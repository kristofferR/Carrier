//! Native macOS pasteboard writes for media context-menu actions.

use objc2::runtime::AnyObject;
use objc2_foundation::NSString;
use tauri::Manager;

fn with_pasteboard(app: &tauri::AppHandle, label: &str, write: impl FnOnce() + Send + 'static) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let _ = window.with_webview(move |_| write());
}

pub(crate) fn copy_text(app: &tauri::AppHandle, label: &str, text: String) {
    with_pasteboard(app, label, move || unsafe {
        use objc2::{class, msg_send};

        let pasteboard: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        let _: isize = msg_send![pasteboard, clearContents];
        let value = NSString::from_str(&text);
        let kind = NSString::from_str("public.utf8-plain-text");
        let written: bool = msg_send![pasteboard, setString: &*value, forType: &*kind];
        if !written {
            log::warn!("failed to write context-menu address to the macOS pasteboard");
        }
    });
}

pub(crate) fn copy_image(app: &tauri::AppHandle, label: &str, bytes: Vec<u8>) {
    with_pasteboard(app, label, move || unsafe {
        use objc2::{class, msg_send};

        let data: *mut AnyObject =
            msg_send![class!(NSData), dataWithBytes: bytes.as_ptr(), length: bytes.len()];
        let image: *mut AnyObject = msg_send![class!(NSImage), alloc];
        let image: *mut AnyObject = msg_send![image, initWithData: data];
        if image.is_null() {
            log::warn!("context-menu image was not a format AppKit could copy");
            return;
        }
        let pasteboard: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        let _: isize = msg_send![pasteboard, clearContents];
        let objects: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: image];
        let written: bool = msg_send![pasteboard, writeObjects: objects];
        let _: () = msg_send![image, release];
        if !written {
            log::warn!("failed to write context-menu image to the macOS pasteboard");
        }
    });
}
