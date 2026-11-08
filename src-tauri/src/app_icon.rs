//! Settings → Appearance → App icon: a style (Color or Monochrome) and a
//! variant (match light/dark, or always light or dark).
//!
//! macOS swaps the running Dock icon (`NSApplication.applicationIconImage`);
//! the installed bundle icon is never rewritten, so updates can't leave a
//! mismatched icon behind. Windows and Linux set the window icon, which is
//! what the Windows taskbar shows; Linux launchers keep the installed icon.
//! The unread badge is drawn separately on every platform, so it keeps
//! working on every icon.

use tauri::{Manager, WebviewWindow};

use crate::settings::Settings;
use crate::window::is_dark;

// macOS restores the bundle icon instead of loading this one.
#[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
const COLOR_LIGHT: &[u8] = include_bytes!("../icons/app-icon/color-light.png");
const COLOR_DARK: &[u8] = include_bytes!("../icons/app-icon/color-dark.png");
const MONO_LIGHT: &[u8] = include_bytes!("../icons/app-icon/mono-light.png");
const MONO_DARK: &[u8] = include_bytes!("../icons/app-icon/mono-dark.png");

/// Whether the dark variant should show for these settings.
fn wants_dark(s: &Settings, system_dark: impl FnOnce(&Settings) -> bool) -> bool {
    match s.app_icon_variant.as_str() {
        "light" => false,
        "dark" => true,
        _ => system_dark(s),
    }
}

/// The PNG for these settings, or None when it is the installed icon (Color,
/// light), so the platform's own bundle icon can show at every size.
fn icon_png(style: &str, dark: bool) -> Option<&'static [u8]> {
    match (style, dark) {
        ("monochrome", false) => Some(MONO_LIGHT),
        ("monochrome", true) => Some(MONO_DARK),
        (_, true) => Some(COLOR_DARK),
        (_, false) => None,
    }
}

fn chosen_png(s: &Settings) -> Option<&'static [u8]> {
    icon_png(&s.app_icon_style, wants_dark(s, is_dark))
}

/// Give one window the chosen icon. Windows and Linux only; on macOS the
/// Dock icon is app-wide (see [`apply_app_icon`]).
pub(crate) fn apply_window_icon(window: &WebviewWindow, s: &Settings) {
    #[cfg(not(target_os = "macos"))]
    {
        let png = chosen_png(s).unwrap_or(COLOR_LIGHT);
        match tauri::image::Image::from_bytes(png) {
            Ok(image) => {
                if let Err(error) = window.set_icon(image) {
                    log::warn!("could not set the icon of {}: {error}", window.label());
                }
            }
            Err(error) => log::warn!("bundled app icon did not decode: {error}"),
        }
    }
    #[cfg(target_os = "macos")]
    let _ = (window, s);
}

/// Show the chosen icon everywhere it can change at runtime.
pub(crate) fn apply_app_icon(app: &tauri::AppHandle, s: &Settings) {
    #[cfg(target_os = "macos")]
    {
        let png = chosen_png(s);
        let _ = app.run_on_main_thread(move || set_dock_icon(png));
    }
    #[cfg(not(target_os = "macos"))]
    for (label, window) in app.webview_windows() {
        // Call windows belong to Messenger and keep the installed icon.
        if crate::window::is_messenger_window_label(&label) || label == "settings" {
            apply_window_icon(&window, s);
        }
    }
}

/// Re-apply after the system switches light/dark, for "Match theme".
pub(crate) fn apply_app_icon_from_state(app: &tauri::AppHandle) {
    let settings = app
        .state::<crate::settings::AppState>()
        .settings
        .lock()
        .unwrap()
        .clone();
    apply_app_icon(app, &settings);
}

/// Main thread only. None restores the bundle icon.
#[cfg(target_os = "macos")]
fn set_dock_icon(png: Option<&'static [u8]>) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSData;

    // SAFETY: AppKit calls on the main thread (run_on_main_thread above).
    // `initWithData:` returns nil for undecodable data, which we check; a nil
    // `applicationIconImage` is documented to restore the bundle icon.
    unsafe {
        let image: Option<Retained<AnyObject>> = match png {
            Some(bytes) => {
                let data = NSData::with_bytes(bytes);
                let alloc: *mut AnyObject = msg_send![class!(NSImage), alloc];
                let image: *mut AnyObject = msg_send![alloc, initWithData: &*data];
                if image.is_null() {
                    log::warn!("bundled Dock icon did not decode");
                    return;
                }
                Retained::from_raw(image)
            }
            None => None,
        };
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let icon: *const AnyObject = image
            .as_deref()
            .map_or(std::ptr::null(), |image| image as *const AnyObject);
        let _: () = msg_send![ns_app, setApplicationIconImage: icon];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(style: &str, variant: &str) -> Settings {
        Settings {
            app_icon_style: style.into(),
            app_icon_variant: variant.into(),
            ..Settings::default()
        }
    }

    #[test]
    fn match_theme_follows_light_and_dark() {
        let auto = with("color", "auto");
        assert!(wants_dark(&auto, |_| true));
        assert!(!wants_dark(&auto, |_| false));
        assert!(wants_dark(&with("color", "dark"), |_| false));
        assert!(!wants_dark(&with("color", "light"), |_| true));
    }

    #[test]
    fn the_light_icon_is_the_default_even_in_dark_mode() {
        assert!(!wants_dark(&Settings::default(), |_| true));
    }

    #[test]
    fn the_light_color_icon_is_the_installed_one() {
        assert_eq!(icon_png("color", false), None);
        assert_eq!(icon_png("color", true), Some(COLOR_DARK));
        assert_eq!(icon_png("monochrome", false), Some(MONO_LIGHT));
        assert_eq!(icon_png("monochrome", true), Some(MONO_DARK));
    }

    #[test]
    fn every_bundled_icon_decodes() {
        for png in [COLOR_LIGHT, COLOR_DARK, MONO_LIGHT, MONO_DARK] {
            let image = tauri::image::Image::from_bytes(png).unwrap();
            assert_eq!((image.width(), image.height()), (512, 512));
        }
    }
}
