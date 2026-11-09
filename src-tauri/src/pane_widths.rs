//! Dragged widths of the chat list and details panes (resizable panes, see
//! `inject/src/messenger/features/pane-resize.ts`). After a drag the page
//! reports both widths with `chatpane:pane-widths`; they are kept in settings,
//! because Facebook clears unknown localStorage keys on Mac page loads, and
//! pushed back to every Messenger page when it loads.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{Listener, Manager};

use crate::settings::{AppState, SaveOutcome, save_settings};

const EVENT: &str = "chatpane:pane-widths";

/// Sanity bounds in CSS pixels. Mirrors `PANE_WIDTH_MIN/MAX` in
/// `inject/src/messenger/lib/pane-resize.ts`.
const PANE_WIDTH_MIN: u32 = 160;
const PANE_WIDTH_MAX: u32 = 1600;

/// None is Facebook's own width.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub(crate) struct PaneWidths {
    pub(crate) list: Option<u32>,
    pub(crate) details: Option<u32>,
}

fn width(value: Option<&serde_json::Value>) -> Option<u32> {
    let value = value?.as_f64().filter(|value| value.is_finite())?;
    // Clamped in f64 first, so the cast cannot overflow.
    Some(
        value
            .round()
            .clamp(f64::from(PANE_WIDTH_MIN), f64::from(PANE_WIDTH_MAX)) as u32,
    )
}

impl PaneWidths {
    /// Widths from untrusted JSON (the page's event, or a hand-edited
    /// settings.json): finite numbers are clamped, anything else is None.
    fn from_value(value: &serde_json::Value) -> Self {
        Self {
            list: width(value.get("list")),
            details: width(value.get("details")),
        }
    }
}

/// Lenient, so a malformed entry resets the widths instead of failing the
/// whole settings file.
impl<'de> Deserialize<'de> for PaneWidths {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::from_value(&serde_json::Value::deserialize(
            deserializer,
        )?))
    }
}

/// Hand `widths` to a Messenger page: its settings snapshot, the snapshot's
/// reload cache, and a `chatpane:pane-widths` event for the feature.
pub(crate) fn push(window: &tauri::WebviewWindow, widths: PaneWidths) {
    let Ok(json) = serde_json::to_string(&widths) else {
        return;
    };
    let _ = window.eval(format!(
        "(function () {{ var w = {json}; var s = window.__CHATPANE_SETTINGS__; \
         if (s && typeof s === 'object') s.pane_widths = w; \
         try {{ var c = JSON.parse(localStorage.getItem('__chatpane_settings') || 'null'); \
         if (c && typeof c === 'object' && !Array.isArray(c)) {{ c.pane_widths = w; \
         localStorage.setItem('__chatpane_settings', JSON.stringify(c)); }} }} catch (e) {{}} \
         window.dispatchEvent(new Event('chatpane:pane-widths')); }})();"
    ));
}

fn push_to_messenger_windows(app: &tauri::AppHandle, widths: PaneWidths) {
    for (label, window) in app.webview_windows() {
        if label != "settings" && !label.starts_with(crate::window::POPUP_LABEL_PREFIX) {
            push(&window, widths);
        }
    }
}

/// Coalesces queued saves so only the newest report is written.
static GENERATION: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn install(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.listen_any(EVENT, move |event| {
        // The payload comes from the remote-origin page: untrusted.
        let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        if !value.is_object() {
            return;
        }
        let widths = PaneWidths::from_value(&value);
        let generation = GENERATION.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
        let h = handle.clone();
        // Listeners run on the UI thread; waiting there on the settings worker
        // can deadlock with a save that applies native window changes (as for
        // chatpane:zoom).
        tauri::async_runtime::spawn(async move {
            let worker_h = h.clone();
            let state = h.state::<AppState>();
            let _settings_worker = state.settings_worker.lock().await;
            if GENERATION.load(Ordering::Acquire) != generation {
                return;
            }
            if let Err(e) = tauri::async_runtime::spawn_blocking(move || {
                let state = worker_h.state::<AppState>();
                let next = {
                    let settings = state.settings.lock().unwrap();
                    if settings.pane_widths == widths {
                        return;
                    }
                    let mut next = settings.clone();
                    next.pane_widths = widths;
                    next
                };
                match save_settings(&worker_h, &next) {
                    Ok(SaveOutcome::Written) => {
                        *state.settings.lock().unwrap() = next;
                        // Other Messenger windows follow; the reporting page
                        // already shows these widths.
                        push_to_messenger_windows(&worker_h, widths);
                    }
                    Ok(SaveOutcome::Superseded) => {
                        log::warn!("pane width update was superseded");
                    }
                    Err(e) => log::error!("failed to save pane widths: {e}"),
                }
            })
            .await
            {
                log::error!("pane width settings worker failed: {e}");
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untrusted_widths_are_clamped_or_dropped() {
        let widths = PaneWidths::from_value(&serde_json::json!({
            "list": 320.4, "details": 1e12, "extra": true
        }));
        assert_eq!(
            widths,
            PaneWidths {
                list: Some(320),
                details: Some(PANE_WIDTH_MAX)
            }
        );
        let junk = PaneWidths::from_value(&serde_json::json!({ "list": "300", "details": -5 }));
        assert_eq!(
            junk,
            PaneWidths {
                list: None,
                details: Some(PANE_WIDTH_MIN)
            }
        );
    }

    #[test]
    fn malformed_settings_entry_resets_instead_of_failing() {
        let widths: PaneWidths = serde_json::from_str("[1, 2]").unwrap();
        assert_eq!(widths, PaneWidths::default());
        let widths: PaneWidths = serde_json::from_str(r#"{"list": null, "details": 400}"#).unwrap();
        assert_eq!(widths.details, Some(400));
    }
}
