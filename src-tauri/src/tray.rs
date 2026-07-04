//! Tray icon: creation, the left-click toggle / right-click Quit behaviour,
//! and showing or reopening the main window.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

#[cfg(target_os = "macos")]
use crate::menu::target_window;
use crate::menu::{recent_menu_id, recent_threads_for_menu};
use crate::settings::{AppState, Settings};
use crate::window::{build_app_window, install_main_close_handler};
use crate::APP_TITLE;

fn reveal_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        reveal_window(&window);
        return;
    }

    if app
        .state::<AppState>()
        .recreating
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }

    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    if let Ok(window) = build_app_window(app, "main", &settings) {
        install_main_close_handler(app, &window);
        reveal_window(&window);
    }
}

/// Show the main window if it's hidden/unfocused, or hide it if it's already the
/// focused window — so a tray click toggles the app.
pub(crate) fn toggle_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            reveal_window(&window);
        }
    } else {
        show_main(app);
    }
}

#[cfg(target_os = "macos")]
fn has_visible_messenger_window(app: &tauri::AppHandle) -> bool {
    app.webview_windows().into_iter().any(|(label, window)| {
        label != "settings"
            && window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false)
    })
}

#[cfg(target_os = "macos")]
fn should_reopen_main(has_visible_windows: bool, has_visible_messenger_window: bool) -> bool {
    !has_visible_windows || !has_visible_messenger_window
}

#[cfg(target_os = "macos")]
pub(crate) fn reopen_main_if_needed(app: &tauri::AppHandle, has_visible_windows: bool) {
    if should_reopen_main(has_visible_windows, has_visible_messenger_window(app)) {
        show_main(app);
    }
}

/// Whether a tray icon should exist: when the user asked for one, or when
/// menu-bar-only mode is on (the only way back to a Dock-less app).
pub(crate) fn wants_tray(s: &Settings) -> bool {
    s.show_tray || s.menu_bar_only
}

pub(crate) fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    // Most recent conversations first (mirrors the macOS Dock menu); clicking
    // one opens that thread. Empty until the page has pushed a list.
    let threads = recent_threads_for_menu(app);
    for t in &threads {
        menu.append(&MenuItem::with_id(
            app,
            recent_menu_id(t),
            &t.name,
            true,
            None::<&str>,
        )?)?;
    }
    if !threads.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit Carrier",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

#[cfg(target_os = "macos")]
fn show_tray_menu(app: &tauri::AppHandle) {
    let Some(window) = target_window(app).or_else(|| app.get_webview_window("main")) else {
        return;
    };
    if let Ok(menu) = build_tray_menu(app) {
        let _ = window.popup_menu(&menu);
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn tray_unread_title(s: &Settings, unread: i64) -> Option<String> {
    if s.unread_badge && unread > 0 {
        Some(unread.to_string())
    } else {
        // tray-icon's macOS backend ignores None, so clear with an empty title.
        Some(String::new())
    }
}

pub(crate) fn build_tray_with_menu(
    app: &tauri::AppHandle,
    menu: Menu<tauri::Wry>,
) -> tauri::Result<TrayIcon> {
    let builder = TrayIconBuilder::with_id("carrier-tray")
        .tooltip(APP_TITLE)
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                match (button, button_state) {
                    (MouseButton::Left, MouseButtonState::Up) => toggle_main(tray.app_handle()),
                    #[cfg(target_os = "macos")]
                    (MouseButton::Right, MouseButtonState::Down) => {
                        show_tray_menu(tray.app_handle());
                    }
                    _ => {}
                }
            }
        });

    #[cfg(not(target_os = "macos"))]
    let builder = builder.menu(&menu);
    #[cfg(target_os = "macos")]
    let _ = &menu;

    builder.build(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // want_tray logic  (new in this PR: show_tray || menu_bar_only)
    // -----------------------------------------------------------------------

    #[test]
    fn wants_tray_true_when_show_tray_set() {
        // show_tray defaults to true.
        assert!(wants_tray(&Settings::default()));
    }

    #[test]
    fn wants_tray_menu_bar_only_forces_it_even_without_show_tray() {
        let s = Settings {
            show_tray: false,
            menu_bar_only: true,
            ..Default::default()
        };
        assert!(wants_tray(&s), "menu_bar_only must force the tray on");
    }

    #[test]
    fn wants_tray_false_when_both_off() {
        let s = Settings {
            show_tray: false,
            menu_bar_only: false,
            ..Default::default()
        };
        assert!(!wants_tray(&s), "no tray when both are off");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_shows_main_when_no_windows_are_visible() {
        assert!(should_reopen_main(false, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_shows_main_when_only_settings_is_visible() {
        assert!(should_reopen_main(true, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_does_not_reload_when_messenger_window_is_visible() {
        assert!(!should_reopen_main(true, true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tray_unread_title_shows_positive_counts_when_badges_enabled() {
        assert_eq!(
            tray_unread_title(&Settings::default(), 7),
            Some("7".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tray_unread_title_clears_zero_and_disabled_badges() {
        assert_eq!(
            tray_unread_title(&Settings::default(), 0),
            Some(String::new())
        );
        let s = Settings {
            unread_badge: false,
            ..Default::default()
        };
        assert_eq!(tray_unread_title(&s, 7), Some(String::new()));
    }
}
