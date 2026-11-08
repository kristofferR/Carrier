//! Settings → Appearance → App icon: one of four icons, and optionally a
//! different one while Messenger is dark.
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

/// The icons Settings offers, as stored in `app_icon` and `app_icon_dark`.
pub(crate) const APP_ICONS: [&str; 4] = ["color-light", "color-dark", "mono-light", "mono-dark"];
/// The installed icon.
pub(crate) const DEFAULT_APP_ICON: &str = "color-light";

/// `app_icon` and `app_icon_dark` for a settings file from before they
/// existed: a style ("color" or "monochrome") and a variant ("light", "dark"
/// or "auto", which matched light/dark).
pub(crate) fn migrate_style_and_variant(
    style: Option<&str>,
    variant: Option<&str>,
) -> (String, String) {
    let style = if style == Some("monochrome") {
        "mono"
    } else {
        "color"
    };
    match variant {
        Some("dark") => (format!("{style}-dark"), String::new()),
        Some("auto") => (format!("{style}-light"), format!("{style}-dark")),
        _ => (format!("{style}-light"), String::new()),
    }
}

/// The icon for these settings. `dark` is only asked when a dark-mode icon
/// is set.
fn chosen_icon(s: &Settings, dark: impl FnOnce(&Settings) -> bool) -> &str {
    if !s.app_icon_dark.is_empty() && dark(s) {
        &s.app_icon_dark
    } else {
        &s.app_icon
    }
}

/// The PNG for an icon, or None for the installed icon (Color, light), so the
/// platform's own bundle icon can show at every size.
fn icon_png(icon: &str) -> Option<&'static [u8]> {
    match icon {
        "color-dark" => Some(COLOR_DARK),
        "mono-light" => Some(MONO_LIGHT),
        "mono-dark" => Some(MONO_DARK),
        _ => None,
    }
}

fn chosen_png(s: &Settings) -> Option<&'static [u8]> {
    icon_png(chosen_icon(s, is_dark))
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

/// Re-apply after the system switches light/dark, for a dark-mode icon.
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

    fn with(light: &str, dark: &str) -> Settings {
        Settings {
            app_icon: light.into(),
            app_icon_dark: dark.into(),
            ..Settings::default()
        }
    }

    #[test]
    fn a_dark_mode_icon_shows_only_while_dark() {
        let pair = with("color-light", "mono-dark");
        assert_eq!(chosen_icon(&pair, |_| true), "mono-dark");
        assert_eq!(chosen_icon(&pair, |_| false), "color-light");
    }

    #[test]
    fn without_a_dark_mode_icon_one_icon_shows_always() {
        let one = with("mono-dark", "");
        assert_eq!(chosen_icon(&one, |_| false), "mono-dark");
        assert_eq!(
            chosen_icon(&one, |_| panic!("light/dark not needed")),
            "mono-dark"
        );
        assert_eq!(chosen_icon(&Settings::default(), |_| true), "color-light");
    }

    #[test]
    fn style_and_variant_settings_migrate() {
        let migrated = |style, variant| {
            let (light, dark) = migrate_style_and_variant(style, variant);
            format!("{light}|{dark}")
        };
        assert_eq!(migrated(Some("color"), Some("light")), "color-light|");
        assert_eq!(migrated(Some("monochrome"), Some("dark")), "mono-dark|");
        assert_eq!(
            migrated(Some("monochrome"), Some("auto")),
            "mono-light|mono-dark"
        );
        assert_eq!(
            migrated(Some("color"), Some("auto")),
            "color-light|color-dark"
        );
        // Either key alone takes the other's old default.
        assert_eq!(migrated(None, Some("dark")), "color-dark|");
        assert_eq!(migrated(Some("monochrome"), None), "mono-light|");
    }

    #[test]
    fn the_light_color_icon_is_the_installed_one() {
        assert_eq!(icon_png("color-light"), None);
        assert_eq!(icon_png("color-dark"), Some(COLOR_DARK));
        assert_eq!(icon_png("mono-light"), Some(MONO_LIGHT));
        assert_eq!(icon_png("mono-dark"), Some(MONO_DARK));
    }

    #[test]
    fn every_bundled_icon_decodes() {
        for png in [COLOR_LIGHT, COLOR_DARK, MONO_LIGHT, MONO_DARK] {
            let image = tauri::image::Image::from_bytes(png).unwrap();
            assert_eq!((image.width(), image.height()), (512, 512));
        }
    }
}
