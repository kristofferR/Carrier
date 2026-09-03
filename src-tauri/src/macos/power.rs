//! macOS system-sleep tracking for Messenger sync recovery.
//!
//! JavaScript wall-clock gaps cannot distinguish a user wake from macOS dark
//! wakes. AppKit can: pause recovery when the system sleeps and resume it only
//! after the displays wake again.

use std::sync::Mutex;

use objc2::runtime::NSObjectProtocol;
use tauri::Manager;

struct PowerState {
    sleeping: bool,
    resume_generation: u64,
}

static POWER_STATE: Mutex<PowerState> = Mutex::new(PowerState {
    sleeping: false,
    resume_generation: 0,
});

struct PowerObserverIvars {
    app: tauri::AppHandle,
}

objc2::define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[ivars = PowerObserverIvars]
    struct PowerObserver;

    impl PowerObserver {
        #[unsafe(method(carrierWorkspaceWillSleep:))]
        fn workspace_will_sleep(&self, _notification: &objc2_foundation::NSNotification) {
            use objc2::DefinedClass;

            POWER_STATE.lock().unwrap().sleeping = true;
            log::info!("system is sleeping; pausing Messenger recovery");
            dispatch_power_event(&self.ivars().app, "carrier:system-sleep");
        }

        #[unsafe(method(carrierWorkspaceScreensDidWake:))]
        fn workspace_screens_did_wake(&self, _notification: &objc2_foundation::NSNotification) {
            use objc2::DefinedClass;

            // Screen-wake notifications also occur without a preceding system
            // sleep. Only the paired transition represents a lid-open/resume.
            {
                let mut state = POWER_STATE.lock().unwrap();
                if !state.sleeping {
                    return;
                }
                state.resume_generation = state.resume_generation.wrapping_add(1);
                state.sleeping = false;
            }
            log::info!("display woke after system sleep; refreshing Messenger");
            dispatch_power_event(&self.ivars().app, "carrier:system-resume");
        }
    }

    unsafe impl NSObjectProtocol for PowerObserver {}
);

fn dispatch_power_event(app: &tauri::AppHandle, event: &str) {
    for (label, window) in app.webview_windows() {
        if label == "settings" {
            continue;
        }
        let _ = window.eval(format!(
            "window.dispatchEvent(new Event({}));",
            serde_json::to_string(event).expect("static event name serialises")
        ));
    }
}

pub(crate) fn is_system_sleeping() -> bool {
    POWER_STATE.lock().unwrap().sleeping
}

pub(crate) fn resume_generation() -> u64 {
    POWER_STATE.lock().unwrap().resume_generation
}

/// Observe the system sleep boundary and the first display wake that follows.
///
/// `NSWorkspaceDidWakeNotification` also fires for maintenance dark-wakes, so
/// it is intentionally not used. `NSWorkspaceScreensDidWakeNotification` is
/// the user-visible wake boundary Carrier needs.
pub(crate) fn observe_system_sleep(app: &tauri::AppHandle) {
    use objc2::rc::Retained;
    use objc2::{sel, AllocAnyThread};
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceScreensDidWakeNotification, NSWorkspaceWillSleepNotification,
    };

    let observer = PowerObserver::alloc().set_ivars(PowerObserverIvars { app: app.clone() });
    let observer: Retained<PowerObserver> = unsafe { objc2::msg_send![super(observer), init] };
    let center = NSWorkspace::sharedWorkspace().notificationCenter();

    // SAFETY: both selectors are implemented above with the standard one-
    // notification argument, and the observer is kept alive for the process.
    unsafe {
        center.addObserver_selector_name_object(
            &observer,
            sel!(carrierWorkspaceWillSleep:),
            Some(NSWorkspaceWillSleepNotification),
            None,
        );
        center.addObserver_selector_name_object(
            &observer,
            sel!(carrierWorkspaceScreensDidWake:),
            Some(NSWorkspaceScreensDidWakeNotification),
            None,
        );
    }
    std::mem::forget(observer);
}
