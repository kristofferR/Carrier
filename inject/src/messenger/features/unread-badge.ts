/* --------------------------- Unread badge ----------------------------- */
// Mirror the unread count onto the Dock / taskbar badge, and tell Rust so the
// tray tooltip can show it too. The count is either unread *messages*
// (Facebook's total, parsed from the "(N)" it puts in the page title) or
// unread *conversations* (chats in the list rendered bold), per `badge_mode`.
import { diag, invoke } from "../bridge";
import { isUnreadConversationText } from "../lib/conversation-row";
import { threadIdFromHref } from "../lib/threads";
import { reconcileUnreadMessageCount, unreadCountFromTitle } from "../lib/unread";
import { chatRows } from "./conversation-actions";

export function initUnreadBadge() {
  if (!window.__TAURI_INTERNALS__) return;

  // Unread conversations: Facebook renders a chat's name/preview bold only
  // while it has unread messages. The class names are hashed and unstable, so
  // we key off the computed font-weight of each list row instead. Rows are the
  // visible links in the navigation list (`/t/<id>`), excluding duplicate or
  // unrelated thread links elsewhere in the page.
  const unreadConversationState = () => {
    const links = chatRows();
    const seen = new Set<string>();
    let count = 0;
    for (const a of links) {
      const id = threadIdFromHref(a.getAttribute("href"));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const row = a.closest('[role="row"]') || a;
      for (const span of row.querySelectorAll("span")) {
        if (isUnreadConversationText(getComputedStyle(span).fontWeight, span.textContent || "")) {
          count++;
          break;
        }
      }
    }

    // A virtualized list only represents the newest chats while it is at the
    // top. Do not let a user scrolling through older rows invalidate the title
    // count merely because the unread rows are temporarily outside the DOM.
    let scrolledFromTop = false;
    const first = links[0];
    for (let el = first?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 16) continue;
      scrolledFromTop = el.scrollTop > 8;
      break;
    }
    return {
      count,
      ready: links.length > 0,
      trustworthy: links.length > 0 && !scrolledFromTop,
    };
  };

  let last: number | null = null;
  const setBadge = (n: number, force: boolean) => {
    if (n === last && !force) return;
    last = n;
    // NB: the command's argument is `value` (the Tauri `setter!` macro names
    // it that), not `count` — passing `count` silently clears the badge.
    invoke("plugin:window|set_badge_count", { value: n > 0 ? n : null })?.catch?.(() =>
      diag("badge.set", "set_badge_count invoke failed"),
    );
    invoke("plugin:event|emit", { event: "carrier:unread", payload: n })?.catch?.(() =>
      diag("badge.emit", "carrier:unread emit failed"),
    );
  };

  // `force` re-applies even when the count is unchanged — used for the initial
  // applications, which must survive the async macOS badge-authorization grant
  // (it lands shortly after launch) and the chat list's first render.
  const apply = (force: boolean) => {
    const s = window.__CARRIER_SETTINGS__ || {};
    if (s.unread_badge === false) {
      setBadge(0, force);
      return;
    }
    const conversations = unreadConversationState();
    const conv = s.badge_mode === "conversations";
    const n = conv
      ? conversations.count
      : reconcileUnreadMessageCount(
          unreadCountFromTitle(document.title || ""),
          conversations.count,
          conversations.trustworthy,
        );
    // While Facebook is reloading the page, the title carries no "(N)" and the
    // chat list hasn't rendered yet, so both counts read 0. The OS keeps the
    // Dock badge across the reload on its own, so don't clear it during that
    // window — it would blink off and back. Only a "ready" page can be trusted
    // to mean 0 unread. (A non-zero count only happens once ready anyway.)
    const ready = conv
      ? conversations.ready
      : document.readyState === "complete" && (document.title || "").trim().length > 0;
    if (n === 0 && !ready) return;
    setBadge(n, force);
  };

  // Re-evaluate whenever the title changes — Facebook updates "(N)" the moment a
  // message arrives or is read, which is exactly when the unread count (and the
  // bolded conversations) change too, so this drives both modes promptly.
  // Observe <head> (not the <title> node directly) so it survives Facebook
  // replacing the element.
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      apply(false); // snappy
      // Re-check shortly after: in conversation mode the (un)bolding of a row
      // can lag the title change by a frame or two.
      setTimeout(() => apply(false), 800);
    }, 120);
  };
  // This runs at document-start, where <head> may not exist yet; if so, wait
  // for it rather than permanently falling back to the interval.
  const headObserver = new MutationObserver(schedule);
  const observeHead = () => {
    if (!document.head) return false;
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    return true;
  };
  if (!observeHead()) {
    const waitForHead = new MutationObserver(() => {
      if (observeHead()) waitForHead.disconnect();
    });
    waitForHead.observe(document.documentElement, { childList: true, subtree: true });
  }
  window.addEventListener("carrier:settings", () => apply(true));
  // Fallback poll behind the title observer above (which stays armed while
  // hidden — badge freshness in the background is the feature). Poll slowly
  // when the window is hidden, snappily when visible, and catch up the moment
  // it's shown again.
  let pollTimer: number | undefined;
  const startPoll = () => {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => apply(false), document.hidden ? 60000 : 5000);
  };
  document.addEventListener("visibilitychange", () => {
    startPoll();
    if (!document.hidden) apply(false);
  });
  startPoll();
  apply(true);
  setTimeout(() => apply(true), 1500);
  setTimeout(() => apply(true), 4000);
}
