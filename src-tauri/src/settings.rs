//! Persisted preferences: the [`Settings`] struct, load/save, the shared
//! [`AppState`], applying settings at runtime, and the webview-data
//! ("Clear Cache") machinery.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

use crate::actions::AppAction;
use crate::hotkey::apply_global_hotkey;
use crate::install_environment::is_snap;
#[cfg(target_os = "macos")]
use crate::macos::theme::set_macos_window_bg;
use crate::menu::{RecentThread, rebuild_recent_menus};
#[cfg(target_os = "macos")]
use crate::tray::set_macos_tray_icon_style;
use crate::tray::{PlatformTrayIcon, build_tray_menu, build_tray_with_menu, show_main, wants_tray};
#[cfg(target_os = "macos")]
use crate::window::is_dark;
#[cfg(not(target_os = "macos"))]
use crate::window::splash_background;
use crate::window::theme_for;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NicknameScope {
    All,
    Direct,
    Groups,
    Off,
}

fn deserialize_nickname_scope<'de, D>(deserializer: D) -> Result<Option<NicknameScope>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value.as_str() {
        Some("all") => Some(NicknameScope::All),
        Some("direct") => Some(NicknameScope::Direct),
        Some("groups") => Some(NicknameScope::Groups),
        Some("off") => Some(NicknameScope::Off),
        _ => None,
    })
}

/// Unknown policies fall back to the legacy switch rather than failing to load.
fn deserialize_muted_conversations<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value.as_str() {
        Some(policy @ ("ignore" | "badge" | "include")) => Some(policy.to_string()),
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Settings {
    pub(crate) always_on_top: bool,
    pub(crate) show_tray: bool,
    /// macOS/Linux tray artwork: full-color app icon or a monochrome mark.
    pub(crate) tray_icon_style: String,
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
    /// count, from the page title), "conversations" (unread chats in the list),
    /// or "dot" (that something is unread, without a number).
    pub(crate) badge_mode: String,
    /// Skip Dock/taskbar badges and native notifications for conversations the
    /// user has muted in Messenger. Legacy; `muted_conversations` wins when set.
    pub(crate) ignore_muted_conversations: bool,
    /// Muted conversations: "ignore" (no badge, no notification), "badge"
    /// (badge only) or "include". None keeps `ignore_muted_conversations`.
    #[serde(deserialize_with = "deserialize_muted_conversations")]
    pub(crate) muted_conversations: Option<String>,
    /// Force the Messenger theme: "system" (follow FB), "light", or "dark".
    pub(crate) theme: String,
    /// The color theme on top of light/dark: a built-in id or an imported
    /// theme's id (see themes.rs). "default" is Messenger's own look.
    pub(crate) color_theme: String,
    /// Accent color as "#rrggbb", or empty to use the theme's own accent.
    pub(crate) accent_color: String,
    /// Font family for messages and the conversation list; empty = default.
    pub(crate) message_font: String,
    /// App icon style: "color" or "monochrome".
    pub(crate) app_icon_style: String,
    /// Which app icon variant: "light" (the installed icon), "dark" or "auto"
    /// (match light/dark).
    pub(crate) app_icon_variant: String,
    /// macOS: run as a menu-bar app with no Dock icon (requires the tray).
    pub(crate) menu_bar_only: bool,
    /// Windows/Linux: hide the native application menu from Messenger windows.
    pub(crate) hide_menu_bar: bool,
    /// Linux: window title bar visibility — "auto" (hidden on tiling window
    /// managers, where the compositor moves/closes windows and the GTK header
    /// bar is dead weight; shown on floating desktops, where it is also how
    /// you drag and close the window), "show", or "hide".
    pub(crate) title_bar: String,
    /// Windows: hide the main window into the tray when it is minimized.
    pub(crate) hide_on_minimize: bool,
    /// Windows: hide the main window into the tray when it loses focus.
    pub(crate) hide_on_focus_loss: bool,
    /// Windows: omit the main window from the taskbar. This is only applied
    /// while a tray icon exists so the app always remains reachable.
    pub(crate) hide_taskbar_icon: bool,
    /// Suppress all desktop notifications for new messages.
    pub(crate) mute_notifications: bool,
    /// Notifications are paused until this time (milliseconds since 1970),
    /// set from the tray or Dock menu. An end time rather than a timer, so a
    /// pause survives restarts and one that ended while Carrier was closed is
    /// already over.
    pub(crate) notifications_paused_until: Option<i64>,
    /// Discover signed Carrier updates on startup and then every
    /// `update_check_hours`. This never downloads or installs without explicit
    /// confirmation in Settings.
    pub(crate) automatic_update_checks: bool,
    /// Hours between automatic update checks: 1, 4 (default) or 24.
    pub(crate) update_check_hours: u32,
    /// Play the OS notification sound for new-message notifications.
    pub(crate) notification_sound: bool,
    /// Notify without the sender name or message text (privacy).
    pub(crate) hide_notification_preview: bool,
    /// Notify for messages in group chats. Off leaves group messages to the
    /// unread badge. On by default.
    pub(crate) notify_group_chats: bool,
    /// The reaction a notification's React button adds: one of Messenger's
    /// six default reactions (`notifications::REACTIONS`). 👍 by default.
    pub(crate) notification_reaction: String,
    /// macOS: stack Notification Center entries by Messenger conversation.
    pub(crate) group_notifications_by_conversation: bool,
    /// macOS/Windows: clear a conversation's delivered notifications (Action
    /// Center toasts on Windows) when it is viewed or replied to inline.
    pub(crate) clear_notifications_on_view: bool,
    /// Ask the desktop for user attention when an unfocused message arrives.
    /// macOS uses a Dock bounce; the platform-neutral name is shared with the
    /// corresponding Windows taskbar behavior.
    pub(crate) attention_on_message: bool,
    /// Blur contact names and avatars (for screen-sharing / public spaces).
    /// The combined switch from before names and avatars were separate; the
    /// two settings below win once set.
    pub(crate) hide_names_avatars: bool,
    /// Blur contact names. None keeps `hide_names_avatars`.
    pub(crate) hide_names: Option<bool>,
    /// Blur avatars and read-receipt faces. None keeps `hide_names_avatars`.
    pub(crate) hide_avatars: Option<bool>,
    /// Explicit scope takes precedence; None retains the legacy two-toggle preference.
    #[serde(deserialize_with = "deserialize_nickname_scope")]
    pub(crate) nickname_scope: Option<NicknameScope>,
    /// Legacy nickname preferences, retained so existing installs keep their behavior.
    pub(crate) show_nicknames: bool,
    /// Restrict nickname presentation to group chats when nicknames are enabled.
    pub(crate) nicknames_group_only: bool,
    /// Render Facebook emoji sprites as native system emoji glyphs.
    pub(crate) system_emoji: bool,
    /// Pause videos and animated media that start without a recent user
    /// interaction. Manual playback remains available. Off by default.
    pub(crate) stop_media_autoplay: bool,
    /// Focus the message box when the window comes back to the front with a
    /// conversation open and nothing else focused. On by default.
    pub(crate) focus_composer_on_return: bool,
    /// Never send the "typing…" indicator to others. Seeing theirs is
    /// unaffected. Off by default.
    pub(crate) block_typing_indicator: bool,
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
    /// Where downloads go: "downloads" saves automatically to the system
    /// Downloads folder, while "ask" opens a native save dialog first.
    pub(crate) download_behavior: String,
    /// Keep broken webviews intact for live inspection. Manual reload still works.
    pub(crate) hold_failures: bool,
}

/// Valid page-zoom range in percent (matches `clampZoom` in
/// `inject/src/messenger/lib/zoom.ts`).
pub(crate) const ZOOM_MIN: i32 = 30;
pub(crate) const ZOOM_MAX: i32 = 200;

pub(crate) fn clamp_zoom(zoom: i32) -> i32 {
    zoom.clamp(ZOOM_MIN, ZOOM_MAX)
}

/// Apply page zoom through the native WebView zoom. Unlike CSS `zoom`, this
/// shrinks the layout viewport, so Messenger's viewport-sized layout still fits
/// the window instead of overflowing it (#318).
pub(crate) fn apply_page_zoom(window: &tauri::WebviewWindow, zoom: i32) {
    let factor = f64::from(clamp_zoom(zoom)) / 100.0;
    #[cfg(target_os = "macos")]
    let result = crate::macos::zoom::set_page_zoom(window, factor);
    #[cfg(not(target_os = "macos"))]
    let result = window.set_zoom(factor);
    if let Err(e) = result {
        log::warn!("failed to set page zoom on {}: {e}", window.label());
    }
}

impl Settings {
    /// Clamp out-of-range values (settings.json is user-editable, and the zoom
    /// event payload comes from the remote-origin page).
    pub(crate) fn sanitized(self) -> Self {
        self.sanitized_for_runtime(is_snap())
    }

    fn sanitized_for_runtime(mut self, snap: bool) -> Self {
        self.zoom = clamp_zoom(self.zoom);
        if self.tray_icon_style != "color" && self.tray_icon_style != "symbolic" {
            self.tray_icon_style = "color".into();
        }
        if self.download_behavior != "downloads" && self.download_behavior != "ask" {
            self.download_behavior = "downloads".into();
        }
        if !matches!(self.title_bar.as_str(), "auto" | "show" | "hide") {
            self.title_bar = "auto".into();
        }
        if self.color_theme.trim().is_empty() {
            self.color_theme = crate::themes::DEFAULT_THEME.into();
        }
        let accent = self.accent_color.trim();
        if !(accent.len() == 7
            && accent.starts_with('#')
            && accent[1..].bytes().all(|b| b.is_ascii_hexdigit()))
        {
            self.accent_color = String::new();
        }
        if self.message_font.len() > 100 || self.message_font.chars().any(char::is_control) {
            self.message_font = String::new();
        }
        if !matches!(self.app_icon_style.as_str(), "color" | "monochrome") {
            self.app_icon_style = "color".into();
        }
        if !matches!(self.app_icon_variant.as_str(), "auto" | "light" | "dark") {
            self.app_icon_variant = "light".into();
        }
        if !matches!(self.update_check_hours, 1 | 4 | 24) {
            self.update_check_hours = 4;
        }
        if !crate::notifications::REACTIONS
            .iter()
            .any(|(literal, _)| *literal == self.notification_reaction)
        {
            self.notification_reaction = "👍".into();
        }
        // Snap owns updates. Sandboxed autostart needs platform integration
        // rather than writing a host desktop file.
        if snap {
            self.autostart = false;
            self.automatic_update_checks = false;
            // Snap notification actions require a single owner of snap.carrier.
            self.multi_instance = false;
        }
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
            tray_icon_style: "color".into(),
            start_to_tray: false,
            autostart: false,
            hide_on_close: true,
            tray_notice_shown: false,
            multi_instance: false,
            spellcheck: false,
            unread_badge: true,
            badge_mode: "messages".into(),
            ignore_muted_conversations: true,
            muted_conversations: None,
            theme: "system".into(),
            color_theme: crate::themes::DEFAULT_THEME.into(),
            accent_color: String::new(),
            message_font: String::new(),
            app_icon_style: "color".into(),
            app_icon_variant: "light".into(),
            menu_bar_only: false,
            hide_menu_bar: false,
            title_bar: "auto".into(),
            hide_on_minimize: false,
            hide_on_focus_loss: false,
            hide_taskbar_icon: false,
            mute_notifications: false,
            notifications_paused_until: None,
            automatic_update_checks: true,
            update_check_hours: 4,
            notification_sound: true,
            hide_notification_preview: false,
            notify_group_chats: true,
            notification_reaction: "👍".into(),
            group_notifications_by_conversation: true,
            clear_notifications_on_view: true,
            attention_on_message: false,
            hide_names_avatars: false,
            hide_names: None,
            hide_avatars: None,
            nickname_scope: None,
            show_nicknames: true,
            nicknames_group_only: false,
            system_emoji: false,
            stop_media_autoplay: false,
            focus_composer_on_return: true,
            block_typing_indicator: false,
            zoom: 100,
            global_hotkey: false,
            block_telemetry: true,
            strip_link_tracking: true,
            send_with_accelerator: false,
            download_behavior: "downloads".into(),
            hold_failures: false,
        }
    }
}

impl Settings {
    /// Contact names are blurred (Ref #364).
    pub(crate) fn hides_names(&self) -> bool {
        self.hide_names.unwrap_or(self.hide_names_avatars)
    }

    /// Avatars are blurred (Ref #364).
    pub(crate) fn hides_avatars(&self) -> bool {
        self.hide_avatars.unwrap_or(self.hide_names_avatars)
    }

    /// The quick toggle (View menu, Cmd/Ctrl+Shift+H): reveal everything if
    /// anything is hidden, otherwise hide both.
    pub(crate) fn toggle_hide_identity(&mut self) {
        let hide = !(self.hides_names() || self.hides_avatars());
        self.hide_names = Some(hide);
        self.hide_avatars = Some(hide);
        self.hide_names_avatars = hide;
    }
}

/// Text a native copy row writes to the clipboard, and its confirmation toast.
pub(crate) type ContextMenuCopy = (String, &'static str);

pub(crate) struct AppState {
    pub(crate) settings: Mutex<Settings>,
    /// Fixed at process startup; the setting itself takes effect after restart.
    pub(crate) scheduled_send_available: bool,
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
    /// Last page-reported unread count, retained so settings and tray creation
    /// can immediately refresh every native unread surface.
    pub(crate) unread_count: std::sync::atomic::AtomicI64,
    /// Portal-derived panel tint heuristic for the opt-in Linux symbolic icon.
    #[cfg(target_os = "linux")]
    pub(crate) linux_panel_dark: AtomicBool,
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
    /// Carrier's injected click handler. They are imported as non-extractable
    /// HMAC keys in the page and are never included in an IPC payload.
    pub(crate) download_reveal_tokens: Mutex<HashMap<String, String>>,
    /// User-selected save paths awaiting the matching WebView download. The
    /// remote page sees only the URL key, never the filesystem path.
    pub(crate) prompted_downloads: Mutex<HashMap<(String, String), (PathBuf, Instant)>>,
    /// Recently consumed signed-action nonces and their insertion times. The
    /// authenticated action timestamp lets old entries expire without allowing
    /// a captured action to be replayed.
    pub(crate) signed_action_nonces: Mutex<HashMap<String, HashMap<String, Instant>>>,
    /// Native context actions become usable only after AppKit reports that the
    /// corresponding menu row was selected.
    #[cfg(target_os = "macos")]
    pub(crate) context_menu_activations: Mutex<HashMap<(String, String), ContextMenuActivation>>,
    /// Download reservations bind a claimed share action to its exact blob URL
    /// before the WebView starts the download.
    #[cfg(target_os = "macos")]
    pub(crate) download_reservations: Mutex<HashMap<(String, String), String>>,
    /// Text captured at the genuine right-click and written to the system
    /// clipboard when its native copy row is selected, with the toast to show.
    pub(crate) context_menu_copy_values: Mutex<HashMap<(String, String), ContextMenuCopy>>,
    /// A validated share-extension handoff awaiting delivery to the page
    /// (cold start, or a reload racing the carrier:// open). See share_intake.
    #[cfg(target_os = "macos")]
    pub(crate) pending_share: Mutex<Option<crate::macos::share_intake::PendingShare>>,
    /// The newest native action waiting for the main Messenger page hooks.
    pub(crate) pending_action: Mutex<Option<AppAction>>,
    /// Whether the main window has completed a Messenger page load.
    pub(crate) messenger_loaded: AtomicBool,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum ContextMenuActivation {
    Pending,
    Selected(Instant),
    Claimed {
        download_id: Option<String>,
        claimed_at: Instant,
    },
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
        .unwrap_or_else(|| Settings::default().sanitized())
}

/// Read persisted settings directly from disk before the Tauri app is built
/// (used to decide single-instance enforcement). Falls back to defaults.
pub(crate) fn load_settings_early() -> Settings {
    dirs_config_dir()
        .map(|b| b.join(APP_IDENTIFIER).join("settings.json"))
        .map(|path| load_settings_from_path(&path))
        .unwrap_or_else(|| Settings::default().sanitized())
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
                Settings::default().sanitized()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Settings::default().sanitized()
        }
        Err(error) => {
            log::warn!(
                "could not read settings file {}; using defaults: {error}",
                path.display()
            );
            Settings::default().sanitized()
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
pub(crate) fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
pub(crate) fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
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
const CLEAR_WEBVIEW_DATA: &[u8] = b"pending";
const ACCOUNT_RESET: &[u8] = b"reset";

fn clear_webview_data_marker(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(CLEAR_WEBVIEW_DATA_MARKER))
}

pub(crate) fn schedule_webview_data_clear(app: &tauri::AppHandle) -> Result<(), String> {
    schedule_clear(app, CLEAR_WEBVIEW_DATA)
}

/// Log Out… (Ref #356): the webview data plus everything
/// else Carrier keeps for the account. `settings.json` stays.
pub(crate) fn schedule_account_reset(app: &tauri::AppHandle) -> Result<(), String> {
    schedule_clear(app, ACCOUNT_RESET)
}

fn schedule_clear(app: &tauri::AppHandle, kind: &[u8]) -> Result<(), String> {
    let marker = clear_webview_data_marker(app)?;
    // A reset still waiting for a retry must not shrink to a cache clear.
    if std::fs::read(&marker).is_ok_and(|pending| pending == ACCOUNT_RESET) {
        return Ok(());
    }
    std::fs::write(&marker, kind).map_err(|e| e.to_string())?;

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

    // Everything but the log folder: this run's log file is already open
    // there, and deleting it would lose the log of the clear itself.
    #[cfg(not(target_os = "macos"))]
    if let Ok(local_data) = app.path().app_local_data_dir() {
        let logs = app.path().app_log_dir().ok();
        match std::fs::read_dir(&local_data) {
            Ok(entries) => paths.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| Some(path) != logs.as_ref()),
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => paths.push(local_data),
        }
    }

    paths.sort();
    paths.dedup();
    paths
}

/// What Carrier itself derives from the signed-in account, beyond the webview.
fn account_data_paths(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(data) = app.path().app_data_dir() {
        paths.extend(crate::notification_ledger::account_files(&data));
        #[cfg(target_os = "macos")]
        paths.push(data.join(crate::notifications::PERSISTED_NOTIFICATION_ROUTES_DIR));
    }
    if let Ok(config) = app.path().app_config_dir() {
        paths.extend(crate::scheduled_send::account_files(&config));
    }
    paths
}

pub(crate) fn clear_pending_webview_data(app: &tauri::AppHandle) {
    let Ok(marker) = clear_webview_data_marker(app) else {
        return;
    };
    let Ok(kind) = std::fs::read(&marker) else {
        return;
    };
    let mut paths = webview_data_paths(app);
    if kind == ACCOUNT_RESET {
        log::info!("resetting Carrier's account data");
        paths.extend(account_data_paths(app));
    }

    let mut all_removed = true;
    for path in paths {
        if let Err(e) = remove_path_if_exists(&path) {
            all_removed = false;
            log::error!("failed to remove webview data path {}: {e}", path.display());
        }
    }

    // Only clear the retry marker once every data path is actually gone. If any
    // removal failed, keep the marker so the next launch retries — otherwise a
    // single failure would silently abandon the "clear cache" request and leave
    // cookies/cache behind.
    if all_removed && let Err(e) = std::fs::remove_file(&marker) {
        log::warn!("failed to remove clear-cache marker: {e}");
    }
}

/// Register or unregister Start on System Startup with the OS. Kept separate so
/// callers can sync it *before* persisting and avoid committing a preference the
/// OS rejected.
pub(crate) fn sync_autostart(app: &tauri::AppHandle, want: bool) -> Result<(), String> {
    if is_snap() {
        return Err(
            "Start on System Startup is unavailable in this sandboxed installation.".into(),
        );
    }
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
    crate::menu::sync_setting_checks(app, s);
    // Action titles are fixed per macOS category registration.
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
    let reaction_changed =
        crate::notifications::set_notification_reaction(&s.notification_reaction);
    #[cfg(target_os = "macos")]
    if reaction_changed {
        crate::macos::notifications::register_notification_categories();
    }
    apply_global_hotkey(app, s.global_hotkey);
    let settings_json = serde_json::to_string(s).ok();
    let theme = theme_for(s);
    #[cfg(target_os = "linux")]
    crate::linux::apply_gtk_theme_name(app, theme);
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
        // Title-bar visibility follows the setting live, on every window —
        // the Settings dialog carries the same redundant header bar on
        // tiling WMs.
        #[cfg(target_os = "linux")]
        let _ = window.set_decorations(crate::window::show_title_bar(s));
        if label != "settings" {
            #[cfg(not(target_os = "macos"))]
            let _ = if s.hide_menu_bar {
                window.hide_menu()
            } else {
                window.show_menu()
            };
            apply_page_zoom(&window, s.zoom);
            crate::themes::apply_appearance(&window, s);
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
    let has_tray = state.tray.lock().unwrap().is_some();
    if !want_tray && has_tray {
        // Removing the only way back, so make sure the main window is
        // visible before dropping the tray icon.
        show_main(app);
    }
    // Build the replacement tray entirely outside the mutex: tray creation is
    // a blocking dispatch to the main thread, and a main-thread listener
    // (menu::rebuild_recent_menus) takes this same mutex — holding it across
    // the dispatch deadlocks the app. apply_settings runs serialized behind
    // the settings worker, so nothing else reconciles the tray concurrently.
    let built_tray = if want_tray && !has_tray {
        build_tray_menu(app)
            .ok()
            .and_then(|menu| build_tray_with_menu(app, menu, &s.tray_icon_style).ok())
    } else {
        None
    };
    let removed_tray = {
        let mut tray = state.tray.lock().unwrap();
        match (want_tray, tray.is_some()) {
            (true, false) => {
                if built_tray.is_some() {
                    *tray = built_tray;
                }
                None
            }
            (false, true) => tray.take(),
            _ => None,
        }
    };
    if removed_tray.is_some() {
        #[cfg(not(target_os = "linux"))]
        {
            // `build()` also registers a clone in Tauri's resource table,
            // so dropping our handle alone leaves the icon visible.
            let _ = app.remove_tray_by_id("carrier-tray");
        }
        // The Linux KSNI service is owned exclusively by this handle and shuts
        // down when it drops here — outside the lock, like every other call
        // that can block on another thread.
        drop(removed_tray);
    }
    #[cfg(target_os = "linux")]
    {
        let tray = state.tray.lock().unwrap();
        if let Some(tray) = tray.as_ref() {
            let dark_panel = state.linux_panel_dark.load(Ordering::Acquire);
            let _ = tray.set_icon_style(&s.tray_icon_style, dark_panel);
        }
    }
    #[cfg(target_os = "macos")]
    {
        // Clone-out for the same reason as above: the style setter dispatches
        // to the main thread.
        let tray = state.tray.lock().unwrap().clone();
        if let Some(tray) = tray {
            let _ = set_macos_tray_icon_style(app, &tray, &s.tray_icon_style);
        }
    }
    // Whether a tray icon is actually present after the reconcile above (e.g.
    // build_tray may have failed). macOS uses this to avoid hiding the Dock with
    // no tray to fall back on.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let tray_available = state.tray.lock().unwrap().is_some();

    crate::app_icon::apply_app_icon(app, s);

    crate::refresh_unread_indicators(
        app,
        s,
        state
            .unread_count
            .load(std::sync::atomic::Ordering::Acquire),
    );

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

    // A pause's menus must stop saying "Paused until" once it ends.
    if let Some(until) = s.notifications_paused_until {
        crate::pause::schedule_pause_expiry(app, until);
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
        assert!(
            s.ignore_muted_conversations,
            "ignore_muted_conversations should default to true"
        );
        assert_eq!(s.tray_icon_style, "color");
        assert!(s.group_notifications_by_conversation);
        assert!(s.clear_notifications_on_view);
        assert!(!s.attention_on_message);
        assert_eq!(s.theme, "system", "theme should default to 'system'");
        assert!(!s.menu_bar_only, "menu_bar_only should default to false");
        assert!(!s.hide_menu_bar, "hide_menu_bar should default to false");
        assert_eq!(s.title_bar, "auto", "title_bar should default to 'auto'");
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
        assert_eq!(
            s.download_behavior, "downloads",
            "downloads should save automatically by default"
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

    #[test]
    fn settings_sanitized_rejects_unknown_tray_icon_styles() {
        let settings = Settings {
            tray_icon_style: "theme-name".into(),
            ..Default::default()
        };
        assert_eq!(settings.sanitized().tray_icon_style, "color");
        let settings = Settings {
            tray_icon_style: "symbolic".into(),
            ..Default::default()
        };
        assert_eq!(settings.sanitized().tray_icon_style, "symbolic");
    }

    #[test]
    fn settings_sanitized_rejects_unknown_download_behaviors() {
        let settings = Settings {
            download_behavior: "desktop".into(),
            ..Default::default()
        };
        assert_eq!(settings.sanitized().download_behavior, "downloads");
        let settings = Settings {
            download_behavior: "ask".into(),
            ..Default::default()
        };
        assert_eq!(settings.sanitized().download_behavior, "ask");
    }

    #[test]
    fn snap_disables_host_owned_settings() {
        let settings = Settings {
            autostart: true,
            automatic_update_checks: true,
            ..Default::default()
        }
        .sanitized_for_runtime(true);

        assert!(!settings.autostart);
        assert!(!settings.automatic_update_checks);
    }

    #[test]
    fn snap_disables_multiple_processes_but_other_packages_preserve_the_setting() {
        for snap in [false, true] {
            let settings = Settings {
                multi_instance: true,
                ..Default::default()
            }
            .sanitized_for_runtime(snap);
            assert_eq!(settings.multi_instance, !snap);
        }
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
    fn settings_json_missing_tray_icon_style_defaults_to_color() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.tray_icon_style, "color");
    }

    #[test]
    fn settings_json_missing_notification_options_uses_safe_defaults() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(settings.group_notifications_by_conversation);
        assert!(settings.clear_notifications_on_view);
        assert!(!settings.attention_on_message);
    }

    #[test]
    fn settings_json_missing_hide_menu_bar_defaults_to_false() {
        // Pre-existing installs have no `hide_menu_bar` key in settings.json.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(!s.hide_menu_bar);
    }

    #[test]
    fn settings_json_missing_title_bar_defaults_to_auto() {
        // Pre-existing installs have no `title_bar` key in settings.json.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.title_bar, "auto");
    }

    #[test]
    fn title_bar_setting_sanitizes_unknown_values_to_auto() {
        let s: Settings = serde_json::from_str(r#"{"title_bar":"maybe"}"#).unwrap();
        assert_eq!(s.sanitized().title_bar, "auto");
        let s: Settings = serde_json::from_str(r#"{"title_bar":"hide"}"#).unwrap();
        assert_eq!(s.sanitized().title_bar, "hide");
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
    fn settings_json_missing_focus_composer_on_return_defaults_to_true() {
        // Existing installs gain the focus behavior without resetting settings.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.focus_composer_on_return);
    }

    #[test]
    fn settings_json_missing_block_typing_indicator_defaults_to_false() {
        // Existing installs keep Messenger's normal typing behavior.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(!s.block_typing_indicator);
    }

    #[test]
    fn hide_names_and_avatars_split_keeps_the_legacy_switch_until_set() {
        let legacy: Settings = serde_json::from_str(r#"{"hide_names_avatars":true}"#).unwrap();
        assert!(legacy.hides_names() && legacy.hides_avatars());
        let split: Settings =
            serde_json::from_str(r#"{"hide_names_avatars":true,"hide_avatars":false}"#).unwrap();
        assert!(split.hides_names() && !split.hides_avatars());

        let mut s = split;
        s.toggle_hide_identity();
        assert!(
            !s.hides_names() && !s.hides_avatars(),
            "anything hidden: reveal all"
        );
        s.toggle_hide_identity();
        assert!(
            s.hides_names() && s.hides_avatars(),
            "nothing hidden: hide both"
        );
    }

    #[test]
    fn muted_conversation_policy_loads_known_values_only() {
        let s: Settings = serde_json::from_str(r#"{"muted_conversations":"badge"}"#).unwrap();
        assert_eq!(s.muted_conversations.as_deref(), Some("badge"));
        let s: Settings = serde_json::from_str(r#"{"muted_conversations":"loud"}"#).unwrap();
        assert_eq!(s.muted_conversations, None);
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.muted_conversations, None);
        assert!(s.ignore_muted_conversations);
    }

    #[test]
    fn settings_json_missing_notify_group_chats_defaults_to_true() {
        // Existing installs keep notifying for group chats.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.notify_group_chats);
    }

    #[test]
    fn notification_reaction_defaults_to_thumbs_up_and_sanitizes_to_messenger_defaults() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.notification_reaction, "👍");
        let s: Settings = serde_json::from_str(r#"{"notification_reaction":"😮"}"#).unwrap();
        assert_eq!(s.sanitized().notification_reaction, "😮");
        let s: Settings = serde_json::from_str(r#"{"notification_reaction":"hi"}"#).unwrap();
        assert_eq!(s.sanitized().notification_reaction, "👍");
    }

    #[test]
    fn update_check_hours_default_and_sanitize_to_offered_choices() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.update_check_hours, 4);
        let s: Settings = serde_json::from_str(r#"{"update_check_hours":24}"#).unwrap();
        assert_eq!(s.sanitized().update_check_hours, 24);
        let s: Settings = serde_json::from_str(r#"{"update_check_hours":0}"#).unwrap();
        assert_eq!(s.sanitized().update_check_hours, 4);
    }

    #[test]
    fn settings_json_missing_stop_media_autoplay_defaults_to_false() {
        // Existing installs should not opt into autoplay suppression implicitly.
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(!s.stop_media_autoplay);
    }

    #[test]
    fn nickname_preference_preserves_defaults_and_round_trips() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.nickname_scope, None);
        assert!(settings.show_nicknames);
        assert!(!settings.nicknames_group_only);
        let settings = Settings {
            show_nicknames: false,
            nicknames_group_only: true,
            ..settings
        };
        let saved = serde_json::to_string(&settings).unwrap();
        let loaded: Settings = serde_json::from_str(&saved).unwrap();
        assert!(!loaded.show_nicknames);
        assert!(loaded.nicknames_group_only);
    }

    #[test]
    fn nickname_scopes_round_trip_and_ignore_invalid_values() {
        for scope in [
            NicknameScope::All,
            NicknameScope::Direct,
            NicknameScope::Groups,
            NicknameScope::Off,
        ] {
            let settings = Settings {
                nickname_scope: Some(scope),
                ..Settings::default()
            };
            let saved = serde_json::to_string(&settings).unwrap();
            let loaded: Settings = serde_json::from_str(&saved).unwrap();
            assert_eq!(loaded.nickname_scope, Some(scope));
        }
        for scope in [r#""invalid""#, "42", "null"] {
            let json =
                format!(r#"{{"nickname_scope":{scope},"zoom":145,"hide_names_avatars":true}}"#);
            let loaded: Settings = serde_json::from_str(&json).unwrap();
            assert_eq!(loaded.nickname_scope, None);
            assert_eq!(loaded.zoom, 145);
            assert!(loaded.hide_names_avatars);
        }
    }

    #[test]
    fn settings_json_missing_download_behavior_defaults_to_downloads() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.download_behavior, "downloads");
    }

    /// A settings.json as v2.1.0 wrote it, with non-default values, plus keys
    /// this version doesn't know.
    const V2_1_0_SETTINGS: &str = r#"{
        "always_on_top": false, "show_tray": true, "tray_icon_style": "symbolic",
        "start_to_tray": false, "autostart": false, "hide_on_close": true,
        "tray_notice_shown": true, "multi_instance": false, "spellcheck": true,
        "unread_badge": true, "badge_mode": "conversations",
        "ignore_muted_conversations": false, "theme": "light", "menu_bar_only": false,
        "hide_menu_bar": true, "title_bar": "show", "hide_on_minimize": false,
        "hide_on_focus_loss": false, "hide_taskbar_icon": false, "mute_notifications": true,
        "automatic_update_checks": false, "notification_sound": false,
        "hide_notification_preview": true, "group_notifications_by_conversation": false,
        "clear_notifications_on_view": false, "attention_on_message": true,
        "hide_names_avatars": true, "nickname_scope": "groups", "show_nicknames": false,
        "nicknames_group_only": true, "system_emoji": true, "stop_media_autoplay": true,
        "zoom": 125, "global_hotkey": true, "block_telemetry": false,
        "strip_link_tracking": false, "send_with_accelerator": true,
        "download_behavior": "ask", "hold_failures": true,
        "some_future_key": {"nested": [1, 2]}, "removed_legacy_flag": "yes"
    }"#;

    fn assert_v2_1_0_values_kept(s: &Settings) {
        assert_eq!(
            (
                s.tray_icon_style.as_str(),
                s.badge_mode.as_str(),
                s.theme.as_str()
            ),
            ("symbolic", "conversations", "light")
        );
        assert_eq!(
            (s.title_bar.as_str(), s.download_behavior.as_str(), s.zoom),
            ("show", "ask", 125)
        );
        assert_eq!(s.nickname_scope, Some(NicknameScope::Groups));
        assert!(s.tray_notice_shown && s.spellcheck && s.hide_menu_bar && s.mute_notifications);
        assert!(s.hide_notification_preview && s.attention_on_message && s.system_emoji);
        assert!(s.stop_media_autoplay && s.global_hotkey && s.send_with_accelerator);
        assert!(s.hold_failures && s.nicknames_group_only);
        assert!(!s.ignore_muted_conversations && !s.automatic_update_checks);
        assert!(!s.notification_sound && !s.group_notifications_by_conversation);
        assert!(!s.clear_notifications_on_view && !s.block_telemetry);
        assert!(!s.strip_link_tracking && !s.show_nicknames);
        assert!(s.show_tray && s.hide_on_close && s.unread_badge);
        assert!(!s.always_on_top && !s.start_to_tray && !s.autostart && !s.multi_instance);
        assert!(!s.menu_bar_only && !s.hide_on_minimize && !s.hide_on_focus_loss);
        assert!(!s.hide_taskbar_icon);
        // Settings that replaced a v2.1.0 one keep deferring to it until set.
        assert_eq!(s.muted_conversations, None);
        assert_eq!((s.hide_names, s.hide_avatars), (None, None));
        assert!(s.hides_names() && s.hides_avatars());
        // Settings new since v2.1.0 start at their defaults.
        let new = Settings::default();
        assert_eq!(s.update_check_hours, new.update_check_hours);
        assert_eq!(s.color_theme, new.color_theme);
        assert_eq!(s.notification_reaction, new.notification_reaction);
        assert_eq!(s.notify_group_chats, new.notify_group_chats);
        assert_eq!(s.focus_composer_on_return, new.focus_composer_on_return);
        assert_eq!(s.notifications_paused_until, None);
        assert_eq!(
            (s.accent_color.as_str(), s.message_font.as_str()),
            (new.accent_color.as_str(), new.message_font.as_str())
        );
        assert_eq!(
            (s.app_icon_style.as_str(), s.app_icon_variant.as_str()),
            (new.app_icon_style.as_str(), new.app_icon_variant.as_str())
        );
        assert_eq!(s.block_typing_indicator, new.block_typing_indicator);
    }

    #[test]
    fn v2_1_0_settings_file_loads_and_saves_without_losing_values() {
        let directory = std::env::temp_dir().join(format!(
            "carrier-settings-v210-{}-{}",
            std::process::id(),
            SETTINGS_WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");
        std::fs::write(&path, V2_1_0_SETTINGS).unwrap();

        let loaded = load_settings_from_path(&path);
        assert_v2_1_0_values_kept(&loaded);

        write_settings_to_path(&path, &loaded).unwrap();
        assert_v2_1_0_values_kept(&load_settings_from_path(&path));
        std::fs::remove_dir_all(directory).unwrap();
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
