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
    let text = wide(crate::i18n::t("dialog.webview2_missing.message"));
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

/// Resume Facebook's SharedWorkers when an in-place reload restarts them.
///
/// WebView2 keeps its own DevTools client attached to each SharedWorker. A
/// reload (F5, Ctrl+R, the watchdog's) ends the worker with the old page, and
/// the new page starts it again under the same URL and name. Chromium then
/// reuses the old DevTools target, and a target with a client attached starts
/// paused until a client sends `Runtime.runIfWaitingForDebugger`. WebView2
/// never sends it. Messenger's encrypted backend runs in that worker, so
/// encrypted chats stopped syncing after every reload until the watchdog
/// rebuilt the webview.
///
/// Through the page's DevTools session, attach to every SharedWorker and resume
/// it when Chromium reports the restart (`Inspector.targetReloadedAfterCrash`).
#[cfg(target_os = "windows")]
pub(crate) fn resume_restarted_shared_workers(window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let result = window.with_webview(move |webview| {
        // SAFETY: wry hands over the live controller on the main thread, where
        // WebView2 also runs the DevTools callbacks.
        let installed = unsafe { webview.controller().CoreWebView2() }
            .and_then(|core| shared_worker_resume::install(&core));
        if let Err(error) = installed {
            log::warn!("could not watch Messenger's shared workers in {label}: {error}");
        }
    });
    if let Err(error) = result {
        log::warn!("could not reach WebView2 to watch shared workers: {error}");
    }
}

#[cfg(target_os = "windows")]
mod shared_worker_resume {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_11, ICoreWebView2DevToolsProtocolEventReceivedEventArgs2,
    };
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler,
        take_pwstr,
    };
    use windows::core::{HSTRING, Interface, PWSTR, Result};

    /// Runs on the main thread that owns the webview, like every call below.
    pub(super) fn install(core: &ICoreWebView2) -> Result<()> {
        // Session calls need WebView2 1.0.1245 or newer.
        core.cast::<ICoreWebView2_11>()?;
        on_event(core, "Target.targetCreated", |core, _, params| {
            if let Some(target) = super::shared_worker_target(&params) {
                attach(core, &target);
            }
        })?;
        on_event(
            core,
            "Inspector.targetReloadedAfterCrash",
            |core, session, _| {
                if let Some(session) = session {
                    log::info!("resuming a restarted shared worker WebView2 left paused");
                    call(
                        core,
                        Some(&session),
                        "Runtime.runIfWaitingForDebugger",
                        "{}",
                        |_| {},
                    );
                }
            },
        )?;
        // Reports the workers already running too, so none is missed.
        call(
            core,
            None,
            "Target.setDiscoverTargets",
            r#"{"discover":true}"#,
            |_| {},
        );
        Ok(())
    }

    fn attach(core: &ICoreWebView2, target: &str) {
        let params = serde_json::json!({ "targetId": target, "flatten": true }).to_string();
        let page = core.clone();
        call(
            core,
            None,
            "Target.attachToTarget",
            &params,
            move |result| {
                let Some(session) = super::attached_session(&result) else {
                    log::warn!("could not attach to a shared worker: {result}");
                    return;
                };
                // Restarts are reported to sessions with the Inspector domain on.
                call(&page, Some(&session), "Inspector.enable", "{}", |_| {});
                call(
                    &page,
                    Some(&session),
                    "Runtime.runIfWaitingForDebugger",
                    "{}",
                    |_| {},
                );
            },
        );
    }

    /// Run a DevTools method on the page, or on a session attached through it.
    fn call(
        core: &ICoreWebView2,
        session: Option<&str>,
        method: &str,
        params: &str,
        done: impl FnOnce(String) + 'static,
    ) {
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, result| {
                match status {
                    Ok(()) => done(result),
                    Err(error) => log::warn!("WebView2 DevTools call failed: {error}"),
                }
                Ok(())
            }));
        let (method_name, params) = (HSTRING::from(method), HSTRING::from(params));
        // SAFETY: called on the main thread that owns the webview.
        let sent = unsafe {
            match session {
                Some(session) => core.cast::<ICoreWebView2_11>().and_then(|core| {
                    core.CallDevToolsProtocolMethodForSession(
                        &HSTRING::from(session),
                        &method_name,
                        &params,
                        &handler,
                    )
                }),
                None => core.CallDevToolsProtocolMethod(&method_name, &params, &handler),
            }
        };
        if let Err(error) = sent {
            log::warn!("could not send {method} to WebView2 DevTools: {error}");
        }
    }

    /// Subscribe to a DevTools event from the page or any attached session.
    /// The handler receives the session id (none for the page) and the
    /// event's parameters as JSON.
    fn on_event(
        core: &ICoreWebView2,
        event: &str,
        mut handle: impl FnMut(&ICoreWebView2, Option<String>, String) + 'static,
    ) -> Result<()> {
        let receiver = unsafe { core.GetDevToolsProtocolEventReceiver(&HSTRING::from(event))? };
        // WebView2 releases the handler, and with it the receiver, when the
        // webview closes.
        let keep = receiver.clone();
        let handler =
            DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |sender, args| {
                let _ = &keep;
                let (Some(core), Some(args)) = (sender, args) else {
                    return Ok(());
                };
                let mut params = PWSTR::null();
                // SAFETY: WebView2 allocates both strings; take_pwstr frees them.
                unsafe {
                    args.ParameterObjectAsJson(&mut params)?;
                    let params = take_pwstr(params);
                    let mut session = PWSTR::null();
                    let session = args
                        .cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>()
                        .and_then(|args| args.SessionId(&mut session))
                        .map(|()| take_pwstr(session))
                        .ok()
                        .filter(|session| !session.is_empty());
                    handle(&core, session, params);
                }
                Ok(())
            }));
        let mut token = 0;
        unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) }
    }
}

/// The id of a SharedWorker from `Target.targetCreated` parameters.
#[cfg(any(target_os = "windows", test))]
fn shared_worker_target(params: &str) -> Option<String> {
    let params: serde_json::Value = serde_json::from_str(params).ok()?;
    let target = params.get("targetInfo")?;
    if target.get("type")?.as_str()? != "shared_worker" {
        return None;
    }
    target.get("targetId")?.as_str().map(str::to_string)
}

/// The session id from a `Target.attachToTarget` result.
#[cfg(any(target_os = "windows", test))]
fn attached_session(result: &str) -> Option<String> {
    let result: serde_json::Value = serde_json::from_str(result).ok()?;
    result.get("sessionId")?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_shared_workers_are_attached() {
        let created = |kind: &str| {
            format!(r#"{{"targetInfo":{{"targetId":"8410CF00","type":"{kind}","attached":true}}}}"#)
        };
        assert_eq!(
            shared_worker_target(&created("shared_worker")).as_deref(),
            Some("8410CF00")
        );
        assert_eq!(shared_worker_target(&created("worker")), None);
        assert_eq!(shared_worker_target(&created("page")), None);
        assert_eq!(
            attached_session(r#"{"sessionId":"AC8266AA"}"#).as_deref(),
            Some("AC8266AA")
        );
        assert_eq!(attached_session("{}"), None);
    }

    #[test]
    fn only_a_real_version_counts_as_installed() {
        assert!(version_installed(Some("131.0.2903.70")));
        assert!(!version_installed(Some("0.0.0.0")));
        assert!(!version_installed(Some("  ")));
        assert!(!version_installed(None));
    }
}
