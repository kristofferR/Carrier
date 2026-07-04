//! The native menu bar: construction and the menu-event handler.

use std::sync::atomic::Ordering;

use serde::Deserialize;
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, MenuItemBuilder, SubmenuBuilder},
    Manager, WebviewWindow,
};

#[cfg(target_os = "macos")]
use crate::macos::dock::{DOCK_MENU_KEEPALIVE, DOCK_NS_MENU};
use crate::settings::{
    apply_settings, save_settings, schedule_webview_data_clear, AppState, Settings,
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

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
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
fn mutate_settings(app: &tauri::AppHandle, f: impl FnOnce(&mut Settings)) {
    let state = app.state::<AppState>();
    // Mutate in place under the lock so concurrent callers can't read-modify-write
    // a stale clone and lose each other's changes. Persist/apply after releasing
    // it (apply_settings touches windows and must not run while holding the lock).
    let (prev_theme, s) = {
        let mut settings = state.settings.lock().unwrap();
        let prev_theme = settings.theme.clone();
        f(&mut settings);
        (prev_theme, settings.clone())
    };
    if let Err(e) = save_settings(app, &s) {
        log::error!("failed to save settings: {e}");
    }
    apply_settings(app, &s);
    // macOS needs a window rebuild to re-theme the title bar; other platforms
    // already re-themed the chrome live in apply_settings.
    recreate_on_theme_change(app, &prev_theme, &s.theme);
}

pub(crate) fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let eval = |js: &str| {
        if let Some(w) = target_window(app) {
            let _ = w.eval(js);
        }
    };
    match event.id().as_ref() {
        "preferences" => {
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
        "new_conversation" => {
            eval("window.__carrierShortcuts && window.__carrierShortcuts.newConversation()")
        }
        "toggle_info" => eval("window.__carrierToggleInfo && window.__carrierToggleInfo()"),
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

fn recent_thread_id(href: &str) -> Option<&str> {
    let id = href.strip_prefix("/t/")?.trim_end_matches('/');
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(id)
}

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
fn open_recent_thread(app: &tauri::AppHandle, href: &str) {
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

/// Rebuild the native menus that mirror the recent-threads list: the macOS
/// Dock menu, and the tray menu on Windows/Linux (the macOS tray builds its
/// menu fresh on every right-click, so it needs no push). Must run on the main
/// thread — menu construction is main-thread-only on macOS.
pub(crate) fn rebuild_recent_menus(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let threads = recent_threads_for_menu(app);
        let ptr = if threads.is_empty() {
            std::ptr::null_mut()
        } else {
            use muda::ContextMenu as _;
            let menu = muda::Menu::new();
            for t in &threads {
                let _ = menu.append(&muda::MenuItem::with_id(
                    recent_menu_id(t),
                    &t.name,
                    true,
                    None,
                ));
            }
            let ptr = menu.ns_menu();
            DOCK_MENU_KEEPALIVE.with(|slot| *slot.borrow_mut() = Some(menu));
            ptr
        };
        DOCK_NS_MENU.store(ptr, Ordering::SeqCst);
        if ptr.is_null() {
            DOCK_MENU_KEEPALIVE.with(|slot| *slot.borrow_mut() = None);
        }
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
}
