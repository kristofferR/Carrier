//! The global summon hotkey: registration/unregistration to match the Global
//! Hotkey setting, and the startup reconcile.

use crate::settings::{save_settings, Settings};
use crate::tray::toggle_main;
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "linux")]
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "linux")]
use tauri::Manager;

/// The fixed global summon shortcut ("CmdOrCtrl" resolves to Cmd on macOS and
/// Ctrl on Windows/Linux). No recorder UI yet, so the combination isn't
/// configurable — see issue #52.
const SUMMON_SHORTCUT: &str = "CmdOrCtrl+Shift+M";

#[cfg(target_os = "linux")]
static STARTUP_RECONCILING: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "linux")]
fn sync_lock() -> &'static Mutex<()> {
    static SYNC_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    SYNC_LOCK.get_or_init(|| Mutex::new(()))
}

fn plugin_sync(app: &tauri::AppHandle, want: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let shortcuts = app.global_shortcut();
    let registered = shortcuts.is_registered(SUMMON_SHORTCUT);
    if want && !registered {
        shortcuts
            .on_shortcut(SUMMON_SHORTCUT, |app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_main(app);
                }
            })
            .map_err(|e| format!("Couldn't enable Global Hotkey ({SUMMON_SHORTCUT}): {e}"))?;
    } else if !want && registered {
        shortcuts
            .unregister(SUMMON_SHORTCUT)
            .map_err(|e| format!("Couldn't disable Global Hotkey ({SUMMON_SHORTCUT}): {e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn hotkey_is_active(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    crate::hotkey_portal::is_active() || app.global_shortcut().is_registered(SUMMON_SHORTCUT)
}

#[cfg(any(test, target_os = "linux"))]
fn combined_enable_error(portal: &str, plugin: &str) -> String {
    format!("{portal}\nFallback failed: {plugin}")
}

/// Register or unregister the global summon hotkey to match the setting.
///
/// On Linux this may block while the desktop shows a portal approval dialog,
/// so it must never run on the main thread.
pub(crate) fn sync_global_hotkey(app: &tauri::AppHandle, want: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _sync_guard = sync_lock().lock().unwrap();
        if want {
            match crate::hotkey_portal::enable(app) {
                Ok(()) => {
                    // A previous portal failure may have left the fallback
                    // registered. Keep exactly one toggle source active.
                    if let Err(error) = plugin_sync(app, false) {
                        log::warn!("failed to clear fallback hotkey after portal enable: {error}");
                    }
                    Ok(())
                }
                Err(portal_error) if portal_error.allows_fallback() => plugin_sync(app, true)
                    .map_err(|plugin_error| {
                        combined_enable_error(&portal_error.to_string(), &plugin_error)
                    }),
                Err(portal_error) => Err(portal_error.to_string()),
            }
        } else {
            let portal_result = crate::hotkey_portal::disable();
            let plugin_result = plugin_sync(app, false);
            match (portal_result, plugin_result) {
                (Ok(()), Ok(())) => Ok(()),
                (Err(portal_error), Ok(())) => Err(portal_error),
                (Ok(()), Err(plugin_error)) => Err(plugin_error),
                (Err(portal_error), Err(plugin_error)) => {
                    Err(combined_enable_error(&portal_error, &plugin_error))
                }
            }
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        plugin_sync(app, want)
    }
}

/// Best-effort hotkey sync used outside the Settings save path. Store-time
/// changes call [`sync_global_hotkey`] directly so failures can be shown in UI.
pub(crate) fn apply_global_hotkey(app: &tauri::AppHandle, want: bool) {
    #[cfg(target_os = "linux")]
    {
        if STARTUP_RECONCILING.load(Ordering::Acquire) || hotkey_is_active(app) == want {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = sync_global_hotkey(&app, want) {
                log::warn!("{error}");
            }
        });
    }

    #[cfg(not(target_os = "linux"))]
    {
        if let Err(error) = sync_global_hotkey(app, want) {
            log::warn!("{error}");
        }
    }
}

/// On startup, a persisted enabled hotkey can become invalid because the
/// desktop session changed or another app claimed the fixed shortcut. Keep the
/// stored setting aligned with the actual registration state.
#[cfg(not(target_os = "linux"))]
pub(crate) fn reconcile_startup_global_hotkey(app: &tauri::AppHandle, s: &mut Settings) {
    if !s.global_hotkey {
        return;
    }
    if let Err(e) = sync_global_hotkey(app, true) {
        log::warn!("{e}");
        s.global_hotkey = false;
        if let Err(save_err) = save_settings(app, s) {
            log::error!("failed to save disabled Global Hotkey setting: {save_err}");
        }
    }
}

/// Linux portal approval can take two minutes. Reconcile it in a worker so
/// startup and window creation never wait on a desktop dialog.
#[cfg(target_os = "linux")]
pub(crate) fn reconcile_startup_global_hotkey(app: &tauri::AppHandle, s: &Settings) {
    if !s.global_hotkey {
        return;
    }
    STARTUP_RECONCILING.store(true, Ordering::Release);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        struct ReconcileGuard;
        impl Drop for ReconcileGuard {
            fn drop(&mut self) {
                STARTUP_RECONCILING.store(false, Ordering::Release);
            }
        }
        let _guard = ReconcileGuard;
        if let Err(error) = sync_global_hotkey(&app, true) {
            log::warn!("{error}");
            let state = app.state::<crate::settings::AppState>();
            let snapshot = {
                let mut settings = state.settings.lock().unwrap();
                settings.global_hotkey = false;
                settings.clone()
            };
            if let Err(save_error) = save_settings(&app, &snapshot) {
                log::error!("failed to save disabled Global Hotkey setting: {save_error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portal_and_plugin_errors_are_kept() {
        assert_eq!(
            combined_enable_error("portal unavailable", "shortcut already taken"),
            "portal unavailable\nFallback failed: shortcut already taken"
        );
    }
}
