//! Requests that Messenger's own page answers for Chatpane: reading and
//! changing the account's Messenger settings (Active Status, read receipts,
//! Do Not Disturb; Ref #358), and Messenger's own sound for Chatpane's sound
//! list. Native asks the main Messenger window through
//! `window.__chatpaneAccount`, and the page reports back on
//! `chatpane:account-result`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Listener;
use tokio::sync::oneshot;

const RESULT_EVENT: &str = "chatpane:account-result";
/// Reading may first load the code of Messenger's Preferences dialog.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Deserialize)]
struct PageReply {
    request: String,
    ok: bool,
    #[serde(default)]
    state: serde_json::Value,
    #[serde(default)]
    error: Option<String>,
}

type Pending = Mutex<HashMap<String, oneshot::Sender<PageReply>>>;

fn pending() -> &'static Pending {
    static PENDING: OnceLock<Pending> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

pub(crate) fn install(app: &tauri::AppHandle) {
    app.listen_any(RESULT_EVENT, |event| {
        let Ok(reply) = serde_json::from_str::<PageReply>(event.payload()) else {
            log::warn!("{RESULT_EVENT} payload did not parse");
            return;
        };
        // Content-free: the account's setting values, or why Messenger refused.
        log::info!(
            "account request answered: ok={} state={} error={:?}",
            reply.ok,
            reply.state,
            reply.error
        );
        if let Some(sender) = pending().lock().unwrap().remove(&reply.request) {
            let _ = sender.send(reply);
        }
    });
}

/// Runs `action` in the main Messenger page and returns what it reports.
pub(crate) async fn page_request(
    app: &tauri::AppHandle,
    action: &str,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let window = crate::menu::target_window(app).ok_or(crate::i18n::t("account.error.not_open"))?;
    let request = uuid::Uuid::new_v4().simple().to_string();
    let (sender, receiver) = oneshot::channel();
    pending().lock().unwrap().insert(request.clone(), sender);
    let args = serde_json::json!([request, action, value]);
    let loading = serde_json::Value::from(crate::i18n::t("account.error.still_loading"));
    // The page may be loading or showing an error page without Chatpane's
    // scripts; answer for it then, so Settings doesn't wait for the timeout.
    let script = format!(
        "(() => {{ const a = {args}; if (window.__chatpaneAccount) window.__chatpaneAccount(...a); \
         else window.__TAURI_INTERNALS__?.invoke('plugin:event|emit', {{ event: '{RESULT_EVENT}', \
         payload: {{ request: a[0], ok: false, error: {loading} }} }}); }})()"
    );
    let outcome = match window.eval(script) {
        Ok(()) => tokio::time::timeout(REQUEST_TIMEOUT, receiver).await.ok(),
        Err(error) => {
            log::warn!("failed to ask the page for {action}: {error}");
            None
        }
    };
    pending().lock().unwrap().remove(&request);
    match outcome {
        Some(Ok(reply)) if reply.ok => Ok(reply.state),
        Some(Ok(reply)) => Err(reply
            .error
            .unwrap_or_else(|| crate::i18n::t("account.error.refused").into())),
        _ => Err(crate::i18n::t("account.error.no_answer").into()),
    }
}

/// Messenger's own settings for the signed-in account. Each is null when
/// Messenger did not report it.
#[derive(Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessengerAccountState {
    active_status: Option<bool>,
    /// Do Not Disturb end in seconds since 1970: 0 off, -1 until turned off.
    dnd_until: Option<i64>,
    /// Whether people see when you've read their messages, and you theirs.
    read_receipts: Option<bool>,
}

/// One change Settings asks for.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "setting", content = "value", rename_all = "camelCase")]
pub(crate) enum MessengerAccountChange {
    ActiveStatus(bool),
    /// Minutes: 0 turns it off, -1 until turned off.
    DoNotDisturb(i64),
    ReadReceipts(bool),
}

impl MessengerAccountChange {
    fn page_action(&self) -> Result<(&'static str, serde_json::Value), String> {
        Ok(match *self {
            Self::ActiveStatus(on) => ("set-active-status", on.into()),
            Self::ReadReceipts(on) => ("set-read-receipts", on.into()),
            Self::DoNotDisturb(minutes)
                if minutes == -1 || (0..=7 * 24 * 60).contains(&minutes) =>
            {
                ("set-dnd", minutes.into())
            }
            Self::DoNotDisturb(_) => {
                return Err(crate::i18n::t("account.error.unsupported_dnd").into());
            }
        })
    }
}

fn parse_state(value: serde_json::Value) -> Result<MessengerAccountState, String> {
    serde_json::from_value(value)
        .map_err(|_| crate::i18n::t("account.error.unexpected_answer").into())
}

/// Settings → Account: read Messenger's own account settings.
#[tauri::command]
pub(crate) async fn messenger_account(
    app: tauri::AppHandle,
) -> Result<MessengerAccountState, String> {
    parse_state(page_request(&app, "read", serde_json::Value::Null).await?)
}

/// Settings → Account: change one setting, then return the state Messenger
/// reports afterwards.
#[tauri::command]
pub(crate) async fn set_messenger_account(
    app: tauri::AppHandle,
    change: MessengerAccountChange,
) -> Result<MessengerAccountState, String> {
    let (action, value) = change.page_action()?;
    parse_state(page_request(&app, action, value).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_parse_from_settings_and_bound_dnd() {
        let change: MessengerAccountChange =
            serde_json::from_str(r#"{"setting":"activeStatus","value":false}"#).unwrap();
        assert_eq!(
            change.page_action().unwrap(),
            ("set-active-status", false.into())
        );
        let change: MessengerAccountChange =
            serde_json::from_str(r#"{"setting":"readReceipts","value":true}"#).unwrap();
        assert_eq!(
            change.page_action().unwrap(),
            ("set-read-receipts", true.into())
        );
        let change: MessengerAccountChange =
            serde_json::from_str(r#"{"setting":"doNotDisturb","value":-1}"#).unwrap();
        assert_eq!(change.page_action().unwrap(), ("set-dnd", (-1).into()));
        assert!(
            MessengerAccountChange::DoNotDisturb(-5)
                .page_action()
                .is_err()
        );
        assert!(
            serde_json::from_str::<MessengerAccountChange>(
                r#"{"setting":"activeStatus","value":"on"}"#
            )
            .is_err()
        );
    }
}
