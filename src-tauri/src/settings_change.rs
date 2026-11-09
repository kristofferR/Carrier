//! Changes from Settings, applied to the latest snapshot inside the settings worker.

use crate::settings::{
    BadgeMode, DownloadBehavior, NicknameScope, Settings, ThemeChoice, TrayIconStyle,
};
use crate::sound::NotificationSound;

macro_rules! setting_changes {
    ($($variant:ident => $field:ident: $value:ty),* $(,)?) => {
        #[derive(Debug, serde::Deserialize)]
        #[cfg_attr(test, derive(ts_rs::TS))]
        #[serde(tag = "key", content = "value", rename_all = "snake_case", deny_unknown_fields)]
        pub(crate) enum SettingsChange {
            $($variant($value),)*
            /// Derive the dark icon from the current light icon in the same transaction.
            AppIconDarkMode(bool),
        }

        impl SettingsChange {
            pub(crate) fn apply(self, mut settings: Settings) -> Settings {
                match self {
                    $(Self::$variant(value) => settings.$field = value,)*
                    Self::AppIconDarkMode(enabled) => {
                        settings.app_icon_dark = if enabled {
                            settings.app_icon.replace("-light", "-dark")
                        } else {
                            String::new()
                        };
                    }
                }
                settings
            }
        }
    };
}

// Internal flags, usage and pane widths have their own native owners.
setting_changes! {
    AlwaysOnTop => always_on_top: bool,
    ShowTray => show_tray: bool,
    TrayIconStyle => tray_icon_style: TrayIconStyle,
    StartToTray => start_to_tray: bool,
    Autostart => autostart: bool,
    HideOnClose => hide_on_close: bool,
    MultiInstance => multi_instance: bool,
    Spellcheck => spellcheck: bool,
    UnreadBadge => unread_badge: bool,
    BadgeMode => badge_mode: BadgeMode,
    MutedConversations => muted_conversations: Option<String>,
    Theme => theme: ThemeChoice,
    ColorTheme => color_theme: String,
    AccentColor => accent_color: String,
    MessageFont => message_font: String,
    AppIcon => app_icon: String,
    AppIconDark => app_icon_dark: String,
    MenuBarOnly => menu_bar_only: bool,
    HideMenuBar => hide_menu_bar: bool,
    HideOnMinimize => hide_on_minimize: bool,
    HideOnFocusLoss => hide_on_focus_loss: bool,
    HideTaskbarIcon => hide_taskbar_icon: bool,
    MuteNotifications => mute_notifications: bool,
    AutomaticUpdateChecks => automatic_update_checks: bool,
    UpdateCheckHours => update_check_hours: u32,
    NotificationSoundChoice => notification_sound_choice: Option<NotificationSound>,
    HideNotificationPreview => hide_notification_preview: bool,
    NotifyGroupChats => notify_group_chats: bool,
    NotifyReactions => notify_reactions: bool,
    NotificationReaction => notification_reaction: String,
    GroupNotificationsByConversation => group_notifications_by_conversation: bool,
    ClearNotificationsOnView => clear_notifications_on_view: bool,
    AttentionOnMessage => attention_on_message: bool,
    HideNames => hide_names: Option<bool>,
    HideAvatars => hide_avatars: Option<bool>,
    NicknameScope => nickname_scope: Option<NicknameScope>,
    SystemEmoji => system_emoji: bool,
    StopMediaAutoplay => stop_media_autoplay: bool,
    FocusComposerOnReturn => focus_composer_on_return: bool,
    BlockTypingIndicator => block_typing_indicator: bool,
    Zoom => zoom: i32,
    GlobalHotkey => global_hotkey: bool,
    BlockTelemetry => block_telemetry: bool,
    StripLinkTracking => strip_link_tracking: bool,
    SendWithAccelerator => send_with_accelerator: bool,
    DownloadBehavior => download_behavior: DownloadBehavior,
    HoldFailures => hold_failures: bool,
    Language => language: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_preserve_other_writers_and_native_owned_state() {
        // Native writers changed these after the Settings window loaded.
        let latest = Settings {
            always_on_top: true,
            zoom: 140,
            pane_widths: crate::pane_widths::PaneWidths {
                list: Some(360),
                details: None,
            },
            tray_notice_shown: true,
            ..Settings::default()
        };
        let before = serde_json::to_value(&latest).unwrap();
        let change: SettingsChange = serde_json::from_value(serde_json::json!({
            "key": "spellcheck", "value": true,
        }))
        .unwrap();
        let next = change.apply(latest);
        let mut expected = before;
        expected["spellcheck"] = true.into();
        assert_eq!(serde_json::to_value(next).unwrap(), expected);
    }

    #[test]
    fn dark_mode_uses_the_latest_icon_and_can_be_disabled() {
        let latest = Settings {
            app_icon: "mono-light".into(),
            ..Settings::default()
        };
        let next = SettingsChange::AppIconDarkMode(true).apply(latest);
        assert_eq!(next.app_icon_dark, "mono-dark");
        assert_eq!(
            SettingsChange::AppIconDarkMode(false)
                .apply(next)
                .app_icon_dark,
            ""
        );
    }

    #[test]
    fn changes_reject_wrong_types_and_native_owned_fields() {
        for value in [
            serde_json::json!({"key": "spellcheck", "value": "true"}),
            serde_json::json!({"key": "theme", "value": "sepia"}),
            serde_json::json!({"key": "pane_widths", "value": {"list": 300}}),
            serde_json::json!({"key": "usage", "value": {}}),
            serde_json::json!({"key": "tray_notice_shown", "value": false}),
            serde_json::json!({"key": "zoom", "value": 110, "spellcheck": true}),
        ] {
            assert!(serde_json::from_value::<SettingsChange>(value).is_err());
        }
    }
}
