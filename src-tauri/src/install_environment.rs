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
