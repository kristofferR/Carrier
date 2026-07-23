//! macOS-only native (objc2) interop: WKWebView transparency and memory,
//! the NSWindow background + appearance observer, the Dock menu, and
//! `UNUserNotificationCenter` delivery.

pub(crate) mod dock;
pub(crate) mod memory;
pub(crate) mod notifications;
pub(crate) mod theme;
