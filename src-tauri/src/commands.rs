//! The `#[tauri::command]` handlers invoked by Carrier's trusted local pages
//! (Settings dialog and splash).

use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use url::Url;

use crate::custom_css::ensure_custom_css;
use crate::hotkey::sync_global_hotkey;
use crate::preflight::{messenger_dns_preflight, MessengerLoadStatus, MessengerPreflightError};
use crate::settings::{
    apply_settings, save_settings, sync_autostart, AppState, SaveOutcome, Settings,
};
use crate::window::recreate_on_theme_change;
use crate::{HOME_URL, MESSENGER_DNS_TIMEOUT};

const AUTOMATIC_UPDATE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(4 * 60 * 60);
// Autostart can beat the OS network/DNS service by a few seconds. Keep the
// existing recovery screen for persistent failures, but absorb that launch race.
const MESSENGER_DNS_MAX_ATTEMPTS: usize = 6;
const MESSENGER_DNS_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);
type MessengerPreflightTask = tauri::async_runtime::JoinHandle<Result<(), MessengerPreflightError>>;

struct MessengerPreflightTasks {
    active: Option<MessengerPreflightTask>,
    // Keep one detached timeout handle so repeated clicks cannot grow the
    // blocking pool without bound while still allowing one fresh lookup.
    retired: Option<MessengerPreflightTask>,
}

impl MessengerPreflightTasks {
    fn prune_retired(&mut self) {
        if self
            .retired
            .as_ref()
            .is_some_and(|task| task.inner().is_finished())
        {
            self.retired.take();
        }
    }

    fn retire_active_after_timeout(&mut self) {
        self.prune_retired();
        if self
            .active
            .as_ref()
            .is_some_and(|task| task.inner().is_finished())
        {
            self.active.take();
        } else if self.retired.is_none() {
            self.retired = self.active.take();
        }
    }
}

static MESSENGER_PREFLIGHT_TASKS: tokio::sync::Mutex<MessengerPreflightTasks> =
    tokio::sync::Mutex::const_new(MessengerPreflightTasks {
        active: None,
        retired: None,
    });

struct UpdateInstallGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl<'a> UpdateInstallGuard<'a> {
    fn acquire(flag: &'a std::sync::atomic::AtomicBool) -> Result<Self, String> {
        flag.compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .map(|_| Self(flag))
        .map_err(|_| "an update install is already in progress".to_string())
    }
}

impl Drop for UpdateInstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}

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
    let (prev_theme, prev_autostart, prev_global_hotkey, prev_automatic_update_checks) = {
        let prev = state.settings.lock().unwrap();
        (
            prev.theme.clone(),
            prev.autostart,
            prev.global_hotkey,
            prev.automatic_update_checks,
        )
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
    if effective.automatic_update_checks && !prev_automatic_update_checks {
        state.update_check_wake.notify_one();
    }
    // macOS needs a window rebuild to re-theme the title bar; other platforms
    // already re-themed the chrome live in apply_settings.
    recreate_on_theme_change(app, &prev_theme, &effective.theme);
    if sync_errors.is_empty() {
        Ok(effective)
    } else {
        Err(sync_errors.join("\n"))
    }
}

async fn store_settings_off_main(app: tauri::AppHandle, new: Settings) -> Result<Settings, String> {
    let worker_app = app.clone();
    let state = app.state::<AppState>();
    let _settings_worker = state.settings_worker.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        store_settings(&worker_app, &state, new)
    })
    .await
    .map_err(|e| format!("settings worker failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn set_settings(app: tauri::AppHandle, new: Settings) -> Result<Settings, String> {
    store_settings_off_main(app, new).await
}

/// Reset all settings to their defaults.
#[tauri::command]
pub(crate) async fn reset_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    store_settings_off_main(app, Settings::default()).await
}

async fn available_update_unlocked(
    app: &tauri::AppHandle,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

async fn available_update(
    app: &tauri::AppHandle,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let state = app.state::<AppState>();
    let _operation_guard = state.update_checking.lock().await;
    available_update_unlocked(app).await
}

fn should_surface_update(remembered: Option<&str>, discovered: Option<&str>) -> bool {
    discovered.is_some() && remembered != discovered
}

fn remember_available_update(
    app: &tauri::AppHandle,
    update: Option<tauri_plugin_updater::Update>,
) -> bool {
    let state = app.state::<AppState>();
    let mut remembered = state.update_available.lock().unwrap();
    let is_new = should_surface_update(
        remembered.as_ref().map(|update| update.version.as_str()),
        update.as_ref().map(|update| update.version.as_str()),
    );
    *remembered = update;
    is_new
}

/// Check GitHub releases without downloading or installing anything. Keeping
/// this read-only lets Settings ask for explicit consent before an update
/// replaces the running application and restarts it.
#[tauri::command]
pub(crate) async fn check_for_updates(app: tauri::AppHandle) -> Result<String, String> {
    if app
        .state::<AppState>()
        .update_installing
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("an update install is already in progress".into());
    }
    match available_update(&app).await? {
        Some(update) => {
            let version = update.version.clone();
            remember_available_update(&app, Some(update));
            Ok(format!("available:{version}"))
        }
        None => {
            remember_available_update(&app, None);
            Ok("up-to-date".into())
        }
    }
}

/// Return the last version found by automatic/manual discovery without another
/// network request. The trusted Settings page uses it to label its update
/// button as soon as it opens.
#[tauri::command]
pub(crate) fn discovered_update(state: State<AppState>) -> Option<String> {
    state
        .update_available
        .lock()
        .unwrap()
        .as_ref()
        .map(|update| update.version.clone())
}

async fn run_automatic_update_check(app: &tauri::AppHandle) {
    let installing = app
        .state::<AppState>()
        .update_installing
        .load(std::sync::atomic::Ordering::Acquire);
    if installing {
        return;
    }

    match available_update(app).await {
        Ok(Some(update)) => {
            // The preference may have been disabled while the network request
            // was in flight, or an explicit install may have started after our
            // initial guard. Honour both before showing anything.
            let state = app.state::<AppState>();
            if state
                .update_installing
                .load(std::sync::atomic::Ordering::Acquire)
                || !state.settings.lock().unwrap().automatic_update_checks
            {
                return;
            }
            let version = update.version.clone();
            if remember_available_update(app, Some(update)) {
                let body = format!(
                    "Carrier {} is available. Open Settings to review and install it.",
                    version
                );
                if let Err(error) = app
                    .notification()
                    .builder()
                    .title("Carrier update available")
                    .body(body)
                    .show()
                {
                    log::warn!("failed to surface available update: {error}");
                }
            }
        }
        Ok(None) => {
            remember_available_update(app, None);
        }
        Err(error) => {
            // Discovery is best-effort and must never interrupt startup or
            // Messenger. Manual checks still return their errors to Settings.
            log::warn!("automatic update check failed: {error}");
        }
    }
}

/// Check once when the app is ready, then every four hours while enabled.
/// Enabling the preference wakes the task immediately rather than waiting for
/// the next periodic tick.
pub(crate) fn spawn_automatic_update_checks(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let enabled = app
                .state::<AppState>()
                .settings
                .lock()
                .unwrap()
                .automatic_update_checks;
            if enabled {
                run_automatic_update_check(&app).await;
            }

            let state = app.state::<AppState>();
            let _ = tokio::time::timeout(
                AUTOMATIC_UPDATE_INTERVAL,
                state.update_check_wake.notified(),
            )
            .await;
        }
    });
}

async fn remembered_or_latest_update_unlocked(
    app: &tauri::AppHandle,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let remembered = app
        .state::<AppState>()
        .update_available
        .lock()
        .unwrap()
        .clone();
    match remembered {
        Some(update) => Ok(Some(update)),
        None => available_update_unlocked(app).await,
    }
}

/// Download and install the retained discovery after the trusted Settings page
/// has obtained explicit confirmation from the user. If no discovery exists,
/// fall back to a fresh check for the manual "Check for updates" path.
#[cfg(not(target_os = "macos"))]
async fn run_update_install(app: &tauri::AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    // Keep every discovery request out until the complete download/install
    // operation has finished. The atomic guard still rejects a second install
    // immediately instead of leaving it waiting here.
    let _operation_guard = state.update_checking.lock().await;
    match remembered_or_latest_update_unlocked(app).await {
        Ok(Some(update)) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            app.restart();
        }
        Ok(None) => Ok("up-to-date".into()),
        Err(e) => Err(e),
    }
}

/// Check GitHub releases for a macOS update and install the signed release DMG.
///
/// Tauri's stock macOS installer expects an `.app.tar.gz` updater payload. Carrier
/// publishes only the user-facing DMG, so we keep Tauri's update check and
/// minisign verification, then mount/copy the verified DMG ourselves.
#[cfg(target_os = "macos")]
async fn run_update_install(app: &tauri::AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    // The macOS DMG download/replacement must be one operation with discovery;
    // otherwise a periodic or manual check could contend with the updater.
    let _operation_guard = state.update_checking.lock().await;
    match remembered_or_latest_update_unlocked(app).await {
        Ok(Some(update)) => {
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            install_macos_dmg_update(&bytes)?;
            app.restart();
        }
        Ok(None) => Ok("up-to-date".into()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub(crate) async fn install_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _guard = UpdateInstallGuard::acquire(&state.update_installing)?;
    run_update_install(&app).await
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

enum MessengerPreflightAttempt {
    Completed(Result<(), MessengerPreflightError>),
    TaskFailed(String),
    TimedOut,
}

enum MessengerPreflightDecision {
    Navigate,
    RetryDns(MessengerPreflightError),
    RetryTimeout,
    Return(MessengerLoadStatus),
}

fn classify_messenger_preflight_attempt(
    attempt: usize,
    max_attempts: usize,
    result: MessengerPreflightAttempt,
) -> MessengerPreflightDecision {
    let has_more_attempts = attempt < max_attempts;

    match result {
        MessengerPreflightAttempt::Completed(Ok(())) => MessengerPreflightDecision::Navigate,
        MessengerPreflightAttempt::Completed(Err(error))
            if has_more_attempts && error.is_retryable() =>
        {
            MessengerPreflightDecision::RetryDns(error)
        }
        MessengerPreflightAttempt::Completed(Err(error)) => {
            MessengerPreflightDecision::Return(error.into())
        }
        MessengerPreflightAttempt::TaskFailed(error) => {
            MessengerPreflightDecision::Return(MessengerLoadStatus::unexpected(
                "Messenger check failed",
                format!("DNS preflight task failed: {error}"),
            ))
        }
        MessengerPreflightAttempt::TimedOut if has_more_attempts => {
            MessengerPreflightDecision::RetryTimeout
        }
        MessengerPreflightAttempt::TimedOut => {
            MessengerPreflightDecision::Return(MessengerLoadStatus::unexpected(
                "Messenger check timed out",
                format!("The Messenger DNS preflight did not finish after {attempt} attempts."),
            ))
        }
    }
}

#[tauri::command]
pub(crate) async fn connect_messenger(
    window: WebviewWindow,
    retry_startup_transients: bool,
) -> MessengerLoadStatus {
    // Only the automatic startup check gets the full retry window. A manual
    // retry should quickly restore the recovery screen and its DNS bypass.
    let max_attempts = if retry_startup_transients {
        MESSENGER_DNS_MAX_ATTEMPTS
    } else {
        1
    };
    let mut attempt = 1;
    // A task already in the slot belongs to an earlier command. Its completed
    // failure is stale for this call; an unfinished task must still be reused
    // because dropping spawn_blocking's handle would not cancel the lookup.
    let mut polling_inherited_task = true;

    loop {
        let (preflight, inherited_result) = {
            let mut preflight_tasks = MESSENGER_PREFLIGHT_TASKS.lock().await;
            preflight_tasks.prune_retired();
            if polling_inherited_task
                && preflight_tasks
                    .active
                    .as_ref()
                    .is_some_and(|task| task.inner().is_finished())
            {
                preflight_tasks.active.take();
            }
            if preflight_tasks.active.is_none() {
                preflight_tasks.active = Some(tauri::async_runtime::spawn_blocking(
                    messenger_dns_preflight,
                ));
                polling_inherited_task = false;
            }

            let result = match tokio::time::timeout(
                MESSENGER_DNS_TIMEOUT,
                preflight_tasks
                    .active
                    .as_mut()
                    .expect("the preflight task slot is initialized before polling"),
            )
            .await
            {
                Ok(Ok(result)) => {
                    preflight_tasks.active.take();
                    MessengerPreflightAttempt::Completed(result)
                }
                Ok(Err(error)) => {
                    preflight_tasks.active.take();
                    MessengerPreflightAttempt::TaskFailed(error.to_string())
                }
                Err(_) => {
                    if attempt >= max_attempts {
                        preflight_tasks.retire_active_after_timeout();
                    }
                    MessengerPreflightAttempt::TimedOut
                }
            };
            (result, polling_inherited_task)
        };

        if inherited_result
            && matches!(
                &preflight,
                MessengerPreflightAttempt::Completed(Err(_))
                    | MessengerPreflightAttempt::TaskFailed(_)
            )
        {
            log::info!("Discarding a completed DNS preflight result from an earlier command");
            continue;
        }

        match classify_messenger_preflight_attempt(attempt, max_attempts, preflight) {
            MessengerPreflightDecision::Navigate => return navigate_to_messenger(&window),
            MessengerPreflightDecision::RetryDns(error) => {
                log::info!(
                    "Messenger DNS preflight attempt {attempt}/{max_attempts} \
                     failed during startup ({error:?}); retrying"
                );
            }
            MessengerPreflightDecision::RetryTimeout => {
                // A running spawn_blocking task cannot be cancelled. Poll the
                // same resolver call again so timed-out lookups do not overlap.
                log::info!(
                    "Messenger DNS preflight attempt {attempt}/{max_attempts} \
                     timed out during startup; continuing to wait"
                );
            }
            MessengerPreflightDecision::Return(status) => return status,
        }

        tokio::time::sleep(MESSENGER_DNS_RETRY_DELAY).await;
        attempt += 1;
    }
}

/// Bypass the OS DNS preflight when the user explicitly asks to try the
/// webview's resolver (for example when a proxy or secure-DNS setup differs
/// from the system resolver).
#[tauri::command]
pub(crate) fn open_messenger_anyway(window: WebviewWindow) -> MessengerLoadStatus {
    navigate_to_messenger(&window)
}

/// Open the folder holding Carrier's log file, for attaching to bug reports.
/// Called from the (local-origin) Settings window.
#[tauri::command]
pub(crate) fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open::that_detached(&dir).map_err(|e| e.to_string())
}

/// Create (without overwriting) and open the user-owned custom stylesheet.
/// Called only from the trusted local Settings window.
#[tauri::command]
pub(crate) fn open_custom_css(app: tauri::AppHandle) -> Result<(), String> {
    let path = ensure_custom_css(&app)?;
    open::that_detached(path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        classify_messenger_preflight_attempt, should_surface_update, MessengerPreflightAttempt,
        MessengerPreflightDecision, UpdateInstallGuard, MESSENGER_DNS_MAX_ATTEMPTS,
    };
    use crate::preflight::MessengerPreflightError;
    use std::io::ErrorKind;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn update_install_guard_is_single_flight_and_releases_on_drop() {
        let flag = AtomicBool::new(false);
        let first = UpdateInstallGuard::acquire(&flag).unwrap();
        assert!(
            UpdateInstallGuard::acquire(&flag).is_err(),
            "a concurrent update install must be rejected"
        );

        drop(first);
        assert!(
            UpdateInstallGuard::acquire(&flag).is_ok(),
            "the guard must release after success or failure"
        );
    }

    #[test]
    fn update_discovery_only_surfaces_new_versions() {
        assert!(should_surface_update(None, Some("1.4.0")));
        assert!(!should_surface_update(Some("1.4.0"), Some("1.4.0")));
        assert!(should_surface_update(Some("1.4.0"), Some("1.5.0")));
        assert!(!should_surface_update(Some("1.4.0"), None));
    }

    #[test]
    fn startup_preflight_retries_only_completed_dns_failures() {
        let dns_failure = || MessengerPreflightError::DnsFailed {
            host: "www.facebook.com",
            kind: ErrorKind::TimedOut,
            resolver_status: None,
            retryable: true,
            error: "temporary failure".into(),
        };
        let blocker = MessengerPreflightError::Blocked {
            host: "www.facebook.com",
            ips: vec!["127.0.0.1".parse().unwrap()],
        };

        assert!(matches!(
            classify_messenger_preflight_attempt(
                1,
                MESSENGER_DNS_MAX_ATTEMPTS,
                MessengerPreflightAttempt::Completed(Err(dns_failure()))
            ),
            MessengerPreflightDecision::RetryDns(_)
        ));
        assert!(matches!(
            classify_messenger_preflight_attempt(
                MESSENGER_DNS_MAX_ATTEMPTS,
                MESSENGER_DNS_MAX_ATTEMPTS,
                MessengerPreflightAttempt::Completed(Err(dns_failure()))
            ),
            MessengerPreflightDecision::Return(_)
        ));
        assert!(matches!(
            classify_messenger_preflight_attempt(
                1,
                MESSENGER_DNS_MAX_ATTEMPTS,
                MessengerPreflightAttempt::Completed(Err(blocker))
            ),
            MessengerPreflightDecision::Return(_)
        ));
    }

    #[test]
    fn startup_preflight_classifies_success_task_failure_and_timeouts() {
        assert!(matches!(
            classify_messenger_preflight_attempt(
                1,
                MESSENGER_DNS_MAX_ATTEMPTS,
                MessengerPreflightAttempt::Completed(Ok(()))
            ),
            MessengerPreflightDecision::Navigate
        ));
        assert!(matches!(
            classify_messenger_preflight_attempt(
                1,
                MESSENGER_DNS_MAX_ATTEMPTS,
                MessengerPreflightAttempt::TaskFailed("panic".into())
            ),
            MessengerPreflightDecision::Return(_)
        ));
        assert!(matches!(
            classify_messenger_preflight_attempt(
                1,
                MESSENGER_DNS_MAX_ATTEMPTS,
                MessengerPreflightAttempt::TimedOut
            ),
            MessengerPreflightDecision::RetryTimeout
        ));
        assert!(matches!(
            classify_messenger_preflight_attempt(
                MESSENGER_DNS_MAX_ATTEMPTS,
                MESSENGER_DNS_MAX_ATTEMPTS,
                MessengerPreflightAttempt::TimedOut
            ),
            MessengerPreflightDecision::Return(_)
        ));
    }

    #[test]
    fn manual_preflight_does_not_retry_transient_dns_failures() {
        let dns_failure = MessengerPreflightError::DnsFailed {
            host: "www.facebook.com",
            kind: ErrorKind::TimedOut,
            resolver_status: None,
            retryable: true,
            error: "temporary resolver timeout".into(),
        };

        assert!(matches!(
            classify_messenger_preflight_attempt(
                1,
                1,
                MessengerPreflightAttempt::Completed(Err(dns_failure))
            ),
            MessengerPreflightDecision::Return(_)
        ));
        assert!(matches!(
            classify_messenger_preflight_attempt(1, 1, MessengerPreflightAttempt::TimedOut),
            MessengerPreflightDecision::Return(_)
        ));
    }

    #[test]
    fn startup_preflight_does_not_retry_permanent_dns_failures() {
        let dns_failure = MessengerPreflightError::DnsFailed {
            host: "www.facebook.com",
            kind: ErrorKind::NotFound,
            resolver_status: None,
            retryable: false,
            error: "name does not exist".into(),
        };

        assert!(matches!(
            classify_messenger_preflight_attempt(
                1,
                MESSENGER_DNS_MAX_ATTEMPTS,
                MessengerPreflightAttempt::Completed(Err(dns_failure))
            ),
            MessengerPreflightDecision::Return(_)
        ));
    }
}
