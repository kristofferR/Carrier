//! Snap blocks the freedesktop ActivationToken broadcast. Exported portal
//! actions instead receive activation data in a call addressed only to Carrier.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex, OnceLock};

use zbus::zvariant::{OwnedValue, Value};

use super::{LinuxNotificationResponse, LINUX_NOTIFICATION_RESPONSE_TIMEOUT};

type Response = (LinuxNotificationResponse, Option<String>);
type Pending = Arc<Mutex<HashMap<String, mpsc::Sender<Response>>>>;

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
        let Some(sender) = self.pending.lock().unwrap().remove(identifier) else {
            return;
        };
        let token = activation_token(&platform_data);
        let _ = sender.send((response, token));
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
) -> Result<Response, String> {
    // Serialize initialization, but allow a later notification to retry a failed
    // session-bus connection. Keep one name owner for all pending notifications.
    static PORTAL: OnceLock<Mutex<Option<Arc<Portal>>>> = OnceLock::new();
    let portal = {
        let mut portal = PORTAL.get_or_init(Default::default).lock().unwrap();
        if portal.is_none() {
            *portal = Some(Arc::new(Portal::connect().map_err(|e| e.to_string())?));
        }
        portal.as_ref().unwrap().clone()
    };
    let identifier = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::channel();
    {
        let mut pending = portal.pending.lock().unwrap();
        if pending.len() >= 128 {
            return Err("too many pending notification actions".into());
        }
        pending.insert(identifier.clone(), sender);
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
    let response = submitted.map(|_| receiver.recv_timeout(LINUX_NOTIFICATION_RESPONSE_TIMEOUT));
    let action_received = matches!(&response, Ok(Ok(_)));
    // Bound retained action routes without removing unattended notifications
    // from the desktop's history when the response wait expires.
    portal.pending.lock().unwrap().remove(&identifier);
    if action_received {
        let _ = portal.connection.call_method(
            Some("org.freedesktop.portal.Desktop"),
            "/org/freedesktop/portal/desktop",
            Some("org.freedesktop.portal.Notification"),
            "RemoveNotification",
            &identifier,
        );
    }
    response
        .map_err(|error| error.to_string())
        .map(|response| response.unwrap_or((LinuxNotificationResponse::Closed, None)))
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
        let (sender, receiver) = mpsc::channel();
        pending
            .lock()
            .unwrap()
            .insert("notification-a".into(), sender);
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
