/* ------------------- Focus the message box on return ------------------- */
// Switching back to Carrier (Cmd/Alt+Tab, Dock, tray, global hotkey) with a
// conversation open, or opening a conversation from the chat list or search,
// puts the cursor in the message box, unless something else the user chose
// already has focus (Ref #359). A native action that reveals the window to
// open a conversation owns focus instead.

import {
  explicitActionRecent,
  type ReturnFocus,
  shouldFocusComposerOnReturn,
} from "../lib/composer-focus";
import { threadIdFromHref } from "../lib/threads";
import { chatRows, focusComposer, isShown } from "./conversation-actions";

// Long enough for a native action evaluated right after the window shows to
// stamp itself, and for the engine to restore the previously focused element.
const SETTLE_MS = 250;
// How long a conversation opened from a link has to show its message box,
// and how long after that Messenger may still move focus to its heading.
const OPEN_WAIT_MS = 3_000;
const SETTLE_AFTER_OPEN_MS = 2_500;
// Native actions that arrive while the page loads are held and dispatched when
// it finishes. Until then, and briefly after, the page has no say over focus.
const AFTER_LOAD_MS = 1_000;

function currentFocus(): ReturnFocus {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) {
    return "nothing";
  }
  const link = active.closest("a");
  return link && chatRows().includes(link as HTMLAnchorElement) ? "chat-list" : "elsewhere";
}

function returnState() {
  return {
    enabled: window.__CARRIER_SETTINGS__?.focus_composer_on_return !== false,
    threadOpen: !!threadIdFromHref(location.pathname),
    dialogOpen: [...document.querySelectorAll('[role="dialog"]')].some(isShown),
    focus: currentFocus(),
  };
}

export function initComposerFocus() {
  let loadedAt: number | null = document.readyState === "complete" ? 0 : null;
  window.addEventListener(
    "load",
    () => {
      loadedAt = performance.now();
    },
    { once: true },
  );
  const settled = () => loadedAt !== null && performance.now() - loadedAt >= AFTER_LOAD_MS;
  window.addEventListener("focus", (event) => {
    if (event.target !== window) return;
    const path = location.pathname;
    setTimeout(() => {
      // A conversation switch in flight: its pane is not the one to type in.
      if (!settled() || explicitActionRecent() || location.pathname !== path) return;
      if (shouldFocusComposerOnReturn(returnState())) focusComposer();
    }, SETTLE_MS);
  });

  // Opening a conversation by clicking it in the chat list or in search
  // results. Messenger leaves focus on the clicked link; once the new
  // conversation's message box is shown, move focus there unless the user
  // has since moved it somewhere of their own (search, a dialog).
  document.addEventListener(
    "click",
    (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!link || link.closest('[role="main"]')) return;
      const target = threadIdFromHref(link.getAttribute("href"));
      if (!target) return;
      const startedAt = performance.now();
      let readyAt: number | null = null;
      // Messenger can update the route before it replaces the pane, so the
      // conversation being left must not count as the one opened (the same
      // check as thread-nav's openThreadForAction).
      const log = () => document.querySelector('[role="main"] [role="log"]');
      const staleLog = threadIdFromHref(location.pathname) === target ? null : log();
      // The user moving focus themselves (a click, Tab, arrow keys) ends the
      // watch; typing does not, since that is what the focus is for.
      let cancelled = false;
      const cancel = (e: Event) => {
        if (e instanceof KeyboardEvent && !/^(Tab|Arrow|Escape|Page|Home|End)/.test(e.key)) return;
        cancelled = true;
      };
      const stop = () => {
        cancelled = true;
        removeEventListener("pointerdown", cancel, true);
        removeEventListener("keydown", cancel, true);
      };
      addEventListener("pointerdown", cancel, true);
      addEventListener("keydown", cancel, true);
      const check = () => {
        const now = performance.now();
        if (cancelled || now - startedAt > OPEN_WAIT_MS || explicitActionRecent()) return stop();
        const current = log();
        if (
          threadIdFromHref(location.pathname) !== target ||
          !current ||
          current === staleLog ||
          !focusComposerReady()
        ) {
          requestAnimationFrame(check);
          return;
        }
        readyAt ??= now;
        const state = returnState();
        // The clicked link still holding focus is the click itself, and
        // Messenger moves focus to a page heading as a conversation opens
        // (for screen readers); neither is a choice to keep focus there.
        // Headings are not focusable by clicking, so this never overrides
        // the user.
        const active = document.activeElement;
        const incidental = link.contains(active) || !!active?.matches(":is(h1, h2)");
        const focus = incidental ? "nothing" : state.focus;
        if (composerFocused()) {
          // Already there; keep watching in case Messenger moves it.
        } else if (shouldFocusComposerOnReturn({ ...state, focus })) {
          focusComposer();
        } else if (focus === "elsewhere") {
          return stop();
        }
        // Keep watch briefly: Messenger's heading focus can land after ours.
        if (now - readyAt < SETTLE_AFTER_OPEN_MS) requestAnimationFrame(check);
        else stop();
      };
      requestAnimationFrame(check);
    },
    true,
  );
}

function composerFocused() {
  return !!document.activeElement?.matches(
    '[role="main"] [contenteditable="true"][role="textbox"]',
  );
}

/** The open conversation's message box is on screen. */
function focusComposerReady() {
  return [
    ...document.querySelectorAll('[role="main"] [contenteditable="true"][role="textbox"]'),
  ].some(isShown);
}
