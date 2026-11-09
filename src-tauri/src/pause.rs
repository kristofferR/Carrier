//! Pause notifications for a set time from the tray and Dock menus (Ref #348).
//!
//! A pause is an end time in settings, not a timer, so it survives restarts
//! and a pause that ended while Chatpane was closed is already over at launch.
//! "Until I turn them back on" is the existing `mute_notifications` setting.

use chrono::{DateTime, Datelike, Duration, Local, NaiveTime, TimeZone, Weekday};
use tauri::Manager;

use crate::i18n::{t, tf};
use crate::settings::{AppState, Settings};

/// "Until tomorrow morning" ends at this local hour.
const MORNING_HOUR: u32 = 8;

pub(crate) const PAUSE_HOUR_ID: &str = "pause:hour";
pub(crate) const PAUSE_MORNING_ID: &str = "pause:morning";
pub(crate) const PAUSE_OFF_ID: &str = "pause:off";
pub(crate) const PAUSE_RESUME_ID: &str = "pause:resume";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PauseChoice {
    OneHour,
    UntilMorning,
}

/// When a pause chosen at `now` ends. The morning is today's when it is still
/// ahead, otherwise tomorrow's. A morning that daylight saving skips ends an
/// hour later instead.
pub(crate) fn pause_end<Tz: TimeZone>(choice: PauseChoice, now: &DateTime<Tz>) -> DateTime<Tz> {
    match choice {
        PauseChoice::OneHour => now.clone() + Duration::hours(1),
        PauseChoice::UntilMorning => {
            let morning = NaiveTime::from_hms_opt(MORNING_HOUR, 0, 0).expect("valid time");
            let local = now.naive_local();
            let day = if local.time() < morning {
                local.date()
            } else {
                local.date() + Duration::days(1)
            };
            let tz = now.timezone();
            tz.from_local_datetime(&day.and_time(morning))
                .earliest()
                .or_else(|| {
                    tz.from_local_datetime(&(day.and_time(morning) + Duration::hours(1)))
                        .earliest()
                })
                .unwrap_or_else(|| now.clone() + Duration::hours(12))
        }
    }
}

pub(crate) fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

/// How notifications stand, for the menus and the delivery gates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PauseState {
    Active,
    PausedUntil(i64),
    Off,
}

pub(crate) fn pause_state(s: &Settings, now_ms: i64) -> PauseState {
    if s.mute_notifications {
        PauseState::Off
    } else {
        match s.notifications_paused_until {
            Some(until) if until > now_ms => PauseState::PausedUntil(until),
            _ => PauseState::Active,
        }
    }
}

/// "Paused until 14:30" today, "Paused until Tue 08:00" on another day.
fn paused_until_label<Tz: TimeZone>(until: &DateTime<Tz>, now: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let time = until.format("%H:%M").to_string();
    if until.date_naive() == now.date_naive() {
        return tf("pause.paused_until", &[("time", &time)]);
    }
    let weekday = match until.weekday() {
        Weekday::Mon => t("pause.weekday.monday"),
        Weekday::Tue => t("pause.weekday.tuesday"),
        Weekday::Wed => t("pause.weekday.wednesday"),
        Weekday::Thu => t("pause.weekday.thursday"),
        Weekday::Fri => t("pause.weekday.friday"),
        Weekday::Sat => t("pause.weekday.saturday"),
        Weekday::Sun => t("pause.weekday.sunday"),
    };
    tf(
        "pause.paused_until_day",
        &[("weekday", &weekday), ("time", &time)],
    )
}

/// One entry of the Pause Notifications submenu: (id, label, enabled).
pub(crate) type PauseEntry = (&'static str, String, bool);

/// The submenu title and its entries for the current state.
pub(crate) fn pause_menu(state: PauseState, now_ms: i64) -> (String, Vec<PauseEntry>) {
    let resume = (PAUSE_RESUME_ID, t("pause.resume").to_string(), true);
    match state {
        PauseState::Active => (
            t("pause.title").into(),
            vec![
                (PAUSE_HOUR_ID, t("pause.one_hour").into(), true),
                (PAUSE_MORNING_ID, t("pause.until_morning").into(), true),
                (PAUSE_OFF_ID, t("pause.until_turned_on").into(), true),
            ],
        ),
        PauseState::PausedUntil(until) => {
            let label = match (
                Local.timestamp_millis_opt(until).single(),
                Local.timestamp_millis_opt(now_ms).single(),
            ) {
                (Some(until), Some(now)) => paused_until_label(&until, &now),
                _ => t("pause.paused").into(),
            };
            (
                t("pause.title_paused").into(),
                vec![("pause:status", label, false), resume],
            )
        }
        PauseState::Off => (
            t("pause.title_off").into(),
            vec![
                ("pause:status", t("pause.off_until_turned_on").into(), false),
                resume,
            ],
        ),
    }
}

/// Apply a Pause Notifications menu choice. Returns false for other ids.
pub(crate) fn handle_pause_menu_event(app: &tauri::AppHandle, id: &str) -> bool {
    let choice = match id {
        PAUSE_HOUR_ID => Some(PauseChoice::OneHour),
        PAUSE_MORNING_ID => Some(PauseChoice::UntilMorning),
        PAUSE_OFF_ID | PAUSE_RESUME_ID => None,
        _ => return false,
    };
    let until = choice.map(|choice| pause_end(choice, &Local::now()).timestamp_millis());
    let mute = id == PAUSE_OFF_ID;
    // Applying the saved settings starts the expiry watch (see apply_settings).
    crate::menu::mutate_settings(app, move |s| {
        s.notifications_paused_until = until;
        s.mute_notifications = mute;
    });
    true
}

/// Refresh the menus when a pause ends, so they stop saying "Paused until".
/// Delivery needs no timer: the gates compare the end time with the clock.
/// The wait is checked against the wall clock in short steps, because a
/// sleeping computer or a clock change would throw off one long timer.
pub(crate) fn schedule_pause_expiry(app: &tauri::AppHandle, until: i64) {
    use std::sync::atomic::{AtomicI64, Ordering};
    const STEP_MS: i64 = 30_000;
    // Settings are applied often; one watcher per pause end. A watcher that
    // stops releases its claim, so pausing again to the same time (twice
    // "until morning") gets a new one.
    static WATCHED: AtomicI64 = AtomicI64::new(i64::MIN);
    if WATCHED.swap(until, Ordering::SeqCst) == until {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let paused_until = || {
            app.state::<AppState>()
                .settings
                .lock()
                .unwrap()
                .notifications_paused_until
        };
        loop {
            if paused_until() != Some(until) {
                let _ =
                    WATCHED.compare_exchange(until, i64::MIN, Ordering::SeqCst, Ordering::SeqCst);
                // A re-pause to this same time may have arrived between the
                // read and the release, and found the claim still held.
                if paused_until() == Some(until)
                    && WATCHED
                        .compare_exchange(i64::MIN, until, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                {
                    continue;
                }
                return;
            }
            let wait = until - now_ms();
            if wait <= 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(wait.min(STEP_MS) as u64)).await;
        }
        let _ = WATCHED.compare_exchange(until, i64::MIN, Ordering::SeqCst, Ordering::SeqCst);
        let main = app.clone();
        let _ = app.run_on_main_thread(move || crate::menu::rebuild_recent_menus(&main));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn at(hour: u32, minute: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(3600)
            .unwrap()
            .with_ymd_and_hms(2026, 11, 7, hour, minute, 0)
            .unwrap()
    }

    #[test]
    fn one_hour_ends_an_hour_later() {
        assert_eq!(
            pause_end(PauseChoice::OneHour, &at(23, 30)),
            at(23, 30) + Duration::hours(1)
        );
    }

    #[test]
    fn morning_is_tomorrow_after_eight_and_today_before() {
        let tomorrow = at(8, 0) + Duration::days(1);
        assert_eq!(pause_end(PauseChoice::UntilMorning, &at(14, 0)), tomorrow);
        assert_eq!(pause_end(PauseChoice::UntilMorning, &at(8, 0)), tomorrow);
        assert_eq!(pause_end(PauseChoice::UntilMorning, &at(23, 59)), tomorrow);
        assert_eq!(pause_end(PauseChoice::UntilMorning, &at(2, 0)), at(8, 0));
    }

    #[test]
    fn a_pause_that_ended_while_closed_is_over() {
        let mut s = Settings {
            notifications_paused_until: Some(1_000),
            ..Default::default()
        };
        assert_eq!(pause_state(&s, 999), PauseState::PausedUntil(1_000));
        assert_eq!(pause_state(&s, 1_000), PauseState::Active);
        s.mute_notifications = true;
        assert_eq!(pause_state(&s, 0), PauseState::Off);
    }

    #[test]
    fn menu_offers_pauses_when_active_and_resume_when_paused() {
        let (title, entries) = pause_menu(PauseState::Active, 0);
        assert_eq!(title, "Pause Notifications");
        let ids: Vec<_> = entries.iter().map(|(id, _, _)| *id).collect();
        assert_eq!(ids, [PAUSE_HOUR_ID, PAUSE_MORNING_ID, PAUSE_OFF_ID]);

        let now = now_ms();
        let (title, entries) = pause_menu(PauseState::PausedUntil(now + 60_000), now);
        assert_eq!(title, "Notifications Paused");
        assert!(entries[0].1.starts_with("Paused until "));
        assert!(!entries[0].2, "the status line is not clickable");
        assert_eq!(entries[1].0, PAUSE_RESUME_ID);

        let (_, entries) = pause_menu(PauseState::Off, now);
        assert_eq!(entries.last().unwrap().0, PAUSE_RESUME_ID);
    }
}
