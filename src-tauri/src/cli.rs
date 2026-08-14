//! Desktop-entry command-line actions for cold and single-instance launches.

use std::ffi::OsStr;

use crate::actions::AppAction;

/// Return the first supported action flag. The executable name, desktop
/// environment metadata, and unknown future flags are intentionally ignored.
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
