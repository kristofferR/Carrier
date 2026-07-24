//! Desktop-entry command-line actions for cold and single-instance launches.

use std::ffi::OsStr;

use tauri::Manager;

use crate::tray::show_main;
use crate::window::show_settings_window;

pub(crate) const NEW_CONVERSATION_JS: &str =
    "window.__carrierShortcuts && window.__carrierShortcuts.newConversation()";

// A cold launch is dispatched from the Messenger page-load hook, but the
// injected shortcut registry can still land just after WebKit reports
// `Finished`. Retry for at most ten seconds and then fail soft.
const NEW_CONVERSATION_RETRY_JS: &str = r#"
(function retryCarrierNewConversation(remaining) {
  var shortcuts = window.__carrierShortcuts;
  if (shortcuts && typeof shortcuts.newConversation === "function") {
    shortcuts.newConversation();
    return;
  }
  if (remaining > 1) {
    setTimeout(function () {
      retryCarrierNewConversation(remaining - 1);
    }, 250);
  }
})(40);
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CliAction {
    NewConversation,
    Settings,
}

/// Return the first supported action flag. The executable name, desktop
/// environment metadata, and unknown future flags are intentionally ignored.
pub(crate) fn parse_cli_action<I, S>(args: I) -> Option<CliAction>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .find_map(|arg| match arg.as_ref().to_str() {
            Some("--new-conversation") => Some(CliAction::NewConversation),
            Some("--settings") => Some(CliAction::Settings),
            _ => None,
        })
}

pub(crate) fn perform_cli_action(app: &tauri::AppHandle, action: CliAction) {
    match action {
        CliAction::NewConversation => {
            show_main(app);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(NEW_CONVERSATION_RETRY_JS);
            }
        }
        CliAction::Settings => {
            // Window creation from a single-instance callback can deadlock on
            // Windows; dispatch it away from that callback just like F3.
            let app = app.clone();
            tauri::async_runtime::spawn(async move { show_settings_window(&app) });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_supported_desktop_action() {
        assert_eq!(
            parse_cli_action(["carrier", "--new-conversation"]),
            Some(CliAction::NewConversation)
        );
        assert_eq!(
            parse_cli_action(["carrier", "--settings"]),
            Some(CliAction::Settings)
        );
    }

    #[test]
    fn ignores_unknown_arguments_and_uses_the_first_supported_action() {
        assert_eq!(
            parse_cli_action(["carrier", "--verbose", "--settings", "--new-conversation"]),
            Some(CliAction::Settings)
        );
        assert_eq!(parse_cli_action(["carrier", "--verbose"]), None);
    }

    #[cfg(unix)]
    #[test]
    fn non_unicode_arguments_are_ignored() {
        use std::os::unix::ffi::OsStringExt;

        let invalid = std::ffi::OsString::from_vec(vec![0xff]);
        assert_eq!(
            parse_cli_action([invalid, "--settings".into()]),
            Some(CliAction::Settings)
        );
    }
}
