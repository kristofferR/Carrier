//! A missing Microsoft Edge WebView2 runtime (Ref #365). The installer
//! bootstraps it, but the portable `.zip` cannot, and some LTSC, Server and
//! stripped images ship without it; Chatpane then failed to start with no
//! useful message. Detection follows Microsoft's documented registry check.

/// The runtime's EdgeUpdate client key, relative to `SOFTWARE`.
#[cfg(target_os = "windows")]
const CLIENT_KEY: &str = "Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// Where Microsoft offers the Evergreen runtime.
#[cfg(target_os = "windows")]
const DOWNLOAD_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// An installed runtime registers a real version; an uninstalled one can
/// leave the key behind with an empty value or "0.0.0.0".
pub(crate) fn version_installed(version: Option<&str>) -> bool {
    version
        .map(str::trim)
        .is_some_and(|version| !version.is_empty() && version != "0.0.0.0")
}

#[cfg(target_os = "windows")]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn registry_version(
    root: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RRF_RT_REG_SZ, RegGetValueW};
    let subkey = wide(subkey);
    let value = wide("pv");
    let mut buffer = [0u16; 64];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: RRF_RT_REG_SZ restricts the value type; RegGetValueW writes at most
    // `size` bytes into `buffer` and updates `size` with the byte count written.
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    let chars = (size as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buffer[..chars.min(buffer.len())]))
}

/// Whether WebView2 can load: the Evergreen runtime is registered, or the
/// loader finds another channel (Edge Beta, Dev or Canary), which it falls
/// back to when no runtime is installed.
#[cfg(target_os = "windows")]
pub(crate) fn runtime_available() -> bool {
    runtime_installed() || tauri::webview_version().is_ok()
}

/// Whether the Evergreen runtime is registered for the machine or this user.
#[cfg(target_os = "windows")]
fn runtime_installed() -> bool {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    [
        (
            HKEY_LOCAL_MACHINE,
            format!("SOFTWARE\\WOW6432Node\\{CLIENT_KEY}"),
        ),
        (HKEY_LOCAL_MACHINE, format!("SOFTWARE\\{CLIENT_KEY}")),
        (HKEY_CURRENT_USER, format!("Software\\{CLIENT_KEY}")),
    ]
    .into_iter()
    .any(|(root, subkey)| version_installed(registry_version(root, &subkey).as_deref()))
}

/// Explain the missing runtime and offer Microsoft's download page.
#[cfg(target_os = "windows")]
pub(crate) fn explain_missing_runtime() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IDOK, MB_ICONWARNING, MB_OKCANCEL, MessageBoxW,
    };
    let text = wide(
        "Chatpane needs the Microsoft Edge WebView2 Runtime, which is not installed on this computer.\n\n\
         Choose OK to open Microsoft's download page. Install the Evergreen runtime, then start Chatpane again.",
    );
    let title = wide("Chatpane");
    // SAFETY: both strings are NUL-terminated UTF-16 that outlive the call; a
    // null owner window is allowed.
    let choice = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OKCANCEL | MB_ICONWARNING,
        )
    };
    if choice == IDOK {
        let _ = open::that(DOWNLOAD_URL);
    }
}

#[cfg(target_os = "windows")]
/// Let the page mark regions that drag the window, like a title bar
/// (`app-region: drag`): WebView2 then handles them natively, with snapping,
/// double-click to maximize and the system menu. It applies from the next
/// navigation, and every Messenger window starts on Chatpane's local page.
pub(crate) fn enable_app_region(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings9;
    use windows::core::Interface;
    let result = window.with_webview(|webview| {
        // SAFETY: wry hands over the live controller on the main thread.
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let Ok(settings) = core
                .Settings()
                .and_then(|s| s.cast::<ICoreWebView2Settings9>())
            else {
                log::warn!("WebView2 is too old for draggable regions");
                return;
            };
            if let Err(error) = settings.SetIsNonClientRegionSupportEnabled(true) {
                log::warn!("could not enable WebView2 draggable regions: {error}");
            }
        }
    });
    if let Err(error) = result {
        log::warn!("could not reach WebView2 for draggable regions: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_real_version_counts_as_installed() {
        assert!(version_installed(Some("131.0.2903.70")));
        assert!(!version_installed(Some("0.0.0.0")));
        assert!(!version_installed(Some("  ")));
        assert!(!version_installed(None));
    }
}
