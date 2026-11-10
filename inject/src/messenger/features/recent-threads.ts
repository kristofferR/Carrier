/* ---------------------- Recent conversations ------------------------- */
// The most recent conversations (display name + /t/<id> link), pushed to Rust,
// which mirrors them into the macOS Dock menu, the tray menu and the Windows
// jump list so a conversation is one right-click away. Read from Messenger's
// database; the chat-list scrape is the fallback when the database is
// unavailable. The list lives in memory only — nothing is persisted to disk.
import { invoke } from "../bridge";
import { nicknameMode } from "../lib/nicknames";
import { hidesNames } from "../lib/privacy";
import { readRecentThreads } from "../lib/recent-threads";
import { accountId, threadIdFromHref } from "../lib/threads";
import { chatRowName, chatRows } from "./conversation-actions";

export function initRecentThreads() {
  if (!window.__TAURI_INTERNALS__) return;

  const MAX_THREADS = 9;
  const EMPTY_GRACE_MS = 15000;

  const chatListScrolledFromTop = (rows: HTMLAnchorElement[]) => {
    const first = rows[0];
    if (!first) return false;
    for (let el = first.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 16) return el.scrollTop > 8;
    }
    return false;
  };

  // Rendered row names by thread id, for chats the database cannot name.
  const rowNames = () => {
    const names = new Map<string, string>();
    for (const a of chatRows()) {
      const id = threadIdFromHref(a.getAttribute("href"));
      if (id && !names.has(id)) names.set(id, chatRowName(a));
    }
    return names;
  };

  const readDatabase = (viewer: string) => {
    let names: Map<string, string> | undefined;
    return readRecentThreads((window as unknown as { require?: unknown }).require, {
      viewer,
      mode: nicknameMode(window.__CHATPANE_SETTINGS__),
      limit: MAX_THREADS,
      fallbackName: (id) => (names ??= rowNames()).get(id) ?? "",
    });
  };

  // Fallback: the visible chat list, top to bottom. Only trust it while the
  // virtualized list is at the top; after a manual scroll, visible rows no
  // longer equal Messenger's most recent conversations.
  const scan = () => {
    const rows = chatRows();
    if (chatListScrolledFromTop(rows)) return null;
    const seen = new Set<string>();
    const out: { name: string; href: string }[] = [];
    for (const a of rows) {
      const id = threadIdFromHref(a.getAttribute("href"));
      if (!id || seen.has(id)) continue;
      const name = chatRowName(a);
      if (!name) continue;
      seen.add(id);
      out.push({ name, href: `/t/${id}/` });
      if (out.length >= MAX_THREADS) break;
    }
    return out;
  };

  let lastSent: string | null = null;
  let emptySince = 0;
  let pushing = false;
  let pushAgain = false;
  const hidden = () => hidesNames(window.__CHATPANE_SETTINGS__);
  // One read at a time; a request made during a read (a settings change, say)
  // runs once it finishes.
  const push = async () => {
    if (pushing) {
      pushAgain = true;
      return;
    }
    pushing = true;
    try {
      do {
        pushAgain = false;
        await send();
      } while (pushAgain);
    } finally {
      pushing = false;
    }
  };
  const send = async () => {
    // Hide Names & Avatars: never let contact names cross into native menus.
    // Logged out (no account cookie, e.g. the login page after a logout):
    // nothing to show, and nothing stale either.
    const viewer = accountId(document.cookie);
    let threads = !viewer || hidden() ? [] : ((await readDatabase(viewer)) ?? scan());
    // Hide Names may have been switched on, or the account logged out or
    // changed, during the read.
    const clear = !viewer || hidden() || accountId(document.cookie) !== viewer;
    if (clear) threads = [];
    if (threads === null) return;
    // An empty list usually means the chat list hasn't loaded (mid-reload),
    // so give it a short grace period. If it stays empty, clear the menus so
    // offline/selector-break states do not leak stale contact names.
    if (!clear && threads.length === 0) {
      const now = Date.now();
      if (!emptySince) emptySince = now;
      if (now - emptySince < EMPTY_GRACE_MS) return;
    } else {
      emptySince = 0;
    }
    const key = JSON.stringify(threads);
    if (key === lastSent) return;
    lastSent = key;
    invoke("plugin:event|emit", { event: "chatpane:recent-threads", payload: threads })?.catch?.(
      () => {},
    );
  };

  // The list reorders when messages arrive or are read — moments the unread
  // badge already refreshes on — so a slow poll plus the settings/visibility
  // hooks keeps the menus fresh without another DOM-wide observer. Emits only
  // on actual change, so the steady-state cost is one database read per tick.
  let timer: number | undefined;
  const startPoll = () => {
    clearInterval(timer);
    timer = setInterval(push, document.hidden ? 60000 : 10000);
  };
  document.addEventListener("visibilitychange", () => {
    startPoll();
    if (!document.hidden) push();
  });
  window.addEventListener("chatpane:settings", push);
  startPoll();
  setTimeout(push, 1500);
  setTimeout(push, 4000);
}
