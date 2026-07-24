//! New-message notifications: the `carrier:notify` payload, the avatar
//! temp-PNG cache, and the platform delivery paths (macOS goes through
//! `UNUserNotificationCenter` in [`crate::macos::notifications`]; Linux uses
//! the freedesktop D-Bus API with notify-rust's builder types; Windows uses
//! notify-rust directly).

use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasher, Hash, Hasher};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
#[cfg(target_os = "linux")]
use futures_util::future::{select, Either};
#[cfg(target_os = "linux")]
use futures_util::{pin_mut, StreamExt};
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
const NOTIFICATION_RATE_WINDOW: Duration = Duration::from_secs(60);
const MAX_NOTIFICATIONS_PER_WINDOW: usize = 20;

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

#[derive(Default)]
struct NotificationRateLimiter {
    delivered: VecDeque<Instant>,
    suppression_logged: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum RateLimitDecision {
    Allow,
    SuppressAndLog,
    Suppress,
}

impl NotificationRateLimiter {
    fn classify(&mut self, now: Instant) -> RateLimitDecision {
        while self
            .delivered
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) > NOTIFICATION_RATE_WINDOW)
        {
            self.delivered.pop_front();
        }
        if self.delivered.len() >= MAX_NOTIFICATIONS_PER_WINDOW {
            if self.suppression_logged {
                return RateLimitDecision::Suppress;
            }
            self.suppression_logged = true;
            return RateLimitDecision::SuppressAndLog;
        }
        self.suppression_logged = false;
        self.delivered.push_back(now);
        RateLimitDecision::Allow
    }
}

static NOTIFICATION_RATE_LIMITER: OnceLock<Mutex<NotificationRateLimiter>> = OnceLock::new();

/// A reload-safe conversation route kept for an emitted notification, with the
/// time it was stored so the cap can evict the oldest rather than every route.
struct RouteEntry {
    path: String,
    at: Instant,
}
static NOTIFICATION_ROUTES: OnceLock<Mutex<HashMap<u64, RouteEntry>>> = OnceLock::new();

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
    // At the cap, evict only the oldest entry. A dismissed notification can
    // leave its route behind, but recent notifications still awaiting a click
    // must keep theirs — clearing the whole map would break their routing.
    if routes.len() >= MAX_RECENT_NOTIFICATIONS && !routes.contains_key(&id) {
        if let Some(oldest) = routes
            .iter()
            .min_by_key(|(_, entry)| entry.at)
            .map(|(id, _)| *id)
        {
            routes.remove(&oldest);
        }
    }
    routes.insert(
        id,
        RouteEntry {
            path,
            at: Instant::now(),
        },
    );
}

fn take_notification_route(id: u64) -> Option<String> {
    NOTIFICATION_ROUTES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .remove(&id)
        .map(|entry| entry.path)
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

fn should_attach_path_avatar(hide_preview: bool, flatpak: bool) -> bool {
    !hide_preview && !flatpak
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

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct LinuxNotificationCapabilities {
    actions: bool,
    inline_reply: bool,
}

#[cfg(target_os = "linux")]
fn linux_notification_capabilities() -> LinuxNotificationCapabilities {
    static CAPABILITIES: OnceLock<LinuxNotificationCapabilities> = OnceLock::new();
    *CAPABILITIES.get_or_init(|| {
        let capabilities = notify_rust::get_capabilities().unwrap_or_default();
        LinuxNotificationCapabilities {
            actions: capabilities.iter().any(|value| value == "actions"),
            inline_reply: capabilities.iter().any(|value| value == "inline-reply"),
        }
    })
}

#[cfg(target_os = "linux")]
fn linux_reply_eligible(
    hide_preview: bool,
    notification_id: u64,
    thread_path: Option<&str>,
    capabilities: LinuxNotificationCapabilities,
) -> bool {
    !hide_preview
        && notification_id != 0
        && thread_path.is_some()
        && capabilities.actions
        && capabilities.inline_reply
}

#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum LinuxNotificationSignal {
    Action(String),
    Reply(String),
    Closed,
}

#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum LinuxSignalDecision {
    Ignore,
    Open,
    Reply(String),
    Closed,
    AwaitReply,
}

#[cfg(target_os = "linux")]
fn classify_linux_signal(
    signal: LinuxNotificationSignal,
    awaiting_reply: bool,
) -> LinuxSignalDecision {
    match signal {
        LinuxNotificationSignal::Action(action) if action == "inline-reply" => {
            LinuxSignalDecision::AwaitReply
        }
        LinuxNotificationSignal::Action(_) => LinuxSignalDecision::Open,
        LinuxNotificationSignal::Reply(text) => LinuxSignalDecision::Reply(text),
        // Some servers close the notification immediately after invoking its
        // reply action. Keep the short reply grace period alive in that case.
        LinuxNotificationSignal::Closed if awaiting_reply => LinuxSignalDecision::Ignore,
        LinuxNotificationSignal::Closed => LinuxSignalDecision::Closed,
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum LinuxNotificationResponse {
    Open,
    OpenComposer,
    Reply(String),
    Closed,
}

#[cfg(target_os = "linux")]
fn linux_notification_sender_matches(actual: Option<&str>, expected: &str) -> bool {
    actual == Some(expected)
}

#[cfg(target_os = "linux")]
fn decode_linux_notification_signal(
    message: &zbus::Message,
    expected_id: u32,
    expected_sender: &str,
) -> Option<LinuxNotificationSignal> {
    let header = message.header();
    if !linux_notification_sender_matches(
        header.sender().map(|sender| sender.as_str()),
        expected_sender,
    ) {
        return None;
    }
    match header.member()?.as_str() {
        "ActionInvoked" => {
            let (id, action) = message.body().deserialize::<(u32, String)>().ok()?;
            (id == expected_id).then_some(LinuxNotificationSignal::Action(action))
        }
        "NotificationReplied" => {
            let (id, text) = message.body().deserialize::<(u32, String)>().ok()?;
            (id == expected_id).then_some(LinuxNotificationSignal::Reply(text))
        }
        "NotificationClosed" => {
            let (id, _reason) = message.body().deserialize::<(u32, u32)>().ok()?;
            (id == expected_id).then_some(LinuxNotificationSignal::Closed)
        }
        _ => None,
    }
}

#[cfg(target_os = "linux")]
async fn wait_for_linux_notification_response(
    mut messages: zbus::MessageStream,
    notification_id: u32,
    notification_sender: &str,
) -> Result<LinuxNotificationResponse, zbus::Error> {
    const REPLY_SIGNAL_GRACE: Duration = Duration::from_secs(2);
    let mut reply_deadline: Option<Instant> = None;

    loop {
        let next_message = messages.next();
        pin_mut!(next_message);
        let next = if let Some(deadline) = reply_deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(LinuxNotificationResponse::OpenComposer);
            }
            let timeout = async_io::Timer::after(remaining);
            pin_mut!(timeout);
            match select(next_message, timeout).await {
                Either::Left((message, _)) => message,
                Either::Right((_, _)) => return Ok(LinuxNotificationResponse::OpenComposer),
            }
        } else {
            next_message.await
        };

        let Some(message) = next else {
            return Ok(LinuxNotificationResponse::Closed);
        };
        let message = message?;
        let Some(signal) =
            decode_linux_notification_signal(&message, notification_id, notification_sender)
        else {
            continue;
        };
        match classify_linux_signal(signal, reply_deadline.is_some()) {
            LinuxSignalDecision::Ignore => {}
            LinuxSignalDecision::Open => return Ok(LinuxNotificationResponse::Open),
            LinuxSignalDecision::Reply(text) => {
                return Ok(LinuxNotificationResponse::Reply(text));
            }
            LinuxSignalDecision::Closed => return Ok(LinuxNotificationResponse::Closed),
            LinuxSignalDecision::AwaitReply => {
                reply_deadline = Some(Instant::now() + REPLY_SIGNAL_GRACE);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_notification_hints(
    sound: bool,
    allow_inline_reply: bool,
) -> HashMap<&'static str, zbus::zvariant::Value<'static>> {
    let mut hints = HashMap::new();
    if sound {
        hints.insert(
            "sound-name",
            zbus::zvariant::Value::from("message-new-instant"),
        );
    } else {
        hints.insert("suppress-sound", zbus::zvariant::Value::from(true));
    }
    if allow_inline_reply {
        hints.insert(
            "x-kde-reply-placeholder-text",
            zbus::zvariant::Value::from("Reply…"),
        );
    }
    hints
}

/// Show a Linux notification and receive the response on the same connection.
/// KDE targets `NotificationReplied` to the sender's unique D-Bus name, which
/// is why notify-rust's private handle connection cannot be replaced by a
/// second listener connection after `show()`.
#[cfg(target_os = "linux")]
fn show_linux_notification(
    title: &str,
    body: &str,
    image: Option<&Path>,
    sound: bool,
    allow_inline_reply: bool,
) -> LinuxNotificationResponse {
    let mut notification = notify_rust::Notification::new();
    notification.appname("Carrier").summary(title);
    if !body.is_empty() {
        notification.body(body);
    }
    if let Some(path) = image.and_then(Path::to_str) {
        notification.icon(path);
    }
    notification.action("default", "Open");
    if allow_inline_reply {
        notification.action("inline-reply", "Reply");
    }

    let result = (|| -> Result<LinuxNotificationResponse, String> {
        let connection =
            zbus::blocking::Connection::session().map_err(|error| error.to_string())?;
        let dbus =
            zbus::blocking::fdo::DBusProxy::new(&connection).map_err(|error| error.to_string())?;
        let notification_name =
            zbus::names::WellKnownName::try_from("org.freedesktop.Notifications").unwrap();
        // The daemon may be D-Bus activated and have no owner until its first
        // use. Start it before pinning the unique owner used by our match rule.
        dbus.start_service_by_name(notification_name.clone(), 0)
            .map_err(|error| error.to_string())?;
        let notification_owner = dbus
            .get_name_owner(notification_name.into())
            .map_err(|error| error.to_string())?;
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender(notification_owner.clone())
            .map_err(|error| error.to_string())?
            .path("/org/freedesktop/Notifications")
            .map_err(|error| error.to_string())?
            .interface("org.freedesktop.Notifications")
            .map_err(|error| error.to_string())?
            .build();
        let messages = async_io::block_on(zbus::MessageStream::for_match_rule(
            rule,
            connection.inner(),
            Some(16),
        ))
        .map_err(|error| error.to_string())?;
        let hints = linux_notification_hints(sound, allow_inline_reply);
        let timeout = i32::from(notification.timeout);
        let reply = connection
            .call_method(
                Some("org.freedesktop.Notifications"),
                "/org/freedesktop/Notifications",
                Some("org.freedesktop.Notifications"),
                "Notify",
                &(
                    &notification.appname,
                    0_u32,
                    &notification.icon,
                    &notification.summary,
                    &notification.body,
                    &notification.actions,
                    hints,
                    timeout,
                ),
            )
            .map_err(|error| error.to_string())?;
        let notification_id = reply
            .body()
            .deserialize::<u32>()
            .map_err(|error| error.to_string())?;
        async_io::block_on(wait_for_linux_notification_response(
            messages,
            notification_id,
            notification_owner.as_str(),
        ))
        .map_err(|error| error.to_string())
    })();

    result.unwrap_or_else(|error| {
        log::warn!("Linux notification response loop failed: {error}");
        LinuxNotificationResponse::Closed
    })
}

#[cfg(target_os = "linux")]
const MAX_QUICK_REPLY_CHARS: usize = 2_000;
#[cfg(target_os = "linux")]
const QUICK_REPLY_ACK_TIMEOUT: Duration = Duration::from_secs(20);

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingReplyMode {
    Send,
    Draft,
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct PendingPageReply {
    id: u64,
    attempt: u64,
    thread_path: String,
    text: String,
    mode: PendingReplyMode,
    expires_at: Instant,
    resume_attempted: bool,
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct PendingPageReplies {
    replies: HashMap<u64, PendingPageReply>,
}

#[cfg(target_os = "linux")]
impl PendingPageReplies {
    fn register(
        &mut self,
        id: u64,
        attempt: u64,
        thread_path: String,
        text: String,
        mode: PendingReplyMode,
        expires_at: Instant,
    ) {
        self.replies.insert(
            id,
            PendingPageReply {
                id,
                attempt,
                thread_path,
                text,
                mode,
                expires_at,
                resume_attempted: false,
            },
        );
    }

    fn complete(&mut self, id: u64, attempt: u64) {
        if self
            .replies
            .get(&id)
            .is_some_and(|reply| reply.attempt == attempt)
        {
            self.replies.remove(&id);
        }
    }

    fn resumable(&mut self, now: Instant) -> Vec<PendingPageReply> {
        self.replies.retain(|_, reply| reply.expires_at > now);
        self.replies
            .values_mut()
            .filter(|reply| !reply.resume_attempted)
            .map(|reply| {
                reply.resume_attempted = true;
                reply.clone()
            })
            .collect()
    }
}

#[cfg(target_os = "linux")]
fn pending_page_replies() -> &'static Mutex<PendingPageReplies> {
    static REPLIES: OnceLock<Mutex<PendingPageReplies>> = OnceLock::new();
    REPLIES.get_or_init(|| Mutex::new(PendingPageReplies::default()))
}

#[cfg(target_os = "linux")]
fn capped_reply_text(text: &str) -> String {
    text.chars().take(MAX_QUICK_REPLY_CHARS).collect()
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct ReplyAckWaiters {
    waiters: HashMap<u64, (u64, std::sync::mpsc::SyncSender<bool>)>,
}

#[cfg(target_os = "linux")]
impl ReplyAckWaiters {
    fn register(&mut self, id: u64, attempt: u64, sender: std::sync::mpsc::SyncSender<bool>) {
        self.waiters.insert(id, (attempt, sender));
    }

    fn complete(&mut self, id: u64, attempt: u64, ok: bool) -> bool {
        if !self
            .waiters
            .get(&id)
            .is_some_and(|(expected, _)| *expected == attempt)
        {
            return false;
        }
        self.waiters
            .remove(&id)
            .is_some_and(|(_, sender)| sender.send(ok).is_ok())
    }

    fn remove(&mut self, id: u64) {
        self.waiters.remove(&id);
    }
}

#[cfg(target_os = "linux")]
fn reply_ack_waiters() -> &'static Mutex<ReplyAckWaiters> {
    static WAITERS: OnceLock<Mutex<ReplyAckWaiters>> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(ReplyAckWaiters::default()))
}

#[cfg(target_os = "linux")]
#[derive(Deserialize)]
struct ReplyResultMsg {
    id: u64,
    attempt: u64,
    ok: bool,
}

#[cfg(target_os = "linux")]
pub(crate) fn handle_reply_result(payload: &str) {
    let Ok(result) = serde_json::from_str::<ReplyResultMsg>(payload) else {
        return;
    };
    pending_page_replies()
        .lock()
        .unwrap()
        .complete(result.id, result.attempt);
    reply_ack_waiters()
        .lock()
        .unwrap()
        .complete(result.id, result.attempt, result.ok);
}

#[cfg(target_os = "linux")]
fn next_reply_attempt() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed).wrapping_add(1).max(1)
}

#[cfg(target_os = "linux")]
fn quick_reply_script(
    id: u64,
    attempt: u64,
    thread_path: &str,
    text: &str,
    mode: PendingReplyMode,
) -> Result<String, String> {
    let path = serde_json::to_string(thread_path).map_err(|error| error.to_string())?;
    let text = serde_json::to_string(text).map_err(|error| error.to_string())?;
    let hook = match mode {
        PendingReplyMode::Send => "__carrierQuickReply",
        PendingReplyMode::Draft => "__carrierQuickReplyDraft",
    };
    Ok(format!("window.{hook}?.({path}, {text}, {id}, {attempt});"))
}

#[cfg(target_os = "linux")]
fn register_pending_page_reply(
    id: u64,
    attempt: u64,
    thread_path: &str,
    text: &str,
    mode: PendingReplyMode,
) {
    pending_page_replies().lock().unwrap().register(
        id,
        attempt,
        thread_path.to_string(),
        text.to_string(),
        mode,
        Instant::now() + QUICK_REPLY_ACK_TIMEOUT,
    );
}

/// Re-dispatch an in-memory notification reply after a hard Messenger
/// navigation replaces the page that received the first eval. Each action gets
/// one resume attempt and expires with the native acknowledgement window.
#[cfg(target_os = "linux")]
pub(crate) fn resume_pending_page_replies(window: &tauri::WebviewWindow) {
    let replies = pending_page_replies()
        .lock()
        .unwrap()
        .resumable(Instant::now());
    for reply in replies {
        match quick_reply_script(
            reply.id,
            reply.attempt,
            &reply.thread_path,
            &reply.text,
            reply.mode,
        ) {
            Ok(script) => {
                if let Err(error) = window.eval(script) {
                    log::warn!(
                        "failed to resume quick-reply page action (id {}): {error}",
                        reply.id
                    );
                }
            }
            Err(error) => {
                log::warn!(
                    "failed to serialize resumed quick-reply page action (id {}): {error}",
                    reply.id
                );
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn eval_hidden_quick_reply(
    app: &tauri::AppHandle,
    id: u64,
    attempt: u64,
    thread_path: &str,
    text: &str,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    let script = quick_reply_script(id, attempt, thread_path, text, PendingReplyMode::Send)?;
    let (sent, received) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = window.eval(script).map_err(|error| error.to_string());
        let _ = sent.send(result);
    })
    .map_err(|error| error.to_string())?;
    received
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| format!("quick-reply eval dispatch failed: {error}"))?
}

#[cfg(target_os = "linux")]
fn show_reply_failure_notification() {
    let mut notification = notify_rust::Notification::new();
    notification
        .appname("Carrier")
        .summary("Carrier")
        .body("Reply not sent — opening the conversation")
        .hint(notify_rust::Hint::SuppressSound(true));
    if let Err(error) = notification.show() {
        log::warn!("failed to show quick-reply failure notification: {error}");
    }
}

#[cfg(target_os = "linux")]
fn open_reply_fallback(app: tauri::AppHandle, id: u64, thread_path: String, text: String) {
    let attempt = next_reply_attempt();
    register_pending_page_reply(id, attempt, &thread_path, &text, PendingReplyMode::Draft);
    let script =
        quick_reply_script(id, attempt, &thread_path, &text, PendingReplyMode::Draft).unwrap();
    let main_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        show_main(&main_app);
        if let Some(window) = main_app.get_webview_window("main") {
            let _ = window.eval(script);
        }
    }) {
        log::warn!("failed to open quick-reply fallback: {error}");
    }
    show_reply_failure_notification();
}

#[cfg(target_os = "linux")]
fn open_notification_composer(app: tauri::AppHandle, id: u64) {
    let Some(thread_path) = take_notification_route(id) else {
        on_notification_click(app, id);
        return;
    };
    let attempt = next_reply_attempt();
    register_pending_page_reply(id, attempt, &thread_path, "", PendingReplyMode::Draft);
    let script =
        quick_reply_script(id, attempt, &thread_path, "", PendingReplyMode::Draft).unwrap();
    let main_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        show_main(&main_app);
        if let Some(window) = main_app.get_webview_window("main") {
            let _ = window.eval(script);
        }
    }) {
        log::warn!("failed to focus notification composer: {error}");
    }
}

#[cfg(target_os = "linux")]
fn deliver_quick_reply(app: tauri::AppHandle, id: u64, raw_text: String) {
    let Some(thread_path) = take_notification_route(id) else {
        log::warn!("quick reply had no validated notification route (id {id})");
        on_notification_click(app, id);
        show_reply_failure_notification();
        return;
    };
    let text = capped_reply_text(&raw_text);
    if text.trim().is_empty() {
        // Empty input is equivalent to activating the notification.
        remember_notification_route(id, &thread_path);
        on_notification_click(app, id);
        return;
    }

    let attempt = next_reply_attempt();
    let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
    reply_ack_waiters()
        .lock()
        .unwrap()
        .register(id, attempt, result_tx);
    register_pending_page_reply(id, attempt, &thread_path, &text, PendingReplyMode::Send);
    let dispatched = eval_hidden_quick_reply(&app, id, attempt, &thread_path, &text);
    let sent = dispatched.is_ok()
        && result_rx
            .recv_timeout(QUICK_REPLY_ACK_TIMEOUT)
            .unwrap_or(false);
    reply_ack_waiters().lock().unwrap().remove(id);
    pending_page_replies().lock().unwrap().complete(id, attempt);
    if !sent {
        if let Err(error) = dispatched {
            log::warn!("quick-reply delivery could not start (id {id}): {error}");
        } else {
            log::warn!("quick-reply delivery failed or timed out (id {id})");
        }
        open_reply_fallback(app, id, thread_path, text);
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
/// startup), so there's no per-notification thread. Linux and Windows each
/// park one thread per notification until the server reports a response;
/// Linux additionally handles KDE's inline-reply signal.
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

    let rate_decision = NOTIFICATION_RATE_LIMITER
        .get_or_init(|| Mutex::new(NotificationRateLimiter::default()))
        .lock()
        .unwrap()
        .classify(Instant::now());
    if rate_decision == RateLimitDecision::SuppressAndLog {
        log::warn!("carrier:notify suppressed by native rate limit");
    }
    if rate_decision != RateLimitDecision::Allow {
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
    #[cfg(target_os = "linux")]
    let allow_inline_reply = linux_reply_eligible(
        hide_preview,
        id,
        validated_thread_path(&msg.thread_path).as_deref(),
        linux_notification_capabilities(),
    );
    remember_notification_route(id, &msg.thread_path);
    // A Flatpak-private temp path is not readable by the host notification
    // daemon. Skip the path attachment there instead of showing a broken icon.
    let image = if should_attach_path_avatar(hide_preview, crate::install_environment::is_flatpak())
    {
        avatar_to_temp_png(&msg.icon)
    } else {
        None
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

    #[cfg(target_os = "windows")]
    {
        let app_id = app.config().identifier.clone();
        std::thread::spawn(move || {
            let clicked =
                show_windows_notification(&title, &body, image.as_deref(), sound, &app_id);
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

    #[cfg(target_os = "linux")]
    std::thread::spawn(move || {
        let response =
            show_linux_notification(&title, &body, image.as_deref(), sound, allow_inline_reply);
        if let Some(path) = image.as_deref() {
            let _ = std::fs::remove_file(path);
        }
        match response {
            LinuxNotificationResponse::Open => on_notification_click(app, id),
            LinuxNotificationResponse::OpenComposer => open_notification_composer(app, id),
            LinuxNotificationResponse::Reply(text) if text.trim().is_empty() => {
                on_notification_click(app, id);
            }
            LinuxNotificationResponse::Reply(text) => deliver_quick_reply(app, id, text),
            LinuxNotificationResponse::Closed => {
                let _ = take_notification_route(id);
            }
        }
    });
}

/// A response represents a click unless the platform explicitly reports that
/// the notification closed. In particular, Windows reports a toast body click
/// as `Default` rather than as a named action.
#[cfg(target_os = "windows")]
fn notification_response_was_clicked(response: &notify_rust::NotificationResponse) -> bool {
    !matches!(response, notify_rust::NotificationResponse::Closed(_))
}

/// See the macOS variant. On Windows notify-rust blocks until the notification
/// closes.
#[cfg(target_os = "windows")]
fn show_windows_notification(
    title: &str,
    body: &str,
    image: Option<&std::path::Path>,
    sound: bool,
    app_id: &str,
) -> bool {
    let mut n = notify_rust::Notification::new();
    n.summary(title);
    if !body.is_empty() {
        n.body(body);
    }
    if let Some(path) = image.and_then(|p| p.to_str()) {
        n.image_path(path);
    }
    // Windows toasts are silent unless a sound is named (notify-rust maps an
    // unset `sound_name` to a silent toast), so name the system default when
    // sound is on; when it's off, leaving `sound_name` unset already delivers
    // silently.
    n.app_id(app_id);
    if sound {
        n.sound_name("Default");
    }
    let mut clicked = false;
    if let Ok(handle) = n.show() {
        let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
            clicked = notification_response_was_clicked(response);
        });
    }
    clicked
}

/* ---------------------------- Sync alerts ----------------------------- */

/// Health notice from the injected page: Messenger's data sync degraded or
/// recovered (the `carrier:sync-alert` event). Distinct from message
/// notifications — fixed strings only (the event comes from the remote
/// facebook.com origin, so its text is never rendered), no dedupe or route
/// machinery, and its own episode gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SyncAlertKind {
    Degraded,
    Recovered,
}

pub(crate) const SYNC_ALERT_MIN_GAP: Duration = Duration::from_secs(10 * 60);

/// Who raised a sync alert: the page's sync monitor, or the native watchdog's
/// exhausted recovery ladder. Their episodes are independent — a page-side
/// recovery must never consume the watchdog's pending recovery pairing (the
/// transport can come back while sync is still dead, and vice versa).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SyncAlertSource {
    Page,
    Watchdog,
}

/// Decides which sync alerts become native notifications: a degraded notice at
/// most once per [`SYNC_ALERT_MIN_GAP`] across both sources (a flapping outage
/// must not spam), and a recovery notice only when that source's degraded
/// counterpart was actually shown.
#[derive(Debug, Default)]
pub(crate) struct SyncAlertGate {
    last_degraded_at: Option<Instant>,
    page_notified: bool,
    watchdog_notified: bool,
}

impl SyncAlertGate {
    fn notified(&mut self, source: SyncAlertSource) -> &mut bool {
        match source {
            SyncAlertSource::Page => &mut self.page_notified,
            SyncAlertSource::Watchdog => &mut self.watchdog_notified,
        }
    }

    pub(crate) fn on_degraded(&mut self, source: SyncAlertSource, now: Instant) -> bool {
        let allow = !self
            .last_degraded_at
            .is_some_and(|at| now.duration_since(at) < SYNC_ALERT_MIN_GAP);
        if allow {
            self.last_degraded_at = Some(now);
            // A suppressed repeat must not clear the pairing of a notice
            // that was actually shown.
            *self.notified(source) = true;
        }
        allow
    }

    pub(crate) fn on_recovered(&mut self, source: SyncAlertSource) -> bool {
        std::mem::take(self.notified(source))
    }
}

static SYNC_ALERT_GATE: OnceLock<Mutex<SyncAlertGate>> = OnceLock::new();

pub(crate) fn show_sync_alert(app: tauri::AppHandle, source: SyncAlertSource, kind: SyncAlertKind) {
    let muted = app
        .state::<AppState>()
        .settings
        .lock()
        .unwrap()
        .mute_notifications;
    if muted {
        log::info!("carrier:sync-alert suppressed by mute_notifications ({kind:?})");
        return;
    }
    let gate = SYNC_ALERT_GATE.get_or_init(|| Mutex::new(SyncAlertGate::default()));
    let (show, body) = match kind {
        SyncAlertKind::Degraded => (
            gate.lock().unwrap().on_degraded(source, Instant::now()),
            "Messenger is struggling to sync — chats may be out of date. \
             This is usually a Facebook-side problem that recovers on its own.",
        ),
        SyncAlertKind::Recovered => (
            gate.lock().unwrap().on_recovered(source),
            "Messenger sync recovered.",
        ),
    };
    if !show {
        return;
    }
    log::warn!("sync alert notification shown ({kind:?})");

    // A fresh id no message notification uses: clicking just surfaces the
    // window (`on_notification_click` finds no route for it).
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1);
    let title = "Carrier";
    let body = body.to_string();

    #[cfg(target_os = "macos")]
    {
        let _ = app;
        deliver_notification_macos(title, &body, id, None, false);
    }

    #[cfg(target_os = "windows")]
    {
        let app_id = app.config().identifier.clone();
        std::thread::spawn(move || {
            if show_windows_notification(title, &body, None, false, &app_id) {
                on_notification_click(app, id);
            }
        });
    }

    #[cfg(target_os = "linux")]
    std::thread::spawn(move || {
        if matches!(
            show_linux_notification(title, &body, None, false, false),
            LinuxNotificationResponse::Open | LinuxNotificationResponse::OpenComposer
        ) {
            on_notification_click(app, id);
        }
    });
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
    fn sync_alert_gate_limits_degraded_notices_and_pairs_recovery() {
        let mut gate = SyncAlertGate::default();
        let t0 = Instant::now();
        let page = SyncAlertSource::Page;

        assert!(gate.on_degraded(page, t0));
        assert!(gate.on_recovered(page));
        assert!(!gate.on_recovered(page));

        // A flap inside the gap stays silent in both directions.
        assert!(!gate.on_degraded(page, t0 + Duration::from_secs(60)));
        assert!(!gate.on_recovered(page));

        // The suppressed flap did not extend the gap.
        assert!(gate.on_degraded(page, t0 + SYNC_ALERT_MIN_GAP));
        assert!(gate.on_recovered(page));

        // A suppressed repeat does not clear the pairing of a shown notice.
        assert!(gate.on_degraded(page, t0 + SYNC_ALERT_MIN_GAP * 2));
        assert!(!gate.on_degraded(page, t0 + SYNC_ALERT_MIN_GAP * 2 + Duration::from_secs(60)));
        assert!(gate.on_recovered(page));
    }

    #[test]
    fn sync_alert_sources_pair_recovery_independently() {
        let mut gate = SyncAlertGate::default();
        let t0 = Instant::now();

        // The watchdog's exhaustion notice is shown; the page's sync episode
        // ending must not consume its pending recovery pairing.
        assert!(gate.on_degraded(SyncAlertSource::Watchdog, t0));
        assert!(!gate.on_recovered(SyncAlertSource::Page));
        assert!(gate.on_recovered(SyncAlertSource::Watchdog));

        // And the other way around: a transport-recovery report must not
        // consume the page's sync-degraded pairing.
        assert!(gate.on_degraded(SyncAlertSource::Page, t0 + SYNC_ALERT_MIN_GAP));
        assert!(!gate.on_recovered(SyncAlertSource::Watchdog));
        assert!(gate.on_recovered(SyncAlertSource::Page));

        // The min-gap stays global: a watchdog notice inside the gap after a
        // page notice is still suppressed, and gains no pairing.
        assert!(gate.on_degraded(SyncAlertSource::Page, t0 + SYNC_ALERT_MIN_GAP * 2));
        assert!(!gate.on_degraded(
            SyncAlertSource::Watchdog,
            t0 + SYNC_ALERT_MIN_GAP * 2 + Duration::from_secs(60)
        ));
        assert!(!gate.on_recovered(SyncAlertSource::Watchdog));
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
    fn path_avatars_are_skipped_for_private_or_flatpak_notifications() {
        assert!(should_attach_path_avatar(false, false));
        assert!(!should_attach_path_avatar(true, false));
        assert!(!should_attach_path_avatar(false, true));
        assert!(!should_attach_path_avatar(true, true));
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

    #[cfg(target_os = "windows")]
    #[test]
    fn notification_responses_distinguish_activation_from_dismissal() {
        use notify_rust::{CloseReason, NotificationResponse};

        assert!(notification_response_was_clicked(
            &NotificationResponse::Default
        ));
        assert!(notification_response_was_clicked(
            &NotificationResponse::Action("open".into())
        ));
        assert!(notification_response_was_clicked(
            &NotificationResponse::Reply("hello".into())
        ));
        assert!(!notification_response_was_clicked(
            &NotificationResponse::Closed(CloseReason::Dismissed)
        ));
        assert!(!notification_response_was_clicked(
            &NotificationResponse::Closed(CloseReason::Expired)
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_reply_requires_preview_route_id_and_capabilities() {
        let supported = LinuxNotificationCapabilities {
            actions: true,
            inline_reply: true,
        };
        assert!(linux_reply_eligible(false, 7, Some("/t/123/"), supported));
        assert!(!linux_reply_eligible(true, 7, Some("/t/123/"), supported));
        assert!(!linux_reply_eligible(false, 0, Some("/t/123/"), supported));
        assert!(!linux_reply_eligible(false, 7, None, supported));
        assert!(!linux_reply_eligible(
            false,
            7,
            Some("/t/123/"),
            LinuxNotificationCapabilities {
                actions: true,
                inline_reply: false,
            }
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_response_classification_preserves_reply_grace() {
        assert_eq!(
            classify_linux_signal(
                LinuxNotificationSignal::Action("inline-reply".into()),
                false
            ),
            LinuxSignalDecision::AwaitReply
        );
        assert_eq!(
            classify_linux_signal(LinuxNotificationSignal::Closed, true),
            LinuxSignalDecision::Ignore
        );
        assert_eq!(
            classify_linux_signal(LinuxNotificationSignal::Reply("hello".into()), true),
            LinuxSignalDecision::Reply("hello".into())
        );
        assert_eq!(
            classify_linux_signal(LinuxNotificationSignal::Action("default".into()), false),
            LinuxSignalDecision::Open
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_notification_signals_require_the_daemon_owner() {
        assert!(linux_notification_sender_matches(Some(":1.42"), ":1.42"));
        assert!(!linux_notification_sender_matches(Some(":1.99"), ":1.42"));
        assert!(!linux_notification_sender_matches(None, ":1.42"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_notification_hints_follow_sound_and_reply_settings() {
        let audible = linux_notification_hints(true, false);
        assert!(audible.contains_key("sound-name"));
        assert!(!audible.contains_key("suppress-sound"));
        assert!(!audible.contains_key("x-kde-reply-placeholder-text"));

        let silent_reply = linux_notification_hints(false, true);
        assert!(!silent_reply.contains_key("sound-name"));
        assert!(silent_reply.contains_key("suppress-sound"));
        assert!(silent_reply.contains_key("x-kde-reply-placeholder-text"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reply_ack_waiters_route_concurrent_ids_independently() {
        let mut waiters = ReplyAckWaiters::default();
        let (first_tx, first_rx) = std::sync::mpsc::sync_channel(1);
        let (second_tx, second_rx) = std::sync::mpsc::sync_channel(1);
        waiters.register(1, 11, first_tx);
        waiters.register(2, 22, second_tx);
        assert!(!waiters.complete(2, 21, true));
        assert!(waiters.complete(2, 22, true));
        assert!(waiters.complete(1, 11, false));
        assert!(!first_rx.recv().unwrap());
        assert!(second_rx.recv().unwrap());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pending_page_replies_resume_once_and_ignore_stale_results() {
        let now = Instant::now();
        let mut pending = PendingPageReplies::default();
        pending.register(
            7,
            70,
            "/t/123/".into(),
            "reply".into(),
            PendingReplyMode::Send,
            now + Duration::from_secs(1),
        );
        pending.register(
            8,
            80,
            "/t/456/".into(),
            "expired".into(),
            PendingReplyMode::Draft,
            now,
        );

        let resumed = pending.resumable(now);
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].id, 7);
        assert_eq!(resumed[0].attempt, 70);
        assert!(matches!(resumed[0].mode, PendingReplyMode::Send));
        assert!(pending.resumable(now).is_empty());

        pending.complete(7, 69);
        assert!(pending.replies.contains_key(&7));
        pending.complete(7, 70);
        assert!(pending.replies.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reply_text_cap_preserves_unicode_boundaries() {
        let text = "å".repeat(MAX_QUICK_REPLY_CHARS + 1);
        let capped = capped_reply_text(&text);
        assert_eq!(capped.chars().count(), MAX_QUICK_REPLY_CHARS);
        assert!(capped.is_char_boundary(capped.len()));
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

    #[test]
    fn notification_rate_limiter_caps_bursts_and_recovers() {
        let start = Instant::now();
        let mut limiter = NotificationRateLimiter::default();

        for offset in 0..MAX_NOTIFICATIONS_PER_WINDOW {
            assert_eq!(
                limiter.classify(start + Duration::from_millis(offset as u64)),
                RateLimitDecision::Allow
            );
        }
        assert_eq!(
            limiter.classify(start + Duration::from_secs(30)),
            RateLimitDecision::SuppressAndLog
        );
        assert_eq!(
            limiter.classify(start + Duration::from_secs(31)),
            RateLimitDecision::Suppress
        );
        assert_eq!(
            limiter.classify(start + NOTIFICATION_RATE_WINDOW + Duration::from_millis(1)),
            RateLimitDecision::Allow
        );
    }
}
