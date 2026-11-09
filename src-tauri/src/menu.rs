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
use crate::i18n::t;
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
use crate::window::show_settings_window;

/// Help menu items that copy the share message and open the GitHub repository,
/// labelled with the app name.
fn share_and_star_items(
    app: &tauri::AppHandle,
) -> tauri::Result<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)> {
    let name = crate::i18n::APP_NAME;
    Ok((
        menu_item(
            app,
            "share_chatpane",
            &format!("Copy {name} Share Message"),
            None,
        )?,
        menu_item(
            app,
            "star_chatpane",
            &format!("Star {name} on GitHub"),
            None,
        )?,
    ))
}

fn about_metadata(version: &str) -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some("Chatpane".into()),
        version: Some(version.into()),
        authors: Some(vec!["kristofferR".into()]),
        comments: Some(t("menu.about_comments").into()),
        license: Some("MIT".into()),
        website: Some(crate::growth::REPO_URL.into()),
        website_label: Some("GitHub".into()),
        ..Default::default()
    }
}

/// Translated text as a menu label: muda reads `&` as a mnemonic marker, so a
/// literal one is doubled.
pub(crate) fn menu_label(text: &str) -> String {
    text.replace('&', "&&")
}

/// A menu item labelled with translated `label`.
fn menu_item(
    app: &tauri::AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    let mut builder = MenuItemBuilder::new(menu_label(label)).id(id);
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

/// Log Out… (Ref #356); the tray has it too.
fn log_out_item(app: &tauri::AppHandle) -> tauri::Result<MenuItem<tauri::Wry>> {
    menu_item(app, "log_out", t("menu.log_out"), None)
}

#[cfg(target_os = "macos")]
pub(crate) fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let prefs = menu_item(
        app,
        "preferences",
        t("menu.mac.settings"),
        Some("CmdOrCtrl+,"),
    )?;
    let log_out = log_out_item(app)?;
    let about = about_metadata(&app.package_info().version.to_string());
    let app_menu = SubmenuBuilder::new(app, APP_TITLE)
        .about_with_text(menu_label(t("menu.mac.about")), Some(about))
        .separator()
        .item(&prefs)
        .separator()
        .item(&log_out)
        .separator()
        .services_with_text(menu_label(t("menu.mac.services")))
        .separator()
        .hide_with_text(menu_label(t("menu.mac.hide")))
        .hide_others_with_text(menu_label(t("menu.mac.hide_others")))
        .show_all_with_text(menu_label(t("menu.mac.show_all")))
        .separator()
        .quit_with_text(menu_label(t("menu.mac.quit")))
        .build()?;

    let new_conversation = menu_item(
        app,
        "new_conversation",
        t("menu.file.new_conversation"),
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let new_window = menu_item(
        app,
        "new_window",
        t("menu.file.new_window"),
        Some("CmdOrCtrl+N"),
    )?;
    let export_html = menu_item(app, "export_html", t("menu.file.export_html"), None)?;
    let export_json = menu_item(app, "export_json", t("menu.file.export_json"), None)?;
    let close_window = menu_label(t("menu.mac.close_window"));
    let file = SubmenuBuilder::new(app, menu_label(t("menu.mac.file")))
        .item(&new_conversation)
        .item(&new_window)
        .separator()
        .item(&export_html)
        .item(&export_json)
        .separator()
        .close_window_with_text(&close_window)
        .build()?;

    let paste_match = menu_item(
        app,
        "paste_match_style",
        t("menu.mac.paste_match_style"),
        Some("CmdOrCtrl+Shift+Alt+V"),
    )?;
    let edit = SubmenuBuilder::new(app, menu_label(t("menu.mac.edit")))
        .undo_with_text(menu_label(t("menu.mac.undo")))
        .redo_with_text(menu_label(t("menu.mac.redo")))
        .separator()
        .cut_with_text(menu_label(t("menu.mac.cut")))
        .copy_with_text(menu_label(t("menu.mac.copy")))
        .paste_with_text(menu_label(t("menu.mac.paste")))
        .item(&paste_match)
        .select_all_with_text(menu_label(t("menu.mac.select_all")))
        .build()?;

    let reload = menu_item(app, "reload", t("menu.view.reload"), Some("CmdOrCtrl+R"))?;
    let clear_cache = menu_item(
        app,
        "clear_cache",
        t("menu.view.clear_cache"),
        Some("CmdOrCtrl+Shift+Backspace"),
    )?;
    let zreset = menu_item(
        app,
        "zoom_reset",
        t("menu.mac.actual_size"),
        Some("CmdOrCtrl+0"),
    )?;
    let zin = menu_item(app, "zoom_in", t("menu.mac.zoom_in"), Some("CmdOrCtrl+="))?;
    let zout = menu_item(app, "zoom_out", t("menu.mac.zoom_out"), Some("CmdOrCtrl+-"))?;
    let theme_sys = menu_item(app, "theme_system", t("menu.view.theme.system"), None)?;
    let theme_light = menu_item(app, "theme_light", t("menu.view.theme.light"), None)?;
    let theme_dark = menu_item(app, "theme_dark", t("menu.view.theme.dark"), None)?;
    let theme_menu = SubmenuBuilder::new(app, menu_label(t("menu.view.theme.title")))
        .item(&theme_sys)
        .item(&theme_light)
        .item(&theme_dark)
        .build()?;
    let toggle_info = menu_item(
        app,
        "toggle_info",
        t("menu.view.toggle_info"),
        Some("CmdOrCtrl+Shift+I"),
    )?;
    // Shift+N belongs to New Conversation, so "hide" gets Shift+H.
    let hide_names = menu_item(
        app,
        "hide_names",
        t("menu.view.hide_names"),
        Some("CmdOrCtrl+Shift+H"),
    )?;
    let aot = menu_item(
        app,
        "always_on_top",
        t("menu.view.toggle_always_on_top"),
        None,
    )?;
    let devtools = menu_item(
        app,
        "devtools",
        t("menu.view.devtools"),
        Some("CmdOrCtrl+Alt+I"),
    )?;
    let view = {
        let b = SubmenuBuilder::new(app, menu_label(t("menu.mac.view")))
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

    let maximize = menu_item(app, "maximize", t("menu.mac.zoom"), None)?;
    // Tauri registers this ID with AppKit after installing the application menu,
    // letting macOS add its supported window controls and live window list.
    let window = SubmenuBuilder::with_id(
        app,
        tauri::menu::WINDOW_SUBMENU_ID,
        menu_label(t("menu.mac.window")),
    )
    .minimize_with_text(menu_label(t("menu.mac.minimize")))
    .item(&maximize)
    .separator()
    .close_window_with_text(&close_window)
    .separator()
    .bring_all_to_front_with_text(menu_label(t("menu.mac.bring_all_to_front")))
    .build()?;

    let shortcuts = menu_item(
        app,
        "keyboard_shortcuts",
        t("menu.help.keyboard_shortcuts"),
        Some("CmdOrCtrl+/"),
    )?;
    let report_issue = menu_item(app, "report_issue", t("menu.help.report_issue"), None)?;
    let (share, star) = share_and_star_items(app)?;
    // Registered as the app's Help menu, so AppKit still adds its search field
    // when the title is translated.
    let help = SubmenuBuilder::with_id(
        app,
        tauri::menu::HELP_SUBMENU_ID,
        menu_label(t("menu.mac.help")),
    )
    .item(&shortcuts)
    .separator()
    .item(&report_issue)
    .item(&share)
    .item(&star)
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
        CheckMenuItem::with_id(app, id, menu_label(label), true, checked, accelerator)
    };

    let new_conversation = menu_item(
        app,
        "new_conversation",
        t("menu.file.new_conversation"),
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let new_window = menu_item(
        app,
        "new_window",
        t("menu.file.new_window"),
        Some("CmdOrCtrl+N"),
    )?;
    let export_html = menu_item(app, "export_html", t("menu.file.export_html"), None)?;
    let export_json = menu_item(app, "export_json", t("menu.file.export_json"), None)?;
    let close_window = menu_item(
        app,
        "close_window",
        t("menu.file.close_window"),
        Some("CmdOrCtrl+W"),
    )?;
    let preferences_label = if cfg!(target_os = "windows") {
        t("menu.settings")
    } else {
        t("menu.preferences")
    };
    let preferences = menu_item(app, "preferences", preferences_label, Some("CmdOrCtrl+,"))?;
    let quit_label = if cfg!(target_os = "windows") {
        t("menu.exit")
    } else {
        t("menu.quit")
    };
    let quit_accelerator = if cfg!(target_os = "linux") {
        Some("Ctrl+Q")
    } else {
        None
    };
    let quit = menu_item(app, "quit", quit_label, quit_accelerator)?;
    let log_out = log_out_item(app)?;
    let file_builder = SubmenuBuilder::new(app, menu_label(t("menu.file.title")))
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
        t("menu.edit.paste_match_style"),
        Some("CmdOrCtrl+Shift+Alt+V"),
    )?;
    #[cfg(target_os = "windows")]
    let edit = SubmenuBuilder::new(app, menu_label(t("menu.edit.title")))
        .id("edit")
        .undo_with_text(menu_label(t("menu.edit.undo")))
        .redo_with_text(menu_label(t("menu.edit.redo")))
        .separator()
        .cut_with_text(menu_label(t("menu.edit.cut")))
        .copy_with_text(menu_label(t("menu.edit.copy")))
        .paste_with_text(menu_label(t("menu.edit.paste")))
        .item(&paste_match)
        .separator()
        .select_all_with_text(menu_label(t("menu.edit.select_all")))
        .build()?;
    #[cfg(target_os = "linux")]
    let edit = {
        let undo = menu_item(app, "edit_undo", t("menu.edit.undo"), Some("Ctrl+Z"))?;
        let redo = menu_item(app, "edit_redo", t("menu.edit.redo"), Some("Ctrl+Shift+Z"))?;
        let cut = menu_item(app, "edit_cut", t("menu.edit.cut"), Some("Ctrl+X"))?;
        let copy = menu_item(app, "edit_copy", t("menu.edit.copy"), Some("Ctrl+C"))?;
        let paste = menu_item(app, "edit_paste", t("menu.edit.paste"), Some("Ctrl+V"))?;
        let select_all = menu_item(
            app,
            "edit_select_all",
            t("menu.edit.select_all"),
            Some("Ctrl+A"),
        )?;
        SubmenuBuilder::new(app, menu_label(t("menu.edit.title")))
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

    let reload = menu_item(app, "reload", t("menu.view.reload"), Some("CmdOrCtrl+R"))?;
    let conversation_info = menu_item(
        app,
        "toggle_info",
        t("menu.view.conversation_info"),
        Some("CmdOrCtrl+Shift+I"),
    )?;
    let hide_names = check_item(
        "hide_names",
        t("menu.view.hide_names_check"),
        settings.hides_names() || settings.hides_avatars(),
        Some("CmdOrCtrl+Shift+H"),
    )?;
    let always_on_top = check_item(
        "always_on_top",
        t("menu.view.always_on_top"),
        settings.always_on_top,
        None,
    )?;
    let zoom_in = menu_item(app, "zoom_in", t("menu.view.zoom_in"), Some("CmdOrCtrl+="))?;
    let zoom_out = menu_item(
        app,
        "zoom_out",
        t("menu.view.zoom_out"),
        Some("CmdOrCtrl+-"),
    )?;
    let actual_size = menu_item(
        app,
        "zoom_reset",
        t("menu.view.actual_size"),
        Some("CmdOrCtrl+0"),
    )?;
    let theme_system = check_item(
        "theme_system",
        t("menu.view.theme.system"),
        settings.theme == "system",
        None,
    )?;
    let theme_light = check_item(
        "theme_light",
        t("menu.view.theme.light"),
        settings.theme == "light",
        None,
    )?;
    let theme_dark = check_item(
        "theme_dark",
        t("menu.view.theme.dark"),
        settings.theme == "dark",
        None,
    )?;
    let theme = SubmenuBuilder::new(app, menu_label(t("menu.view.theme.title")))
        .id("theme")
        .item(&theme_system)
        .item(&theme_light)
        .item(&theme_dark)
        .build()?;
    let devtools = menu_item(
        app,
        "devtools",
        t("menu.view.devtools"),
        Some("CmdOrCtrl+Alt+I"),
    )?;
    let view_builder = SubmenuBuilder::new(app, menu_label(t("menu.view.title")))
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
        t("menu.help.keyboard_shortcuts"),
        Some("CmdOrCtrl+/"),
    )?;
    let report_issue = menu_item(app, "report_issue", t("menu.help.report_issue"), None)?;
    let clear_cache = menu_item(
        app,
        "clear_cache",
        t("menu.help.clear_cache"),
        Some("CmdOrCtrl+Shift+Backspace"),
    )?;
    let (share, star) = share_and_star_items(app)?;
    let about = about_metadata(&app.package_info().version.to_string());
    let help = SubmenuBuilder::new(app, menu_label(t("menu.help.title")))
        .id("help")
        .item(&shortcuts)
        .item(&report_issue)
        .item(&share)
        .item(&star)
        .separator()
        .item(&clear_cache)
        .separator()
        .about_with_text(menu_label(t("menu.about")), Some(about))
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
/// run while Chatpane is hidden, and a hidden window has no Wayland surface:
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
        .message(t("menu.dialog.clear_cache.message"))
        .title(t("menu.dialog.clear_cache.title"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            t("menu.dialog.clear_cache.confirm").into(),
            t("dialog.cancel").into(),
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

/// Open another window on Facebook's session (File > New Window, Facebook's
/// language settings). On macOS the first extra window reloads the open ones
/// onto Messenger's shared engine, so ask first if that would interrupt a call
/// or an unsent message.
pub(crate) fn request_extra_window<F, Fut>(app: &tauri::AppHandle, open: F)
where
    F: FnOnce(tauri::AppHandle) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    // Off the event-loop handler to avoid the Windows window-creation deadlock.
    let open = move |app: tauri::AppHandle| {
        tauri::async_runtime::spawn(open(app));
    };
    #[cfg(target_os = "macos")]
    if crate::window::opening_window_reloads_others()
        && crate::webview_watchdog::any_messenger_window_protected()
    {
        let app_handle = app.clone();
        let mut dialog = app
            .dialog()
            .message(t("menu.dialog.new_window.message"))
            .title(t("menu.dialog.new_window.title"))
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                t("menu.dialog.new_window.confirm").into(),
                t("dialog.cancel").into(),
            ));
        // The window asking: Settings, for the language settings.
        if let Some(window) =
            focused_window(app).filter(|window| window.is_visible().unwrap_or(false))
        {
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
                    t("shared.context.copy_failed")
                }
            };
            if let Some(window) = app.get_webview_window(label)
                && let Ok(toast) = serde_json::to_string(toast)
            {
                let _ = window.eval(format!("window.__chatpaneToast?.({toast})"));
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
                    "window.dispatchEvent(new CustomEvent('chatpane:context-action', {{ detail: {detail} }}));"
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
        "zoom_in" => eval("window.__chatpaneZoomIn && window.__chatpaneZoomIn()"),
        "zoom_out" => eval("window.__chatpaneZoomOut && window.__chatpaneZoomOut()"),
        "zoom_reset" => eval("window.__chatpaneZoomReset && window.__chatpaneZoomReset()"),
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
        "toggle_info" => eval("window.__chatpaneToggleInfo && window.__chatpaneToggleInfo()"),
        "keyboard_shortcuts" => {
            eval("window.__chatpaneToggleShortcuts && window.__chatpaneToggleShortcuts()")
        }
        "report_issue" => {
            if let Err(error) = app.opener().open_url(
                format!("{}/issues", crate::growth::REPO_URL),
                None::<String>,
            ) {
                log::warn!("failed to open issue tracker: {error}");
            }
        }
        "share_chatpane" => {
            let toast = match crate::growth::copy_share_message(app) {
                Ok(()) => crate::growth::SHARE_COPIED.to_string(),
                Err(error) => error,
            };
            if let (Some(window), Ok(toast)) = (target_window(app), serde_json::to_string(&toast)) {
                let _ = window.eval(format!("window.__chatpaneToast?.({toast})"));
            }
        }
        "star_chatpane" => crate::growth::open_repo(app),
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
        "new_window" => request_extra_window(app, crate::window::open_messenger_window),
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

// The page names each row by its string key and Rust shows `t(key)`, so the
// page can never put its own text in a native menu; only reactions carry
// their emoji, checked by `valid_reaction_label`. The TypeScript arrays with
// the same names are kept in sync by a test.

/// The two rows that register a macOS activation when selected. Named so the
/// activation check below cannot drift from the key arrays: a video menu's
/// Share row must stay the same key as an image menu's.
const COPY_IMAGE_CONTEXT_MENU_KEY: &str = "shared.context.copy_image";
const SHARE_CONTEXT_MENU_KEY: &str = "shared.context.share";

const IMAGE_CONTEXT_MENU_KEYS: &[&str] = &[
    COPY_IMAGE_CONTEXT_MENU_KEY,
    "shared.context.download_image",
    SHARE_CONTEXT_MENU_KEY,
    "shared.context.copy_image_address",
    "shared.context.open_image_in_browser",
];
const VIDEO_CONTEXT_MENU_KEYS: &[&str] = &[
    "shared.context.download_video",
    SHARE_CONTEXT_MENU_KEY,
    "shared.context.copy_video_address",
];
const LINK_CONTEXT_MENU_KEYS: &[&str] = &[
    "shared.context.copy_link_address",
    "shared.context.open_link_in_browser",
];
const IMAGE_CONTEXT_MENU_KEYS_NO_SHARE: &[&str] = &[
    COPY_IMAGE_CONTEXT_MENU_KEY,
    "shared.context.download_image",
    "shared.context.copy_image_address",
    "shared.context.open_image_in_browser",
];
const VIDEO_CONTEXT_MENU_KEYS_NO_SHARE: &[&str] = &[
    "shared.context.download_video",
    "shared.context.copy_video_address",
];

/// A message's own actions, in menu order. Each is driven through Messenger's
/// hover toolbar; the page sends only the ones Messenger offers.
const MESSAGE_CONTEXT_MENU_KEYS: &[&str] = &[
    "shared.context.reply",
    COPY_TEXT_CONTEXT_MENU_KEY,
    "shared.context.edit",
    "shared.context.forward",
    "shared.context.pin",
    "shared.context.unpin",
    "shared.context.unsend",
    "shared.context.remove",
];
const COPY_TEXT_CONTEXT_MENU_KEY: &str = "shared.context.copy_text";
/// A chat-list conversation's own menu rows, in menu order. Each is driven
/// through the row's "More options" menu; the page sends only the ones
/// Messenger offers.
const CHAT_ROW_CONTEXT_MENU_KEYS: &[&str] = &[
    "shared.context.mark_as_read",
    "shared.context.mark_as_unread",
    "shared.context.mute_notifications",
    "shared.context.unmute_notifications",
    "shared.context.view_profile",
    "shared.context.start_encrypted_chat",
    "shared.context.block",
    "shared.context.unblock",
    "shared.context.archive_chat",
    "shared.context.unarchive_chat",
    "shared.context.delete_chat",
    "shared.context.report",
    "shared.context.leave_group",
];
/// Chatpane's own conversation rows, after Messenger's: export the chat. The
/// native menu shows them as an "Export chat" submenu of the formats in
/// `CHAT_EXPORT_FORMATS`, index-aligned.
const CHAT_EXPORT_CONTEXT_MENU_KEYS: &[&str] = &[
    "shared.context.export_chat_html",
    "shared.context.export_chat_json",
];
const CHAT_EXPORT_FORMATS: [&str; 2] = ["HTML…", "JSON…"];
const MAX_CONTEXT_MENU_REACTIONS: usize = 12;
const MAX_CONTEXT_MENU_VALUE: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct NativeContextMenuItem {
    /// The row's string key from the arrays above, or a reaction's emoji.
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

/// The allowlisted key a page-sent row names.
fn context_menu_key(label: &str) -> Option<&'static str> {
    [
        IMAGE_CONTEXT_MENU_KEYS,
        VIDEO_CONTEXT_MENU_KEYS,
        LINK_CONTEXT_MENU_KEYS,
        MESSAGE_CONTEXT_MENU_KEYS,
        CHAT_ROW_CONTEXT_MENU_KEYS,
        CHAT_EXPORT_CONTEXT_MENU_KEYS,
    ]
    .into_iter()
    .flatten()
    .copied()
    .find(|key| *key == label)
}

/// Whether `items` are exactly `keys`, with a value only at `value_index`.
fn matches_shape(items: &[NativeContextMenuItem], keys: &[&str], value_index: usize) -> bool {
    items.len() == keys.len()
        && items.iter().enumerate().all(|(index, item)| {
            item.label == keys[index]
                && !item.reaction
                && !item.checked
                && item.value.is_some() == (index == value_index)
        })
}

/// The media and link menus, each with the index of its copied value.
fn media_context_menu_shapes() -> Vec<(&'static [&'static str], usize)> {
    let mut shapes = vec![
        (IMAGE_CONTEXT_MENU_KEYS, 3),
        (VIDEO_CONTEXT_MENU_KEYS, 2),
        (LINK_CONTEXT_MENU_KEYS, 0),
    ];
    if cfg!(not(target_os = "macos")) {
        shapes.push((IMAGE_CONTEXT_MENU_KEYS_NO_SHARE, 2));
        shapes.push((VIDEO_CONTEXT_MENU_KEYS_NO_SHARE, 1));
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
    let mut next_key = 0;
    reactions <= MAX_CONTEXT_MENU_REACTIONS
        && items[..reactions]
            .iter()
            .all(|item| item.value.is_none() && valid_reaction_label(&item.label))
        && items[reactions..].iter().all(|item| {
            let Some(index) = MESSAGE_CONTEXT_MENU_KEYS[next_key..]
                .iter()
                .position(|key| *key == item.label)
            else {
                return false;
            };
            next_key += index + 1;
            !item.reaction
                && !item.checked
                && item.value.is_some() == (item.label == COPY_TEXT_CONTEXT_MENU_KEY)
        })
}

/// A conversation's own rows, then its export rows, in their fixed order.
fn valid_chat_row_items(items: &[NativeContextMenuItem]) -> bool {
    let keys: Vec<&str> = CHAT_ROW_CONTEXT_MENU_KEYS
        .iter()
        .chain(CHAT_EXPORT_CONTEXT_MENU_KEYS)
        .copied()
        .collect();
    let mut next_key = 0;
    !items.is_empty()
        && items.iter().all(|item| {
            let Some(index) = keys[next_key..].iter().position(|key| *key == item.label) else {
                return false;
            };
            next_key += index + 1;
            !item.reaction && !item.checked && item.value.is_none()
        })
}

/// A menu is one known media or link shape, a message's menu, a media shape
/// followed by the menu of the message that holds it, or a chat-list
/// conversation's menu.
fn valid_context_menu_items(items: &[NativeContextMenuItem]) -> bool {
    let media_prefix = media_context_menu_shapes()
        .into_iter()
        .find_map(|(keys, value_index)| {
            let prefix = items.get(..keys.len())?;
            matches_shape(prefix, keys, value_index).then_some(keys.len())
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
        log::warn!("chatpane:context-menu payload was invalid");
        return false;
    }
    let Some(window) = app.get_webview_window(label) else {
        log::warn!("chatpane:context-menu target window {label:?} is gone");
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
                let copied = if item.label == COPY_TEXT_CONTEXT_MENU_KEY {
                    t("shared.context.text_copied")
                } else {
                    t("shared.context.address_copied")
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
                && (item.label == COPY_IMAGE_CONTEXT_MENU_KEY
                    || item.label == SHARE_CONTEXT_MENU_KEY)
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
/// actions; or a conversation's rows. Item ids carry only the window and the
/// opaque action token.
fn append_context_menu_items(
    app: &tauri::AppHandle,
    menu: &Menu<tauri::Wry>,
    label: &str,
    items: &[NativeContextMenuItem],
) -> tauri::Result<()> {
    let id = |item: &NativeContextMenuItem| format!("chatpane-context:{label}:{}", item.action);
    // Media rows, the React submenu, message actions, conversation actions,
    // and conversation export each form a group.
    let group = |item: &NativeContextMenuItem| {
        if item.reaction {
            1
        } else if MESSAGE_CONTEXT_MENU_KEYS.contains(&item.label.as_str()) {
            2
        } else if CHAT_ROW_CONTEXT_MENU_KEYS.contains(&item.label.as_str()) {
            3
        } else if CHAT_EXPORT_CONTEXT_MENU_KEYS.contains(&item.label.as_str()) {
            4
        } else {
            0
        }
    };
    let mut reactions: Option<tauri::menu::Submenu<tauri::Wry>> = None;
    let mut exports: Option<tauri::menu::Submenu<tauri::Wry>> = None;
    // The group's submenu, created on its first row.
    let submenu = |slot: &mut Option<tauri::menu::Submenu<tauri::Wry>>, title: &str| {
        if let Some(submenu) = slot {
            return Ok(submenu.clone());
        }
        let submenu = SubmenuBuilder::new(app, menu_label(title)).build()?;
        menu.append(&submenu)?;
        *slot = Some(submenu.clone());
        tauri::Result::Ok(submenu)
    };
    let mut previous = None;
    for item in items {
        if previous.is_some_and(|previous| previous != group(item)) {
            menu.append(&tauri::menu::PredefinedMenuItem::separator(app)?)?;
        }
        previous = Some(group(item));
        if item.reaction {
            submenu(&mut reactions, t("shared.context.react"))?.append(
                &tauri::menu::CheckMenuItemBuilder::new(&item.label)
                    .id(id(item))
                    .checked(item.checked)
                    .build(app)?,
            )?;
        } else if let Some(format) = CHAT_EXPORT_CONTEXT_MENU_KEYS
            .iter()
            .position(|key| *key == item.label)
            .and_then(|index| CHAT_EXPORT_FORMATS.get(index))
        {
            submenu(&mut exports, t("menu.context.export_chat"))?
                .append(&MenuItemBuilder::new(*format).id(id(item)).build(app)?)?;
        } else if let Some(key) = context_menu_key(&item.label) {
            menu.append(
                &MenuItemBuilder::new(menu_label(t(key)))
                    .id(id(item))
                    .build(app)?,
            )?;
        }
    }
    Ok(())
}

fn context_menu_action(id: &str) -> Option<(&str, &str)> {
    let (label, action) = id.strip_prefix("chatpane-context:")?.rsplit_once(':')?;
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
/// database (or the chat list) and pushes over `chatpane:recent-threads`.
/// Held in memory only; conversation names/ids are never written to disk.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct RecentThread {
    pub(crate) name: String,
    pub(crate) href: String,
}

/// The `chatpane:recent-threads` payload crosses from the remote Facebook page,
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
                "window.__chatpaneOpenThread && window.__chatpaneOpenThread({arg});"
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
                    menu_label(&thread.name),
                    true,
                    None,
                )),
                DockEntry::Separator => menu.append(&muda::PredefinedMenuItem::separator()),
                DockEntry::NewConversation => menu.append(&muda::MenuItem::with_id(
                    "dock:new_conversation",
                    menu_label(t("menu.file.new_conversation")),
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
                    let submenu = muda::Submenu::new(menu_label(&title), true);
                    for (id, label, enabled) in entries {
                        if let Err(error) = submenu.append(&muda::MenuItem::with_id(
                            id,
                            menu_label(&label),
                            enabled,
                            None,
                        )) {
                            log::warn!("failed to append macOS Dock pause item: {error}");
                        }
                    }
                    menu.append(&submenu)
                }
                DockEntry::Settings => menu.append(&muda::MenuItem::with_id(
                    "dock:settings",
                    menu_label(t("menu.mac.settings")),
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

        assert_eq!(metadata.name.as_deref(), Some("Chatpane"));
        assert_eq!(metadata.version.as_deref(), Some("1.12.0"));
        assert_eq!(metadata.authors, Some(vec!["kristofferR".into()]));
        assert_eq!(metadata.license.as_deref(), Some("MIT"));
        assert_eq!(metadata.comments.as_deref(), Some(t("menu.about_comments")));
        assert_eq!(
            metadata.website.as_deref(),
            Some("https://github.com/kristofferR/Chatpane")
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

    fn injected_context_menu_keys(name: &str) -> Vec<&'static str> {
        let source = match name {
            "MESSAGE_CONTEXT_MENU_KEYS" => {
                include_str!("../../inject/src/messenger/lib/message-menu.ts")
            }
            "CHAT_ROW_CONTEXT_MENU_KEYS" | "CHAT_EXPORT_CONTEXT_MENU_KEYS" => {
                include_str!("../../inject/src/messenger/lib/chat-row-menu.ts")
            }
            _ => include_str!("../../inject/src/messenger/features/context-menu.ts"),
        };
        let declaration = format!("const {name} = [");
        let body = source
            .split_once(&declaration)
            .unwrap_or_else(|| panic!("missing injected key declaration {name}"))
            .1
            .split_once("] as const;")
            .unwrap_or_else(|| panic!("unterminated injected key declaration {name}"))
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
            context_item("shared.context.copy_image", '1'),
            context_item("shared.context.download_image", '2'),
            context_item("shared.context.share", '3'),
            context_item("shared.context.copy_image_address", '4'),
            context_item("shared.context.open_image_in_browser", '5'),
        ];
        image[3].value = Some("https://example.com/image.png".into());
        assert!(valid_context_menu_items(&image));

        image[0].value = image[3].value.take();
        assert!(!valid_context_menu_items(&image));
        image[3].value = image[0].value.take();

        // English text, other UI strings, and arbitrary text are refused.
        let mut spoofed = image;
        for label in ["Share…", "menu.quit_app", "Allow microphone"] {
            spoofed[2].label = label.into();
            assert!(!valid_context_menu_items(&spoofed), "{label}");
        }

        let mut duplicate = vec![
            context_item("shared.context.copy_link_address", 'a'),
            context_item("shared.context.open_link_in_browser", 'a'),
        ];
        duplicate[0].value = Some("https://example.com".into());
        assert!(!valid_context_menu_items(&duplicate));
    }

    #[test]
    fn message_menus_take_reactions_then_actions_in_order() {
        let mut message = vec![
            reaction_item("❤️", '1'),
            reaction_item("👍", '2'),
            context_item("shared.context.reply", '3'),
            context_item("shared.context.copy_text", '4'),
            context_item("shared.context.forward", '5'),
            context_item("shared.context.unsend", '6'),
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
        message[5].label = "shared.context.forward".into();
        assert!(!valid_context_menu_items(&message));
        message[5].label = "Allow microphone".into();
        assert!(!valid_context_menu_items(&message));
        message.pop();

        // Reactions come first and never pose as actions.
        message.swap(1, 2);
        assert!(!valid_context_menu_items(&message));
        message.swap(1, 2);
        let mut posing = reaction_item("shared.context.reply", '7');
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
            context_item("shared.context.download_video", '1'),
            context_item("shared.context.copy_video_address", '2'),
            reaction_item("😆", '3'),
            context_item("shared.context.reply", '4'),
            context_item("shared.context.forward", '5'),
        ];
        items[1].value = Some("https://example.com/video.mp4".into());
        let valid = valid_context_menu_items(&items);
        assert_eq!(valid, cfg!(not(target_os = "macos")));
        assert!(!valid_context_menu_items(&[]));
    }

    #[test]
    fn chat_row_menus_take_only_their_own_rows() {
        let mut items = vec![
            context_item("shared.context.mark_as_unread", '1'),
            context_item("shared.context.mute_notifications", '2'),
            context_item("shared.context.archive_chat", '3'),
            context_item("shared.context.leave_group", '4'),
        ];
        assert!(valid_context_menu_items(&items));

        // Export rows follow Messenger's, never precede them.
        items.push(context_item("shared.context.export_chat_html", '7'));
        items.push(context_item("shared.context.export_chat_json", '8'));
        assert!(valid_context_menu_items(&items));
        assert!(valid_context_menu_items(&items[4..]));
        items.swap(0, 4);
        assert!(!valid_context_menu_items(&items));
        items.swap(0, 4);
        items.truncate(4);

        // Rows keep their fixed order, never repeat, and carry no value.
        items.swap(0, 1);
        assert!(!valid_context_menu_items(&items));
        items.swap(0, 1);
        items[1].label = "shared.context.mark_as_unread".into();
        assert!(!valid_context_menu_items(&items));
        items[1].label = "shared.context.mute_notifications".into();
        items[2].value = Some("x".into());
        assert!(!valid_context_menu_items(&items));
        items[2].value = None;

        // Unknown rows, message actions, calls, and English text are refused.
        for label in [
            "shared.context.audio_call",
            "shared.context.reply",
            "Allow microphone",
            "Archive chat",
        ] {
            items[2].label = label.into();
            assert!(!valid_context_menu_items(&items), "{label}");
        }
        items[2].label = "shared.context.archive_chat".into();

        // The link's rows never join them.
        let mut copy = context_item("shared.context.copy_link_address", '5');
        copy.value = Some("https://www.facebook.com/messages/t/1/".into());
        items.push(copy);
        items.push(context_item("shared.context.open_link_in_browser", '6'));
        assert!(!valid_context_menu_items(&items));
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
    fn native_context_menu_allowlist_matches_injected_keys() {
        for (name, expected) in [
            ("IMAGE_CONTEXT_MENU_KEYS", IMAGE_CONTEXT_MENU_KEYS),
            ("VIDEO_CONTEXT_MENU_KEYS", VIDEO_CONTEXT_MENU_KEYS),
            ("LINK_CONTEXT_MENU_KEYS", LINK_CONTEXT_MENU_KEYS),
            ("MESSAGE_CONTEXT_MENU_KEYS", MESSAGE_CONTEXT_MENU_KEYS),
            ("CHAT_ROW_CONTEXT_MENU_KEYS", CHAT_ROW_CONTEXT_MENU_KEYS),
            (
                "CHAT_EXPORT_CONTEXT_MENU_KEYS",
                CHAT_EXPORT_CONTEXT_MENU_KEYS,
            ),
        ] {
            assert_eq!(injected_context_menu_keys(name), expected, "{name}");
        }
    }

    #[test]
    fn every_context_menu_key_has_text() {
        for key in [
            IMAGE_CONTEXT_MENU_KEYS,
            VIDEO_CONTEXT_MENU_KEYS,
            LINK_CONTEXT_MENU_KEYS,
            MESSAGE_CONTEXT_MENU_KEYS,
            CHAT_ROW_CONTEXT_MENU_KEYS,
            CHAT_EXPORT_CONTEXT_MENU_KEYS,
        ]
        .concat()
        {
            assert_eq!(context_menu_key(key), Some(key));
            assert_ne!(t(key), key, "{key} has no text");
        }
    }

    #[test]
    fn menu_labels_keep_a_literal_ampersand() {
        assert_eq!(
            menu_label("Clear Cache & Restart"),
            "Clear Cache && Restart"
        );
        assert_eq!(menu_label("Reload"), "Reload");
    }

    #[test]
    fn no_share_allowlists_track_the_primary_shapes() {
        let image: Vec<&str> = IMAGE_CONTEXT_MENU_KEYS
            .iter()
            .copied()
            .filter(|key| *key != SHARE_CONTEXT_MENU_KEY)
            .collect();
        assert_eq!(image, IMAGE_CONTEXT_MENU_KEYS_NO_SHARE);

        let video: Vec<&str> = VIDEO_CONTEXT_MENU_KEYS
            .iter()
            .copied()
            .filter(|key| *key != SHARE_CONTEXT_MENU_KEY)
            .collect();
        assert_eq!(video, VIDEO_CONTEXT_MENU_KEYS_NO_SHARE);
    }

    #[test]
    fn native_context_action_ids_bind_the_window_and_opaque_action() {
        let token = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            context_menu_action(&format!("chatpane-context:win-2:{token}")),
            Some(("win-2", token))
        );
        assert_eq!(context_menu_action("chatpane-context:win-2:share"), None);
        assert_eq!(context_menu_action(&format!("other:win-2:{token}")), None);
    }
}
