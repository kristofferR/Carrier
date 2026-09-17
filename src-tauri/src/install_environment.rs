//! Runtime packaging detection for behavior that an immutable sandbox owns.

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

#[cfg(target_os = "linux")]
pub(crate) fn linux_desktop_id() -> String {
    if is_snap() {
        // snapd prefixes exported desktop files with the instance name.
        let name = std::env::var("SNAP_INSTANCE_NAME")
            .or_else(|_| std::env::var("SNAP_NAME"))
            .unwrap_or_else(|_| "carrier".into());
        format!("{name}_carrier")
    } else {
        "Carrier".into()
    }
}
