//! macOS Dock-menu interop: the `applicationDockMenu:` delegate hook that
//! serves the recent-conversations menu (see [`crate::menu`]).

use std::sync::atomic::Ordering;

/// The NSMenu currently served as the Dock menu. AppKit re-queries
/// `applicationDockMenu:` on every Dock right-click, so swapping this pointer
/// (and the keepalive below) is all a rebuild takes. Null = no custom menu.
pub(crate) static DOCK_NS_MENU: std::sync::atomic::AtomicPtr<std::ffi::c_void> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

// Keeps the muda menu backing DOCK_NS_MENU alive between rebuilds. Main-thread
// only: muda menus aren't Send, and AppKit menus must be touched there anyway.
thread_local! {
    pub(crate) static DOCK_MENU_KEEPALIVE: std::cell::RefCell<Option<muda::Menu>> =
        const { std::cell::RefCell::new(None) };
}

/// The `applicationDockMenu:` implementation grafted onto tao's NSApplication
/// delegate: hand AppKit whatever menu the last rebuild published.
extern "C-unwind" fn application_dock_menu(
    _this: *mut objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    _sender: *mut objc2::runtime::AnyObject,
) -> *mut objc2::runtime::AnyObject {
    DOCK_NS_MENU.load(Ordering::SeqCst) as *mut objc2::runtime::AnyObject
}

/// Add `applicationDockMenu:` to the live app delegate so the Dock icon's
/// context menu can list recent conversations — neither tauri, tao, nor muda
/// exposes a Dock-menu API, but the delegate hook is the one AppKit blesses.
/// Called once from `RunEvent::Ready` (the delegate exists by then); the added
/// method reads [`DOCK_NS_MENU`], so later rebuilds don't touch the delegate.
pub(crate) fn install_dock_menu_provider() {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};

    // SAFETY: main-thread AppKit reads (RunEvent::Ready runs there); the
    // delegate outlives the app, and class_addMethod is a documented runtime
    // call — it fails harmlessly (returns NO) if the method ever exists.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![app, delegate];
        if delegate.is_null() {
            return;
        }
        let cls = (*delegate).class() as *const objc2::runtime::AnyClass;
        // "@@:@": returns id, takes self + _cmd + the NSApplication sender.
        let imp: objc2::runtime::Imp = std::mem::transmute(
            application_dock_menu
                as extern "C-unwind" fn(
                    *mut AnyObject,
                    objc2::runtime::Sel,
                    *mut AnyObject,
                ) -> *mut AnyObject,
        );
        objc2::ffi::class_addMethod(
            cls.cast_mut(),
            sel!(applicationDockMenu:),
            imp,
            c"@@:@".as_ptr(),
        );
    }
}
