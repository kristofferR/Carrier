//! Foreground rendering for notification actions in a window nobody is
//! looking at.
//!
//! WebKit treats a covered or ordered-out window as hidden and drops its web
//! process to background priority (`pri` 4), where opening a conversation for
//! a 👍, Mute, or inline reply takes 10+ seconds and effectively waits for the
//! user to open the window. For the duration of one action, Carrier makes
//! WebKit count the main window as visible:
//!
//! - a covered window only needs WKWebView's occlusion detection switched off;
//! - an ordered-out window is also ordered in at the back, fully transparent
//!   and ignoring the mouse.
//!
//! Everything is restored when the action ends. If the user reveals the
//! window meanwhile (tray, Dock, focus), it becomes opaque at once and stays.

use std::sync::Mutex;
use std::time::Duration;

use objc2::runtime::AnyObject;
use objc2::{msg_send, sel};
use tauri::Manager;

#[derive(Clone, Copy)]
struct Engaged {
    occlusion_detection_was_enabled: bool,
    /// Set while Carrier holds an ordered-out window in, transparent.
    ordered_in: Option<Transparency>,
}

#[derive(Clone, Copy)]
struct Transparency {
    alpha: f64,
    ignored_mouse: bool,
}

// Notification actions are serialized natively, so one engagement at a time.
static ENGAGED: Mutex<Option<Engaged>> = Mutex::new(None);

/// Restores the main window when dropped.
pub(crate) struct ForegroundRender {
    app: tauri::AppHandle,
}

fn responds(object: *mut AnyObject, selector: objc2::runtime::Sel) -> bool {
    // SAFETY: callers pass a live AppKit/WebKit object on the main thread.
    !object.is_null() && unsafe { msg_send![object, respondsToSelector: selector] }
}

/// Make WebKit treat the main window as visible until the guard drops. None
/// when there is no main window, it is already visible to the user, or the
/// WebKit SPI is missing.
pub(crate) fn begin(app: &tauri::AppHandle) -> Option<ForegroundRender> {
    let window = app.get_webview_window("main")?;
    let (sent, received) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |webview| {
            let webview = webview.inner().cast();
            let engaged = engage(webview);
            // `begin` stopped waiting: no guard exists to restore this, so
            // undo it at once rather than leave the window held in.
            if sent.send(engaged).is_err() && engaged == Some(true) {
                release(webview);
            }
        })
        .ok()?;
    let engaged = received.recv_timeout(Duration::from_secs(2)).ok().flatten();
    (engaged == Some(true)).then(|| ForegroundRender { app: app.clone() })
}

/// Runs on the main thread inside `with_webview`.
fn engage(webview: *mut AnyObject) -> Option<bool> {
    if !responds(webview, sel!(_setWindowOcclusionDetectionEnabled:))
        || !responds(webview, sel!(_windowOcclusionDetectionEnabled))
    {
        return Some(false);
    }
    // SAFETY: `webview` is the live main-thread WKWebView; its window (if any)
    // is a live NSWindow. Every selector is public AppKit or checked above.
    unsafe {
        let window: *mut AnyObject = msg_send![webview, window];
        if window.is_null() {
            return Some(false);
        }
        let visible: bool = msg_send![window, isVisible];
        let miniaturized: bool = msg_send![window, isMiniaturized];
        let key: bool = msg_send![window, isKeyWindow];
        // The user is looking at it, or it is in the Dock (ordering a
        // minimized window in would restore it).
        if key || miniaturized {
            return Some(false);
        }
        let occlusion_detection_was_enabled: bool =
            msg_send![webview, _windowOcclusionDetectionEnabled];
        let _: () = msg_send![webview, _setWindowOcclusionDetectionEnabled: false];
        let ordered_in = (!visible).then(|| {
            let transparency = Transparency {
                alpha: msg_send![window, alphaValue],
                ignored_mouse: msg_send![window, ignoresMouseEvents],
            };
            let _: () = msg_send![window, setAlphaValue: 0.0_f64];
            let _: () = msg_send![window, setIgnoresMouseEvents: true];
            let _: () = msg_send![window, orderBack: std::ptr::null::<AnyObject>()];
            transparency
        });
        notify_occlusion_changed(window);
        *ENGAGED.lock().unwrap() = Some(Engaged {
            occlusion_detection_was_enabled,
            ordered_in,
        });
        Some(true)
    }
}

impl Drop for ForegroundRender {
    fn drop(&mut self) {
        let Some(window) = self.app.get_webview_window("main") else {
            ENGAGED.lock().unwrap().take();
            return;
        };
        let _ = window.with_webview(|webview| release(webview.inner().cast()));
    }
}

/// Undo `engage`. Runs on the main thread inside `with_webview`.
fn release(webview: *mut AnyObject) {
    let Some(engaged) = ENGAGED.lock().unwrap().take() else {
        return;
    };
    if !responds(webview, sel!(_setWindowOcclusionDetectionEnabled:)) {
        return;
    }
    // SAFETY: as in `engage`, on the main thread.
    unsafe {
        let _: () = msg_send![
            webview,
            _setWindowOcclusionDetectionEnabled: engaged.occlusion_detection_was_enabled
        ];
        let window: *mut AnyObject = msg_send![webview, window];
        if window.is_null() {
            return;
        }
        if let Some(transparency) = engaged.ordered_in {
            let _: () = msg_send![window, orderOut: std::ptr::null::<AnyObject>()];
            restore_transparency(window, transparency);
        }
        notify_occlusion_changed(window);
    }
}

/// WebKit re-reads a window's visibility only when its occlusion state
/// changes, so toggling occlusion detection alone leaves a covered page
/// hidden. Post the notification WebKit's window observer listens for.
///
/// # Safety
/// `window` must be a live NSWindow, on the main thread.
unsafe fn notify_occlusion_changed(window: *mut AnyObject) {
    let center: *mut AnyObject = msg_send![objc2::class!(NSNotificationCenter), defaultCenter];
    let name = objc2_foundation::NSString::from_str("NSWindowDidChangeOcclusionStateNotification");
    let _: () = msg_send![center, postNotificationName: &*name, object: window];
}

/// # Safety
/// `window` must be a live NSWindow, on the main thread.
unsafe fn restore_transparency(window: *mut AnyObject, transparency: Transparency) {
    let _: () = msg_send![window, setAlphaValue: transparency.alpha];
    let _: () = msg_send![window, setIgnoresMouseEvents: transparency.ignored_mouse];
}

/// Whether a notification action is holding the closed main window in,
/// transparently. AppKit reports it visible meanwhile.
pub(crate) fn holds_window_in() -> bool {
    ENGAGED
        .lock()
        .unwrap()
        .is_some_and(|engaged| engaged.ordered_in.is_some())
}

/// The user is revealing the main window: make a transparent stand-in opaque
/// so they see it, and keep it open when the action ends. Returns whether a
/// transparent window was handed over. Call on the main thread before showing.
pub(crate) fn hand_over(window: &tauri::WebviewWindow) -> bool {
    let transparency = {
        let mut engaged = ENGAGED.lock().unwrap();
        match engaged
            .as_mut()
            .and_then(|engaged| engaged.ordered_in.take())
        {
            Some(transparency) => transparency,
            None => return false,
        }
    };
    if let Ok(ns_window) = window.ns_window() {
        // SAFETY: Tauri's live NSWindow for the main window, on the main thread.
        unsafe { restore_transparency(ns_window.cast(), transparency) };
    }
    true
}
