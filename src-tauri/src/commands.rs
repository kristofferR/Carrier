//! The `#[tauri::command]` handlers the local pages (Settings dialog, splash)
//! invoke, plus the update check they share with the F2 shortcut.

use tauri::{Manager, State, WebviewWindow};
use url::Url;

use crate::hotkey::sync_global_hotkey;
use crate::preflight::{messenger_dns_preflight, MessengerLoadStatus, MessengerPreflightError};
use crate::settings::{
    apply_settings, save_settings, sync_autostart, AppState, SaveOutcome, Settings,
};
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

    if save_settings(app, &effective)? == SaveOutcome::Superseded {
        // A newer settings snapshot already reached disk from a concurrent
        // save; applying this stale one would leave runtime settings diverged
        // from what is persisted. Skip the in-memory update and apply, and
        // report the settings actually in effect.
        let current = state.settings.lock().unwrap().clone();
        return if sync_errors.is_empty() {
            Ok(current)
        } else {
            Err(sync_errors.join("\n"))
        };
    }
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
#[cfg(not(target_os = "macos"))]
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

/// Check GitHub releases for a macOS update and install the signed release DMG.
///
/// Tauri's stock macOS installer expects an `.app.tar.gz` updater payload. Carrier
/// publishes only the user-facing DMG, so we keep Tauri's update check and
/// minisign verification, then mount/copy the verified DMG ourselves.
#[cfg(target_os = "macos")]
pub(crate) async fn run_update_check(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            install_macos_dmg_update(&bytes)?;
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

#[cfg(target_os = "macos")]
fn install_macos_dmg_update(bytes: &[u8]) -> Result<(), String> {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let work_dir =
        std::env::temp_dir().join(format!("carrier-update-{}-{nonce}", std::process::id()));
    let result = (|| {
        fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
        let dmg_path = work_dir.join("Carrier-update.dmg");
        fs::write(&dmg_path, bytes).map_err(|e| e.to_string())?;

        let mountpoint = work_dir.join("mount");
        fs::create_dir(&mountpoint).map_err(|e| e.to_string())?;
        let mut attach = std::process::Command::new("hdiutil");
        attach
            .arg("attach")
            .arg("-nobrowse")
            .arg("-readonly")
            .arg("-mountpoint")
            .arg(&mountpoint)
            .arg(&dmg_path);
        run_macos_command(&mut attach)?;
        let _mounted = MountedDmg {
            mountpoint: mountpoint.clone(),
        };

        let source_app = find_app_bundle(&mountpoint)?;
        let destination_app = current_app_bundle()?;
        replace_app_bundle(&source_app, &destination_app, &work_dir)?;
        Ok(())
    })();

    let _ = fs::remove_dir_all(&work_dir);
    result
}

#[cfg(target_os = "macos")]
struct MountedDmg {
    mountpoint: std::path::PathBuf,
}

#[cfg(target_os = "macos")]
impl Drop for MountedDmg {
    fn drop(&mut self) {
        let _ = std::process::Command::new("hdiutil")
            .arg("detach")
            .arg(&self.mountpoint)
            .arg("-quiet")
            .status();
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn current_app_bundle() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    for ancestor in exe.ancestors() {
        if ancestor.extension().is_some_and(|ext| ext == "app") {
            return Ok(ancestor.to_path_buf());
        }
    }
    Err("Could not locate the running .app bundle.".into())
}

#[cfg(target_os = "macos")]
fn find_app_bundle(mountpoint: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let mut fallback = None;
    for entry in std::fs::read_dir(mountpoint).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|ext| ext == "app") {
            if path.file_name().is_some_and(|name| name == "Carrier.app") {
                return Ok(path);
            }
            fallback = Some(path);
        }
    }
    fallback.ok_or_else(|| "The update DMG did not contain an app bundle.".into())
}

#[cfg(target_os = "macos")]
fn replace_app_bundle(
    source_app: &std::path::Path,
    destination_app: &std::path::Path,
    work_dir: &std::path::Path,
) -> Result<(), String> {
    let backup_dir = work_dir.join("backup");
    std::fs::create_dir(&backup_dir).map_err(|e| e.to_string())?;
    let backup_app = backup_dir.join("Carrier.app");

    match std::fs::rename(destination_app, &backup_app) {
        Ok(()) => {
            if let Err(err) = ditto(source_app, destination_app) {
                let _ = std::fs::remove_dir_all(destination_app);
                let _ = std::fs::rename(&backup_app, destination_app);
                return Err(err);
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            install_with_admin_privileges(source_app, destination_app)?;
        }
        Err(err) => return Err(err.to_string()),
    }

    let _ = std::process::Command::new("touch")
        .arg(destination_app)
        .status();
    Ok(())
}

#[cfg(target_os = "macos")]
fn ditto(source: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    let mut command = std::process::Command::new("ditto");
    command.arg(source).arg(destination);
    run_macos_command(&mut command)
}

#[cfg(target_os = "macos")]
fn install_with_admin_privileges(
    source_app: &std::path::Path,
    destination_app: &std::path::Path,
) -> Result<(), String> {
    // Back up the current bundle to a sibling path (same volume, so the move is
    // atomic) before overwriting, and restore it if `ditto` fails — otherwise a
    // failed privileged copy (disk full, interrupted read) would leave the user
    // with no app at all. This mirrors the rename/rollback the non-privileged
    // branch does, and the whole sequence runs inside one privileged shell so
    // the rollback is itself privileged.
    let script = format!(
        concat!(
            "do shell script \"",
            "rm -rf \" & quoted form of {backup} & \" ; ",
            "mv \" & quoted form of {destination} & \" \" & quoted form of {backup} & \" || exit 1 ; ",
            "if ditto \" & quoted form of {source} & \" \" & quoted form of {destination} & \" ; ",
            "then rm -rf \" & quoted form of {backup} & \" ; ",
            "else rm -rf \" & quoted form of {destination} & \" ; ",
            "mv \" & quoted form of {backup} & \" \" & quoted form of {destination} & \" ; exit 1 ; fi",
            "\" with administrator privileges"
        ),
        source = applescript_string(&source_app.display().to_string()),
        destination = applescript_string(&destination_app.display().to_string()),
        backup = applescript_string(&format!("{}.carrier-backup", destination_app.display())),
    );
    let mut command = std::process::Command::new("osascript");
    command.arg("-e").arg(script);
    run_macos_command(&mut command)
}

#[cfg(target_os = "macos")]
fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "macos")]
fn run_macos_command(command: &mut std::process::Command) -> Result<(), String> {
    let program = command.get_program().to_string_lossy().into_owned();
    let output = command.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let details = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        Err(format!("{program} failed: {details}"))
    }
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
