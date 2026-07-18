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
        ColorScheme::PreferLight | ColorScheme::NoPreference => {
            Some(tauri::webview::Color(255, 255, 255, 255))
        }
    }
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
        if let Some(background) = background {
            let _ = window.set_background_color(Some(background));
        }
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
                if last_error.as_deref() != Some(&message) {
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
        assert_eq!(
            background_for_color_scheme(ColorScheme::NoPreference),
            Some(tauri::webview::Color(255, 255, 255, 255))
        );
    }
}
