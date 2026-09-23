//! Durable, at-most-once scheduled submissions. Persist a claim before touching
//! Messenger; an interrupted claim is uncertain, never automatically replayed.
use std::{io::Write, path::PathBuf, sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{Listener, Manager};

const EVENT: &str = "carrier:scheduled-send";
const GRACE_MS: u64 = 120_000;
const MAX_ITEMS: usize = 100;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Status {
    Draft,
    Scheduled,
    Sending,
    Missed,
    Uncertain,
}

#[derive(Clone, Deserialize, Serialize)]
struct Message {
    id: String,
    account: String,
    thread: String,
    text: String,
    due: u64,
    status: Status,
    #[serde(default)]
    notified: bool,
    #[serde(default)]
    toast_seen: bool,
}

impl Message {
    fn eligible(&self, now: u64) -> bool {
        self.status == Status::Scheduled
            && now >= self.due
            && now <= self.due.saturating_add(GRACE_MS)
    }

    fn expire(&mut self, now: u64) {
        if now > self.due.saturating_add(GRACE_MS) {
            if matches!(self.status, Status::Scheduled | Status::Draft) {
                self.status = Status::Missed;
            } else if self.status == Status::Sending
                && now > self.due.saturating_add(GRACE_MS + 15_000)
            {
                self.status = Status::Uncertain;
            }
        }
    }
}

struct Store {
    path: PathBuf,
    items: Vec<Message>,
    unavailable: bool,
}

impl Store {
    fn load(path: PathBuf) -> Self {
        let loaded = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Vec<Message>>(&bytes).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.to_string()),
        };
        let unavailable = loaded.is_err();
        if unavailable {
            log::error!("scheduled-send store could not be loaded; scheduling disabled");
        }
        Self {
            path,
            items: loaded.unwrap_or_default(),
            unavailable,
        }
    }

    fn persist(&self, items: &[Message]) -> Result<(), String> {
        if self.unavailable {
            return Err("Scheduled messages could not be loaded. Restart Carrier to retry.".into());
        }
        let parent = self.path.parent().ok_or("No schedule directory")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temp = parent.join(format!(".scheduled-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp).map_err(|e| e.to_string())?;
            file.write_all(&serde_json::to_vec(items).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            crate::settings::replace_file(&temp, &self.path).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            std::fs::File::open(parent)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    }

    fn commit(&mut self, items: Vec<Message>) -> Result<(), String> {
        // A failed fsync may already have published the file. Stop all further
        // sends until reload instead of letting memory contradict durable state.
        if let Err(error) = self.persist(&items) {
            self.unavailable = true;
            log::error!("scheduled-send persistence failed: {error}");
            return Err(
                "Could not save scheduled messages. Restart Carrier before retrying.".into(),
            );
        }
        self.items = items;
        Ok(())
    }

    fn apply(
        &mut self,
        request: &Request,
        label: &str,
        now: u64,
    ) -> Result<Option<String>, String> {
        if self.unavailable {
            return Err("Scheduled messages are unavailable. Restart Carrier to retry.".into());
        }
        if !valid_account(&request.account) {
            return Err("Sign in to schedule a message.".into());
        }
        if request.op == "list" {
            return Ok(None);
        }
        let mut items = self.items.clone();
        let mut claimed = None;
        match request.op.as_str() {
            "save" => {
                let text = request.text.as_deref().ok_or("Message is missing")?;
                let thread = request
                    .thread
                    .as_deref()
                    .and_then(crate::actions::validated_thread_path)
                    .ok_or("Invalid conversation")?;
                let due = request.due.ok_or("Choose a send time")?;
                if text.trim().is_empty() || text.chars().count() > 2_000 {
                    return Err("Use 1–2,000 characters for a scheduled message.".into());
                }
                if due <= now || due > now.saturating_add(366 * 24 * 60 * 60 * 1000) {
                    return Err("Choose a future time within one year.".into());
                }
                let id = request
                    .id
                    .clone()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                claimed = Some(id.clone());
                if request.id.is_some() {
                    let item = items
                        .iter_mut()
                        .find(|m| m.id == id && m.account == request.account)
                        .ok_or("Message no longer exists")?;
                    if item.status == Status::Sending {
                        return Err("This message is already being submitted.".into());
                    }
                    *item = Message {
                        id,
                        account: request.account.clone(),
                        thread,
                        text: text.into(),
                        due,
                        status: Status::Scheduled,
                        notified: false,
                        toast_seen: false,
                    };
                } else {
                    if items
                        .iter()
                        .filter(|m| m.account == request.account)
                        .count()
                        >= MAX_ITEMS
                    {
                        return Err("Remove an old scheduled message before adding another.".into());
                    }
                    items.push(Message {
                        id,
                        account: request.account.clone(),
                        thread,
                        text: text.into(),
                        due,
                        status: Status::Draft,
                        notified: false,
                        toast_seen: false,
                    });
                }
            }
            "arm" => {
                let item = items
                    .iter_mut()
                    .find(|m| Some(&m.id) == request.id.as_ref() && m.account == request.account)
                    .ok_or("Message no longer exists")?;
                if item.status != Status::Draft || now >= item.due {
                    return Err("Choose a new send time for this message.".into());
                }
                item.status = Status::Scheduled;
            }
            "claim" => {
                if label != "main" || items.iter().any(|m| m.status == Status::Sending) {
                    return Ok(None);
                }
                let item = items
                    .iter_mut()
                    .find(|m| Some(&m.id) == request.id.as_ref() && m.account == request.account)
                    .ok_or("Message no longer exists")?;
                if !item.eligible(now) {
                    return Ok(None);
                }
                item.status = Status::Sending;
                claimed = Some(item.id.clone());
            }
            "sent" | "missed" | "uncertain" | "defer" => {
                if label != "main" {
                    return Err("Only the main window can submit scheduled messages.".into());
                }
                let index = items
                    .iter()
                    .position(|m| {
                        Some(&m.id) == request.id.as_ref() && m.account == request.account
                    })
                    .ok_or("Message no longer exists")?;
                if items[index].status != Status::Sending || request.due != Some(items[index].due) {
                    return Err("Message is no longer being submitted.".into());
                }
                match request.op.as_str() {
                    "sent" => {
                        items.remove(index);
                    }
                    "defer" if now <= items[index].due.saturating_add(GRACE_MS) => {
                        items[index].status = Status::Scheduled
                    }
                    "uncertain" => items[index].status = Status::Uncertain,
                    _ => items[index].status = Status::Missed,
                }
            }
            "cancel" | "seen" => {
                let index = items
                    .iter()
                    .position(|m| {
                        Some(&m.id) == request.id.as_ref() && m.account == request.account
                    })
                    .ok_or("Message no longer exists")?;
                if request.op == "seen" {
                    if matches!(items[index].status, Status::Missed | Status::Uncertain) {
                        items[index].toast_seen = true;
                    }
                } else {
                    if items[index].status == Status::Sending {
                        return Err("This message is already being submitted.".into());
                    }
                    items.remove(index);
                }
            }
            _ => return Err("Unknown schedule action".into()),
        }
        self.commit(items)?;
        Ok(claimed)
    }
}

fn valid_account(account: &str) -> bool {
    !account.is_empty() && account.len() <= 32 && account.bytes().all(|b| b.is_ascii_digit())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    request: String,
    op: String,
    account: String,
    id: Option<String>,
    thread: Option<String>,
    text: Option<String>,
    due: Option<u64>,
}

#[derive(Serialize)]
struct Reply<'a> {
    request: &'a str,
    data: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn respond(
    app: &tauri::AppHandle,
    label: &str,
    request: &Request,
    outcome: Result<Option<String>, String>,
) {
    let store = app.state::<Mutex<Store>>();
    let store = store.lock().unwrap();
    let rows: Vec<_> = store
        .items
        .iter()
        .filter(|m| m.account == request.account)
        .collect();
    let (claimed, error) = match outcome {
        Ok(id) => (id, None),
        Err(e) => (None, Some(e)),
    };
    let data = serde_json::json!({ "items": rows, "claimed": if request.op == "claim" { claimed.clone() } else { None }, "saved": if request.op == "save" { claimed } else { None }, "error": error, "can_deliver": label == "main" }).to_string();
    let reply = Reply {
        request: &request.request,
        data,
    };
    let event = format!("{EVENT}-result");
    let signature = app
        .state::<crate::AppState>()
        .download_reveal_tokens
        .lock()
        .unwrap()
        .get(label)
        .and_then(|secret| crate::result_signature(secret, &event, &reply));
    if let (Some(signature), Some(window)) = (signature, app.get_webview_window(label)) {
        let detail = serde_json::json!({"request": reply.request, "data": reply.data, "signature": signature});
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('{event}', {{detail:{detail}}}));"
        ));
    }
}

pub(crate) fn install(app: &tauri::AppHandle, single_instance: bool) {
    let Ok(directory) = app.path().app_config_dir() else {
        return;
    };
    // Independent app processes would have independent claim locks. Keep the
    // feature disabled under the existing experimental multi-instance setting.
    if !single_instance {
        return;
    }
    let mut store = Store::load(directory.join("scheduled-messages.json"));
    let mut recovered = store.items.clone();
    let mut changed = false;
    for item in &mut recovered {
        if item.status == Status::Sending {
            item.status = Status::Uncertain;
            changed = true;
        }
    }
    if changed {
        let _ = store.commit(recovered);
    }
    app.manage(Mutex::new(store));
    let handle = app.clone();
    app.listen_any(EVENT, move |event| {
        let Ok(signed) = serde_json::from_str::<crate::SignedAction>(event.payload()) else {
            return;
        };
        let Some(label) = crate::signed_action_window(&handle, EVENT, &signed) else {
            return;
        };
        let Ok(request) = serde_json::from_str::<Request>(&signed.message) else {
            return;
        };
        if request.request.len() != 32 || !request.request.bytes().all(|b| b.is_ascii_hexdigit()) {
            return;
        }
        let outcome =
            handle
                .state::<Mutex<Store>>()
                .lock()
                .unwrap()
                .apply(&request, &label, now_ms());
        respond(&handle, &label, &request, outcome);
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let warn = {
                let state = handle.state::<Mutex<Store>>();
                let mut store = state.lock().unwrap();
                let mut items = store.items.clone();
                let mut changed = false;
                let mut warn = false;
                for item in &mut items {
                    let before = item.status;
                    item.expire(now_ms());
                    changed |= before != item.status;
                    if matches!(item.status, Status::Missed | Status::Uncertain) && !item.notified {
                        item.notified = true;
                        changed = true;
                        warn = true;
                    }
                }
                changed && store.commit(items).is_ok() && warn
            };
            if warn {
                crate::notifications::show_scheduled_send_warning(&handle);
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message() -> Message {
        Message {
            id: "a".into(),
            account: "123".into(),
            thread: "/t/456/".into(),
            text: "hello".into(),
            due: 1_000,
            status: Status::Scheduled,
            notified: false,
            toast_seen: false,
        }
    }
    #[test]
    fn grace_window_is_inclusive_but_never_extends_after_a_miss() {
        let mut m = message();
        assert!(!m.eligible(999));
        assert!(m.eligible(1_000));
        assert!(m.eligible(121_000));
        assert!(!m.eligible(121_001));
        m.expire(121_001);
        assert_eq!(m.status, Status::Missed);
        assert!(!m.eligible(1_000));
    }
    #[test]
    fn interrupted_submission_is_never_retryable() {
        let mut m = message();
        m.status = Status::Sending;
        assert!(!m.eligible(1_000));
        m.expire(136_001);
        assert_eq!(m.status, Status::Uncertain);
        assert!(!m.eligible(1_000));
    }
    #[test]
    fn persistence_and_claims_prevent_duplicate_delivery() {
        let dir =
            std::env::temp_dir().join(format!("carrier-schedule-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("messages.json");
        let mut store = Store::load(path.clone());
        store.commit(vec![message()]).unwrap();
        let mut req = Request {
            request: "a".repeat(32),
            op: "claim".into(),
            account: "123".into(),
            id: Some("a".into()),
            thread: None,
            text: None,
            due: None,
        };
        assert_eq!(store.apply(&req, "win-1", 1_000).unwrap(), None);
        req.account = "999".into();
        assert!(store.apply(&req, "main", 1_000).is_err());
        req.account = "123".into();
        assert_eq!(store.apply(&req, "main", 1_000).unwrap(), Some("a".into()));
        assert_eq!(store.apply(&req, "main", 1_000).unwrap(), None);
        let loaded = Store::load(path);
        assert_eq!(loaded.items[0].status, Status::Sending);
        req.op = "cancel".into();
        assert!(store.apply(&req, "main", 1_000).is_err());
        req.op = "defer".into();
        req.due = Some(1_000);
        store.apply(&req, "main", 121_001).unwrap();
        assert_eq!(store.items[0].status, Status::Missed);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn saved_draft_cannot_send_until_the_composer_clear_is_acknowledged() {
        let dir =
            std::env::temp_dir().join(format!("carrier-schedule-test-{}", uuid::Uuid::new_v4()));
        let mut store = Store::load(dir.join("messages.json"));
        let mut req = Request {
            request: "a".repeat(32),
            op: "save".into(),
            account: "123".into(),
            id: None,
            thread: Some("/t/456/".into()),
            text: Some("hello".into()),
            due: Some(2_000),
        };
        let saved = store.apply(&req, "main", 1_000).unwrap().unwrap();
        assert_eq!(store.items[0].status, Status::Draft);
        req.id = Some(saved.clone());
        req.op = "claim".into();
        assert_eq!(store.apply(&req, "main", 2_000).unwrap(), None);
        req.op = "arm".into();
        store.apply(&req, "main", 1_500).unwrap();
        req.op = "claim".into();
        assert_eq!(store.apply(&req, "main", 2_000).unwrap(), Some(saved));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rescheduling_keeps_existing_message_armed_without_a_second_request() {
        let dir =
            std::env::temp_dir().join(format!("carrier-schedule-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("messages.json");
        let mut store = Store::load(path.clone());
        store.commit(vec![message()]).unwrap();
        let req = Request {
            request: "a".repeat(32),
            op: "save".into(),
            account: "123".into(),
            id: Some("a".into()),
            thread: Some("/t/456/".into()),
            text: Some("hello".into()),
            due: Some(2_000),
        };
        store.apply(&req, "main", 1_000).unwrap();
        let reloaded = Store::load(path);
        assert_eq!(reloaded.items[0].status, Status::Scheduled);
        assert_eq!(reloaded.items[0].due, 2_000);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn schedule_limit_counts_only_the_current_account() {
        let dir =
            std::env::temp_dir().join(format!("carrier-schedule-test-{}", uuid::Uuid::new_v4()));
        let mut store = Store::load(dir.join("messages.json"));
        let mut items = vec![message(); MAX_ITEMS];
        for (index, item) in items.iter_mut().enumerate() {
            item.id = index.to_string();
        }
        store.commit(items).unwrap();
        let mut req = Request {
            request: "a".repeat(32),
            op: "save".into(),
            account: "999".into(),
            id: None,
            thread: Some("/t/456/".into()),
            text: Some("hello".into()),
            due: Some(2_000),
        };
        store.apply(&req, "main", 1_000).unwrap();
        req.account = "123".into();
        assert!(store.apply(&req, "main", 1_000).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn unreadable_store_is_not_overwritten() {
        let dir =
            std::env::temp_dir().join(format!("carrier-schedule-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("messages.json");
        std::fs::write(&path, "broken").unwrap();
        let mut store = Store::load(path.clone());
        assert!(store.commit(Vec::new()).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "broken");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
