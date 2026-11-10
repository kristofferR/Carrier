import type {
  MessengerAccountChange,
  MessengerAccountState,
  MessengerProfile,
  NotificationSound,
  Settings,
  SettingsChange,
  SoundOption,
  Status,
  ThemeInfo,
  UpdateInstallMode,
} from "./native-types";

/** Argument and result contracts for the trusted Settings window's commands. */
interface Commands {
  window_control: [{ action: "drag" | "close" }, null];
  get_settings: [undefined, Settings];
  update_setting: [{ change: SettingsChange }, Settings];
  reset_settings: [undefined, Settings];
  autostart_status: [undefined, Status | null];
  open_login_items: [undefined, null];
  list_themes: [undefined, ThemeInfo[]];
  add_theme: [undefined, string | null];
  remove_theme: [{ id: string }, null];
  open_themes_folder: [undefined, null];
  open_theme_guide: [undefined, null];
  list_fonts: [undefined, string[]];
  notification_sounds: [undefined, SoundOption[]];
  choose_notification_sound: [undefined, NotificationSound | null];
  preview_notification_sound: [{ sound: NotificationSound }, null];
  restart_app: [undefined, null];
  open_facebook_language: [undefined, null];
  send_test_notification: [undefined, string];
  open_log_folder: [undefined, null];
  open_custom_css: [undefined, null];
  messenger_account: [undefined, MessengerAccountState];
  set_messenger_account: [{ change: MessengerAccountChange }, MessengerAccountState];
  messenger_profile: [undefined, MessengerProfile];
  log_out: [undefined, null];
  copy_share_message: [undefined, null];
  open_github: [undefined, null];
  update_release_notes: [{ version: string }, string | null];
  update_install_mode: [undefined, UpdateInstallMode];
  discovered_update: [undefined, string | null];
  check_for_updates: [undefined, string];
  open_manual_update: [undefined, null];
  install_update: [undefined, string];
}

export function invoke<K extends keyof Commands>(
  command: K,
  ...args: Commands[K][0] extends undefined ? [] : [args: Commands[K][0]]
): Promise<Commands[K][1]> {
  const bridge = window.__TAURI_INTERNALS__!;
  return bridge.invoke(command, args[0]) as Promise<Commands[K][1]>;
}
