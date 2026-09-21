//! Persistent diagnostics and the personal debug-install boundary.

use std::path::PathBuf;

pub(crate) const UPDATE_INSTRUCTIONS: &str = "This debug installation receives debug drafts through carrier-debug-update. Release updates are blocked. New debug builds install only while Carrier is quit.";

fn install_dir() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(if cfg!(target_os = "macos") {
        home.join("Library/Application Support/CarrierDebug")
    } else {
        home.join(".local/share/carrier-debug")
    })
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
                "revision": env!("CARRIER_BUILD_REVISION"),
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
            eprintln!("Carrier: this machine requires a diagnostics debug build. Run carrier-debug-update.");
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
                    libc::LOCK_SH
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
                    eprintln!("Carrier debug install lock: {error}");
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
                    .env("CARRIER_DEBUG_LOCK_OWNER", std::process::id().to_string())
                    .status();
                drop(lock);
                std::process::exit(result.ok().and_then(|s| s.code()).unwrap_or(1));
            }
            let _ = INSTALL_LOCK.set(lock);
        }
    }
    // Configure the process environment before starting the logging thread.
    if cfg!(debug_assertions) {
        std::env::set_var("RUST_BACKTRACE", "full");
    }
    #[cfg(all(unix, debug_assertions))]
    if let Err(error) = capture_native_output() {
        eprintln!("Carrier could not capture native diagnostics: {error}");
    }
    if cfg!(debug_assertions) {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            eprintln!(
                "Carrier panic: {info}\n{}",
                std::backtrace::Backtrace::force_capture()
            );
            previous(info);
        }));
        eprintln!(
            "Carrier debug {} revision={} diagnostics={}",
            env!("CARGO_PKG_VERSION"),
            env!("CARRIER_BUILD_REVISION"),
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
        home.join("Library/Logs/io.github.kristofferr.carrier")
    } else {
        PathBuf::from(
            std::env::var_os("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share").into()),
        )
        .join("io.github.kristofferr.carrier/logs")
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
        .name("carrier-native-log".into())
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
                // block Carrier or close its stdout pipe and cause SIGPIPE.
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
    #[test]
    fn debug_build_cannot_use_the_release_updater() {
        assert!(super::release_updates_allowed().is_err());
    }
}
