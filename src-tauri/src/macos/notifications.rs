//! macOS notification interop: the `UNUserNotificationCenter` delegate and the
//! native delivery path for new-message notifications.

use std::path::Path;

// `define_class!` matches the conformed protocol as a bare identifier, so bring it
// into scope rather than naming it by path in the macro body.
use objc2::runtime::NSObjectProtocol;
use objc2_user_notifications::UNUserNotificationCenterDelegate;

use crate::notifications::on_notification_click;

/// The data the notification-centre delegate needs: the handle it routes a
/// notification click back through.
struct NotifyDelegateIvars {
    app: tauri::AppHandle,
}

// The `UNUserNotificationCenter` delegate. It does two jobs:
//
// - `willPresentNotification` returns `Banner | Sound | List` so a new-message
//   notification is shown even while Carrier is frontmost/focused (without a
//   delegate, macOS suppresses banners for the active app — a required product
//   behaviour here).
// - `didReceiveNotificationResponse` recovers the conversation id from the
//   notification's `userInfo` and routes a click back to the page via
//   `on_notification_click`.
//
// Set once at startup and retained for the process lifetime (the centre's
// `setDelegate:` does not retain) — see `setup_macos_notifications`.
objc2::define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[ivars = NotifyDelegateIvars]
    struct NotifyDelegate;

    impl NotifyDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &objc2_user_notifications::UNUserNotificationCenter,
            _notification: &objc2_user_notifications::UNNotification,
            completion_handler: &block2::DynBlock<
                dyn Fn(objc2_user_notifications::UNNotificationPresentationOptions),
            >,
        ) {
            use objc2_user_notifications::UNNotificationPresentationOptions as Opts;
            // Show even when Carrier is the active app (Banner), play the sound,
            // and keep it in Notification Centre (List).
            completion_handler.call((Opts::Banner | Opts::Sound | Opts::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &objc2_user_notifications::UNUserNotificationCenter,
            response: &objc2_user_notifications::UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            use objc2::DefinedClass;
            use objc2_foundation::{NSNumber, NSString};
            let user_info = response.notification().request().content().userInfo();
            let key = NSString::from_str("id");
            if let Some(value) = user_info.objectForKey(&key) {
                if let Ok(num) = value.downcast::<NSNumber>() {
                    on_notification_click(self.ivars().app.clone(), num.unsignedLongLongValue());
                }
            }
            // The API requires the completion block be called when we're done.
            completion_handler.call(());
        }
    }

    unsafe impl NSObjectProtocol for NotifyDelegate {}
    unsafe impl UNUserNotificationCenterDelegate for NotifyDelegate {}
);

/// Set up macOS notifications once the app is ready: request authorization
/// (including the **badge** option) and install the centre's delegate.
///
/// Authorization — since macOS 12 (Monterey), `[[NSApp dockTile] setBadgeLabel:]`
/// (what Tauri's `set_badge_count` calls) is silently ignored unless the app has
/// requested `UNUserNotificationCenter` authorization with the badge option, and
/// macOS won't present banners (or register the app under System Settings →
/// Notifications) without an Alert grant (issue #5). The grant is persisted by
/// the OS, so later launches resolve without a prompt.
///
/// Delegate — installs [`NotifyDelegate`] so notifications present while Carrier
/// is frontmost and clicks route back to the page. `setDelegate:` does not
/// retain, so the delegate is leaked (it lives for the whole process); a static
/// `OnceLock` can't hold it because `Retained<…>` is neither `Send` nor `Sync`,
/// and this mirrors the `ThemeObserver` precedent.
///
/// Must run on the main thread, once the app has finished launching — calling it
/// from `setup` is a silent no-op — so it's invoked from the `RunEvent::Ready`
/// handler. Safe to call unconditionally.
pub(crate) fn setup_macos_notifications(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{msg_send, AllocAnyThread};
    use objc2_foundation::NSError;
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};

    refresh_launch_services_registration();

    let center = UNUserNotificationCenter::currentNotificationCenter();

    // Install the delegate before requesting authorization so we never miss an
    // early presentation/click callback.
    let delegate = NotifyDelegate::alloc().set_ivars(NotifyDelegateIvars { app: app.clone() });
    let delegate: Retained<NotifyDelegate> = unsafe { msg_send![super(delegate), init] };
    let proto = ProtocolObject::<dyn UNUserNotificationCenterDelegate>::from_ref(&*delegate);
    center.setDelegate(Some(proto));
    // Keep the delegate alive for the process: `setDelegate:` does not retain.
    std::mem::forget(delegate);

    let options = UNAuthorizationOptions::Badge
        | UNAuthorizationOptions::Alert
        | UNAuthorizationOptions::Sound;
    // The completion handler is required by the API and the OS persists the
    // grant. Log the outcome: authorization can fail silently (e.g. duplicate
    // LaunchServices registrations of the bundle id from a still-mounted
    // release DMG), which presents as "badges work but no banners" with no
    // trace in the log file. The framework copies the block, so letting our
    // `RcBlock` drop when this returns is fine.
    let handler = RcBlock::new(|granted: Bool, error: *mut NSError| {
        // SAFETY: the framework passes a valid NSError or null.
        let error = unsafe { error.as_ref() };
        match error {
            Some(e) => log::warn!(
                "notification authorization failed: {}",
                e.localizedDescription()
            ),
            None if granted.as_bool() => log::info!("notification authorization granted"),
            None => log::warn!("notification authorization denied (banners will not show)"),
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(options, &handler);
}

/// Refresh this bundle's LaunchServices registration before asking for
/// notification authorization. When the bundle id is registered at several
/// paths — typically a still-mounted release DMG alongside the installed copy —
/// `usernoted` can resolve the id to the wrong copy and the authorization
/// request fails silently: banners never show while badges keep working.
/// Re-registering the copy that's actually running keeps its record fresh so
/// the lookup lands here.
fn refresh_launch_services_registration() {
    use objc2::rc::Retained;
    use objc2_foundation::{NSString, NSURL};

    // LSRegisterURL(CFURLRef, Boolean) — CFURLRef is toll-free bridged from
    // NSURL, and `Boolean` is a u8.
    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSRegisterURL(in_url: *const std::ffi::c_void, in_update: u8) -> i32;
    }

    // Not running from an .app bundle (`tauri dev` runs the bare binary) —
    // there's nothing LaunchServices could register.
    let Ok(bundle) = crate::commands::current_app_bundle() else {
        return;
    };
    let Some(path) = bundle.to_str() else {
        return;
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    // SAFETY: `url` is a valid NSURL (a CFURLRef via toll-free bridging) that
    // outlives the call.
    let status = unsafe { LSRegisterURL(Retained::as_ptr(&url).cast(), 1) };
    if status != 0 {
        log::warn!("LSRegisterURL({path}) failed with status {status}");
    }
}

/// Deliver a new-message notification through the modern
/// `UNUserNotificationCenter` (macOS). Builds a `UNMutableNotificationContent`
/// (title = sender, body = preview, the default sound when `sound` is on —
/// leaving it unset delivers silently), stashes the conversation
/// `id` in `userInfo` so [`NotifyDelegate`] can recover it on click, attaches
/// the avatar as a `UNNotificationAttachment` when one decoded (best-effort),
/// and adds the request for immediate delivery (`trigger: nil`).
///
/// Replaces the dead legacy `NSUserNotification` path (mac-notification-sys),
/// which macOS 26/27 no longer presents for third-party apps.
pub(crate) fn deliver_notification_macos(
    title: &str,
    body: &str,
    id: u64,
    image: Option<&Path>,
    sound: bool,
) {
    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotificationAttachment, UNNotificationRequest,
        UNNotificationSound, UNUserNotificationCenter,
    };

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    if sound {
        content.setSound(Some(&UNNotificationSound::defaultSound()));
    }

    // Carry the conversation id so the delegate's click handler can recover it.
    // Built typed (NSString → NSNumber) then cast to the bare `NSDictionary`
    // the `setUserInfo:` signature wants; the generics are just markers.
    let key = NSString::from_str("id");
    let num = NSNumber::numberWithUnsignedLongLong(id);
    let dict = NSDictionary::from_slices(&[&*key], &[&*num]);
    let dict: Retained<NSDictionary> = unsafe { Retained::cast_unchecked(dict) };
    // SAFETY: `dict` is a valid NSDictionary with a string key and number value.
    unsafe { content.setUserInfo(&dict) };

    // Avatar attachment (Caprine-style thumbnail). Best-effort: if the OS
    // rejects the file, send the notification without it.
    if let Some(path) = image.and_then(|p| p.to_str()) {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let ident = NSString::from_str("avatar");
        // SAFETY: no attachment options are passed (`None`), so there's no
        // option-type contract to uphold.
        let attachment = unsafe {
            UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(&ident, &url, None)
        };
        if let Ok(attachment) = attachment {
            content.setAttachments(&NSArray::arrayWithObject(&*attachment));
        }
    }

    // A per-notification identifier; the page's id (stringified) is unique
    // enough and keeps requests from coalescing.
    let request_id = NSString::from_str(&id.to_string());
    // `&content` coerces from the mutable subclass to `&UNNotificationContent`.
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&request_id, &content, None);
    // A rejected request (revoked authorization, malformed content) is
    // otherwise invisible — same silent failure mode the authorization
    // logging in `setup_macos_notifications` exists for — so log it. The
    // framework copies the block; dropping our `RcBlock` on return is fine.
    let handler = block2::RcBlock::new(|error: *mut objc2_foundation::NSError| {
        // SAFETY: the framework passes a valid NSError or null.
        if let Some(e) = unsafe { error.as_ref() } {
            log::warn!("notification delivery failed: {}", e.localizedDescription());
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&handler));
}
