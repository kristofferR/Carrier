//! Persistent diagnostics and the personal debug-install boundary.

use std::path::PathBuf;

pub(crate) const UPDATE_INSTRUCTIONS: &str = "This debug installation receives debug drafts through chatpane-debug-update. Release updates are blocked. New debug builds install only while Chatpane is quit.";

fn install_dir() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(if cfg!(target_os = "macos") {
        home.join("Library/Application Support/ChatpaneDebug")
    } else {
        home.join(".local/share/chatpane-debug")
    })
}

/// A build the personal updater verified and staged in `pending.json` to
/// install once Chatpane quits.
#[cfg(any(feature = "diagnostics", test))]
#[derive(Debug, PartialEq)]
struct StagedBuild {
    version: String,
    revision: String,
}

/// The staged build, unless it is the one already running.
#[cfg(any(feature = "diagnostics", test))]
fn staged_build(pending: &[u8], running_revision: &str) -> Option<StagedBuild> {
    #[derive(serde::Deserialize)]
    struct Pending {
        version: String,
        revision: String,
    }
    let Pending { version, revision } = serde_json::from_slice(pending).ok()?;
    (revision != running_revision).then_some(StagedBuild { version, revision })
}

/// The updater never quits Chatpane, so a session left running keeps its old
/// build indefinitely. Say once per staged build that quitting installs it.
#[cfg(feature = "diagnostics")]
pub(crate) fn spawn_staged_build_notices(app: tauri::AppHandle) {
    const INTERVAL: std::time::Duration = std::time::Duration::from_secs(10 * 60);
    tauri::async_runtime::spawn(async move {
        let mut announced: Option<String> = None;
        loop {
            tokio::time::sleep(INTERVAL).await;
            let Some(build) = install_dir()
                .and_then(|dir| std::fs::read(dir.join("pending.json")).ok())
                .and_then(|pending| staged_build(&pending, env!("CHATPANE_BUILD_REVISION")))
            else {
                continue;
            };
            if announced.as_deref() == Some(build.revision.as_str()) {
                continue;
            }
            let short = build.revision.get(..12).unwrap_or(&build.revision);
            log::info!(
                "debug build {} {short} is staged until Chatpane quits",
                build.version
            );
            crate::notifications::show_app_notice(
                &app,
                "Chatpane debug update ready".into(),
                format!(
                    "Chatpane {} debug ({short}) is staged. Quit Chatpane to install it; the updater runs every five minutes while Chatpane is closed.",
                    build.version
                ),
            );
            announced = Some(build.revision);
        }
    });
}

pub(crate) fn release_updates_allowed() -> Result<(), String> {
    if cfg!(debug_assertions) {
        Err(UPDATE_INSTRUCTIONS.into())
    } else {
        Ok(())
    }
}

/// Runs before GTK/AppKit, threads, or single-instance handling. The probe is
/// safe for installers and never opens a window or touches the running app.
pub(crate) fn startup() -> bool {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--build-info")) {
        println!(
            "{}",
            serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "revision": env!("CHATPANE_BUILD_REVISION"),
                "debug": cfg!(debug_assertions),
                "diagnostics": cfg!(feature = "diagnostics"),
                "mcp": cfg!(feature = "mcp"),
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
            })
        );
        return false;
    }
    if let Some(dir) = install_dir() {
        if dir.join("debug-only").exists() && !cfg!(feature = "diagnostics") {
            eprintln!(
                "Chatpane: this machine requires a diagnostics debug build. Run chatpane-debug-update."
            );
            std::process::exit(1);
        }
        #[cfg(all(unix, feature = "diagnostics"))]
        {
            use std::os::fd::AsRawFd;
            static INSTALL_LOCK: std::sync::OnceLock<std::fs::File> = std::sync::OnceLock::new();
            let operation = std::env::args_os().nth(1);
            let update_lock =
                operation.as_deref() == Some(std::ffi::OsStr::new("--debug-update-lock"));
            let exclusive = update_lock
                || operation.as_deref() == Some(std::ffi::OsStr::new("--debug-install-lock"));
            let lock = (|| -> std::io::Result<std::fs::File> {
                std::fs::create_dir_all(&dir)?;
                let file = std::fs::OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .write(true)
                    .open(dir.join(if update_lock {
                        "update.lock"
                    } else {
                        "install.lock"
                    }))?;
                let operation = if exclusive {
                    libc::LOCK_EX | libc::LOCK_NB
                } else {
                    libc::LOCK_SH | libc::LOCK_NB
                };
                // The descriptor remains open for the whole app/installer lifetime.
                if unsafe { libc::flock(file.as_raw_fd(), operation) } != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(file)
            })();
            let lock = match lock {
                Ok(lock) => lock,
                Err(error) => {
                    eprintln!("Chatpane debug install lock: {error}");
                    std::process::exit(if exclusive { 75 } else { 1 });
                }
            };
            if exclusive {
                let mut args = std::env::args_os().skip(2);
                let Some(command) = args.next() else {
                    std::process::exit(2)
                };
                let result = std::process::Command::new(command)
                    .args(args)
                    .env("CHATPANE_DEBUG_LOCK_OWNER", std::process::id().to_string())
                    .status();
                drop(lock);
                std::process::exit(result.ok().and_then(|s| s.code()).unwrap_or(1));
            }
            let _ = INSTALL_LOCK.set(lock);
        }
    }
    // Configure the process environment before starting the logging thread.
    if cfg!(debug_assertions) {
        // SAFETY: `run()` calls this first, while the process is single-threaded.
        unsafe { std::env::set_var("RUST_BACKTRACE", "full") };
    }
    // Before the native log below creates Chatpane's data folder, and after
    // the environment, since stopping a running Carrier can start threads.
    crate::identity::migrate();
    #[cfg(all(unix, debug_assertions))]
    if let Err(error) = capture_native_output() {
        eprintln!("Chatpane could not capture native diagnostics: {error}");
    }
    if cfg!(debug_assertions) {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            eprintln!(
                "Chatpane panic: {info}\n{}",
                std::backtrace::Backtrace::force_capture()
            );
            previous(info);
        }));
        eprintln!(
            "Chatpane debug {} revision={} diagnostics={}",
            env!("CARGO_PKG_VERSION"),
            env!("CHATPANE_BUILD_REVISION"),
            cfg!(feature = "diagnostics")
        );
    }
    true
}

#[cfg(all(unix, debug_assertions))]
fn capture_native_output() -> std::io::Result<()> {
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::OpenOptionsExt;

    let home = PathBuf::from(
        std::env::var_os("HOME").ok_or_else(|| std::io::Error::other("HOME missing"))?,
    );
    let dir = if cfg!(target_os = "macos") {
        home.join("Library/Logs").join(crate::identity::current())
    } else {
        PathBuf::from(
            std::env::var_os("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share").into()),
        )
        .join(crate::identity::current())
        .join("logs")
    };
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("native-{}.log", std::process::id()));
    // Bound both session count and bytes. Separate files avoid multi-instance
    // processes racing a shared rotation. Keep five completed sessions plus live ones.
    let mut sessions: Vec<_> = std::fs::read_dir(&dir)?
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            let Some(pid) = name
                .strip_prefix("native-")
                .and_then(|s| s.strip_suffix(".log"))
                .and_then(|s| s.parse::<libc::pid_t>().ok())
            else {
                return false;
            };
            // Isolated debug instances must not unlink a live session's log.
            unsafe { libc::kill(pid, 0) != 0 }
        })
        .collect();
    sessions.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    for entry in sessions.iter().take(sessions.len().saturating_sub(5)) {
        let _ = std::fs::remove_file(entry.path());
        let _ = std::fs::remove_file(entry.path().with_extension("log.1"));
    }
    let open = |path: &std::path::Path| {
        OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)
    };
    let mut output = open(&path)?;
    let mut descriptors = [0; 2];
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut reader = unsafe { File::from_raw_fd(descriptors[0]) };
    let writer = unsafe { File::from_raw_fd(descriptors[1]) };
    for descriptor in descriptors {
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    std::thread::Builder::new()
        .name("chatpane-native-log".into())
        .spawn(move || {
            let mut size = output.metadata().map(|m| m.len()).unwrap_or(0);
            let mut writable = true;
            let mut buffer = [0; 8192];
            loop {
                let length = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(length) => length,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                // Keep draining even if disk writes fail. Diagnostics must never
                // block Chatpane or close its stdout pipe and cause SIGPIPE.
                if !writable {
                    continue;
                }
                if size + length as u64 > 20 * 1024 * 1024 {
                    if std::fs::rename(&path, path.with_extension("log.1")).is_err() {
                        writable = false;
                        continue;
                    }
                    match open(&path) {
                        Ok(next) => output = next,
                        Err(_) => {
                            writable = false;
                            continue;
                        }
                    }
                    size = 0;
                }
                writable = output.write_all(&buffer[..length]).is_ok();
                size += length as u64;
            }
        })?;
    for descriptor in [libc::STDOUT_FILENO, libc::STDERR_FILENO] {
        if unsafe { libc::dup2(writer.as_raw_fd(), descriptor) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    drop(writer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_build_cannot_use_the_release_updater() {
        assert!(release_updates_allowed().is_err());
    }

    #[test]
    fn staged_build_is_reported_only_when_it_differs_from_the_running_one() {
        let pending = br#"{"version":"2.0.7","revision":"390bb906b576ff11","debug":true}"#;
        assert_eq!(
            staged_build(pending, "414b256598f34e03"),
            Some(StagedBuild {
                version: "2.0.7".into(),
                revision: "390bb906b576ff11".into(),
            })
        );
        assert_eq!(staged_build(pending, "390bb906b576ff11"), None);
        assert_eq!(staged_build(b"not json", "414b256598f34e03"), None);
    }
}
