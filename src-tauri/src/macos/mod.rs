//! macOS-only native (objc2) interop: WKWebView transparency, the NSWindow
//! background + appearance observer, the Dock menu, and
//! `UNUserNotificationCenter` delivery.

pub(crate) mod dock;
pub(crate) mod notifications;
pub(crate) mod theme;
