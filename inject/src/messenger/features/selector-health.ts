/* ------------------------- Selector health ---------------------------- */
// The selectors the core features stand on. If one goes dry while a
// logged-in Messenger page is up, the matching feature is broken — report it
// and tell the user once, instead of failing silently for weeks.
import { diag, toast } from "../bridge";

const WATCHED_SELECTORS = [
  // The notification MutationObserver is intentionally scoped to this exact
  // grid. A looser chat-link selector can stay green while the scanner is dead.
  { key: "notification-grid", sel: '[role="navigation"] [role="grid"]' },
  // Conversation list links: Cmd/Ctrl+1–9, unread-conversations badge,
  // recent threads, hide-names blur.
  { key: "chat-list", sel: '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]' },
  // The conversation pane: media viewer, hide-names header blur.
  { key: "main-region", sel: '[role="main"]' },
  // The injected Settings gear depends on Messenger's localized overflow
  // control/icon. Watch the actual output rather than testing a copied icon
  // path constant against itself.
  { key: "settings-button", sel: "[data-carrier-settings-button]" },
];

export function initSelectorHealth() {
  if (!window.__TAURI_INTERNALS__) return;
  let warnedUser = false;
  const misses = new Map<string, number>();
  const check = () => {
    // Only a logged-in Messenger view is expected to match; skip the login
    // page, checkpoints, and mid-reload states.
    if (!location.pathname.startsWith("/messages")) return;
    if (document.querySelector('input[name="pass"]')) return;
    for (const { key, sel } of WATCHED_SELECTORS) {
      if (document.querySelector(sel)) {
        misses.set(key, 0);
        continue;
      }
      // Two consecutive dry checks, so a slow render can't false-positive.
      const n = (misses.get(key) || 0) + 1;
      misses.set(key, n);
      if (n < 2) continue;
      diag(`selector.${key}`, "core selector matched nothing on a logged-in Messenger page");
      if (!warnedUser) {
        warnedUser = true;
        toast("A Messenger update may have broken part of Carrier — check for updates (F2).");
      }
    }
  };
  // First check once the page has had time to render, then keep watch.
  setTimeout(check, 45_000);
  setInterval(check, 300_000);
}
