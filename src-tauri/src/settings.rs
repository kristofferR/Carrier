//! Persisted preferences: the [`Settings`] struct, load/save, the shared
//! [`AppState`], applying settings at runtime, and the webview-data
//! ("Clear Cache") machinery.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{tray::TrayIcon, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::hotkey::apply_global_hotkey;
#[cfg(target_os = "macos")]
use crate::macos::theme::set_macos_window_bg;
use crate::menu::{rebuild_recent_menus, RecentThread};
use crate::tray::{build_tray_menu, build_tray_with_menu, show_main, wants_tray};
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
    /// Suppress all desktop notifications for new messages.
    pub(crate) mute_notifications: bool,
    /// Play the OS notification sound for new-message notifications.
    pub(crate) notification_sound: bool,
    /// Notify without the sender name or message text (privacy).
    pub(crate) hide_notification_preview: bool,
    /// Blur contact names and avatars (for screen-sharing / public spaces).
    pub(crate) hide_names_avatars: bool,
    /// Render Facebook emoji sprites as native system emoji glyphs.
    pub(crate) system_emoji: bool,
    /// Page zoom in percent (clamped to 30–200; 100 = no zoom).
    pub(crate) zoom: i32,
    /// Global summon hotkey (Cmd/Ctrl+Shift+M): show or hide Carrier from
    /// anywhere. Off by default so it can't clash with other apps' shortcuts.
    pub(crate) global_hotkey: bool,
    /// Block Facebook's analytics/logging requests (banzai, quick metrics,
    /// error reporting) in the page. Never touches messaging endpoints.
    pub(crate) block_telemetry: bool,
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
            multi_instance: false,
            spellcheck: true,
            unread_badge: true,
            badge_mode: "messages".into(),
            theme: "system".into(),
            menu_bar_only: false,
            mute_notifications: false,
            notification_sound: true,
            hide_notification_preview: false,
            hide_names_avatars: false,
            system_emoji: false,
            zoom: 100,
            global_hotkey: false,
            block_telemetry: true,
        }
    }
}

pub(crate) struct AppState {
    pub(crate) settings: Mutex<Settings>,
    pub(crate) tray: Mutex<Option<TrayIcon>>,
    pub(crate) next_window: AtomicUsize,
    /// True while [`recreate_themed_windows`](crate::window::recreate_themed_windows)
    /// is between destroying and rebuilding, so the run loop doesn't exit when
    /// the window count hits zero.
    pub(crate) recreating: std::sync::atomic::AtomicBool,
    /// The page-scraped recent-conversations list backing the Dock/tray menus.
    /// In memory only — never persisted (see `carrier:recent-threads`).
    pub(crate) recent_threads: Mutex<Vec<RecentThread>>,
}

const APP_IDENTIFIER: &str = "io.github.kristofferr.carrier";

fn settings_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("settings.json"))
}

pub(crate) fn load_settings(app: &tauri::AppHandle) -> Settings {
    settings_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default()
        .sanitized()
}

/// Read persisted settings directly from disk before the Tauri app is built
/// (used to decide single-instance enforcement). Falls back to defaults.
pub(crate) fn load_settings_early() -> Settings {
    dirs_config_dir()
        .map(|b| b.join(APP_IDENTIFIER).join("settings.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default()
        .sanitized()
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

pub(crate) fn save_settings(app: &tauri::AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_file(app).ok_or("no config directory available")?;
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
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
/// state, the injected-prefs refresh, the global hotkey, and the tray).
/// Autostart and store-time hotkey changes are handled separately so failures
/// can be returned to Settings; everything else here is best-effort.
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
            // `build()` also registers a clone in Tauri's resource table, so
            // dropping our handle alone leaves the icon visible — remove it by id.
            let _ = app.remove_tray_by_id("carrier-tray");
            *tray = None;
        }
        _ => {}
    }
    // Whether a tray icon is actually present after the reconcile above (e.g.
    // build_tray may have failed). macOS uses this to avoid hiding the Dock with
    // no tray to fall back on.
    #[cfg(target_os = "macos")]
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
        assert!(!s.system_emoji, "system_emoji should default to false");
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

    #[test]
    fn settings_json_missing_zoom_defaults_to_100() {
        // Pre-existing installs have no `zoom` key in settings.json.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.zoom, 100);
    }
}
