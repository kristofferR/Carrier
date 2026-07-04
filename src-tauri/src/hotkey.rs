//! The global summon hotkey: registration/unregistration to match the Global
//! Hotkey setting, and the startup reconcile.

use crate::settings::{save_settings, Settings};
use crate::tray::toggle_main;

/// The fixed global summon shortcut ("CmdOrCtrl" resolves to Cmd on macOS and
/// Ctrl on Windows/Linux). No recorder UI yet, so the combination isn't
/// configurable — see issue #52.
const SUMMON_SHORTCUT: &str = "CmdOrCtrl+Shift+M";

/// Register or unregister the global summon hotkey to match the setting.
pub(crate) fn sync_global_hotkey(app: &tauri::AppHandle, want: bool) -> Result<(), String> {
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

/// Best-effort hotkey sync used outside the Settings save path. Store-time
/// changes call [`sync_global_hotkey`] directly so failures can be shown in UI.
pub(crate) fn apply_global_hotkey(app: &tauri::AppHandle, want: bool) {
    if let Err(e) = sync_global_hotkey(app, want) {
        log::warn!("{e}");
    }
}

/// On startup, a persisted enabled hotkey can become invalid because the
/// desktop session changed or another app claimed the fixed shortcut. Keep the
/// stored setting aligned with the actual registration state.
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
