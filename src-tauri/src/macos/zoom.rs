//! Native page zoom, including Catalina's pre-public-API WebKit selector.

use objc2::runtime::AnyObject;
use objc2::{msg_send, sel};

pub(crate) fn set_page_zoom(window: &tauri::WebviewWindow, factor: f64) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        let webview = webview.inner().cast::<AnyObject>();
        if webview.is_null() {
            return;
        }
        // SAFETY: with_webview supplies the live WKWebView on the main thread.
        // Check each selector before sending it: setPageZoom: requires macOS 11,
        // while Catalina's _setPageZoomFactor: sets the same WebKit page zoom.
        unsafe {
            let public: bool = msg_send![webview, respondsToSelector: sel!(setPageZoom:)];
            if public {
                let _: () = msg_send![webview, setPageZoom: factor];
            } else {
                let legacy: bool =
                    msg_send![webview, respondsToSelector: sel!(_setPageZoomFactor:)];
                if legacy {
                    let _: () = msg_send![webview, _setPageZoomFactor: factor];
                } else {
                    log::warn!("WebKit does not support native page zoom");
                }
            }
        }
    })
}
