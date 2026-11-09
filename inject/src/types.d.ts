/*
 * Ambient types for the injected environment: the Chatpane settings snapshot
 * the Rust side pushes onto the page, the internal Tauri bridge, and the
 * `__chatpane*` globals the injected scripts hang off `window` so the native
 * menus / other injected scripts can reach them.
 */

/**
 * Mirror of the Rust `Settings` struct (src-tauri/src/settings.rs), pushed to
 * the page as `window.__CHATPANE_SETTINGS__` + a `chatpane:settings` event. All
 * fields are optional because the page may run off a stale localStorage cache
 * (or none at all) before the first settings push lands.
 */
interface ChatpaneSettings {
  hold_failures?: boolean;
  always_on_top?: boolean;
  show_tray?: boolean;
  /** macOS/Linux tray artwork: the full-color icon or a monochrome glyph. */
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
  badge_mode?: "messages" | "conversations" | "dot";
  /** Skip badge and native notifications for Facebook-muted conversations. */
  ignore_muted_conversations?: boolean;
  /** "ignore", "badge" (badge only) or "include"; absent on older installs. */
  muted_conversations?: "ignore" | "badge" | "include" | null;
  /** "system", "light", or "dark". */
  theme?: "system" | "light" | "dark";
  menu_bar_only?: boolean;
  hide_menu_bar?: boolean;
  /** Linux only: "auto" hides the title bar in tiled windows. */
  title_bar?: "auto" | "show" | "hide";
  hide_on_minimize?: boolean;
  hide_on_focus_loss?: boolean;
  hide_taskbar_icon?: boolean;
  mute_notifications?: boolean;
  /** Notifications paused from the tray or Dock menu until this time (ms since 1970). */
  notifications_paused_until?: number | null;
  notification_sound?: boolean;
  hide_notification_preview?: boolean;
  /** Notify for group-chat messages too (the badge counts them either way). */
  notify_group_chats?: boolean;
  group_notifications_by_conversation?: boolean;
  clear_notifications_on_view?: boolean;
  attention_on_message?: boolean;
  hide_names_avatars?: boolean;
  /** Blur names; absent (null) keeps hide_names_avatars. */
  hide_names?: boolean | null;
  /** Blur avatars; absent (null) keeps hide_names_avatars. */
  hide_avatars?: boolean | null;
  nickname_scope?: "all" | "direct" | "groups" | "off" | null;
  show_nicknames?: boolean;
  nicknames_group_only?: boolean;
  system_emoji?: boolean;
  /** Never tell others you are typing (regular and encrypted chats). */
  block_typing_indicator?: boolean;
  /** Pause video/GIF playback unless it follows a recent user interaction. */
  stop_media_autoplay?: boolean;
  /** Page zoom in percent (30–200; 100 = no zoom). */
  zoom?: number;
  /** Dragged widths of the chat list and details panes in CSS px; null is Facebook's. */
  pane_widths?: { list?: number | null; details?: number | null } | null;
  global_hotkey?: boolean;
  block_telemetry?: boolean;
  /** Strip Facebook attribution parameters from copied and externally opened links. */
  strip_link_tracking?: boolean;
  /** Put the cursor in the message box when the window comes back to the front. */
  focus_composer_on_return?: boolean;
  /** Require Cmd+Enter (macOS) or Ctrl+Enter (elsewhere) to send. */
  send_with_accelerator?: boolean;
  /** Save automatically to Downloads, or open a native save dialog first. */
  download_behavior?: "downloads" | "ask";
}

type ChatpaneToastAction =
  | { label: string; kind: "reveal-download"; url: string }
  | { label: string; kind: "open-download-privacy" }
  | { label: string; kind: "star-github" };

interface ChatpaneToastOptions {
  warning?: boolean;
  /** Visible time in ms (hovering pauses it). */
  duration?: number;
  /** Show a close button. */
  closable?: boolean;
  /** Distance from the window bottom in px. */
  bottom?: number;
}

/**
 * Closure-scoped bridge supplied by the Rust initialization wrapper. It signs
 * the request without serializing its non-extractable native authorization.
 */
declare const chatpaneRevealDownload: (url: string) => Promise<unknown> | undefined;
/** Opens the OS settings pane that grants Chatpane folder access (macOS). */
declare const chatpaneOpenDownloadPrivacy: () => Promise<unknown> | undefined;
/** Reports the star toast to native code (growth.rs). */
declare const chatpaneStarPrompt: (action: "shown" | "star") => Promise<unknown> | undefined;
declare const chatpaneWindowControl: (
  action: "minimize" | "toggle-maximize" | "close" | "drag",
) => Promise<unknown> | undefined;
declare const chatpaneMediaViewer: (open: boolean) => Promise<unknown> | undefined;
declare const chatpaneScheduledSend: (
  request: import("./messenger/lib/scheduled-send").ScheduleRequest,
) => Promise<import("./messenger/lib/scheduled-send").ScheduleResponse>;

declare const chatpaneMediaPlatform: "macos" | "windows" | "linux";
type ChatpaneMediaPermissionState =
  | "unknown"
  | "not-determined"
  | "restricted"
  | "denied"
  | "allowed";
type ChatpaneMediaPermissionSnapshot = Record<
  "camera" | "microphone",
  ChatpaneMediaPermissionState
>;
declare const chatpaneMediaPermissionStatus: (
  device?: "camera" | "microphone",
) => Promise<ChatpaneMediaPermissionSnapshot>;
declare const chatpaneOpenMediaPrivacy: (device: "camera" | "microphone") => Promise<void>;

/** Claim a selected native context action before starting its asynchronous work. */
declare const chatpaneClaimContextAction: (action: string) => Promise<unknown>;

/** Reserve the exact blob URL produced by a claimed native share action. */
declare const chatpanePrepareDownload: (action: string, url: string) => Promise<unknown>;

/** Ask the native shell to reserve a user-selected path for this download. */
declare const chatpaneChooseDownload: (url: string, name: string) => Promise<unknown>;

/**
 * Ask the native shell to render and save a conversation export where the user
 * chooses. Rejects with "export cancelled" when the save dialog is dismissed.
 * `reveal` is an opaque key the toast's reveal action can use afterwards.
 */
declare const chatpaneExportConversation: (payload: {
  format: "html" | "json";
  conversation: import("./messenger/lib/conversation-export").ConversationExport;
  reveal: string;
}) => Promise<void>;

/**
 * Same closure-scoped credential, second action: open the macOS share sheet
 * for a just-downloaded file, anchored at viewport fractions (0..1 top-left).
 */
declare const chatpaneShareDownload: (
  downloadId: string,
  x: number,
  y: number,
  action: string,
) => Promise<void>;

/** Write an image through the native pasteboard after its menu row is selected. */
declare const chatpaneCopyImage: (dataUrl: string, action: string) => Promise<unknown> | undefined;

/** Show Chatpane's media and message actions in a native context menu. A
 * keyboard-opened menu passes the viewport point to pop up at. */
declare const chatpaneShowContextMenu: (
  items: { label: string; action: string; value?: string; reaction?: true; checked?: true }[],
  position?: [x: number, y: number],
) => Promise<void>;

/** Verify the native context-menu selection without exposing the window secret. */
declare const chatpaneVerifyResult:
  | ((event: string, value: unknown, signature: unknown) => Promise<boolean>)
  | undefined;

/** Send a quick-reply result through the non-extractable per-window signer. */
declare const chatpaneReplyResult: (id: number, attempt: number, ok: boolean) => Promise<unknown>;

interface Window {
  /** Tauri's always-present internal IPC bridge (no `withGlobalTauri`). */
  __TAURI_INTERNALS__?: {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
    metadata?: { currentWindow?: { label?: string } };
  };
  /** The title bar strip Chatpane keeps (src-tauri/src/title_bar.rs). */
  __CHATPANE_TITLE_BAR__?: {
    inset: number;
    controls: "windows" | "linux" | null;
    minimize: boolean;
    maximize: boolean;
    maximized: boolean;
  };
  /** Called by the native side with the strip's current state. */
  __chatpaneTitleBar?: (state: unknown) => void;
  __CHATPANE_SETTINGS__?: ChatpaneSettings;
  /** Scheduled delivery availability fixed when the native process starts. */
  __CHATPANE_SCHEDULED_SEND_AVAILABLE__?: boolean;
  /** Conversation id a recycled window reopens; set only in rebuilt windows. */
  __CHATPANE_RESTORE_THREAD__?: string;
  /** macOS: built after a second window moved the session to Messenger's shared engine. */
  __CHATPANE_SHARED_ENGINE__?: boolean;
  /** Native watchdog generation baked into this Messenger window. */
  __CHATPANE_HEARTBEAT_ID__?: number;

  // panel.js
  __chatpaneToast?: (
    msg: string,
    action?: ChatpaneToastAction,
    options?: ChatpaneToastOptions,
  ) => void;
  __chatpaneCheckUpdates?: () => void;
  __chatpaneToggleSettings?: () => void;
  __chatpaneToggleShortcuts?: () => void;
  /** Called by native code when the one-time star toast is due. */
  __chatpaneStarPrompt?: (productName: string) => void;

  // messenger.js — driven by the native menus (View ▸ Zoom, File ▸ New
  // Conversation, Dock/tray thread menus) and the dev-only mcp-bridge.
  __chatpaneZoomIn?: () => void;
  __chatpaneZoomOut?: () => void;
  __chatpaneZoomReset?: () => void;
  __chatpaneShortcuts?: Record<string, () => unknown>;
  __chatpaneToggleInfo?: () => boolean;
  /** Native → page account requests; answered on `chatpane:account-result`. */
  __chatpaneAccount?: (request: string, action: string, value: unknown) => void;
  /** File ▸ Export Conversation as HTML/JSON… */
  __chatpaneExportConversation?: (format: unknown) => void;
  __chatpaneOpenThread?: (href: string) => boolean;
  /** Temporarily resume encrypted-history indexing for conversation search. */
  __chatpaneWakeSearchIndex?: () => void;
  __CHATPANE_WORKER_OPTIMIZATION__?: {
    responsivenessWorkersStopped: number;
  };
  __chatpaneNotifyClick?: (id: number) => boolean;
  __chatpaneNotifyResult?: (id: number, delivery: string) => void;
  /** Share-extension payload delivery from the native intake (macOS). */
  __chatpaneShareMedia?: (payload: unknown) => void;
  /** Deliver a native notification reply without raising the Chatpane window. */
  __chatpaneQuickReply?: (path: string, text: string, id: number, attempt: number) => void;
  /** Preserve a failed notification reply as an unsent composer draft. */
  __chatpaneQuickReplyDraft?: (path: string, text: string, id: number, attempt: number) => void;
  /** Mute a conversation from its notification without raising the window. */
  __chatpaneQuickMute?: (
    path: string,
    target: unknown,
    id: number,
    attempt: number,
    budgetMs: number,
  ) => void;
  /** React to the message a notification announced (`target`: native ActionTarget). */
  __chatpaneQuickReact?: (
    path: string,
    target: unknown,
    id: number,
    attempt: number,
    budgetMs: number,
  ) => void;
  /** Mark a notification's conversation read without opening it. */
  __chatpaneMarkRead?: (
    path: string,
    target: unknown,
    id: number,
    attempt: number,
    budgetMs: number,
  ) => void;
  /** Auto-refresh nudge, called by the Notification bridge. */
  __chatpaneOnNotification?: () => void;
  /** Sender-avatar cache sizes, or one sender's verdict, for the MCP probe. */
  __chatpaneSenderAvatarStats?: (
    thread?: string,
    sender?: string,
  ) => { avatars: number; groups: number; retired: number } | { resolves: string };
  /** Set while a getUserMedia call is live so auto-refresh never reloads mid-call. */
  __chatpaneInCall?: boolean;
  /** Respond to the native renderer watchdog without exposing page content. */
  __chatpaneHeartbeat?: (expectedId: number) => void;
  __chatpaneRateLimitRetry?: (expectedId: number, expires: number) => void;
  __chatpaneCaptureRecovery?: () => Promise<void>;
}

interface XMLHttpRequest {
  /** Set by the telemetry blocker in open(), consumed in send(). */
  __chatpaneBlocked?: boolean;
}

interface Element {
  /** System-emoji feature: the native-glyph <span> shadowing this sprite. */
  __chatpaneSystemEmojiGlyph?: HTMLSpanElement;
  /** Fullscreen polyfill (only on WebViews without the real API). */
  webkitRequestFullscreen?: () => Promise<void>;
}

interface Document {
  /** Fullscreen polyfill (only on WebViews without the real API). */
  webkitExitFullscreen?: () => Promise<void>;
}
