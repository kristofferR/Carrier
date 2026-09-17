//! Bounded recovery for a responsive page that has stopped delivering frames.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

const FOCUSED_STALL: Duration = Duration::from_secs(30);
const UNFOCUSED_STALL: Duration = Duration::from_secs(120);
const RELOAD_GRACE: Duration = Duration::from_secs(60);
const HEALTHY_RESET: Duration = Duration::from_secs(60);
const SAMPLE_GAP: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
pub(crate) struct RenderHeartbeat {
    pub state: RenderSignal,
    pub wait_ms: u64,
    pub document_epoch_ms: u64,
    pub document_age_ms: u64,
    pub visible: bool,
    pub focused: bool,
    // Old diagnostic-only pages and login/checkpoint documents never recover
    // on frame evidence. Their existing heartbeat handling remains available.
    #[serde(default)]
    pub content_page: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RenderSignal {
    Pending,
    Ok,
    Stalled,
    #[serde(other)]
    Unknown,
}

/// Carried into the replacement of this particular window. Healthy siblings
/// cannot refund it, and recreating a webview cannot replenish its own budget.
#[derive(Debug, Clone, Default)]
pub(crate) struct RenderRecoveryBudget(Arc<AtomicBool>);

impl RenderRecoveryBudget {
    pub fn claim(&self) -> bool {
        !self.0.swap(true, Ordering::Relaxed)
    }

    pub fn refund(&self) {
        self.0.store(false, Ordering::Relaxed);
    }

    pub fn used(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct RenderWindowState {
    pub visible: bool,
    pub focused: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RenderAction {
    Wait,
    Protected,
    Reload,
    Rebuild,
    Exhausted,
}

#[derive(Debug, Default)]
pub(crate) struct RenderRecovery {
    budget: RenderRecoveryBudget,
    window: RenderWindowState,
    eligible: bool,
    focused: bool,
    last_sample: Option<Duration>,
    document: Option<u64>,
    stalled_since: Option<Duration>,
    healthy_since: Option<Duration>,
    reload_attempted: bool,
    reload_pending_since: Option<Duration>,
    exhausted_reported: bool,
}

impl RenderRecovery {
    pub fn new(budget: RenderRecoveryBudget) -> Self {
        Self {
            budget,
            ..Self::default()
        }
    }

    pub fn budget(&self) -> RenderRecoveryBudget {
        self.budget.clone()
    }

    pub fn window_changed(&mut self, now: Duration, window: RenderWindowState) {
        if self.window != window {
            self.pause(now);
            self.window = window;
        }
    }

    pub fn pause(&mut self, now: Duration) {
        self.stalled_since = None;
        self.healthy_since = None;
        self.last_sample = None;
        self.eligible = false;
        // A wake or focus change gets a fresh load grace, without replenishing
        // either the reload or rebuild budget.
        if self.reload_pending_since.is_some() {
            self.reload_pending_since = Some(now);
        }
    }

    pub fn observe(&mut self, now: Duration, sample: Option<&RenderHeartbeat>) {
        let Some(sample) = sample else {
            self.pause(now);
            return;
        };
        let focused = self.window.focused && sample.focused;
        if self.document != Some(sample.document_epoch_ms)
            || self.focused != focused
            || self
                .last_sample
                .is_some_and(|last| now.saturating_sub(last) > SAMPLE_GAP)
        {
            self.pause(now);
        }
        self.document = Some(sample.document_epoch_ms);
        self.focused = focused;
        self.last_sample = Some(now);
        self.eligible = self.window.visible && sample.visible && sample.content_page;
        if !sample.content_page {
            self.reload_pending_since = None;
        }
        if !self.eligible {
            self.stalled_since = None;
            self.healthy_since = None;
            return;
        }
        match sample.state {
            RenderSignal::Ok => {
                self.stalled_since = None;
                self.reload_pending_since = None;
                let since = self.healthy_since.get_or_insert(now);
                if now.saturating_sub(*since) >= HEALTHY_RESET {
                    self.reload_attempted = false;
                    self.budget.refund();
                    self.exhausted_reported = false;
                }
            }
            RenderSignal::Stalled => {
                self.healthy_since = None;
                self.stalled_since.get_or_insert(now);
            }
            RenderSignal::Pending | RenderSignal::Unknown => {
                self.stalled_since = None;
                self.healthy_since = None;
            }
        }
    }

    /// Some(Wait) keeps other watchdog branches from spending a fresh reload
    /// budget while a frame-recovery reload is pending or its budget is spent.
    pub fn action(&self, now: Duration, protected: bool) -> Option<RenderAction> {
        let recovering = self.reload_attempted || self.budget.used();
        let waiting = recovering.then_some(RenderAction::Wait);
        if self.budget.used()
            && self.window.visible
            && self.document.is_none()
            && now >= RELOAD_GRACE
            && !self.exhausted_reported
        {
            return Some(RenderAction::Exhausted);
        }
        if !self.window.visible || (!self.eligible && self.reload_pending_since.is_none()) {
            return waiting;
        }
        let stalled = self.stalled_since.is_some_and(|since| {
            now.saturating_sub(since)
                >= if self.focused {
                    FOCUSED_STALL
                } else {
                    UNFOCUSED_STALL
                }
        });
        let reload_timed_out = self
            .reload_pending_since
            .is_some_and(|since| now.saturating_sub(since) >= RELOAD_GRACE);
        let recovery_went_silent = recovering
            && self
                .last_sample
                .is_some_and(|last| now.saturating_sub(last) >= RELOAD_GRACE);
        if !stalled && !reload_timed_out && !recovery_went_silent {
            return waiting;
        }
        // Before the first attempt, stale page evidence belongs to the usual
        // unresponsive-renderer watchdog. Afterwards a missing heartbeat must
        // not disguise a reload that failed to recover the page.
        if !recovering
            && self
                .last_sample
                .is_none_or(|last| now.saturating_sub(last) > SAMPLE_GAP)
        {
            return None;
        }
        if protected {
            return Some(RenderAction::Protected);
        }
        if self.budget.used() {
            return Some(if self.exhausted_reported {
                RenderAction::Wait
            } else {
                RenderAction::Exhausted
            });
        }
        if self.reload_pending_since.is_some() && !reload_timed_out {
            return Some(RenderAction::Wait);
        }
        Some(if self.reload_attempted {
            RenderAction::Rebuild
        } else {
            RenderAction::Reload
        })
    }

    pub fn reload_started(&mut self, now: Duration) {
        self.reload_attempted = true;
        self.reload_pending_since = Some(now);
        self.stalled_since = None;
        self.healthy_since = None;
    }

    pub fn exhausted(&mut self) {
        self.exhausted_reported = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(state: RenderSignal, focused: bool) -> RenderHeartbeat {
        RenderHeartbeat {
            state,
            focused,
            visible: true,
            content_page: true,
            wait_ms: 15_000,
            document_epoch_ms: 1,
            document_age_ms: 15_000,
        }
    }

    fn feed(recovery: &mut RenderRecovery, from: u64, to: u64, sample: &RenderHeartbeat) {
        for seconds in (from..=to).step_by(5) {
            recovery.observe(Duration::from_secs(seconds), Some(sample));
        }
    }

    fn visible(focused: bool) -> RenderWindowState {
        RenderWindowState {
            visible: true,
            focused,
        }
    }

    fn stalled(focused: bool) -> RenderRecovery {
        let mut recovery = RenderRecovery::default();
        recovery.window_changed(Duration::ZERO, visible(focused));
        feed(
            &mut recovery,
            0,
            120,
            &sample(RenderSignal::Stalled, focused),
        );
        recovery
    }

    #[test]
    fn focused_and_unfocused_windows_have_different_confirmation_periods() {
        for (focused, threshold) in [(true, 30), (false, 120)] {
            let mut recovery = RenderRecovery::default();
            recovery.window_changed(Duration::ZERO, visible(focused));
            let sample = sample(RenderSignal::Stalled, focused);
            feed(&mut recovery, 0, threshold - 5, &sample);
            assert_eq!(
                recovery.action(Duration::from_secs(threshold - 1), false),
                None
            );
            recovery.observe(Duration::from_secs(threshold), Some(&sample));
            assert_eq!(
                recovery.action(Duration::from_secs(threshold), false),
                Some(RenderAction::Reload)
            );
            assert_eq!(
                recovery.action(Duration::from_secs(threshold), true),
                Some(RenderAction::Protected)
            );
        }
    }

    #[test]
    fn focus_visibility_and_sampling_gaps_restart_confirmation() {
        let mut recovery = stalled(false);
        recovery.window_changed(Duration::from_secs(120), visible(true));
        let sample = sample(RenderSignal::Stalled, true);
        feed(&mut recovery, 120, 145, &sample);
        assert_eq!(recovery.action(Duration::from_secs(145), false), None);
        recovery.observe(Duration::from_secs(150), Some(&sample));
        assert_eq!(
            recovery.action(Duration::from_secs(150), false),
            Some(RenderAction::Reload)
        );
        recovery.window_changed(Duration::from_secs(150), RenderWindowState::default());
        assert_eq!(recovery.action(Duration::from_secs(150), false), None);
        recovery.window_changed(Duration::from_secs(155), visible(true));
        feed(&mut recovery, 155, 180, &sample);
        recovery.observe(Duration::from_secs(240), Some(&sample));
        assert_eq!(recovery.action(Duration::from_secs(240), false), None);
        feed(&mut recovery, 245, 270, &sample);
        assert_eq!(
            recovery.action(Duration::from_secs(270), false),
            Some(RenderAction::Reload)
        );
    }

    #[test]
    fn hidden_login_unknown_and_legacy_pages_cannot_trigger_frame_recovery() {
        for sample in [
            RenderHeartbeat {
                visible: false,
                ..sample(RenderSignal::Stalled, true)
            },
            RenderHeartbeat {
                content_page: false,
                ..sample(RenderSignal::Stalled, true)
            },
            sample(RenderSignal::Unknown, true),
            sample(RenderSignal::Pending, true),
        ] {
            let mut recovery = RenderRecovery::default();
            recovery.window_changed(Duration::ZERO, visible(true));
            feed(&mut recovery, 0, 300, &sample);
            assert_eq!(recovery.action(Duration::from_secs(300), false), None);
        }
        let legacy: RenderHeartbeat = serde_json::from_str(
            r#"{"state":"stalled","wait_ms":20000,"document_epoch_ms":1,"document_age_ms":20000,"visible":true,"focused":true}"#
        ).unwrap();
        assert!(!legacy.content_page);
    }

    #[test]
    fn reload_that_leaves_old_document_alive_escalates_once_despite_heartbeats() {
        let mut recovery = stalled(true);
        recovery.reload_started(Duration::from_secs(120));
        let sample = sample(RenderSignal::Stalled, true);
        feed(&mut recovery, 125, 175, &sample);
        assert_eq!(
            recovery.action(Duration::from_secs(175), false),
            Some(RenderAction::Wait)
        );
        recovery.observe(Duration::from_secs(180), Some(&sample));
        assert_eq!(
            recovery.action(Duration::from_secs(180), true),
            Some(RenderAction::Protected)
        );
        assert_eq!(
            recovery.action(Duration::from_secs(180), false),
            Some(RenderAction::Rebuild)
        );
    }

    #[test]
    fn missing_heartbeats_after_reload_do_not_spend_a_second_reload() {
        let mut recovery = stalled(true);
        recovery.reload_started(Duration::from_secs(120));
        recovery.pause(Duration::from_secs(121)); // Native navigation starts.
        assert_eq!(
            recovery.action(Duration::from_secs(180), false),
            Some(RenderAction::Wait)
        );
        assert_eq!(
            recovery.action(Duration::from_secs(181), false),
            Some(RenderAction::Rebuild)
        );
        assert_eq!(
            recovery.action(Duration::from_secs(181), true),
            Some(RenderAction::Protected)
        );
    }

    #[test]
    fn replacement_document_gets_grace_but_pending_is_not_success() {
        let mut recovery = stalled(true);
        recovery.reload_started(Duration::from_secs(120));
        let mut sample = sample(RenderSignal::Pending, true);
        sample.document_epoch_ms = 2;
        feed(&mut recovery, 125, 180, &sample);
        assert_eq!(
            recovery.action(Duration::from_secs(180), false),
            Some(RenderAction::Wait)
        );
        recovery.observe(Duration::from_secs(185), Some(&sample));
        assert_eq!(
            recovery.action(Duration::from_secs(185), false),
            Some(RenderAction::Rebuild)
        );
        sample.content_page = false; // Authentication redirect.
        recovery.observe(Duration::from_secs(190), Some(&sample));
        assert_eq!(
            recovery.action(Duration::from_secs(300), false),
            Some(RenderAction::Wait)
        );
    }

    #[test]
    fn rebuild_budget_survives_replacement_and_only_sustained_frames_rearm_it() {
        let budget = RenderRecoveryBudget::default();
        assert!(budget.claim());
        assert!(!budget.claim());
        let mut replacement = RenderRecovery::new(budget.clone());
        replacement.window_changed(Duration::ZERO, visible(true));
        let bad = sample(RenderSignal::Stalled, true);
        feed(&mut replacement, 0, 30, &bad);
        assert_eq!(
            replacement.action(Duration::from_secs(30), false),
            Some(RenderAction::Exhausted)
        );
        replacement.exhausted();
        assert_eq!(
            replacement.action(Duration::from_secs(30), false),
            Some(RenderAction::Wait)
        );
        let good = sample(RenderSignal::Ok, true);
        feed(&mut replacement, 35, 60, &good);
        assert!(!budget.claim());
        replacement.observe(Duration::from_secs(65), Some(&bad));
        feed(&mut replacement, 70, 125, &good);
        assert!(!budget.claim());
        replacement.observe(Duration::from_secs(130), Some(&good));
        assert!(!budget.used());
        feed(&mut replacement, 135, 165, &bad);
        assert_eq!(
            replacement.action(Duration::from_secs(165), false),
            Some(RenderAction::Reload)
        );
        assert!(!RenderRecoveryBudget::default().used());
    }

    #[test]
    fn abandoned_rebuild_refunds_only_the_rebuild_and_silent_replacement_stops() {
        let mut recovery = stalled(true);
        recovery.reload_started(Duration::from_secs(120));
        let budget = recovery.budget();
        assert!(budget.claim());
        budget.refund();
        feed(
            &mut recovery,
            125,
            180,
            &sample(RenderSignal::Stalled, true),
        );
        assert_eq!(
            recovery.action(Duration::from_secs(180), false),
            Some(RenderAction::Rebuild)
        );
        assert!(budget.claim());
        let mut replacement = RenderRecovery::new(budget);
        replacement.window_changed(Duration::ZERO, visible(false));
        assert_eq!(
            replacement.action(Duration::from_secs(60), false),
            Some(RenderAction::Exhausted)
        );
        replacement.exhausted();
        assert_eq!(
            replacement.action(Duration::from_secs(120), false),
            Some(RenderAction::Wait)
        );
    }
}
