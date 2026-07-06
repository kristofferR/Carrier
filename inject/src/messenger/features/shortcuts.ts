/* --------------------------- Keyboard shortcuts ----------------------- */
// Triggered with the platform accelerator (Cmd on macOS, Ctrl elsewhere).
import {
  attachFiles,
  chatRows,
  focusChatSearch,
  focusComposer,
  newConversation,
  openEmojiPicker,
  openGifPicker,
  searchInConversation,
  stepConversation,
} from "./conversation-actions";
import { zoomIn, zoomOut, zoomReset } from "./zoom";

const isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
const accel = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

const shortcuts: Record<string, () => unknown> = {
  "[": () => stepConversation(-1),
  "]": () => stepConversation(1),
  "-": zoomOut,
  "=": zoomIn,
  "+": zoomIn,
  "0": zoomReset,
  r: () => location.reload(),
  k: () => focusChatSearch(),
  f: () => searchInConversation(),
  l: () => focusComposer(),
  e: () => openEmojiPicker(),
  g: () => openGifPicker(),
  t: () => attachFiles(),
};

export function initShortcuts() {
  document.addEventListener(
    "keydown",
    (e) => {
      // Ctrl+Tab / Ctrl+Shift+Tab cycle conversations (all platforms).
      if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        stepConversation(e.shiftKey ? -1 : 1);
        return;
      }
      if (!accel(e)) return;
      const fn = shortcuts[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    },
    true,
  );
}

/* ----------------------- Function-key shortcuts ----------------------- */
// F2 check for updates · F3 settings · F5 reload (parity with messenger-next).
export function initFunctionKeys() {
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "F5") {
        e.preventDefault();
        location.reload();
      } else if (e.key === "F3") {
        e.preventDefault();
        window.__carrierToggleSettings?.();
      } else if (e.key === "F2") {
        e.preventDefault();
        window.__carrierCheckUpdates?.();
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        // Cmd/Ctrl+1–9: jump to the Nth conversation in the list.
        const target = chatRows()[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          target.click();
        }
      }
    },
    true,
  );
}

// Registry for the native menu (File ▸ New Conversation) and the dev-only
// mcp-bridge test hook; the keydown handlers above call these directly.
export function initShortcutRegistry() {
  window.__carrierShortcuts = {
    nextConversation: () => stepConversation(1),
    prevConversation: () => stepConversation(-1),
    focusChatSearch,
    focusComposer,
    searchInConversation,
    openEmojiPicker,
    openGifPicker,
    attachFiles,
    newConversation,
  };
}
