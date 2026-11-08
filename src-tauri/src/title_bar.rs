//! Carrier's own title bar: Messenger windows have no separate one, like the
//! old Messenger app. The page keeps a strip of [`INSET`] CSS pixels free for
//! the window controls (messenger.css, inject/src/messenger/features/title-bar.ts):
//!
//! - macOS: the native window buttons float over the top of the chat list
//!   (macos::title_bar draws nothing but moves the window).
//! - Windows, and Linux on floating desktops: Carrier draws minimize, maximize
//!   and close at the top right, over a strip above the chat; the chat list
//!   starts at the top. The page asks for window actions through the
//!   `carrier:window-control` event.
//!
//! The strip goes in full screen and, on macOS, while the photo viewer has a
//! title bar of its own.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

use crate::settings::Settings;
use crate::window::is_messenger_window_label;

/// The windows Carrier keeps its title bar in: Messenger's and Settings.
fn has_title_bar(label: &str) -> bool {
    is_messenger_window_label(label) || label == "settings"
}

/// Height of the strip, in CSS pixels at 100% zoom: macOS's title bar, or the
/// caption buttons Carrier draws.
pub(crate) const INSET: f64 = if cfg!(target_os = "macos") {
    28.0
} else {
    32.0
};

/// Which window controls Carrier draws in the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Controls {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Windows,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Linux,
}

/// Carrier draws the window controls itself: always on Windows, and on Linux
/// when the title bar is Automatic on a floating desktop (tiling window
/// managers manage the window, and Show keeps the GTK header bar).
pub(crate) fn controls(settings: &Settings) -> Option<Controls> {
    #[cfg(target_os = "windows")]
    {
        let _ = settings;
        Some(Controls::Windows)
    }
    #[cfg(target_os = "linux")]
    {
        (settings.title_bar == "auto" && !crate::linux::is_tiling_wm()).then_some(Controls::Linux)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = settings;
        None
    }
}

/// Whether a Messenger window keeps the strip at all.
fn has_strip(controls: Option<Controls>) -> bool {
    cfg!(target_os = "macos") || controls.is_some()
}

/// The page zoom in percent and the controls in use, kept here rather than read
/// from the settings, whose lock may be held by whoever changes them.
static ZOOM_PERCENT: AtomicI32 = AtomicI32::new(100);
fn current_controls() -> &'static Mutex<Option<Controls>> {
    static CONTROLS: OnceLock<Mutex<Option<Controls>>> = OnceLock::new();
    CONTROLS.get_or_init(Default::default)
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

/// What the page needs: the strip's height, the controls to draw, and whether
/// the window is maximized (the maximize button turns into restore).
#[derive(Serialize, PartialEq)]
struct PageState {
    inset: f64,
    controls: Option<Controls>,
    maximized: bool,
}

/// Set before the page's features run (window::init_script), so Messenger's
/// first layout already keeps the strip. The Settings window gets it too, at
/// 100%: page zoom applies only to Messenger.
pub(crate) fn initial_script(settings: &Settings, zoomed: bool) -> String {
    let controls = controls(settings);
    *current_controls().lock().unwrap() = controls;
    // Even without a strip: the page then follows a later change of the title
    // bar setting (Linux "show" to "auto").
    let state = PageState {
        inset: if has_strip(controls) {
            css_inset(if zoomed { settings.zoom } else { 100 })
        } else {
            0.0
        },
        controls,
        maximized: false,
    };
    format!(
        "\n  window.__CARRIER_TITLE_BAR__ = {};",
        serde_json::to_string(&state).expect("title bar state serialises")
    )
}

fn page_state(window: &WebviewWindow) -> PageState {
    let controls = *current_controls().lock().unwrap();
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
    PageState {
        inset,
        controls,
        maximized: window.is_maximized().unwrap_or(false),
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
    let _ = window.eval(format!(
        "document.documentElement && document.documentElement.style.setProperty(\
         '--carrier-title-bar-inset', '{inset}px'); window.__carrierTitleBar?.({json});",
        inset = state.inset
    ));
    #[cfg(target_os = "macos")]
    crate::macos::title_bar::set_strip_hidden(window, state.inset == 0.0);
}

/// Keep a Messenger window's page in step with full screen and maximizing,
/// which both resize the window.
pub(crate) fn watch(window: &WebviewWindow) {
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
    #[cfg(target_os = "macos")]
    crate::macos::title_bar::forget(label);
}

/// Called whenever a Messenger window's page zoom is set.
pub(crate) fn zoom_changed(window: &WebviewWindow, percent: i32) {
    ZOOM_PERCENT.store(percent, Ordering::Relaxed);
    sync(window);
}

/// Called with every settings change (and at startup): the title bar setting
/// can switch Carrier's controls on or off.
pub(crate) fn settings_changed(app: &tauri::AppHandle, settings: &Settings) {
    *current_controls().lock().unwrap() = controls(settings);
    for (label, window) in app.webview_windows() {
        if has_title_bar(&label) {
            sync(&window);
        }
    }
}

/// A window action: from Messenger's page through the signed
/// `carrier:window-control` event (lib.rs), which names the sender's window,
/// or from Carrier's own pages through [`window_control`]. The worst a page
/// can do is minimize, maximize, move or close (to the tray) its own window.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Action {
    Minimize,
    ToggleMaximize,
    Close,
    Drag,
}

/// The same for Carrier's own local pages (the connection check, Settings),
/// which call it as a command.
#[tauri::command]
pub(crate) fn window_control(window: WebviewWindow, action: Action) {
    if has_title_bar(window.label()) {
        perform(&window, action);
    }
}

pub(crate) fn perform(window: &WebviewWindow, action: Action) {
    if current_controls().lock().unwrap().is_none() {
        return;
    }
    let result = match action {
        Action::Minimize => window.minimize(),
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
