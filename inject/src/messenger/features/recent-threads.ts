/* ---------------------- Recent conversations ------------------------- */
// Scrape the chat list's most recent threads (display name + /t/<id> link)
// and push them to Rust, which mirrors them into the macOS Dock menu and the
// tray menu so a conversation is one right-click away. The list lives in
// memory only — nothing is persisted to disk.
import { invoke } from "../bridge";
import { SEPARATOR_RE, threadIdFromHref } from "../lib/threads";
import { chatRows } from "./conversation-actions";

export function initRecentThreads() {
  if (!window.__TAURI_INTERNALS__) return;

  const MAX_THREADS = 9;
  const EMPTY_GRACE_MS = 15000;

  // A thread row's display name. Facebook's class names are hashed and
  // unstable, so take the row's first span with real text — the name renders
  // before the message preview and timestamp.
  const rowName = (a: HTMLAnchorElement) => {
    const row = a.closest('[role="row"]') || a;
    for (const span of row.querySelectorAll("span")) {
      const t = (span.textContent || "").replace(/\s+/g, " ").trim();
      if (t && !SEPARATOR_RE.test(t)) return t.slice(0, 60);
    }
    return "";
  };

  const chatListScrolledFromTop = (rows: HTMLAnchorElement[]) => {
    const first = rows[0];
    if (!first) return false;
    for (let el = first.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 16) return el.scrollTop > 8;
    }
    return false;
  };

  // The visible chat list, top to bottom. Only trust it while the virtualized
  // list is at the top; after a manual scroll, visible rows no longer equal
  // Messenger's most recent conversations.
  const scan = () => {
    const rows = chatRows();
    if (chatListScrolledFromTop(rows)) return null;
    const seen = new Set<string>();
    const out: { name: string; href: string }[] = [];
    for (const a of rows) {
      const id = threadIdFromHref(a.getAttribute("href"));
      if (!id || seen.has(id)) continue;
      const name = rowName(a);
      if (!name) continue;
      seen.add(id);
      out.push({ name, href: `/t/${id}/` });
      if (out.length >= MAX_THREADS) break;
    }
    return out;
  };

  let lastSent: string | null = null;
  let emptySince = 0;
  const push = () => {
    // Hide Names & Avatars: never let contact names cross into native menus.
    const hide = window.__CARRIER_SETTINGS__?.hide_names_avatars === true;
    const threads = hide ? [] : scan();
    if (threads === null) return;
    // An empty scan usually means the chat list hasn't rendered (mid-reload),
    // so give it a short grace period. If rows stay absent, clear the menus so
    // logout/offline/selector-break states do not leak stale contact names.
    if (!hide && threads.length === 0) {
      const now = Date.now();
      if (!emptySince) emptySince = now;
      if (now - emptySince < EMPTY_GRACE_MS) return;
    } else {
      emptySince = 0;
    }
    const key = JSON.stringify(threads);
    if (key === lastSent) return;
    lastSent = key;
    invoke("plugin:event|emit", { event: "carrier:recent-threads", payload: threads })?.catch?.(
      () => {},
    );
  };

  // The list reorders when messages arrive or are read — moments the unread
  // badge already refreshes on — so a slow poll plus the settings/visibility
  // hooks keeps the menus fresh without another DOM-wide observer. Emits only
  // on actual change, so the steady-state cost is one scan per tick.
  let timer: number | undefined;
  const startPoll = () => {
    clearInterval(timer);
    timer = setInterval(push, document.hidden ? 60000 : 10000);
  };
  document.addEventListener("visibilitychange", () => {
    startPoll();
    if (!document.hidden) push();
  });
  window.addEventListener("carrier:settings", push);
  startPoll();
  setTimeout(push, 1500);
  setTimeout(push, 4000);
}
