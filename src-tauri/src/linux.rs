//! Linux desktop integration.

use ashpd::desktop::settings::{ColorScheme, Settings as PortalSettings};
use futures_util::StreamExt;
use tauri::Manager;

use crate::settings::AppState;

fn theme_for_color_scheme(scheme: ColorScheme) -> Option<tauri::Theme> {
    match scheme {
        ColorScheme::PreferDark => Some(tauri::Theme::Dark),
        ColorScheme::PreferLight => Some(tauri::Theme::Light),
        ColorScheme::NoPreference => None,
    }
}

fn background_for_color_scheme(scheme: ColorScheme) -> Option<tauri::webview::Color> {
    match scheme {
        ColorScheme::PreferDark => Some(tauri::webview::Color(24, 25, 26, 255)),
        ColorScheme::PreferLight => Some(tauri::webview::Color(255, 255, 255, 255)),
        ColorScheme::NoPreference => None,
    }
}

fn should_log_portal_error(last_error: Option<&str>, message: &str) -> bool {
    last_error != Some(message)
}

fn apply_portal_color_scheme(app: &tauri::AppHandle, scheme: ColorScheme) {
    let follows_system = app.state::<AppState>().settings.lock().unwrap().theme == "system";
    if !follows_system {
        return;
    }

    let theme = theme_for_color_scheme(scheme);
    let background = background_for_color_scheme(scheme);
    for (_, window) in app.webview_windows() {
        // Re-applying an explicit resolved theme makes WebKitGTK update both
        // native chrome and `prefers-color-scheme` in the page immediately.
        let _ = window.set_theme(theme);
        // `NoPreference` means the desktop has not forced light or dark. Clear
        // any previously forced backdrop and let Tauri/WebKitGTK follow the
        // system along with `set_theme(None)`.
        let _ = window.set_background_color(background);
    }
}

async fn watch_portal_color_scheme(app: tauri::AppHandle) {
    let mut last_error = None;
    loop {
        let result = async {
            let portal = PortalSettings::new().await?;
            // Apply the current value too. This closes the small race between
            // window creation and subscribing to the signal.
            let current = portal.color_scheme().await?;
            apply_portal_color_scheme(&app, current);

            let mut changes = portal.receive_color_scheme_changed().await?;
            while let Some(scheme) = changes.next().await {
                apply_portal_color_scheme(&app, scheme);
            }
            Ok::<(), ashpd::Error>(())
        }
        .await;

        match result {
            Ok(()) => {
                last_error = None;
                log::warn!("desktop color-scheme portal stream ended; reconnecting");
            }
            Err(error) => {
                // Some minimal Linux sessions have no portal. Keep Carrier
                // running and retry in case the desktop service starts later,
                // but do not write the same warning to disk every 30 seconds.
                let message = error.to_string();
                if should_log_portal_error(last_error.as_deref(), &message) {
                    log::warn!("desktop color-scheme portal unavailable: {message}");
                    last_error = Some(message);
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
}

/// Follow `org.freedesktop.appearance color-scheme` while Theme = System.
pub(crate) fn observe_system_theme_changes(app: &tauri::AppHandle) {
    tauri::async_runtime::spawn(watch_portal_color_scheme(app.clone()));
}

/// Point-in-time read of `org.freedesktop.appearance color-scheme`, used by
/// `window::is_dark` while Theme = System. This is what `dark-light` did on
/// Linux, minus the wrapper (and its second ashpd version). Portal-less or
/// hung sessions fall back to light: errors immediately, a stalled portal
/// after a short timeout so window creation is never blocked indefinitely.
pub(crate) fn system_prefers_dark() -> bool {
    use futures_util::future::{select, Either};

    let read = std::pin::pin!(async { PortalSettings::new().await?.color_scheme().await });
    let timeout = std::pin::pin!(async_io::Timer::after(std::time::Duration::from_secs(2)));
    async_io::block_on(async {
        match select(read, timeout).await {
            Either::Left((Ok(scheme), _)) => matches!(scheme, ColorScheme::PreferDark),
            _ => false,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portal_color_schemes_map_to_tauri_themes_and_backgrounds() {
        assert_eq!(
            theme_for_color_scheme(ColorScheme::PreferDark),
            Some(tauri::Theme::Dark)
        );
        assert_eq!(
            theme_for_color_scheme(ColorScheme::PreferLight),
            Some(tauri::Theme::Light)
        );
        assert_eq!(theme_for_color_scheme(ColorScheme::NoPreference), None);
        assert_eq!(
            background_for_color_scheme(ColorScheme::PreferDark),
            Some(tauri::webview::Color(24, 25, 26, 255))
        );
        assert_eq!(
            background_for_color_scheme(ColorScheme::PreferLight),
            Some(tauri::webview::Color(255, 255, 255, 255))
        );
        assert_eq!(background_for_color_scheme(ColorScheme::NoPreference), None);
    }

    #[test]
    fn repeated_portal_errors_are_not_logged_again() {
        assert!(should_log_portal_error(None, "portal unavailable"));
        assert!(!should_log_portal_error(
            Some("portal unavailable"),
            "portal unavailable"
        ));
        assert!(should_log_portal_error(
            Some("portal unavailable"),
            "portal restarted"
        ));
    }
}
