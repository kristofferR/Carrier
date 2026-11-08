//! Durable record of the message each conversation last announced.
//!
//! The page decides when a conversation has news, but its memory dies with the
//! document: Facebook's macOS client deletes Carrier's localStorage on every
//! load, and a rebuilt window or a restart has no session storage either. A
//! re-hydrated unread row would then notify again. Every banner passes through
//! the native side, so this ledger is shared by all windows and survives
//! reloads, rebuilds and restarts. It holds account and conversation ids and
//! opaque preview hashes, never message text.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

const LEDGER_FILE: &str = "notification-ledger.json";
const LEDGER_LIMIT: usize = 1000;
/// A conversation read while Carrier was closed never reports that read, so
/// its entry expires instead of silencing an identical preview forever.
const ENTRY_MAX_AGE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// A conversation preview the page says it announced. Validated before it
/// touches the ledger.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct HandledMessage {
    #[serde(default)]
    pub(crate) account: String,
    #[serde(default)]
    pub(crate) thread: String,
    /// Hash of the conversation title and preview.
    #[serde(default)]
    pub(crate) fingerprint: String,
    /// Hash of the preview alone, so a renamed conversation is not news.
    #[serde(default)]
    pub(crate) body_hash: String,
}

impl HandledMessage {
    fn is_valid(&self) -> bool {
        let id = |value: &str| {
            !value.is_empty() && value.len() <= 32 && value.bytes().all(|b| b.is_ascii_digit())
        };
        let hash = |value: &str| value.len() == 16 && value.bytes().all(|b| b.is_ascii_hexdigit());
        id(&self.account)
            && id(&self.thread)
            && hash(&self.fingerprint)
            && (self.body_hash.is_empty() || hash(&self.body_hash))
    }

    fn same_conversation(&self, other: &HandledMessage) -> bool {
        self.account == other.account && self.thread == other.thread
    }

    /// The same preview in the same conversation. A changed title alone does
    /// not make it a different message.
    fn same_preview(&self, other: &HandledMessage) -> bool {
        self.same_conversation(other)
            && (self.fingerprint == other.fingerprint
                || (!other.body_hash.is_empty() && self.body_hash == other.body_hash))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct LedgerEntry {
    #[serde(flatten)]
    message: HandledMessage,
    /// Unix milliseconds when this preview was last announced.
    at: u64,
}

#[derive(Default)]
struct NotificationLedger {
    /// Oldest first, at most one entry per conversation.
    entries: Vec<LedgerEntry>,
    /// None keeps the ledger in memory (tests, or no data directory).
    path: Option<PathBuf>,
}

impl NotificationLedger {
    fn load(path: PathBuf, now: u64) -> Self {
        let mut entries: Vec<LedgerEntry> = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        entries.retain(|entry| entry.message.is_valid() && !Self::expired(entry, now));
        let excess = entries.len().saturating_sub(LEDGER_LIMIT);
        entries.drain(..excess);
        Self {
            entries,
            path: Some(path),
        }
    }

    fn expired(entry: &LedgerEntry, now: u64) -> bool {
        now.saturating_sub(entry.at) > ENTRY_MAX_AGE_MS
    }

    /// Whether `message` is the preview its conversation already announced.
    /// `read_at` is when the page confirmed the conversation read before this
    /// arrival (0 if it did not): an announcement from before that read covered
    /// an earlier message. One from after it is another window's claim on this
    /// same arrival. Every announcement happens while its row is unread, and a
    /// read is confirmed only after the row renders read for a while, so the
    /// two never overlap.
    fn already_handled(&self, message: &HandledMessage, read_at: u64, now: u64) -> bool {
        message.is_valid()
            && self.entries.iter().any(|entry| {
                entry.message.same_preview(message)
                    && !Self::expired(entry, now)
                    && entry.at >= read_at
            })
    }

    fn record(&mut self, message: &HandledMessage, now: u64) {
        if !message.is_valid() {
            return;
        }
        self.entries
            .retain(|entry| !entry.message.same_conversation(message));
        self.entries.push(LedgerEntry {
            message: message.clone(),
            at: now,
        });
        let excess = self.entries.len().saturating_sub(LEDGER_LIMIT);
        self.entries.drain(..excess);
        self.persist();
    }

    /// The page confirmed the conversation read, rendering read since `since`.
    /// Whatever it announced before then, even if a reply has replaced that
    /// preview, the read covered, so an identical future preview is news. A
    /// later delivery, from another window, stays.
    fn forget(&mut self, account: &str, thread: &str, since: u64) {
        let before = self.entries.len();
        self.entries.retain(|entry| {
            let handled = &entry.message;
            !(handled.account == account && handled.thread == thread && entry.at < since)
        });
        if self.entries.len() != before {
            self.persist();
        }
    }

    fn persist(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let write = || -> std::io::Result<()> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
            std::fs::write(&temp, serde_json::to_vec(&self.entries)?)?;
            std::fs::rename(&temp, path).inspect_err(|_| {
                let _ = std::fs::remove_file(&temp);
            })
        };
        if let Err(error) = write() {
            log::warn!("failed to save the notification ledger: {error}");
        }
    }
}

static LEDGER: OnceLock<Mutex<NotificationLedger>> = OnceLock::new();

fn ledger() -> &'static Mutex<NotificationLedger> {
    LEDGER.get_or_init(Mutex::default)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// The ledger in `dir` and any snapshot a crash left mid-save (Log Out and
/// Reset; Ref #356).
pub(crate) fn account_files(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut files = vec![dir.join(LEDGER_FILE)];
    if let Ok(entries) = std::fs::read_dir(dir) {
        files.extend(entries.flatten().map(|entry| entry.path()).filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(LEDGER_FILE) && name.ends_with(".tmp"))
        }));
    }
    files
}

/// Load the saved ledger. Call once at startup, before any window can notify.
pub(crate) fn init(app: &tauri::AppHandle) {
    let Ok(directory) = app.path().app_data_dir() else {
        log::warn!("no data directory; the notification ledger lasts this session only");
        return;
    };
    let _ = LEDGER.set(Mutex::new(NotificationLedger::load(
        directory.join(LEDGER_FILE),
        now_ms(),
    )));
}

pub(crate) fn already_handled(message: &HandledMessage, read_at: u64) -> bool {
    ledger()
        .lock()
        .unwrap()
        .already_handled(message, read_at, now_ms())
}

pub(crate) fn record(message: &HandledMessage) {
    ledger().lock().unwrap().record(message, now_ms());
}

pub(crate) fn forget(account: &str, thread: &str, since: u64) {
    ledger().lock().unwrap().forget(account, thread, since);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(thread: &str, fingerprint: &str, body_hash: &str) -> HandledMessage {
        HandledMessage {
            account: "100".into(),
            thread: thread.into(),
            fingerprint: fingerprint.into(),
            body_hash: body_hash.into(),
        }
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("carrier-ledger-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join(LEDGER_FILE)
    }

    const A: &str = "aaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccc";

    #[test]
    fn reset_covers_the_ledger_and_its_crash_snapshots_only() {
        let path = temp_path("reset");
        let dir = path.parent().unwrap();
        std::fs::create_dir_all(dir).unwrap();
        let snapshot = dir.join(format!("{LEDGER_FILE}.42.tmp"));
        std::fs::write(&snapshot, b"{}").unwrap();
        std::fs::write(dir.join("settings.json"), b"{}").unwrap();

        let mut files = account_files(dir);
        files.sort();
        assert_eq!(files, vec![path.clone(), snapshot]);
    }

    #[test]
    fn a_restart_still_recognizes_an_announced_preview() {
        let path = temp_path("restart");
        NotificationLedger::load(path.clone(), 0).record(&message("1", A, B), 0);

        let restarted = NotificationLedger::load(path.clone(), 1);

        assert!(restarted.already_handled(&message("1", A, B), 0, 1));
        // A renamed conversation repeats the same preview under a new title.
        assert!(restarted.already_handled(&message("1", C, B), 0, 1));
        assert!(!restarted.already_handled(&message("1", C, C), 0, 1));
        assert!(!restarted.already_handled(&message("2", A, B), 0, 1));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_read_retires_what_came_before_it_but_not_a_later_delivery() {
        let mut ledger = NotificationLedger::default();
        ledger.record(&message("1", A, B), 100);
        // Rendering read since 200, even with a reply as the preview by now.
        ledger.forget("100", "1", 200);
        assert!(!ledger.already_handled(&message("1", A, B), 0, 300));

        // Another window recorded a new message after this read began.
        ledger.record(&message("1", C, C), 300);
        ledger.forget("100", "1", 250);
        assert!(ledger.already_handled(&message("1", C, C), 0, 301));
    }

    #[test]
    fn old_entries_expire_and_a_redelivery_renews_them() {
        let mut ledger = NotificationLedger::default();
        ledger.record(&message("1", A, B), 0);
        assert!(ledger.already_handled(&message("1", A, B), 0, ENTRY_MAX_AGE_MS));
        assert!(!ledger.already_handled(&message("1", A, B), 0, ENTRY_MAX_AGE_MS + 1));

        ledger.record(&message("1", A, B), ENTRY_MAX_AGE_MS + 1);

        assert!(ledger.already_handled(&message("1", A, B), 0, ENTRY_MAX_AGE_MS + 2));
    }

    #[test]
    fn an_identical_message_after_a_read_notifies_once_across_windows() {
        let mut ledger = NotificationLedger::default();
        ledger.record(&message("1", A, B), 100);

        // Read confirmed at 200; the identical message arrives at 300.
        assert!(!ledger.already_handled(&message("1", A, B), 200, 300));
        ledger.record(&message("1", A, B), 300);
        // Another window confirmed the same read and claims the same arrival.
        assert!(ledger.already_handled(&message("1", A, B), 210, 305));
    }

    #[test]
    fn malformed_claims_never_touch_the_ledger() {
        let mut ledger = NotificationLedger::default();
        let mut bad = message("1", A, B);
        bad.account.clear();
        ledger.record(&bad, 0);
        ledger.record(&message("/t/1/", A, B), 0);
        ledger.record(&message("1", "not-a-hash", B), 0);

        assert!(ledger.entries.is_empty());
    }
}
