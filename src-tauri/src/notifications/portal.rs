//! Snap blocks the freedesktop ActivationToken broadcast. Exported portal
//! actions instead receive activation data in a call addressed only to Carrier.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use zbus::zvariant::{OwnedValue, Value};

use super::LinuxNotificationResponse;

type Response = (LinuxNotificationResponse, Option<String>);
type ResponseHandler = Box<dyn FnOnce(Response) + Send>;

struct PendingAction {
    inserted_at: Instant,
    handler: ResponseHandler,
}

type Pending = Arc<Mutex<HashMap<String, PendingAction>>>;
const MAX_PENDING_ACTIONS: usize = 128;

struct ApplicationActions {
    pending: Pending,
}

#[zbus::interface(name = "org.freedesktop.Application")]
impl ApplicationActions {
    fn activate_action(
        &self,
        action_name: &str,
        parameter: Vec<OwnedValue>,
        platform_data: HashMap<String, OwnedValue>,
    ) {
        let response = match action_name {
            "open-notification" => LinuxNotificationResponse::Open,
            "reply-notification" => LinuxNotificationResponse::OpenComposer,
            _ => return,
        };
        let [identifier] = parameter.as_slice() else {
            return;
        };
        let Ok(identifier) = <&str>::try_from(identifier) else {
            return;
        };
        // Only live, unguessable notification IDs can activate a retained route.
        let Some(action) = self.pending.lock().unwrap().remove(identifier) else {
            return;
        };
        let token = activation_token(&platform_data);
        (action.handler)((response, token));
    }
}

fn activation_token(platform_data: &HashMap<String, OwnedValue>) -> Option<String> {
    ["activation-token", "desktop-startup-id"]
        .into_iter()
        .filter_map(|key| platform_data.get(key))
        .filter_map(|value| <&str>::try_from(value).ok())
        .find(|token| !token.is_empty())
        .map(str::to_owned)
}

struct Portal {
    connection: zbus::blocking::Connection,
    pending: Pending,
    version: u32,
}

impl Portal {
    fn connect() -> Result<Self, zbus::Error> {
        let pending = Pending::default();
        let connection = zbus::blocking::connection::Builder::session()?
            .serve_at(
                "/snap/carrier",
                ApplicationActions {
                    pending: pending.clone(),
                },
            )?
            .name("snap.carrier")?
            .build()?;
        let version = zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Notification",
        )?
        .get_property("version")?;
        Ok(Self {
            connection,
            pending,
            version,
        })
    }
}

pub(super) fn show(
    title: &str,
    body: &str,
    image: Option<&Path>,
    sound: bool,
    reply: bool,
    on_response: impl FnOnce(Response) + Send + 'static,
) -> Result<(), String> {
    // Serialize initialization, but allow a later notification to retry a failed
    // session-bus connection. Keep one name owner for all pending notifications.
    static PORTAL: OnceLock<Mutex<Option<Arc<Portal>>>> = OnceLock::new();
    let portal = {
        let mut portal = PORTAL.get_or_init(Default::default).lock().unwrap();
        if portal.is_none() {
            match Portal::connect() {
                Ok(connected) => *portal = Some(Arc::new(connected)),
                Err(error) => {
                    drop(portal);
                    on_response((LinuxNotificationResponse::Closed, None));
                    return Err(error.to_string());
                }
            }
        }
        portal.as_ref().unwrap().clone()
    };
    let identifier = uuid::Uuid::new_v4().to_string();
    let response_connection = portal.connection.clone();
    let response_identifier = identifier.clone();
    let handler = Box::new(move |response| {
        on_response(response);
        let _ = response_connection.call_method(
            Some("org.freedesktop.portal.Desktop"),
            "/org/freedesktop/portal/desktop",
            Some("org.freedesktop.portal.Notification"),
            "RemoveNotification",
            &response_identifier,
        );
    });
    let evicted = {
        let mut pending = portal.pending.lock().unwrap();
        let evicted = if pending.len() >= MAX_PENDING_ACTIONS {
            pending
                .iter()
                .min_by_key(|(_, action)| action.inserted_at)
                .map(|(identifier, _)| identifier.clone())
                .and_then(|identifier| pending.remove(&identifier).map(|action| action.handler))
        } else {
            None
        };
        pending.insert(
            identifier.clone(),
            PendingAction {
                inserted_at: Instant::now(),
                handler,
            },
        );
        evicted
    };
    if let Some(handler) = evicted {
        handler((LinuxNotificationResponse::Closed, None));
    }
    let mut notification = HashMap::<&str, Value<'_>>::from([
        ("title", title.into()),
        ("body", body.into()),
        ("default-action", "app.open-notification".into()),
        ("default-action-target", identifier.as_str().into()),
    ]);
    // Version 1 rejects unknown keys rather than ignoring them.
    if portal.version >= 2 {
        notification.insert("sound", if sound { "default" } else { "silent" }.into());
    }
    // Bytes icons work with Ubuntu's version-1 portal and do not expose a
    // sandbox-private filename. Reuse the same bounded PNG validation as FDO.
    let avatar = image
        .and_then(super::linux_notification_avatar)
        .map(|(bytes, _)| bytes);
    let icon = avatar.unwrap_or_else(|| include_bytes!("../../icons/icon.png").to_vec());
    notification.insert("icon", Value::from(("bytes", Value::from(icon))));
    if reply {
        let button = HashMap::<&str, Value<'_>>::from([
            ("label", "Reply".into()),
            ("action", "app.reply-notification".into()),
            ("target", identifier.as_str().into()),
        ]);
        notification.insert("buttons", vec![button].into());
    }
    let submitted = portal.connection.call_method(
        Some("org.freedesktop.portal.Desktop"),
        "/org/freedesktop/portal/desktop",
        Some("org.freedesktop.portal.Notification"),
        "AddNotification",
        &(&identifier, notification),
    );
    if let Err(error) = submitted {
        if let Some(action) = portal.pending.lock().unwrap().remove(&identifier) {
            (action.handler)((LinuxNotificationResponse::Closed, None));
        }
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(value: &str) -> OwnedValue {
        Value::from(value).try_to_owned().unwrap()
    }

    #[test]
    fn exported_action_delivers_token_only_to_matching_pending_notification() {
        let pending = Pending::default();
        let actions = ApplicationActions {
            pending: pending.clone(),
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        pending.lock().unwrap().insert(
            "notification-a".into(),
            PendingAction {
                inserted_at: Instant::now(),
                handler: Box::new(move |response| {
                    let _ = sender.send(response);
                }),
            },
        );
        actions.activate_action("unknown", vec![owned("notification-a")], HashMap::new());
        actions.activate_action("open-notification", vec![owned("unknown")], HashMap::new());
        assert!(receiver.try_recv().is_err());
        actions.activate_action(
            "open-notification",
            vec![owned("notification-a")],
            HashMap::from([("activation-token".into(), owned("test-token"))]),
        );
        let (response, token) = receiver.try_recv().unwrap();
        assert!(matches!(response, LinuxNotificationResponse::Open));
        assert_eq!(token.as_deref(), Some("test-token"));
        assert!(pending.lock().unwrap().is_empty());
        actions.activate_action(
            "open-notification",
            vec![owned("notification-a")],
            HashMap::new(),
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn startup_id_is_a_fallback_for_missing_or_empty_activation_token() {
        let mut data = HashMap::from([("desktop-startup-id".into(), owned("startup"))]);
        assert_eq!(activation_token(&data).as_deref(), Some("startup"));
        data.insert("activation-token".into(), owned(""));
        assert_eq!(activation_token(&data).as_deref(), Some("startup"));
        data.insert("activation-token".into(), owned("wayland"));
        assert_eq!(activation_token(&data).as_deref(), Some("wayland"));
    }
}
