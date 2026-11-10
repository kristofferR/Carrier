// GENERATED from Rust wire types. Do not edit.
// Regenerate: bun run build:settings-types

export type ThemeChoice = "system" | "light" | "dark";

export type BadgeMode = "messages" | "conversations" | "dot";

export type TrayIconStyle = "color" | "symbolic";

export type DownloadBehavior = "downloads" | "ask";

export type NicknameScope = "all" | "direct" | "groups" | "off";

export type PaneWidths = { list: number | null, details: number | null, };

export type Usage = { 
/**
 * Local calendar days (days since 0001-01-01) of the first and latest use.
 */
first_day: number | null, last_day: number | null, 
/**
 * Distinct days with a recorded use.
 */
days: number, 
/**
 * The prompt was shown; it is never shown again.
 */
star_prompt_done: boolean, };

export type NotificationSound = "off" | "default" | { "system": { platform: string, name: string, } } | { "file": string };

export type Settings = { always_on_top: boolean, show_tray: boolean, tray_icon_style: TrayIconStyle, start_to_tray: boolean, autostart: boolean, hide_on_close: boolean, 
/**
 * Whether the one-time "still running in the tray" close notice has been
 * shown. Persisted internally; it is not an end-user preference.
 */
tray_notice_shown: boolean, 
/**
 * Experimental: when true, single-instance enforcement is skipped at the
 * next launch (takes effect after restart).
 */
multi_instance: boolean, spellcheck: boolean, 
/**
 * Show the unread count on the Dock/taskbar icon.
 */
unread_badge: boolean, badge_mode: BadgeMode, 
/**
 * Skip Dock/taskbar badges and native notifications for conversations the
 * user has muted in Messenger. Legacy; `muted_conversations` wins when set.
 */
ignore_muted_conversations: boolean, 
/**
 * Muted conversations: "ignore" (no badge, no notification), "badge"
 * (badge only) or "include". None keeps `ignore_muted_conversations`.
 */
muted_conversations: string | null, theme: ThemeChoice, 
/**
 * The color theme on top of light/dark: a built-in id or an imported
 * theme's id (see themes.rs). "default" is Messenger's own look.
 */
color_theme: string, 
/**
 * Accent color as "#rrggbb", or empty to use the theme's own accent.
 */
accent_color: string, 
/**
 * Font family for messages and the conversation list; empty = default.
 */
message_font: string, 
/**
 * The app icon: one of [`crate::app_icon::APP_ICONS`]. "color-light" is
 * the installed icon.
 */
app_icon: string, 
/**
 * The app icon while Messenger is dark, from the same set; empty uses
 * `app_icon` in both.
 */
app_icon_dark: string, 
/**
 * macOS: run as a menu-bar app with no Dock icon (requires the tray).
 */
menu_bar_only: boolean, 
/**
 * Windows/Linux: hide the native application menu from Messenger windows.
 */
hide_menu_bar: boolean, 
/**
 * Windows: hide the main window into the tray when it is minimized.
 */
hide_on_minimize: boolean, 
/**
 * Windows: hide the main window into the tray when it loses focus.
 */
hide_on_focus_loss: boolean, 
/**
 * Windows: omit the main window from the taskbar. This is only applied
 * while a tray icon exists so the app always remains reachable.
 */
hide_taskbar_icon: boolean, 
/**
 * Suppress all desktop notifications for new messages.
 */
mute_notifications: boolean, 
/**
 * Notifications are paused until this time (milliseconds since 1970),
 * set from the tray or Dock menu. An end time rather than a timer, so a
 * pause survives restarts and one that ended while Chatpane was closed is
 * already over.
 */
notifications_paused_until: number | null, 
/**
 * Discover signed Chatpane updates on startup and then every
 * `update_check_hours`. This never downloads or installs without explicit
 * confirmation in Settings.
 */
automatic_update_checks: boolean, 
/**
 * Hours between automatic update checks: 1, 4 (default) or 24.
 */
update_check_hours: number, 
/**
 * Notifications play a sound. Follows `notification_sound_choice` once
 * that is set; the page and older builds read only this switch.
 */
notification_sound: boolean, 
/**
 * The notification sound (Ref #363). None keeps `notification_sound`.
 */
notification_sound_choice: NotificationSound | null, 
/**
 * Notify without the sender name or message text (privacy).
 */
hide_notification_preview: boolean, 
/**
 * Notify for messages in group chats. Off leaves group messages to the
 * unread badge. On by default.
 */
notify_group_chats: boolean, 
/**
 * Notify when someone reacts to a message you sent. On by default.
 */
notify_reactions: boolean, 
/**
 * The reaction a notification's React button adds: one of Messenger's
 * six default reactions (`notifications::REACTIONS`). 👍 by default.
 */
notification_reaction: string, 
/**
 * macOS: stack Notification Center entries by Messenger conversation.
 */
group_notifications_by_conversation: boolean, 
/**
 * macOS/Windows: clear a conversation's delivered notifications (Action
 * Center toasts on Windows) when it is viewed or replied to inline.
 */
clear_notifications_on_view: boolean, 
/**
 * Ask the desktop for user attention when an unfocused message arrives.
 * macOS uses a Dock bounce; the platform-neutral name is shared with the
 * corresponding Windows taskbar behavior.
 */
attention_on_message: boolean, 
/**
 * Blur contact names and avatars (for screen-sharing / public spaces).
 * The combined switch from before names and avatars were separate; the
 * two settings below win once set.
 */
hide_names_avatars: boolean, 
/**
 * Blur contact names. None keeps `hide_names_avatars`.
 */
hide_names: boolean | null, 
/**
 * Blur avatars and read-receipt faces. None keeps `hide_names_avatars`.
 */
hide_avatars: boolean | null, 
/**
 * Explicit scope takes precedence; None retains the legacy two-toggle preference.
 */
nickname_scope: NicknameScope | null, 
/**
 * Legacy nickname preferences, retained so existing installs keep their behavior.
 */
show_nicknames: boolean, 
/**
 * Restrict nickname presentation to group chats when nicknames are enabled.
 */
nicknames_group_only: boolean, 
/**
 * Render Facebook emoji sprites as native system emoji glyphs.
 */
system_emoji: boolean, 
/**
 * Pause videos and animated media that start without a recent user
 * interaction. Manual playback remains available. Off by default.
 */
stop_media_autoplay: boolean, 
/**
 * Focus the message box when the window comes back to the front with a
 * conversation open and nothing else focused. On by default.
 */
focus_composer_on_return: boolean, 
/**
 * Never send the "typing…" indicator to others. Seeing theirs is
 * unaffected. Off by default.
 */
block_typing_indicator: boolean, 
/**
 * Page zoom in percent (clamped to 30–200; 100 = no zoom).
 */
zoom: number, 
/**
 * Dragged chat list and details pane widths, reported by the page.
 */
pane_widths: PaneWidths, 
/**
 * Days of use and the one-time star prompt (growth.rs). Internal state.
 */
usage: Usage, 
/**
 * Global summon hotkey (Cmd/Ctrl+Shift+M): show or hide Chatpane from
 * anywhere. Off by default so it can't clash with other apps' shortcuts.
 */
global_hotkey: boolean, 
/**
 * Block Facebook's analytics/logging requests (banzai, quick metrics,
 * error reporting) in the page. Never touches messaging endpoints.
 */
block_telemetry: boolean, 
/**
 * Remove Facebook attribution parameters from links copied from Messenger
 * or opened in the system browser.
 */
strip_link_tracking: boolean, 
/**
 * Require Cmd+Enter on macOS or Ctrl+Enter elsewhere to send a message.
 * Plain Enter inserts a line break. Off by default.
 */
send_with_accelerator: boolean, download_behavior: DownloadBehavior, 
/**
 * Keep broken webviews intact for live inspection. Manual reload still works.
 */
hold_failures: boolean, 
/**
 * Chatpane's own UI language: "system" follows the OS, or a code from
 * `i18n::LANGUAGES`. Applies on the next launch.
 */
language: string, };

export type SettingsChange = { "key": "always_on_top", "value": boolean } | { "key": "show_tray", "value": boolean } | { "key": "tray_icon_style", "value": TrayIconStyle } | { "key": "start_to_tray", "value": boolean } | { "key": "autostart", "value": boolean } | { "key": "hide_on_close", "value": boolean } | { "key": "multi_instance", "value": boolean } | { "key": "spellcheck", "value": boolean } | { "key": "unread_badge", "value": boolean } | { "key": "badge_mode", "value": BadgeMode } | { "key": "muted_conversations", "value": string | null } | { "key": "theme", "value": ThemeChoice } | { "key": "color_theme", "value": string } | { "key": "accent_color", "value": string } | { "key": "message_font", "value": string } | { "key": "app_icon", "value": string } | { "key": "app_icon_dark", "value": string } | { "key": "menu_bar_only", "value": boolean } | { "key": "hide_menu_bar", "value": boolean } | { "key": "hide_on_minimize", "value": boolean } | { "key": "hide_on_focus_loss", "value": boolean } | { "key": "hide_taskbar_icon", "value": boolean } | { "key": "mute_notifications", "value": boolean } | { "key": "automatic_update_checks", "value": boolean } | { "key": "update_check_hours", "value": number } | { "key": "notification_sound_choice", "value": NotificationSound | null } | { "key": "hide_notification_preview", "value": boolean } | { "key": "notify_group_chats", "value": boolean } | { "key": "notify_reactions", "value": boolean } | { "key": "notification_reaction", "value": string } | { "key": "group_notifications_by_conversation", "value": boolean } | { "key": "clear_notifications_on_view", "value": boolean } | { "key": "attention_on_message", "value": boolean } | { "key": "hide_names", "value": boolean | null } | { "key": "hide_avatars", "value": boolean | null } | { "key": "nickname_scope", "value": NicknameScope | null } | { "key": "system_emoji", "value": boolean } | { "key": "stop_media_autoplay", "value": boolean } | { "key": "focus_composer_on_return", "value": boolean } | { "key": "block_typing_indicator", "value": boolean } | { "key": "zoom", "value": number } | { "key": "global_hotkey", "value": boolean } | { "key": "block_telemetry", "value": boolean } | { "key": "strip_link_tracking", "value": boolean } | { "key": "send_with_accelerator", "value": boolean } | { "key": "download_behavior", "value": DownloadBehavior } | { "key": "hold_failures", "value": boolean } | { "key": "language", "value": string } | { "key": "app_icon_dark_mode", "value": boolean };

export type RuntimeCapabilities = { snap: boolean, autostart: boolean, automaticUpdateChecks: boolean, multiInstance: boolean, debug: boolean, };

export type SettingsBoot = { settings: Settings, capabilities: RuntimeCapabilities, version: string, 
/**
 * None until startup has found it; the page then asks.
 */
install_mode: UpdateInstallMode | null, discovered_update: string | null, };

export type Status = "on" | "off" | "needs-approval";

export type ThemeMode = "light" | "dark";

export type ThemeInfo = { id: string, name: string, author: string | null, mode: ThemeMode | null, preview: [string, string, string, string, string] | null, builtIn: boolean, };

export type SoundOption = { label: string, sound: NotificationSound, };

export type MessengerAccountState = { activeStatus: boolean | null, sounds: boolean | null, 
/**
 * Do Not Disturb end in seconds since 1970: 0 off, -1 until turned off.
 */
dndUntil: number | null, 
/**
 * Whether people see when you've read their messages, and you theirs.
 */
readReceipts: boolean | null, };

export type MessengerAccountChange = { "setting": "activeStatus", "value": boolean } | { "setting": "sounds", "value": boolean } | { "setting": "doNotDisturb", "value": number } | { "setting": "readReceipts", "value": boolean };

export type UpdateInstallKind = "built-in" | "manual" | "debug";

export type UpdateInstallMode = { kind: UpdateInstallKind, buttonLabel: string | null, instructions: string | null, };
