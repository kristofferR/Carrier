//! Bound Messenger's WKWebView high-water memory after it has gone inactive.
//!
//! Meta's long-lived SPA leaves large allocations in WebKit's content process.
//! A same-process reload keeps that allocator, while terminating the content
//! process releases it. Carrier already refreshes an inactive page every
//! fifteen minutes for sync health; this module upgrades that existing refresh
//! to a renderer restart only when it has actually crossed the soft limit.

use std::mem::MaybeUninit;

use objc2::{msg_send, runtime::AnyObject, sel};
use tauri::Manager;

/// Above this footprint, prefer a fresh renderer to another same-process load.
/// This is deliberately a soft background limit, not a foreground kill limit.
const WEB_CONTENT_SOFT_LIMIT: u64 = 512 * 1024 * 1024;

fn should_recycle(physical_footprint: u64) -> bool {
    physical_footprint >= WEB_CONTENT_SOFT_LIMIT
}

/// Read the physical footprint Activity Monitor attributes to the WKWebView's
/// content process. `_webProcessIdentifier` is WebKit SPI, like the
/// `drawsBackground` hook Carrier already needs for title-bar rendering.
fn web_content_physical_footprint(wk_webview: *mut AnyObject) -> Option<u64> {
    if wk_webview.is_null() {
        return None;
    }

    // Private SPI can disappear independently of Carrier's deployment target.
    // Treat that exactly like a failed footprint query so the caller falls
    // back to Carrier's existing ordinary reload.
    // SAFETY: `wk_webview` is the live WKWebView supplied by Tauri on the main
    // thread for the duration of this callback.
    let can_read_pid: bool =
        unsafe { msg_send![wk_webview, respondsToSelector: sel!(_webProcessIdentifier)] };
    if !can_read_pid {
        return None;
    }

    let pid: libc::pid_t = unsafe { msg_send![wk_webview, _webProcessIdentifier] };
    if pid <= 0 {
        return None;
    }

    process_physical_footprint(pid)
}

fn process_physical_footprint(pid: libc::pid_t) -> Option<u64> {
    let mut usage = MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: proc_pid_rusage writes an rusage_info_v4 into the caller-owned,
    // correctly sized buffer for RUSAGE_INFO_V4. The PID came from this
    // WKWebView rather than process enumeration, so another app is never read.
    let result = unsafe {
        libc::proc_pid_rusage(
            pid,
            libc::RUSAGE_INFO_V4,
            usage.as_mut_ptr().cast::<libc::rusage_info_t>(),
        )
    };
    (result == 0).then(|| {
        // SAFETY: a successful proc_pid_rusage initialized the entire buffer.
        unsafe { usage.assume_init() }.ri_phys_footprint
    })
}

/// Perform Carrier's already-scheduled inactive refresh. Oversized renderers
/// are terminated so WebKit releases their allocator; smaller ones use the
/// ordinary, cheaper reload path. The WKWebView itself survives, avoiding
/// WebKit's idle-process cache and preserving all native window state.
pub(crate) fn refresh_inactive_messenger(app: &tauri::AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let label = label.to_string();
    let inspected_label = label.clone();
    let reload_window = window.clone();
    if let Err(error) = window.with_webview(move |webview| {
        let wk_webview = webview.inner() as *mut AnyObject;
        let footprint = web_content_physical_footprint(wk_webview);
        // SAFETY: the pointer is the live object for the duration of this
        // Tauri callback.
        let can_restart: bool = !wk_webview.is_null()
            && unsafe {
                msg_send![wk_webview, respondsToSelector: sel!(_killWebContentProcessAndResetState)]
            };
        if footprint.is_some_and(should_recycle) && can_restart {
            let mib = footprint.unwrap_or_default() / (1024 * 1024);
            log::info!(
                "Messenger renderer {label} reached {mib} MiB while inactive; restarting it to release WebKit memory"
            );
            // SAFETY: `wk_webview` is the live WKWebView supplied by Tauri on
            // the main thread. WebKit's client-requested termination starts a
            // fresh content process for the reload below instead of caching the
            // oversized old process after a WKWebView teardown.
            unsafe {
                let _: () = msg_send![wk_webview, _killWebContentProcessAndResetState];
            }
        }

        if let Err(error) = reload_window.reload() {
            log::warn!("failed to refresh inactive Messenger webview {label}: {error}");
        }
    }) {
        log::warn!("failed to inspect inactive Messenger webview {inspected_label}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_recycling_uses_an_inclusive_soft_limit() {
        assert!(!should_recycle(WEB_CONTENT_SOFT_LIMIT - 1));
        assert!(should_recycle(WEB_CONTENT_SOFT_LIMIT));
        assert!(should_recycle(WEB_CONTENT_SOFT_LIMIT + 1));
    }

    #[test]
    fn process_footprint_reads_the_current_process() {
        let footprint = process_physical_footprint(std::process::id() as libc::pid_t);
        assert!(footprint.is_some_and(|bytes| bytes > 0));
    }
}
