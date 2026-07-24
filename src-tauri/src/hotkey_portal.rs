//! Linux global-shortcut integration through the XDG GlobalShortcuts portal.
//!
//! Portal binding can present a desktop approval dialog, so every public entry
//! point here is synchronous by design and must be called from a worker thread.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut, Shortcut};
use ashpd::desktop::{ResponseError, Session};
use futures_util::future::{select, Either};
use futures_util::{pin_mut, StreamExt};
use tauri::Manager;

use crate::settings::{save_settings, AppState};
use crate::tray::toggle_main_with_activation_token;

const SHORTCUT_ID: &str = "summon";
const PREFERRED_TRIGGER: &str = "CTRL+SHIFT+m";
const CREATE_TIMEOUT: Duration = Duration::from_secs(5);
const BIND_TIMEOUT: Duration = Duration::from_secs(120);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const REBIND_DELAY: Duration = Duration::from_secs(30);

type CloseResultSender = mpsc::SyncSender<Result<(), String>>;

struct Keeper {
    generation: u64,
    stop: tokio::sync::oneshot::Sender<CloseResultSender>,
}

fn keeper_state() -> &'static Mutex<Option<Keeper>> {
    static KEEPER: OnceLock<Mutex<Option<Keeper>>> = OnceLock::new();
    KEEPER.get_or_init(|| Mutex::new(None))
}

fn next_generation() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed).wrapping_add(1).max(1)
}

fn clear_keeper(generation: u64) {
    let mut keeper = keeper_state().lock().unwrap();
    if keeper
        .as_ref()
        .is_some_and(|keeper| keeper.generation == generation)
    {
        *keeper = None;
    }
}

#[derive(Clone, Debug)]
struct BindFailure {
    message: String,
    denied: bool,
}

impl BindFailure {
    fn ordinary(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            denied: false,
        }
    }

    fn denied(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            denied: true,
        }
    }
}

fn bind_failure(error: ashpd::Error) -> BindFailure {
    let denied = matches!(
        error,
        ashpd::Error::Response(ResponseError::Cancelled)
            | ashpd::Error::Portal(
                ashpd::PortalError::NotAllowed(_) | ashpd::PortalError::Cancelled(_)
            )
    );
    BindFailure {
        message: error.to_string(),
        denied,
    }
}

fn contains_shortcut_id<'a>(ids: impl IntoIterator<Item = &'a str>, expected_id: &str) -> bool {
    ids.into_iter().any(|id| id == expected_id)
}

fn bind_response_contains(shortcuts: &[Shortcut], expected_id: &str) -> bool {
    contains_shortcut_id(shortcuts.iter().map(Shortcut::id), expected_id)
}

fn activation_matches(
    expected_session: &str,
    expected_id: &str,
    actual_session: &str,
    actual_id: &str,
) -> bool {
    expected_session == actual_session && expected_id == actual_id
}

fn activation_token(
    options: &std::collections::HashMap<String, ashpd::zvariant::OwnedValue>,
) -> Option<&str> {
    options
        .get("activation_token")
        .and_then(|value| <&str>::try_from(value).ok())
        .filter(|token| !token.is_empty())
}

fn serialized_session_path<T>(session: &Session<'_, T>) -> Result<String, BindFailure>
where
    T: ashpd::desktop::SessionPortal,
{
    let encoded = serde_json::to_string(session).map_err(|error| {
        BindFailure::ordinary(format!("couldn't encode portal session: {error}"))
    })?;
    serde_json::from_str(&encoded)
        .map_err(|error| BindFailure::ordinary(format!("couldn't read portal session: {error}")))
}

async fn create_session(
    portal: &GlobalShortcuts<'static>,
) -> Result<Session<'static, GlobalShortcuts<'static>>, BindFailure> {
    tokio::time::timeout(CREATE_TIMEOUT, portal.create_session())
        .await
        .map_err(|_| BindFailure::ordinary("portal session creation timed out"))?
        .map_err(bind_failure)
}

async fn close_session(session: &Session<'_, GlobalShortcuts<'static>>) -> Result<(), String> {
    tokio::time::timeout(CLOSE_TIMEOUT, session.close())
        .await
        .map_err(|_| "Couldn't disable portal Global Hotkey: close timed out".to_string())?
        .map_err(|error| format!("Couldn't disable portal Global Hotkey: {error}"))
}

fn acknowledge_early_stop(
    close_sender: Result<CloseResultSender, tokio::sync::oneshot::error::RecvError>,
    ready: Option<&mpsc::SyncSender<Result<(), BindFailure>>>,
    close_result: Result<(), String>,
) {
    if let Some(ready) = ready {
        let _ = ready.send(Err(BindFailure::ordinary(
            "portal shortcut binding was cancelled",
        )));
    }
    if let Ok(sender) = close_sender {
        let _ = sender.send(close_result);
    }
}

async fn disable_persisted_setting(app: tauri::AppHandle) {
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<AppState>();
        let snapshot = {
            let mut settings = state.settings.lock().unwrap();
            if !settings.global_hotkey {
                return Ok(());
            }
            settings.global_hotkey = false;
            settings.clone()
        };
        save_settings(&worker_app, &snapshot).map(|_| ())
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            log::error!("failed to save disabled Global Hotkey setting: {error}");
        }
        Err(error) => {
            log::error!("Global Hotkey setting worker failed: {error}");
        }
    }
}

async fn run_portal_session(
    app: &tauri::AppHandle,
    stop: &mut tokio::sync::oneshot::Receiver<CloseResultSender>,
    ready: Option<&mpsc::SyncSender<Result<(), BindFailure>>>,
    ready_delivered: &mut bool,
) -> Result<(), BindFailure> {
    let connect = tokio::time::timeout(CREATE_TIMEOUT, GlobalShortcuts::new());
    pin_mut!(connect);
    let portal: GlobalShortcuts<'static> = match select(&mut *stop, connect).await {
        Either::Left((close_sender, _)) => {
            acknowledge_early_stop(close_sender, ready, Ok(()));
            return Ok(());
        }
        Either::Right((result, _)) => result
            .map_err(|_| BindFailure::ordinary("portal connection timed out"))?
            .map_err(bind_failure)?,
    };

    let create = create_session(&portal);
    pin_mut!(create);
    let session = match select(&mut *stop, create).await {
        Either::Left((close_sender, _)) => {
            // Dropping the in-flight request aborts creation; there is no
            // session handle available to close yet.
            acknowledge_early_stop(close_sender, ready, Ok(()));
            return Ok(());
        }
        Either::Right((result, _)) => result?,
    };
    let session_path = serialized_session_path(&session)?;

    // Subscribe before binding so an activation immediately after approval
    // cannot race past the listener.
    let subscribe = portal.receive_activated();
    pin_mut!(subscribe);
    let mut activations = match select(&mut *stop, subscribe).await {
        Either::Left((close_sender, _)) => {
            let close_result = close_session(&session).await;
            acknowledge_early_stop(close_sender, ready, close_result);
            return Ok(());
        }
        Either::Right((result, _)) => result.map_err(bind_failure)?,
    };
    let shortcut =
        NewShortcut::new(SHORTCUT_ID, "Show or hide Carrier").preferred_trigger(PREFERRED_TRIGGER);
    let shortcuts = [shortcut];
    let bind = tokio::time::timeout(
        BIND_TIMEOUT,
        portal.bind_shortcuts(&session, &shortcuts, None),
    );
    pin_mut!(bind);
    let request = match select(&mut *stop, bind).await {
        Either::Left((close_sender, _)) => {
            let close_result = close_session(&session).await;
            acknowledge_early_stop(close_sender, ready, close_result);
            return Ok(());
        }
        Either::Right((result, _)) => result
            .map_err(|_| BindFailure::ordinary("portal shortcut approval timed out"))?
            .map_err(bind_failure)?,
    };
    let response = request.response().map_err(bind_failure)?;
    if !bind_response_contains(response.shortcuts(), SHORTCUT_ID) {
        return Err(BindFailure::denied(
            "portal response did not contain the summon shortcut",
        ));
    }
    if let Some(sender) = ready {
        if sender.send(Ok(())).is_err() {
            let _ = close_session(&session).await;
            return Ok(());
        }
        *ready_delivered = true;
    }

    loop {
        let activation = activations.next();
        pin_mut!(activation);
        match select(&mut *stop, activation).await {
            Either::Left((close_sender, _)) => {
                let result = close_session(&session).await;
                if let Ok(sender) = close_sender {
                    let _ = sender.send(result);
                }
                return Ok(());
            }
            Either::Right((activation, _)) => {
                let Some(activation) = activation else {
                    return Err(BindFailure::ordinary(
                        "desktop GlobalShortcuts portal stream ended",
                    ));
                };
                if activation_matches(
                    &session_path,
                    SHORTCUT_ID,
                    activation.session_handle().as_str(),
                    activation.shortcut_id(),
                ) {
                    let token = activation_token(activation.options()).map(str::to_owned);
                    let activation_app = app.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        toggle_main_with_activation_token(&activation_app, token.as_deref());
                    }) {
                        log::warn!("failed to dispatch Global Hotkey activation: {error}");
                    }
                }
            }
        }
    }
}

async fn keeper_task(
    app: tauri::AppHandle,
    generation: u64,
    mut stop: tokio::sync::oneshot::Receiver<CloseResultSender>,
    ready: mpsc::SyncSender<Result<(), BindFailure>>,
) {
    let mut first = true;
    let mut ready_delivered = false;
    let mut last_error = None;
    loop {
        let is_initial = first;
        first = false;
        let result = run_portal_session(
            &app,
            &mut stop,
            if is_initial { Some(&ready) } else { None },
            &mut ready_delivered,
        )
        .await;
        if is_initial && !ready_delivered && result.is_err() {
            if ready
                .send(result.as_ref().map(|_| ()).map_err(Clone::clone))
                .is_err()
            {
                break;
            }
            break;
        }

        match result {
            Ok(()) => break,
            Err(error) if error.denied => {
                // A denial during background recovery is a user decision. Do
                // not reopen the approval dialog every 30 seconds.
                log::warn!(
                    "desktop denied Global Hotkey rebind; disabling the setting: {}",
                    error.message
                );
                disable_persisted_setting(app.clone()).await;
                break;
            }
            Err(error) => {
                if last_error.as_deref() != Some(error.message.as_str()) {
                    log::warn!(
                        "desktop Global Hotkey portal unavailable; retrying: {}",
                        error.message
                    );
                    last_error = Some(error.message);
                }
            }
        }

        let delay = async_io::Timer::after(REBIND_DELAY);
        pin_mut!(delay);
        match select(&mut stop, delay).await {
            Either::Left((close_sender, _)) => {
                if let Ok(sender) = close_sender {
                    let _ = sender.send(Ok(()));
                }
                break;
            }
            Either::Right((_, _)) => {}
        }
    }

    clear_keeper(generation);
}

pub(crate) fn is_active() -> bool {
    keeper_state().lock().unwrap().is_some()
}

/// Bind the summon shortcut and keep its portal session alive.
pub(crate) fn enable(app: &tauri::AppHandle) -> Result<(), String> {
    if is_active() {
        return Ok(());
    }
    let (ready_rx, generation) = {
        let mut keeper = keeper_state().lock().unwrap();
        if keeper.is_some() {
            return Ok(());
        }
        let generation = next_generation();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        *keeper = Some(Keeper {
            generation,
            stop: stop_tx,
        });
        tauri::async_runtime::spawn(keeper_task(app.clone(), generation, stop_rx, ready_tx));
        (ready_rx, generation)
    };

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => {
            clear_keeper(generation);
            Err(format!(
                "Couldn't enable portal Global Hotkey: {}",
                error.message
            ))
        }
        Err(error) => {
            clear_keeper(generation);
            Err(format!("Couldn't start portal Global Hotkey: {error}"))
        }
    }
}

/// Close the active portal session, if any.
pub(crate) fn disable() -> Result<(), String> {
    let Some(keeper) = keeper_state().lock().unwrap().take() else {
        return Ok(());
    };
    let (closed_tx, closed_rx) = mpsc::sync_channel(1);
    keeper
        .stop
        .send(closed_tx)
        .map_err(|_| "Couldn't disable portal Global Hotkey: keeper stopped".to_string())?;
    closed_rx
        .recv_timeout(CLOSE_WAIT_TIMEOUT)
        .map_err(|error| format!("Couldn't disable portal Global Hotkey: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_requires_matching_session_and_id() {
        assert!(activation_matches(
            "/org/freedesktop/portal/desktop/session/1",
            "summon",
            "/org/freedesktop/portal/desktop/session/1",
            "summon",
        ));
        assert!(!activation_matches(
            "/org/freedesktop/portal/desktop/session/1",
            "summon",
            "/org/freedesktop/portal/desktop/session/2",
            "summon",
        ));
        assert!(!activation_matches(
            "/org/freedesktop/portal/desktop/session/1",
            "summon",
            "/org/freedesktop/portal/desktop/session/1",
            "other",
        ));
    }

    #[test]
    fn bind_response_requires_the_requested_id() {
        assert!(contains_shortcut_id(["other", SHORTCUT_ID], SHORTCUT_ID));
        assert!(!contains_shortcut_id(["other"], SHORTCUT_ID));
    }

    #[test]
    fn activation_token_accepts_only_a_nonempty_string() {
        let options = std::collections::HashMap::from([(
            "activation_token".to_string(),
            ashpd::zvariant::OwnedValue::from(ashpd::zvariant::Str::from("portal-token")),
        )]);
        assert_eq!(activation_token(&options), Some("portal-token"));

        let empty = std::collections::HashMap::from([(
            "activation_token".to_string(),
            ashpd::zvariant::OwnedValue::from(ashpd::zvariant::Str::from("")),
        )]);
        assert_eq!(activation_token(&empty), None);

        let wrong_type = std::collections::HashMap::from([(
            "activation_token".to_string(),
            ashpd::zvariant::OwnedValue::from(7_u32),
        )]);
        assert_eq!(activation_token(&wrong_type), None);
    }

    #[test]
    fn generic_portal_failure_is_not_a_user_denial() {
        assert!(bind_failure(ashpd::Error::Response(ResponseError::Cancelled)).denied);
        assert!(!bind_failure(ashpd::Error::Response(ResponseError::Other)).denied);
    }
}
