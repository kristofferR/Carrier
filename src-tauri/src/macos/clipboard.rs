//! Native macOS pasteboard writes for media context-menu actions.

use objc2::runtime::AnyObject;
use objc2_foundation::NSString;

fn with_pasteboard<T: Send + 'static>(
    app: &tauri::AppHandle,
    write: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    if objc2::MainThreadMarker::new().is_some() {
        return Some(write());
    }

    let (sent, received) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sent.send(write());
    })
    .ok()?;
    received.recv().ok()
}

pub(crate) fn copy_text(app: &tauri::AppHandle, text: String) {
    let _ = with_pasteboard(app, move || unsafe {
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

pub(crate) fn copy_image(app: &tauri::AppHandle, bytes: Vec<u8>) -> bool {
    // SAFETY: `with_pasteboard` runs this on the main thread as AppKit requires.
    // NSData copies `bytes`. `alloc`/`initWithData:` gives us a +1 image retain;
    // `arrayWithObject:` retains it independently, so `release` balances our +1.
    // When `initWithData:` returns nil, it has consumed the allocated receiver,
    // so the early return has no caller-owned retain to release.
    with_pasteboard(app, move || unsafe {
        use objc2::{class, msg_send};

        let data: *mut AnyObject =
            msg_send![class!(NSData), dataWithBytes: bytes.as_ptr(), length: bytes.len()];
        let image: *mut AnyObject = msg_send![class!(NSImage), alloc];
        let image: *mut AnyObject = msg_send![image, initWithData: data];
        if image.is_null() {
            log::warn!("context-menu image was not a format AppKit could copy");
            return false;
        }
        let pasteboard: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
        let _: isize = msg_send![pasteboard, clearContents];
        let objects: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: image];
        let written: bool = msg_send![pasteboard, writeObjects: objects];
        let _: () = msg_send![image, release];
        if !written {
            log::warn!("failed to write context-menu image to the macOS pasteboard");
        }
        written
    })
    .unwrap_or(false)
}
