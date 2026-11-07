/* ------------------- Focus the message box on return ------------------- */
// Switching back to Carrier (Cmd/Alt+Tab, Dock, tray, global hotkey) with a
// conversation open puts the cursor in the message box, unless something
// else the user chose already has focus (Ref #359). A native action that
// reveals the window to open a conversation owns focus instead.

// Long enough for a native action evaluated right after the window shows to
// stamp itself, and for the engine to restore the previously focused element.
const SETTLE_MS = 250;

import {
  explicitActionRecent,
  type ReturnFocus,
  shouldFocusComposerOnReturn,
} from "../lib/composer-focus";
import { threadIdFromHref } from "../lib/threads";
import { chatRows, focusComposer, isShown } from "./conversation-actions";

function currentFocus(): ReturnFocus {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) {
    return "nothing";
  }
  const link = active.closest("a");
  return link && chatRows().includes(link as HTMLAnchorElement) ? "chat-list" : "elsewhere";
}

export function initComposerFocus() {
  window.addEventListener("focus", (event) => {
    if (event.target !== window) return;
    const path = location.pathname;
    setTimeout(() => {
      // A conversation switch in flight: its pane is not the one to type in.
      if (explicitActionRecent() || location.pathname !== path) return;
      const state = {
        enabled: window.__CARRIER_SETTINGS__?.focus_composer_on_return !== false,
        threadOpen: !!threadIdFromHref(location.pathname),
        dialogOpen: [...document.querySelectorAll('[role="dialog"]')].some(isShown),
        focus: currentFocus(),
      };
      if (shouldFocusComposerOnReturn(state)) focusComposer();
    }, SETTLE_MS);
  });
}
