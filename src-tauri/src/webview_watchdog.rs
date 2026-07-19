//! Native supervision for Messenger's renderer process.
//!
//! A JavaScript timer cannot detect that its own WebView is suspended until it
//! wakes up again. Carrier therefore pings the injected page from the native
//! process and reloads a Messenger window when its content-free heartbeat stops.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{Listener, WebviewWindow, WindowEvent};

use crate::preflight::messenger_dns_preflight;
use crate::url_rules::is_messenger_web_url;
use crate::MESSENGER_DNS_TIMEOUT;

const HEARTBEAT_EVENT: &str = "carrier:webview-heartbeat";
const PING_INTERVAL: Duration = Duration::from_secs(5);
const PING_RESPONSE_GRACE: Duration = Duration::from_millis(250);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(20);
const PROTECTED_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(60);
const REACHABILITY_RETRY: Duration = Duration::from_secs(10);

static NEXT_WATCHDOG_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
struct HeartbeatPayload {
    // This routes heartbeats to the right window generation; it is not a
    // security credential. The remote page already has event-plugin access.
    id: u64,
    protected: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum WatchdogAction {
    None,
    Protected,
    Reload,
}

#[derive(Debug, Default)]
struct WatchdogState {
    last_heartbeat_at: Option<Duration>,
    navigation_started_at: Option<Duration>,
    protected: bool,
}

impl WatchdogState {
    fn heartbeat(&mut self, now: Duration, protected: bool) {
        self.last_heartbeat_at = Some(now);
        self.navigation_started_at = None;
        self.protected = protected;
    }

    fn action(&self, now: Duration) -> WatchdogAction {
        if let Some(navigation_started_at) = self.navigation_started_at {
            return if now.saturating_sub(navigation_started_at) < NAVIGATION_TIMEOUT {
                WatchdogAction::None
            } else {
                WatchdogAction::Reload
            };
        }
        let Some(last_heartbeat_at) = self.last_heartbeat_at else {
            return WatchdogAction::None;
        };
        let stalled_for = now.saturating_sub(last_heartbeat_at);
        if stalled_for < HEARTBEAT_TIMEOUT {
            return WatchdogAction::None;
        }
        if self.protected && stalled_for < PROTECTED_HEARTBEAT_TIMEOUT {
            WatchdogAction::Protected
        } else {
            WatchdogAction::Reload
        }
    }

    fn navigation_started(&mut self, now: Duration) {
        self.navigation_started_at = Some(now);
    }

    fn navigation_failed(&mut self) {
        self.navigation_started_at = None;
    }

    fn disarm(&mut self) {
        self.last_heartbeat_at = None;
        self.navigation_started_at = None;
        self.protected = false;
    }
}

#[derive(Clone)]
pub(crate) struct WebviewWatchdog {
    id: u64,
    started_at: Instant,
    state: Arc<Mutex<WatchdogState>>,
}

impl WebviewWatchdog {
    pub(crate) fn new() -> Self {
        Self {
            id: NEXT_WATCHDOG_ID.fetch_add(1, Ordering::Relaxed),
            started_at: Instant::now(),
            state: Arc::new(Mutex::new(WatchdogState::default())),
        }
    }

    pub(crate) fn id(&self) -> u64 {
        self.id
    }

    /// Pause stale checks while a replacement document loads. A new heartbeat
    /// clears this state; a load that never answers becomes recoverable again.
    pub(crate) fn navigation_started(&self) {
        self.state
            .lock()
            .unwrap()
            .navigation_started(self.started_at.elapsed());
    }

    /// Forget the previous document when navigation reaches a page outside the
    /// Messenger injection scope, such as an OAuth or captcha surface.
    pub(crate) fn disarm(&self) {
        self.state.lock().unwrap().disarm();
    }

    /// Install one watchdog task for this Messenger window generation.
    ///
    /// The watchdog arms only after the injected page answers once, so Carrier's
    /// local connectivity screen and a page that has not loaded yet are never put
    /// into a reload loop. A destroyed window stops its task; this matters when a
    /// macOS theme change rebuilds a window under the same label.
    pub(crate) fn install(&self, window: &WebviewWindow) {
        let watchdog_id = self.id;
        let started_at = self.started_at;
        let heartbeat_state = Arc::clone(&self.state);
        let listener_id = window.listen(HEARTBEAT_EVENT, move |event| {
            let Ok(payload) = serde_json::from_str::<HeartbeatPayload>(event.payload()) else {
                return;
            };
            if payload.id != watchdog_id {
                return;
            }
            heartbeat_state
                .lock()
                .unwrap()
                .heartbeat(started_at.elapsed(), payload.protected);
        });

        let alive = Arc::new(AtomicBool::new(true));
        let window_alive = Arc::clone(&alive);
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                window_alive.store(false, Ordering::Release);
            }
        });

        let state = Arc::clone(&self.state);
        let watchdog_window = window.clone();
        let label = window.label().to_string();
        tauri::async_runtime::spawn(async move {
            let mut next_recovery_attempt = Duration::ZERO;
            loop {
                tokio::time::sleep(PING_INTERVAL).await;
                if !alive.load(Ordering::Acquire) {
                    break;
                }

                // Native eval wakes a throttled renderer. The event response proves
                // the page actually executed it; a successful eval call alone only
                // proves that WebKit accepted the request.
                let _ =
                    watchdog_window.eval(format!("window.__carrierHeartbeat?.({watchdog_id});"));
                tokio::time::sleep(PING_RESPONSE_GRACE).await;

                let action = state.lock().unwrap().action(started_at.elapsed());
                match action {
                    WatchdogAction::None | WatchdogAction::Protected => {}
                    WatchdogAction::Reload => {
                        let now = started_at.elapsed();
                        if now < next_recovery_attempt {
                            continue;
                        }
                        let Ok(url) = watchdog_window.url() else {
                            next_recovery_attempt = now + REACHABILITY_RETRY;
                            continue;
                        };
                        // Auth providers and captcha pages intentionally do not run
                        // Carrier's injection. Forget the Messenger heartbeat rather
                        // than reloading a user out of an in-progress login flow.
                        if !is_messenger_web_url(&url) {
                            state.lock().unwrap().disarm();
                            continue;
                        }

                        // A native reload can strand WebKit on its network-error
                        // document, where neither injection nor the `online` event
                        // runs. Keep the stale state armed and retry reachability so
                        // recovery happens automatically when the network returns.
                        let reachable = matches!(
                            tokio::time::timeout(
                                MESSENGER_DNS_TIMEOUT,
                                tauri::async_runtime::spawn_blocking(messenger_dns_preflight)
                            )
                            .await,
                            Ok(Ok(Ok(())))
                        );
                        if !reachable {
                            next_recovery_attempt = now + REACHABILITY_RETRY;
                            continue;
                        }

                        log::warn!(
                            "Messenger webview {label} stopped responding; reloading to restore sync"
                        );
                        state.lock().unwrap().navigation_started(now);
                        match watchdog_window.reload() {
                            Ok(()) => {
                                next_recovery_attempt = Duration::ZERO;
                            }
                            Err(error) => {
                                state.lock().unwrap().navigation_failed();
                                log::warn!(
                                    "failed to reload stale Messenger webview {label}: {error}"
                                );
                                next_recovery_attempt = now + REACHABILITY_RETRY;
                            }
                        }
                    }
                }
            }
            watchdog_window.unlisten(listener_id);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_disarmed_until_the_page_responds() {
        let state = WatchdogState::default();

        assert_eq!(state.action(HEARTBEAT_TIMEOUT * 10), WatchdogAction::None);
    }

    #[test]
    fn reloads_immediately_after_the_heartbeat_deadline() {
        let mut state = WatchdogState::default();
        state.heartbeat(Duration::ZERO, false);

        assert_eq!(
            state.action(HEARTBEAT_TIMEOUT - Duration::from_millis(1)),
            WatchdogAction::None
        );
        assert_eq!(state.action(HEARTBEAT_TIMEOUT), WatchdogAction::Reload);
    }

    #[test]
    fn protects_a_draft_or_call_during_a_renderer_stall() {
        let mut state = WatchdogState::default();
        state.heartbeat(Duration::ZERO, true);

        assert_eq!(state.action(HEARTBEAT_TIMEOUT), WatchdogAction::Protected);
        assert_eq!(
            state.action(PROTECTED_HEARTBEAT_TIMEOUT - Duration::from_millis(1)),
            WatchdogAction::Protected
        );
        assert_eq!(
            state.action(PROTECTED_HEARTBEAT_TIMEOUT),
            WatchdogAction::Reload
        );
    }

    #[test]
    fn a_reload_disarms_until_the_new_page_responds() {
        let mut state = WatchdogState::default();
        state.heartbeat(Duration::ZERO, false);
        state.disarm();

        assert_eq!(state.action(HEARTBEAT_TIMEOUT * 2), WatchdogAction::None);
    }

    #[test]
    fn navigation_waits_for_a_new_page_then_recovers_if_it_never_answers() {
        let mut state = WatchdogState::default();
        state.heartbeat(Duration::ZERO, false);
        state.navigation_started(Duration::from_secs(1));

        assert_eq!(
            state.action(Duration::from_secs(1) + NAVIGATION_TIMEOUT - Duration::from_millis(1)),
            WatchdogAction::None
        );
        assert_eq!(
            state.action(Duration::from_secs(1) + NAVIGATION_TIMEOUT),
            WatchdogAction::Reload
        );

        state.heartbeat(Duration::from_secs(2), false);
        assert_eq!(
            state.action(Duration::from_secs(2) + HEARTBEAT_TIMEOUT - Duration::from_millis(1)),
            WatchdogAction::None
        );
    }
}
