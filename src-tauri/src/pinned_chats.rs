//! Pinned chats (Ref #457): the conversations pinned to the top of the chat
//! list, per Facebook account, each with the name the chat list last showed.
//! The page asks for an account's pins, or changes one, with a signed
//! `chatpane:pinned-chats` request and gets the account's pins back signed;
//! a change sends the other Messenger windows `chatpane:pinned-chats-changed`
//! to ask again (inject/src/messenger/features/pinned-chats.ts).
//! They name conversations, so they live in their own file, which Log Out
//! deletes, rather than in settings.json.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Listener, Manager};

const EVENT: &str = "chatpane:pinned-chats";
const CHANGED_EVENT: &str = "chatpane:pinned-chats-changed";
/// Pinned chats, in the config directory.
const STORE_FILE: &str = "pinned-chats.json";
const TEMP_PREFIX: &str = ".pinned-chats-";
/// Mirror `MAX_PINNED_CHATS` and `MAX_PINNED_NAME_CHARS` in
/// `inject/src/messenger/lib/pinned-chats.ts`.
const MAX_PINS: usize = 50;
const MAX_NAME_CHARS: usize = 60;
/// Accounts kept, most recently saved last. The page names the account, so
/// this bounds what it can make Chatpane keep.
const MAX_ACCOUNTS: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Pin {
    id: String,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct AccountPins {
    account: String,
    pins: Vec<Pin>,
}

fn valid_thread_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

fn clean_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_NAME_CHARS)
        .collect()
}

/// Pins from untrusted JSON: valid ids only, each once, in order, capped.
fn pins_from_value(value: &serde_json::Value) -> Vec<Pin> {
    let mut pins: Vec<Pin> = Vec::new();
    for item in value.as_array().into_iter().flatten() {
        if pins.len() >= MAX_PINS {
            break;
        }
        let Some(id) = item.get("id").and_then(|id| id.as_str()) else {
            continue;
        };
        if !valid_thread_id(id) || pins.iter().any(|pin| pin.id == id) {
            continue;
        }
        let name = item
            .get("name")
            .and_then(|name| name.as_str())
            .unwrap_or("");
        pins.push(Pin {
            id: id.to_owned(),
            name: clean_name(name),
        });
    }
    pins
}

#[derive(Debug, Default)]
struct Store {
    accounts: Vec<AccountPins>,
}

impl Store {
    fn from_json(json: &[u8]) -> Self {
        let values: Vec<serde_json::Value> = serde_json::from_slice(json).unwrap_or_default();
        let mut store = Self::default();
        for value in values {
            if let Some(account) = value.get("account").and_then(|a| a.as_str())
                && crate::scheduled_send::valid_account(account)
            {
                let pins = pins_from_value(value.get("pins").unwrap_or(&serde_json::Value::Null));
                store.set(account, pins);
            }
        }
        store
    }

    fn get(&self, account: &str) -> Vec<Pin> {
        self.accounts
            .iter()
            .find(|entry| entry.account == account)
            .map(|entry| entry.pins.clone())
            .unwrap_or_default()
    }

    /// Whether this changed anything.
    fn set(&mut self, account: &str, pins: Vec<Pin>) -> bool {
        let position = self.accounts.iter().position(|e| e.account == account);
        if position.is_some_and(|index| self.accounts[index].pins == pins)
            || (position.is_none() && pins.is_empty())
        {
            return false;
        }
        if let Some(index) = position {
            self.accounts.remove(index);
        }
        if !pins.is_empty() {
            self.accounts.push(AccountPins {
                account: account.to_owned(),
                pins,
            });
            if self.accounts.len() > MAX_ACCOUNTS {
                self.accounts.remove(0);
            }
        }
        true
    }
}

fn save(path: &Path, store: &Store) -> Result<(), String> {
    let parent = path.parent().ok_or("No config directory")?;
    if store.accounts.is_empty() {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec(&store.accounts).map_err(|e| e.to_string())?;
    let temp = parent.join(format!("{TEMP_PREFIX}{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&json)?;
        file.sync_all()?;
        drop(file);
        crate::settings::replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.map_err(|e| e.to_string())
}

/// The store and any temporary file a crash left mid-save (Log Out; Ref #356).
pub(crate) fn account_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = vec![dir.join(STORE_FILE)];
    if let Ok(entries) = std::fs::read_dir(dir) {
        files.extend(entries.flatten().map(|entry| entry.path()).filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(TEMP_PREFIX) && name.ends_with(".tmp"))
        }));
    }
    files
}

/// One change to an account's pins. Pages send changes rather than whole
/// lists, so changes from several windows, or racing a read, all land.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Change {
    Pin { id: String, name: String },
    Unpin { id: String },
    Rename { id: String, name: String },
}

impl Change {
    /// `pins` with this change made, or None when it changes nothing.
    fn apply(&self, pins: &[Pin]) -> Option<Vec<Pin>> {
        let (Change::Pin { id, .. } | Change::Unpin { id } | Change::Rename { id, .. }) = self;
        let index = pins.iter().position(|pin| &pin.id == id);
        let mut next = pins.to_vec();
        match (self, index) {
            (Change::Pin { name, .. }, None) if valid_thread_id(id) && pins.len() < MAX_PINS => {
                next.push(Pin {
                    id: id.clone(),
                    name: clean_name(name),
                });
            }
            (Change::Unpin { .. }, Some(index)) => {
                next.remove(index);
            }
            (Change::Rename { name, .. }, Some(index)) => {
                let name = clean_name(name);
                if name.is_empty() || name == pins[index].name {
                    return None;
                }
                next[index].name = name;
            }
            _ => return None,
        }
        Some(next)
    }
}

#[derive(Deserialize)]
struct Request {
    /// The page's token for the signed reply.
    request: String,
    account: String,
    /// Absent to ask for the account's pins.
    #[serde(flatten)]
    change: Option<Change>,
}

struct PinnedChats {
    path: PathBuf,
    store: Store,
    /// Rises with every change, so a page can drop a snapshot older than the
    /// one it has.
    revision: u64,
}

#[derive(Serialize)]
struct Reply<'a> {
    request: &'a str,
    data: String,
}

/// Answer the requesting window only, signed with its secret (the page checks
/// it with `chatpaneVerifyResult`).
fn reply(app: &tauri::AppHandle, label: &str, request: &str, data: String) {
    let event = format!("{EVENT}-result");
    let reply = Reply { request, data };
    let signature = app
        .state::<crate::AppState>()
        .download_reveal_tokens
        .lock()
        .unwrap()
        .get(label)
        .and_then(|secret| crate::result_signature(secret, &event, &reply));
    if let (Some(signature), Some(window)) = (signature, app.get_webview_window(label)) {
        let detail = serde_json::json!({ "request": reply.request, "data": reply.data, "signature": signature });
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('{event}', {{ detail: {detail} }}));"
        ));
    }
}

/// Tell the other Messenger windows to ask again. It carries nothing, so a
/// page script faking it only causes a signed request.
fn announce_change(app: &tauri::AppHandle, except: &str) {
    let script = format!("window.dispatchEvent(new Event('{CHANGED_EVENT}'));");
    for (label, window) in app.webview_windows() {
        if label != except && crate::window::is_messenger_window_label(&label) {
            let _ = window.eval(&script);
        }
    }
}

pub(crate) fn install(app: &tauri::AppHandle) {
    let Ok(directory) = app.path().app_config_dir() else {
        return;
    };
    let path = directory.join(STORE_FILE);
    let store = std::fs::read(&path)
        .map(|json| Store::from_json(&json))
        .unwrap_or_default();
    app.manage(Mutex::new(PinnedChats {
        path,
        store,
        revision: 1,
    }));
    let handle = app.clone();
    app.listen_any(EVENT, move |event| {
        // Any script on a granted origin can emit this event, so only
        // Chatpane's signed requests are answered.
        let Ok(signed) = serde_json::from_str::<crate::SignedAction>(event.payload()) else {
            return;
        };
        let Some(label) = crate::signed_action_window(&handle, EVENT, &signed) else {
            return;
        };
        let Ok(request) = serde_json::from_str::<Request>(&signed.message) else {
            return;
        };
        if request.request.len() != 32
            || !request.request.bytes().all(|b| b.is_ascii_hexdigit())
            || !crate::scheduled_send::valid_account(&request.account)
        {
            return;
        }
        let handle = handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = handle.state::<Mutex<PinnedChats>>();
            // Answer under the lock, so snapshots leave in the order they were made.
            let mut pinned = state.lock().unwrap();
            let mut changed = false;
            if let Some(next) = request
                .change
                .as_ref()
                .and_then(|change| change.apply(&pinned.store.get(&request.account)))
                && pinned.store.set(&request.account, next)
            {
                changed = true;
                pinned.revision += 1;
                if let Err(e) = save(&pinned.path, &pinned.store) {
                    log::error!("failed to save pinned chats: {e}");
                }
            }
            let data = serde_json::json!({
                "revision": pinned.revision,
                "pins": pinned.store.get(&request.account),
            })
            .to_string();
            reply(&handle, &label, &request.request, data);
            if changed {
                announce_change(&handle, &label);
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(id: &str, name: &str) -> Pin {
        Pin {
            id: id.into(),
            name: name.into(),
        }
    }

    #[test]
    fn untrusted_pins_are_cleaned_deduplicated_and_capped() {
        let pins = pins_from_value(&serde_json::json!([
            { "id": "12", "name": "  Ada \n Lovelace  " },
            { "id": "12", "name": "again" },
            { "id": "x1", "name": "bad id" },
            { "id": "34" },
            "junk",
            { "id": "56", "name": "n".repeat(200) },
        ]));
        assert_eq!(
            pins,
            vec![
                pin("12", "Ada Lovelace"),
                pin("34", ""),
                pin("56", &"n".repeat(MAX_NAME_CHARS))
            ]
        );
        let many: Vec<_> = (0..MAX_PINS + 5)
            .map(|i| serde_json::json!({ "id": i.to_string(), "name": "" }))
            .collect();
        assert_eq!(pins_from_value(&serde_json::json!(many)).len(), MAX_PINS);
        assert!(pins_from_value(&serde_json::json!({ "id": "1" })).is_empty());
    }

    #[test]
    fn changes_apply_to_the_stored_pins() {
        let change = |json: serde_json::Value| serde_json::from_value::<Change>(json).unwrap();
        let pins = vec![pin("1", "Ada")];
        let pinned = change(serde_json::json!({ "op": "pin", "id": "2", "name": " Grace " }))
            .apply(&pins)
            .unwrap();
        assert_eq!(pinned, vec![pin("1", "Ada"), pin("2", "Grace")]);
        assert!(
            change(serde_json::json!({ "op": "pin", "id": "1", "name": "again" }))
                .apply(&pins)
                .is_none()
        );
        assert!(
            change(serde_json::json!({ "op": "pin", "id": "x", "name": "" }))
                .apply(&pins)
                .is_none()
        );
        let full: Vec<_> = (0..MAX_PINS).map(|i| pin(&i.to_string(), "")).collect();
        assert!(
            change(serde_json::json!({ "op": "pin", "id": "999", "name": "" }))
                .apply(&full)
                .is_none()
        );
        assert_eq!(
            change(serde_json::json!({ "op": "unpin", "id": "1" })).apply(&pins),
            Some(vec![])
        );
        assert!(
            change(serde_json::json!({ "op": "unpin", "id": "2" }))
                .apply(&pins)
                .is_none()
        );
        assert_eq!(
            change(serde_json::json!({ "op": "rename", "id": "1", "name": "Ada L" })).apply(&pins),
            Some(vec![pin("1", "Ada L")])
        );
        assert!(
            change(serde_json::json!({ "op": "rename", "id": "1", "name": "  " }))
                .apply(&pins)
                .is_none()
        );
        // A read carries no change.
        let read: Request =
            serde_json::from_value(serde_json::json!({ "request": "r", "account": "1" })).unwrap();
        assert!(read.change.is_none());
    }

    #[test]
    fn saving_an_account_moves_it_last_and_drops_empty_and_oldest() {
        let mut store = Store::default();
        assert!(!store.set("1", vec![]));
        assert!(store.set("1", vec![pin("10", "a")]));
        assert!(!store.set("1", vec![pin("10", "a")]));
        assert!(store.set("2", vec![pin("20", "b")]));
        assert!(store.set("1", vec![pin("11", "c")]));
        let order: Vec<_> = store.accounts.iter().map(|e| e.account.as_str()).collect();
        assert_eq!(order, ["2", "1"]);
        assert!(store.set("2", vec![]));
        assert_eq!(store.get("2"), vec![]);
        for account in 100..100 + MAX_ACCOUNTS {
            store.set(&account.to_string(), vec![pin("1", "")]);
        }
        assert_eq!(store.accounts.len(), MAX_ACCOUNTS);
        assert!(store.get("1").is_empty(), "the oldest account was dropped");
    }

    #[test]
    fn store_round_trips_and_rejects_bad_accounts() {
        let mut store = Store::default();
        store.set("123", vec![pin("10", "Ada")]);
        let json = serde_json::to_vec(&store.accounts).unwrap();
        assert_eq!(Store::from_json(&json).get("123"), vec![pin("10", "Ada")]);
        let hostile = br#"[{"account":"me","pins":[{"id":"1","name":"x"}]},{"account":"5"}]"#;
        assert!(Store::from_json(hostile).accounts.is_empty());
        assert!(Store::from_json(b"not json").accounts.is_empty());
    }

    #[test]
    fn saving_writes_the_file_and_removes_it_when_empty() {
        let dir = std::env::temp_dir().join(format!("chatpane-pins-{}", uuid::Uuid::new_v4()));
        let path = dir.join(STORE_FILE);
        let mut store = Store::default();
        store.set("123", vec![pin("10", "Ada")]);
        save(&path, &store).unwrap();
        assert_eq!(
            Store::from_json(&std::fs::read(&path).unwrap()).get("123"),
            vec![pin("10", "Ada")]
        );
        assert_eq!(account_files(&dir), vec![path.clone()]);
        store.set("123", vec![]);
        save(&path, &store).unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
