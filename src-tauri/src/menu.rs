//! The native menu bar: construction and the menu-event handler.

#[cfg(target_os = "macos")]
use std::time::Instant;

use serde::Deserialize;
#[cfg(not(target_os = "macos"))]
use tauri::menu::{CheckMenuItem, MenuItemKind, Submenu};
use tauri::{
    Manager, WebviewWindow,
    menu::{AboutMetadata, Menu, MenuItem, MenuItemBuilder, SubmenuBuilder},
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "macos")]
use crate::APP_TITLE;
use crate::actions::{AppAction, NEW_CONVERSATION_JS, run_app_action, validated_thread_path};
use crate::export::Format as ExportFormat;
#[cfg(target_os = "macos")]
use crate::macos::dock::{DOCK_MENU_KEEPALIVE, DOCK_NS_MENU};
#[cfg(target_os = "macos")]
use crate::settings::ContextMenuActivation;
use crate::settings::{
    AppState, SaveOutcome, Settings, apply_settings, save_settings, schedule_webview_data_clear,
};
#[cfg(not(target_os = "macos"))]
use crate::tray::build_tray_menu;
use crate::tray::show_main;
use crate::window::{recreate_on_theme_change, show_settings_window};

fn about_metadata(version: &str) -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some("Carrier".into()),
        version: Some(version.into()),
        authors: Some(vec!["kristofferR".into()]),
        comments: Some("A tiny, distraction-free desktop client for Facebook Messenger.".into()),
        license: Some("MIT".into()),
        website: Some("https://github.com/kristofferR/Carrier".into()),
        website_label: Some("GitHub".into()),
        ..Default::default()
    }
}

fn menu_item(
    app: &tauri::AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    let mut builder = MenuItemBuilder::new(label).id(id);
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

/// Log Out… (Ref #356); the tray has it too.
fn log_out_item(app: &tauri::AppHandle) -> tauri::Result<MenuItem<tauri::Wry>> {
    menu_item(app, "log_out", crate::tray::LOG_OUT_LABEL, None)
}

#[cfg(target_os = "macos")]
pub(crate) fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let prefs = menu_item(app, "preferences", "Settings…", Some("CmdOrCtrl+,"))?;
    let log_out = log_out_item(app)?;
    let about = about_metadata(&app.package_info().version.to_string());
    let app_menu = SubmenuBuilder::new(app, APP_TITLE)
        .about(Some(about))
        .separator()
        .item(&prefs)
        .separator()
        .item(&log_out)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_conversation = menu_item(
        app,
        "new_conversation",
        "New Conversation",
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let new_window = menu_item(app, "new_window", "New Window", Some("CmdOrCtrl+N"))?;
    let export_html = menu_item(app, "export_html", "Export Conversation as HTML…", None)?;
    let export_json = menu_item(app, "export_json", "Export Conversation as JSON…", None)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_conversation)
        .item(&new_window)
        .separator()
        .item(&export_html)
        .item(&export_json)
        .separator()
        .close_window()
        .build()?;

    let paste_match = menu_item(
        app,
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

    let reload = menu_item(app, "reload", "Reload", Some("CmdOrCtrl+R"))?;
    let clear_cache = menu_item(
        app,
        "clear_cache",
        "Clear Cache && Restart",
        Some("CmdOrCtrl+Shift+Backspace"),
    )?;
    let zreset = menu_item(app, "zoom_reset", "Actual Size", Some("CmdOrCtrl+0"))?;
    let zin = menu_item(app, "zoom_in", "Zoom In", Some("CmdOrCtrl+="))?;
    let zout = menu_item(app, "zoom_out", "Zoom Out", Some("CmdOrCtrl+-"))?;
    let theme_sys = menu_item(app, "theme_system", "System", None)?;
    let theme_light = menu_item(app, "theme_light", "Light", None)?;
    let theme_dark = menu_item(app, "theme_dark", "Dark", None)?;
    let theme_menu = SubmenuBuilder::new(app, "Theme")
        .item(&theme_sys)
        .item(&theme_light)
        .item(&theme_dark)
        .build()?;
    let toggle_info = menu_item(
        app,
        "toggle_info",
        "Toggle Conversation Information",
        Some("CmdOrCtrl+Shift+I"),
    )?;
    // Shift+N belongs to New Conversation, so "hide" gets Shift+H.
    let hide_names = menu_item(
        app,
        "hide_names",
        "Hide Names && Avatars",
        Some("CmdOrCtrl+Shift+H"),
    )?;
    let aot = menu_item(app, "always_on_top", "Toggle Always on Top", None)?;
    let devtools = menu_item(
        app,
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

    let maximize = menu_item(app, "maximize", "Zoom", None)?;
    // Tauri registers this ID with AppKit after installing the application menu,
    // letting macOS add its supported window controls and live window list.
    let window = SubmenuBuilder::with_id(app, tauri::menu::WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .item(&maximize)
        .separator()
        .close_window()
        .separator()
        .bring_all_to_front()
        .build()?;

    let shortcuts = menu_item(
        app,
        "keyboard_shortcuts",
        "Keyboard Shortcuts",
        Some("CmdOrCtrl+/"),
    )?;
    let report_issue = menu_item(app, "report_issue", "Report an Issue…", None)?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&shortcuts)
        .separator()
        .item(&report_issue)
        .build()?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    let check_item = |id: &str,
                      label: &str,
                      checked: bool,
                      accelerator: Option<&str>|
     -> tauri::Result<CheckMenuItem<tauri::Wry>> {
        CheckMenuItem::with_id(app, id, label, true, checked, accelerator)
    };

    let new_conversation = menu_item(
        app,
        "new_conversation",
        "New Conversation",
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let new_window = menu_item(app, "new_window", "New Window", Some("CmdOrCtrl+N"))?;
    let export_html = menu_item(app, "export_html", "Export Conversation as HTML…", None)?;
    let export_json = menu_item(app, "export_json", "Export Conversation as JSON…", None)?;
    let close_window = menu_item(app, "close_window", "Close Window", Some("CmdOrCtrl+W"))?;
    let preferences_label = if cfg!(target_os = "windows") {
        "Settings…"
    } else {
        "Preferences…"
    };
    let preferences = menu_item(app, "preferences", preferences_label, Some("CmdOrCtrl+,"))?;
    let quit_label = if cfg!(target_os = "windows") {
        "Exit"
    } else {
        "Quit"
    };
    let quit_accelerator = if cfg!(target_os = "linux") {
        Some("Ctrl+Q")
    } else {
        None
    };
    let quit = menu_item(app, "quit", quit_label, quit_accelerator)?;
    let log_out = log_out_item(app)?;
    let file_builder = SubmenuBuilder::new(app, "File")
        .id("file")
        .item(&new_conversation)
        .item(&new_window)
        .separator()
        .item(&export_html)
        .item(&export_json)
        .separator()
        .item(&close_window)
        .separator()
        .item(&log_out);
    #[cfg(target_os = "windows")]
    let file_builder = file_builder
        .separator()
        .item(&preferences)
        .separator()
        .item(&quit);
    #[cfg(target_os = "linux")]
    let file_builder = file_builder.separator().item(&quit);
    let file = file_builder.build()?;

    let paste_match = menu_item(
        app,
        "paste_match_style",
        "Paste and Match Style",
        Some("CmdOrCtrl+Shift+Alt+V"),
    )?;
    #[cfg(target_os = "windows")]
    let edit = SubmenuBuilder::new(app, "Edit")
        .id("edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(&paste_match)
        .separator()
        .select_all()
        .build()?;
    #[cfg(target_os = "linux")]
    let edit = {
        let undo = menu_item(app, "edit_undo", "Undo", Some("Ctrl+Z"))?;
        let redo = menu_item(app, "edit_redo", "Redo", Some("Ctrl+Shift+Z"))?;
        let cut = menu_item(app, "edit_cut", "Cut", Some("Ctrl+X"))?;
        let copy = menu_item(app, "edit_copy", "Copy", Some("Ctrl+C"))?;
        let paste = menu_item(app, "edit_paste", "Paste", Some("Ctrl+V"))?;
        let select_all = menu_item(app, "edit_select_all", "Select All", Some("Ctrl+A"))?;
        SubmenuBuilder::new(app, "Edit")
            .id("edit")
            .item(&undo)
            .item(&redo)
            .separator()
            .item(&cut)
            .item(&copy)
            .item(&paste)
            .item(&paste_match)
            .separator()
            .item(&select_all)
            .separator()
            .item(&preferences)
            .build()?
    };

    let reload = menu_item(app, "reload", "Reload", Some("CmdOrCtrl+R"))?;
    let conversation_info = menu_item(
        app,
        "toggle_info",
        "Conversation Information",
        Some("CmdOrCtrl+Shift+I"),
    )?;
    let hide_names = check_item(
        "hide_names",
        "Hide Names and Avatars",
        settings.hides_names() || settings.hides_avatars(),
        Some("CmdOrCtrl+Shift+H"),
    )?;
    let always_on_top = check_item(
        "always_on_top",
        "Always on Top",
        settings.always_on_top,
        None,
    )?;
    let zoom_in = menu_item(app, "zoom_in", "Zoom In", Some("CmdOrCtrl+="))?;
    let zoom_out = menu_item(app, "zoom_out", "Zoom Out", Some("CmdOrCtrl+-"))?;
    let actual_size = menu_item(app, "zoom_reset", "Actual Size", Some("CmdOrCtrl+0"))?;
    let theme_system = check_item("theme_system", "System", settings.theme == "system", None)?;
    let theme_light = check_item("theme_light", "Light", settings.theme == "light", None)?;
    let theme_dark = check_item("theme_dark", "Dark", settings.theme == "dark", None)?;
    let theme = SubmenuBuilder::new(app, "Theme")
        .id("theme")
        .item(&theme_system)
        .item(&theme_light)
        .item(&theme_dark)
        .build()?;
    let devtools = menu_item(
        app,
        "devtools",
        "Toggle Developer Tools",
        Some("CmdOrCtrl+Alt+I"),
    )?;
    let view_builder = SubmenuBuilder::new(app, "View")
        .id("view")
        .item(&reload)
        .separator()
        .item(&conversation_info)
        .item(&hide_names)
        .item(&always_on_top)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&actual_size)
        .separator()
        .item(&theme);
    #[cfg(debug_assertions)]
    let view_builder = view_builder.separator().item(&devtools);
    let _ = &devtools;
    let view = view_builder.build()?;

    let shortcuts = menu_item(
        app,
        "keyboard_shortcuts",
        "Keyboard Shortcuts",
        Some("CmdOrCtrl+/"),
    )?;
    let report_issue = menu_item(app, "report_issue", "Report an Issue…", None)?;
    let clear_cache = menu_item(
        app,
        "clear_cache",
        "Clear Cache and Restart…",
        Some("CmdOrCtrl+Shift+Backspace"),
    )?;
    let about = about_metadata(&app.package_info().version.to_string());
    let help = SubmenuBuilder::new(app, "Help")
        .id("help")
        .item(&shortcuts)
        .item(&report_issue)
        .separator()
        .item(&clear_cache)
        .separator()
        .about_with_text("About Carrier", Some(about))
        .build()?;

    Menu::with_items(app, &[&file, &edit, &view, &help])
}

#[cfg(not(target_os = "macos"))]
fn set_check_item(submenu: &Submenu<tauri::Wry>, id: &str, checked: bool) {
    if let Some(MenuItemKind::Check(item)) = submenu.get(id)
        && let Err(error) = item.set_checked(checked)
    {
        log::warn!("failed to update native menu item {id}: {error}");
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn sync_setting_checks(app: &tauri::AppHandle, settings: &Settings) {
    let Some(menu) = app.menu() else {
        return;
    };
    let Some(MenuItemKind::Submenu(view)) = menu.get("view") else {
        return;
    };

    set_check_item(
        &view,
        "hide_names",
        settings.hides_names() || settings.hides_avatars(),
    );
    set_check_item(&view, "always_on_top", settings.always_on_top);

    let Some(MenuItemKind::Submenu(theme)) = view.get("theme") else {
        return;
    };
    set_check_item(&theme, "theme_system", settings.theme == "system");
    set_check_item(&theme, "theme_light", settings.theme == "light");
    set_check_item(&theme, "theme_dark", settings.theme == "dark");
}

#[cfg(target_os = "macos")]
pub(crate) fn sync_setting_checks(_app: &tauri::AppHandle, _settings: &Settings) {}

/// The focused Messenger window (a `main`/`win-*` window), falling back to
/// `main`. Used so menu actions affect the window the user is actually looking
/// at rather than always `main`. Settings and call windows are excluded.
pub(crate) fn target_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .find(|(label, w)| {
            crate::window::is_messenger_window_label(label) && w.is_focused().unwrap_or(false)
        })
        .map(|(_, w)| w)
        .or_else(|| app.get_webview_window("main"))
}

/// The window a native dialog attaches to, if it is on screen. Tray actions
/// run while Carrier is hidden, and a hidden window has no Wayland surface:
/// tao aborts building its handle. Without a parent the dialog opens on its own.
pub(crate) fn dialog_parent(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    target_window(app).filter(|window| window.is_visible().unwrap_or(false))
}

/// The window that owns keyboard focus, including Settings and call popups.
/// Window controls and editing commands follow focus; fall back to the main
/// Messenger window when the platform does not report one.
fn focused_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
}

/// Apply a settings change made from the native menu: mutate, persist, re-apply.
/// (Used for view-style toggles — not autostart, which syncs separately.)
pub(crate) fn mutate_settings(
    app: &tauri::AppHandle,
    f: impl FnOnce(&mut Settings) + Send + 'static,
) {
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
            let (previous, s) = {
                let settings = state.settings.lock().unwrap();
                let previous = settings.clone();
                let mut next = settings.clone();
                f(&mut next);
                (previous, next)
            };
            match save_settings(&worker_app, &s) {
                Ok(SaveOutcome::Written) => {
                    *state.settings.lock().unwrap() = s.clone();
                    apply_settings(&worker_app, &s);
                    // macOS needs a window rebuild to re-theme the title bar;
                    // other platforms already re-themed the chrome live.
                    recreate_on_theme_change(&worker_app, &previous.theme, &s.theme);
                }
                Ok(SaveOutcome::Superseded) => {
                    let current = state.settings.lock().unwrap().clone();
                    sync_setting_checks(&worker_app, &current);
                    log::warn!("native menu settings update was superseded");
                }
                Err(e) => {
                    sync_setting_checks(&worker_app, &previous);
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

#[cfg(target_os = "linux")]
fn linux_editing_command(id: &str) -> Option<&'static str> {
    match id {
        "edit_undo" => Some("Undo"),
        "edit_redo" => Some("Redo"),
        "edit_cut" => Some("Cut"),
        "edit_copy" => Some("Copy"),
        "edit_paste" => Some("Paste"),
        "paste_match_style" => Some("PasteAsPlainText"),
        "edit_select_all" => Some("SelectAll"),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn execute_linux_editing_command(app: &tauri::AppHandle, command: &'static str) {
    let Some(window) = focused_window(app) else {
        return;
    };
    if let Err(error) = window.with_webview(move |platform_webview| {
        use webkit2gtk::WebViewExt;
        platform_webview.inner().execute_editing_command(command);
    }) {
        log::warn!("failed to execute native editing command {command}: {error}");
    }
}

#[cfg(any(not(target_os = "linux"), test))]
fn paste_plain_text_script(text: &str) -> String {
    let text = serde_json::to_string(text).expect("serializing a string cannot fail");
    format!("document.execCommand('insertText', false, {text});")
}

#[cfg(not(target_os = "linux"))]
fn paste_plain_text(app: &tauri::AppHandle) {
    let text = match app.clipboard().read_text() {
        Ok(text) => text,
        Err(error) => {
            log::warn!("failed to read clipboard text: {error}");
            return;
        }
    };
    if let Some(window) = focused_window(app) {
        let _ = window.eval(paste_plain_text_script(&text));
    }
}

fn confirm_clear_cache(app: &tauri::AppHandle) {
    let app_handle = app.clone();
    let mut dialog = app
        .dialog()
        .message("This clears Carrier's Messenger browsing data, signs you out, and restarts the app. Continue?")
        .title("Clear Cache and Restart")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Clear and Restart".into(),
            "Cancel".into(),
        ));
    if let Some(window) = dialog_parent(app) {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |confirmed| {
        if !confirmed {
            return;
        }
        match schedule_webview_data_clear(&app_handle) {
            Ok(()) => app_handle.restart(),
            Err(error) => log::warn!("failed to schedule cache clear: {error}"),
        }
    });
}

/// File > New Window. On macOS the first extra window reloads the open ones
/// onto Messenger's shared engine, so ask first if that would interrupt a call
/// or an unsent message.
fn request_new_window(app: &tauri::AppHandle) {
    // Off the event-loop handler to avoid the Windows window-creation deadlock.
    let open = |app: tauri::AppHandle| {
        tauri::async_runtime::spawn(crate::window::open_messenger_window(app));
    };
    #[cfg(target_os = "macos")]
    if crate::window::opening_window_reloads_others()
        && crate::webview_watchdog::any_messenger_window_protected()
    {
        let app_handle = app.clone();
        let mut dialog = app
            .dialog()
            .message(
                "To keep every window in sync, Carrier reloads Messenger in your open window. \
                 A call or an unsent message there will be interrupted.",
            )
            .title("Open a New Window?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Open Window".into(),
                "Cancel".into(),
            ));
        if let Some(window) = dialog_parent(app) {
            dialog = dialog.parent(&window);
        }
        dialog.show(move |confirmed| {
            if confirmed {
                open(app_handle);
            }
        });
        return;
    }
    open(app.clone());
}

pub(crate) fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    if let Some((label, action)) = context_menu_action(event.id().as_ref()) {
        let state = app.state::<AppState>();
        let key = (label.to_string(), action.to_string());
        let copy = state.context_menu_copy_values.lock().unwrap().remove(&key);
        if let Some((value, copied)) = copy {
            // Match the page-rendered menu's feedback in both directions.
            let toast = match app.clipboard().write_text(value) {
                Ok(()) => copied,
                Err(error) => {
                    log::warn!("failed to write context-menu text to the clipboard: {error}");
                    "Copy failed"
                }
            };
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.eval(format!("window.__carrierToast?.('{toast}')"));
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

    #[cfg(target_os = "linux")]
    if let Some(command) = linux_editing_command(event.id().as_ref()) {
        execute_linux_editing_command(app, command);
        return;
    }

    let eval = |js: &str| {
        if let Some(w) = target_window(app) {
            let _ = w.eval(js);
        }
    };
    if crate::pause::handle_pause_menu_event(app, event.id().as_ref()) {
        return;
    }
    match event.id().as_ref() {
        "preferences" | "dock:settings" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { show_settings_window(&app) });
        }
        "reload" => eval("location.reload()"),
        "zoom_in" => eval("window.__carrierZoomIn && window.__carrierZoomIn()"),
        "zoom_out" => eval("window.__carrierZoomOut && window.__carrierZoomOut()"),
        "zoom_reset" => eval("window.__carrierZoomReset && window.__carrierZoomReset()"),
        #[cfg(not(target_os = "linux"))]
        "paste_match_style" => paste_plain_text(app),
        "theme_system" => mutate_settings(app, |s| s.theme = "system".into()),
        "theme_light" => mutate_settings(app, |s| s.theme = "light".into()),
        "theme_dark" => mutate_settings(app, |s| s.theme = "dark".into()),
        "new_conversation" => eval(NEW_CONVERSATION_JS),
        "export_html" => eval(&ExportFormat::Html.page_script()),
        "export_json" => eval(&ExportFormat::Json.page_script()),
        "dock:new_conversation" => {
            run_app_action(app, AppAction::NewConversation);
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
        "hide_names" => mutate_settings(app, Settings::toggle_hide_identity),
        "maximize" => {
            if let Some(w) = focused_window(app) {
                if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
        }
        "new_window" => request_new_window(app),
        "close_window" => {
            if let Some(window) = focused_window(app) {
                let _ = window.close();
            }
        }
        "quit" => app.exit(0),
        "clear_cache" => confirm_clear_cache(app),
        "log_out" => crate::log_out::log_out(app),
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

/// The two rows that register a macOS activation when selected. Named so the
/// activation check below cannot drift from the label arrays: a video menu's
/// Share row must stay the same string as an image menu's.
const COPY_IMAGE_CONTEXT_MENU_LABEL: &str = "Copy image";
const SHARE_CONTEXT_MENU_LABEL: &str = "Share…";

const IMAGE_CONTEXT_MENU_LABELS: &[&str] = &[
    COPY_IMAGE_CONTEXT_MENU_LABEL,
    "Download image",
    SHARE_CONTEXT_MENU_LABEL,
    "Copy image address",
    "Open image in browser",
];
const VIDEO_CONTEXT_MENU_LABELS: &[&str] = &[
    "Download video",
    SHARE_CONTEXT_MENU_LABEL,
    "Copy video address",
];
const LINK_CONTEXT_MENU_LABELS: &[&str] = &["Copy link address", "Open link in browser"];
const IMAGE_CONTEXT_MENU_LABELS_NO_SHARE: &[&str] = &[
    COPY_IMAGE_CONTEXT_MENU_LABEL,
    "Download image",
    "Copy image address",
    "Open image in browser",
];
const VIDEO_CONTEXT_MENU_LABELS_NO_SHARE: &[&str] = &["Download video", "Copy video address"];

/// A message's own actions, in menu order. Each is driven through Messenger's
/// hover toolbar; the page sends only the ones Messenger offers.
const MESSAGE_CONTEXT_MENU_LABELS: &[&str] = &[
    "Reply",
    COPY_TEXT_CONTEXT_MENU_LABEL,
    "Edit",
    "Forward",
    "Pin",
    "Unpin",
    "Unsend",
    "Remove",
];
const COPY_TEXT_CONTEXT_MENU_LABEL: &str = "Copy text";
/// A chat-list conversation's own menu rows, in menu order. Each is driven
/// through the row's "More options" menu; the page sends only the ones
/// Messenger offers, followed by the link rows.
const CHAT_ROW_CONTEXT_MENU_LABELS: &[&str] = &[
    "Mark as read",
    "Mark as unread",
    "Mute notifications",
    "Unmute notifications",
    "View profile",
    "Start end-to-end encrypted chat",
    "Block",
    "Unblock",
    "Archive chat",
    "Unarchive chat",
    "Delete chat",
    "Report",
    "Leave group",
];
const REACT_CONTEXT_MENU_LABEL: &str = "React";
const MAX_CONTEXT_MENU_REACTIONS: usize = 12;
const MAX_CONTEXT_MENU_VALUE: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct NativeContextMenuItem {
    pub(crate) label: String,
    pub(crate) action: String,
    pub(crate) value: Option<String>,
    /// A quick reaction: shown in the React submenu, checked when it is
    /// already the user's reaction to the message.
    #[serde(default)]
    pub(crate) reaction: bool,
    #[serde(default)]
    pub(crate) checked: bool,
}

/// Whether `items` are exactly `labels`, with a value only at `value_index`.
fn matches_shape(items: &[NativeContextMenuItem], labels: &[&str], value_index: usize) -> bool {
    items.len() == labels.len()
        && items.iter().enumerate().all(|(index, item)| {
            item.label == labels[index]
                && !item.reaction
                && !item.checked
                && item.value.is_some() == (index == value_index)
        })
}

/// The media and link menus, each with the index of its copied value.
fn media_context_menu_shapes() -> Vec<(&'static [&'static str], usize)> {
    let mut shapes = vec![
        (IMAGE_CONTEXT_MENU_LABELS, 3),
        (VIDEO_CONTEXT_MENU_LABELS, 2),
        (LINK_CONTEXT_MENU_LABELS, 0),
    ];
    if cfg!(not(target_os = "macos")) {
        shapes.push((IMAGE_CONTEXT_MENU_LABELS_NO_SHARE, 2));
        shapes.push((VIDEO_CONTEXT_MENU_LABELS_NO_SHARE, 1));
    }
    shapes
}

/// A reaction label must be a short emoji. Messenger supplies them from the
/// page, so letters, spacing, and invisible or direction-changing characters
/// are refused: a label can never pose as a different menu row.
fn valid_reaction_label(label: &str) -> bool {
    let units = label.encode_utf16().count();
    (1..=16).contains(&units)
        && label.chars().all(|c| {
            !c.is_ascii()
                && !c.is_alphanumeric()
                && !c.is_whitespace()
                && !c.is_control()
                && !matches!(
                    c as u32,
                    0x200B..=0x200C | 0x200E..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0xFEFF
                )
        })
}

/// Quick reactions first, then message actions in their fixed order; only
/// Copy text carries a value.
fn valid_message_items(items: &[NativeContextMenuItem]) -> bool {
    let reactions = items.iter().take_while(|item| item.reaction).count();
    let mut next_label = 0;
    reactions <= MAX_CONTEXT_MENU_REACTIONS
        && items[..reactions]
            .iter()
            .all(|item| item.value.is_none() && valid_reaction_label(&item.label))
        && items[reactions..].iter().all(|item| {
            let Some(index) = MESSAGE_CONTEXT_MENU_LABELS[next_label..]
                .iter()
                .position(|label| *label == item.label)
            else {
                return false;
            };
            next_label += index + 1;
            !item.reaction
                && !item.checked
                && item.value.is_some() == (item.label == COPY_TEXT_CONTEXT_MENU_LABEL)
        })
}

/// A conversation's own rows in their fixed order, then the link rows.
fn valid_chat_row_items(items: &[NativeContextMenuItem]) -> bool {
    let Some(split) = items.len().checked_sub(LINK_CONTEXT_MENU_LABELS.len()) else {
        return false;
    };
    let (rows, link) = items.split_at(split);
    let mut next_label = 0;
    !rows.is_empty()
        && matches_shape(link, LINK_CONTEXT_MENU_LABELS, 0)
        && rows.iter().all(|item| {
            let Some(index) = CHAT_ROW_CONTEXT_MENU_LABELS[next_label..]
                .iter()
                .position(|label| *label == item.label)
            else {
                return false;
            };
            next_label += index + 1;
            !item.reaction && !item.checked && item.value.is_none()
        })
}

/// A menu is one known media or link shape, a message's menu, a media shape
/// followed by the menu of the message that holds it, or a chat-list
/// conversation's menu followed by its link rows.
fn valid_context_menu_items(items: &[NativeContextMenuItem]) -> bool {
    let media_prefix = media_context_menu_shapes()
        .into_iter()
        .find_map(|(labels, value_index)| {
            let prefix = items.get(..labels.len())?;
            matches_shape(prefix, labels, value_index).then_some(labels.len())
        });
    let shape_valid = match media_prefix {
        Some(len) => valid_message_items(&items[len..]),
        None => (!items.is_empty() && valid_message_items(items)) || valid_chat_row_items(items),
    };
    let mut actions = std::collections::HashSet::new();
    shape_valid
        && items.iter().all(|item| {
            item.action.len() == 32
                && item.action.bytes().all(|byte| byte.is_ascii_hexdigit())
                && item
                    .value
                    .as_ref()
                    .is_none_or(|value| value.encode_utf16().count() <= MAX_CONTEXT_MENU_VALUE)
                && actions.insert(item.action.as_str())
        })
}

/// Build, validate, and pop up the native media context menu.
///
/// `on_presented` fires after every fallible setup step but *before*
/// `popup_menu`, which blocks until the menu is dismissed — the page must
/// receive its "shown" acknowledgment while the user is still browsing the
/// menu, or its result timeout tears the action handlers down mid-use.
pub(crate) fn show_native_context_menu(
    app: &tauri::AppHandle,
    label: &str,
    items: Vec<NativeContextMenuItem>,
    position: Option<tauri::LogicalPosition<f64>>,
    on_presented: impl FnOnce(),
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
    if let Err(error) = append_context_menu_items(app, &menu, label, &items) {
        log::warn!("failed to build native context menu: {error}");
        return false;
    }
    {
        let state = app.state::<AppState>();
        let mut copies = state.context_menu_copy_values.lock().unwrap();
        copies.retain(|(window, _), _| window != label);
        for item in &items {
            if let Some(value) = &item.value {
                let copied = if item.label == COPY_TEXT_CONTEXT_MENU_LABEL {
                    "Text copied"
                } else {
                    "Address copied"
                };
                copies.insert(
                    (label.to_string(), item.action.clone()),
                    (value.clone(), copied),
                );
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
                && (item.label == COPY_IMAGE_CONTEXT_MENU_LABEL
                    || item.label == SHARE_CONTEXT_MENU_LABEL)
            {
                activations.insert(key, ContextMenuActivation::Pending);
            }
        }
    }
    on_presented();
    // A keyboard-opened menu has no pointer to pop up at; the page passes the
    // focused message's position instead.
    let shown = match position {
        Some(position) => window.popup_menu_at(&menu, position),
        None => window.popup_menu(&menu),
    };
    match shown {
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

/// Media rows, then (after a separator) a React submenu and the message's
/// actions; or a conversation's rows, then the link rows. Item ids carry only
/// the window and the opaque action token.
fn append_context_menu_items(
    app: &tauri::AppHandle,
    menu: &Menu<tauri::Wry>,
    label: &str,
    items: &[NativeContextMenuItem],
) -> tauri::Result<()> {
    let id = |item: &NativeContextMenuItem| format!("carrier-context:{label}:{}", item.action);
    // Media rows, the React submenu, message actions, and conversation
    // actions each form a group.
    let group = |item: &NativeContextMenuItem| {
        if item.reaction {
            1
        } else if MESSAGE_CONTEXT_MENU_LABELS.contains(&item.label.as_str()) {
            2
        } else if CHAT_ROW_CONTEXT_MENU_LABELS.contains(&item.label.as_str()) {
            3
        } else {
            0
        }
    };
    let mut reactions: Option<tauri::menu::Submenu<tauri::Wry>> = None;
    let mut previous = None;
    for item in items {
        if previous.is_some_and(|previous| previous != group(item)) {
            menu.append(&tauri::menu::PredefinedMenuItem::separator(app)?)?;
        }
        previous = Some(group(item));
        if item.reaction {
            let submenu = match &reactions {
                Some(submenu) => submenu.clone(),
                None => {
                    let submenu = SubmenuBuilder::new(app, REACT_CONTEXT_MENU_LABEL).build()?;
                    menu.append(&submenu)?;
                    reactions = Some(submenu.clone());
                    submenu
                }
            };
            submenu.append(
                &tauri::menu::CheckMenuItemBuilder::new(&item.label)
                    .id(id(item))
                    .checked(item.checked)
                    .build(app)?,
            )?;
        } else {
            menu.append(&MenuItemBuilder::new(&item.label).id(id(item)).build(app)?)?;
        }
    }
    Ok(())
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

/// One entry of the recent-conversations list the page reads from Messenger's
/// database (or the chat list) and pushes over `carrier:recent-threads`.
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
    validated_thread_path(&format!("/t/{id}/"))
}

/// The recent-threads list as native menus should show it: empty while names
/// are hidden, so contact names never surface in the Dock/tray menu
/// of a screen-shared machine.
pub(crate) fn recent_threads_for_menu(app: &tauri::AppHandle) -> Vec<RecentThread> {
    let state = app.state::<AppState>();
    if state.settings.lock().unwrap().hides_names() {
        return Vec::new();
    }
    state.recent_threads.lock().unwrap().clone()
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
    Pause,
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
    entries.push(DockEntry::Pause);
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
                DockEntry::Pause => {
                    let now = crate::pause::now_ms();
                    let state = crate::pause::pause_state(
                        &app.state::<AppState>().settings.lock().unwrap(),
                        now,
                    );
                    let (title, entries) = crate::pause::pause_menu(state, now);
                    let submenu = muda::Submenu::new(&title, true);
                    for (id, label, enabled) in entries {
                        if let Err(error) =
                            submenu.append(&muda::MenuItem::with_id(id, &label, enabled, None))
                        {
                            log::warn!("failed to append macOS Dock pause item: {error}");
                        }
                    }
                    menu.append(&submenu)
                }
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
        DOCK_NS_MENU.store(ptr, std::sync::atomic::Ordering::SeqCst);
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
        drop(tray);
        // The Windows taskbar jump list mirrors the tray's recent conversations.
        #[cfg(target_os = "windows")]
        crate::windows::jumplist::rebuild_jump_list(recent_threads_for_menu(app));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_dialog_has_visible_product_metadata() {
        let metadata = about_metadata("1.12.0");

        assert_eq!(metadata.name.as_deref(), Some("Carrier"));
        assert_eq!(metadata.version.as_deref(), Some("1.12.0"));
        assert_eq!(metadata.authors, Some(vec!["kristofferR".into()]));
        assert_eq!(metadata.license.as_deref(), Some("MIT"));
        assert_eq!(
            metadata.comments.as_deref(),
            Some("A tiny, distraction-free desktop client for Facebook Messenger.")
        );
        assert_eq!(
            metadata.website.as_deref(),
            Some("https://github.com/kristofferR/Carrier")
        );
        assert_eq!(metadata.website_label.as_deref(), Some("GitHub"));
    }

    #[test]
    fn plain_text_paste_escapes_clipboard_content_for_javascript() {
        let script = paste_plain_text_script("'); window.pwned = true; //\nnext");

        assert_eq!(
            script,
            "document.execCommand('insertText', false, \"'); window.pwned = true; //\\nnext\");"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_edit_menu_uses_webkit_editing_commands() {
        assert_eq!(linux_editing_command("edit_undo"), Some("Undo"));
        assert_eq!(linux_editing_command("edit_redo"), Some("Redo"));
        assert_eq!(linux_editing_command("edit_cut"), Some("Cut"));
        assert_eq!(linux_editing_command("edit_copy"), Some("Copy"));
        assert_eq!(linux_editing_command("edit_paste"), Some("Paste"));
        assert_eq!(
            linux_editing_command("paste_match_style"),
            Some("PasteAsPlainText")
        );
        assert_eq!(linux_editing_command("edit_select_all"), Some("SelectAll"));
        assert_eq!(linux_editing_command("unknown"), None);
    }

    fn injected_context_menu_labels(name: &str) -> Vec<&'static str> {
        let source = match name {
            "MESSAGE_CONTEXT_MENU_LABELS" => {
                include_str!("../../inject/src/messenger/lib/message-menu.ts")
            }
            "CHAT_ROW_CONTEXT_MENU_LABELS" => {
                include_str!("../../inject/src/messenger/lib/chat-row-menu.ts")
            }
            _ => include_str!("../../inject/src/messenger/features/context-menu.ts"),
        };
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
            reaction: false,
            checked: false,
        }
    }

    fn reaction_item(label: &str, action: char) -> NativeContextMenuItem {
        NativeContextMenuItem {
            reaction: true,
            ..context_item(label, action)
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
            vec![
                DockEntry::NewConversation,
                DockEntry::Pause,
                DockEntry::Settings
            ]
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
                DockEntry::Pause,
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
    fn message_menus_take_reactions_then_actions_in_order() {
        let mut message = vec![
            reaction_item("❤️", '1'),
            reaction_item("👍", '2'),
            context_item("Reply", '3'),
            context_item("Copy text", '4'),
            context_item("Forward", '5'),
            context_item("Unsend", '6'),
        ];
        message[1].checked = true;
        message[3].value = Some("hello".into());
        assert!(valid_context_menu_items(&message));

        // Copy text must carry its text, and nothing else may.
        message[3].value = None;
        assert!(!valid_context_menu_items(&message));
        message[3].value = Some("hello".into());
        message[2].value = Some("smuggled".into());
        assert!(!valid_context_menu_items(&message));
        message[2].value = None;

        // Out of order, repeated, or unknown actions are refused.
        message.swap(4, 5);
        assert!(!valid_context_menu_items(&message));
        message.swap(4, 5);
        message[5].label = "Forward".into();
        assert!(!valid_context_menu_items(&message));
        message[5].label = "Allow microphone".into();
        assert!(!valid_context_menu_items(&message));
        message.pop();

        // Reactions come first and never pose as actions.
        message.swap(1, 2);
        assert!(!valid_context_menu_items(&message));
        message.swap(1, 2);
        let mut posing = reaction_item("Reply", '7');
        posing.action = "7".repeat(32);
        message.insert(0, posing);
        assert!(!valid_context_menu_items(&message));
        message.remove(0);

        // An action is never checked.
        message[2].checked = true;
        assert!(!valid_context_menu_items(&message));
    }

    #[test]
    fn media_menus_may_carry_their_message_menu() {
        let mut items = vec![
            context_item("Download video", '1'),
            context_item("Copy video address", '2'),
            reaction_item("😆", '3'),
            context_item("Reply", '4'),
            context_item("Forward", '5'),
        ];
        items[1].value = Some("https://example.com/video.mp4".into());
        let valid = valid_context_menu_items(&items);
        assert_eq!(valid, cfg!(not(target_os = "macos")));
        assert!(!valid_context_menu_items(&[]));
    }

    #[test]
    fn chat_row_menus_end_with_their_link_rows() {
        let link = |action: char| {
            let mut copy = context_item("Copy link address", action);
            copy.value = Some("https://www.facebook.com/messages/t/1/".into());
            copy
        };
        let mut items = vec![
            context_item("Mark as unread", '1'),
            context_item("Mute notifications", '2'),
            context_item("Archive chat", '3'),
            context_item("Leave group", '4'),
            link('5'),
            context_item("Open link in browser", '6'),
        ];
        assert!(valid_context_menu_items(&items));

        // Rows keep their fixed order, never repeat, and carry no value.
        items.swap(0, 1);
        assert!(!valid_context_menu_items(&items));
        items.swap(0, 1);
        items[1].label = "Mark as unread".into();
        assert!(!valid_context_menu_items(&items));
        items[1].label = "Mute notifications".into();
        items[2].value = Some("x".into());
        assert!(!valid_context_menu_items(&items));
        items[2].value = None;

        // Unknown rows, message actions, and calls are refused.
        for label in ["Audio call", "Reply", "Allow microphone"] {
            items[2].label = label.into();
            assert!(!valid_context_menu_items(&items), "{label}");
        }
        items[2].label = "Archive chat".into();

        // The link rows must close the menu, complete.
        items.pop();
        assert!(!valid_context_menu_items(&items));
        let rows_only: Vec<_> = items.drain(..4).collect();
        assert!(!valid_context_menu_items(&rows_only));
    }

    #[test]
    fn reaction_labels_are_short_emoji_only() {
        for label in ["❤", "❤️", "👍", "👍🏽", "👨‍👩‍👧", "🇳🇴"] {
            assert!(valid_reaction_label(label), "{label}");
        }
        for label in [
            "",
            "Reply",
            "👍 Pin",
            "a",
            "\u{202E}👍",
            "👍\u{200B}",
            "😀😀😀😀😀😀😀😀😀",
        ] {
            assert!(!valid_reaction_label(label), "{label:?}");
        }
    }

    #[test]
    fn native_context_menu_allowlist_matches_injected_labels() {
        for (name, expected) in [
            ("IMAGE_CONTEXT_MENU_LABELS", IMAGE_CONTEXT_MENU_LABELS),
            ("VIDEO_CONTEXT_MENU_LABELS", VIDEO_CONTEXT_MENU_LABELS),
            ("LINK_CONTEXT_MENU_LABELS", LINK_CONTEXT_MENU_LABELS),
            ("MESSAGE_CONTEXT_MENU_LABELS", MESSAGE_CONTEXT_MENU_LABELS),
            ("CHAT_ROW_CONTEXT_MENU_LABELS", CHAT_ROW_CONTEXT_MENU_LABELS),
        ] {
            assert_eq!(injected_context_menu_labels(name), expected, "{name}");
        }
    }

    #[test]
    fn no_share_allowlists_track_the_primary_shapes() {
        let image: Vec<&str> = IMAGE_CONTEXT_MENU_LABELS
            .iter()
            .copied()
            .filter(|label| *label != SHARE_CONTEXT_MENU_LABEL)
            .collect();
        assert_eq!(image, IMAGE_CONTEXT_MENU_LABELS_NO_SHARE);

        let video: Vec<&str> = VIDEO_CONTEXT_MENU_LABELS
            .iter()
            .copied()
            .filter(|label| *label != SHARE_CONTEXT_MENU_LABEL)
            .collect();
        assert_eq!(video, VIDEO_CONTEXT_MENU_LABELS_NO_SHARE);
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
