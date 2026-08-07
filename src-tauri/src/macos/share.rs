//! macOS share sheet (NSSharingServicePicker) for downloaded Messenger media.
//!
//! The page's context menu offers "Share…" on images and videos; the media is
//! first saved through the normal trusted download flow, then the picker is
//! shown for the saved file, anchored at the click position.

use std::path::PathBuf;

use objc2::runtime::AnyObject;
use objc2_foundation::{NSPoint, NSRect, NSRectEdge, NSSize, NSString};
use tauri::Manager;

/// Association key holding the live picker on the WKWebView — AppKit does not
/// retain the picker while its menu is up, and dropping it dismisses the UI.
/// Each new share replaces (and thereby releases) the previous one.
static SHARE_PICKER_KEY: u8 = 0;

/// Show the share sheet for `path`, anchored at the given viewport-fraction
/// position (0..1 from the top-left) inside `label`'s webview.
///
/// `report(true)` means the picker was *presented* — AppKit gives no
/// completion callback without a delegate, so whether the user then chose a
/// service or dismissed the sheet is unknown here. Callers treat the value as
/// "shown", nothing stronger.
pub(crate) fn show_share_picker(
    report: impl FnOnce(bool) + Send + 'static,
    app: &tauri::AppHandle,
    label: &str,
    path: PathBuf,
    fx: f64,
    fy: f64,
) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(label) else {
        report(false);
        return Ok(());
    };
    window.with_webview(move |webview| {
        let shown = (|| {
            use objc2::{class, msg_send};

            let view = webview.inner() as *mut AnyObject;
            if view.is_null() {
                return false;
            }
            // SAFETY: `view` is the live WKWebView; runs on the main thread
            // (with_webview guarantees it), which AppKit requires for the picker.
            unsafe {
                let ns_path = NSString::from_str(&path.to_string_lossy());
                let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: &*ns_path];
                if url.is_null() {
                    return false;
                }
                let items: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: url];
                let picker: *mut AnyObject = msg_send![class!(NSSharingServicePicker), alloc];
                let picker: *mut AnyObject = msg_send![picker, initWithItems: items];
                if picker.is_null() {
                    return false;
                }
                // +1 from alloc/init, +1 from the association; drop ours so the
                // association is the only owner and replacement frees the old one.
                objc2::ffi::objc_setAssociatedObject(
                    view,
                    std::ptr::addr_of!(SHARE_PICKER_KEY).cast(),
                    picker,
                    objc2::ffi::OBJC_ASSOCIATION_RETAIN,
                );
                let _: () = msg_send![picker, release];

                // Anchor rect in the view's own coordinate space; page coordinates
                // are top-left based, so flip unless the view already is.
                let bounds: NSRect = msg_send![view, bounds];
                let flipped: bool = msg_send![view, isFlipped];
                let fx = fx.clamp(0.0, 1.0);
                let fy = fy.clamp(0.0, 1.0);
                let fy_view = if flipped { fy } else { 1.0 - fy };
                let y = fy_view * bounds.size.height;
                let rect = NSRect {
                    origin: NSPoint {
                        x: fx * bounds.size.width,
                        y,
                    },
                    size: NSSize {
                        width: 1.0,
                        height: 1.0,
                    },
                };
                // "Below the anchor" is the min-Y edge in standard coordinates but
                // the max-Y edge when the view is flipped.
                let edge = if flipped {
                    NSRectEdge::MaxY
                } else {
                    NSRectEdge::MinY
                };
                let _: () =
                    msg_send![picker, showRelativeToRect: rect, ofView: view, preferredEdge: edge];
                true
            }
        })();
        report(shown);
    })
}
