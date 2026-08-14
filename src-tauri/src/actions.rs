//! Native app actions shared by command-line flags, menus, and macOS URLs.

use std::sync::atomic::Ordering;

use tauri::Manager;
#[cfg(any(target_os = "macos", test))]
use url::Url;

use crate::settings::AppState;
use crate::tray::show_main;
use crate::window::show_settings_window;

pub(crate) const NEW_CONVERSATION_JS: &str =
    "window.__carrierShortcuts && window.__carrierShortcuts.newConversation()";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AppAction {
    NewConversation,
    Settings,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    OpenThread(String),
}

/// Accept only the canonical page route used everywhere native code opens a
/// Messenger conversation. The digits-only id makes embedding the result in a
/// URL or JSON string safe; callers still JSON-encode it before page eval.
pub(crate) fn validated_thread_path(value: &str) -> Option<String> {
    let id = value.strip_prefix("/t/")?.strip_suffix('/')?;
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(format!("/t/{id}/"))
}

/// Parse the deliberately small `carrier://` automation surface. URL metadata
/// is rejected rather than ignored so a copied or generated URL cannot mean
/// something different to another parser.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn parse_carrier_url(url: &Url) -> Option<AppAction> {
    if url.scheme() != "carrier"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }

    match (url.host_str(), url.path()) {
        (Some("compose"), "") => Some(AppAction::NewConversation),
        (Some("settings"), "") => Some(AppAction::Settings),
        (Some("t"), path) => {
            let id = path.strip_prefix('/')?;
            if id.contains('/') {
                return None;
            }
            validated_thread_path(&format!("/t/{id}/")).map(AppAction::OpenThread)
        }
        _ => None,
    }
}

fn page_action_script(action: &AppAction) -> Option<String> {
    let invoke = match action {
        AppAction::NewConversation => r#"
    var shortcuts = window.__carrierShortcuts;
    if (shortcuts && typeof shortcuts.newConversation === "function") {
      shortcuts.newConversation();
      return;
    }"#
        .to_string(),
        AppAction::OpenThread(path) => {
            let path = validated_thread_path(path)?;
            let path = serde_json::to_string(&path).ok()?;
            format!(
                r#"
    if (typeof window.__carrierOpenThread === "function") {{
      window.__carrierOpenThread({path});
      return;
    }}"#
            )
        }
        AppAction::Settings => return None,
    };

    Some(format!(
        r#"
(function retryCarrierAction(remaining) {{{invoke}
  if (remaining > 1) {{
    setTimeout(function () {{ retryCarrierAction(remaining - 1); }}, 500);
  }}
}})(20);
"#
    ))
}

fn dispatch_page_action(window: &tauri::WebviewWindow, action: &AppAction) -> bool {
    page_action_script(action).is_some_and(|script| {
        if let Err(error) = window.eval(script) {
            log::warn!("failed to dispatch app action to Messenger: {error}");
            false
        } else {
            true
        }
    })
}

fn dispatch_or_retain_page_action(app: &tauri::AppHandle, action: AppAction) {
    let state = app.state::<AppState>();
    let mut pending = state.pending_action.lock().unwrap();
    let ready = state.messenger_loaded.load(Ordering::Acquire);
    if ready {
        if let Some(window) = app.get_webview_window("main") {
            // A successful warm dispatch supersedes anything that was waiting
            // for a previous page load. Keep the slot as last-writer-wins.
            *pending = None;
            if dispatch_page_action(&window, &action) {
                return;
            }
        }
    }
    *pending = Some(action);
}

/// Run an app action now when Messenger is ready, otherwise retain the newest
/// action for the main window's next completed Messenger load.
pub(crate) fn run_app_action(app: &tauri::AppHandle, action: AppAction) {
    if action == AppAction::Settings {
        // Window creation from a single-instance callback can deadlock on
        // Windows; dispatch it away from that callback just like F3.
        let app = app.clone();
        tauri::async_runtime::spawn(async move { show_settings_window(&app) });
        return;
    }

    show_main(app);
    // Page-load callbacks run on the main thread. Put readiness inspection and
    // eval there too so a Started transition cannot race a background
    // notification/CLI action between the ready read and script dispatch.
    let main_app = app.clone();
    let fallback_action = action.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        dispatch_or_retain_page_action(&main_app, action);
    }) {
        log::warn!("failed to queue app action on the main thread: {error}");
        *app.state::<AppState>().pending_action.lock().unwrap() = Some(fallback_action);
    }
}

/// Mark the main page unavailable before a navigation replaces its injected
/// hooks. This keeps actions arriving during a reload in the pending slot.
pub(crate) fn messenger_page_started(window: &tauri::WebviewWindow) {
    if window.label() == "main" {
        let state = window.state::<AppState>();
        let _pending = state.pending_action.lock().unwrap();
        state.messenger_loaded.store(false, Ordering::Release);
    }
}

/// Publish Messenger readiness and drain the last pending action. Taking the
/// slot under the same lock used by `run_app_action` closes the load/action race.
pub(crate) fn messenger_page_finished(window: &tauri::WebviewWindow) {
    if window.label() != "main" {
        return;
    }
    let state = window.state::<AppState>();
    let mut pending = state.pending_action.lock().unwrap();
    state.messenger_loaded.store(true, Ordering::Release);
    if let Some(action) = pending.take() {
        if !dispatch_page_action(window, &action) {
            // The webview may have disappeared between the navigation event
            // and eval. Preserve the action for the next completed load.
            *pending = Some(action);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(value: &str) -> Option<AppAction> {
        Url::parse(value)
            .ok()
            .and_then(|url| parse_carrier_url(&url))
    }

    #[test]
    fn parses_canonical_carrier_actions() {
        assert_eq!(parse("carrier://compose"), Some(AppAction::NewConversation));
        assert_eq!(parse("carrier://settings"), Some(AppAction::Settings));
        assert_eq!(
            parse("carrier://t/123456"),
            Some(AppAction::OpenThread("/t/123456/".into()))
        );
    }

    #[test]
    fn rejects_noncanonical_or_annotated_carrier_urls() {
        for value in [
            "carrier://compose/",
            "carrier://settings/",
            "carrier://t/",
            "carrier://t/123/",
            "carrier://t/not-a-number",
            "carrier://t/123?draft=yes",
            "carrier://t/123#message",
            "carrier://user@t/123",
            "carrier://t:42/123",
            "https://t/123",
        ] {
            assert_eq!(parse(value), None, "{value}");
        }
        assert_eq!(parse(&format!("carrier://t/{}", "1".repeat(33))), None);
    }

    #[test]
    fn validates_only_bare_numeric_thread_paths() {
        assert_eq!(validated_thread_path("/t/12345/"), Some("/t/12345/".into()));
        assert_eq!(validated_thread_path("/t/12345"), None);
        assert_eq!(validated_thread_path("https://facebook.com/t/12345/"), None);
        assert_eq!(validated_thread_path("/t/1';alert(1)//"), None);
        assert_eq!(validated_thread_path("/t/123/../../settings/"), None);
    }
}
