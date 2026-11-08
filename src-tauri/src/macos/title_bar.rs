//! Messenger windows without a separate title bar, like the old Messenger
//! app: the window buttons float over the page, which keeps a strip of
//! [`INSET`] points free at the top. A transparent native view over that strip
//! drags the window and answers a double-click as the system's title bar does,
//! so the page needs no window permissions. While Messenger's photo viewer is
//! open the window gets a title bar of its own, as the viewer puts its buttons
//! at the very top: Tauri's Transparent style, which lays the page out below
//! it and paints it in the window's themed background (Visible keeps the page
//! under an opaque bar). In full screen the strip goes, with the title bar.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};

use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{msg_send, sel};
use tauri::{TitleBarStyle, WebviewWindow, WindowEvent};

/// Height of the strip under the window buttons, in points (CSS pixels at 100%).
pub(crate) const INSET: f64 = 28.0;

/// The page zoom in percent. Native zoom scales CSS pixels, so the page's
/// inset shrinks as it grows. Kept here rather than read from the settings,
/// whose lock may be held by whoever changes the zoom.
static ZOOM_PERCENT: AtomicI32 = AtomicI32::new(100);

/// Windows whose photo viewer is open, by label.
fn viewer_open() -> &'static Mutex<HashSet<String>> {
    static OPEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    OPEN.get_or_init(Default::default)
}

/// The inset each window's page was last told, by label.
fn told_inset() -> &'static Mutex<HashMap<String, f64>> {
    static TOLD: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();
    TOLD.get_or_init(Default::default)
}

/// The drag strip's class: an NSView that moves the window.
fn drag_view_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| {
        let superclass = AnyClass::get(c"NSView").expect("AppKit has NSView");
        let mut builder = ClassBuilder::new(c"CarrierTitleBarDragView", superclass)
            .expect("the drag view class is registered once");
        // SAFETY: each method matches its selector's Objective-C signature.
        unsafe {
            builder.add_method(
                sel!(mouseDownCanMoveWindow),
                yes as extern "C-unwind" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(acceptsFirstMouse:),
                yes_for_event as extern "C-unwind" fn(_, _, _) -> _,
            );
            builder.add_method(
                sel!(mouseDown:),
                mouse_down as extern "C-unwind" fn(_, _, _),
            );
        }
        builder.register()
    })
}

extern "C-unwind" fn yes(_this: &AnyObject, _cmd: Sel) -> Bool {
    Bool::YES
}

extern "C-unwind" fn yes_for_event(_this: &AnyObject, _cmd: Sel, _event: *mut AnyObject) -> Bool {
    Bool::YES
}

/// A double-click does what System Settings › Desktop & Dock says a title bar
/// double-click does; any other press drags the window.
extern "C-unwind" fn mouse_down(this: &AnyObject, _cmd: Sel, event: *mut AnyObject) {
    // SAFETY: AppKit calls this on the main thread with the view's live
    // window and the mouse-down event.
    unsafe {
        let window: *mut AnyObject = msg_send![this, window];
        if window.is_null() || event.is_null() {
            return;
        }
        let clicks: isize = msg_send![event, clickCount];
        if clicks == 2 {
            let defaults: *mut AnyObject =
                msg_send![objc2::class!(NSUserDefaults), standardUserDefaults];
            let key = objc2_foundation::NSString::from_str("AppleActionOnDoubleClick");
            let action: Option<objc2::rc::Retained<objc2_foundation::NSString>> =
                msg_send![defaults, stringForKey: &*key];
            match action.map(|action| action.to_string()).as_deref() {
                Some("None") => {}
                Some("Minimize") => {
                    let _: () = msg_send![window, performMiniaturize: this];
                }
                _ => {
                    let _: () = msg_send![window, performZoom: this];
                }
            }
            return;
        }
        let _: () = msg_send![window, performWindowDragWithEvent: event];
    }
}

/// Put the drag strip over the top of a Messenger window and keep it, and the
/// page's inset, in step with full screen and the photo viewer.
pub(crate) fn install(window: &WebviewWindow) {
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as usize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: Tauri returns the live NSWindow of a window that still
        // exists; the view is added on the main thread.
        unsafe {
            let ns_window = ns_window as *mut AnyObject;
            let content: *mut AnyObject = msg_send![ns_window, contentView];
            if content.is_null() {
                return;
            }
            let bounds: objc2_foundation::NSRect = msg_send![content, bounds];
            let flipped: bool = msg_send![content, isFlipped];
            let y = if flipped {
                0.0
            } else {
                bounds.size.height - INSET
            };
            let frame = objc2_foundation::NSRect::new(
                objc2_foundation::NSPoint::new(0.0, y),
                objc2_foundation::NSSize::new(bounds.size.width, INSET),
            );
            let view: *mut AnyObject = msg_send![drag_view_class(), alloc];
            let view: *mut AnyObject = msg_send![view, initWithFrame: frame];
            // Full width, pinned to the top edge.
            const WIDTH_SIZABLE: usize = 2;
            const MIN_Y_MARGIN: usize = 8;
            const MAX_Y_MARGIN: usize = 32;
            let mask = WIDTH_SIZABLE | if flipped { MAX_Y_MARGIN } else { MIN_Y_MARGIN };
            let _: () = msg_send![view, setAutoresizingMask: mask];
            let _: () = msg_send![content, addSubview: view];
            let _: () = msg_send![view, release];
        }
    });
    let watched = window.clone();
    window.on_window_event(move |event| {
        // Entering or leaving full screen resizes the window.
        if matches!(event, WindowEvent::Resized(_)) {
            sync(&watched);
        }
    });
}

/// Called when the page's photo viewer opens or closes.
pub(crate) fn set_viewer_open(window: &WebviewWindow, open: bool) {
    let changed = {
        let mut set = viewer_open().lock().unwrap();
        if open {
            set.insert(window.label().to_string())
        } else {
            set.remove(window.label())
        }
    };
    if !changed {
        return;
    }
    let style = if open {
        TitleBarStyle::Transparent
    } else {
        TitleBarStyle::Overlay
    };
    if let Err(error) = window.set_title_bar_style(style) {
        log::warn!("could not switch the title bar for the photo viewer: {error}");
    }
    sync(window);
    // Changing the style leaves the window without a first responder, so
    // Escape and the arrow keys wouldn't reach the viewer until clicked.
    let _ = window.with_webview(|webview| {
        // SAFETY: the live WKWebView and its NSWindow, on the main thread.
        unsafe {
            let view = webview.inner().cast::<AnyObject>();
            let ns_window = webview.ns_window().cast::<AnyObject>();
            if !view.is_null() && !ns_window.is_null() {
                let _: Bool = msg_send![ns_window, makeFirstResponder: view];
            }
        }
    });
}

/// Forget a closed window's state.
pub(crate) fn forget(label: &str) {
    viewer_open().lock().unwrap().remove(label);
    told_inset().lock().unwrap().remove(label);
}

/// A new page starts from the initial inset: tell it the current one.
pub(crate) fn page_loaded(window: &WebviewWindow) {
    told_inset().lock().unwrap().remove(window.label());
    sync(window);
}

/// The strip the page keeps free right now: none in full screen or while the
/// photo viewer has a title bar of its own.
fn current_inset(window: &WebviewWindow) -> f64 {
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let viewer = viewer_open().lock().unwrap().contains(window.label());
    if fullscreen || viewer {
        0.0
    } else {
        css_inset(ZOOM_PERCENT.load(Ordering::Relaxed))
    }
}

/// The strip in CSS pixels at a page zoom of `zoom_percent`.
pub(crate) fn css_inset(zoom_percent: i32) -> f64 {
    INSET * 100.0 / f64::from(zoom_percent.max(1))
}

/// Called whenever a Messenger window's page zoom is set.
pub(crate) fn zoom_changed(window: &WebviewWindow, percent: i32) {
    ZOOM_PERCENT.store(percent, Ordering::Relaxed);
    sync(window);
}

/// The script that tells a page how much room to keep under the window buttons.
pub(crate) fn inset_script(inset: f64) -> String {
    format!(
        "document.documentElement && document.documentElement.style.setProperty(\
         '--carrier-title-bar-inset', '{inset}px');"
    )
}

/// Bring the drag strip and the page's inset in line with the window's state,
/// when it changed. Only Messenger windows have the strip; call windows keep a
/// title bar.
pub(crate) fn sync(window: &WebviewWindow) {
    if !crate::window::is_messenger_window_label(window.label()) {
        return;
    }
    let inset = current_inset(window);
    let previous = told_inset()
        .lock()
        .unwrap()
        .insert(window.label().to_string(), inset);
    if previous == Some(inset) {
        return;
    }
    let _ = window.eval(inset_script(inset));
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as usize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: the live NSWindow; its subviews are read on the main thread.
        unsafe {
            let ns_window = ns_window as *mut AnyObject;
            let content: *mut AnyObject = msg_send![ns_window, contentView];
            if content.is_null() {
                return;
            }
            let subviews: *mut AnyObject = msg_send![content, subviews];
            let count: usize = msg_send![subviews, count];
            for index in 0..count {
                let view: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
                let is_strip: bool = msg_send![view, isKindOfClass: drag_view_class()];
                if is_strip {
                    let _: () = msg_send![view, setHidden: inset == 0.0];
                }
            }
        }
    });
}
