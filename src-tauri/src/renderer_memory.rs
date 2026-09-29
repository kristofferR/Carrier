//! Restart an idle Messenger renderer that has grown well past its settled size.
//!
//! Facebook's long-lived SPA keeps growing inside WebKit's web process, and a
//! same-process reload keeps the allocator's high-water mark. Terminating the
//! process releases it while the window and its native state survive. Windows
//! (WebView2) has no equivalent hook here, so it never measures a footprint.

use std::time::Duration;

use tauri::WebviewWindow;

/// A document measures its own baseline once it has loaded and settled.
const SETTLE_AGE: Duration = Duration::from_secs(10 * 60);
/// Growth past the baseline that makes a fresh renderer worth a reload.
const GROWTH_LIMIT: u64 = 256 * 1024 * 1024;
/// Hidden or minimized: nobody sees the reload.
const HIDDEN_IDLE: Duration = Duration::from_secs(15 * 60);
/// Visible but unfocused, such as a window on another workspace.
const UNFOCUSED_IDLE: Duration = Duration::from_secs(60 * 60);
const SAMPLE_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Default)]
pub(crate) struct RendererMemory {
    document_epoch_ms: Option<u64>,
    document_seen_at: Option<Duration>,
    baseline: Option<u64>,
    /// Latest heartbeat: realtime healthy, no draft or call, no rate limit.
    healthy: bool,
    hidden_since: Option<Duration>,
    unfocused_since: Option<Duration>,
    last_sample_at: Option<Duration>,
}

impl RendererMemory {
    pub(crate) fn heartbeat(&mut self, now: Duration, document_epoch_ms: u64, healthy: bool) {
        if self.document_epoch_ms != Some(document_epoch_ms) {
            self.document_epoch_ms = Some(document_epoch_ms);
            self.document_seen_at = Some(now);
            self.baseline = None;
        }
        self.healthy = healthy;
    }

    pub(crate) fn window(&mut self, now: Duration, visible: bool, focused: bool) {
        if visible {
            self.hidden_since = None;
        } else {
            self.hidden_since.get_or_insert(now);
        }
        if focused {
            self.unfocused_since = None;
        } else {
            self.unfocused_since.get_or_insert(now);
        }
    }

    /// Navigation, recovery, or a restart: wait for the next document.
    pub(crate) fn pause(&mut self) {
        self.document_epoch_ms = None;
        self.document_seen_at = None;
        self.baseline = None;
        self.healthy = false;
    }

    fn idle(&self, now: Duration) -> bool {
        let since = |start: Option<Duration>, limit| {
            start.is_some_and(|start| now.saturating_sub(start) >= limit)
        };
        since(self.hidden_since, HIDDEN_IDLE) || since(self.unfocused_since, UNFOCUSED_IDLE)
    }

    pub(crate) fn ready(&self, now: Duration) -> bool {
        self.healthy && self.idle(now)
    }

    /// A sample either records the settled baseline or tests an idle renderer.
    pub(crate) fn wants_sample(&self, now: Duration) -> bool {
        let settled = self
            .document_seen_at
            .is_some_and(|seen| now.saturating_sub(seen) >= SETTLE_AGE);
        let recent = self
            .last_sample_at
            .is_some_and(|at| now.saturating_sub(at) < SAMPLE_INTERVAL);
        settled && !recent && self.healthy && (self.baseline.is_none() || self.idle(now))
    }

    /// Returns the baseline when this footprint warrants a fresh renderer.
    pub(crate) fn sampled(&mut self, now: Duration, footprint: u64) -> Option<u64> {
        self.last_sample_at = Some(now);
        let baseline = *self.baseline.get_or_insert(footprint);
        (self.ready(now) && footprint >= baseline.saturating_add(GROWTH_LIMIT)).then_some(baseline)
    }
}

/// Bytes the Messenger renderer holds in RAM and swap or compression.
pub(crate) async fn footprint(window: &WebviewWindow) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let _ = window;
        tauri::async_runtime::spawn_blocking(linux::largest_web_process_footprint)
            .await
            .ok()
            .flatten()
    }
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                let _ = sender.send(macos::web_process_identifier(webview.inner().cast()));
            })
            .ok()?;
        macos::physical_footprint(receiver.await.ok()??)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = window;
        None
    }
}

/// Replace the web process, then load the same Messenger URL in a fresh one.
pub(crate) fn restart(window: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    let result = window.with_webview(|webview| {
        use webkit2gtk::WebViewExt;
        let view = webview.inner();
        view.terminate_web_process();
        view.reload();
    });
    #[cfg(target_os = "macos")]
    let result = window
        .with_webview(|webview| macos::kill_web_process(webview.inner().cast()))
        .and_then(|()| window.reload());
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let result = window.reload();
    if let Err(error) = result {
        log::warn!(
            "failed to restart Messenger renderer {}: {error}",
            window.label()
        );
    }
}

#[cfg(any(target_os = "linux", test))]
mod linux {
    /// Name, parent PID, and resident plus swapped bytes from `/proc/<pid>/status`.
    pub(super) fn parse_status(status: &str) -> Option<(&str, u32, u64)> {
        let field = |key: &str| {
            status.lines().find_map(|line| {
                line.strip_prefix(key)
                    .and_then(|rest| rest.strip_prefix(':'))
                    .map(str::trim)
            })
        };
        let kib = |key: &str| {
            field(key)
                .and_then(|value| value.strip_suffix("kB"))
                .and_then(|value| value.trim().parse::<u64>().ok())
        };
        let resident = kib("VmRSS")?;
        Some((
            field("Name")?,
            field("PPid")?.parse().ok()?,
            (resident + kib("VmSwap").unwrap_or(0)) * 1024,
        ))
    }

    /// WebKitGTK exposes no web-process ID. Use the largest WebKit web process
    /// under Carrier, which is Messenger's; bubblewrap may sit in between.
    #[cfg(target_os = "linux")]
    pub(super) fn largest_web_process_footprint() -> Option<u64> {
        let status = |pid: u32| std::fs::read_to_string(format!("/proc/{pid}/status")).ok();
        let carrier = std::process::id();
        let descends_from_carrier = |mut parent: u32| {
            for _ in 0..4 {
                if parent == carrier {
                    return true;
                }
                let Some(next) = status(parent)
                    .as_deref()
                    .and_then(parse_status)
                    .map(|(_, parent, _)| parent)
                else {
                    return false;
                };
                parent = next;
            }
            false
        };
        std::fs::read_dir("/proc")
            .ok()?
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(|pid| {
                let status = status(pid)?;
                let (name, parent, bytes) = parse_status(&status)?;
                (name == "WebKitWebProces" && descends_from_carrier(parent)).then_some(bytes)
            })
            .max()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::mem::MaybeUninit;

    use objc2::{msg_send, runtime::AnyObject, sel};

    fn responds(webview: *mut AnyObject, selector: objc2::runtime::Sel) -> bool {
        // SAFETY: `webview` is the live WKWebView Tauri passes to a main-thread
        // `with_webview` callback.
        !webview.is_null() && unsafe { msg_send![webview, respondsToSelector: selector] }
    }

    /// `_webProcessIdentifier` is WebKit SPI. Without the matching kill SPI a
    /// reload keeps the old process, so report nothing and never restart.
    pub(super) fn web_process_identifier(webview: *mut AnyObject) -> Option<libc::pid_t> {
        if !responds(webview, sel!(_webProcessIdentifier))
            || !responds(webview, sel!(_killWebContentProcessAndResetState))
        {
            return None;
        }
        // SAFETY: checked above on the live main-thread WKWebView.
        let pid: libc::pid_t = unsafe { msg_send![webview, _webProcessIdentifier] };
        (pid > 0).then_some(pid)
    }

    /// The footprint Activity Monitor shows, including compressed memory.
    pub(super) fn physical_footprint(pid: libc::pid_t) -> Option<u64> {
        let mut usage = MaybeUninit::<libc::rusage_info_v4>::zeroed();
        // SAFETY: proc_pid_rusage writes an rusage_info_v4 into this correctly
        // sized buffer. The PID came from Carrier's own WKWebView.
        let result = unsafe {
            libc::proc_pid_rusage(
                pid,
                libc::RUSAGE_INFO_V4,
                usage.as_mut_ptr().cast::<libc::rusage_info_t>(),
            )
        };
        // SAFETY: a successful call initialized the whole buffer.
        (result == 0).then(|| unsafe { usage.assume_init() }.ri_phys_footprint)
    }

    pub(super) fn kill_web_process(webview: *mut AnyObject) {
        if responds(webview, sel!(_killWebContentProcessAndResetState)) {
            // SAFETY: checked above on the live main-thread WKWebView.
            unsafe {
                let _: () = msg_send![webview, _killWebContentProcessAndResetState];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    fn at(minutes: u64) -> Duration {
        Duration::from_secs(minutes * 60)
    }

    fn settled_hidden_renderer(baseline: u64) -> RendererMemory {
        let mut memory = RendererMemory::default();
        memory.heartbeat(at(0), 1, true);
        memory.window(at(0), false, false);
        assert!(memory.wants_sample(at(10)));
        assert_eq!(memory.sampled(at(10), baseline), None);
        memory
    }

    #[test]
    fn restarts_only_after_growing_past_the_settled_baseline() {
        let mut memory = RendererMemory::default();
        memory.heartbeat(at(0), 1, true);
        assert!(!memory.wants_sample(at(9)));

        let mut memory = settled_hidden_renderer(900 * MIB);
        assert!(!memory.wants_sample(at(10)));
        assert!(memory.wants_sample(at(16)));
        assert_eq!(memory.sampled(at(16), 1155 * MIB), None);
        assert!(!memory.wants_sample(at(16)));
        assert_eq!(memory.sampled(at(17), 1156 * MIB), Some(900 * MIB));
    }

    #[test]
    fn visible_windows_wait_for_an_hour_unfocused_and_focus_resets_the_clock() {
        let mut memory = settled_hidden_renderer(900 * MIB);
        memory.window(at(11), true, false);
        assert!(!memory.ready(at(59)));
        memory.window(at(30), true, true);
        memory.window(at(31), true, false);
        assert!(!memory.ready(at(90)));
        assert!(memory.ready(at(91)));
    }

    #[test]
    fn an_unhealthy_page_or_new_document_is_never_restarted() {
        let mut memory = settled_hidden_renderer(900 * MIB);
        memory.heartbeat(at(20), 1, false);
        assert!(!memory.wants_sample(at(20)));
        assert_eq!(memory.sampled(at(20), 2048 * MIB), None);

        memory.heartbeat(at(21), 2, true);
        assert!(!memory.wants_sample(at(30)));
        assert!(memory.wants_sample(at(31)));
        assert_eq!(memory.sampled(at(31), 2048 * MIB), None);

        memory.pause();
        assert!(!memory.wants_sample(at(60)));
    }

    #[test]
    fn linux_status_counts_resident_and_swapped_memory() {
        let status =
            "Name:\tWebKitWebProces\nPPid:\t42\nVmRSS:\t  937712 kB\nVmSwap:\t  490208 kB\n";
        assert_eq!(
            linux::parse_status(status),
            Some(("WebKitWebProces", 42, (937_712 + 490_208) * 1024))
        );
        assert_eq!(linux::parse_status("Name:\tkthreadd\nPPid:\t2\n"), None);
    }
}
