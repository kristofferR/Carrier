//! Chatpane's own title bar: Messenger windows have no separate one, like the
//! old Messenger app. The page keeps a strip of [`INSET`] CSS pixels free for
//! the window controls (messenger.css, inject/src/messenger/features/title-bar.ts):
//!
//! - macOS: the native window buttons float over the top of the chat list
//!   (macos::title_bar draws nothing but moves the window).
//! - Windows, and Linux windows the compositor doesn't tile: Chatpane draws
//!   minimize, maximize and close at the top right, over a strip above the
//!   chat; the chat list starts at the top. The page asks for window actions
//!   through the `chatpane:window-control` event. A window the compositor tiles
//!   or gives a title bar of its own has neither (crate::linux_tiling).
//!
//! The strip goes in full screen and, on macOS, while the photo viewer has a
//! title bar of its own.
//!
//! Windows and Linux: a window with Chatpane's controls never shows the native
//! menu bar ([`shows_menu`]). GTK would put it above the page, over the strip,
//! and on Windows the frameless window has no room for it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

use crate::settings::Settings;
use crate::window::is_messenger_window_label;

/// The windows Chatpane keeps its title bar in: Messenger's and Settings.
pub(crate) fn has_title_bar(label: &str) -> bool {
    is_messenger_window_label(label) || label == "settings"
}

/// Height of the strip, in CSS pixels at 100% zoom: macOS's title bar, or the
/// caption buttons Chatpane draws.
pub(crate) const INSET: f64 = if cfg!(target_os = "macos") {
    28.0
} else {
    32.0
};

/// Which window controls Chatpane draws in the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Controls {
    Windows,
    Linux,
}

/// Chatpane draws the window controls itself on Windows and Linux, except in
/// windows the compositor handles (see [`window_controls`]).
const CONTROLS: Option<Controls> = if cfg!(target_os = "windows") {
    Some(Controls::Windows)
} else if cfg!(target_os = "linux") {
    Some(Controls::Linux)
} else {
    None
};

/// The controls one window draws: none where the compositor handles them.
fn window_controls(label: &str) -> Option<Controls> {
    let controls = CONTROLS;
    #[cfg(target_os = "linux")]
    let controls = controls.filter(|_| !crate::linux_tiling::compositor_handles(label));
    #[cfg(not(target_os = "linux"))]
    let _ = label;
    controls
}

/// Whether a Messenger window keeps the strip at all.
fn has_strip(controls: Option<Controls>) -> bool {
    cfg!(target_os = "macos") || controls.is_some()
}

/// The page zoom in percent and the Hide Top Menu setting, kept here rather
/// than read from the settings, whose lock may be held by whoever changes them.
static ZOOM_PERCENT: AtomicI32 = AtomicI32::new(100);
static HIDE_MENU_BAR: AtomicBool = AtomicBool::new(false);

/// Whether a window shows the native menu bar: not one with Chatpane's
/// controls, and none when Hide Top Menu is on. The Settings window has none.
#[cfg(not(target_os = "macos"))]
pub(crate) fn shows_menu(label: &str) -> bool {
    !HIDE_MENU_BAR.load(Ordering::Relaxed)
        && (!has_title_bar(label) || window_controls(label).is_none())
}

/// Show or hide a window's native menu bar, as [`shows_menu`] says.
#[cfg(not(target_os = "macos"))]
pub(crate) fn sync_menu(window: &WebviewWindow) {
    let _ = if shows_menu(window.label()) {
        window.show_menu()
    } else {
        window.hide_menu()
    };
}

/// What each window's page was last told, by label.
fn told() -> &'static Mutex<HashMap<String, String>> {
    static TOLD: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    TOLD.get_or_init(Default::default)
}

/// The strip in CSS pixels at a page zoom of `zoom_percent`.
pub(crate) fn css_inset(zoom_percent: i32) -> f64 {
    INSET * 100.0 / f64::from(zoom_percent.max(1))
}

/// What the page needs: the strip's height, the controls to draw, which of
/// minimize and maximize they include (close is always there), and whether
/// the window is maximized (the maximize button turns into restore).
#[derive(Serialize, PartialEq)]
struct PageState {
    inset: f64,
    controls: Option<Controls>,
    minimize: bool,
    maximize: bool,
    maximized: bool,
}

/// Which of minimize and maximize the controls offer.
fn buttons() -> (bool, bool) {
    #[cfg(target_os = "linux")]
    if crate::linux::is_tiling_wm() {
        return crate::linux_tiling::buttons();
    }
    (true, true)
}

fn is_maximized(window: &WebviewWindow) -> bool {
    #[cfg(target_os = "linux")]
    if let Some(maximized) = crate::linux_tiling::hyprland_maximized(window.label()) {
        return maximized;
    }
    window.is_maximized().unwrap_or(false)
}

/// Set before the page's features run (window::init_script), so Messenger's
/// first layout already keeps the strip. The Settings window gets it too, at
/// 100%: page zoom applies only to Messenger.
pub(crate) fn initial_script(settings: &Settings, zoomed: bool) -> String {
    // The first window is built before the settings are first applied.
    settings_changed(settings);
    // A new window counts as tiled until the compositor says otherwise.
    #[cfg(target_os = "linux")]
    let controls = CONTROLS.filter(|_| !crate::linux::is_tiling_wm());
    #[cfg(not(target_os = "linux"))]
    let controls = CONTROLS;
    // Even without a strip: the page then follows a tiled window floating.
    let (minimize, maximize) = buttons();
    let state = PageState {
        inset: if has_strip(controls) {
            css_inset(if zoomed { settings.zoom } else { 100 })
        } else {
            0.0
        },
        controls,
        minimize,
        maximize,
        maximized: false,
    };
    format!(
        "\n  window.__CHATPANE_TITLE_BAR__ = {};",
        serde_json::to_string(&state).expect("title bar state serialises")
    )
}

fn page_state(window: &WebviewWindow) -> PageState {
    let controls = window_controls(window.label());
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    #[cfg(target_os = "macos")]
    let viewer = crate::macos::title_bar::viewer_open(window.label());
    #[cfg(not(target_os = "macos"))]
    let viewer = false;
    let zoom = if is_messenger_window_label(window.label()) {
        ZOOM_PERCENT.load(Ordering::Relaxed)
    } else {
        100
    };
    let inset = if has_strip(controls) && !fullscreen && !viewer {
        css_inset(zoom)
    } else {
        0.0
    };
    let (minimize, maximize) = buttons();
    PageState {
        inset,
        controls,
        minimize,
        maximize,
        maximized: is_maximized(window),
    }
}

/// Bring the page (and on macOS the drag strip) in line with the window's
/// state, when it changed. Only Messenger windows have the strip.
pub(crate) fn sync(window: &WebviewWindow) {
    if !has_title_bar(window.label()) {
        return;
    }
    let state = page_state(window);
    let json = serde_json::to_string(&state).expect("title bar state serialises");
    if told()
        .lock()
        .unwrap()
        .insert(window.label().to_string(), json.clone())
        == Some(json.clone())
    {
        return;
    }
    // The controls may have come or gone with the window tiling or floating.
    #[cfg(not(target_os = "macos"))]
    sync_menu(window);
    let _ = window.eval(format!(
        "document.documentElement && document.documentElement.style.setProperty(\
         '--chatpane-title-bar-inset', '{inset}px'); window.__chatpaneTitleBar?.({json});",
        inset = state.inset
    ));
    #[cfg(target_os = "macos")]
    crate::macos::title_bar::set_strip_hidden(window, state.inset == 0.0);
}

/// Keep a Messenger window's page in step with full screen and maximizing,
/// which both resize the window.
pub(crate) fn watch(window: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    crate::linux_tiling::watch(window);
    let watched = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_)) {
            sync(&watched);
        }
    });
}

/// A new page starts from the initial state: tell it the current one.
pub(crate) fn page_loaded(window: &WebviewWindow) {
    told().lock().unwrap().remove(window.label());
    sync(window);
}

/// Forget a closed window's state.
pub(crate) fn forget(label: &str) {
    told().lock().unwrap().remove(label);
    #[cfg(target_os = "linux")]
    crate::linux_tiling::forget(label);
    #[cfg(target_os = "macos")]
    crate::macos::title_bar::forget(label);
}

/// Called whenever a Messenger window's page zoom is set.
pub(crate) fn zoom_changed(window: &WebviewWindow, percent: i32) {
    ZOOM_PERCENT.store(percent, Ordering::Relaxed);
    sync(window);
}

/// Called with every settings change (and at startup). The caller syncs the
/// menu bars.
pub(crate) fn settings_changed(settings: &Settings) {
    HIDE_MENU_BAR.store(settings.hide_menu_bar, Ordering::Relaxed);
}

/// Linux: a compositor that starts reporting tiling changes every window.
#[cfg(target_os = "linux")]
pub(crate) fn sync_all(app: &tauri::AppHandle) {
    use tauri::Manager;
    for (label, window) in app.webview_windows() {
        if has_title_bar(&label) {
            sync(&window);
        }
    }
}

/// A window action: from Messenger's page through the signed
/// `chatpane:window-control` event (lib.rs), which names the sender's window,
/// or from Chatpane's own pages through [`window_control`]. The worst a page
/// can do is minimize, maximize, move or close (to the tray) its own window.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Action {
    Minimize,
    ToggleMaximize,
    Close,
    Drag,
}

/// The same for Chatpane's own local pages (the connection check, Settings),
/// which call it as a command.
#[tauri::command]
pub(crate) fn window_control(window: WebviewWindow, action: Action) {
    if has_title_bar(window.label()) {
        perform(&window, action);
    }
}

pub(crate) fn perform(window: &WebviewWindow, action: Action) {
    if CONTROLS.is_none() {
        return;
    }
    let result = match action {
        Action::Minimize => window.minimize(),
        #[cfg(target_os = "linux")]
        Action::ToggleMaximize if crate::linux_tiling::toggle_maximized(window.label()) => Ok(()),
        Action::ToggleMaximize => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        // As the system's close button: hides to the tray when that is set.
        Action::Close => window.close(),
        Action::Drag => window.start_dragging(),
    };
    if let Err(error) = result {
        log::warn!("window control {action:?} failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_actions_parse_and_unknown_ones_are_refused() {
        let ok: Action = serde_json::from_str(r#""toggle-maximize""#).unwrap();
        assert_eq!(ok, Action::ToggleMaximize);
        assert!(serde_json::from_str::<Action>(r#""quit""#).is_err());
    }

    #[test]
    fn the_strip_shrinks_as_the_page_zooms_in() {
        assert_eq!(css_inset(100), INSET);
        assert_eq!(css_inset(200), INSET / 2.0);
    }
}
