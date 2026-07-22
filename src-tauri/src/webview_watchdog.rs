//! Native supervision for Messenger's renderer process.
//!
//! A JavaScript timer cannot detect that its own WebView is suspended until it
//! wakes up again. Carrier therefore pings the injected page from the native
//! process and reloads a Messenger window when its content-free heartbeat stops.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{Listener, Manager, WebviewWindow, WindowEvent};

use crate::preflight::messenger_dns_preflight;
use crate::url_rules::is_messenger_web_url;
use crate::MESSENGER_DNS_TIMEOUT;

const HEARTBEAT_EVENT: &str = "carrier:webview-heartbeat";
const PING_INTERVAL: Duration = Duration::from_secs(5);
const PING_RESPONSE_GRACE: Duration = Duration::from_millis(250);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(20);
const PROTECTED_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MISSING_CONTENT_TIMEOUT: Duration = Duration::from_secs(60);
const NAVIGATION_TIMEOUT: Duration = Duration::from_secs(60);
const REACHABILITY_RETRY: Duration = Duration::from_secs(10);
/// How long the page must continuously report a bad realtime transport before
/// the native side intervenes. The page's own 60s reload loop handles the
/// transient cases first; this only fires when the page cannot help itself.
const REALTIME_BAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Native reloads per bad-transport episode before escalating to a rebuild.
const REALTIME_RELOAD_LIMIT: u32 = 2;
/// Webview rebuilds per app session without an intervening healthy transport.
/// Bounds the damage if the page's transport instrumentation goes blind.
const REALTIME_RECREATE_LIMIT: u32 = 1;
/// A heartbeat gap this large means the renderer was suspended; the realtime
/// timer restarts so thresholds require fresh continuous reports.
const REALTIME_HEARTBEAT_GAP_RESET: Duration = Duration::from_secs(30);
/// Facebook's static error document is unambiguous the moment it renders, so
/// it only gets a short confirmation window before recovery acts...
const REALTIME_ERROR_TIMEOUT: Duration = Duration::from_secs(15);
/// ...and a single reload attempt: if a reload already came back to the same
/// error page, rebuilding the webview is the next useful step.
const REALTIME_ERROR_RELOAD_LIMIT: u32 = 1;

static NEXT_WATCHDOG_ID: AtomicU64 = AtomicU64::new(1);
// Survives window recreation (which builds a fresh watchdog); reset to zero
// whenever any heartbeat proves the realtime transport healthy.
static REALTIME_RECREATES: AtomicU32 = AtomicU32::new(0);
// Whether the give-up rung actually showed its native notice. Only then does
// a healthy transport report earn a "recovered" notification — a healthy
// transport must never clear a sync-degraded notice raised by the page (the
// transport can be fine while sync is dead; that is that notice's whole point).
static REALTIME_EXHAUSTION_NOTIFIED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Deserialize)]
struct HeartbeatPayload {
    // This routes heartbeats to the right window generation; it is not a
    // security credential. The remote page already has event-plugin access.
    id: u64,
    protected: bool,
    /// Whether a `/messages` document still has visible page controls. Older
    /// payloads omit this and retain the renderer-only watchdog behaviour.
    content_present: Option<bool>,
    /// Realtime transport status as observed by the page. Older payloads omit
    /// it; unknown future strings deserialize as `Unknown` rather than
    /// invalidating the whole heartbeat.
    realtime: Option<RealtimeSignal>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RealtimeSignal {
    Ok,
    Pending,
    Stale,
    Never,
    Error,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, PartialEq, Eq)]
enum WatchdogAction {
    None,
    Protected,
    Reload,
    ReloadBlank,
    RecreateBlank,
    ReloadRealtime,
    RecreateRealtime,
}

#[derive(Debug, Default)]
struct WatchdogState {
    last_heartbeat_at: Option<Duration>,
    navigation_started_at: Option<Duration>,
    missing_content_since: Option<Duration>,
    blank_reload_attempted: bool,
    protected: bool,
    realtime_bad_since: Option<Duration>,
    realtime_error_page: bool,
    realtime_reloads: u32,
    realtime_exhausted: bool,
}

impl WatchdogState {
    fn heartbeat(
        &mut self,
        now: Duration,
        protected: bool,
        content_present: Option<bool>,
        realtime: Option<RealtimeSignal>,
    ) {
        // A large gap means the renderer was suspended, not that the transport
        // was continuously bad; restart the accounting from fresh heartbeats.
        if self
            .last_heartbeat_at
            .is_some_and(|last| now.saturating_sub(last) >= REALTIME_HEARTBEAT_GAP_RESET)
        {
            self.realtime_bad_since = None;
        }
        self.last_heartbeat_at = Some(now);
        self.navigation_started_at = None;
        self.protected = protected;
        match content_present {
            Some(true) => {
                self.missing_content_since = None;
                self.blank_reload_attempted = false;
            }
            Some(false) => {
                self.missing_content_since.get_or_insert(now);
            }
            None => {}
        }
        self.realtime_error_page = matches!(realtime, Some(RealtimeSignal::Error));
        match realtime {
            // A proven-healthy transport ends the episode: the reload budget
            // and the give-up latch re-arm in full.
            Some(RealtimeSignal::Ok) => {
                self.realtime_bad_since = None;
                self.realtime_reloads = 0;
                self.realtime_exhausted = false;
            }
            Some(RealtimeSignal::Stale | RealtimeSignal::Never | RealtimeSignal::Error) => {
                self.realtime_bad_since.get_or_insert(now);
            }
            // "pending" pauses the timer without refunding the reload budget —
            // a reload into a still-broken page must not reset escalation.
            Some(RealtimeSignal::Pending | RealtimeSignal::Unknown) | None => {
                self.realtime_bad_since = None;
            }
        }
    }

    fn action(&self, now: Duration) -> WatchdogAction {
        if let Some(navigation_started_at) = self.navigation_started_at {
            return if now.saturating_sub(navigation_started_at) < NAVIGATION_TIMEOUT {
                WatchdogAction::None
            } else {
                WatchdogAction::Reload
            };
        }
        if self
            .missing_content_since
            .is_some_and(|since| now.saturating_sub(since) >= MISSING_CONTENT_TIMEOUT)
        {
            if self.protected {
                return WatchdogAction::Protected;
            }
            return if self.blank_reload_attempted {
                WatchdogAction::RecreateBlank
            } else {
                WatchdogAction::ReloadBlank
            };
        }
        let Some(last_heartbeat_at) = self.last_heartbeat_at else {
            return WatchdogAction::None;
        };
        let stalled_for = now.saturating_sub(last_heartbeat_at);
        if stalled_for >= HEARTBEAT_TIMEOUT {
            return if self.protected && stalled_for < PROTECTED_HEARTBEAT_TIMEOUT {
                WatchdogAction::Protected
            } else {
                WatchdogAction::Reload
            };
        }
        // Facebook's static error page is a certainty, not a suspicion: confirm
        // briefly, spend one reload, then go straight to a rebuild.
        let (bad_timeout, reload_limit) = if self.realtime_error_page {
            (REALTIME_ERROR_TIMEOUT, REALTIME_ERROR_RELOAD_LIMIT)
        } else {
            (REALTIME_BAD_TIMEOUT, REALTIME_RELOAD_LIMIT)
        };
        if !self.realtime_exhausted
            && self
                .realtime_bad_since
                .is_some_and(|since| now.saturating_sub(since) >= bad_timeout)
        {
            if self.protected {
                return WatchdogAction::Protected;
            }
            return if self.realtime_reloads < reload_limit {
                WatchdogAction::ReloadRealtime
            } else {
                WatchdogAction::RecreateRealtime
            };
        }
        WatchdogAction::None
    }

    fn navigation_started(&mut self, now: Duration) {
        self.navigation_started_at = Some(now);
    }

    fn navigation_failed(&mut self) {
        self.navigation_started_at = None;
    }

    fn blank_reload_started(&mut self, now: Duration) {
        self.blank_reload_attempted = true;
        self.missing_content_since = None;
        self.navigation_started(now);
    }

    fn realtime_reload_started(&mut self, now: Duration) {
        self.realtime_reloads += 1;
        self.realtime_bad_since = None;
        self.navigation_started(now);
    }

    fn realtime_recovery_exhausted(&mut self) {
        self.realtime_exhausted = true;
        self.realtime_bad_since = None;
    }

    fn disarm(&mut self) {
        self.last_heartbeat_at = None;
        self.navigation_started_at = None;
        self.missing_content_since = None;
        self.blank_reload_attempted = false;
        self.protected = false;
        self.realtime_bad_since = None;
        self.realtime_error_page = false;
        self.realtime_reloads = 0;
        self.realtime_exhausted = false;
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
        let listener_window = window.clone();
        let listener_id = window.listen(HEARTBEAT_EVENT, move |event| {
            let Ok(payload) = serde_json::from_str::<HeartbeatPayload>(event.payload()) else {
                return;
            };
            if payload.id != watchdog_id {
                return;
            }
            if payload.realtime == Some(RealtimeSignal::Ok) {
                REALTIME_RECREATES.store(0, Ordering::Relaxed);
                // Pair a "recovered" notice only with a shown exhaustion
                // notice — never with a sync-degraded notice from the page.
                if REALTIME_EXHAUSTION_NOTIFIED.swap(false, Ordering::Relaxed) {
                    crate::notifications::show_sync_alert(
                        listener_window.app_handle().clone(),
                        crate::notifications::SyncAlertKind::Recovered,
                    );
                }
            }
            heartbeat_state.lock().unwrap().heartbeat(
                started_at.elapsed(),
                payload.protected,
                payload.content_present,
                payload.realtime,
            );
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
                    WatchdogAction::Reload
                    | WatchdogAction::ReloadBlank
                    | WatchdogAction::RecreateBlank
                    | WatchdogAction::ReloadRealtime
                    | WatchdogAction::RecreateRealtime => {
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

                        match action {
                            WatchdogAction::Reload => {
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
                            WatchdogAction::ReloadBlank => {
                                log::warn!(
                                    "Messenger webview {label} lost its visible page content; reloading"
                                );
                                state.lock().unwrap().blank_reload_started(now);
                                match watchdog_window.reload() {
                                    Ok(()) => {
                                        next_recovery_attempt = Duration::ZERO;
                                    }
                                    Err(error) => {
                                        state.lock().unwrap().navigation_failed();
                                        log::warn!(
                                            "failed to reload blank Messenger webview {label}: {error}"
                                        );
                                        next_recovery_attempt = now + REACHABILITY_RETRY;
                                    }
                                }
                            }
                            WatchdogAction::ReloadRealtime => {
                                log::warn!(
                                    "Messenger webview {label} reports a dead realtime transport; reloading to restore sync"
                                );
                                state.lock().unwrap().realtime_reload_started(now);
                                match watchdog_window.reload() {
                                    Ok(()) => {
                                        next_recovery_attempt = Duration::ZERO;
                                    }
                                    Err(error) => {
                                        state.lock().unwrap().navigation_failed();
                                        log::warn!(
                                            "failed to reload Messenger webview {label} with dead realtime transport: {error}"
                                        );
                                        next_recovery_attempt = now + REACHABILITY_RETRY;
                                    }
                                }
                            }
                            WatchdogAction::RecreateBlank | WatchdogAction::RecreateRealtime => {
                                // DNS resolution ran off-thread. Messenger may
                                // have recovered while it was in flight, so do
                                // not destroy a webview whose state has since
                                // improved.
                                if state.lock().unwrap().action(started_at.elapsed()) != action {
                                    next_recovery_attempt = Duration::ZERO;
                                    continue;
                                }
                                if action == WatchdogAction::RecreateRealtime {
                                    // One atomic claim of the rebuild budget:
                                    // concurrent window watchdogs must not both
                                    // pass a separate check-then-increment.
                                    let claimed = REALTIME_RECREATES
                                        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                                            (n < REALTIME_RECREATE_LIMIT).then_some(n + 1)
                                        })
                                        .is_ok();
                                    if !claimed {
                                        state.lock().unwrap().realtime_recovery_exhausted();
                                        log::warn!(
                                            "Messenger webview {label} realtime transport still dead after rebuilding; giving up automated recovery until it reports healthy"
                                        );
                                        // The one silent spot left: a page with no
                                        // spinners and no requests (Facebook's error
                                        // page) that recovery could not fix. Say so
                                        // natively; the alert gate dedupes.
                                        if crate::notifications::show_sync_alert(
                                            watchdog_window.app_handle().clone(),
                                            crate::notifications::SyncAlertKind::Degraded,
                                        ) {
                                            REALTIME_EXHAUSTION_NOTIFIED
                                                .store(true, Ordering::Relaxed);
                                        }
                                        continue;
                                    }
                                    log::warn!(
                                        "Messenger webview {label} realtime transport stayed dead across reloads; rebuilding the webview"
                                    );
                                } else {
                                    log::warn!(
                                        "Messenger webview {label} stayed blank after reload; rebuilding it"
                                    );
                                }
                                if crate::window::recreate_messenger_window(
                                    watchdog_window.app_handle(),
                                    &label,
                                ) {
                                    // Keep supervising until the async rebuild
                                    // actually destroys this window. If destroy
                                    // fails, `alive` stays set and a later pass
                                    // retries instead of leaving the label
                                    // without a watchdog.
                                    next_recovery_attempt = now + REACHABILITY_RETRY;
                                    continue;
                                }
                                next_recovery_attempt = now + REACHABILITY_RETRY;
                            }
                            WatchdogAction::None | WatchdogAction::Protected => unreachable!(),
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
        state.heartbeat(Duration::ZERO, false, None, None);

        assert_eq!(
            state.action(HEARTBEAT_TIMEOUT - Duration::from_millis(1)),
            WatchdogAction::None
        );
        assert_eq!(state.action(HEARTBEAT_TIMEOUT), WatchdogAction::Reload);
    }

    #[test]
    fn protects_a_draft_or_call_during_a_renderer_stall() {
        let mut state = WatchdogState::default();
        state.heartbeat(Duration::ZERO, true, None, None);

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
        state.heartbeat(Duration::ZERO, false, None, None);
        state.disarm();

        assert_eq!(state.action(HEARTBEAT_TIMEOUT * 2), WatchdogAction::None);
    }

    #[test]
    fn navigation_waits_for_a_new_page_then_recovers_if_it_never_answers() {
        let mut state = WatchdogState::default();
        state.heartbeat(Duration::ZERO, false, None, None);
        state.navigation_started(Duration::from_secs(1));

        assert_eq!(
            state.action(Duration::from_secs(1) + NAVIGATION_TIMEOUT - Duration::from_millis(1)),
            WatchdogAction::None
        );
        assert_eq!(
            state.action(Duration::from_secs(1) + NAVIGATION_TIMEOUT),
            WatchdogAction::Reload
        );

        state.heartbeat(Duration::from_secs(2), false, None, None);
        assert_eq!(
            state.action(Duration::from_secs(2) + HEARTBEAT_TIMEOUT - Duration::from_millis(1)),
            WatchdogAction::None
        );
    }

    #[test]
    fn blank_content_reloads_once_then_recreates_the_webview() {
        let mut state = WatchdogState::default();
        state.heartbeat(Duration::ZERO, false, Some(false), None);
        state.heartbeat(
            MISSING_CONTENT_TIMEOUT - Duration::from_millis(1),
            false,
            Some(false),
            None,
        );
        assert_eq!(
            state.action(MISSING_CONTENT_TIMEOUT - Duration::from_millis(1)),
            WatchdogAction::None
        );

        state.heartbeat(MISSING_CONTENT_TIMEOUT, false, Some(false), None);
        assert_eq!(
            state.action(MISSING_CONTENT_TIMEOUT),
            WatchdogAction::ReloadBlank
        );
        state.blank_reload_started(MISSING_CONTENT_TIMEOUT);
        assert_eq!(
            state.action(MISSING_CONTENT_TIMEOUT + Duration::from_millis(500)),
            WatchdogAction::None
        );

        let next_document = MISSING_CONTENT_TIMEOUT + Duration::from_secs(1);
        state.heartbeat(next_document, false, Some(false), None);
        state.heartbeat(
            next_document + MISSING_CONTENT_TIMEOUT,
            false,
            Some(false),
            None,
        );
        assert_eq!(
            state.action(next_document + MISSING_CONTENT_TIMEOUT),
            WatchdogAction::RecreateBlank
        );
    }

    #[test]
    fn visible_content_cancels_blank_recovery_escalation() {
        let mut state = WatchdogState::default();
        state.heartbeat(Duration::ZERO, false, Some(false), None);
        state.blank_reload_started(MISSING_CONTENT_TIMEOUT);
        state.heartbeat(
            MISSING_CONTENT_TIMEOUT + Duration::from_secs(1),
            false,
            Some(true),
            None,
        );

        assert_eq!(
            state.action(
                MISSING_CONTENT_TIMEOUT + Duration::from_secs(1) + HEARTBEAT_TIMEOUT
                    - Duration::from_millis(1)
            ),
            WatchdogAction::None
        );
        assert!(!state.blank_reload_attempted);
        assert!(state.missing_content_since.is_none());
    }

    #[test]
    fn heartbeat_payload_without_content_signal_stays_compatible() {
        let payload: HeartbeatPayload =
            serde_json::from_str(r#"{"id":7,"protected":false}"#).unwrap();

        assert_eq!(payload.id, 7);
        assert_eq!(payload.content_present, None);
        assert_eq!(payload.realtime, None);
    }

    /// Feed a heartbeat every 5s (the page's real cadence) from `from` to `to`
    /// seconds inclusive, reporting the given realtime signal.
    fn feed_realtime(state: &mut WatchdogState, from: u64, to: u64, signal: RealtimeSignal) {
        let mut t = from;
        while t <= to {
            state.heartbeat(Duration::from_secs(t), false, Some(true), Some(signal));
            t += 5;
        }
    }

    #[test]
    fn persistent_bad_realtime_reloads_after_the_threshold() {
        let mut state = WatchdogState::default();
        feed_realtime(&mut state, 0, 115, RealtimeSignal::Stale);
        assert_eq!(state.action(Duration::from_secs(115)), WatchdogAction::None);

        feed_realtime(&mut state, 120, 120, RealtimeSignal::Never);
        assert_eq!(
            state.action(Duration::from_secs(120)),
            WatchdogAction::ReloadRealtime
        );
    }

    #[test]
    fn realtime_ok_resets_the_bad_timer_and_attempts() {
        let mut state = WatchdogState::default();
        feed_realtime(&mut state, 0, 120, RealtimeSignal::Stale);
        state.realtime_reload_started(Duration::from_secs(120));

        state.heartbeat(
            Duration::from_secs(125),
            false,
            Some(true),
            Some(RealtimeSignal::Ok),
        );
        assert_eq!(state.action(Duration::from_secs(125)), WatchdogAction::None);

        feed_realtime(&mut state, 130, 250, RealtimeSignal::Stale);
        assert_eq!(
            state.action(Duration::from_secs(250)),
            WatchdogAction::ReloadRealtime
        );
    }

    #[test]
    fn pending_clears_the_timer_but_preserves_escalation() {
        let mut state = WatchdogState::default();
        feed_realtime(&mut state, 0, 120, RealtimeSignal::Stale);
        assert_eq!(
            state.action(Duration::from_secs(120)),
            WatchdogAction::ReloadRealtime
        );
        state.realtime_reload_started(Duration::from_secs(120));

        // The reloaded page reports "pending" while it boots: no action, but
        // the reload budget is not refunded.
        feed_realtime(&mut state, 125, 125, RealtimeSignal::Pending);
        assert_eq!(state.action(Duration::from_secs(125)), WatchdogAction::None);

        feed_realtime(&mut state, 130, 250, RealtimeSignal::Never);
        assert_eq!(
            state.action(Duration::from_secs(250)),
            WatchdogAction::ReloadRealtime
        );
        state.realtime_reload_started(Duration::from_secs(250));

        feed_realtime(&mut state, 255, 255, RealtimeSignal::Pending);
        feed_realtime(&mut state, 260, 380, RealtimeSignal::Never);
        assert_eq!(
            state.action(Duration::from_secs(380)),
            WatchdogAction::RecreateRealtime
        );
    }

    #[test]
    fn a_heartbeat_gap_restarts_realtime_bad_accounting() {
        let mut state = WatchdogState::default();
        feed_realtime(&mut state, 0, 5, RealtimeSignal::Stale);

        // A suspended renderer resumes 60s later still reporting stale; the
        // bad timer must restart rather than count the suspended time.
        feed_realtime(&mut state, 65, 180, RealtimeSignal::Stale);
        assert_eq!(state.action(Duration::from_secs(180)), WatchdogAction::None);

        feed_realtime(&mut state, 185, 185, RealtimeSignal::Stale);
        assert_eq!(
            state.action(Duration::from_secs(185)),
            WatchdogAction::ReloadRealtime
        );
    }

    #[test]
    fn protected_page_defers_realtime_recovery() {
        let mut state = WatchdogState::default();
        let mut t = 0;
        while t <= 120 {
            state.heartbeat(
                Duration::from_secs(t),
                true,
                Some(true),
                Some(RealtimeSignal::Stale),
            );
            t += 5;
        }

        assert_eq!(
            state.action(Duration::from_secs(120)),
            WatchdogAction::Protected
        );
    }

    #[test]
    fn exhausted_realtime_recovery_waits_for_ok() {
        let mut state = WatchdogState {
            realtime_reloads: REALTIME_RELOAD_LIMIT,
            ..WatchdogState::default()
        };
        feed_realtime(&mut state, 0, 120, RealtimeSignal::Never);
        assert_eq!(
            state.action(Duration::from_secs(120)),
            WatchdogAction::RecreateRealtime
        );

        state.realtime_recovery_exhausted();
        feed_realtime(&mut state, 125, 250, RealtimeSignal::Never);
        assert_eq!(state.action(Duration::from_secs(250)), WatchdogAction::None);

        feed_realtime(&mut state, 255, 255, RealtimeSignal::Ok);
        feed_realtime(&mut state, 260, 380, RealtimeSignal::Stale);
        assert_eq!(
            state.action(Duration::from_secs(380)),
            WatchdogAction::ReloadRealtime
        );
    }

    #[test]
    fn navigation_pauses_realtime_recovery() {
        let mut state = WatchdogState::default();
        feed_realtime(&mut state, 0, 115, RealtimeSignal::Stale);
        state.navigation_started(Duration::from_secs(116));

        assert_eq!(state.action(Duration::from_secs(125)), WatchdogAction::None);
    }

    #[test]
    fn an_error_page_reloads_after_a_short_confirmation() {
        let mut state = WatchdogState::default();
        feed_realtime(&mut state, 0, 10, RealtimeSignal::Error);
        assert_eq!(state.action(Duration::from_secs(10)), WatchdogAction::None);

        feed_realtime(&mut state, 15, 15, RealtimeSignal::Error);
        assert_eq!(
            state.action(Duration::from_secs(15)),
            WatchdogAction::ReloadRealtime
        );
    }

    #[test]
    fn an_error_page_seen_again_after_a_reload_recreates_quickly() {
        let mut state = WatchdogState::default();
        feed_realtime(&mut state, 0, 15, RealtimeSignal::Error);
        assert_eq!(
            state.action(Duration::from_secs(15)),
            WatchdogAction::ReloadRealtime
        );
        state.realtime_reload_started(Duration::from_secs(15));

        // The reload lands on the same error document: one reload was enough
        // to prove reloading does not help, so rebuild after confirmation.
        feed_realtime(&mut state, 20, 20, RealtimeSignal::Pending);
        feed_realtime(&mut state, 25, 40, RealtimeSignal::Error);
        assert_eq!(
            state.action(Duration::from_secs(40)),
            WatchdogAction::RecreateRealtime
        );
    }

    #[test]
    fn an_error_page_resolving_to_messenger_restores_the_slow_ladder() {
        let mut state = WatchdogState::default();
        feed_realtime(&mut state, 0, 15, RealtimeSignal::Error);
        state.realtime_reload_started(Duration::from_secs(15));

        // The reload lands on real Messenger that has not connected yet: the
        // short error deadline no longer applies.
        feed_realtime(&mut state, 20, 140, RealtimeSignal::Never);
        assert_eq!(state.action(Duration::from_secs(139)), WatchdogAction::None);
    }

    #[test]
    fn heartbeat_payload_realtime_deserializes_with_unknown_values() {
        let never: HeartbeatPayload =
            serde_json::from_str(r#"{"id":1,"protected":false,"realtime":"never"}"#).unwrap();
        assert_eq!(never.realtime, Some(RealtimeSignal::Never));

        let error: HeartbeatPayload =
            serde_json::from_str(r#"{"id":1,"protected":false,"realtime":"error"}"#).unwrap();
        assert_eq!(error.realtime, Some(RealtimeSignal::Error));

        let future: HeartbeatPayload =
            serde_json::from_str(r#"{"id":1,"protected":false,"realtime":"weird-future-value"}"#)
                .unwrap();
        assert_eq!(future.realtime, Some(RealtimeSignal::Unknown));
    }
}
