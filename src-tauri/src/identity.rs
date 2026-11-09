//! Chatpane's identifier, and the move away from the one Carrier used.
//!
//! Every OS keeps an app's data in folders named after its identifier: the
//! settings, themes and logs, and the webview's Facebook login and
//! encrypted-chat keys. Carrier used `io.github.kristofferr.carrier`. The first
//! launch as Chatpane stops a Carrier that is still running, then moves those
//! folders to Chatpane's names before anything reads or creates them. When a
//! folder can't be moved, that launch runs on Carrier's folders instead and the
//! next one tries again.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// `identifier` in tauri.conf.json, for code that runs before the app is built.
pub(crate) const IDENTIFIER: &str = "app.chatpane.Chatpane";
/// Carrier's identifier.
pub(crate) const PREVIOUS: &str = "io.github.kristofferr.carrier";

static MOVED: AtomicBool = AtomicBool::new(false);
static ON_PREVIOUS: AtomicBool = AtomicBool::new(false);
static REPORT: Mutex<Vec<Result<String, String>>> = Mutex::new(Vec::new());

/// Move Carrier's data folders to Chatpane's. Runs before anything else opens
/// them; [`log_report`] logs the outcome once logging is set up.
pub(crate) fn migrate() {
    let folders = folders();
    if !folders
        .iter()
        .any(|(old, _)| old.symlink_metadata().is_ok())
    {
        return;
    }
    stop_previous_app();
    let mut report = REPORT.lock().unwrap();
    match move_all(&folders) {
        Ok(moved) => {
            MOVED.store(!moved.is_empty(), Ordering::Relaxed);
            report.extend(moved.into_iter().map(Ok));
        }
        Err(failure) => {
            ON_PREVIOUS.store(true, Ordering::Relaxed);
            report.push(Err(format!("{failure}; using Carrier's folders this time")));
        }
    }
}

/// Move every folder, or none: after a failure, what already moved goes
/// back, so Carrier's data stays whole and Chatpane has no folders that would
/// stop the next try.
fn move_all(folders: &[(PathBuf, PathBuf)]) -> Result<Vec<String>, String> {
    let mut moved = Vec::new();
    for (old, new) in folders {
        match move_folder(old, new) {
            Ok(true) => moved.push((old, new)),
            Ok(false) => {}
            Err(error) => {
                for (old, new) in moved {
                    let _ = std::fs::rename(new, old);
                }
                return Err(format!(
                    "couldn't move {} to {}: {error}",
                    old.display(),
                    new.display()
                ));
            }
        }
    }
    Ok(moved
        .into_iter()
        .map(|(old, new)| format!("moved {} to {}", old.display(), new.display()))
        .collect())
}

/// The identifier whose folders this launch uses: Chatpane's, or Carrier's
/// when its data couldn't be moved.
pub(crate) fn current() -> &'static str {
    if ON_PREVIOUS.load(Ordering::Relaxed) {
        PREVIOUS
    } else {
        IDENTIFIER
    }
}

pub(crate) fn log_report() {
    for line in REPORT.lock().unwrap().drain(..) {
        match line {
            Ok(line) => log::info!("{line}"),
            Err(line) => log::warn!("{line}"),
        }
    }
}

/// Whether this launch moved Carrier's data, true once: the macOS login item
/// then has to be registered again under the new identifier.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn take_moved() -> bool {
    MOVED.swap(false, Ordering::Relaxed)
}

/// Move `old` to `new`, unless Chatpane already has its own `new`.
fn move_folder(old: &Path, new: &Path) -> std::io::Result<bool> {
    if old.symlink_metadata().is_err() || new.symlink_metadata().is_ok() {
        return Ok(false);
    }
    if let Some(parent) = new.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Carrier's WebView2 can hold its files for a moment after Carrier exits.
    let mut attempts = if cfg!(windows) { 25 } else { 1 };
    loop {
        attempts -= 1;
        match std::fs::rename(old, new) {
            Ok(()) => return Ok(true),
            Err(error) if attempts == 0 => return Err(error),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

/// Carrier's data folders, and Chatpane's names for them.
fn folders() -> Vec<(PathBuf, PathBuf)> {
    let mut folders: Vec<_> = bases()
        .into_iter()
        .map(|base| (base.join(PREVIOUS), base.join(IDENTIFIER)))
        .collect();
    // WebKit's cookie files are named after the identifier too.
    #[cfg(target_os = "macos")]
    if let Some(home) = home() {
        for dir in ["Library/HTTPStorages", "Library/Cookies"] {
            let dir = home.join(dir);
            folders.push((
                dir.join(format!("{PREVIOUS}.binarycookies")),
                dir.join(format!("{IDENTIFIER}.binarycookies")),
            ));
        }
    }
    folders.sort();
    folders.dedup();
    folders
}

/// The folders that hold one folder per app, named after its identifier.
fn bases() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let dirs = [
            "Application Support",
            "Caches",
            "Logs",
            "WebKit",
            "HTTPStorages",
        ];
        home()
            .map(|home| dirs.map(|dir| home.join("Library").join(dir)).to_vec())
            .unwrap_or_default()
    }
    #[cfg(target_os = "windows")]
    {
        ["APPDATA", "LOCALAPPDATA"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect()
    }
    #[cfg(target_os = "linux")]
    {
        let home = home();
        [
            ("XDG_CONFIG_HOME", ".config"),
            ("XDG_DATA_HOME", ".local/share"),
            ("XDG_CACHE_HOME", ".cache"),
        ]
        .into_iter()
        .filter_map(|(variable, fallback)| {
            std::env::var_os(variable)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .or_else(|| home.as_ref().map(|home| home.join(fallback)))
        })
        .collect()
    }
}

#[cfg(unix)]
fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Stop a Carrier that is still running, so the two never share a data
/// folder: a Linux package upgrade or Homebrew can leave it open. Windows needs
/// nothing here: the installer runs Carrier's uninstaller, which stops it.
#[cfg(target_os = "macos")]
fn stop_previous_app() {
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;

    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(
        PREVIOUS,
    ));
    for app in apps.iter() {
        let pid = app.processIdentifier();
        // Ask Carrier to quit; force it when it doesn't.
        if !app.terminate() || !exited(pid) {
            app.forceTerminate();
            exited(pid);
        }
    }
}

#[cfg(target_os = "linux")]
fn stop_previous_app() {
    // Carrier's single-instance plugin owns this D-Bus name while it runs.
    let pid = (|| {
        let connection = zbus::blocking::Connection::session().ok()?;
        let name = zbus::names::BusName::try_from(format!("{PREVIOUS}.SingleInstance")).ok()?;
        let pid = zbus::blocking::fdo::DBusProxy::new(&connection)
            .ok()?
            .get_connection_unix_process_id(name)
            .ok()?;
        libc::pid_t::try_from(pid).ok().filter(|pid| *pid > 0)
    })();
    let Some(pid) = pid else { return };
    // SAFETY: plain signals to the process that owns Carrier's D-Bus name.
    unsafe { libc::kill(pid, libc::SIGTERM) };
    if !exited(pid) {
        unsafe { libc::kill(pid, libc::SIGKILL) };
        exited(pid);
    }
}

#[cfg(target_os = "windows")]
fn stop_previous_app() {}

/// Wait up to five seconds for `pid` to exit.
#[cfg(unix)]
fn exited(pid: libc::pid_t) -> bool {
    if pid <= 0 {
        return true;
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    // SAFETY: signal 0 only checks whether the process still exists.
    while unsafe { libc::kill(pid, 0) } == 0 {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_matches_the_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
    }

    #[test]
    fn a_folder_moves_only_where_chatpane_has_none() {
        let root = std::env::temp_dir().join(format!("chatpane-identity-{}", std::process::id()));
        let (old, new) = (root.join(PREVIOUS), root.join(IDENTIFIER));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("settings.json"), "{}").unwrap();

        assert!(move_folder(&old, &new).unwrap());
        assert!(!old.exists());
        assert_eq!(
            std::fs::read_to_string(new.join("settings.json")).unwrap(),
            "{}"
        );
        // Nothing left to move.
        assert!(!move_folder(&old, &new).unwrap());

        // Chatpane's own folder wins over a Carrier folder that reappears.
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("settings.json"), "old").unwrap();
        assert!(!move_folder(&old, &new).unwrap());
        assert_eq!(
            std::fs::read_to_string(new.join("settings.json")).unwrap(),
            "{}"
        );
        assert!(old.exists());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_failed_move_puts_back_what_moved() {
        let root = std::env::temp_dir().join(format!("chatpane-move-all-{}", std::process::id()));
        let config = (
            root.join("config").join(PREVIOUS),
            root.join("config").join(IDENTIFIER),
        );
        std::fs::create_dir_all(&config.0).unwrap();
        // The second destination can't be created: its parent is a file.
        let data = (
            root.join("data").join(PREVIOUS),
            root.join("blocked").join(IDENTIFIER),
        );
        std::fs::create_dir_all(&data.0).unwrap();
        std::fs::write(root.join("blocked"), "").unwrap();

        assert!(move_all(&[config.clone(), data.clone()]).is_err());
        assert!(config.0.exists() && !config.1.exists());
        assert!(data.0.exists());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn every_folder_pairs_carrier_with_chatpane() {
        for (old, new) in folders() {
            let (old, new) = (old.to_string_lossy(), new.to_string_lossy());
            assert!(old.contains(PREVIOUS), "{old}");
            assert_eq!(old.replace(PREVIOUS, IDENTIFIER), new);
        }
        assert!(!take_moved());
    }
}
