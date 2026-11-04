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

/// What the page says a conversation announced, or deliberately kept quiet
/// because the conversation is muted. Validated before it touches the ledger.
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

    fn same_conversation(&self, account: &str, thread: &str) -> bool {
        self.account == account && self.thread == thread
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct LedgerEntry {
    #[serde(flatten)]
    message: HandledMessage,
    /// Unix milliseconds when this preview was first handled.
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
    /// The same preview under a changed title is still the same message.
    fn already_handled(&self, message: &HandledMessage, now: u64) -> bool {
        message.is_valid()
            && self.entries.iter().any(|entry| {
                let handled = &entry.message;
                handled.same_conversation(&message.account, &message.thread)
                    && !Self::expired(entry, now)
                    && (handled.fingerprint == message.fingerprint
                        || (!message.body_hash.is_empty()
                            && handled.body_hash == message.body_hash))
            })
    }

    fn record(&mut self, message: &HandledMessage, now: u64) {
        if !message.is_valid() {
            return;
        }
        let current = self.entries.iter().position(|entry| {
            entry
                .message
                .same_conversation(&message.account, &message.thread)
        });
        if let Some(index) = current {
            if self.entries[index].message == *message {
                return;
            }
            self.entries.remove(index);
        }
        self.entries.push(LedgerEntry {
            message: message.clone(),
            at: now,
        });
        let excess = self.entries.len().saturating_sub(LEDGER_LIMIT);
        self.entries.drain(..excess);
        self.persist();
    }

    /// The conversation was read, so an identical future preview is news.
    fn forget(&mut self, account: &str, thread: &str) {
        let before = self.entries.len();
        self.entries
            .retain(|entry| !entry.message.same_conversation(account, thread));
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

pub(crate) fn already_handled(message: &HandledMessage) -> bool {
    ledger().lock().unwrap().already_handled(message, now_ms())
}

pub(crate) fn record(message: &HandledMessage) {
    ledger().lock().unwrap().record(message, now_ms());
}

pub(crate) fn forget(account: &str, threads: &[String]) {
    let mut ledger = ledger().lock().unwrap();
    for thread in threads {
        ledger.forget(account, thread);
    }
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
    fn a_restart_still_recognizes_an_announced_preview() {
        let path = temp_path("restart");
        NotificationLedger::load(path.clone(), 0).record(&message("1", A, B), 0);

        let restarted = NotificationLedger::load(path.clone(), 1);

        assert!(restarted.already_handled(&message("1", A, B), 1));
        // A renamed conversation repeats the same preview under a new title.
        assert!(restarted.already_handled(&message("1", C, B), 1));
        assert!(!restarted.already_handled(&message("1", C, C), 1));
        assert!(!restarted.already_handled(&message("2", A, B), 1));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn reading_a_conversation_lets_an_identical_preview_notify_again() {
        let mut ledger = NotificationLedger::default();
        ledger.record(&message("1", A, B), 0);

        ledger.forget("100", "1");

        assert!(!ledger.already_handled(&message("1", A, B), 0));
    }

    #[test]
    fn old_entries_expire_instead_of_silencing_a_conversation() {
        let mut ledger = NotificationLedger::default();
        ledger.record(&message("1", A, B), 0);

        assert!(ledger.already_handled(&message("1", A, B), ENTRY_MAX_AGE_MS));
        assert!(!ledger.already_handled(&message("1", A, B), ENTRY_MAX_AGE_MS + 1));
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
