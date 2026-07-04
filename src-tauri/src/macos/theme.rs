//! macOS theme interop: force the WKWebView transparent, paint the NSWindow
//! background to match the theme, and observe live OS light/dark switches.

// `define_class!` matches the conformed protocol as a bare identifier, so bring it
// into scope rather than naming it by path in the macro body.
use objc2::runtime::NSObjectProtocol;
use tauri::{Manager, WebviewWindow};

use crate::settings::AppState;
use crate::window::recreate_themed_windows;

/// Disable the WKWebView's opaque white background so the window background —
/// which we keep in step with the theme — shows through the title bar and
/// overscroll areas. Tauri leaves the webview background unimplemented on macOS,
/// so flip the private `drawsBackground` flag ourselves (the same thing wry does
/// for transparent windows).
pub(crate) fn make_webview_transparent(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        let wk = webview.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        // SAFETY: `wk` is the live WKWebView; -setValue:forKey: with @NO on the
        // private `drawsBackground` key runs on the main thread.
        unsafe {
            let no: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: false];
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![wk, setValue: no, forKey: &*key];
        }
    });
}

/// Set the NSWindow background colour directly — Facebook dark, or white — so the
/// transparent webview shows the right colour in the title bar. Tauri's
/// set_background_color is unreliable on macOS, so we message AppKit ourselves.
/// Must run on the main thread.
pub(crate) fn set_macos_window_bg(ns_window: *mut std::ffi::c_void, dark: bool) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    if ns_window.is_null() {
        return;
    }
    // SAFETY: `ns_window` is this window's live NSWindow*; NSColor factory
    // methods and -setBackgroundColor: run on the main thread.
    unsafe {
        let ns_window = ns_window as *mut AnyObject;
        let color: *mut AnyObject = if dark {
            // Facebook dark, matching splash_background.
            msg_send![class!(NSColor), colorWithSRGBRed: 24.0f64 / 255.0, green: 25.0f64 / 255.0, blue: 26.0f64 / 255.0, alpha: 1.0f64]
        } else {
            msg_send![class!(NSColor), whiteColor]
        };
        let _: () = msg_send![ns_window, setBackgroundColor: color];
    }
}

/// The last resolved app appearance (true = dark) the observer acted on. Used to
/// drop spurious `effectiveAppearance` KVO notifications that don't actually flip
/// light↔dark — notably the ones our own `set_theme` calls post on *every*
/// settings change while Theme = System (see [`nsapp_effective_is_dark`]).
static LAST_EFFECTIVE_DARK: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Whether the shared application's current effective appearance resolves to dark
/// — i.e. what macOS is actually rendering right now (while Theme = System this
/// tracks the OS light/dark setting). Read straight from AppKit so it reflects
/// the live state rather than our settings. Must run on the main thread.
fn nsapp_effective_is_dark() -> bool {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, rc::Retained, sel};
    use objc2_foundation::NSString;

    // SAFETY: -sharedApplication / -effectiveAppearance / -name are main-thread
    // AppKit reads; the only callers (startup setup + the KVO observer) are on it.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let responds: bool = msg_send![app, respondsToSelector: sel!(effectiveAppearance)];
        if !responds {
            return false;
        }
        let appearance: *mut AnyObject = msg_send![app, effectiveAppearance];
        if appearance.is_null() {
            return false;
        }
        // The appearance name is "…DarkAqua" for every dark variant (incl. the
        // high-contrast ones), so a substring test is enough and avoids needing
        // NSArray + bestMatchFromAppearancesWithNames:.
        let name: Retained<NSString> = msg_send![appearance, name];
        name.to_string().contains("Dark")
    }
}

/// The data the appearance observer needs: the handle it rebuilds windows through.
struct ThemeObserverIvars {
    app: tauri::AppHandle,
}

// A KVO observer of `NSApplication`'s `effectiveAppearance`.
//
// macOS only surfaces a *system* light/dark switch through tao's
// `WindowEvent::ThemeChanged`, which rides a coalesced distributed notification a
// background app doesn't receive in time — so Carrier, sitting in the background
// while you flip the OS theme in System Settings, never noticed, and its title bar
// (themed once, at window creation) stayed on the old colour. KVO on
// `effectiveAppearance` fires reliably and on the main thread the instant AppKit
// updates the appearance, background or not. On each change, while following the
// system theme, rebuild the windows — the same refresh a manual theme change does
// (`recreate_themed_windows`). The webview's own CSS re-themes by itself.
objc2::define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[ivars = ThemeObserverIvars]
    struct ThemeObserver;

    impl ThemeObserver {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe_appearance_change(
            &self,
            _key_path: Option<&objc2_foundation::NSString>,
            _object: Option<&objc2::runtime::AnyObject>,
            _change: Option<&objc2::runtime::AnyObject>,
            _context: *mut std::ffi::c_void,
        ) {
            use objc2::DefinedClass;
            use std::sync::atomic::Ordering;
            let app = &self.ivars().app;
            // `effectiveAppearance` fires for changes that don't flip light↔dark —
            // in particular our own `set_theme` runs on *every* settings change
            // (apply_settings calls it for each window), and while Theme = System
            // that's `setAppearance:nil`, which re-posts the KVO without changing
            // the resolved appearance. Acting on those reloaded the page on an
            // unrelated toggle (Hide Names, Always on Top, …), so require a flip.
            let now_dark = nsapp_effective_is_dark();
            let was_dark = LAST_EFFECTIVE_DARK.swap(now_dark, Ordering::SeqCst);
            // Only while following the system theme. An explicit light/dark choice
            // also moves NSApp's appearance (we set it ourselves on a manual
            // switch), but is rebuilt by recreate_on_theme_change, not from here;
            // and overlapping rebuilds are dropped by the `recreating` flag, so a
            // burst of changes is safe.
            let is_system = app.state::<AppState>().settings.lock().unwrap().theme == "system";
            if is_system && now_dark != was_dark {
                recreate_themed_windows(app);
            }
        }
    }

    unsafe impl NSObjectProtocol for ThemeObserver {}
);

/// Register a [`ThemeObserver`] on the shared application so live OS light/dark
/// switches refresh the native window chrome while Theme = System. Called once at
/// startup; the observer is leaked (it lives for the whole process) so KVO never
/// messages a freed object, and it keeps working across the rebuilds it triggers.
pub(crate) fn observe_system_theme_changes(app: &tauri::AppHandle) {
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject, AllocAnyThread};
    use objc2_foundation::ns_string;

    // Seed the baseline so the observer only fires on a genuine flip away from the
    // appearance shown right now — not on the first spurious self-inflicted KVO.
    LAST_EFFECTIVE_DARK.store(
        nsapp_effective_is_dark(),
        std::sync::atomic::Ordering::SeqCst,
    );

    let observer = ThemeObserver::alloc().set_ivars(ThemeObserverIvars { app: app.clone() });
    let observer: Retained<ThemeObserver> = unsafe { msg_send![super(observer), init] };

    // SAFETY: standard KVO registration on the shared NSApplication. The key path
    // exists on NSApplication; we request no change values and pass a null context.
    // KVO does not retain observers, so the observer is kept alive for the process
    // lifetime via `mem::forget` below.
    unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![
            ns_app,
            addObserver: &*observer,
            forKeyPath: ns_string!("effectiveAppearance"),
            options: 0usize,
            context: std::ptr::null_mut::<std::ffi::c_void>(),
        ];
    }
    std::mem::forget(observer);
}
