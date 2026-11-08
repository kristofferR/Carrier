//! macOS notification interop: the `UNUserNotificationCenter` delegate and the
//! native delivery path for new-message notifications.

use std::path::Path;

// `define_class!` matches the conformed protocol as a bare identifier, so bring it
// into scope rather than naming it by path in the macro body.
use objc2::runtime::NSObjectProtocol;
use objc2_user_notifications::UNUserNotificationCenterDelegate;

use crate::actions::validated_thread_path;
use crate::notifications::{
    NotificationAction, on_notification_action, on_notification_click_with_path,
    on_notification_reply,
};

/// Reply alone, for a notification with no quick actions.
const REPLY_CATEGORY_ID: &str = "carrier.message.reply";
const REPLY_ACTION_ID: &str = "reply";

/// The category of a notification offering Reply plus `actions`. Each entry of
/// [`crate::notifications::ACTION_SETS`] is registered as one.
fn category_id(actions: &[NotificationAction]) -> String {
    if actions.is_empty() {
        return REPLY_CATEGORY_ID.into();
    }
    let ids: Vec<&str> = actions.iter().map(|action| action.id()).collect();
    format!("carrier.message.{}", ids.join("."))
}

/// Set once the notification centre is set up; categories registered before
/// then would be dropped.
static CATEGORIES_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Register a category per action combination. Called at setup and again when
/// the React button's reaction changes, since action titles are fixed per
/// registration.
pub(crate) fn register_notification_categories() {
    use objc2_foundation::{NSArray, NSSet, NSString};
    use objc2_user_notifications::{
        UNNotificationAction, UNNotificationActionOptionNone, UNNotificationCategory,
        UNNotificationCategoryOptionNone, UNTextInputNotificationAction, UNUserNotificationCenter,
    };

    if !CATEGORIES_READY.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    let reply = UNTextInputNotificationAction::actionWithIdentifier_title_options_textInputButtonTitle_textInputPlaceholder(
        &NSString::from_str(REPLY_ACTION_ID),
        &NSString::from_str("Reply"),
        UNNotificationActionOptionNone,
        &NSString::from_str("Send"),
        &NSString::from_str("Message…"),
    );
    let reply: &UNNotificationAction = &reply;
    let intents = NSArray::<NSString>::from_slice(&[]);
    // With more than one action, macOS folds them into the banner's Options menu.
    let categories: Vec<_> = crate::notifications::ACTION_SETS
        .iter()
        .map(|set| {
            let quick: Vec<_> = set
                .iter()
                .map(|action| {
                    UNNotificationAction::actionWithIdentifier_title_options(
                        &NSString::from_str(action.id()),
                        &NSString::from_str(action.title()),
                        UNNotificationActionOptionNone,
                    )
                })
                .collect();
            let mut actions = vec![reply];
            actions.extend(quick.iter().map(|action| &**action));
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(&category_id(set)),
                &NSArray::from_slice(&actions),
                &intents,
                UNNotificationCategoryOptionNone,
            )
        })
        .collect();
    let categories: Vec<&UNNotificationCategory> = categories.iter().map(|c| &**c).collect();
    UNUserNotificationCenter::currentNotificationCenter()
        .setNotificationCategories(&NSSet::from_slice(&categories));
}
const ROUTE_PAIRING_DELAY_SECONDS: f64 = 4.0;

#[derive(Clone, Copy, Default)]
pub(crate) struct MacNotificationOptions<'a> {
    pub(crate) subtitle: &'a str,
    /// Who sent the message, for a communication notification (Ref #366).
    pub(crate) sender: Option<MacSender<'a>>,
    /// Attached when there is no `image` and no communication notification
    /// shows the sender's face (the avatar).
    pub(crate) fallback_image: Option<&'a Path>,
    pub(crate) thread_path: Option<&'a str>,
    pub(crate) group_by_conversation: bool,
    pub(crate) reply_eligible: bool,
    pub(crate) wait_for_route: bool,
    pub(crate) page_id: Option<u64>,
}

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
// - `didReceiveNotificationResponse` recovers the conversation id and persisted
//   path from `userInfo`, then routes a click or inline reply back to the page.
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
            use objc2_user_notifications::{
                UNNotificationDefaultActionIdentifier, UNTextInputNotificationResponse,
            };
            let user_info = response.notification().request().content().userInfo();
            let id = user_info
                .objectForKey(&NSString::from_str("id"))
                .and_then(|value| value.downcast::<NSNumber>().ok())
                .map(|value| value.unsignedLongLongValue());
            let page_id = user_info
                .objectForKey(&NSString::from_str("page_id"))
                .and_then(|value| value.downcast::<NSNumber>().ok())
                .map(|value| value.unsignedLongLongValue());
            let path = user_info
                .objectForKey(&NSString::from_str("path"))
                .and_then(|value| value.downcast::<NSString>().ok())
                .map(|value| value.to_string())
                .and_then(|value| validated_thread_path(&value));
            let action = response.actionIdentifier();

            if let Some(action) = NotificationAction::from_id(&action.to_string()) {
                // Quick actions run in the background; never block this callback.
                completion_handler.call(());
                if let Some(id) = id {
                    on_notification_action(self.ivars().app.clone(), id, page_id, path, action, None);
                }
                return;
            }

            if action.to_string() == REPLY_ACTION_ID {
                let text = response
                    .downcast_ref::<UNTextInputNotificationResponse>()
                    .map(|response| response.userText().to_string());
                // The native callback must never wait for page navigation or
                // its acknowledgement. `on_notification_reply` queues the work.
                completion_handler.call(());
                if let Some(id) = id {
                    if let Some(text) = text {
                        on_notification_reply(self.ivars().app.clone(), id, page_id, path, text, None);
                    } else {
                        on_notification_click_with_path(
                            self.ivars().app.clone(),
                            id,
                            page_id,
                            path,
                        );
                    }
                }
                return;
            }

            // SAFETY: UserNotifications exports this as a process-lifetime
            // NSString constant on every supported macOS version.
            let default_action = unsafe { UNNotificationDefaultActionIdentifier };
            if &*action == default_action
                && let Some(id) = id {
                    on_notification_click_with_path(
                        self.ivars().app.clone(),
                        id,
                        page_id,
                        path,
                    );
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
    use objc2::{AllocAnyThread, msg_send};
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

    // Categories are valid independently of authorization state and must be
    // registered before a reply-eligible notification is delivered.
    CATEGORIES_READY.store(true, std::sync::atomic::Ordering::Release);
    register_notification_categories();

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
    unsafe extern "C" {
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

/// Apply the routing fields shared by initial and late-paired requests.
fn apply_route_metadata(
    content: &objc2_user_notifications::UNMutableNotificationContent,
    id: u64,
    page_id: Option<u64>,
    thread_path: Option<&str>,
    group_by_conversation: bool,
    reply_eligible: bool,
) -> Option<String> {
    use crate::notifications::offered_actions;
    use objc2::rc::Retained;
    use objc2_foundation::{NSDictionary, NSNumber, NSObject, NSString};

    let thread_path = thread_path.and_then(validated_thread_path);
    let thread_id = thread_path.as_deref().and_then(|path| {
        path.strip_prefix("/t/")
            .and_then(|path| path.strip_suffix('/'))
    });
    if group_by_conversation && let Some(thread_id) = thread_id {
        content.setThreadIdentifier(&NSString::from_str(thread_id));
    }
    if reply_eligible && thread_path.is_some() {
        content.setCategoryIdentifier(&NSString::from_str(&category_id(offered_actions(id))));
    }

    let id_key = NSString::from_str("id");
    let num = NSNumber::numberWithUnsignedLongLong(id);
    let page_id = page_id.filter(|page_id| *page_id != 0);
    let page_key = NSString::from_str("page_id");
    let page_num = page_id.map(NSNumber::numberWithUnsignedLongLong);
    let path_key = NSString::from_str("path");
    let path = thread_path.as_deref().map(NSString::from_str);
    let dict = match (path.as_deref(), page_num.as_deref()) {
        (Some(path), Some(page_num)) => {
            let values: [&NSObject; 3] = [&num, page_num, path];
            NSDictionary::from_slices(&[&*id_key, &*page_key, &*path_key], &values)
        }
        (Some(path), None) => {
            let values: [&NSObject; 2] = [&num, path];
            NSDictionary::from_slices(&[&*id_key, &*path_key], &values)
        }
        (None, Some(page_num)) => {
            let values: [&NSObject; 2] = [&num, page_num];
            NSDictionary::from_slices(&[&*id_key, &*page_key], &values)
        }
        (None, None) => {
            let values: [&NSObject; 1] = [&num];
            NSDictionary::from_slices(&[&*id_key], &values)
        }
    };
    let dict: Retained<NSDictionary> = unsafe { Retained::cast_unchecked(dict) };
    // SAFETY: every key is an NSString and every value is an Objective-C
    // property-list object (NSNumber or NSString).
    unsafe { content.setUserInfo(&dict) };
    thread_path
}

/// Deliver a new-message notification through modern UserNotifications. A
/// route-known request is immediate; a route-less page-first request gets a
/// short trigger so a late pairing can replace it while still pending. This
/// supersedes the legacy `NSUserNotification` path, which modern macOS no
/// longer presents reliably for third-party apps.
pub(crate) fn deliver_notification_macos(
    title: &str,
    body: &str,
    id: u64,
    image: Option<&Path>,
    sound: bool,
    options: MacNotificationOptions<'_>,
) {
    use objc2_foundation::{NSArray, NSString, NSURL};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotificationAttachment, UNNotificationRequest,
        UNNotificationSound, UNNotificationTrigger, UNTimeIntervalNotificationTrigger,
        UNUserNotificationCenter,
    };

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setSubtitle(&NSString::from_str(options.subtitle));
    content.setBody(&NSString::from_str(body));
    if sound {
        content.setSound(Some(&UNNotificationSound::defaultSound()));
    }

    // Carry the trusted native id, page callback id, and validated route.
    // Notification Center entries outlive this process, so the route is the
    // restart-safe fallback when the in-memory map is gone.
    let thread_path = apply_route_metadata(
        &content,
        id,
        options.page_id,
        options.thread_path,
        options.group_by_conversation,
        options.reply_eligible,
    );

    // A shared-media thumbnail, or the sender's avatar when no communication
    // notification shows their face. Best-effort: if the OS rejects the file,
    // deliver the text without it.
    let attach = |path: &Path| {
        let Some(path) = path.to_str() else {
            return;
        };
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let ident = NSString::from_str("image");
        // SAFETY: no attachment options are passed (`None`), so there's no
        // option-type contract to uphold.
        let attachment = unsafe {
            UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(&ident, &url, None)
        };
        if let Ok(attachment) = attachment {
            content.setAttachments(&NSArray::arrayWithObject(&*attachment));
        }
    };
    if let Some(path) = image {
        attach(path);
    }

    // Present it as a message from its sender when possible: macOS shows
    // their face (and the group's name) in place of Carrier's icon. Without
    // the communication-notifications entitlement this fails and the plain
    // content is delivered, with the avatar attached as before.
    // A route-less notification has no conversation yet and stays plain;
    // routes are normally known at delivery.
    let communication = options
        .sender
        .as_ref()
        .zip(thread_path.as_deref())
        .and_then(|(sender, conversation)| {
            communication_content(&content, sender, conversation, body)
        });
    let content: objc2::rc::Retained<objc2_user_notifications::UNNotificationContent> =
        match communication {
            Some(updated) => updated,
            None => {
                if image.is_none()
                    && let Some(path) = options.fallback_image
                {
                    attach(path);
                }
                content.into_super()
            }
        };

    // The trusted native id stays unique when the page reloads, so an older
    // Notification Center request cannot coalesce with a new page counter.
    let request_id = NSString::from_str(&id.to_string());
    // A page-first message may precede its conversation row by a moment. Keep
    // only an explicitly pairable route-less request pending long enough for
    // the late route event to replace it with fully grouped/reply-capable
    // content. Route-known messages and route-independent system alerts remain
    // immediate.
    let delayed_trigger = (options.wait_for_route && thread_path.is_none()).then(|| {
        UNTimeIntervalNotificationTrigger::triggerWithTimeInterval_repeats(
            ROUTE_PAIRING_DELAY_SECONDS,
            false,
        )
    });
    let trigger = delayed_trigger.as_deref().map(|trigger| {
        let trigger: &UNNotificationTrigger = trigger;
        trigger
    });
    // `&content` coerces from the mutable subclass to `&UNNotificationContent`.
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &request_id,
        &content,
        trigger,
    );
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

/// Add a late route to a notification that is still inside the short native
/// pairing delay. Replacing a pending request with the same identifier is
/// silent; using an immediate trigger then delivers it once with complete
/// click, grouping, and reply metadata.
pub(crate) fn update_pending_notification_route_macos(
    id: u64,
    thread_path: &str,
    group_by_conversation: bool,
    reply_eligible: bool,
) {
    use core::ptr::NonNull;

    use objc2_foundation::{NSArray, NSMutableCopying, NSString};
    use objc2_user_notifications::{UNNotificationRequest, UNUserNotificationCenter};

    let Some(thread_path) = validated_thread_path(thread_path) else {
        return;
    };
    let expected_id = id.to_string();
    let handler = block2::RcBlock::new(move |requests: NonNull<NSArray<UNNotificationRequest>>| {
        // SAFETY: UserNotifications supplies a valid array for the callback.
        let requests = unsafe { requests.as_ref() };
        let Some(request) = requests
            .iter()
            .find(|request| request.identifier().to_string() == expected_id)
        else {
            return;
        };
        let content = request.content().mutableCopy();
        let page_id = request
            .content()
            .userInfo()
            .objectForKey(&NSString::from_str("page_id"))
            .and_then(|value| value.downcast::<objc2_foundation::NSNumber>().ok())
            .map(|value| value.unsignedLongLongValue());
        apply_route_metadata(
            &content,
            id,
            page_id,
            Some(&thread_path),
            group_by_conversation,
            reply_eligible,
        );
        let identifier = NSString::from_str(&expected_id);
        let replacement = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            None,
        );
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&replacement, None);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getPendingNotificationRequestsWithCompletionHandler(&handler);
}

/// Remove delivered notifications belonging to one validated conversation.
/// Querying Notification Center instead of keeping another process-local map
/// also clears entries delivered before Carrier restarted.
pub(crate) fn clear_delivered_for_thread(thread_id: &str, late_route_ids: &[u64]) {
    use core::ptr::NonNull;
    use std::collections::HashSet;

    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSString};
    use objc2_user_notifications::{UNNotification, UNUserNotificationCenter};

    let Some(expected_path) = validated_thread_path(&format!("/t/{thread_id}/")) else {
        return;
    };
    let thread_id = thread_id.to_string();
    let late_route_ids: HashSet<String> = late_route_ids.iter().map(u64::to_string).collect();
    let path_key = NSString::from_str("path");
    let handler = block2::RcBlock::new(move |notifications: NonNull<NSArray<UNNotification>>| {
        // SAFETY: UserNotifications supplies a valid array for the duration
        // of this callback.
        let notifications = unsafe { notifications.as_ref() };
        let identifiers: Vec<Retained<NSString>> = notifications
            .iter()
            .filter_map(|notification| {
                let request = notification.request();
                let content = request.content();
                let grouped = content.threadIdentifier().to_string() == thread_id;
                let late_routed = late_route_ids.contains(&request.identifier().to_string());
                let persisted_path = content
                    .userInfo()
                    .objectForKey(&*path_key)
                    .and_then(|value| value.downcast::<NSString>().ok())
                    .map(|value| value.to_string());
                (grouped
                    || late_routed
                    || persisted_path.as_deref() == Some(expected_path.as_str()))
                .then(|| request.identifier())
            })
            .collect();
        if !identifiers.is_empty() {
            UNUserNotificationCenter::currentNotificationCenter()
                .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(
                    &identifiers,
                ));
        }
    });
    // UserNotifications copies the block, so dropping our local RcBlock after
    // registering it does not end the asynchronous enumeration.
    UNUserNotificationCenter::currentNotificationCenter()
        .getDeliveredNotificationsWithCompletionHandler(&handler);
}

/// Why macOS would not show Carrier's banners, from its notification settings
/// (Ref #259). None when banners are allowed or macOS does not answer in time.
pub(crate) fn notification_blocker() -> Option<String> {
    use objc2_user_notifications::{UNNotificationSettings, UNUserNotificationCenter};

    let (tx, rx) = std::sync::mpsc::channel();
    let handler = block2::RcBlock::new(
        move |settings: core::ptr::NonNull<UNNotificationSettings>| {
            // SAFETY: UserNotifications passes a valid settings object.
            let settings = unsafe { settings.as_ref() };
            let _ = tx.send((settings.authorizationStatus().0, settings.alertSetting().0));
        },
    );
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&handler);
    let (status, alert) = rx.recv_timeout(std::time::Duration::from_secs(3)).ok()?;
    crate::notifications::macos_blocker_message(status, alert)
}

/// The sender of a message notification (Ref #366).
#[derive(Clone, Copy)]
pub(crate) struct MacSender<'a> {
    /// Stable and unique per person: `messenger:<account>:<participant id>`.
    pub(crate) identifier: &'a str,
    /// Presentation only.
    pub(crate) name: &'a str,
    /// The sender's own picture; None when only another picture (such as
    /// the group's) is available.
    pub(crate) avatar: Option<&'a Path>,
    /// The group conversation's name; None for a one-to-one chat.
    pub(crate) group_name: Option<&'a str>,
    /// The group's own picture; None for a one-to-one chat or a group without
    /// one, which macOS then draws from its members.
    pub(crate) group_picture: Option<&'a Path>,
}

/// The content as a message from `sender`, via an `INSendMessageIntent`.
/// None when macOS refuses it, e.g. a build without the
/// communication-notifications entitlement or its provisioning profile.
///
/// Adapted from fMess (https://github.com/toanbku/fmess, src-tauri/src/notify.rs),
/// MIT License, Copyright (c) 2026 fMess contributors.
fn communication_content(
    content: &objc2_user_notifications::UNNotificationContent,
    sender: &MacSender<'_>,
    conversation: &str,
    body: &str,
) -> Option<objc2::rc::Retained<objc2_user_notifications::UNNotificationContent>> {
    use objc2::rc::Retained;
    use objc2::{AnyThread, msg_send};
    use objc2_foundation::{NSArray, NSData, NSError, NSString};
    use objc2_intents::{
        INImage, INInteraction, INInteractionDirection, INOutgoingMessageType, INPerson,
        INPersonHandle, INPersonHandleType, INSendMessageIntent, INSpeakableString,
    };
    use objc2_user_notifications::UNNotificationContent;

    fn person(name: &str, picture: Option<&[u8]>, id: &str) -> Retained<INPerson> {
        let name = NSString::from_str(name);
        let id = NSString::from_str(id);
        // SAFETY: plain value constructors; every argument is a valid object
        // or None where the API allows it.
        unsafe {
            let handle = INPersonHandle::initWithValue_type(
                INPersonHandle::alloc(),
                Some(&id),
                INPersonHandleType::Unknown,
            );
            let image =
                picture.map(|bytes| INImage::imageWithImageData(&NSData::with_bytes(bytes)));
            INPerson::initWithPersonHandle_nameComponents_displayName_image_contactIdentifier_customIdentifier(
                INPerson::alloc(),
                &handle,
                None,
                Some(&name),
                image.as_deref(),
                None,
                Some(&id),
            )
        }
    }

    // INSendMessageIntent and contentByUpdatingWithProvider: need macOS 12;
    // Carrier supports 10.15, where the plain notification stays.
    if !objc2::available!(macos = 12.0) {
        return None;
    }
    let picture = sender.avatar.and_then(|path| std::fs::read(path).ok());
    let from = person(sender.name, picture.as_deref(), sender.identifier);
    let conversation = NSString::from_str(conversation);
    // SAFETY: a plain value constructor with a valid string.
    let group_name = sender.group_name.map(|name| unsafe {
        INSpeakableString::initWithSpokenPhrase(
            INSpeakableString::alloc(),
            &NSString::from_str(name),
        )
    });
    // More than one recipient makes it a group conversation.
    let recipients = sender
        .group_name
        .is_some()
        .then(|| NSArray::from_retained_slice(&[person("Me", None, "me")]));
    // SAFETY: the intent and interaction are built from valid objects; the
    // donation completion is optional. INSendMessageIntent conforms to
    // UNNotificationContentProviding, which the bindings do not declare, so the
    // update is sent directly; it returns new content or an NSError.
    unsafe {
        let intent = INSendMessageIntent::initWithRecipients_outgoingMessageType_content_speakableGroupName_conversationIdentifier_serviceName_sender_attachments(
            INSendMessageIntent::alloc(),
            recipients.as_deref(),
            INOutgoingMessageType::OutgoingMessageText,
            Some(&NSString::from_str(body)),
            group_name.as_deref(),
            Some(&conversation),
            None,
            Some(&from),
            None,
        );
        // The group's picture, shown the way Messages shows a named group's.
        if sender.group_name.is_some()
            && let Some(bytes) = sender
                .group_picture
                .and_then(|path| std::fs::read(path).ok())
        {
            let image = INImage::imageWithImageData(&NSData::with_bytes(&bytes));
            intent.setImage_forParameterNamed(
                Some(&image),
                &NSString::from_str("speakableGroupName"),
            );
        }
        let interaction =
            INInteraction::initWithIntent_response(INInteraction::alloc(), &intent, None);
        interaction.setDirection(INInteractionDirection::Incoming);
        interaction.setGroupIdentifier(Some(&conversation));
        interaction.donateInteractionWithCompletion(None);
        let updated: Result<Retained<UNNotificationContent>, Retained<NSError>> =
            msg_send![content, contentByUpdatingWithProvider: &*intent, error: _];
        match updated {
            Ok(updated) => Some(updated),
            Err(error) => {
                log::info!(
                    "communication notification unavailable, using the plain one: {}",
                    error.localizedDescription()
                );
                None
            }
        }
    }
}

/// Remove every delivered Carrier notification (Log Out and Reset; Ref #356).
pub(crate) fn clear_all_delivered() {
    objc2_user_notifications::UNUserNotificationCenter::currentNotificationCenter()
        .removeAllDeliveredNotifications();
}
