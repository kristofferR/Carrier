//! The native menu bar: construction and the menu-event handler.

use std::sync::atomic::Ordering;
#[cfg(target_os = "macos")]
use std::time::Instant;

use serde::Deserialize;
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, MenuItemBuilder, SubmenuBuilder},
    Manager, WebviewWindow,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::cli::NEW_CONVERSATION_JS;
#[cfg(target_os = "macos")]
use crate::macos::dock::{DOCK_MENU_KEEPALIVE, DOCK_NS_MENU};
#[cfg(target_os = "macos")]
use crate::settings::ContextMenuActivation;
use crate::settings::{
    apply_settings, save_settings, schedule_webview_data_clear, AppState, SaveOutcome, Settings,
};
#[cfg(not(target_os = "macos"))]
use crate::tray::build_tray_menu;
use crate::tray::show_main;
use crate::window::{build_app_window, recreate_on_theme_change, show_settings_window};
use crate::APP_TITLE;

pub(crate) fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let mi = |id: &str, label: &str, accel: Option<&str>| -> tauri::Result<MenuItem<tauri::Wry>> {
        let mut b = MenuItemBuilder::new(label).id(id);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let prefs = mi("preferences", "Settings…", Some("CmdOrCtrl+,"))?;
    let app_menu = SubmenuBuilder::new(app, APP_TITLE)
        .about(Some(AboutMetadata::default()))
        .separator()
        .item(&prefs)
        .separator()
        .hide()
        .separator()
        .quit()
        .build()?;

    let new_conversation = mi(
        "new_conversation",
        "New Conversation",
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let new_window = mi("new_window", "New Window", Some("CmdOrCtrl+N"))?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_conversation)
        .item(&new_window)
        .separator()
        .close_window()
        .build()?;

    let paste_match = mi(
        "paste_match_style",
        "Paste and Match Style",
        Some("CmdOrCtrl+Shift+Alt+V"),
    )?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(&paste_match)
        .select_all()
        .build()?;

    let reload = mi("reload", "Reload", Some("CmdOrCtrl+R"))?;
    let clear_cache = mi(
        "clear_cache",
        "Clear Cache && Restart",
        Some("CmdOrCtrl+Shift+Backspace"),
    )?;
    let zreset = mi("zoom_reset", "Actual Size", Some("CmdOrCtrl+0"))?;
    let zin = mi("zoom_in", "Zoom In", Some("CmdOrCtrl+="))?;
    let zout = mi("zoom_out", "Zoom Out", Some("CmdOrCtrl+-"))?;
    let theme_sys = mi("theme_system", "System", None)?;
    let theme_light = mi("theme_light", "Light", None)?;
    let theme_dark = mi("theme_dark", "Dark", None)?;
    let theme_menu = SubmenuBuilder::new(app, "Theme")
        .item(&theme_sys)
        .item(&theme_light)
        .item(&theme_dark)
        .build()?;
    let toggle_info = mi(
        "toggle_info",
        "Toggle Conversation Information",
        Some("CmdOrCtrl+Shift+I"),
    )?;
    // Shift+N belongs to New Conversation, so "hide" gets Shift+H.
    let hide_names = mi(
        "hide_names",
        "Hide Names && Avatars",
        Some("CmdOrCtrl+Shift+H"),
    )?;
    let aot = mi("always_on_top", "Toggle Always on Top", None)?;
    let devtools = mi(
        "devtools",
        "Toggle Developer Tools",
        Some("CmdOrCtrl+Alt+I"),
    )?;
    let view = {
        let b = SubmenuBuilder::new(app, "View")
            .item(&reload)
            .item(&clear_cache)
            .separator()
            .item(&zreset)
            .item(&zin)
            .item(&zout)
            .separator()
            .item(&theme_menu)
            .item(&toggle_info)
            .item(&hide_names)
            .item(&aot);
        #[cfg(debug_assertions)]
        let b = b.separator().item(&devtools);
        let _ = &devtools;
        b.build()?
    };

    let maximize = mi("maximize", "Zoom", None)?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&maximize)
        .separator()
        .close_window()
        .build()?;

    let shortcuts = mi(
        "keyboard_shortcuts",
        "Keyboard Shortcuts",
        Some("CmdOrCtrl+/"),
    )?;
    let report_issue = mi("report_issue", "Report an Issue…", None)?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&shortcuts)
        .separator()
        .item(&report_issue)
        .build()?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

/// The focused Messenger window (a `main`/`win-*` window), falling back to
/// `main`. Used so menu actions affect the window the user is actually looking
/// at rather than always `main`. The local settings window is excluded.
pub(crate) fn target_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .find(|(label, w)| label.as_str() != "settings" && w.is_focused().unwrap_or(false))
        .map(|(_, w)| w)
        .or_else(|| app.get_webview_window("main"))
}

/// Apply a settings change made from the native menu: mutate, persist, re-apply.
/// (Used for view-style toggles — not autostart, which syncs separately.)
fn mutate_settings(app: &tauri::AppHandle, f: impl FnOnce(&mut Settings) + Send + 'static) {
    // Native menu callbacks run on the UI thread. Never wait for a settings
    // transaction there: its owner may need that thread while applying window
    // changes. Queue the whole ordered mutation away from the UI thread.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let worker_app = app.clone();
        let state = app.state::<AppState>();
        let _settings_worker = state.settings_worker.lock().await;
        if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
            let state = worker_app.state::<AppState>();
            // Build the next snapshot without publishing it in memory. A failed
            // or superseded disk write must not leave runtime state ahead of
            // persistence.
            let (prev_theme, s) = {
                let settings = state.settings.lock().unwrap();
                let prev_theme = settings.theme.clone();
                let mut next = settings.clone();
                f(&mut next);
                (prev_theme, next)
            };
            match save_settings(&worker_app, &s) {
                Ok(SaveOutcome::Written) => {
                    *state.settings.lock().unwrap() = s.clone();
                    apply_settings(&worker_app, &s);
                    // macOS needs a window rebuild to re-theme the title bar;
                    // other platforms already re-themed the chrome live.
                    recreate_on_theme_change(&worker_app, &prev_theme, &s.theme);
                }
                Ok(SaveOutcome::Superseded) => {
                    log::warn!("native menu settings update was superseded");
                }
                Err(e) => {
                    log::error!("failed to save settings: {e}");
                }
            }
        })
        .await
        {
            log::error!("native menu settings worker failed: {e}");
        }
    });
}

pub(crate) fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    if let Some((label, action)) = context_menu_action(event.id().as_ref()) {
        let state = app.state::<AppState>();
        let key = (label.to_string(), action.to_string());
        if let Some(value) = state.context_menu_copy_values.lock().unwrap().remove(&key) {
            if let Err(error) = app.clipboard().write_text(value) {
                log::warn!("failed to write context-menu address to the clipboard: {error}");
            }
            return;
        }
        #[cfg(target_os = "macos")]
        if let Some(selected) = state.context_menu_activations.lock().unwrap().get_mut(&key) {
            *selected = ContextMenuActivation::Selected(Instant::now());
        }
        let signature = state
            .download_reveal_tokens
            .lock()
            .unwrap()
            .get(label)
            .and_then(|secret| crate::context_action_signature(secret, action));
        let Some(signature) = signature else {
            log::warn!("failed to authenticate native media context action");
            return;
        };
        if let Some(window) = app.get_webview_window(label) {
            let detail = serde_json::json!({ "action": action, "signature": signature });
            if let Ok(detail) = serde_json::to_string(&detail) {
                let _ = window.eval(format!(
                    "window.dispatchEvent(new CustomEvent('carrier:context-action', {{ detail: {detail} }}));"
                ));
            }
        }
        return;
    }

    let eval = |js: &str| {
        if let Some(w) = target_window(app) {
            let _ = w.eval(js);
        }
    };
    match event.id().as_ref() {
        "preferences" | "dock:settings" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { show_settings_window(&app) });
        }
        "reload" => eval("location.reload()"),
        "zoom_in" => eval("window.__carrierZoomIn && window.__carrierZoomIn()"),
        "zoom_out" => eval("window.__carrierZoomOut && window.__carrierZoomOut()"),
        "zoom_reset" => eval("window.__carrierZoomReset && window.__carrierZoomReset()"),
        "paste_match_style" => eval(
            "navigator.clipboard && navigator.clipboard.readText().then(function (t) { \
             document.execCommand('insertText', false, t); })",
        ),
        "theme_system" => mutate_settings(app, |s| s.theme = "system".into()),
        "theme_light" => mutate_settings(app, |s| s.theme = "light".into()),
        "theme_dark" => mutate_settings(app, |s| s.theme = "dark".into()),
        "new_conversation" => eval(NEW_CONVERSATION_JS),
        "dock:new_conversation" => {
            show_main(app);
            eval(NEW_CONVERSATION_JS);
        }
        "toggle_info" => eval("window.__carrierToggleInfo && window.__carrierToggleInfo()"),
        "keyboard_shortcuts" => {
            eval("window.__carrierToggleShortcuts && window.__carrierToggleShortcuts()")
        }
        "report_issue" => {
            if let Err(error) = app.opener().open_url(
                "https://github.com/kristofferR/Carrier/issues",
                None::<String>,
            ) {
                log::warn!("failed to open issue tracker: {error}");
            }
        }
        // Dock/tray "recent conversations" items ("recent:<thread-id>"). Handled
        // here (the app-wide menu handler) only — the tray's own handler must
        // not repeat this, since every menu event is broadcast to all handlers.
        id if id.starts_with("recent:") => {
            if let Some(href) = recent_href_from_menu_id(id) {
                open_recent_thread(app, &href);
            }
        }
        "hide_names" => mutate_settings(app, |s| s.hide_names_avatars = !s.hide_names_avatars),
        "maximize" => {
            if let Some(w) = target_window(app) {
                if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
        }
        "new_window" => {
            // Off the event-loop handler to avoid the Windows window-creation
            // deadlock.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let s = app.state::<AppState>().settings.lock().unwrap().clone();
                let n = app
                    .state::<AppState>()
                    .next_window
                    .fetch_add(1, Ordering::SeqCst);
                let _ = build_app_window(&app, &format!("win-{n}"), &s);
            });
        }
        "clear_cache" => match schedule_webview_data_clear(app) {
            Ok(()) => app.restart(),
            Err(e) => log::warn!("failed to schedule cache clear: {e}"),
        },
        "always_on_top" => mutate_settings(app, |s| s.always_on_top = !s.always_on_top),
        "devtools" =>
        {
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }
        }
        _ => {}
    }
}

const IMAGE_CONTEXT_MENU_LABELS: &[&str] = &[
    "Copy image",
    "Download image",
    "Share…",
    "Copy image address",
    "Open image in browser",
];
const VIDEO_CONTEXT_MENU_LABELS: &[&str] = &["Download video", "Share…", "Copy video address"];
const LINK_CONTEXT_MENU_LABELS: &[&str] = &["Copy link address", "Open link in browser"];
const IMAGE_CONTEXT_MENU_LABELS_NO_SHARE: &[&str] = &[
    "Copy image",
    "Download image",
    "Copy image address",
    "Open image in browser",
];
const VIDEO_CONTEXT_MENU_LABELS_NO_SHARE: &[&str] = &["Download video", "Copy video address"];

#[derive(Debug, Deserialize)]
pub(crate) struct NativeContextMenuItem {
    pub(crate) label: String,
    pub(crate) action: String,
    pub(crate) value: Option<String>,
}

fn valid_context_menu_items(items: &[NativeContextMenuItem]) -> bool {
    let labels: Vec<&str> = items.iter().map(|item| item.label.as_str()).collect();
    let labels_valid = labels == IMAGE_CONTEXT_MENU_LABELS
        || labels == VIDEO_CONTEXT_MENU_LABELS
        || labels == LINK_CONTEXT_MENU_LABELS
        || {
            #[cfg(not(target_os = "macos"))]
            {
                labels == IMAGE_CONTEXT_MENU_LABELS_NO_SHARE
                    || labels == VIDEO_CONTEXT_MENU_LABELS_NO_SHARE
            }
            #[cfg(target_os = "macos")]
            {
                false
            }
        };
    let value_index = if labels == IMAGE_CONTEXT_MENU_LABELS {
        Some(3)
    } else if labels == VIDEO_CONTEXT_MENU_LABELS {
        Some(2)
    } else if labels == LINK_CONTEXT_MENU_LABELS {
        Some(0)
    } else if labels == IMAGE_CONTEXT_MENU_LABELS_NO_SHARE {
        Some(2)
    } else if labels == VIDEO_CONTEXT_MENU_LABELS_NO_SHARE {
        Some(1)
    } else {
        None
    };
    let values_valid = value_index.is_some_and(|expected| {
        items
            .iter()
            .enumerate()
            .all(|(index, item)| item.value.is_some() == (index == expected))
    });
    let mut actions = std::collections::HashSet::new();
    labels_valid
        && values_valid
        && items.iter().all(|item| {
            item.action.len() == 32
                && item.action.bytes().all(|byte| byte.is_ascii_hexdigit())
                && item
                    .value
                    .as_ref()
                    .is_none_or(|value| value.encode_utf16().count() <= 64 * 1024)
                && actions.insert(item.action.as_str())
        })
}

pub(crate) fn show_native_context_menu(
    app: &tauri::AppHandle,
    label: &str,
    items: Vec<NativeContextMenuItem>,
) -> bool {
    if !valid_context_menu_items(&items) {
        log::warn!("carrier:context-menu payload was invalid");
        return false;
    }
    let Some(window) = app.get_webview_window(label) else {
        log::warn!("carrier:context-menu target window {label:?} is gone");
        return false;
    };
    let menu = match Menu::new(app) {
        Ok(menu) => menu,
        Err(error) => {
            log::warn!("failed to create native media context menu: {error}");
            return false;
        }
    };
    for item in &items {
        let id = format!("carrier-context:{label}:{}", item.action);
        let menu_item = match MenuItemBuilder::new(&item.label).id(id).build(app) {
            Ok(menu_item) => menu_item,
            Err(error) => {
                log::warn!(
                    "failed to build native media context menu item for action {}: {error}",
                    item.action
                );
                return false;
            }
        };
        if let Err(error) = menu.append(&menu_item) {
            log::warn!(
                "failed to append native media context menu item for action {}: {error}",
                item.action
            );
            return false;
        }
    }
    {
        let state = app.state::<AppState>();
        let mut copies = state.context_menu_copy_values.lock().unwrap();
        copies.retain(|(window, _), _| window != label);
        for item in &items {
            if let Some(value) = &item.value {
                copies.insert((label.to_string(), item.action.clone()), value.clone());
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let state = app.state::<AppState>();
        state
            .download_reservations
            .lock()
            .unwrap()
            .retain(|(window, _), _| window != label);
        let mut activations = state.context_menu_activations.lock().unwrap();
        let now = Instant::now();
        activations.retain(|(window, _), activation| {
            window != label || crate::context_menu_activation_is_current(activation.clone(), now)
        });
        for item in &items {
            let key = (label.to_string(), item.action.clone());
            if item.value.is_none()
                && (item.label == IMAGE_CONTEXT_MENU_LABELS[0]
                    || item.label == IMAGE_CONTEXT_MENU_LABELS[2])
            {
                activations.insert(key, ContextMenuActivation::Pending);
            }
        }
    }
    match window.popup_menu(&menu) {
        Ok(()) => true,
        Err(error) => {
            log::warn!("failed to show native media context menu: {error}");
            let state = app.state::<AppState>();
            state
                .context_menu_copy_values
                .lock()
                .unwrap()
                .retain(|(window, _), _| window != label);
            #[cfg(target_os = "macos")]
            state
                .context_menu_activations
                .lock()
                .unwrap()
                .retain(|(window, _), _| window != label);
            false
        }
    }
}

fn context_menu_action(id: &str) -> Option<(&str, &str)> {
    let (label, action) = id.strip_prefix("carrier-context:")?.rsplit_once(':')?;
    if label.is_empty()
        || action.len() != 32
        || !action.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some((label, action))
}

// ---------------------------------------------------------------------------
// Recent conversations (Dock / tray menu)
// ---------------------------------------------------------------------------

/// One entry of the recent-conversations list the page scrapes from the chat
/// list and pushes over `carrier:recent-threads` (see inject/messenger.js).
/// Held in memory only; conversation names/ids are never written to disk.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct RecentThread {
    pub(crate) name: String,
    pub(crate) href: String,
}

/// The `carrier:recent-threads` payload crosses from the remote Facebook page,
/// so validate it hard: names are trimmed and truncated, hrefs must be a bare
/// `/t/<digits>/` thread path (they're re-embedded into an eval'd navigation),
/// duplicates are dropped, and the list is capped.
pub(crate) fn sanitize_recent_threads(threads: Vec<RecentThread>) -> Vec<RecentThread> {
    const MAX_THREADS: usize = 9;
    const MAX_NAME_CHARS: usize = 60;
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<RecentThread> = Vec::new();
    for t in threads {
        let name: String = t.name.trim().chars().take(MAX_NAME_CHARS).collect();
        let Some(id) = t
            .href
            .strip_prefix("/t/")
            .map(|rest| rest.trim_end_matches('/'))
        else {
            continue;
        };
        if name.is_empty()
            || id.is_empty()
            || id.len() > 32
            || !id.bytes().all(|b| b.is_ascii_digit())
            || t.href != format!("/t/{id}/")
        {
            continue;
        }
        if !seen.insert(id.to_string()) {
            continue;
        }
        out.push(RecentThread {
            name,
            href: format!("/t/{id}/"),
        });
        if out.len() >= MAX_THREADS {
            break;
        }
    }
    out
}

#[cfg(any(not(target_os = "linux"), test))]
fn recent_thread_id(href: &str) -> Option<&str> {
    let id = href.strip_prefix("/t/")?.trim_end_matches('/');
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(id)
}

#[cfg(any(not(target_os = "linux"), test))]
pub(crate) fn recent_menu_id(thread: &RecentThread) -> String {
    let id = recent_thread_id(&thread.href).expect("recent thread href is sanitized");
    format!("recent:{id}")
}

fn recent_href_from_menu_id(menu_id: &str) -> Option<String> {
    let id = menu_id.strip_prefix("recent:")?;
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!("/t/{id}/"))
}

/// The recent-threads list as native menus should show it: empty while Hide
/// Names & Avatars is on, so contact names never surface in the Dock/tray menu
/// of a screen-shared machine.
pub(crate) fn recent_threads_for_menu(app: &tauri::AppHandle) -> Vec<RecentThread> {
    let state = app.state::<AppState>();
    if state.settings.lock().unwrap().hide_names_avatars {
        return Vec::new();
    }
    let threads = state.recent_threads.lock().unwrap().clone();
    threads
}

/// Open a conversation picked from the Dock/tray menu: surface the app and ask
/// the page to navigate to the thread (it clicks the chat-list row for SPA
/// navigation, falling back to a hard navigation). The href is encoded into the
/// menu id when the menu is built, so a later recents refresh cannot make a
/// visible native menu item open a different thread.
pub(crate) fn open_recent_thread(app: &tauri::AppHandle, href: &str) {
    show_main(app);
    if let Some(w) = target_window(app) {
        // `href` is validated to `/t/<digits>/`; JSON-encode it anyway so the
        // eval always receives a well-formed JS string literal.
        if let Ok(arg) = serde_json::to_string(&href) {
            let _ = w.eval(format!(
                "window.__carrierOpenThread && window.__carrierOpenThread({arg});"
            ));
        }
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq)]
enum DockEntry {
    Recent(RecentThread),
    Separator,
    NewConversation,
    Settings,
}

#[cfg(any(target_os = "macos", test))]
fn dock_menu_entries(threads: &[RecentThread]) -> Vec<DockEntry> {
    let mut entries = Vec::with_capacity(threads.len() + 3);
    entries.extend(threads.iter().cloned().map(DockEntry::Recent));
    if !threads.is_empty() {
        entries.push(DockEntry::Separator);
    }
    entries.push(DockEntry::NewConversation);
    entries.push(DockEntry::Settings);
    entries
}

/// Rebuild the native menus that mirror the recent-threads list: the macOS
/// Dock menu, and the tray menu on Windows/Linux (the macOS tray builds its
/// menu fresh on every right-click, so it needs no push). Must run on the main
/// thread — menu construction is main-thread-only on macOS.
pub(crate) fn rebuild_recent_menus(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let threads = recent_threads_for_menu(app);
        use muda::ContextMenu as _;
        let menu = muda::Menu::new();
        for entry in dock_menu_entries(&threads) {
            let result = match entry {
                DockEntry::Recent(thread) => menu.append(&muda::MenuItem::with_id(
                    recent_menu_id(&thread),
                    &thread.name,
                    true,
                    None,
                )),
                DockEntry::Separator => menu.append(&muda::PredefinedMenuItem::separator()),
                DockEntry::NewConversation => menu.append(&muda::MenuItem::with_id(
                    "dock:new_conversation",
                    "New Conversation",
                    true,
                    None,
                )),
                DockEntry::Settings => menu.append(&muda::MenuItem::with_id(
                    "dock:settings",
                    "Settings…",
                    true,
                    None,
                )),
            };
            if let Err(error) = result {
                log::warn!("failed to append macOS Dock menu item: {error}");
            }
        }
        let ptr = menu.ns_menu();
        DOCK_MENU_KEEPALIVE.with(|slot| *slot.borrow_mut() = Some(menu));
        DOCK_NS_MENU.store(ptr, Ordering::SeqCst);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let Ok(menu) = build_tray_menu(app) else {
            return;
        };
        let state = app.state::<AppState>();
        let tray = state.tray.lock().unwrap();
        if let Some(tray) = tray.as_ref() {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn injected_context_menu_labels(name: &str) -> Vec<&'static str> {
        let source = include_str!("../../inject/src/messenger/features/context-menu.ts");
        let declaration = format!("const {name} = [");
        let body = source
            .split_once(&declaration)
            .unwrap_or_else(|| panic!("missing injected label declaration {name}"))
            .1
            .split_once("] as const;")
            .unwrap_or_else(|| panic!("unterminated injected label declaration {name}"))
            .0;
        body.split('"').skip(1).step_by(2).collect()
    }

    fn context_item(label: &str, action: char) -> NativeContextMenuItem {
        NativeContextMenuItem {
            label: label.into(),
            action: action.to_string().repeat(32),
            value: None,
        }
    }

    fn thread(name: &str, href: &str) -> RecentThread {
        RecentThread {
            name: name.into(),
            href: href.into(),
        }
    }

    #[test]
    fn recent_threads_keep_only_valid_thread_paths() {
        let out = sanitize_recent_threads(vec![
            thread("Alice", "/t/12345/"),
            thread("Mallory", "https://evil.example/t/1/"),
            thread("Mallory", "/t/1'; alert(1);//"),
            thread("Mallory", "/t/12345/../../settings/"),
            thread("Mallory", "/t//"),
            thread("Bob", "/t/67890/"),
        ]);
        assert_eq!(
            out,
            vec![thread("Alice", "/t/12345/"), thread("Bob", "/t/67890/")]
        );
    }

    #[test]
    fn recent_threads_drop_empty_names_and_duplicates_and_cap_the_list() {
        let mut input = vec![
            thread("   ", "/t/1/"),
            thread("Alice", "/t/2/"),
            thread("Alice again", "/t/2/"),
        ];
        for i in 0..20 {
            input.push(thread("More", &format!("/t/{}/", 100 + i)));
        }
        let out = sanitize_recent_threads(input);
        assert_eq!(out.len(), 9);
        assert_eq!(out[0], thread("Alice", "/t/2/"));
        // Duplicate thread id keeps only the first entry.
        assert!(!out.iter().any(|t| t.name == "Alice again"));
    }

    #[test]
    fn recent_threads_truncate_long_names_on_char_boundaries() {
        let name = "ø".repeat(100);
        let out = sanitize_recent_threads(vec![thread(&name, "/t/5/")]);
        assert_eq!(out[0].name.chars().count(), 60);
    }

    #[test]
    fn recent_menu_ids_round_trip_thread_ids() {
        let t = thread("Alice", "/t/12345/");
        assert_eq!(recent_menu_id(&t), "recent:12345");
        assert_eq!(
            recent_href_from_menu_id("recent:12345").as_deref(),
            Some("/t/12345/")
        );
        assert_eq!(recent_href_from_menu_id("recent:"), None);
        assert_eq!(recent_href_from_menu_id("recent:abc"), None);
        assert_eq!(recent_href_from_menu_id("recent:12345/../../"), None);
    }

    #[test]
    fn dock_menu_keeps_static_actions_without_recent_threads() {
        assert_eq!(
            dock_menu_entries(&[]),
            vec![DockEntry::NewConversation, DockEntry::Settings]
        );
    }

    #[test]
    fn dock_menu_places_recent_threads_before_static_actions() {
        let alice = thread("Alice", "/t/12345/");
        let bob = thread("Bob", "/t/67890/");
        assert_eq!(
            dock_menu_entries(&[alice.clone(), bob.clone()]),
            vec![
                DockEntry::Recent(alice),
                DockEntry::Recent(bob),
                DockEntry::Separator,
                DockEntry::NewConversation,
                DockEntry::Settings,
            ]
        );
    }

    #[test]
    fn native_context_menu_accepts_only_known_shapes_and_unique_tokens() {
        let mut image = vec![
            context_item("Copy image", '1'),
            context_item("Download image", '2'),
            context_item("Share…", '3'),
            context_item("Copy image address", '4'),
            context_item("Open image in browser", '5'),
        ];
        image[3].value = Some("https://example.com/image.png".into());
        assert!(valid_context_menu_items(&image));

        image[0].value = image[3].value.take();
        assert!(!valid_context_menu_items(&image));
        image[3].value = image[0].value.take();

        let mut spoofed = image;
        spoofed[2].label = "Allow microphone".into();
        assert!(!valid_context_menu_items(&spoofed));

        let mut duplicate = vec![
            context_item("Copy link address", 'a'),
            context_item("Open link in browser", 'a'),
        ];
        duplicate[0].value = Some("https://example.com".into());
        assert!(!valid_context_menu_items(&duplicate));
    }

    #[test]
    fn native_context_menu_allowlist_matches_injected_labels() {
        for (name, expected) in [
            ("IMAGE_CONTEXT_MENU_LABELS", IMAGE_CONTEXT_MENU_LABELS),
            ("VIDEO_CONTEXT_MENU_LABELS", VIDEO_CONTEXT_MENU_LABELS),
            ("LINK_CONTEXT_MENU_LABELS", LINK_CONTEXT_MENU_LABELS),
        ] {
            assert_eq!(injected_context_menu_labels(name), expected, "{name}");
        }
    }

    #[test]
    fn native_context_action_ids_bind_the_window_and_opaque_action() {
        let token = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            context_menu_action(&format!("carrier-context:win-2:{token}")),
            Some(("win-2", token))
        );
        assert_eq!(context_menu_action("carrier-context:win-2:share"), None);
        assert_eq!(context_menu_action(&format!("other:win-2:{token}")), None);
    }
}
