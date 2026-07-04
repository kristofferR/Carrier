//! The `#[tauri::command]` handlers the local pages (Settings dialog, splash)
//! invoke, plus the update check they share with the F2 shortcut.

use tauri::{Manager, State, WebviewWindow};
use url::Url;

use crate::hotkey::sync_global_hotkey;
use crate::preflight::{messenger_dns_preflight, MessengerLoadStatus, MessengerPreflightError};
use crate::settings::{apply_settings, save_settings, sync_autostart, AppState, Settings};
use crate::window::recreate_on_theme_change;
use crate::{HOME_URL, MESSENGER_DNS_TIMEOUT};

#[tauri::command]
pub(crate) fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

/// Persist `new`, syncing OS-backed preferences first so a failed sync doesn't
/// commit a preference the OS rejected. Other preferences are always saved;
/// sync failures are returned (after saving the rest) so the UI can surface them.
fn store_settings(
    app: &tauri::AppHandle,
    state: &State<AppState>,
    new: Settings,
) -> Result<Settings, String> {
    let (prev_theme, prev_autostart, prev_global_hotkey) = {
        let prev = state.settings.lock().unwrap();
        (prev.theme.clone(), prev.autostart, prev.global_hotkey)
    };
    let mut effective = new.clone().sanitized();
    let mut sync_errors = Vec::new();

    if new.autostart != prev_autostart {
        match sync_autostart(app, new.autostart) {
            Ok(()) => {}
            // Keep the previous autostart value rather than persisting one the OS
            // didn't accept; still save/apply every other preference.
            Err(e) => {
                effective.autostart = prev_autostart;
                sync_errors.push(e);
            }
        }
    }
    if new.global_hotkey != prev_global_hotkey {
        match sync_global_hotkey(app, new.global_hotkey) {
            Ok(()) => {}
            // Keep the checkbox aligned with whether the shortcut is actually
            // registered. This also covers Linux Wayland sessions where the
            // plugin cannot register the fixed global shortcut.
            Err(e) => {
                effective.global_hotkey = prev_global_hotkey;
                sync_errors.push(e);
            }
        }
    }

    save_settings(app, &effective)?;
    *state.settings.lock().unwrap() = effective.clone();
    apply_settings(app, &effective);
    // macOS needs a window rebuild to re-theme the title bar; other platforms
    // already re-themed the chrome live in apply_settings.
    recreate_on_theme_change(app, &prev_theme, &effective.theme);
    if sync_errors.is_empty() {
        Ok(effective)
    } else {
        Err(sync_errors.join("\n"))
    }
}

#[tauri::command]
pub(crate) fn set_settings(
    app: tauri::AppHandle,
    state: State<AppState>,
    new: Settings,
) -> Result<Settings, String> {
    store_settings(&app, &state, new)
}

/// Reset all settings to their defaults.
#[tauri::command]
pub(crate) fn reset_settings(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<Settings, String> {
    store_settings(&app, &state, Settings::default())
}

/// Check GitHub releases for an update; download & install if found.
pub(crate) async fn run_update_check(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            app.restart();
        }
        Ok(None) => Ok("up-to-date".into()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub(crate) async fn check_for_updates(app: tauri::AppHandle) -> Result<String, String> {
    run_update_check(&app).await
}

fn navigate_to_messenger(window: &WebviewWindow) -> MessengerLoadStatus {
    match Url::parse(HOME_URL) {
        Ok(url) => match window.navigate(url) {
            Ok(()) => MessengerLoadStatus::loading(),
            Err(e) => MessengerLoadStatus::unexpected(
                "Cannot open Messenger",
                format!("WebView navigation failed: {e}"),
            ),
        },
        Err(e) => MessengerLoadStatus::unexpected(
            "Cannot open Messenger",
            format!("Carrier has an invalid Messenger URL: {e}"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn connect_messenger(window: WebviewWindow) -> MessengerLoadStatus {
    let preflight = tokio::time::timeout(
        MESSENGER_DNS_TIMEOUT,
        tauri::async_runtime::spawn_blocking(messenger_dns_preflight),
    )
    .await;

    match preflight {
        Ok(Ok(Ok(()))) => navigate_to_messenger(&window),
        Ok(Ok(Err(error @ MessengerPreflightError::Blocked { .. }))) => error.into(),
        Ok(Ok(Err(error))) => {
            log::warn!("Messenger DNS preflight failed ({error:?}); navigating anyway");
            navigate_to_messenger(&window)
        }
        Ok(Err(e)) => {
            log::warn!("Messenger DNS preflight task failed: {e}; navigating anyway");
            navigate_to_messenger(&window)
        }
        Err(_) => {
            log::warn!("Messenger DNS preflight timed out; navigating anyway");
            navigate_to_messenger(&window)
        }
    }
}

/// Open the folder holding Carrier's log file, for attaching to bug reports.
/// Called from the (local-origin) Settings window.
#[tauri::command]
pub(crate) fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open::that_detached(&dir).map_err(|e| e.to_string())
}
