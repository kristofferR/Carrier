//! Carrier — a tiny, distraction-free desktop client for Facebook Messenger.
//!
//! Opens a WebView window pointed at the Messenger web app, injects a stylesheet
//! that hides Facebook's surrounding chrome, and adds quality-of-life features:
//! shortcuts, zoom, an image viewer, a settings panel, copy/download image,
//! native notifications, theme sync, and tracking-redirect-free external links.
//! Anything that isn't Messenger is handed to the user's default browser.

use std::hash::{BuildHasher, Hasher};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    webview::{Color, DownloadEvent},
    Listener, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;
use url::Url;

/// The page we wrap.
const HOME_URL: &str = "https://www.facebook.com/messages";
const HOME_HOST: &str = "www.facebook.com";
const HOME_PORT: u16 = 443;
const MESSENGER_DNS_TIMEOUT: Duration = Duration::from_millis(1500);

/// Window/app title. Debug builds are marked so a dev build (e.g. the
/// tauri-mcp one) isn't mistaken for a release install.
const APP_TITLE: &str = if cfg!(debug_assertions) {
    "Carrier (debug)"
} else {
    "Carrier"
};

/// Injected assets (see `inject/`).
const INJECT_CSS: &str = include_str!("../inject/messenger.css");
const INJECT_JS: &str = include_str!("../inject/messenger.js");
const INJECT_PANEL: &str = include_str!("../inject/panel.js");

// The `mcp` feature wires a JS-eval responder into the remote Facebook page and
// opens a local control socket — strictly a dev tool. Enabling it in a release
// build is always a mistake, so fail the build loudly rather than risk shipping
// it. (This guards every `#[cfg(feature = "mcp")]` path below, including the
// plugin registration, since the feature can then only compile in debug.)
#[cfg(all(feature = "mcp", not(debug_assertions)))]
compile_error!("the `mcp` feature is dev-only and must not be enabled in release builds");

// Dev-only (`mcp` feature): the tauri-plugin-mcp guest responder, injected into
// the remote Facebook page so execute_js / get_dom round-trips work. Empty in
// release builds, so the JS-eval responder never ships.
#[cfg(feature = "mcp")]
const INJECT_MCP_BRIDGE: &str = include_str!("../inject/mcp-bridge.js");
#[cfg(not(feature = "mcp"))]
const INJECT_MCP_BRIDGE: &str = "";

/// A modern browser UA so Facebook serves the full Messenger web app.
const fn user_agent() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
         (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
    }
    #[cfg(target_os = "windows")]
    {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
         (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
    #[cfg(target_os = "linux")]
    {
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 \
         (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
}

#[cfg(any(test, target_os = "linux"))]
fn should_disable_webkit_dmabuf_renderer(
    has_wayland_display: bool,
    has_dmabuf_override: bool,
) -> bool {
    has_wayland_display && !has_dmabuf_override
}

#[cfg(target_os = "linux")]
fn configure_linux_webkit_renderer() {
    if should_disable_webkit_dmabuf_renderer(
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
        std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some(),
    ) {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
    always_on_top: bool,
    show_tray: bool,
    start_to_tray: bool,
    autostart: bool,
    hide_on_close: bool,
    /// Experimental: when true, single-instance enforcement is skipped at the
    /// next launch (takes effect after restart).
    multi_instance: bool,
    spellcheck: bool,
    /// Show the unread count on the Dock/taskbar icon.
    unread_badge: bool,
    /// What the unread badge counts: "messages" (Facebook's total unread message
    /// count, from the page title) or "conversations" (unread chats in the list).
    badge_mode: String,
    /// Force the Messenger theme: "system" (follow FB), "light", or "dark".
    theme: String,
    /// macOS: run as a menu-bar app with no Dock icon (requires the tray).
    menu_bar_only: bool,
    /// Suppress all desktop notifications for new messages.
    mute_notifications: bool,
    /// Play the OS notification sound for new-message notifications.
    notification_sound: bool,
    /// Notify without the sender name or message text (privacy).
    hide_notification_preview: bool,
    /// Do-not-disturb window start, local wall-clock "HH:MM" (empty = off).
    dnd_start: String,
    /// Do-not-disturb window end, local wall-clock "HH:MM" (empty = off).
    dnd_end: String,
    /// Blur contact names and avatars (for screen-sharing / public spaces).
    hide_names_avatars: bool,
    /// Render Facebook emoji sprites as native system emoji glyphs.
    system_emoji: bool,
    /// Page zoom in percent (clamped to 30–200; 100 = no zoom).
    zoom: i32,
    /// Global summon hotkey (Cmd/Ctrl+Shift+M): show or hide Carrier from
    /// anywhere. Off by default so it can't clash with other apps' shortcuts.
    global_hotkey: bool,
    /// Block Facebook's analytics/logging requests (banzai, quick metrics,
    /// error reporting) in the page. Never touches messaging endpoints.
    block_telemetry: bool,
}

/// Valid page-zoom range in percent (matches the keyboard zoom in
/// `inject/messenger.js`).
const ZOOM_MIN: i32 = 30;
const ZOOM_MAX: i32 = 200;

fn clamp_zoom(zoom: i32) -> i32 {
    zoom.clamp(ZOOM_MIN, ZOOM_MAX)
}

impl Settings {
    /// Clamp out-of-range values (settings.json is user-editable, and the zoom
    /// event payload comes from the remote-origin page).
    fn sanitized(mut self) -> Self {
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
            dnd_start: String::new(),
            dnd_end: String::new(),
            hide_names_avatars: false,
            system_emoji: false,
            zoom: 100,
            global_hotkey: false,
            block_telemetry: true,
        }
    }
}

struct AppState {
    settings: Mutex<Settings>,
    tray: Mutex<Option<TrayIcon>>,
    next_window: AtomicUsize,
    /// True while [`recreate_themed_windows`] is between destroying and
    /// rebuilding, so the run loop doesn't exit when the window count hits zero.
    recreating: std::sync::atomic::AtomicBool,
    /// The page-scraped recent-conversations list backing the Dock/tray menus.
    /// In memory only — never persisted (see `carrier:recent-threads`).
    recent_threads: Mutex<Vec<RecentThread>>,
}

const APP_IDENTIFIER: &str = "io.github.kristofferr.carrier";

fn settings_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("settings.json"))
}

fn load_settings(app: &tauri::AppHandle) -> Settings {
    settings_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default()
        .sanitized()
}

/// Read persisted settings directly from disk before the Tauri app is built
/// (used to decide single-instance enforcement). Falls back to defaults.
fn load_settings_early() -> Settings {
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

fn save_settings(app: &tauri::AppHandle, s: &Settings) -> Result<(), String> {
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

fn schedule_webview_data_clear(app: &tauri::AppHandle) -> Result<(), String> {
    let marker = clear_webview_data_marker(app)?;
    std::fs::write(&marker, b"pending").map_err(|e| e.to_string())?;

    // Best-effort for the current process. On macOS this only schedules
    // WKWebView's async clear, so startup also removes the on-disk profile before
    // creating the next webview.
    for (_label, window) in app.webview_windows() {
        if let Err(e) = window.clear_all_browsing_data() {
            eprintln!("carrier: failed to schedule webview data clear: {e}");
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

fn clear_pending_webview_data(app: &tauri::AppHandle) {
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
            eprintln!(
                "carrier: failed to remove webview data path {}: {e}",
                path.display()
            );
        }
    }

    // Only clear the retry marker once every data path is actually gone. If any
    // removal failed, keep the marker so the next launch retries — otherwise a
    // single failure would silently abandon the "clear cache" request and leave
    // cookies/cache behind.
    if all_removed {
        if let Err(e) = std::fs::remove_file(&marker) {
            eprintln!("carrier: failed to remove clear-cache marker: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

fn reveal_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        reveal_window(&window);
        return;
    }

    if app
        .state::<AppState>()
        .recreating
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }

    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    if let Ok(window) = build_app_window(app, "main", &settings) {
        install_main_close_handler(app, &window);
        reveal_window(&window);
    }
}

/// Show the main window if it's hidden/unfocused, or hide it if it's already the
/// focused window — so a tray click toggles the app.
fn toggle_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            reveal_window(&window);
        }
    } else {
        show_main(app);
    }
}

#[cfg(target_os = "macos")]
fn has_visible_messenger_window(app: &tauri::AppHandle) -> bool {
    app.webview_windows().into_iter().any(|(label, window)| {
        label != "settings"
            && window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false)
    })
}

#[cfg(target_os = "macos")]
fn should_reopen_main(has_visible_windows: bool, has_visible_messenger_window: bool) -> bool {
    !has_visible_windows || !has_visible_messenger_window
}

#[cfg(target_os = "macos")]
fn reopen_main_if_needed(app: &tauri::AppHandle, has_visible_windows: bool) {
    if should_reopen_main(has_visible_windows, has_visible_messenger_window(app)) {
        show_main(app);
    }
}

/// Whether a tray icon should exist: when the user asked for one, or when
/// menu-bar-only mode is on (the only way back to a Dock-less app).
fn wants_tray(s: &Settings) -> bool {
    s.show_tray || s.menu_bar_only
}

fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    // Most recent conversations first (mirrors the macOS Dock menu); clicking
    // one opens that thread. Empty until the page has pushed a list.
    let threads = recent_threads_for_menu(app);
    for t in &threads {
        menu.append(&MenuItem::with_id(
            app,
            recent_menu_id(t),
            &t.name,
            true,
            None::<&str>,
        )?)?;
    }
    if !threads.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit Carrier",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

#[cfg(target_os = "macos")]
fn show_tray_menu(app: &tauri::AppHandle) {
    let Some(window) = target_window(app).or_else(|| app.get_webview_window("main")) else {
        return;
    };
    if let Ok(menu) = build_tray_menu(app) {
        let _ = window.popup_menu(&menu);
    }
}

#[cfg(target_os = "macos")]
fn tray_unread_title(s: &Settings, unread: i64) -> Option<String> {
    if s.unread_badge && unread > 0 {
        Some(unread.to_string())
    } else {
        // tray-icon's macOS backend ignores None, so clear with an empty title.
        Some(String::new())
    }
}

fn build_tray_with_menu(app: &tauri::AppHandle, menu: Menu<tauri::Wry>) -> tauri::Result<TrayIcon> {
    let builder = TrayIconBuilder::with_id("carrier-tray")
        .tooltip(APP_TITLE)
        .icon(app.default_window_icon().expect("bundled icon").clone())
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                match (button, button_state) {
                    (MouseButton::Left, MouseButtonState::Up) => toggle_main(tray.app_handle()),
                    #[cfg(target_os = "macos")]
                    (MouseButton::Right, MouseButtonState::Down) => {
                        show_tray_menu(tray.app_handle());
                    }
                    _ => {}
                }
            }
        });

    #[cfg(not(target_os = "macos"))]
    let builder = builder.menu(&menu);
    #[cfg(target_os = "macos")]
    let _ = &menu;

    builder.build(app)
}

/// Register or unregister Start on System Startup with the OS. Kept separate so
/// callers can sync it *before* persisting and avoid committing a preference the
/// OS rejected.
fn sync_autostart(app: &tauri::AppHandle, want: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    let res = if want { mgr.enable() } else { mgr.disable() };
    res.map_err(|e| format!("Couldn't update Start on System Startup: {e}"))
}

/// The fixed global summon shortcut ("CmdOrCtrl" resolves to Cmd on macOS and
/// Ctrl on Windows/Linux). No recorder UI yet, so the combination isn't
/// configurable — see issue #52.
const SUMMON_SHORTCUT: &str = "CmdOrCtrl+Shift+M";

/// Register or unregister the global summon hotkey to match the setting.
fn sync_global_hotkey(app: &tauri::AppHandle, want: bool) -> Result<(), String> {
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
fn apply_global_hotkey(app: &tauri::AppHandle, want: bool) {
    if let Err(e) = sync_global_hotkey(app, want) {
        eprintln!("carrier: {e}");
    }
}

/// On startup, a persisted enabled hotkey can become invalid because the
/// desktop session changed or another app claimed the fixed shortcut. Keep the
/// stored setting aligned with the actual registration state.
fn reconcile_startup_global_hotkey(app: &tauri::AppHandle, s: &mut Settings) {
    if !s.global_hotkey {
        return;
    }
    if let Err(e) = sync_global_hotkey(app, true) {
        eprintln!("carrier: {e}");
        s.global_hotkey = false;
        if let Err(save_err) = save_settings(app, s) {
            eprintln!("carrier: failed to save disabled Global Hotkey setting: {save_err}");
        }
    }
}

/// Apply the settings that have an immediate runtime effect (window topmost
/// state, the injected-prefs refresh, the global hotkey, and the tray).
/// Autostart and store-time hotkey changes are handled separately so failures
/// can be returned to Settings; everything else here is best-effort.
fn apply_settings(app: &tauri::AppHandle, s: &Settings) {
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

// ---------------------------------------------------------------------------
// Recent conversations (Dock / tray menu)
// ---------------------------------------------------------------------------

/// One entry of the recent-conversations list the page scrapes from the chat
/// list and pushes over `carrier:recent-threads` (see inject/messenger.js).
/// Held in memory only; conversation names/ids are never written to disk.
#[derive(Debug, Clone, PartialEq, Deserialize)]
struct RecentThread {
    name: String,
    href: String,
}

/// The `carrier:recent-threads` payload crosses from the remote Facebook page,
/// so validate it hard: names are trimmed and truncated, hrefs must be a bare
/// `/t/<digits>/` thread path (they're re-embedded into an eval'd navigation),
/// duplicates are dropped, and the list is capped.
fn sanitize_recent_threads(threads: Vec<RecentThread>) -> Vec<RecentThread> {
    const MAX_THREADS: usize = 9;
    const MAX_NAME_CHARS: usize = 60;
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<RecentThread> = Vec::new();
    for t in threads {
        let name: String = t.name.trim().chars().take(MAX_NAME_CHARS).collect();
        let Some(id) = t
            .href
            .strip_prefix("/t/")
            .map(|rest| rest.trim_end_matches('/'))
        else {
            continue;
        };
        if name.is_empty()
            || id.is_empty()
            || id.len() > 32
            || !id.bytes().all(|b| b.is_ascii_digit())
            || t.href != format!("/t/{id}/")
        {
            continue;
        }
        if !seen.insert(id.to_string()) {
            continue;
        }
        out.push(RecentThread {
            name,
            href: format!("/t/{id}/"),
        });
        if out.len() >= MAX_THREADS {
            break;
        }
    }
    out
}

fn recent_thread_id(href: &str) -> Option<&str> {
    let id = href.strip_prefix("/t/")?.trim_end_matches('/');
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(id)
}

fn recent_menu_id(thread: &RecentThread) -> String {
    let id = recent_thread_id(&thread.href).expect("recent thread href is sanitized");
    format!("recent:{id}")
}

fn recent_href_from_menu_id(menu_id: &str) -> Option<String> {
    let id = menu_id.strip_prefix("recent:")?;
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!("/t/{id}/"))
}

/// The recent-threads list as native menus should show it: empty while Hide
/// Names & Avatars is on, so contact names never surface in the Dock/tray menu
/// of a screen-shared machine.
fn recent_threads_for_menu(app: &tauri::AppHandle) -> Vec<RecentThread> {
    let state = app.state::<AppState>();
    if state.settings.lock().unwrap().hide_names_avatars {
        return Vec::new();
    }
    let threads = state.recent_threads.lock().unwrap().clone();
    threads
}

/// Open a conversation picked from the Dock/tray menu: surface the app and ask
/// the page to navigate to the thread (it clicks the chat-list row for SPA
/// navigation, falling back to a hard navigation). The href is encoded into the
/// menu id when the menu is built, so a later recents refresh cannot make a
/// visible native menu item open a different thread.
fn open_recent_thread(app: &tauri::AppHandle, href: &str) {
    show_main(app);
    if let Some(w) = target_window(app) {
        // `href` is validated to `/t/<digits>/`; JSON-encode it anyway so the
        // eval always receives a well-formed JS string literal.
        if let Ok(arg) = serde_json::to_string(&href) {
            let _ = w.eval(format!(
                "window.__carrierOpenThread && window.__carrierOpenThread({arg});"
            ));
        }
    }
}

/// The NSMenu currently served as the Dock menu. AppKit re-queries
/// `applicationDockMenu:` on every Dock right-click, so swapping this pointer
/// (and the keepalive below) is all a rebuild takes. Null = no custom menu.
#[cfg(target_os = "macos")]
static DOCK_NS_MENU: std::sync::atomic::AtomicPtr<std::ffi::c_void> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

// Keeps the muda menu backing DOCK_NS_MENU alive between rebuilds. Main-thread
// only: muda menus aren't Send, and AppKit menus must be touched there anyway.
#[cfg(target_os = "macos")]
thread_local! {
    static DOCK_MENU_KEEPALIVE: std::cell::RefCell<Option<muda::Menu>> =
        const { std::cell::RefCell::new(None) };
}

/// The `applicationDockMenu:` implementation grafted onto tao's NSApplication
/// delegate: hand AppKit whatever menu the last rebuild published.
#[cfg(target_os = "macos")]
extern "C-unwind" fn application_dock_menu(
    _this: *mut objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    _sender: *mut objc2::runtime::AnyObject,
) -> *mut objc2::runtime::AnyObject {
    DOCK_NS_MENU.load(Ordering::SeqCst) as *mut objc2::runtime::AnyObject
}

/// Add `applicationDockMenu:` to the live app delegate so the Dock icon's
/// context menu can list recent conversations — neither tauri, tao, nor muda
/// exposes a Dock-menu API, but the delegate hook is the one AppKit blesses.
/// Called once from `RunEvent::Ready` (the delegate exists by then); the added
/// method reads [`DOCK_NS_MENU`], so later rebuilds don't touch the delegate.
#[cfg(target_os = "macos")]
fn install_dock_menu_provider() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};

    // SAFETY: main-thread AppKit reads (RunEvent::Ready runs there); the
    // delegate outlives the app, and class_addMethod is a documented runtime
    // call — it fails harmlessly (returns NO) if the method ever exists.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![app, delegate];
        if delegate.is_null() {
            return;
        }
        let cls = (*delegate).class() as *const objc2::runtime::AnyClass;
        // "@@:@": returns id, takes self + _cmd + the NSApplication sender.
        let imp: objc2::runtime::Imp = std::mem::transmute(
            application_dock_menu
                as extern "C-unwind" fn(
                    *mut AnyObject,
                    objc2::runtime::Sel,
                    *mut AnyObject,
                ) -> *mut AnyObject,
        );
        objc2::ffi::class_addMethod(
            cls.cast_mut(),
            sel!(applicationDockMenu:),
            imp,
            c"@@:@".as_ptr(),
        );
    }
}

/// Rebuild the native menus that mirror the recent-threads list: the macOS
/// Dock menu, and the tray menu on Windows/Linux (the macOS tray builds its
/// menu fresh on every right-click, so it needs no push). Must run on the main
/// thread — menu construction is main-thread-only on macOS.
fn rebuild_recent_menus(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let threads = recent_threads_for_menu(app);
        let ptr = if threads.is_empty() {
            std::ptr::null_mut()
        } else {
            use muda::ContextMenu as _;
            let menu = muda::Menu::new();
            for t in &threads {
                let _ = menu.append(&muda::MenuItem::with_id(
                    recent_menu_id(t),
                    &t.name,
                    true,
                    None,
                ));
            }
            let ptr = menu.ns_menu();
            DOCK_MENU_KEEPALIVE.with(|slot| *slot.borrow_mut() = Some(menu));
            ptr
        };
        DOCK_NS_MENU.store(ptr, Ordering::SeqCst);
        if ptr.is_null() {
            DOCK_MENU_KEEPALIVE.with(|slot| *slot.borrow_mut() = None);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let Ok(menu) = build_tray_menu(app) else {
            return;
        };
        let state = app.state::<AppState>();
        let tray = state.tray.lock().unwrap();
        if let Some(tray) = tray.as_ref() {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

// ---------------------------------------------------------------------------
// Link handling
// ---------------------------------------------------------------------------

/// Facebook wraps external links in tracking redirects
/// (`l.facebook.com/l.php?u=…`, `lm.facebook.com/l.php?u=…`, `facebook.com/l.php`).
/// Return the real destination if `url` is such a redirect.
fn unwrap_tracking(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    let is_redirect = host == "l.facebook.com"
        || host == "lm.facebook.com"
        || (host == "facebook.com" && url.path() == "/l.php");
    if !is_redirect {
        return None;
    }
    url.query_pairs()
        .find(|(k, _)| k == "u")
        .map(|(_, v)| v.into_owned())
        // Only unwrap to a real web URL — never a javascript:/file:/data: target
        // smuggled through the `u=` parameter.
        .filter(|target| {
            Url::parse(target)
                .map(|u| matches!(u.scheme(), "http" | "https"))
                .unwrap_or(false)
        })
}

/// OAuth/login URLs that must stay *inside* the app, so Facebook's "continue
/// with Google/Apple/Microsoft" social logins work as an in-app popup instead of
/// bouncing to the browser. Restricted to the dedicated auth hosts (which serve
/// nothing but auth) — matching on OAuth *paths* across arbitrary hosts is both
/// unnecessary (Facebook doesn't offer those providers) and error-prone.
fn is_auth_url(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    const AUTH_HOSTS: &[&str] = &["login.microsoftonline.com", "appleid.apple.com"];
    if AUTH_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
    {
        return true;
    }
    // Google federates "Sign in with Google" across many of its own domains in a
    // single flow: the sign-in/consent UI on accounts.google.com (and country
    // domains like accounts.google.no), plus a session-cookie sync
    // ("CheckConnection"/"SetSID"/"SetOSID") that bounces through
    // accounts.youtube.com, myaccount.google.com, … — always under an
    // `/accounts/` path. Keep these in-app so none spawn a default-browser
    // window, while ordinary Google/YouTube content still opens externally.
    is_google_owned_host(&host)
        && (host.starts_with("accounts.") || url.path().starts_with("/accounts/"))
}

/// A host whose registrable domain is Google's: `youtube.com` or `google.<tld>`
/// for a plausible country/gTLD (each label 2–3 ASCII letters, e.g. `com`, `no`,
/// `co.uk`). The boundary + TLD checks reject lookalikes like
/// `accounts.google.evil.com`.
fn is_google_owned_host(host: &str) -> bool {
    if host == "youtube.com" || host.ends_with(".youtube.com") {
        return true;
    }
    let is_tld = |tld: &str| {
        !tld.is_empty()
            && tld.len() <= 6
            && tld
                .split('.')
                .all(|p| (2..=3).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphabetic()))
    };
    host.match_indices("google.").any(|(i, _)| {
        // Must start a label: at the host start or right after a dot.
        (i == 0 || host.as_bytes()[i - 1] == b'.') && is_tld(&host[i + "google.".len()..])
    })
}

/// Domains kept *inside* the app (Messenger plus the Facebook/Meta auth and
/// media surfaces needed to log in and load content).
fn is_internal(url: &Url) -> bool {
    if is_local_app_url(url) {
        return true;
    }
    match url.scheme() {
        "about" => return true,
        // Resolve a blob: URL to its inner origin and judge that.
        "blob" => {
            return url
                .as_str()
                .strip_prefix("blob:")
                .and_then(|inner| Url::parse(inner).ok())
                .is_some_and(|inner| is_internal(&inner));
        }
        // data: / javascript: (and anything else) are never "internal".
        "http" | "https" => {}
        _ => return false,
    }
    if is_auth_url(url) {
        return true;
    }
    // Reject hostless HTTP(S) rather than treating it as internal.
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.strip_prefix("www.").unwrap_or(host);
    const INTERNAL_SUFFIXES: &[&str] = &[
        "facebook.com",
        "messenger.com",
        "fbcdn.net",
        "fbsbx.com",
        "meta.com",
        "oculus.com",
    ];
    INTERNAL_SUFFIXES
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

fn is_local_app_url(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    )
}

// ---------------------------------------------------------------------------
// Messenger connectivity preflight
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct MessengerLoadStatus {
    state: String,
    title: String,
    message: String,
    detail: Option<String>,
}

impl MessengerLoadStatus {
    fn new(state: &str, title: &str, message: &str, detail: Option<String>) -> Self {
        Self {
            state: state.into(),
            title: title.into(),
            message: message.into(),
            detail,
        }
    }

    fn loading() -> Self {
        Self::new(
            "loading",
            "Loading Messenger",
            "Messenger is reachable. Carrier is opening it now.",
            None,
        )
    }

    fn unexpected(title: &str, detail: String) -> Self {
        Self::new(
            "error",
            title,
            "Carrier could not finish the Messenger reachability check.",
            Some(detail),
        )
    }
}

#[derive(Debug)]
enum MessengerPreflightError {
    Blocked {
        host: &'static str,
        ips: Vec<IpAddr>,
    },
    DnsFailed {
        host: &'static str,
        error: String,
    },
}

impl From<MessengerPreflightError> for MessengerLoadStatus {
    fn from(error: MessengerPreflightError) -> Self {
        match error {
            MessengerPreflightError::Blocked { host, ips } => Self::new(
                "blocked",
                "Messenger appears blocked",
                "Carrier cannot load Messenger because Facebook is resolving to a local blocking address. This commonly happens when a productivity blocker, DNS filter, or hosts-file rule is active.",
                Some(format!("{host} -> {}", format_ips(&ips))),
            ),
            MessengerPreflightError::DnsFailed { host, error } => Self::new(
                "unreachable",
                "Cannot resolve Messenger",
                "Carrier could not resolve Facebook's Messenger host. Check your internet connection, DNS settings, VPN, or firewall.",
                Some(format!("{host}: {error}")),
            ),
        }
    }
}

fn is_blocker_sinkhole_ip(ip: IpAddr) -> bool {
    ip.is_unspecified() || ip.is_loopback()
}

fn unique_ips(addrs: &[SocketAddr]) -> Vec<IpAddr> {
    let mut ips = Vec::new();
    for addr in addrs {
        let ip = addr.ip();
        if !ips.contains(&ip) {
            ips.push(ip);
        }
    }
    ips
}

fn format_ips(ips: &[IpAddr]) -> String {
    if ips.is_empty() {
        "no addresses".into()
    } else {
        ips.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn classify_messenger_resolution(addrs: &[SocketAddr]) -> Option<MessengerPreflightError> {
    let ips = unique_ips(addrs);
    if ips.is_empty() {
        return Some(MessengerPreflightError::DnsFailed {
            host: HOME_HOST,
            error: "no addresses returned".into(),
        });
    }
    if ips.iter().all(|ip| is_blocker_sinkhole_ip(*ip)) {
        return Some(MessengerPreflightError::Blocked {
            host: HOME_HOST,
            ips,
        });
    }
    None
}

fn messenger_dns_preflight() -> Result<(), MessengerPreflightError> {
    let addrs = (HOME_HOST, HOME_PORT)
        .to_socket_addrs()
        .map(|iter| iter.collect::<Vec<_>>())
        .map_err(|e| MessengerPreflightError::DnsFailed {
            host: HOME_HOST,
            error: e.to_string(),
        })?;

    if let Some(error) = classify_messenger_resolution(&addrs) {
        return Err(error);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/// Only the commands that fetch a URL (copy/download image & video) are exposed
/// to the remote page, so restrict them to Facebook/Messenger media hosts over
/// HTTPS. This is a strict allowlist — far stronger than IP filtering, since an
/// attacker can't point `fbcdn.net` at a private/loopback address via DNS
/// rebinding to reach the local network (SSRF).
fn is_fetchable_media_host(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.strip_prefix("www.").unwrap_or(host);
    const HOSTS: &[&str] = &["fbcdn.net", "fbsbx.com", "facebook.com", "messenger.com"];
    HOSTS
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

fn downloads_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var_os("HOME").map(std::path::PathBuf::from);
    base.map(|b| b.join("Downloads"))
}

/// Minimal percent-decoder for filenames.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Strip path separators and shell-unsafe characters so a page-supplied name
/// can't escape the Downloads folder; falls back to "download".
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(
                c,
                '/' | '\\' | '\0' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
            ) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.');
    if cleaned.is_empty() {
        "download".into()
    } else {
        cleaned.to_string()
    }
}

/// Best-effort filename from a URL: last path segment, percent-decoded, query
/// stripped. Keeps the URL's own extension (so a video isn't saved as `.png`).
fn filename_from_url(url: &Url) -> String {
    let raw = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .filter(|s| !s.is_empty())
        .unwrap_or("download");
    sanitize_filename(&percent_decode(raw))
}

fn is_media_filename(name: &str) -> bool {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "jpg"
            | "jpeg"
            | "png"
            | "gif"
            | "webp"
            | "heic"
            | "heif"
            | "bmp"
            | "tif"
            | "tiff"
            | "mp4"
            | "m4v"
            | "mov"
            | "webm"
            | "avi"
            | "mkv"
            | "3gp"
            | "mp3"
            | "m4a"
            | "aac"
            | "wav"
            | "ogg"
            | "opus"
            | "flac"
    )
}

fn is_media_data_url(url: &Url) -> bool {
    let Some(rest) = url.as_str().strip_prefix("data:") else {
        return false;
    };
    let header = rest.split_once(',').map(|(h, _)| h).unwrap_or(rest);
    let media_type = header.split_once(';').map(|(m, _)| m).unwrap_or(header);
    let media_type = media_type.to_ascii_lowercase();
    media_type.starts_with("image/")
        || media_type.starts_with("video/")
        || media_type.starts_with("audio/")
}

fn is_allowed_download(url: &Url, name: &str) -> bool {
    match url.scheme() {
        "blob" => is_media_filename(name),
        "data" => is_media_data_url(url) && is_media_filename(name),
        _ => is_fetchable_media_host(url) && is_media_filename(name),
    }
}

/// True for filenames whose extension is a directly-executable type, so a remote
/// page can't quietly drop malware in Downloads. Media, documents and archives
/// (the things you'd actually save from Messenger) are all allowed.
fn is_unsafe_download(name: &str) -> bool {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        "exe"
            | "msi"
            | "bat"
            | "cmd"
            | "com"
            | "scr"
            | "ps1"
            | "vbs"
            | "vbe"
            | "js"
            | "jse"
            | "wsf"
            | "wsh"
            | "hta"
            | "dmg"
            | "pkg"
            | "app"
            | "command"
            | "scpt"
            | "sh"
            | "bash"
            | "zsh"
            | "run"
            | "bin"
            | "jar"
            | "jnlp"
            | "deb"
            | "rpm"
            | "appimage"
    )
}

/// Avoid clobbering an existing file by appending " (n)".
fn unique_path(p: std::path::PathBuf) -> std::path::PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download")
        .to_string();
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let parent = p.parent().map(|x| x.to_path_buf()).unwrap_or_default();
    for n in 1..10000 {
        let cand = parent.join(format!("{stem} ({n}){ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    p
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
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
fn set_settings(
    app: tauri::AppHandle,
    state: State<AppState>,
    new: Settings,
) -> Result<Settings, String> {
    store_settings(&app, &state, new)
}

/// Reset all settings to their defaults.
#[tauri::command]
fn reset_settings(app: tauri::AppHandle, state: State<AppState>) -> Result<Settings, String> {
    store_settings(&app, &state, Settings::default())
}

/// Check GitHub releases for an update; download & install if found.
async fn run_update_check(app: &tauri::AppHandle) -> Result<String, String> {
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
async fn check_for_updates(app: tauri::AppHandle) -> Result<String, String> {
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
async fn connect_messenger(window: WebviewWindow) -> MessengerLoadStatus {
    let preflight = tokio::time::timeout(
        MESSENGER_DNS_TIMEOUT,
        tauri::async_runtime::spawn_blocking(messenger_dns_preflight),
    )
    .await;

    match preflight {
        Ok(Ok(Ok(()))) => navigate_to_messenger(&window),
        Ok(Ok(Err(error @ MessengerPreflightError::Blocked { .. }))) => error.into(),
        Ok(Ok(Err(error))) => {
            eprintln!("carrier: Messenger DNS preflight failed ({error:?}); navigating anyway");
            navigate_to_messenger(&window)
        }
        Ok(Err(e)) => {
            eprintln!("carrier: Messenger DNS preflight task failed: {e}; navigating anyway");
            navigate_to_messenger(&window)
        }
        Err(_) => {
            eprintln!("carrier: Messenger DNS preflight timed out; navigating anyway");
            navigate_to_messenger(&window)
        }
    }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/// The window/chrome theme to apply for a given preference: an explicit
/// light/dark, or `None` to follow the system.
fn theme_for(s: &Settings) -> Option<tauri::Theme> {
    match s.theme.as_str() {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    }
}

/// True when the window should render dark (forced dark, or system-dark).
fn is_dark(s: &Settings) -> bool {
    match s.theme.as_str() {
        "dark" => true,
        "light" => false,
        _ => matches!(dark_light::detect(), Ok(dark_light::Mode::Dark)),
    }
}

/// A theme-appropriate window background so there's no white flash before the
/// remote page paints (Facebook glares white in dark mode while loading).
fn splash_background(s: &Settings) -> Color {
    if is_dark(s) {
        Color(24, 25, 26, 255) // Facebook dark
    } else {
        Color(255, 255, 255, 255)
    }
}

/// Build a Carrier window (used for the main window and any extra windows).
fn build_app_window(
    app: &tauri::AppHandle,
    label: &str,
    settings: &Settings,
) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(APP_TITLE)
        .inner_size(1200.0, 780.0)
        .min_inner_size(420.0, 520.0)
        .theme(theme_for(settings))
        .background_color(splash_background(settings))
        .user_agent(user_agent())
        .initialization_script(init_script(settings))
        .on_navigation(|url| {
            // External tracking redirect -> open the real (web-only) destination.
            if let Some(real) = unwrap_tracking(url) {
                if Url::parse(&real).is_ok_and(|r| matches!(r.scheme(), "http" | "https")) {
                    let _ = open::that(real);
                }
                return false;
            }
            if is_internal(url) {
                return true;
            }
            // Open ordinary web links in the browser; block anything else
            // (data:, javascript:, file:, custom schemes).
            if matches!(url.scheme(), "http" | "https") {
                let _ = open::that(url.as_str());
            }
            false
        })
        .on_download(|_webview, event| {
            if let DownloadEvent::Requested { url, destination } = event {
                // Only accept downloads of Messenger's own media or page-generated
                // blob:/data: content; refuse anything else a remote page might try
                // to write to the user's Downloads folder.
                // Prefer the WebView's suggested filename — it carries the real
                // extension (e.g. a blob the page named via `download="photo.png"`);
                // fall back to the URL's last path segment.
                let suggested = destination
                    .file_name()
                    .and_then(|n| n.to_str())
                    .filter(|n| !n.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| filename_from_url(&url));
                let name = sanitize_filename(&suggested);
                if !is_allowed_download(&url, &name) {
                    return false;
                }
                // Don't silently save an executable a page might push to Downloads.
                if is_unsafe_download(&name) {
                    return false;
                }
                // Fail closed: if we can't resolve/create the Downloads folder we
                // can't enforce where the file lands, so refuse rather than let the
                // WebView write to its own chosen destination.
                let Some(dir) = downloads_dir() else {
                    return false;
                };
                if std::fs::create_dir_all(&dir).is_err() {
                    return false;
                }
                *destination = unique_path(dir.join(name));
            }
            true
        })
        .build()
        .inspect(|window| {
            // New windows inherit the current always-on-top preference.
            let _ = window.set_always_on_top(settings.always_on_top);
            // macOS: let the themed window background show through the title bar.
            #[cfg(target_os = "macos")]
            make_webview_transparent(window);
        })
}

/// Disable the WKWebView's opaque white background so the window background —
/// which we keep in step with the theme — shows through the title bar and
/// overscroll areas. Tauri leaves the webview background unimplemented on macOS,
/// so flip the private `drawsBackground` flag ourselves (the same thing wry does
/// for transparent windows).
#[cfg(target_os = "macos")]
fn make_webview_transparent(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        let wk = webview.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        // SAFETY: `wk` is the live WKWebView; -setValue:forKey: with @NO on the
        // private `drawsBackground` key runs on the main thread.
        unsafe {
            let no: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: false];
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![wk, setValue: no, forKey: &*key];
        }
    });
}

/// Set the NSWindow background colour directly — Facebook dark, or white — so the
/// transparent webview shows the right colour in the title bar. Tauri's
/// set_background_color is unreliable on macOS, so we message AppKit ourselves.
/// Must run on the main thread.
#[cfg(target_os = "macos")]
fn set_macos_window_bg(ns_window: *mut std::ffi::c_void, dark: bool) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    if ns_window.is_null() {
        return;
    }
    // SAFETY: `ns_window` is this window's live NSWindow*; NSColor factory
    // methods and -setBackgroundColor: run on the main thread.
    unsafe {
        let ns_window = ns_window as *mut AnyObject;
        let color: *mut AnyObject = if dark {
            // Facebook dark, matching splash_background.
            msg_send![class!(NSColor), colorWithSRGBRed: 24.0f64 / 255.0, green: 25.0f64 / 255.0, blue: 26.0f64 / 255.0, alpha: 1.0f64]
        } else {
            msg_send![class!(NSColor), whiteColor]
        };
        let _: () = msg_send![ns_window, setBackgroundColor: color];
    }
}

/// The last resolved app appearance (true = dark) the observer acted on. Used to
/// drop spurious `effectiveAppearance` KVO notifications that don't actually flip
/// light↔dark — notably the ones our own `set_theme` calls post on *every*
/// settings change while Theme = System (see [`nsapp_effective_is_dark`]).
#[cfg(target_os = "macos")]
static LAST_EFFECTIVE_DARK: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Whether the shared application's current effective appearance resolves to dark
/// — i.e. what macOS is actually rendering right now (while Theme = System this
/// tracks the OS light/dark setting). Read straight from AppKit so it reflects
/// the live state rather than our settings. Must run on the main thread.
#[cfg(target_os = "macos")]
fn nsapp_effective_is_dark() -> bool {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, rc::Retained, sel};
    use objc2_foundation::NSString;

    // SAFETY: -sharedApplication / -effectiveAppearance / -name are main-thread
    // AppKit reads; the only callers (startup setup + the KVO observer) are on it.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let responds: bool = msg_send![app, respondsToSelector: sel!(effectiveAppearance)];
        if !responds {
            return false;
        }
        let appearance: *mut AnyObject = msg_send![app, effectiveAppearance];
        if appearance.is_null() {
            return false;
        }
        // The appearance name is "…DarkAqua" for every dark variant (incl. the
        // high-contrast ones), so a substring test is enough and avoids needing
        // NSArray + bestMatchFromAppearancesWithNames:.
        let name: Retained<NSString> = msg_send![appearance, name];
        name.to_string().contains("Dark")
    }
}

/// The data the appearance observer needs: the handle it rebuilds windows through.
#[cfg(target_os = "macos")]
struct ThemeObserverIvars {
    app: tauri::AppHandle,
}

// `define_class!` matches the conformed protocol as a bare identifier, so bring it
// into scope rather than naming it by path in the macro body.
#[cfg(target_os = "macos")]
use objc2::runtime::NSObjectProtocol;
#[cfg(target_os = "macos")]
use objc2_user_notifications::UNUserNotificationCenterDelegate;

// A KVO observer of `NSApplication`'s `effectiveAppearance`.
//
// macOS only surfaces a *system* light/dark switch through tao's
// `WindowEvent::ThemeChanged`, which rides a coalesced distributed notification a
// background app doesn't receive in time — so Carrier, sitting in the background
// while you flip the OS theme in System Settings, never noticed, and its title bar
// (themed once, at window creation) stayed on the old colour. KVO on
// `effectiveAppearance` fires reliably and on the main thread the instant AppKit
// updates the appearance, background or not. On each change, while following the
// system theme, rebuild the windows — the same refresh a manual theme change does
// (`recreate_themed_windows`). The webview's own CSS re-themes by itself.
#[cfg(target_os = "macos")]
objc2::define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[ivars = ThemeObserverIvars]
    struct ThemeObserver;

    impl ThemeObserver {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe_appearance_change(
            &self,
            _key_path: Option<&objc2_foundation::NSString>,
            _object: Option<&objc2::runtime::AnyObject>,
            _change: Option<&objc2::runtime::AnyObject>,
            _context: *mut std::ffi::c_void,
        ) {
            use objc2::DefinedClass;
            use std::sync::atomic::Ordering;
            let app = &self.ivars().app;
            // `effectiveAppearance` fires for changes that don't flip light↔dark —
            // in particular our own `set_theme` runs on *every* settings change
            // (apply_settings calls it for each window), and while Theme = System
            // that's `setAppearance:nil`, which re-posts the KVO without changing
            // the resolved appearance. Acting on those reloaded the page on an
            // unrelated toggle (Hide Names, Always on Top, …), so require a flip.
            let now_dark = nsapp_effective_is_dark();
            let was_dark = LAST_EFFECTIVE_DARK.swap(now_dark, Ordering::SeqCst);
            // Only while following the system theme. An explicit light/dark choice
            // also moves NSApp's appearance (we set it ourselves on a manual
            // switch), but is rebuilt by recreate_on_theme_change, not from here;
            // and overlapping rebuilds are dropped by the `recreating` flag, so a
            // burst of changes is safe.
            let is_system = app.state::<AppState>().settings.lock().unwrap().theme == "system";
            if is_system && now_dark != was_dark {
                recreate_themed_windows(app);
            }
        }
    }

    unsafe impl NSObjectProtocol for ThemeObserver {}
);

/// Register a [`ThemeObserver`] on the shared application so live OS light/dark
/// switches refresh the native window chrome while Theme = System. Called once at
/// startup; the observer is leaked (it lives for the whole process) so KVO never
/// messages a freed object, and it keeps working across the rebuilds it triggers.
#[cfg(target_os = "macos")]
fn observe_system_theme_changes(app: &tauri::AppHandle) {
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject, AllocAnyThread};
    use objc2_foundation::ns_string;

    // Seed the baseline so the observer only fires on a genuine flip away from the
    // appearance shown right now — not on the first spurious self-inflicted KVO.
    LAST_EFFECTIVE_DARK.store(
        nsapp_effective_is_dark(),
        std::sync::atomic::Ordering::SeqCst,
    );

    let observer = ThemeObserver::alloc().set_ivars(ThemeObserverIvars { app: app.clone() });
    let observer: Retained<ThemeObserver> = unsafe { msg_send![super(observer), init] };

    // SAFETY: standard KVO registration on the shared NSApplication. The key path
    // exists on NSApplication; we request no change values and pass a null context.
    // KVO does not retain observers, so the observer is kept alive for the process
    // lifetime via `mem::forget` below.
    unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![
            ns_app,
            addObserver: &*observer,
            forKeyPath: ns_string!("effectiveAppearance"),
            options: 0usize,
            context: std::ptr::null_mut::<std::ffi::c_void>(),
        ];
    }
    std::mem::forget(observer);
}

/// On macOS the window/title-bar theme is fixed at creation, so a live theme
/// change needs a full window rebuild; other platforms re-theme the chrome live
/// in `apply_settings`, so this is a no-op there (rebuilding would needlessly
/// reload Messenger and drop in-progress UI state).
#[cfg(target_os = "macos")]
fn recreate_on_theme_change(app: &tauri::AppHandle, prev: &str, next: &str) {
    if prev != next {
        recreate_themed_windows(app);
    }
}

#[cfg(not(target_os = "macos"))]
fn recreate_on_theme_change(_app: &tauri::AppHandle, _prev: &str, _next: &str) {}

/// Install the `main` window's close behaviour: hide to the tray when
/// `hide_on_close` is set and a tray exists, otherwise quit. Reinstalled on every
/// `main` window the app creates (startup and after a themed rebuild) so the
/// behaviour survives `recreate_themed_windows`.
fn install_main_close_handler(app: &tauri::AppHandle, window: &WebviewWindow) {
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let (hide, has_tray) = {
                let state = handle.state::<AppState>();
                let hide = state.settings.lock().unwrap().hide_on_close;
                let has_tray = state.tray.lock().unwrap().is_some();
                (hide, has_tray)
            };
            // Only hide to the tray if one was actually created (tray creation can
            // fail, e.g. on a Linux session without an AppIndicator); otherwise
            // closing the main window quits the app (don't let an open Settings
            // dialog keep it running).
            if hide && has_tray {
                api.prevent_close();
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.hide();
                }
            } else {
                handle.exit(0);
            }
        }
    });
}

/// The data the notification-centre delegate needs: the handle it routes a
/// notification click back through.
#[cfg(target_os = "macos")]
struct NotifyDelegateIvars {
    app: tauri::AppHandle,
}

// The `UNUserNotificationCenter` delegate. It does two jobs:
//
// - `willPresentNotification` returns `Banner | Sound | List` so a new-message
//   notification is shown even while Carrier is frontmost/focused (without a
//   delegate, macOS suppresses banners for the active app — a required product
//   behaviour here).
// - `didReceiveNotificationResponse` recovers the conversation id from the
//   notification's `userInfo` and routes a click back to the page via
//   `on_notification_click`.
//
// Set once at startup and retained for the process lifetime (the centre's
// `setDelegate:` does not retain) — see `setup_macos_notifications`.
#[cfg(target_os = "macos")]
objc2::define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[ivars = NotifyDelegateIvars]
    struct NotifyDelegate;

    impl NotifyDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &objc2_user_notifications::UNUserNotificationCenter,
            _notification: &objc2_user_notifications::UNNotification,
            completion_handler: &block2::DynBlock<
                dyn Fn(objc2_user_notifications::UNNotificationPresentationOptions),
            >,
        ) {
            use objc2_user_notifications::UNNotificationPresentationOptions as Opts;
            // Show even when Carrier is the active app (Banner), play the sound,
            // and keep it in Notification Centre (List).
            completion_handler.call((Opts::Banner | Opts::Sound | Opts::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &objc2_user_notifications::UNUserNotificationCenter,
            response: &objc2_user_notifications::UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            use objc2::DefinedClass;
            use objc2_foundation::{NSNumber, NSString};
            let user_info = response.notification().request().content().userInfo();
            let key = NSString::from_str("id");
            if let Some(value) = user_info.objectForKey(&key) {
                if let Ok(num) = value.downcast::<NSNumber>() {
                    on_notification_click(self.ivars().app.clone(), num.unsignedLongLongValue());
                }
            }
            // The API requires the completion block be called when we're done.
            completion_handler.call(());
        }
    }

    unsafe impl NSObjectProtocol for NotifyDelegate {}
    unsafe impl UNUserNotificationCenterDelegate for NotifyDelegate {}
);

/// Set up macOS notifications once the app is ready: request authorization
/// (including the **badge** option) and install the centre's delegate.
///
/// Authorization — since macOS 12 (Monterey), `[[NSApp dockTile] setBadgeLabel:]`
/// (what Tauri's `set_badge_count` calls) is silently ignored unless the app has
/// requested `UNUserNotificationCenter` authorization with the badge option, and
/// macOS won't present banners (or register the app under System Settings →
/// Notifications) without an Alert grant (issue #5). The grant is persisted by
/// the OS, so later launches resolve without a prompt.
///
/// Delegate — installs [`NotifyDelegate`] so notifications present while Carrier
/// is frontmost and clicks route back to the page. `setDelegate:` does not
/// retain, so the delegate is leaked (it lives for the whole process); a static
/// `OnceLock` can't hold it because `Retained<…>` is neither `Send` nor `Sync`,
/// and this mirrors the `ThemeObserver` precedent.
///
/// Must run on the main thread, once the app has finished launching — calling it
/// from `setup` is a silent no-op — so it's invoked from the `RunEvent::Ready`
/// handler. Safe to call unconditionally.
#[cfg(target_os = "macos")]
fn setup_macos_notifications(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{msg_send, AllocAnyThread};
    use objc2_foundation::NSError;
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};

    let center = UNUserNotificationCenter::currentNotificationCenter();

    // Install the delegate before requesting authorization so we never miss an
    // early presentation/click callback.
    let delegate = NotifyDelegate::alloc().set_ivars(NotifyDelegateIvars { app: app.clone() });
    let delegate: Retained<NotifyDelegate> = unsafe { msg_send![super(delegate), init] };
    let proto = ProtocolObject::<dyn UNUserNotificationCenterDelegate>::from_ref(&*delegate);
    center.setDelegate(Some(proto));
    // Keep the delegate alive for the process: `setDelegate:` does not retain.
    std::mem::forget(delegate);

    let options = UNAuthorizationOptions::Badge
        | UNAuthorizationOptions::Alert
        | UNAuthorizationOptions::Sound;
    // The completion handler is required by the API; the OS persists the grant,
    // so there's nothing to do with the result. The framework copies the block,
    // so letting our `RcBlock` drop when this returns is fine.
    let handler = RcBlock::new(|_granted: Bool, _error: *mut NSError| {});
    center.requestAuthorizationWithOptions_completionHandler(options, &handler);
}

/// Rebuild every Messenger window (not the Settings dialog) with the current
/// settings. The macOS title bar's theme is fixed at window creation — no
/// runtime call repaints it — so a live theme switch is reflected by recreating
/// the window. Each rebuilt window keeps its place and size; the page reloads
/// (the login session is preserved by the persisted cookies). Runs off the
/// event-loop handler and destroys before rebuilding so the label is free.
#[cfg(target_os = "macos")]
fn recreate_themed_windows(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    // Claim the "recreating" flag synchronously: if a rebuild is already in
    // flight, skip this one. Setting it inside the spawned task would let two
    // rapid theme switches overlap, and the second could clear the flag mid-way
    // through the first's zero-window window — letting the app exit.
    if app
        .state::<AppState>()
        .recreating
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Snapshot label + geometry, then destroy (not close — close would just
        // hide it), so we can rebuild each window where it was.
        let targets: Vec<(String, _)> = app
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| label != "settings")
            .map(|(label, window)| {
                let geometry = window.outer_position().ok().zip(window.inner_size().ok());
                let _ = window.destroy();
                (label, geometry)
            })
            .collect();
        if !targets.is_empty() {
            // Let the event loop finish destroying so the labels are free again.
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            // Read settings after the wait so a theme change during it is honoured.
            let settings = app.state::<AppState>().settings.lock().unwrap().clone();
            for (label, geometry) in targets {
                if let Ok(window) = build_app_window(&app, &label, &settings) {
                    // The rebuilt main window must re-acquire the close-to-tray
                    // handler startup installed on the original.
                    if label == "main" {
                        install_main_close_handler(&app, &window);
                    }
                    if let Some((pos, size)) = geometry {
                        let _ = window.set_position(tauri::Position::Physical(pos));
                        let _ = window.set_size(tauri::Size::Physical(size));
                    }
                }
            }
        }
        app.state::<AppState>()
            .recreating
            .store(false, Ordering::SeqCst);
    });
}

/// Open (or focus) the dedicated settings window (a small local page, separate
/// from the Messenger view).
fn show_settings_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    // Match the Messenger windows' topmost state so the dialog isn't trapped
    // behind them when Always on Top is enabled.
    let (aot, theme) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        (s.always_on_top, theme_for(&s))
    };
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title(format!("{APP_TITLE} Settings"))
        .inner_size(460.0, 620.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(aot)
        .theme(theme)
        .build();
}

// ---------------------------------------------------------------------------
// Native menu
// ---------------------------------------------------------------------------

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let mi = |id: &str, label: &str, accel: Option<&str>| -> tauri::Result<MenuItem<tauri::Wry>> {
        let mut b = MenuItemBuilder::new(label).id(id);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let prefs = mi("preferences", "Settings…", Some("CmdOrCtrl+,"))?;
    let app_menu = SubmenuBuilder::new(app, APP_TITLE)
        .about(Some(AboutMetadata::default()))
        .separator()
        .item(&prefs)
        .separator()
        .hide()
        .separator()
        .quit()
        .build()?;

    let new_conversation = mi(
        "new_conversation",
        "New Conversation",
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let new_window = mi("new_window", "New Window", Some("CmdOrCtrl+N"))?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_conversation)
        .item(&new_window)
        .separator()
        .close_window()
        .build()?;

    let paste_match = mi(
        "paste_match_style",
        "Paste and Match Style",
        Some("CmdOrCtrl+Shift+Alt+V"),
    )?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(&paste_match)
        .select_all()
        .build()?;

    let reload = mi("reload", "Reload", Some("CmdOrCtrl+R"))?;
    let clear_cache = mi(
        "clear_cache",
        "Clear Cache && Restart",
        Some("CmdOrCtrl+Shift+Backspace"),
    )?;
    let zreset = mi("zoom_reset", "Actual Size", Some("CmdOrCtrl+0"))?;
    let zin = mi("zoom_in", "Zoom In", Some("CmdOrCtrl+="))?;
    let zout = mi("zoom_out", "Zoom Out", Some("CmdOrCtrl+-"))?;
    let theme_sys = mi("theme_system", "System", None)?;
    let theme_light = mi("theme_light", "Light", None)?;
    let theme_dark = mi("theme_dark", "Dark", None)?;
    let theme_menu = SubmenuBuilder::new(app, "Theme")
        .item(&theme_sys)
        .item(&theme_light)
        .item(&theme_dark)
        .build()?;
    let toggle_info = mi(
        "toggle_info",
        "Toggle Conversation Information",
        Some("CmdOrCtrl+Shift+I"),
    )?;
    // Shift+N belongs to New Conversation, so "hide" gets Shift+H.
    let hide_names = mi(
        "hide_names",
        "Hide Names && Avatars",
        Some("CmdOrCtrl+Shift+H"),
    )?;
    let aot = mi("always_on_top", "Toggle Always on Top", None)?;
    let devtools = mi(
        "devtools",
        "Toggle Developer Tools",
        Some("CmdOrCtrl+Alt+I"),
    )?;
    let view = {
        let b = SubmenuBuilder::new(app, "View")
            .item(&reload)
            .item(&clear_cache)
            .separator()
            .item(&zreset)
            .item(&zin)
            .item(&zout)
            .separator()
            .item(&theme_menu)
            .item(&toggle_info)
            .item(&hide_names)
            .item(&aot);
        #[cfg(debug_assertions)]
        let b = b.separator().item(&devtools);
        let _ = &devtools;
        b.build()?
    };

    let maximize = mi("maximize", "Zoom", None)?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&maximize)
        .separator()
        .close_window()
        .build()?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

/// The focused Messenger window (a `main`/`win-*` window), falling back to
/// `main`. Used so menu actions affect the window the user is actually looking
/// at rather than always `main`. The local settings window is excluded.
fn target_window(app: &tauri::AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .find(|(label, w)| label.as_str() != "settings" && w.is_focused().unwrap_or(false))
        .map(|(_, w)| w)
        .or_else(|| app.get_webview_window("main"))
}

/// Apply a settings change made from the native menu: mutate, persist, re-apply.
/// (Used for view-style toggles — not autostart, which syncs separately.)
fn mutate_settings(app: &tauri::AppHandle, f: impl FnOnce(&mut Settings)) {
    let state = app.state::<AppState>();
    // Mutate in place under the lock so concurrent callers can't read-modify-write
    // a stale clone and lose each other's changes. Persist/apply after releasing
    // it (apply_settings touches windows and must not run while holding the lock).
    let (prev_theme, s) = {
        let mut settings = state.settings.lock().unwrap();
        let prev_theme = settings.theme.clone();
        f(&mut settings);
        (prev_theme, settings.clone())
    };
    if let Err(e) = save_settings(app, &s) {
        eprintln!("carrier: failed to save settings: {e}");
    }
    apply_settings(app, &s);
    // macOS needs a window rebuild to re-theme the title bar; other platforms
    // already re-themed the chrome live in apply_settings.
    recreate_on_theme_change(app, &prev_theme, &s.theme);
}

fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let eval = |js: &str| {
        if let Some(w) = target_window(app) {
            let _ = w.eval(js);
        }
    };
    match event.id().as_ref() {
        "preferences" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { show_settings_window(&app) });
        }
        "reload" => eval("location.reload()"),
        "zoom_in" => eval("window.__carrierZoomIn && window.__carrierZoomIn()"),
        "zoom_out" => eval("window.__carrierZoomOut && window.__carrierZoomOut()"),
        "zoom_reset" => eval("window.__carrierZoomReset && window.__carrierZoomReset()"),
        "paste_match_style" => eval(
            "navigator.clipboard && navigator.clipboard.readText().then(function (t) { \
             document.execCommand('insertText', false, t); })",
        ),
        "theme_system" => mutate_settings(app, |s| s.theme = "system".into()),
        "theme_light" => mutate_settings(app, |s| s.theme = "light".into()),
        "theme_dark" => mutate_settings(app, |s| s.theme = "dark".into()),
        "new_conversation" => {
            eval("window.__carrierShortcuts && window.__carrierShortcuts.newConversation()")
        }
        "toggle_info" => eval("window.__carrierToggleInfo && window.__carrierToggleInfo()"),
        // Dock/tray "recent conversations" items ("recent:<thread-id>"). Handled
        // here (the app-wide menu handler) only — the tray's own handler must
        // not repeat this, since every menu event is broadcast to all handlers.
        id if id.starts_with("recent:") => {
            if let Some(href) = recent_href_from_menu_id(id) {
                open_recent_thread(app, &href);
            }
        }
        "hide_names" => mutate_settings(app, |s| s.hide_names_avatars = !s.hide_names_avatars),
        "maximize" => {
            if let Some(w) = target_window(app) {
                if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
        }
        "new_window" => {
            // Off the event-loop handler to avoid the Windows window-creation
            // deadlock.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let s = app.state::<AppState>().settings.lock().unwrap().clone();
                let n = app
                    .state::<AppState>()
                    .next_window
                    .fetch_add(1, Ordering::SeqCst);
                let _ = build_app_window(&app, &format!("win-{n}"), &s);
            });
        }
        "clear_cache" => match schedule_webview_data_clear(app) {
            Ok(()) => app.restart(),
            Err(e) => eprintln!("carrier: failed to schedule cache clear: {e}"),
        },
        "always_on_top" => mutate_settings(app, |s| s.always_on_top = !s.always_on_top),
        "devtools" =>
        {
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

fn init_script(settings: &Settings) -> String {
    let css_literal = serde_json::to_string(INJECT_CSS).expect("CSS serialises");
    let settings_literal = serde_json::to_string(settings).expect("settings serialise");
    format!(
        r#"(function () {{
  var carrierHost = String(location.hostname || '').toLowerCase().replace(/^www\./, '');
  var carrierInjectable =
    carrierHost === 'facebook.com' ||
    carrierHost.endsWith('.facebook.com') ||
    carrierHost === 'messenger.com' ||
    carrierHost.endsWith('.messenger.com');
  if (!carrierInjectable) return;

  // Prefer settings cached in localStorage (written by apply_settings on every
  // change) over this baked-in snapshot, so an in-session settings change
  // survives Facebook reloading the page (which re-runs this script). Falls back
  // to the snapshot on first load / if storage was cleared.
  var baked = {settings_literal};
  try {{
    // Merge the cache onto the baked defaults (rather than replacing) so a stale
    // or partial cached object can't drop fields the current build expects, and
    // sanitise enum-like settings.
    var stored = JSON.parse(localStorage.getItem('__carrier_settings') || 'null');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {{
      var merged = Object.assign({{}}, baked, stored);
      if (merged.badge_mode !== 'messages' && merged.badge_mode !== 'conversations') {{
        merged.badge_mode = baked.badge_mode;
      }}
      var mz = Math.round(Number(merged.zoom));
      merged.zoom = isFinite(mz) ? Math.min({ZOOM_MAX}, Math.max({ZOOM_MIN}, mz)) : baked.zoom;
      window.__CARRIER_SETTINGS__ = merged;
    }} else {{
      window.__CARRIER_SETTINGS__ = baked;
    }}
  }} catch (e) {{
    window.__CARRIER_SETTINGS__ = baked;
  }}
  var css = {css_literal};
  function inject() {{
    if (!document.head) return false;
    if (document.head.querySelector('style[data-carrier]')) return true;
    var s = document.createElement('style');
    s.setAttribute('data-carrier', '');
    s.textContent = css;
    document.head.appendChild(s);
    return true;
  }}
  if (!inject()) {{
    new MutationObserver(function (_, obs) {{ if (inject()) obs.disconnect(); }})
      .observe(document.documentElement, {{ childList: true, subtree: true }});
  }}
{INJECT_JS}
{INJECT_PANEL}
{INJECT_MCP_BRIDGE}
}})();"#
    )
}

// ---------------------------------------------------------------------------
// New-message notifications
// ---------------------------------------------------------------------------

/// A new-message notification request from the page (the `carrier:notify` event).
/// Facebook hands its in-page `Notification` the sender (`title`), the message
/// preview (`body`), and the sender's avatar URL; the injected bridge forwards
/// them here, rendering the avatar to a PNG data URL (`icon`, best-effort) so the
/// native side never has to re-fetch it. `id` is the page's handle for this
/// notification — echoed back on click so the page can open the conversation.
#[derive(Debug, Default, Deserialize)]
struct NotifyMsg {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    icon: String,
}

/// Unique-name counter for avatar temp files (see [`avatar_to_temp_png`]).
static AVATAR_SEQ: AtomicUsize = AtomicUsize::new(0);
static AVATAR_CACHE_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Decode the avatar the page sent as a PNG data URL into a temp file the native
/// notification can point at. Returns `None` (→ a text-only notification) on any
/// problem; the avatar is strictly best-effort.
fn avatar_to_temp_png(data_url: &str) -> Option<PathBuf> {
    // `carrier:notify` crosses from the remote page, so validate the shape
    // before decoding or writing. Our injected bridge always builds the avatar
    // with `canvas.toDataURL("image/png")`, so require exactly a base64 PNG data
    // URL rather than trusting an arbitrary `image/*` type from the page.
    let b64 = data_url.strip_prefix("data:image/png;base64,")?.trim();
    // A 64×64 PNG is a few KB; cap far below this ceiling but well above any
    // legitimate avatar, and reject before decoding so an oversized payload
    // can't force a large allocation (base64 inflates the byte count by ~4/3).
    const MAX_AVATAR_BYTES: usize = 1 << 20; // 1 MiB decoded
    if b64.len() > MAX_AVATAR_BYTES / 3 * 4 + 4 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    // The decoded bytes are untrusted (remote page) and we name the file `.png`,
    // so confirm they actually begin with the PNG magic header and stay in
    // bounds before writing anything to disk.
    const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() > MAX_AVATAR_BYTES || !bytes.starts_with(PNG_MAGIC) {
        return None;
    }
    // A private per-process directory keeps `multi_instance` runs from colliding
    // on temp-file names or deleting each other's in-flight avatars.
    let dir = avatar_cache_dir()?;
    sweep_stale_avatars(&dir);
    // A unique name per notification avoids any race between writing the file
    // here and the OS reading it when the notification is shown.
    let seq = AVATAR_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("{seq}.png"));
    std::fs::write(&path, &bytes).ok()?;
    Some(path)
}

/// Best-effort sweep of stale avatars from this process's own directory. On
/// macOS a shown notification's file is deliberately left behind for the OS to
/// read asynchronously (see [`show_message_notification`]) and would otherwise
/// accumulate for the whole session; anything this old is long past delivery
/// and safe to drop.
fn sweep_stale_avatars(dir: &Path) {
    const MAX_AVATAR_AGE: Duration = Duration::from_secs(10 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("png") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > MAX_AVATAR_AGE);
        if stale {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// This process's private avatar-cache directory. The random suffix prevents a
/// different local user from pre-creating the path as a symlink before the first
/// notification.
fn avatar_cache_dir() -> Option<PathBuf> {
    AVATAR_CACHE_DIR
        .get_or_init(create_avatar_cache_dir)
        .clone()
}

fn create_avatar_cache_dir() -> Option<PathBuf> {
    let temp_dir = std::env::temp_dir();
    for attempt in 0..16 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u32(std::process::id());
        hasher.write_usize(attempt);
        let dir = temp_dir.join(format!(
            "carrier-avatars-{}-{:016x}",
            std::process::id(),
            hasher.finish()
        ));
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                #[cfg(unix)]
                if std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).is_err() {
                    let _ = std::fs::remove_dir(&dir);
                    return None;
                }
                return Some(dir);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

/// Best-effort cleanup of avatar temp files, so the temp directory doesn't grow
/// without bound. Called once at startup. Sweeps old files from sibling cache
/// directories and removes directories that are then empty, but never follows
/// symlinks or removes a non-empty directory that could belong to a live
/// instance mid-notification.
fn clear_avatar_cache() {
    if let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("carrier-avatars-")
            {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if !file_type.is_dir() {
                    continue;
                }
                let path = entry.path();
                sweep_stale_avatars(&path);
                // `remove_dir` only succeeds on an empty directory, so a live
                // instance's avatars are never deleted out from under it.
                let _ = std::fs::remove_dir(path);
            }
        }
    }
}

/// Parse a `"HH:MM"` wall-clock string into minutes since midnight. Strict:
/// digits only (1–2 hour digits, exactly 2 minute digits, as `<input
/// type="time">` produces), hour 0–23, minute 0–59. Anything else → `None`.
fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    if h.is_empty()
        || h.len() > 2
        || m.len() != 2
        || !h.bytes().all(|b| b.is_ascii_digit())
        || !m.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
    (h <= 23 && m <= 59).then_some(h * 60 + m)
}

/// Whether the do-not-disturb window covers `now_minutes` (minutes since local
/// midnight). The window is half-open `[start, end)` so back-to-back windows
/// can't overlap, and it may wrap past midnight (e.g. `22:00`–`07:00`). The
/// schedule is off — never active — when either bound is empty, malformed, or
/// when start == end (a zero-length window rather than "all day").
fn dnd_active(start: &str, end: &str, now_minutes: u32) -> bool {
    let (Some(s), Some(e)) = (parse_hhmm(start.trim()), parse_hhmm(end.trim())) else {
        return false;
    };
    match s.cmp(&e) {
        std::cmp::Ordering::Equal => false,
        std::cmp::Ordering::Less => now_minutes >= s && now_minutes < e,
        // Overnight wrap: active from `start` to midnight and midnight to `end`.
        std::cmp::Ordering::Greater => now_minutes >= s || now_minutes < e,
    }
}

/// Minutes since local midnight, for [`dnd_active`].
fn local_now_minutes() -> u32 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    now.hour() * 60 + now.minute()
}

/// Show a native OS notification for a new message and, if it's clicked, bring
/// Carrier forward and open the conversation. The avatar is attached where the
/// platform allows (a thumbnail on macOS — the app icon always owns the main
/// slot there — and the notification icon on Linux/Windows).
///
/// macOS delivers through `UNUserNotificationCenter`: the request is added
/// non-blocking and clicks arrive later through the
/// [`NotifyDelegate`] (set up at startup), so there's no per-notification
/// thread. Linux/Windows keep the legacy notify-rust path: each notification
/// gets its own thread that blocks until the user clicks or dismisses it (it
/// only parks, doesn't spin), and on click it routes back to the page.
fn show_message_notification(app: tauri::AppHandle, msg: NotifyMsg) {
    let (sound, dnd_start, dnd_end) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        (s.notification_sound, s.dnd_start.clone(), s.dnd_end.clone())
    };
    // Do-not-disturb schedule: drop the notification entirely inside the window.
    // Only delivery is suppressed — the unread badge/tray count still updates
    // (that rides the separate `carrier:unread` event).
    if dnd_active(&dnd_start, &dnd_end, local_now_minutes()) {
        return;
    }

    let title = if msg.title.trim().is_empty() {
        "Messenger".to_string()
    } else {
        msg.title
    };
    let body = msg.body;
    let id = msg.id;
    let image = avatar_to_temp_png(&msg.icon);

    #[cfg(target_os = "macos")]
    {
        // The click comes back through the centre's delegate, which holds its
        // own handle, so `app` isn't needed here. The avatar temp file is read
        // asynchronously by the OS, so leave it for the next startup's
        // `clear_avatar_cache()` rather than racing it with a delete.
        let _ = app;
        deliver_notification_macos(&title, &body, id, image.as_deref(), sound);
    }

    #[cfg(not(target_os = "macos"))]
    std::thread::spawn(move || {
        let clicked = show_native_notification(&title, &body, image.as_deref(), sound);
        // The notification has been shown and dismissed/clicked, so the OS is
        // done with the avatar file — delete it now rather than leaving it for
        // the next startup's clear_avatar_cache().
        if let Some(path) = image.as_deref() {
            let _ = std::fs::remove_file(path);
        }
        if clicked {
            on_notification_click(app, id);
        }
    });
}

/// Deliver a new-message notification through the modern
/// `UNUserNotificationCenter` (macOS). Builds a `UNMutableNotificationContent`
/// (title = sender, body = preview, the default sound when `sound` is on —
/// leaving it unset delivers silently), stashes the conversation
/// `id` in `userInfo` so [`NotifyDelegate`] can recover it on click, attaches
/// the avatar as a `UNNotificationAttachment` when one decoded (best-effort),
/// and adds the request for immediate delivery (`trigger: nil`).
///
/// Replaces the dead legacy `NSUserNotification` path (mac-notification-sys),
/// which macOS 26/27 no longer presents for third-party apps.
#[cfg(target_os = "macos")]
fn deliver_notification_macos(title: &str, body: &str, id: u64, image: Option<&Path>, sound: bool) {
    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotificationAttachment, UNNotificationRequest,
        UNNotificationSound, UNUserNotificationCenter,
    };

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    if sound {
        content.setSound(Some(&UNNotificationSound::defaultSound()));
    }

    // Carry the conversation id so the delegate's click handler can recover it.
    // Built typed (NSString → NSNumber) then cast to the bare `NSDictionary`
    // the `setUserInfo:` signature wants; the generics are just markers.
    let key = NSString::from_str("id");
    let num = NSNumber::numberWithUnsignedLongLong(id);
    let dict = NSDictionary::from_slices(&[&*key], &[&*num]);
    let dict: Retained<NSDictionary> = unsafe { Retained::cast_unchecked(dict) };
    // SAFETY: `dict` is a valid NSDictionary with a string key and number value.
    unsafe { content.setUserInfo(&dict) };

    // Avatar attachment (Caprine-style thumbnail). Best-effort: if the OS
    // rejects the file, send the notification without it.
    if let Some(path) = image.and_then(|p| p.to_str()) {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let ident = NSString::from_str("avatar");
        // SAFETY: no attachment options are passed (`None`), so there's no
        // option-type contract to uphold.
        let attachment = unsafe {
            UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(&ident, &url, None)
        };
        if let Ok(attachment) = attachment {
            content.setAttachments(&NSArray::arrayWithObject(&*attachment));
        }
    }

    // A per-notification identifier; the page's id (stringified) is unique
    // enough and keeps requests from coalescing.
    let request_id = NSString::from_str(&id.to_string());
    // `&content` coerces from the mutable subclass to `&UNNotificationContent`.
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&request_id, &content, None);
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, None);
}

/// See the macOS variant. On Linux/Windows notify-rust's `wait_for_action`
/// blocks until the notification closes; a freedesktop notification needs an
/// explicit `default` action for a body click to be reported (it shows no
/// button), which Windows toasts don't.
#[cfg(not(target_os = "macos"))]
fn show_native_notification(
    title: &str,
    body: &str,
    image: Option<&std::path::Path>,
    sound: bool,
) -> bool {
    let mut n = notify_rust::Notification::new();
    n.summary(title);
    if !body.is_empty() {
        n.body(body);
    }
    if let Some(path) = image.and_then(|p| p.to_str()) {
        n.icon(path);
    }
    // Windows toasts are silent unless a sound is named (notify-rust maps an
    // unset `sound_name` to a silent toast), so name the system default when
    // sound is on; when it's off, leaving `sound_name` unset already delivers
    // silently.
    #[cfg(windows)]
    if sound {
        n.sound_name("Default");
    }
    // XDG servers pick their own default sound, so ask them not to play it.
    #[cfg(unix)]
    if !sound {
        n.hint(notify_rust::Hint::SuppressSound(true));
    }
    #[cfg(unix)]
    n.action("default", "Open");
    let mut clicked = false;
    if let Ok(handle) = n.show() {
        handle.wait_for_action(|action| {
            // notify-rust reports `__closed` for a dismissal; anything else is an
            // activation (the body or our `default`/`Open` action).
            clicked = action != "__closed";
        });
    }
    clicked
}

/// A notification was clicked: surface Carrier's window and ask the page to open
/// the conversation (it invokes Facebook's own `onclick` for that notification,
/// keyed by `id`). Hops to the main thread for the window + webview calls.
fn on_notification_click(app: tauri::AppHandle, id: u64) {
    let _ = app.clone().run_on_main_thread(move || {
        show_main(&app);
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval(format!(
                "window.__carrierNotifyClick && window.__carrierNotifyClick({id});"
            ));
        }
    });
}

pub fn run() {
    #[cfg(target_os = "linux")]
    configure_linux_webkit_renderer();

    let initial = load_settings_early();

    let mut builder = tauri::Builder::default();

    // Dev-only (the `mcp` feature): expose the webview to tauri-plugin-mcp for
    // DOM/JS inspection. Not in the dependency graph for normal/release builds.
    #[cfg(feature = "mcp")]
    {
        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            tauri_plugin_mcp::PluginConfig::new(APP_TITLE.to_string())
                .start_socket_server(true)
                .socket_path("/tmp/tauri-mcp.sock".into()),
        ));
    }

    // Single-instance enforcement (unless the experimental multi-instance flag
    // is set). Must be registered first so it runs before any window is created.
    if !initial.multi_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }));
    }

    builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // The summon shortcut itself is (un)registered in `apply_settings`,
        // following the Global Hotkey setting.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Persist geometry only — NOT visibility, so the app always shows
                // its window on launch (unless Start to Tray) rather than coming
                // back hidden after a previous hide-to-tray.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_denylist(&["settings"]) // fixed-size dialog; don't persist its geometry
                .build(),
        )
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(AppState {
            settings: Mutex::new(initial.clone()),
            tray: Mutex::new(None),
            next_window: AtomicUsize::new(2),
            recreating: std::sync::atomic::AtomicBool::new(false),
            recent_threads: Mutex::new(Vec::new()),
        })
        .menu(build_menu)
        .on_menu_event(handle_menu_event)
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            reset_settings,
            check_for_updates,
            connect_messenger
        ])
        .setup(move |app| {
            clear_pending_webview_data(app.handle());

            let mut settings = load_settings(app.handle());
            *app.state::<AppState>().settings.lock().unwrap() = settings.clone();

            let window = build_app_window(app.handle(), "main", &settings)?;

            // Close button: hide to tray (if enabled) instead of quitting.
            // A themed rebuild reinstalls this on the new main window too.
            install_main_close_handler(app.handle(), &window);

            // Follow live OS light/dark switches while Theme = System (macOS only;
            // other platforms re-theme the chrome on their own). Registered once —
            // the observer is process-wide and survives the window rebuilds.
            #[cfg(target_os = "macos")]
            observe_system_theme_changes(app.handle());

            // Don't sync autostart at startup; the OS registration already
            // reflects the user's last explicit choice.
            reconcile_startup_global_hotkey(app.handle(), &mut settings);
            *app.state::<AppState>().settings.lock().unwrap() = settings.clone();
            apply_settings(app.handle(), &settings);

            // Start hidden only when a tray was actually created to reopen from.
            let has_tray = app.state::<AppState>().tray.lock().unwrap().is_some();
            if settings.start_to_tray && has_tray {
                let _ = window.hide();
            }

            // The Facebook page is a remote origin and can't call Carrier's own
            // commands, so the F3/F2 shortcuts emit events that we handle here.
            let h = app.handle().clone();
            app.listen_any("carrier:open-settings", move |_| {
                let h = h.clone();
                tauri::async_runtime::spawn(async move { show_settings_window(&h) });
            });
            let h = app.handle().clone();
            app.listen_any("carrier:check-updates", move |_| {
                let h = h.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(msg) = run_update_check(&h).await {
                        if msg == "up-to-date" {
                            let _ = h
                                .notification()
                                .builder()
                                .title("Carrier")
                                .body("Carrier is up to date.")
                                .show();
                        }
                    }
                });
            });

            // Unread count from the page → tray tooltip (the Dock badge is set
            // page-side; this keeps the tray useful in menu-bar-only mode).
            let h = app.handle().clone();
            app.listen_any("carrier:unread", move |event| {
                let n: i64 = event.payload().trim().parse().unwrap_or(0);
                let state = h.state::<AppState>();
                let settings = state.settings.lock().unwrap().clone();
                let tray_n = if settings.unread_badge { n } else { 0 };
                let tray = state.tray.lock().unwrap();
                if let Some(tray) = tray.as_ref() {
                    let tip = if tray_n > 0 {
                        format!("{APP_TITLE} — {tray_n} unread")
                    } else {
                        APP_TITLE.to_string()
                    };
                    let _ = tray.set_tooltip(Some(&tip));
                    #[cfg(target_os = "macos")]
                    {
                        let _ = tray.set_title(tray_unread_title(&settings, tray_n));
                    }
                }
            });

            // Keyboard/menu zoom from the page → persist it in settings so the
            // Settings window, other Messenger windows, and the next launch pick
            // it up. The payload comes from the remote-origin page, so treat it
            // as untrusted: parse, clamp, and ignore junk.
            let h = app.handle().clone();
            app.listen_any("carrier:zoom", move |event| {
                let Ok(zoom) = event.payload().trim().parse::<i32>() else {
                    return;
                };
                let zoom = clamp_zoom(zoom);
                let state = h.state::<AppState>();
                let s = {
                    let mut settings = state.settings.lock().unwrap();
                    if settings.zoom == zoom {
                        return;
                    }
                    settings.zoom = zoom;
                    settings.clone()
                };
                if let Err(e) = save_settings(&h, &s) {
                    eprintln!("carrier: failed to save settings: {e}");
                }
                apply_settings(&h, &s);
            });

            // Recent conversations scraped from the page's chat list → the
            // macOS Dock menu / tray menu. Kept in memory only; the menus are
            // rebuilt on the main thread (menu APIs require it on macOS).
            let h = app.handle().clone();
            app.listen_any("carrier:recent-threads", move |event| {
                let Ok(threads) = serde_json::from_str::<Vec<RecentThread>>(event.payload()) else {
                    return;
                };
                let threads = sanitize_recent_threads(threads);
                {
                    let state = h.state::<AppState>();
                    let mut current = state.recent_threads.lock().unwrap();
                    if *current == threads {
                        return;
                    }
                    *current = threads;
                }
                let handle = h.clone();
                let _ = h.run_on_main_thread(move || rebuild_recent_menus(&handle));
            });

            // New-message notifications: the page's `Notification` bridge sends
            // sender/preview/avatar here; we render them natively (with the
            // avatar), notify you while Carrier is in the background, and open the
            // conversation on click. See `show_message_notification`.
            clear_avatar_cache();
            // macOS delivery now goes through UNUserNotificationCenter under the
            // app's own bundle id (set up in `setup_macos_notifications` once the
            // app is ready), so there's no per-process registration to do here.
            let notify_handle = app.handle().clone();
            app.listen_any("carrier:notify", move |event| {
                if let Ok(msg) = serde_json::from_str::<NotifyMsg>(event.payload()) {
                    show_message_notification(notify_handle.clone(), msg);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Carrier")
        .run(|app, event| {
            // macOS needs notification authorization (for banners + the Dock
            // badge) and the centre delegate installed once the app is ready
            // (UNUserNotificationCenter needs the app fully launched — doing it
            // during setup is a silent no-op). See `setup_macos_notifications`
            // and issue #5.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Ready = event {
                setup_macos_notifications(app);
                // The Dock-menu delegate hook also needs the app fully
                // launched (tao installs its NSApplication delegate by now).
                install_dock_menu_provider();
            }

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                reopen_main_if_needed(app, has_visible_windows);
            }

            // A theme switch destroys and rebuilds the windows; don't let the
            // momentary zero-window state quit the app.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app
                    .state::<AppState>()
                    .recreating
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    api.prevent_exit();
                }
            }
        });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn webkit_dmabuf_renderer_is_disabled_only_for_wayland_without_override() {
        assert!(should_disable_webkit_dmabuf_renderer(true, false));
        assert!(!should_disable_webkit_dmabuf_renderer(false, false));
        assert!(!should_disable_webkit_dmabuf_renderer(true, true));
        assert!(!should_disable_webkit_dmabuf_renderer(false, true));
    }

    #[test]
    fn dnd_is_off_when_unset_or_malformed() {
        // Empty = the schedule is disabled.
        assert!(!dnd_active("", "", 0));
        assert!(!dnd_active("22:00", "", 23 * 60));
        assert!(!dnd_active("", "07:00", 3 * 60));
        // Malformed inputs never activate.
        assert!(!dnd_active("24:00", "07:00", 3 * 60));
        assert!(!dnd_active("22:60", "07:00", 3 * 60));
        assert!(!dnd_active("22", "07:00", 3 * 60));
        assert!(!dnd_active("2a:00", "07:00", 3 * 60));
        assert!(!dnd_active("+2:00", "07:00", 3 * 60));
        assert!(!dnd_active("22:0", "07:00", 3 * 60));
        assert!(!dnd_active("garbage", "also garbage", 3 * 60));
        // start == end is a zero-length window, not "all day".
        assert!(!dnd_active("09:00", "09:00", 9 * 60));
    }

    #[test]
    fn dnd_normal_range_is_half_open() {
        let at = |m| dnd_active("09:00", "17:30", m);
        assert!(at(9 * 60)); // start boundary: active
        assert!(at(12 * 60));
        assert!(at(17 * 60 + 29)); // last minute inside
        assert!(!at(17 * 60 + 30)); // end boundary: inactive
        assert!(!at(8 * 60 + 59)); // minute before start
        assert!(!at(23 * 60));
    }

    #[test]
    fn dnd_overnight_range_wraps_midnight() {
        let at = |m| dnd_active("22:00", "07:00", m);
        assert!(at(22 * 60)); // start boundary: active
        assert!(at(23 * 60 + 59)); // just before midnight
        assert!(at(0)); // midnight itself
        assert!(at(6 * 60 + 59)); // last minute inside
        assert!(!at(7 * 60)); // end boundary: inactive
        assert!(!at(12 * 60)); // daytime is outside the window
        assert!(!at(21 * 60 + 59)); // minute before start
    }

    #[test]
    fn hhmm_parses_strict_wall_clock_times() {
        assert_eq!(parse_hhmm("00:00"), Some(0));
        assert_eq!(parse_hhmm("7:05"), Some(7 * 60 + 5)); // single hour digit ok
        assert_eq!(parse_hhmm("23:59"), Some(23 * 60 + 59));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("12:60"), None);
        assert_eq!(parse_hhmm("12:5"), None);
        assert_eq!(parse_hhmm("120:00"), None);
        assert_eq!(parse_hhmm(""), None);
        assert_eq!(parse_hhmm(":30"), None);
        assert_eq!(parse_hhmm("1230"), None);
    }

    #[test]
    fn fetchable_media_host_is_an_https_fb_allowlist() {
        assert!(is_fetchable_media_host(&u(
            "https://scontent.fbcdn.net/v/x.jpg"
        )));
        assert!(is_fetchable_media_host(&u(
            "https://video.xx.fbcdn.net/x.mp4"
        )));
        assert!(is_fetchable_media_host(&u("https://www.facebook.com/x")));
        // wrong scheme, arbitrary hosts, and IPs are all rejected
        assert!(!is_fetchable_media_host(&u(
            "http://scontent.fbcdn.net/x.jpg"
        ))); // not https
        assert!(!is_fetchable_media_host(&u("https://example.com/x.jpg")));
        assert!(!is_fetchable_media_host(&u("https://evil-fbcdn.net/x"))); // suffix trick
        assert!(!is_fetchable_media_host(&u("https://127.0.0.1/x")));
        assert!(!is_fetchable_media_host(&u("https://localhost/x")));
    }

    #[test]
    fn internal_allows_messenger_blocks_dangerous() {
        assert!(is_internal(&u("https://www.facebook.com/messages")));
        assert!(is_internal(&u("https://web.facebook.com/x")));
        assert!(is_internal(&u("https://accounts.google.com/o/oauth2/auth")));
        assert!(is_internal(&u("about:blank")));
        assert!(is_internal(&u("tauri://localhost/")));
        assert!(is_internal(&u("http://tauri.localhost/")));
        assert!(!is_internal(&u("https://example.com/")));
        assert!(!is_internal(&u("tauri://example.com/")));
        assert!(!is_internal(&u("https://not-tauri.localhost/")));
        assert!(!is_internal(&u("foo://tauri.localhost/")));
        assert!(!is_internal(&u("ftp://tauri.localhost/")));
        assert!(!is_internal(&u("data:text/html,<script>1</script>")));
        assert!(!is_internal(&u("javascript:alert(1)")));
    }

    #[test]
    fn blocker_sinkhole_ips_are_detected() {
        assert!(is_blocker_sinkhole_ip(IpAddr::from([0, 0, 0, 0])));
        assert!(is_blocker_sinkhole_ip(IpAddr::from([127, 0, 0, 1])));
        assert!(is_blocker_sinkhole_ip("::".parse().unwrap()));
        assert!(is_blocker_sinkhole_ip("::1".parse().unwrap()));
        assert!(!is_blocker_sinkhole_ip(IpAddr::from([31, 13, 72, 8])));
    }

    #[test]
    fn messenger_resolution_all_sinkholes_is_blocked() {
        let addrs = [
            SocketAddr::from(([0, 0, 0, 0], 443)),
            SocketAddr::from(([127, 0, 0, 1], 443)),
        ];
        assert!(matches!(
            classify_messenger_resolution(&addrs),
            Some(MessengerPreflightError::Blocked { .. })
        ));
    }

    #[test]
    fn messenger_resolution_with_public_ip_is_not_blocked() {
        let addrs = [
            SocketAddr::from(([0, 0, 0, 0], 443)),
            SocketAddr::from(([31, 13, 72, 8], 443)),
        ];
        assert!(classify_messenger_resolution(&addrs).is_none());
    }

    #[test]
    fn auth_is_dedicated_hosts_only() {
        assert!(is_auth_url(&u("https://accounts.google.com/anything")));
        assert!(is_auth_url(&u("https://appleid.apple.com/auth/authorize")));
        assert!(is_auth_url(&u(
            "https://login.microsoftonline.com/common/oauth2"
        )));
        assert!(is_auth_url(&u("https://accounts.google.com/o/oauth2/auth")));
        // Google SSO federates across YouTube, country-coded domains and other
        // Google products mid-flow — sign-in subdomains and /accounts/ cookie sync.
        assert!(is_auth_url(&u(
            "https://accounts.youtube.com/accounts/CheckConnection?pmpo=https%3A%2F%2Faccounts.google.com"
        )));
        assert!(is_auth_url(&u(
            "https://accounts.google.no/accounts/SetSID"
        )));
        assert!(is_auth_url(&u(
            "https://accounts.google.co.uk/ServiceLogin"
        )));
        assert!(is_auth_url(&u(
            "https://myaccount.google.com/accounts/SetOSID"
        )));
        // code hosts and arbitrary /oauth paths are external, not in-app auth
        assert!(!is_auth_url(&u("https://github.com/login/oauth/authorize")));
        assert!(!is_auth_url(&u("https://github.com/user/repo")));
        assert!(!is_auth_url(&u("https://example.com/oauth/authorize")));
        // Ordinary Google/YouTube content stays external: Google-owned but neither
        // an `accounts.` subdomain nor an `/accounts/` cookie-sync path.
        assert!(!is_auth_url(&u("https://www.youtube.com/watch?v=abc")));
        assert!(!is_auth_url(&u("https://www.google.com/search?q=x")));
        assert!(!is_auth_url(&u("https://mail.google.com/mail/u/0")));
        // Lookalike / invalid Google TLDs don't match.
        assert!(!is_auth_url(&u("https://accounts.google.evil.com/SetSID")));
        assert!(!is_auth_url(&u("https://accounts.google.example/SetSID")));
        assert!(!is_auth_url(&u("https://accounts.googleX.com/SetSID")));
    }

    #[test]
    fn sanitize_blocks_traversal_and_windows_drive() {
        let a = sanitize_filename("../../etc/passwd");
        assert!(!a.contains('/') && !a.contains('\\'));
        let b = sanitize_filename("C:evil.exe");
        assert!(!b.contains(':'));
        assert_eq!(sanitize_filename("   "), "download");
        assert_eq!(sanitize_filename("..."), "download");
        assert_eq!(sanitize_filename("photo.png"), "photo.png");
    }

    #[test]
    fn tracking_redirect_is_unwrapped() {
        let url = u("https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fa&h=AT0");
        assert_eq!(
            unwrap_tracking(&url).as_deref(),
            Some("https://example.com/a")
        );
        assert_eq!(
            unwrap_tracking(&u("https://www.facebook.com/messages")),
            None
        );
        // A tracking redirect whose `u=` target is a non-HTTP(S) scheme must not
        // be unwrapped (defense-in-depth against javascript:/file:/data:).
        assert_eq!(
            unwrap_tracking(&u(
                "https://l.facebook.com/l.php?u=javascript%3Aalert%281%29&h=AT0"
            )),
            None
        );
        assert_eq!(
            unwrap_tracking(&u(
                "https://l.facebook.com/l.php?u=file%3A%2F%2F%2Fetc%2Fpasswd"
            )),
            None
        );
    }

    #[test]
    fn filename_keeps_real_extension() {
        assert_eq!(
            filename_from_url(&u("https://x.com/a/video.mp4?dl=1")),
            "video.mp4"
        );
        assert_eq!(filename_from_url(&u("https://x.com/")), "download");
    }

    #[test]
    fn media_filename_accepts_media_extensions_only() {
        assert!(is_media_filename("photo.jpg"));
        assert!(is_media_filename("clip.MP4"));
        assert!(is_media_filename("voice.opus"));
        assert!(!is_media_filename("document.pdf"));
        assert!(!is_media_filename("archive.zip"));
        assert!(!is_media_filename("download"));
    }

    #[test]
    fn media_data_url_requires_media_mime_type() {
        assert!(is_media_data_url(&u("data:image/png;base64,iVBORw0KGgo=")));
        assert!(is_media_data_url(&u("data:video/mp4;base64,AAAA")));
        assert!(!is_media_data_url(&u("data:text/html,<script>1</script>")));
        assert!(!is_media_data_url(&u("data:application/pdf;base64,AAAA")));
    }

    #[test]
    fn allowed_download_requires_media_for_generated_urls() {
        assert!(is_allowed_download(
            &u("blob:https://www.facebook.com/123"),
            "photo.png"
        ));
        assert!(!is_allowed_download(
            &u("blob:https://www.facebook.com/123"),
            "document.pdf"
        ));
        assert!(is_allowed_download(
            &u("data:image/png;base64,iVBORw0KGgo="),
            "photo.png"
        ));
        assert!(!is_allowed_download(
            &u("data:text/html,<script>1</script>"),
            "photo.png"
        ));
        assert!(!is_allowed_download(
            &u("data:image/png;base64,iVBORw0KGgo="),
            "document.pdf"
        ));
    }

    #[test]
    fn allowed_download_requires_media_host_and_name_for_remote_urls() {
        assert!(is_allowed_download(
            &u("https://scontent.fbcdn.net/v/photo.jpg"),
            "photo.jpg"
        ));
        assert!(!is_allowed_download(
            &u("https://scontent.fbcdn.net/v/document.pdf"),
            "document.pdf"
        ));
        assert!(!is_allowed_download(
            &u("https://example.com/photo.jpg"),
            "photo.jpg"
        ));
    }

    #[test]
    fn unique_path_preserves_stem_and_extension() {
        let dir = std::env::temp_dir().join(format!(
            "carrier-unique-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let first = dir.join("Messenger.jpeg");
        let second = dir.join("Messenger (1).jpeg");
        let third = dir.join("Messenger (2).jpeg");
        std::fs::write(&first, b"").unwrap();
        assert_eq!(unique_path(first.clone()), second);
        std::fs::write(&second, b"").unwrap();
        assert_eq!(unique_path(first), third);

        std::fs::remove_dir_all(dir).unwrap();
    }

    // -----------------------------------------------------------------------
    // is_unsafe_download  (new in this PR)
    // -----------------------------------------------------------------------

    #[test]
    fn unsafe_download_blocks_all_listed_executable_extensions() {
        // Every extension in the explicit blocklist must be rejected.
        let blocked = [
            "malware.exe",
            "setup.msi",
            "run.bat",
            "run.cmd",
            "trojan.com",
            "screen.scr",
            "evil.ps1",
            "script.vbs",
            "script.vbe",
            "payload.js",
            "payload.jse",
            "config.wsf",
            "config.wsh",
            "app.hta",
            "installer.dmg",
            "package.pkg",
            "bundle.app",
            "run.command",
            "autorun.scpt",
            "start.sh",
            "start.bash",
            "start.zsh",
            "start.run",
            "payload.bin",
            "library.jar",
            "webstart.jnlp",
            "package.deb",
            "package.rpm",
            "portable.appimage",
        ];
        for name in &blocked {
            assert!(
                is_unsafe_download(name),
                "expected {name} to be blocked as unsafe"
            );
        }
    }

    #[test]
    fn unsafe_download_allows_safe_media_and_document_extensions() {
        // Common file types users legitimately save from Messenger must be allowed.
        let allowed = [
            "photo.jpg",
            "image.jpeg",
            "picture.png",
            "animation.gif",
            "photo.webp",
            "clip.mp4",
            "video.mov",
            "video.avi",
            "audio.mp3",
            "audio.wav",
            "audio.ogg",
            "document.pdf",
            "spreadsheet.xlsx",
            "presentation.pptx",
            "archive.zip",
            "archive.tar",
            "archive.gz",
            "archive.7z",
            "text.txt",
            "data.csv",
            "data.json",
        ];
        for name in &allowed {
            assert!(
                !is_unsafe_download(name),
                "expected {name} to be allowed (safe extension)"
            );
        }
    }

    #[test]
    fn unsafe_download_is_case_insensitive() {
        // Extensions should be compared case-insensitively.
        assert!(is_unsafe_download("VIRUS.EXE"));
        assert!(is_unsafe_download("Script.Ps1"));
        assert!(is_unsafe_download("Payload.SH"));
        assert!(!is_unsafe_download("Photo.PNG"));
        assert!(!is_unsafe_download("Clip.MP4"));
    }

    #[test]
    fn unsafe_download_no_extension_is_safe() {
        // A filename with no extension at all is allowed (not executable by extension).
        assert!(!is_unsafe_download("filenoext"));
        assert!(!is_unsafe_download("download"));
    }

    #[test]
    fn unsafe_download_dotfile_edge_cases() {
        // A dotfile whose name is exactly the "extension" portion — rsplit_once('.') returns
        // ("", "sh") for ".sh", so ".sh" is blocked; ".gitignore" has ext "gitignore" (safe).
        assert!(is_unsafe_download(".sh"));
        assert!(!is_unsafe_download(".gitignore"));
        // Multiple dots: only the last segment is checked.
        assert!(is_unsafe_download("setup.tar.exe"));
        assert!(!is_unsafe_download("setup.exe.zip"));
    }

    // -----------------------------------------------------------------------
    // theme_for / is_dark / splash_background  (new in this PR)
    // -----------------------------------------------------------------------

    fn with_theme(theme: &str) -> Settings {
        Settings {
            theme: theme.into(),
            ..Default::default()
        }
    }

    #[test]
    fn theme_for_dark_returns_dark() {
        assert_eq!(theme_for(&with_theme("dark")), Some(tauri::Theme::Dark));
    }

    #[test]
    fn theme_for_light_returns_light() {
        assert_eq!(theme_for(&with_theme("light")), Some(tauri::Theme::Light));
    }

    #[test]
    fn theme_for_system_returns_none() {
        assert_eq!(theme_for(&with_theme("system")), None);
    }

    #[test]
    fn theme_for_unknown_string_returns_none() {
        assert_eq!(theme_for(&with_theme("auto")), None);
        assert_eq!(theme_for(&with_theme("")), None);
    }

    // "system" calls dark_light::detect() (OS-dependent), so only the
    // explicitly-forced cases are asserted here.
    #[test]
    fn is_dark_forced_dark() {
        assert!(is_dark(&with_theme("dark")));
    }

    #[test]
    fn is_dark_forced_light() {
        assert!(!is_dark(&with_theme("light")));
    }

    #[test]
    fn splash_background_dark_is_facebook_dark_color() {
        // Facebook's dark background colour, as hard-coded in the function.
        assert_eq!(
            splash_background(&with_theme("dark")),
            Color(24, 25, 26, 255)
        );
    }

    #[test]
    fn splash_background_light_is_white() {
        assert_eq!(
            splash_background(&with_theme("light")),
            Color(255, 255, 255, 255)
        );
    }

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

    // -----------------------------------------------------------------------
    // want_tray logic  (new in this PR: show_tray || menu_bar_only)
    // -----------------------------------------------------------------------

    #[test]
    fn wants_tray_true_when_show_tray_set() {
        // show_tray defaults to true.
        assert!(wants_tray(&Settings::default()));
    }

    #[test]
    fn wants_tray_menu_bar_only_forces_it_even_without_show_tray() {
        let s = Settings {
            show_tray: false,
            menu_bar_only: true,
            ..Default::default()
        };
        assert!(wants_tray(&s), "menu_bar_only must force the tray on");
    }

    #[test]
    fn wants_tray_false_when_both_off() {
        let s = Settings {
            show_tray: false,
            menu_bar_only: false,
            ..Default::default()
        };
        assert!(!wants_tray(&s), "no tray when both are off");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_shows_main_when_no_windows_are_visible() {
        assert!(should_reopen_main(false, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_shows_main_when_only_settings_is_visible() {
        assert!(should_reopen_main(true, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dock_reopen_does_not_reload_when_messenger_window_is_visible() {
        assert!(!should_reopen_main(true, true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tray_unread_title_shows_positive_counts_when_badges_enabled() {
        assert_eq!(
            tray_unread_title(&Settings::default(), 7),
            Some("7".to_string())
        );
    }

    fn thread(name: &str, href: &str) -> RecentThread {
        RecentThread {
            name: name.into(),
            href: href.into(),
        }
    }

    #[test]
    fn recent_threads_keep_only_valid_thread_paths() {
        let out = sanitize_recent_threads(vec![
            thread("Alice", "/t/12345/"),
            thread("Mallory", "https://evil.example/t/1/"),
            thread("Mallory", "/t/1'; alert(1);//"),
            thread("Mallory", "/t/12345/../../settings/"),
            thread("Mallory", "/t//"),
            thread("Bob", "/t/67890/"),
        ]);
        assert_eq!(
            out,
            vec![thread("Alice", "/t/12345/"), thread("Bob", "/t/67890/")]
        );
    }

    #[test]
    fn recent_threads_drop_empty_names_and_duplicates_and_cap_the_list() {
        let mut input = vec![
            thread("   ", "/t/1/"),
            thread("Alice", "/t/2/"),
            thread("Alice again", "/t/2/"),
        ];
        for i in 0..20 {
            input.push(thread("More", &format!("/t/{}/", 100 + i)));
        }
        let out = sanitize_recent_threads(input);
        assert_eq!(out.len(), 9);
        assert_eq!(out[0], thread("Alice", "/t/2/"));
        // Duplicate thread id keeps only the first entry.
        assert!(!out.iter().any(|t| t.name == "Alice again"));
    }

    #[test]
    fn recent_threads_truncate_long_names_on_char_boundaries() {
        let name = "ø".repeat(100);
        let out = sanitize_recent_threads(vec![thread(&name, "/t/5/")]);
        assert_eq!(out[0].name.chars().count(), 60);
    }

    #[test]
    fn recent_menu_ids_round_trip_thread_ids() {
        let t = thread("Alice", "/t/12345/");
        assert_eq!(recent_menu_id(&t), "recent:12345");
        assert_eq!(
            recent_href_from_menu_id("recent:12345").as_deref(),
            Some("/t/12345/")
        );
        assert_eq!(recent_href_from_menu_id("recent:"), None);
        assert_eq!(recent_href_from_menu_id("recent:abc"), None);
        assert_eq!(recent_href_from_menu_id("recent:12345/../../"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tray_unread_title_clears_zero_and_disabled_badges() {
        assert_eq!(
            tray_unread_title(&Settings::default(), 0),
            Some(String::new())
        );
        let s = Settings {
            unread_badge: false,
            ..Default::default()
        };
        assert_eq!(tray_unread_title(&s, 7), Some(String::new()));
    }

    // -----------------------------------------------------------------------
    // percent_decode  (used by filename_from_url; boundary cases)
    // -----------------------------------------------------------------------

    #[test]
    fn percent_decode_handles_encoded_chars() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("photo%2Fname.jpg"), "photo/name.jpg");
        assert_eq!(percent_decode("%2F%00"), "/\0");
    }

    #[test]
    fn percent_decode_leaves_plain_text_unchanged() {
        assert_eq!(percent_decode("photo.png"), "photo.png");
        assert_eq!(percent_decode(""), "");
    }

    #[test]
    fn percent_decode_incomplete_sequence_is_kept_literally() {
        // A trailing lone '%' or short sequence must not panic.
        assert_eq!(percent_decode("abc%"), "abc%");
        assert_eq!(percent_decode("abc%2"), "abc%2");
    }

    #[test]
    fn avatar_data_url_is_decoded_to_a_temp_png() {
        // "iVBORw0KGgo=" is base64 for the 8-byte PNG magic header; the helper
        // requires real PNG bytes (it checks the magic header) before writing
        // the file, so we can assert the exact contents round-trip.
        let png_magic: &[u8] = b"\x89PNG\r\n\x1a\n";
        let path = avatar_to_temp_png("data:image/png;base64,iVBORw0KGgo=")
            .expect("a well-formed PNG data URL decodes to a file");
        let written = std::fs::read(&path).expect("temp avatar file exists");
        assert_eq!(written, png_magic);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn notify_msg_parses_the_page_payload() {
        // The shape the injected bridge emits on `carrier:notify`.
        let msg: NotifyMsg = serde_json::from_str(
            r#"{"id":7,"title":"Jane","body":"hi there","icon":"data:image/png;base64,aGk="}"#,
        )
        .expect("payload parses");
        assert_eq!(msg.id, 7);
        assert_eq!(msg.title, "Jane");
        assert_eq!(msg.body, "hi there");
        // Missing fields fall back to defaults rather than failing the parse.
        let bare: NotifyMsg = serde_json::from_str("{}").expect("empty object parses");
        assert_eq!(bare.id, 0);
        assert!(bare.title.is_empty());
    }

    #[test]
    fn avatar_decode_rejects_malformed_input() {
        // Not a data URL at all.
        assert!(avatar_to_temp_png("").is_none());
        assert!(avatar_to_temp_png("https://example.com/a.png").is_none());
        // A data URL, but not an image media type.
        assert!(avatar_to_temp_png("data:text/plain;base64,aGVsbG8=").is_none());
        // Image, but not base64-encoded (no `;base64,` marker).
        assert!(avatar_to_temp_png("data:image/png,aGVsbG8=").is_none());
        // Present but empty payload → nothing to attach.
        assert!(avatar_to_temp_png("data:image/png;base64,").is_none());
        // Garbage that isn't valid base64.
        assert!(avatar_to_temp_png("data:image/png;base64,!!not-base64!!").is_none());
        // Valid base64, but the decoded bytes aren't a PNG (no magic header).
        assert!(avatar_to_temp_png("data:image/png;base64,aGVsbG8=").is_none());
        // Real PNG bytes, but a non-PNG image subtype is rejected at the prefix.
        assert!(avatar_to_temp_png("data:image/jpeg;base64,iVBORw0KGgo=").is_none());
    }

    #[test]
    fn avatar_decode_rejects_oversized_payload() {
        // A base64 body far larger than any real 64×64 avatar is rejected
        // before it's decoded, so a hostile page can't force a huge write.
        let huge = format!("data:image/png;base64,{}", "A".repeat(4 << 20));
        assert!(avatar_to_temp_png(&huge).is_none());
    }
}
