/*
 * Carrier — in-page enhancements for the Messenger web app.
 * Clean-room implementation (keyboard shortcuts, page zoom, an image/video
 * zoom + pan viewer, and a fullscreen polyfill for the WebView).
 *
 * Runs as a WebView initialization script at document start. Source of the
 * generated src-tauri/inject/messenger.js (see inject/build.ts).
 *
 * NOTE: main() calls the feature inits in the same order the original single
 * script ran its sections in — capture-phase listeners on the same event fire
 * in registration order, so this order is part of the behaviour.
 */
import { diag } from "./bridge";
import { initAccountRequests } from "./features/account-requests";
import { initAutoRefresh } from "./features/auto-refresh";
import { initChatGradient } from "./features/chat-gradient";
import { initComposerFocus } from "./features/composer-focus";
import { initComposerKeys } from "./features/composer-keys";
import { initContextMenu } from "./features/context-menu";
import { initConversationExport } from "./features/conversation-export";
import { initCookieAutoDecline } from "./features/cookie-consent";
import { initDownloadAnchors } from "./features/download-anchors";
import { initEmojiImageLoading } from "./features/emoji-images";
import { initFacebookModuleInterception } from "./features/facebook-modules";
import { initFacebookWorkerOptimization } from "./features/facebook-workers";
import { initForceTheme, initThemeMarkers } from "./features/force-theme";
import { initFullscreenPolyfill } from "./features/fullscreen";
import { initHideNames } from "./features/hide-names";
import { initImagePaste } from "./features/image-paste";
import { initLinkHandling } from "./features/link-handling";
import { initLinuxCallNotice } from "./features/linux-call-notice";
import { initLoginTidy } from "./features/login-tidy";
import { initMediaAutoplay } from "./features/media-autoplay";
import { initMediaPermissionWarning } from "./features/media-permissions";
import { initMediaViewer } from "./features/media-viewer";
import { initMessengerDnd } from "./features/messenger-dnd";
import { initNotificationActions } from "./features/notification-actions";
import { initNotificationBridge } from "./features/notifications";
import { initPaneResize } from "./features/pane-resize";
import { initQuickMute } from "./features/quick-mute";
import { initQuickReply } from "./features/quick-reply";
import { initRateLimit } from "./features/rate-limit";
import { initReadAhead } from "./features/read-ahead";
import { initRecentThreads } from "./features/recent-threads";
import { initScheduledSend } from "./features/scheduled-send";
import { initScrollbars } from "./features/scrollbars";
import { initSelection } from "./features/selection";
import { initSelectorHealth } from "./features/selector-health";
import { initSettingsButton } from "./features/settings-button";
import { initShareIntake } from "./features/share-intake";
import { initFunctionKeys, initShortcutRegistry, initShortcuts } from "./features/shortcuts";
import { initSpellcheck } from "./features/spellcheck";
import { initSyncHealth } from "./features/sync-health";
import { initSystemEmoji } from "./features/system-emoji";
import { initTelemetryBlocking } from "./features/telemetry";
import { initThreadNav } from "./features/thread-nav";
import { initTypingBlock } from "./features/typing-block";
import { initUnreadBadge } from "./features/unread-badge";
import { initViewerControls } from "./features/viewer-controls";
import { initZoom } from "./features/zoom";
import { initMuteActionTracking } from "./lib/mute";

function initFeature(name: string, init: () => void) {
  try {
    init();
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    diag(`init.${name}`, detail.slice(0, 500));
  }
}

function main() {
  initFeature("rate-limit", initRateLimit);
  // Must wrap Worker before Facebook starts its background profiler.
  initFeature("facebook-workers", initFacebookWorkerOptimization);
  // Must run before any Facebook module definitions execute.
  initFeature("facebook-modules", initFacebookModuleInterception);
  // Must patch WebSocket/MessagePort before Messenger opens its socket.
  initFeature("typing-block", initTypingBlock);
  // Must run before Facebook assigns eager sources to its emoji images.
  initFeature("emoji-images", initEmojiImageLoading);
  initFeature("composer-keys", initComposerKeys);
  initFeature("image-paste", initImagePaste);
  initFeature("composer-focus", initComposerFocus);
  initFeature("selection", initSelection);
  initFeature("shortcuts", initShortcuts);
  initFeature("zoom", initZoom);
  initFeature("selector-health", initSelectorHealth);
  initFeature("settings-button", initSettingsButton);
  initFeature("function-keys", initFunctionKeys);
  initFeature("shortcut-registry", initShortcutRegistry);
  initFeature("link-handling", initLinkHandling);
  initFeature("context-menu", initContextMenu);
  initFeature("download-anchors", initDownloadAnchors);
  initFeature("spellcheck", initSpellcheck);
  initFeature("telemetry", initTelemetryBlocking);
  initFeature("media-autoplay", initMediaAutoplay);
  initFeature("mute-action-tracking", initMuteActionTracking);
  initFeature("messenger-dnd", initMessengerDnd);
  initFeature("account-requests", initAccountRequests);
  initFeature("notifications", initNotificationBridge);
  initFeature("share-intake", initShareIntake);
  initFeature("sync-health", initSyncHealth);
  initFeature("auto-refresh", initAutoRefresh);
  initFeature("force-theme", initForceTheme);
  initFeature("theme-markers", initThemeMarkers);
  initFeature("scrollbars", initScrollbars);
  initFeature("chat-gradient", initChatGradient);
  initFeature("unread-badge", initUnreadBadge);
  initFeature("recent-threads", initRecentThreads);
  initFeature("thread-nav", initThreadNav);
  initFeature("conversation-export", initConversationExport);
  initFeature("quick-reply", initQuickReply);
  initFeature("quick-mute", initQuickMute);
  initFeature("read-ahead", initReadAhead);
  initFeature("notification-actions", initNotificationActions);
  initFeature("scheduled-send", initScheduledSend);
  initFeature("hide-names", initHideNames);
  initFeature("pane-resize", initPaneResize);
  initFeature("system-emoji", initSystemEmoji);
  initFeature("media-permissions", initMediaPermissionWarning);
  initFeature("linux-call-notice", initLinuxCallNotice);
  initFeature("cookie-consent", initCookieAutoDecline);
  initFeature("login-tidy", initLoginTidy);
  initFeature("media-viewer", initMediaViewer);
  initFeature("viewer-controls", initViewerControls);
  initFeature("fullscreen", initFullscreenPolyfill);
}

// Tauri injects initialization scripts into subframes too (notably on
// Windows). Only enhance the top-level Messenger document.
if (window.top === window.self) main();
