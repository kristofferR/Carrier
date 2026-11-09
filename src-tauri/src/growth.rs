//! Sharing Chatpane and the one-time GitHub star prompt.
//!
//! Chatpane counts the days its main window gains focus (in settings, since
//! Facebook clears unknown localStorage on Mac page loads). Once the window
//! has been used on [`STAR_PROMPT_DAYS_USED`] days and the first use is
//! [`STAR_PROMPT_MIN_AGE_DAYS`] old, each focus asks the page to show the
//! star toast; the page only does so at a quiet moment
//! (`inject/src/panel/star-prompt.ts`) and reports `shown`, after which it
//! never asks again.

use serde::{Deserialize, Serialize};
use tauri::{Listener, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::settings::{AppState, SaveOutcome, save_settings};

/// The landing page; the link people share.
pub(crate) const SITE_URL: &str = "https://chatpane.app/";
/// GitHub redirects this after a repository rename.
pub(crate) const REPO_URL: &str = "https://github.com/kristofferR/Carrier";

const STAR_PROMPT_DAYS_USED: u32 = 14;
const STAR_PROMPT_MIN_AGE_DAYS: i32 = 21;
const EVENT: &str = "chatpane:star-prompt";

/// The confirmation shown after the share message is copied.
pub(crate) const SHARE_COPIED: &str = "Copied. Paste it to anyone you like.";

pub(crate) fn share_message() -> String {
    format!(
        "I use {} for Messenger on my computer. It's free and open source: {SITE_URL}",
        crate::i18n::APP_NAME
    )
}

/// Days the main window was used and whether the star prompt has run.
/// Owned by the native side: Settings saves and resets keep it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Usage {
    /// Local calendar days (days since 0001-01-01) of the first and latest use.
    first_day: Option<i32>,
    last_day: Option<i32>,
    /// Distinct days with a recorded use.
    days: u32,
    /// The prompt was shown; it is never shown again.
    star_prompt_done: bool,
}

impl Usage {
    /// This usage with `today` counted, or None when today already counts.
    fn recorded(self, today: i32) -> Option<Self> {
        (self.last_day != Some(today)).then(|| Self {
            first_day: Some(self.first_day.unwrap_or(today)),
            last_day: Some(today),
            days: self.days.saturating_add(1),
            ..self
        })
    }

    fn star_prompt_due(&self, today: i32) -> bool {
        !self.star_prompt_done
            && self.days >= STAR_PROMPT_DAYS_USED
            && self
                .first_day
                .is_some_and(|first| today - first >= STAR_PROMPT_MIN_AGE_DAYS)
    }
}

/// Lenient, so a malformed entry restarts the count instead of failing the
/// whole settings file.
pub(crate) fn deserialize_usage<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Usage, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(deserializer)?).unwrap_or_default())
}

fn today() -> i32 {
    use chrono::Datelike;
    chrono::Local::now().date_naive().num_days_from_ce()
}

/// The main window gained focus: count today, and ask the page for the star
/// prompt when it is due.
pub(crate) fn main_focused(app: &tauri::AppHandle) {
    let today = today();
    let mut usage = app.state::<AppState>().settings.lock().unwrap().usage;
    if let Some(recorded) = usage.recorded(today) {
        update_usage(app, move |usage| usage.recorded(today));
        // Judge today's focus with today counted.
        usage = recorded;
    }
    if usage.star_prompt_due(today)
        && let Some(main) = app.get_webview_window("main")
    {
        let Ok(name) = serde_json::to_string(crate::i18n::APP_NAME) else {
            return;
        };
        let _ = main.eval(format!(
            "window.__chatpaneStarPrompt && window.__chatpaneStarPrompt({name})"
        ));
    }
}

/// Apply `change` to the newest usage and save it, off the UI thread.
fn update_usage(
    app: &tauri::AppHandle,
    change: impl FnOnce(Usage) -> Option<Usage> + Send + 'static,
) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let worker = handle.clone();
        let state = handle.state::<AppState>();
        let _settings_worker = state.settings_worker.lock().await;
        let result = tauri::async_runtime::spawn_blocking(move || {
            let state = worker.state::<AppState>();
            let mut next = state.settings.lock().unwrap().clone();
            let Some(usage) = change(next.usage) else {
                return;
            };
            next.usage = usage;
            match save_settings(&worker, &next) {
                Ok(SaveOutcome::Written) => state.settings.lock().unwrap().usage = usage,
                Ok(SaveOutcome::Superseded) => log::warn!("usage update was superseded"),
                Err(error) => log::warn!("failed to save usage: {error}"),
            }
        })
        .await;
        if let Err(error) = result {
            log::warn!("usage worker failed: {error}");
        }
    });
}

pub(crate) fn open_repo(app: &tauri::AppHandle) {
    if let Err(error) = app.opener().open_url(REPO_URL, None::<&str>) {
        log::warn!("failed to open the GitHub repository: {error}");
    }
}

pub(crate) fn copy_share_message(app: &tauri::AppHandle) -> Result<(), String> {
    app.clipboard()
        .write_text(share_message())
        .map_err(|error| format!("Couldn't copy: {error}"))
}

/// The page's signed reports from the star toast: `shown` ends the prompt for
/// good, `star` is a trusted click on its button.
pub(crate) fn install(app: &tauri::AppHandle) {
    #[derive(Deserialize)]
    struct Message {
        action: String,
    }

    let handle = app.clone();
    app.listen_any(EVENT, move |event| {
        let Ok(signed) = serde_json::from_str::<crate::SignedAction>(event.payload()) else {
            return;
        };
        if crate::signed_action_window(&handle, EVENT, &signed).is_none() {
            log::warn!("{EVENT} was not authorized");
            return;
        }
        let Ok(message) = serde_json::from_str::<Message>(&signed.message) else {
            return;
        };
        match message.action.as_str() {
            "shown" => update_usage(&handle, |usage| {
                (!usage.star_prompt_done).then_some(Usage {
                    star_prompt_done: true,
                    ..usage
                })
            }),
            "star" => {
                let h = handle.clone();
                tauri::async_runtime::spawn_blocking(move || open_repo(&h));
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_each_day_once() {
        let usage = Usage::default().recorded(100).unwrap();
        assert_eq!((usage.first_day, usage.days), (Some(100), 1));
        assert_eq!(usage.recorded(100), None);
        let usage = usage.recorded(103).unwrap();
        assert_eq!(
            (usage.first_day, usage.last_day, usage.days),
            (Some(100), Some(103), 2)
        );
    }

    #[test]
    fn star_prompt_waits_for_days_used_and_age_then_never_repeats() {
        let used = |days, first| Usage {
            first_day: Some(first),
            last_day: Some(first + 30),
            days,
            star_prompt_done: false,
        };
        assert!(used(14, 0).star_prompt_due(21));
        assert!(!used(13, 0).star_prompt_due(21), "too few days used");
        assert!(!used(14, 0).star_prompt_due(20), "first use too recent");
        let done = Usage {
            star_prompt_done: true,
            ..used(40, 0)
        };
        assert!(!done.star_prompt_due(100));
        assert!(!Usage::default().star_prompt_due(100));
    }

    #[test]
    fn malformed_usage_restarts_the_count() {
        #[derive(Deserialize)]
        struct Wrapper {
            #[serde(deserialize_with = "deserialize_usage")]
            usage: Usage,
        }
        for junk in [r#""junk""#, r#"{"days": "many"}"#] {
            let parsed: Wrapper = serde_json::from_str(&format!(r#"{{"usage": {junk}}}"#)).unwrap();
            assert_eq!(parsed.usage, Usage::default());
        }
        let parsed: Wrapper =
            serde_json::from_str(r#"{"usage": {"days": 3, "star_prompt_done": true}}"#).unwrap();
        assert_eq!(parsed.usage.days, 3);
        assert!(parsed.usage.star_prompt_done);
    }
}
