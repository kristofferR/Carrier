//! Chatpane was called Carrier. Carrier's updater replaces the app in place,
//! so an install it updated to Chatpane is still `Carrier.app`. On launch, a
//! release build running from `Carrier.app` renames it to `Chatpane.app` and
//! reopens from there. A rename keeps the bundle's file identity, which Dock
//! items resolve. Homebrew installs are left to `brew upgrade`, which installs
//! `Chatpane.app` itself and would collide with an app that renamed itself.

use std::path::{Path, PathBuf};

/// Passed to the reopened app, which then moves Start on System Startup to the
/// new path: the login item still names `Carrier.app`.
#[cfg(target_os = "macos")]
const RENAMED_ARG: &str = "--renamed-from-carrier";

/// Where the bundle should move, or None when it already has the new name, the
/// new name is taken, or Homebrew manages it (`caskrooms` are Homebrew's
/// Caskroom directories).
pub(crate) fn rename_target(bundle: &Path, caskrooms: &[PathBuf]) -> Option<PathBuf> {
    if bundle.file_name()? != "Carrier.app" {
        return None;
    }
    let managed_by_homebrew = caskrooms.iter().any(|caskroom| {
        ["carrier", "chatpane"]
            .iter()
            .any(|token| caskroom.join(token).exists())
    });
    let renamed = bundle.with_file_name("Chatpane.app");
    (!managed_by_homebrew && !renamed.exists()).then_some(renamed)
}

/// Rename a `Carrier.app` install and schedule it to reopen once this process
/// exits. Returns true when the caller should exit now. Any failure leaves
/// the app where it is and running.
#[cfg(target_os = "macos")]
pub(crate) fn rename_and_relaunch() -> bool {
    if cfg!(debug_assertions) {
        // Debug installs are placed by chatpane-debug-update.
        return false;
    }
    let Ok(bundle) = crate::commands::current_app_bundle() else {
        return false;
    };
    let caskrooms = [
        PathBuf::from("/opt/homebrew/Caskroom"),
        PathBuf::from("/usr/local/Caskroom"),
    ];
    let Some(renamed) = rename_target(&bundle, &caskrooms) else {
        return false;
    };
    if let Err(error) = std::fs::rename(&bundle, &renamed) {
        eprintln!("couldn't rename Carrier.app to Chatpane.app: {error}");
        return false;
    }
    // The new instance must start after this one exits, or the single-instance
    // check would hand it back to this process.
    let reopened = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("while kill -0 \"$1\" 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open -n \"$2\" --args \"$3\"")
        .arg("chatpane-rename-relaunch")
        .arg(std::process::id().to_string())
        .arg(&renamed)
        .arg(RENAMED_ARG)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    if let Err(error) = reopened {
        eprintln!("couldn't reopen Chatpane.app: {error}");
        // Keep this instance's bundle path valid.
        let _ = std::fs::rename(&renamed, &bundle);
        return false;
    }
    true
}

/// Whether this launch is the reopen after the rename.
#[cfg(target_os = "macos")]
pub(crate) fn launched_after_rename() -> bool {
    std::env::args().any(|arg| arg == RENAMED_ARG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_unmanaged_carrier_bundle_moves() {
        let dir = std::env::temp_dir().join(format!("chatpane-rename-{}", std::process::id()));
        let apps = dir.join("Applications");
        let caskroom = dir.join("Caskroom");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::create_dir_all(&caskroom).unwrap();
        let carrier = apps.join("Carrier.app");
        let caskrooms = [caskroom.clone()];

        assert_eq!(
            rename_target(&carrier, &caskrooms),
            Some(apps.join("Chatpane.app"))
        );
        assert_eq!(rename_target(&apps.join("Chatpane.app"), &caskrooms), None);
        assert_eq!(
            rename_target(&apps.join("Carrier Beta.app"), &caskrooms),
            None
        );

        std::fs::create_dir_all(caskroom.join("carrier")).unwrap();
        assert_eq!(rename_target(&carrier, &caskrooms), None);
        std::fs::remove_dir_all(caskroom.join("carrier")).unwrap();

        std::fs::create_dir_all(apps.join("Chatpane.app")).unwrap();
        assert_eq!(rename_target(&carrier, &caskrooms), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
