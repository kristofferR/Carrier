//! Desktop-entry command-line actions for cold and single-instance launches.

use std::ffi::OsStr;

use crate::actions::AppAction;

/// Return the first supported action flag. The executable name, desktop
/// environment metadata, and unknown future flags are intentionally ignored.
/// Windows routes launches through `action_from_argv` instead (it also parses
/// `--thread` and `carrier://` URLs), so this flag-only parser is compiled only
/// where it is used.
#[cfg(any(not(target_os = "windows"), test))]
pub(crate) fn parse_cli_action<I, S>(args: I) -> Option<AppAction>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .find_map(|arg| match arg.as_ref().to_str() {
            Some("--new-conversation") => Some(AppAction::NewConversation),
            Some("--settings") => Some(AppAction::Settings),
            _ => None,
        })
}

/// The launch-action parser for this platform's argv surface, used for both the
/// cold `run()` path and the single-instance warm callback. Windows also
/// understands `--thread <id>` and `carrier://` URLs (they arrive as argv);
/// the other desktops keep the flag-only parser above.
pub(crate) fn parse_launch_action<I, S>(args: I) -> Option<AppAction>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    #[cfg(target_os = "windows")]
    {
        crate::actions::action_from_argv(args)
    }
    #[cfg(not(target_os = "windows"))]
    {
        parse_cli_action(args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_supported_desktop_action() {
        assert_eq!(
            parse_cli_action(["carrier", "--new-conversation"]),
            Some(AppAction::NewConversation)
        );
        assert_eq!(
            parse_cli_action(["carrier", "--settings"]),
            Some(AppAction::Settings)
        );
    }

    #[test]
    fn ignores_unknown_arguments_and_uses_the_first_supported_action() {
        assert_eq!(
            parse_cli_action(["carrier", "--verbose", "--settings", "--new-conversation"]),
            Some(AppAction::Settings)
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
            Some(AppAction::Settings)
        );
    }
}
