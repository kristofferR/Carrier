//! New-message notifications: the `carrier:notify` payload, the avatar
//! temp-PNG cache, and the platform delivery paths (macOS goes through
//! `UNUserNotificationCenter` in [`crate::macos::notifications`]; Linux/Windows
//! use notify-rust).

use std::collections::HashMap;
use std::hash::{BuildHasher, Hash, Hasher};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Deserialize;
use tauri::Manager;

#[cfg(target_os = "macos")]
use crate::macos::notifications::deliver_notification_macos;
use crate::settings::AppState;
use crate::tray::show_main;

/// A new-message notification request from the page (the `carrier:notify` event).
/// Facebook hands its in-page `Notification` the sender (`title`), the message
/// preview (`body`), and the sender's avatar URL; the injected bridge forwards
/// them here, rendering the avatar to a PNG data URL (`icon`, best-effort) so the
/// native side never has to re-fetch it. `id` is the page's handle for this
/// notification — echoed back on click so the page can open the conversation.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct NotifyMsg {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    icon: String,
    /// Opaque fingerprint of the original sender and preview, computed before
    /// hidden-preview redaction so unrelated private notifications do not
    /// collapse into one. Older page bundles omit it and fall back to text.
    #[serde(default)]
    dedupe_key: String,
    /// Serializable conversation route supplied by the row-driven fallback.
    /// Kept native-side so notification clicks still work after a page reload.
    #[serde(default)]
    thread_path: String,
}

const NOTIFICATION_DEDUPE_WINDOW: Duration = Duration::from_secs(30);
const MAX_RECENT_NOTIFICATIONS: usize = 256;

/// What to do with an incoming notification after deduplication.
enum Delivery {
    /// Show it; it becomes the canonical notification for its fingerprint.
    Show,
    /// Suppress it as a duplicate. `delivered_id` is the notification already
    /// shown for this fingerprint, so a route this duplicate carries can be
    /// attached to it — the page-first notification it duplicates may have been
    /// emitted before its conversation row (and thus its route) was known.
    Suppress { delivered_id: u64 },
}

/// A delivered notification kept for the dedupe window: when it was last seen
/// and the native id it was shown under (so a later duplicate's route can reach
/// the notification the user actually has on screen).
struct SeenNotification {
    at: Instant,
    delivered_id: u64,
}

#[derive(Default)]
struct NotificationDeduper {
    seen: HashMap<u64, SeenNotification>,
}

impl NotificationDeduper {
    fn fingerprint(msg: &NotifyMsg) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        let valid_dedupe_key = msg.dedupe_key.len() == 16
            && msg.dedupe_key.bytes().all(|byte| byte.is_ascii_hexdigit());
        if valid_dedupe_key {
            0_u8.hash(&mut hasher);
            msg.dedupe_key.hash(&mut hasher);
        } else {
            // Compatibility with an already-loaded older injected bundle.
            1_u8.hash(&mut hasher);
            msg.title.trim().hash(&mut hasher);
            msg.body.trim().hash(&mut hasher);
        }
        hasher.finish()
    }

    /// Atomically reserve a logical notification for delivery. Repeated
    /// sightings refresh the window, so a noisy source cannot leak another
    /// copy every 30 seconds while it keeps replaying the same event. A
    /// suppressed duplicate reports the id of the notification already shown for
    /// its fingerprint so its route can still be attached there.
    fn classify(&mut self, msg: &NotifyMsg, now: Instant) -> Delivery {
        self.seen
            .retain(|_, seen| now.saturating_duration_since(seen.at) <= NOTIFICATION_DEDUPE_WINDOW);

        let fingerprint = Self::fingerprint(msg);
        if let Some(seen) = self.seen.get_mut(&fingerprint) {
            seen.at = now;
            return Delivery::Suppress {
                delivered_id: seen.delivered_id,
            };
        }

        if self.seen.len() >= MAX_RECENT_NOTIFICATIONS {
            if let Some(oldest) = self
                .seen
                .iter()
                .min_by_key(|(_, seen)| seen.at)
                .map(|(fingerprint, _)| *fingerprint)
            {
                self.seen.remove(&oldest);
            }
        }
        self.seen.insert(
            fingerprint,
            SeenNotification {
                at: now,
                delivered_id: msg.id,
            },
        );
        Delivery::Show
    }

    /// Test helper: the delivery decision reduced to a bool.
    #[cfg(test)]
    fn should_deliver_at(&mut self, msg: &NotifyMsg, now: Instant) -> bool {
        matches!(self.classify(msg, now), Delivery::Show)
    }
}

static NOTIFICATION_DEDUPER: OnceLock<Mutex<NotificationDeduper>> = OnceLock::new();
static NOTIFICATION_ROUTES: OnceLock<Mutex<HashMap<u64, String>>> = OnceLock::new();

fn validated_thread_path(value: &str) -> Option<String> {
    let id = value.strip_prefix("/t/")?.strip_suffix('/')?;
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(format!("/t/{id}/"))
}

fn remember_notification_route(id: u64, value: &str) {
    // `id` is the page's unique per-notification handle. A missing or zero id
    // (older or malformed payloads deserialize `id` to 0) is not unique: every
    // such notification would overwrite the same slot, so a click on an older
    // notification could open the newest thread. Skip native routing for a
    // non-unique id — the in-page handler still routes it while the page lives.
    if id == 0 {
        return;
    }
    let Some(path) = validated_thread_path(value) else {
        return;
    };
    let mut routes = NOTIFICATION_ROUTES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    if routes.len() >= MAX_RECENT_NOTIFICATIONS {
        routes.clear();
    }
    routes.insert(id, path);
}

fn take_notification_route(id: u64) -> Option<String> {
    NOTIFICATION_ROUTES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .remove(&id)
}

impl NotifyMsg {
    /// The page's handle for this notification (safe to log — it's a counter,
    /// not message content).
    pub(crate) fn id(&self) -> u64 {
        self.id
    }
}

/// A late route update for an already-emitted notification (the
/// `carrier:notify-route` event). Sent when a page `Notification` fired before
/// its conversation row was known: the row-driven pairing later supplies the
/// route so a click still opens the conversation after a page reload.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct NotifyRouteMsg {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    thread_path: String,
}

/// Attach (or refresh) the reload-safe route for a notification the page has
/// already emitted. A no-op for a non-unique id or an invalid path.
pub(crate) fn update_notification_route(msg: &NotifyRouteMsg) {
    remember_notification_route(msg.id, &msg.thread_path);
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
pub(crate) fn clear_avatar_cache() {
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

/// Show a native OS notification for a new message and, if it's clicked, bring
/// Carrier forward and open the conversation. The avatar is attached where the
/// platform allows (a thumbnail on macOS — the app icon always owns the main
/// slot there — and the notification icon on Linux/Windows).
///
/// macOS delivers through `UNUserNotificationCenter`: the request is added
/// non-blocking and clicks arrive later through the
/// [`NotifyDelegate`](crate::macos::notifications::NotifyDelegate) (set up at
/// startup), so there's no per-notification thread. Linux/Windows keep the
/// legacy notify-rust path: each notification gets its own thread that blocks
/// until the user clicks or dismisses it (it only parks, doesn't spin), and on
/// click it routes back to the page.
pub(crate) fn show_message_notification(app: tauri::AppHandle, msg: NotifyMsg) {
    // Re-enforce the privacy settings here on the trusted side. The page-side
    // checks in messenger.js run in the remote facebook.com origin, so a page
    // bug (or a hostile script emitting carrier:notify directly) must not be
    // able to bypass mute or leak sender/message content past hide-preview.
    let (sound, muted, hide_preview) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        (
            s.notification_sound,
            s.mute_notifications,
            s.hide_notification_preview,
        )
    };
    if muted {
        log::info!(
            "carrier:notify suppressed by mute_notifications (id {})",
            msg.id
        );
        return;
    }

    let decision = NOTIFICATION_DEDUPER
        .get_or_init(|| Mutex::new(NotificationDeduper::default()))
        .lock()
        .unwrap()
        .classify(&msg, Instant::now());
    if let Delivery::Suppress { delivered_id } = decision {
        // The duplicate is dropped, but it may carry the reload-safe route the
        // shown notification lacked (a page-first notification whose row paired
        // only after the page pairing window, inside the native dedupe window).
        // Attach it to the notification the user actually has on screen.
        remember_notification_route(delivered_id, &msg.thread_path);
        log::info!("duplicate carrier:notify suppressed (id {})", msg.id);
        return;
    }

    // Same redaction the page applies: generic title/body, no avatar.
    let title = if hide_preview || msg.title.trim().is_empty() {
        "Messenger".to_string()
    } else {
        msg.title
    };
    let body = if hide_preview {
        "New message".to_string()
    } else {
        msg.body
    };
    let id = msg.id;
    remember_notification_route(id, &msg.thread_path);
    let image = if hide_preview {
        None
    } else {
        avatar_to_temp_png(&msg.icon)
    };

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
        } else {
            let _ = take_notification_route(id);
        }
    });
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
pub(crate) fn on_notification_click(app: tauri::AppHandle, id: u64) {
    let thread_path = take_notification_route(id);
    let _ = app.clone().run_on_main_thread(move || {
        show_main(&app);
        if let Some(w) = app.get_webview_window("main") {
            let script = if let Some(thread_path) = thread_path {
                let path = serde_json::to_string(&thread_path).unwrap();
                format!(
                    "if (window.__carrierNotifyClick?.({id}) !== true) \
                     window.__carrierOpenThread?.({path});"
                )
            } else {
                format!("window.__carrierNotifyClick?.({id});")
            };
            let _ = w.eval(script);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
            r#"{"id":7,"title":"Jane","body":"hi there","icon":"data:image/png;base64,aGk=","dedupe_key":"0123456789abcdef","thread_path":"/t/123/"}"#,
        )
        .expect("payload parses");
        assert_eq!(msg.id, 7);
        assert_eq!(msg.title, "Jane");
        assert_eq!(msg.body, "hi there");
        assert_eq!(msg.dedupe_key, "0123456789abcdef");
        assert_eq!(msg.thread_path, "/t/123/");
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

    fn notify_msg(id: u64, title: &str, body: &str, dedupe_key: &str) -> NotifyMsg {
        NotifyMsg {
            id,
            title: title.into(),
            body: body.into(),
            icon: String::new(),
            dedupe_key: dedupe_key.into(),
            thread_path: String::new(),
        }
    }

    #[test]
    fn notification_routes_accept_only_bare_numeric_thread_paths() {
        assert_eq!(validated_thread_path("/t/12345/"), Some("/t/12345/".into()));
        assert_eq!(validated_thread_path("/t/12345"), None);
        assert_eq!(validated_thread_path("https://facebook.com/t/12345/"), None);
        assert_eq!(validated_thread_path("/t/1';alert(1)//"), None);
        assert_eq!(validated_thread_path("/t/123/../../settings/"), None);
    }

    #[test]
    fn distinct_notification_ids_keep_independent_routes() {
        // Two notifications with unique ids must not clobber each other's route,
        // so clicking an older one still opens its own thread.
        remember_notification_route(9_001, "/t/111/");
        remember_notification_route(9_002, "/t/222/");
        assert_eq!(take_notification_route(9_001).as_deref(), Some("/t/111/"));
        assert_eq!(take_notification_route(9_002).as_deref(), Some("/t/222/"));
    }

    #[test]
    fn non_unique_zero_id_is_never_routed() {
        // A missing/zero id is not unique: storing it would let a later message
        // hijack an earlier notification's click, so no route is kept at all.
        remember_notification_route(0, "/t/111/");
        remember_notification_route(0, "/t/222/");
        assert_eq!(take_notification_route(0), None);
    }

    #[test]
    fn update_notification_route_refreshes_an_emitted_route() {
        // The page-first path emits with no route, then supplies it once the row
        // is known; the later value must win for that id.
        update_notification_route(&NotifyRouteMsg {
            id: 9_010,
            thread_path: "/t/555/".into(),
        });
        assert_eq!(take_notification_route(9_010).as_deref(), Some("/t/555/"));
    }

    #[test]
    fn suppressed_duplicate_reports_the_shown_notification_id() {
        // A page-first notification (id 42) is shown; a later fallback for the
        // same message (id 99) that carries the route is suppressed, but must
        // report id 42 so the route reaches the notification on screen.
        let now = Instant::now();
        let mut deduper = NotificationDeduper::default();
        let shown = notify_msg(42, "Jane", "Hello", "0123456789abcdef");
        let duplicate = notify_msg(99, "Jane", "Hello", "0123456789abcdef");
        assert!(matches!(deduper.classify(&shown, now), Delivery::Show));
        match deduper.classify(&duplicate, now) {
            Delivery::Suppress { delivered_id } => assert_eq!(delivered_id, 42),
            Delivery::Show => panic!("an identical second notification must be suppressed"),
        }
    }

    #[test]
    fn notification_deduper_suppresses_replays_and_refreshes_the_window() {
        let start = Instant::now();
        let mut deduper = NotificationDeduper::default();
        let first = notify_msg(1, "Jane", "Hello", "0123456789abcdef");
        let replay = notify_msg(2, "Jane", "Hello", "0123456789abcdef");

        assert!(deduper.should_deliver_at(&first, start));
        assert!(!deduper.should_deliver_at(&replay, start + Duration::from_secs(20)));
        assert!(!deduper.should_deliver_at(&replay, start + Duration::from_secs(40)));
        assert!(deduper.should_deliver_at(&replay, start + Duration::from_secs(71)));
    }

    #[test]
    fn notification_deduper_keeps_hidden_previews_distinct() {
        let now = Instant::now();
        let mut deduper = NotificationDeduper::default();
        let jane = notify_msg(1, "Messenger", "New message", "1111111111111111");
        let john = notify_msg(2, "Messenger", "New message", "2222222222222222");

        assert!(deduper.should_deliver_at(&jane, now));
        assert!(deduper.should_deliver_at(&john, now));
    }

    #[test]
    fn notification_deduper_supports_payloads_without_a_key() {
        let now = Instant::now();
        let mut deduper = NotificationDeduper::default();
        let first = notify_msg(1, "Jane", "Hello", "");
        let replay = notify_msg(2, "Jane", "Hello", "");
        let different = notify_msg(3, "Jane", "Different", "");

        assert!(deduper.should_deliver_at(&first, now));
        assert!(!deduper.should_deliver_at(&replay, now));
        assert!(deduper.should_deliver_at(&different, now));
    }

    #[test]
    fn notification_deduper_rejects_malformed_keys() {
        let now = Instant::now();
        let mut deduper = NotificationDeduper::default();
        let jane = notify_msg(1, "Jane", "Hello", "malformed-key");
        let john = notify_msg(2, "John", "Different", "malformed-key");
        let jane_replay = notify_msg(3, "Jane", "Hello", "malformed-key");

        assert!(deduper.should_deliver_at(&jane, now));
        assert!(deduper.should_deliver_at(&john, now));
        assert!(!deduper.should_deliver_at(&jane_replay, now));
    }
}
