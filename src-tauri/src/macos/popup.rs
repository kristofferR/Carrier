//! Windows Messenger opens itself, such as a call window.

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{ffi, msg_send, sel};

/// wry's `WKUIDelegate` has no `webViewDidClose:`, so a page's `window.close()`
/// does nothing on macOS and a call window would stay open after its call
/// ends. Add the method to the delegate's class: it closes the window as its
/// close button would. WebKit ignores `window.close()` in a window no script
/// opened once it has navigated, so Messenger's own windows are unaffected.
pub(crate) fn close_on_page_request(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|webview| {
        let webview = webview.inner().cast::<AnyObject>();
        if webview.is_null() {
            return;
        }
        // SAFETY: with_webview supplies the live WKWebView on the main thread,
        // and the added method matches `webViewDidClose:`'s `v@:@` signature.
        unsafe {
            let delegate: Option<Retained<AnyObject>> = msg_send![webview, UIDelegate];
            let Some(delegate) = delegate else {
                return;
            };
            let class = delegate.class();
            let selector = sel!(webViewDidClose:);
            if class.instance_method(selector).is_none() {
                let imp = std::mem::transmute::<
                    unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                    Imp,
                >(web_view_did_close);
                ffi::class_addMethod(
                    (class as *const AnyClass).cast_mut(),
                    selector,
                    imp,
                    c"v@:@".as_ptr(),
                );
            }
            // WebKit records which methods a delegate implements when it is
            // assigned, so reassign it for this webview to pick up the method.
            let _: () = msg_send![webview, setUIDelegate: std::ptr::null_mut::<AnyObject>()];
            let _: () = msg_send![webview, setUIDelegate: &*delegate];
        }
    });
    if let Err(error) = result {
        log::warn!("failed to let a page close its window: {error}");
    }
}

unsafe extern "C-unwind" fn web_view_did_close(
    _delegate: *mut AnyObject,
    _cmd: Sel,
    webview: *mut AnyObject,
) {
    if webview.is_null() {
        return;
    }
    // SAFETY: WebKit calls this on the main thread with the closing WKWebView.
    unsafe {
        let window: *mut AnyObject = msg_send![webview, window];
        if !window.is_null() {
            let _: () = msg_send![window, performClose: std::ptr::null_mut::<AnyObject>()];
        }
    }
}
