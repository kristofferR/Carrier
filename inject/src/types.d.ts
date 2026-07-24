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
  /** Linux tray artwork: the full-color icon or a panel-tinted glyph. */
  tray_icon_style?: "color" | "symbolic";
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
  hide_on_minimize?: boolean;
  hide_on_focus_loss?: boolean;
  hide_taskbar_icon?: boolean;
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
  /** Strip Facebook attribution parameters from copied and externally opened links. */
  strip_link_tracking?: boolean;
  /** Require Cmd+Enter (macOS) or Ctrl+Enter (elsewhere) to send. */
  send_with_accelerator?: boolean;
}

interface CarrierToastAction {
  label: string;
  kind: "reveal-download";
  url: string;
}

/**
 * Closure-scoped bridge supplied by the Rust initialization wrapper. It holds
 * the native reveal authorization and is deliberately not a Window property.
 */
declare const carrierRevealDownload: (url: string) => Promise<unknown> | undefined;

interface Window {
  /** Tauri's always-present internal IPC bridge (no `withGlobalTauri`). */
  __TAURI_INTERNALS__?: {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  };
  __CARRIER_SETTINGS__?: CarrierSettings;
  /** Native watchdog generation baked into this Messenger window. */
  __CARRIER_HEARTBEAT_ID__?: number;

  // panel.js
  __carrierToast?: (msg: string, action?: CarrierToastAction) => void;
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
  /** Temporarily resume encrypted-history indexing for conversation search. */
  __carrierWakeSearchIndex?: () => void;
  __CARRIER_WORKER_OPTIMIZATION__?: {
    responsivenessWorkersStopped: number;
  };
  __carrierNotifyClick?: (id: number) => boolean;
  /** Deliver a KDE notification reply without raising the Carrier window. */
  __carrierQuickReply?: (path: string, text: string, id: number, attempt: number) => void;
  /** Preserve a failed notification reply as an unsent composer draft. */
  __carrierQuickReplyDraft?: (path: string, text: string, id: number, attempt: number) => void;
  /** Auto-refresh nudge, called by the Notification bridge. */
  __carrierOnNotification?: () => void;
  /** Set while a getUserMedia call is live so auto-refresh never reloads mid-call. */
  __carrierInCall?: boolean;
  /** Respond to the native renderer watchdog without exposing page content. */
  __carrierHeartbeat?: (expectedId: number) => void;
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
