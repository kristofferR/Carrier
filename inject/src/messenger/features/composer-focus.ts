/* ------------------- Focus the message box on return ------------------- */
// Switching back to Carrier (Cmd/Alt+Tab, Dock, tray, global hotkey) with a
// conversation open puts the cursor in the message box, unless something
// else the user chose already has focus (Ref #359).
import { type ReturnFocus, shouldFocusComposerOnReturn } from "../lib/composer-focus";
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
    // Let the engine restore the previously focused element first.
    setTimeout(() => {
      const state = {
        enabled: window.__CARRIER_SETTINGS__?.focus_composer_on_return !== false,
        threadOpen: !!threadIdFromHref(location.pathname),
        dialogOpen: [...document.querySelectorAll('[role="dialog"]')].some(isShown),
        focus: currentFocus(),
      };
      if (shouldFocusComposerOnReturn(state)) focusComposer();
    }, 0);
  });
}
