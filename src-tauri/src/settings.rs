//! Persisted preferences: the [`Settings`] struct, load/save, the shared
//! [`AppState`], applying settings at runtime, and the webview-data
//! ("Clear Cache") machinery.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

use crate::hotkey::apply_global_hotkey;
#[cfg(target_os = "macos")]
use crate::macos::theme::set_macos_window_bg;
use crate::menu::{rebuild_recent_menus, RecentThread};
use crate::tray::{build_tray_menu, build_tray_with_menu, show_main, wants_tray, PlatformTrayIcon};
#[cfg(target_os = "macos")]
use crate::window::is_dark;
#[cfg(not(target_os = "macos"))]
use crate::window::splash_background;
use crate::window::theme_for;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Settings {
    pub(crate) always_on_top: bool,
    pub(crate) show_tray: bool,
    pub(crate) start_to_tray: bool,
    pub(crate) autostart: bool,
    pub(crate) hide_on_close: bool,
    /// Whether the one-time "still running in the tray" close notice has been
    /// shown. Persisted internally; it is not an end-user preference.
    pub(crate) tray_notice_shown: bool,
    /// Experimental: when true, single-instance enforcement is skipped at the
    /// next launch (takes effect after restart).
    pub(crate) multi_instance: bool,
    pub(crate) spellcheck: bool,
    /// Show the unread count on the Dock/taskbar icon.
    pub(crate) unread_badge: bool,
    /// What the unread badge counts: "messages" (Facebook's total unread message
    /// count, from the page title) or "conversations" (unread chats in the list).
    pub(crate) badge_mode: String,
    /// Force the Messenger theme: "system" (follow FB), "light", or "dark".
    pub(crate) theme: String,
    /// macOS: run as a menu-bar app with no Dock icon (requires the tray).
    pub(crate) menu_bar_only: bool,
    /// Windows/Linux: hide the native application menu from Messenger windows.
    pub(crate) hide_menu_bar: bool,
    /// Windows: hide the main window into the tray when it is minimized.
    pub(crate) hide_on_minimize: bool,
    /// Windows: hide the main window into the tray when it loses focus.
    pub(crate) hide_on_focus_loss: bool,
    /// Windows: omit the main window from the taskbar. This is only applied
    /// while a tray icon exists so the app always remains reachable.
    pub(crate) hide_taskbar_icon: bool,
    /// Suppress all desktop notifications for new messages.
    pub(crate) mute_notifications: bool,
    /// Discover signed Carrier updates on startup and every four hours. This
    /// never downloads or installs without explicit confirmation in Settings.
    pub(crate) automatic_update_checks: bool,
    /// Play the OS notification sound for new-message notifications.
    pub(crate) notification_sound: bool,
    /// Notify without the sender name or message text (privacy).
    pub(crate) hide_notification_preview: bool,
    /// Blur contact names and avatars (for screen-sharing / public spaces).
    pub(crate) hide_names_avatars: bool,
    /// Render Facebook emoji sprites as native system emoji glyphs.
    pub(crate) system_emoji: bool,
    /// Pause videos and animated media that start without a recent user
    /// interaction. Manual playback remains available. Off by default.
    pub(crate) stop_media_autoplay: bool,
    /// Page zoom in percent (clamped to 30–200; 100 = no zoom).
    pub(crate) zoom: i32,
    /// Global summon hotkey (Cmd/Ctrl+Shift+M): show or hide Carrier from
    /// anywhere. Off by default so it can't clash with other apps' shortcuts.
    pub(crate) global_hotkey: bool,
    /// Block Facebook's analytics/logging requests (banzai, quick metrics,
    /// error reporting) in the page. Never touches messaging endpoints.
    pub(crate) block_telemetry: bool,
    /// Remove Facebook attribution parameters from links copied from Messenger
    /// or opened in the system browser.
    pub(crate) strip_link_tracking: bool,
    /// Require Cmd+Enter on macOS or Ctrl+Enter elsewhere to send a message.
    /// Plain Enter inserts a line break. Off by default.
    pub(crate) send_with_accelerator: bool,
}

/// Valid page-zoom range in percent (matches the keyboard zoom in
/// `inject/messenger.js`).
pub(crate) const ZOOM_MIN: i32 = 30;
pub(crate) const ZOOM_MAX: i32 = 200;

pub(crate) fn clamp_zoom(zoom: i32) -> i32 {
    zoom.clamp(ZOOM_MIN, ZOOM_MAX)
}

impl Settings {
    /// Clamp out-of-range values (settings.json is user-editable, and the zoom
    /// event payload comes from the remote-origin page).
    pub(crate) fn sanitized(mut self) -> Self {
        self.zoom = clamp_zoom(self.zoom);
        // Every Windows tray-oriented behavior can make the main window
        // disappear without closing it. Keep the escape hatch explicit and
        // persisted rather than relying only on a runtime fallback.
        #[cfg(target_os = "windows")]
        if self.hide_on_minimize || self.hide_on_focus_loss || self.hide_taskbar_icon {
            self.show_tray = true;
        }
        self
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            always_on_top: false,
            show_tray: true,
            start_to_tray: false,
            autostart: false,
            hide_on_close: true,
            tray_notice_shown: false,
            multi_instance: false,
            spellcheck: false,
            unread_badge: true,
            badge_mode: "messages".into(),
            theme: "system".into(),
            menu_bar_only: false,
            hide_menu_bar: false,
            hide_on_minimize: false,
            hide_on_focus_loss: false,
            hide_taskbar_icon: false,
            mute_notifications: false,
            automatic_update_checks: true,
            notification_sound: true,
            hide_notification_preview: false,
            hide_names_avatars: false,
            system_emoji: false,
            stop_media_autoplay: false,
            zoom: 100,
            global_hotkey: false,
            block_telemetry: true,
            strip_link_tracking: true,
            send_with_accelerator: false,
        }
    }
}

pub(crate) struct AppState {
    pub(crate) settings: Mutex<Settings>,
    /// Serializes every settings read-modify-write operation before it enters
    /// blocking/native work. Awaiting this queue avoids both stale snapshots and
    /// one waiting OS thread per mutation during a burst.
    pub(crate) settings_worker: tokio::sync::Mutex<()>,
    pub(crate) tray: Mutex<Option<PlatformTrayIcon>>,
    pub(crate) next_window: AtomicUsize,
    /// Serializes update installation even if the trusted Settings page is
    /// invoked concurrently from multiple windows or automation.
    pub(crate) update_installing: AtomicBool,
    /// Serializes every updater operation so automatic/manual discovery cannot
    /// race the installer's re-check, download, or replacement.
    pub(crate) update_checking: tokio::sync::Mutex<()>,
    /// Update discovered during this process, if any. Retaining the verified
    /// metadata makes the Settings action genuinely install the update it
    /// advertises, even if a later release check is temporarily unavailable.
    pub(crate) update_available: Mutex<Option<tauri_plugin_updater::Update>>,
    /// Wakes the automatic checker immediately when its opt-in is enabled.
    pub(crate) update_check_wake: tokio::sync::Notify,
    /// Prevents a successfully delivered first tray notice from repeating in
    /// the current process even while its settings write is being merged.
    pub(crate) tray_notice_delivered: AtomicBool,
    /// Non-zero generation token while the main window is deliberately being
    /// restored. A token (rather than a bool) lets overlapping reveals renew
    /// the guard without an older reset timer clearing the newer reveal.
    pub(crate) revealing_main: AtomicUsize,
    /// Monotonic source for `revealing_main` tokens.
    pub(crate) next_reveal_generation: AtomicUsize,
    /// Monotonic token used to coalesce queued page zoom persistence work.
    /// The event listener queues work away from the UI thread, so older tasks
    /// must be able to yield to the newest zoom event.
    pub(crate) zoom_generation: AtomicUsize,
    /// True while Messenger windows are being destroyed and rebuilt for a theme
    /// change or blank-webview recovery, so the run loop doesn't exit when the
    /// window count hits zero.
    pub(crate) recreating: AtomicBool,
    /// The page-scraped recent-conversations list backing the Dock/tray menus.
    /// In memory only — never persisted (see `carrier:recent-threads`).
    pub(crate) recent_threads: Mutex<Vec<RecentThread>>,
    /// Per-window secrets that authenticate reveal-download requests from
    /// Carrier's injected click handler. Remote page scripts can emit events,
    /// but cannot read these closure-scoped tokens.
    pub(crate) download_reveal_tokens: Mutex<HashMap<String, String>>,
}

const APP_IDENTIFIER: &str = "io.github.kristofferr.carrier";
// Orders concurrent settings writes: each call takes a monotonically increasing
// ticket, and the publish step below refuses to overwrite a destination that a
// higher-ticket (newer) snapshot has already reached.
static SETTINGS_WRITE_SEQ: AtomicUsize = AtomicUsize::new(0);
// Serializes the publish (rename) step and records, per destination, the newest
// ticket already on disk. Keyed by path so writes to unrelated files never block
// or skip one another (in production there is only ever one settings file).
static SETTINGS_PUBLISHED: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();

fn settings_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("settings.json"))
}

pub(crate) fn load_settings(app: &tauri::AppHandle) -> Settings {
    settings_file(app)
        .map(|path| load_settings_from_path(&path))
        .unwrap_or_default()
}

/// Read persisted settings directly from disk before the Tauri app is built
/// (used to decide single-instance enforcement). Falls back to defaults.
pub(crate) fn load_settings_early() -> Settings {
    dirs_config_dir()
        .map(|b| b.join(APP_IDENTIFIER).join("settings.json"))
        .map(|path| load_settings_from_path(&path))
        .unwrap_or_default()
}

fn load_settings_from_path(path: &Path) -> Settings {
    match std::fs::read_to_string(path) {
        Ok(json) => match serde_json::from_str::<Settings>(&json) {
            Ok(settings) => settings.sanitized(),
            Err(error) => {
                log::warn!(
                    "settings file {} is corrupt; using defaults: {error}",
                    path.display()
                );
                Settings::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(error) => {
            log::warn!(
                "could not read settings file {}; using defaults: {error}",
                path.display()
            );
            Settings::default()
        }
    }
}

fn dirs_config_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library/Application Support"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config"))
            })
    }
}

/// Result of a settings save: whether this snapshot actually reached disk or was
/// dropped because a newer concurrent save had already been published. Callers
/// must not apply a `Superseded` snapshot to runtime — doing so would leave the
/// running settings diverged from what is persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SaveOutcome {
    Written,
    Superseded,
}

pub(crate) fn save_settings(app: &tauri::AppHandle, s: &Settings) -> Result<SaveOutcome, String> {
    let path = settings_file(app).ok_or("no config directory available")?;
    write_settings_to_path(&path, s)
}

fn write_settings_to_path(path: &Path, s: &Settings) -> Result<SaveOutcome, String> {
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let parent = path
        .parent()
        .ok_or("settings path has no parent directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("settings path has no valid file name")?;
    let sequence = SETTINGS_WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    // A random component keeps the temp name unique even if a previous run
    // crashed after creating one and the OS later reuses this pid — that would
    // restart the sequence at 0 and collide with the leftover under
    // `create_new`, failing the first save and losing the change.
    let nonce = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    let temp = parent.join(format!(
        ".{file_name}.{}.{}.{:016x}.tmp",
        std::process::id(),
        sequence,
        nonce
    ));

    let result = (|| -> Result<SaveOutcome, String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);

        // Publish under a lock so concurrent saves rename in a defined order,
        // and drop this write if a newer snapshot already reached the file —
        // otherwise a slow older writer could clobber newer settings.
        let mut published = SETTINGS_PUBLISHED
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap();
        if published.get(path).is_some_and(|latest| sequence < *latest) {
            let _ = std::fs::remove_file(&temp);
            return Ok(SaveOutcome::Superseded);
        }
        replace_file(&temp, path).map_err(|e| e.to_string())?;
        published.insert(path.to_path_buf(), sequence);
        // Fsync the parent directory so the rename itself survives a crash. A
        // failure means that durability can't be promised, so surface it rather
        // than reporting a clean save (the new bytes are already on disk).
        #[cfg(unix)]
        {
            let directory = std::fs::File::open(parent).map_err(|e| e.to_string())?;
            directory.sync_all().map_err(|e| e.to_string())?;
        }
        Ok(SaveOutcome::Written)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both paths are NUL-terminated UTF-16 buffers that remain alive
    // for the duration of the call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

const CLEAR_WEBVIEW_DATA_MARKER: &str = ".clear-webview-data-on-next-launch";

fn clear_webview_data_marker(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(CLEAR_WEBVIEW_DATA_MARKER))
}

pub(crate) fn schedule_webview_data_clear(app: &tauri::AppHandle) -> Result<(), String> {
    let marker = clear_webview_data_marker(app)?;
    std::fs::write(&marker, b"pending").map_err(|e| e.to_string())?;

    // Best-effort for the current process. On macOS this only schedules
    // WKWebView's async clear, so startup also removes the on-disk profile before
    // creating the next webview.
    for (_label, window) in app.webview_windows() {
        if let Err(e) = window.clear_all_browsing_data() {
            log::warn!("failed to schedule webview data clear: {e}");
        }
    }
    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<(), std::io::Error> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(target_os = "macos")]
fn push_macos_webview_store_paths(paths: &mut Vec<PathBuf>, home: &Path, name: &str) {
    paths.push(home.join("Library/WebKit").join(name));
    paths.push(home.join("Library/Caches").join(name));
    paths.push(
        home.join("Library/HTTPStorages")
            .join(format!("{name}.binarycookies")),
    );
    paths.push(
        home.join("Library/Cookies")
            .join(format!("{name}.binarycookies")),
    );
}

fn webview_data_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Ok(cache) = app.path().app_cache_dir() {
        paths.push(cache);
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            let identifier = app.config().identifier.as_str();
            push_macos_webview_store_paths(&mut paths, &home, identifier);

            // Older/dev builds wrote WKWebView data under the executable name.
            push_macos_webview_store_paths(&mut paths, &home, "carrier");
        }
    }

    #[cfg(not(target_os = "macos"))]
    if let Ok(local_data) = app.path().app_local_data_dir() {
        paths.push(local_data);
    }

    paths.sort();
    paths.dedup();
    paths
}

pub(crate) fn clear_pending_webview_data(app: &tauri::AppHandle) {
    let Ok(marker) = clear_webview_data_marker(app) else {
        return;
    };
    if !marker.exists() {
        return;
    }

    let mut all_removed = true;
    for path in webview_data_paths(app) {
        if let Err(e) = remove_path_if_exists(&path) {
            all_removed = false;
            log::error!("failed to remove webview data path {}: {e}", path.display());
        }
    }

    // Only clear the retry marker once every data path is actually gone. If any
    // removal failed, keep the marker so the next launch retries — otherwise a
    // single failure would silently abandon the "clear cache" request and leave
    // cookies/cache behind.
    if all_removed {
        if let Err(e) = std::fs::remove_file(&marker) {
            log::warn!("failed to remove clear-cache marker: {e}");
        }
    }
}

/// Register or unregister Start on System Startup with the OS. Kept separate so
/// callers can sync it *before* persisting and avoid committing a preference the
/// OS rejected.
pub(crate) fn sync_autostart(app: &tauri::AppHandle, want: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    let res = if want { mgr.enable() } else { mgr.disable() };
    res.map_err(|e| format!("Couldn't update Start on System Startup: {e}"))
}

/// Apply the settings that have an immediate runtime effect (window topmost
/// state, native menu visibility, the injected-prefs refresh, the global
/// hotkey, and the tray).
/// Autostart and store-time hotkey changes are handled separately so failures
/// can be returned to Settings; everything else here is best-effort. On Linux
/// the hotkey helper coalesces already-matched or startup-pending state before
/// dispatching portal work off-main.
pub(crate) fn apply_settings(app: &tauri::AppHandle, s: &Settings) {
    apply_global_hotkey(app, s.global_hotkey);
    let settings_json = serde_json::to_string(s).ok();
    let theme = theme_for(s);
    for (label, window) in app.webview_windows() {
        // Apply to every window (incl. the Settings dialog) so toggling Always
        // on Top from the dialog doesn't leave the dialog stuck behind the
        // now-topmost Messenger windows.
        let _ = window.set_always_on_top(s.always_on_top);
        // Webview color-scheme (and the window chrome on Windows/Linux).
        let _ = window.set_theme(theme);
        // The (now-transparent) webview lets the window background show through
        // the title bar, so keep that background in step with the theme. Tauri's
        // own set_background_color is unreliable on macOS (it can invert white to
        // black — tauri#12349), so set the NSWindow colour directly there.
        #[cfg(target_os = "macos")]
        {
            let win = window.clone();
            let dark = is_dark(s);
            let _ = window.run_on_main_thread(move || {
                if let Ok(ptr) = win.ns_window() {
                    set_macos_window_bg(ptr, dark);
                }
            });
        }
        #[cfg(not(target_os = "macos"))]
        let _ = window.set_background_color(Some(splash_background(s)));
        if label != "settings" {
            #[cfg(not(target_os = "macos"))]
            let _ = if s.hide_menu_bar {
                window.hide_menu()
            } else {
                window.show_menu()
            };
            // Push the new prefs to the running page so JS-side settings
            // (spell-check) refresh without a reload.
            if let Some(ref json) = settings_json {
                let _ = window.eval(format!(
                    "window.__CARRIER_SETTINGS__ = {json}; \
                     try {{ localStorage.setItem('__carrier_settings', JSON.stringify(window.__CARRIER_SETTINGS__)); }} catch (e) {{}} \
                     window.dispatchEvent(new Event('carrier:settings'));"
                ));
            }
        }
    }

    // Tray: create or tear down. Menu-bar-only needs one (it's the only way to
    // reach a Dock-less app), so force it on then.
    let want_tray = wants_tray(s);
    let state = app.state::<AppState>();
    let needs_tray = {
        let tray = state.tray.lock().unwrap();
        want_tray && tray.is_none()
    };
    let new_tray_menu = if needs_tray {
        build_tray_menu(app).ok()
    } else {
        None
    };
    let mut tray = state.tray.lock().unwrap();
    match (want_tray, tray.is_some()) {
        (true, false) => {
            if let Some(menu) = new_tray_menu {
                if let Ok(t) = build_tray_with_menu(app, menu) {
                    *tray = Some(t);
                }
            }
        }
        (false, true) => {
            // Removing the only way back, so make sure the main window is
            // visible before dropping the tray icon.
            show_main(app);
            #[cfg(not(target_os = "linux"))]
            {
                // `build()` also registers a clone in Tauri's resource table,
                // so dropping our handle alone leaves the icon visible.
                let _ = app.remove_tray_by_id("carrier-tray");
            }
            // The Linux KSNI service is owned exclusively by this handle and
            // shuts down here; Tauri's handle was removed from its table above.
            *tray = None;
        }
        _ => {}
    }
    // Whether a tray icon is actually present after the reconcile above (e.g.
    // build_tray may have failed). macOS uses this to avoid hiding the Dock with
    // no tray to fall back on.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let tray_available = tray.is_some();
    drop(tray);

    // macOS: hide/show the Dock icon (menu-bar-only mode). Only go Dock-less when
    // a tray exists to reach the app from — otherwise the app would have neither a
    // Dock icon nor a tray and be unreachable, so stay Regular and show the window.
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(if s.menu_bar_only && tray_available {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        });
        if s.menu_bar_only && !tray_available {
            show_main(app);
        }
    }

    // Only remove the main window from the Windows taskbar after the tray has
    // actually been created. If AppIndicator/tray creation fails for any
    // reason, restore the taskbar entry and surface the window instead of
    // leaving Carrier with no reliable way back.
    #[cfg(target_os = "windows")]
    {
        let hide_from_taskbar = s.hide_taskbar_icon && tray_available;
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.set_skip_taskbar(hide_from_taskbar);
        }
        if s.hide_taskbar_icon && !tray_available {
            show_main(app);
        }
    }

    // Keep the recent-conversations menus in step with the settings — most
    // importantly, flipping Hide Names & Avatars on must clear them at once.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || rebuild_recent_menus(&handle));
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Settings::default  (new fields added in this PR)
    // -----------------------------------------------------------------------

    #[test]
    fn settings_default_new_fields_have_correct_values() {
        let s = Settings::default();
        assert!(s.unread_badge, "unread_badge should default to true");
        assert_eq!(s.theme, "system", "theme should default to 'system'");
        assert!(!s.menu_bar_only, "menu_bar_only should default to false");
        assert!(!s.hide_menu_bar, "hide_menu_bar should default to false");
        assert!(
            !s.hide_on_minimize,
            "hide_on_minimize should default to false"
        );
        assert!(
            !s.hide_on_focus_loss,
            "hide_on_focus_loss should default to false"
        );
        assert!(
            !s.hide_taskbar_icon,
            "hide_taskbar_icon should default to false"
        );
        assert!(!s.spellcheck, "spellcheck should default to false");
        assert!(
            s.automatic_update_checks,
            "automatic signed-update discovery should default to true"
        );
        assert!(
            !s.tray_notice_shown,
            "the first hide-to-tray should explain where Carrier went"
        );
        assert!(!s.system_emoji, "system_emoji should default to false");
        assert!(
            !s.stop_media_autoplay,
            "stop_media_autoplay should default to false"
        );
        assert!(
            !s.send_with_accelerator,
            "send_with_accelerator should default to false"
        );
        assert!(
            s.strip_link_tracking,
            "Facebook link tracking removal should default to true"
        );
        assert_eq!(s.zoom, 100, "zoom should default to 100%");
    }

    // -----------------------------------------------------------------------
    // Page zoom clamping
    // -----------------------------------------------------------------------

    #[test]
    fn clamp_zoom_limits_to_valid_range() {
        assert_eq!(clamp_zoom(100), 100);
        assert_eq!(clamp_zoom(30), 30);
        assert_eq!(clamp_zoom(200), 200);
        assert_eq!(clamp_zoom(10), 30);
        assert_eq!(clamp_zoom(-50), 30);
        assert_eq!(clamp_zoom(1000), 200);
    }

    #[test]
    fn settings_sanitized_clamps_zoom() {
        let s = Settings {
            zoom: 9999,
            ..Default::default()
        };
        assert_eq!(s.sanitized().zoom, 200);
        let s = Settings {
            zoom: 0,
            ..Default::default()
        };
        assert_eq!(s.sanitized().zoom, 30);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn tray_oriented_windows_settings_force_the_tray_on() {
        for settings in [
            Settings {
                show_tray: false,
                hide_on_minimize: true,
                ..Default::default()
            },
            Settings {
                show_tray: false,
                hide_on_focus_loss: true,
                ..Default::default()
            },
            Settings {
                show_tray: false,
                hide_taskbar_icon: true,
                ..Default::default()
            },
        ] {
            assert!(settings.sanitized().show_tray);
        }
    }

    #[test]
    fn settings_json_missing_zoom_defaults_to_100() {
        // Pre-existing installs have no `zoom` key in settings.json.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.zoom, 100);
    }

    #[test]
    fn settings_json_missing_hide_menu_bar_defaults_to_false() {
        // Pre-existing installs have no `hide_menu_bar` key in settings.json.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(!s.hide_menu_bar);
    }

    #[test]
    fn settings_json_missing_windows_tray_options_defaults_to_false() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(!s.hide_on_minimize);
        assert!(!s.hide_on_focus_loss);
        assert!(!s.hide_taskbar_icon);
    }

    #[test]
    fn settings_json_missing_spellcheck_defaults_to_false() {
        // Pre-existing installs without this key should not opt in implicitly.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(!s.spellcheck);
    }

    #[test]
    fn settings_json_missing_automatic_update_checks_defaults_to_true() {
        // Existing installs should gain safe discovery, while install remains
        // behind the separate explicit confirmation path.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.automatic_update_checks);
    }

    #[test]
    fn settings_json_missing_send_with_accelerator_defaults_to_false() {
        // Existing installs keep Enter-to-send unless they explicitly opt in.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(!s.send_with_accelerator);
    }

    #[test]
    fn settings_json_missing_strip_link_tracking_defaults_to_true() {
        // Existing installs should gain link cleanup without having to reset
        // their settings file.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.strip_link_tracking);
    }

    #[test]
    fn settings_json_missing_stop_media_autoplay_defaults_to_false() {
        // Existing installs should not opt into autoplay suppression implicitly.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(!s.stop_media_autoplay);
    }

    #[test]
    fn settings_write_replaces_the_file_atomically() {
        let directory = std::env::temp_dir().join(format!(
            "carrier-settings-test-{}-{}",
            std::process::id(),
            SETTINGS_WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");
        std::fs::write(&path, "{ partial").unwrap();

        let settings = Settings {
            zoom: 140,
            hide_names_avatars: true,
            ..Default::default()
        };
        write_settings_to_path(&path, &settings).unwrap();

        let loaded = load_settings_from_path(&path);
        assert_eq!(loaded.zoom, 140);
        assert!(loaded.hide_names_avatars);
        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            1,
            "temporary settings file should be renamed away"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stale_settings_write_does_not_replace_a_newer_snapshot() {
        let directory = std::env::temp_dir().join(format!(
            "carrier-settings-stale-{}-{}",
            std::process::id(),
            SETTINGS_WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");

        // Pretend a newer snapshot (the maximum ticket) already reached this
        // path, and seed the file with its content so we can prove it survives.
        SETTINGS_PUBLISHED
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .insert(path.clone(), usize::MAX);
        let newer = Settings {
            zoom: 175,
            ..Default::default()
        };
        std::fs::write(&path, serde_json::to_string_pretty(&newer).unwrap()).unwrap();

        // A slower older write (a lower ticket) must be dropped, not published.
        let older = Settings {
            zoom: 60,
            ..Default::default()
        };
        assert_eq!(
            write_settings_to_path(&path, &older).unwrap(),
            SaveOutcome::Superseded,
            "an older write must report itself superseded, not written"
        );

        assert_eq!(
            load_settings_from_path(&path).zoom,
            175,
            "an older snapshot must not overwrite a newer one"
        );
        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            1,
            "the dropped write must leave no temporary file behind"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupt_settings_fall_back_to_defaults() {
        let path = std::env::temp_dir().join(format!(
            "carrier-corrupt-settings-{}-{}.json",
            std::process::id(),
            SETTINGS_WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, "{ partial").unwrap();
        let loaded = load_settings_from_path(&path);
        assert_eq!(loaded.zoom, Settings::default().zoom);
        let _ = std::fs::remove_file(path);
    }
}
