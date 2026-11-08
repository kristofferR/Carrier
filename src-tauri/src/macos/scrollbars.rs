//! Overlay scroll bars for the Messenger page.
//!
//! WebKit draws overlay scroll bars (thin, shown only while scrolling, moved
//! on its scrolling thread) only when AppKit prefers them, which follows
//! System Settings and whether a mouse is connected. Otherwise it draws classic
//! always-on tracks that take room from the panes. A value in Chatpane's own
//! defaults domain outranks the system-wide one, for Chatpane only. WebKit asks
//! once, when it starts, so this runs before any webview exists. Idea from
//! fMess (github.com/toanbku/fmess, MIT).

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;

pub(crate) fn prefer_overlay_scrollbars() {
    let key = NSString::from_str("AppleShowScrollBars");
    let value = NSString::from_str("WhenScrolling");
    // SAFETY: NSUserDefaults is thread-safe; a string is a valid property-list
    // value, and both strings outlive the call.
    unsafe {
        let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
        if defaults.is_null() {
            return;
        }
        let _: () = msg_send![defaults, setObject: &*value, forKey: &*key];
    }
}
