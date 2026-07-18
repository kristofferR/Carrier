/*
 * Ambient types for the injected environment: the Carrier settings snapshot
 * the Rust side pushes onto the page, the internal Tauri bridge, and the
 * `__carrier*` globals the injected scripts hang off `window` so the native
 * menus / other injected scripts can reach them.
 */

/**
 * Mirror of the Rust `Settings` struct (src-tauri/src/settings.rs), pushed to
 * the page as `window.__CARRIER_SETTINGS__` + a `carrier:settings` event. All
 * fields are optional because the page may run off a stale localStorage cache
 * (or none at all) before the first settings push lands.
 */
interface CarrierSettings {
  always_on_top?: boolean;
  show_tray?: boolean;
  start_to_tray?: boolean;
  autostart?: boolean;
  hide_on_close?: boolean;
  /** Internal one-time onboarding state; not exposed in Settings. */
  tray_notice_shown?: boolean;
  multi_instance?: boolean;
  spellcheck?: boolean;
  unread_badge?: boolean;
  /** "messages" (page-title total) or "conversations" (bold chat rows). */
  badge_mode?: "messages" | "conversations";
  /** "system", "light", or "dark". */
  theme?: "system" | "light" | "dark";
  menu_bar_only?: boolean;
  hide_menu_bar?: boolean;
  mute_notifications?: boolean;
  notification_sound?: boolean;
  hide_notification_preview?: boolean;
  hide_names_avatars?: boolean;
  system_emoji?: boolean;
  /** Pause video/GIF playback unless it follows a recent user interaction. */
  stop_media_autoplay?: boolean;
  /** Page zoom in percent (30–200; 100 = no zoom). */
  zoom?: number;
  global_hotkey?: boolean;
  block_telemetry?: boolean;
  /** Require Cmd+Enter (macOS) or Ctrl+Enter (elsewhere) to send. */
  send_with_accelerator?: boolean;
}

interface Window {
  /** Tauri's always-present internal IPC bridge (no `withGlobalTauri`). */
  __TAURI_INTERNALS__?: {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  };
  __CARRIER_SETTINGS__?: CarrierSettings;

  // panel.js
  __carrierToast?: (msg: string) => void;
  __carrierCheckUpdates?: () => void;
  __carrierToggleSettings?: () => void;
  __carrierToggleShortcuts?: () => void;

  // messenger.js — driven by the native menus (View ▸ Zoom, File ▸ New
  // Conversation, Dock/tray thread menus) and the dev-only mcp-bridge.
  __carrierZoomIn?: () => void;
  __carrierZoomOut?: () => void;
  __carrierZoomReset?: () => void;
  __carrierShortcuts?: Record<string, () => unknown>;
  __carrierToggleInfo?: () => boolean;
  __carrierOpenThread?: (href: string) => boolean;
  __carrierNotifyClick?: (id: number) => boolean;
  /** Auto-refresh nudge, called by the Notification bridge. */
  __carrierOnNotification?: () => void;
  /** Set while a getUserMedia call is live so auto-refresh never reloads mid-call. */
  __carrierInCall?: boolean;
}

interface XMLHttpRequest {
  /** Set by the telemetry blocker in open(), consumed in send(). */
  __carrierBlocked?: boolean;
}

interface Element {
  /** System-emoji feature: the native-glyph <span> shadowing this sprite. */
  __carrierSystemEmojiGlyph?: HTMLSpanElement;
  /** Fullscreen polyfill (only on WebViews without the real API). */
  webkitRequestFullscreen?: () => Promise<void>;
}

interface Document {
  /** Fullscreen polyfill (only on WebViews without the real API). */
  webkitExitFullscreen?: () => Promise<void>;
}
