//! Runtime packaging detection for behavior that an immutable sandbox owns.

/// Flatpak exposes this file inside every application sandbox. Detecting the
/// sandbox from the filesystem avoids trusting caller-controlled environment
/// variables.
pub(crate) fn is_flatpak() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/.flatpak-info").is_file()
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Snap sets SNAP to the mounted package root. Check the executable and package
/// metadata too, so an inherited environment variable cannot disable features
/// in a regular installation.
pub(crate) fn is_snap() -> bool {
    #[cfg(target_os = "linux")]
    {
        let (Some(root), Ok(executable)) = (std::env::var_os("SNAP"), std::env::current_exe())
        else {
            return false;
        };
        let root = std::path::PathBuf::from(root);
        root.is_absolute() && executable.starts_with(&root) && root.join("meta/snap.yaml").is_file()
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

pub(crate) fn is_store_sandbox() -> bool {
    is_flatpak() || is_snap()
}

#[cfg(target_os = "linux")]
pub(crate) fn linux_desktop_id() -> String {
    if is_snap() {
        // snapd prefixes exported desktop files with the instance name.
        let name = std::env::var("SNAP_INSTANCE_NAME")
            .or_else(|_| std::env::var("SNAP_NAME"))
            .unwrap_or_else(|_| "carrier".into());
        format!("{name}_carrier")
    } else if is_flatpak() {
        "io.github.kristofferr.carrier".into()
    } else {
        "Carrier".into()
    }
}
