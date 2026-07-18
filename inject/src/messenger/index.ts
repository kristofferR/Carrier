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
import { initAutoRefresh } from "./features/auto-refresh";
import { initComposerKeys } from "./features/composer-keys";
import { initContextMenu } from "./features/context-menu";
import { initCookieAutoDecline } from "./features/cookie-consent";
import { initDownloadAnchors } from "./features/download-anchors";
import { initForceTheme } from "./features/force-theme";
import { initFullscreenPolyfill } from "./features/fullscreen";
import { initHideNames } from "./features/hide-names";
import { initLinkHandling } from "./features/link-handling";
import { initLoginTidy } from "./features/login-tidy";
import { initMediaAutoplay } from "./features/media-autoplay";
import { initMediaPermissionWarning } from "./features/media-permissions";
import { initMediaViewer } from "./features/media-viewer";
import { initNotificationBridge } from "./features/notifications";
import { initRecentThreads } from "./features/recent-threads";
import { initSelectorHealth } from "./features/selector-health";
import { initSettingsButton } from "./features/settings-button";
import { initFunctionKeys, initShortcutRegistry, initShortcuts } from "./features/shortcuts";
import { initSpellcheck } from "./features/spellcheck";
import { initSystemEmoji } from "./features/system-emoji";
import { initTelemetryBlocking } from "./features/telemetry";
import { initThreadNav } from "./features/thread-nav";
import { initUnreadBadge } from "./features/unread-badge";
import { initZoom } from "./features/zoom";

function main() {
  initComposerKeys();
  initShortcuts();
  initZoom();
  initSelectorHealth();
  initSettingsButton();
  initFunctionKeys();
  initShortcutRegistry();
  initLinkHandling();
  initContextMenu();
  initDownloadAnchors();
  initSpellcheck();
  initTelemetryBlocking();
  initMediaAutoplay();
  initNotificationBridge();
  initAutoRefresh();
  initForceTheme();
  initUnreadBadge();
  initRecentThreads();
  initThreadNav();
  initHideNames();
  initSystemEmoji();
  initMediaPermissionWarning();
  initCookieAutoDecline();
  initLoginTidy();
  initMediaViewer();
  initFullscreenPolyfill();
}

// Tauri injects initialization scripts into subframes too (notably on
// Windows). Only enhance the top-level Messenger document.
if (window.top === window.self) main();
