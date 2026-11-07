/* --------------------------- Unread badge ----------------------------- */
// Mirror the unread count onto the Dock / taskbar badge, and tell Rust so the
// tray tooltip can show it too. The count is either unread *messages*
// (Facebook's total, parsed from the "(N)" it puts in the page title) or
// unread *conversations* (chats in the list rendered bold), per `badge_mode`.
import { diag, invoke } from "../bridge";
import {
  conversationNodeText,
  conversationTextParts,
  hasCandidateTextChild,
  isUnreadConversationText,
} from "../lib/conversation-row";
import {
  ignoresMutedConversations,
  observeConversationMute,
  observeDatabaseMute,
  observeOpenThreadMute,
} from "../lib/mute";
import { pageReloadSafeStorage } from "../lib/reload-safe-storage";
import { readThreadStates, type ThreadState } from "../lib/thread-state";
import { threadIdFromHref } from "../lib/threads";
import {
  didMutedFilterPolicyChange,
  type MutedUnreadObservation,
  MutedUnreadStore,
  mutedUnreadStorageKey,
  reconcileUnreadConversationCount,
  reconcileUnreadMessageCount,
  UnreadListReadiness,
  unreadCountFromTitle,
} from "../lib/unread";
import { chatRows } from "./conversation-actions";
import { RATE_LIMIT_EVENT, rateLimitRemainingMs } from "./rate-limit";

export function initUnreadBadge() {
  if (!window.__TAURI_INTERNALS__) return;

  const unreadStorage = pageReloadSafeStorage();
  const accountStorageKey = mutedUnreadStorageKey(document.cookie);
  const listReadiness = new UnreadListReadiness();

  // Messenger's database is the source of truth for listed chats; the
  // rendering heuristics below remain the fallback for chats it cannot answer
  // for (module changes, an unready database). Reads are async, so the count
  // uses the latest snapshot and re-applies when a refresh changes it.
  const THREAD_STATE_LIMIT = 500;
  const threadStates = new Map<string, ThreadState>();
  let refreshingStates = false;
  let statesFailing = false;
  // Bumped by an explicit mute action, so a read that started before it
  // cannot restore the old state. Messenger may also take a moment to write
  // the change, so the action's mute state holds briefly over the database.
  let stateEpoch = 0;
  const MUTE_ACTION_HOLD_MS = 5_000;
  const muteActions = new Map<string, { muted: boolean; at: number }>();
  const heldMute = (id: string, muted: boolean) => {
    const action = muteActions.get(id);
    if (!action) return muted;
    if (Date.now() - action.at < MUTE_ACTION_HOLD_MS) return action.muted;
    muteActions.delete(id);
    return muted;
  };
  const refreshThreadStates = (ids: string[]) => {
    if (refreshingStates || !ids.length) return;
    refreshingStates = true;
    const epoch = stateEpoch;
    readThreadStates(ids, (window as unknown as { require?: unknown }).require, Date.now())
      .then((states) => {
        if (epoch !== stateEpoch) return;
        if (states === null) {
          if (!statesFailing) diag("badge.thread-state", "Messenger database unavailable");
          statesFailing = true;
        } else statesFailing = false;
        // Every requested chat ends up with a current answer or none: chats
        // the database could not answer for fall back to rendered evidence.
        let changed = false;
        for (const id of ids) {
          const read = states?.get(id);
          const state = read && { ...read, muted: heldMute(id, read.muted) };
          const old = threadStates.get(id);
          if (!state) {
            if (threadStates.delete(id)) changed = true;
            continue;
          }
          if (old?.unread !== state.unread || old?.muted !== state.muted) changed = true;
          threadStates.delete(id);
          threadStates.set(id, state);
          if (threadStates.size > THREAD_STATE_LIMIT) {
            threadStates.delete(threadStates.keys().next().value!);
          }
        }
        if (changed) apply(true);
      })
      .finally(() => {
        refreshingStates = false;
      });
  };

  // Unread conversations: Facebook renders a chat's name/preview bold only
  // while it has unread messages. The class names are hashed and unstable, so
  // we key off the computed font-weight of each list row instead. Rows are the
  // visible links in the navigation list (`/t/<id>`), excluding duplicate or
  // unrelated thread links elsewhere in the page.
  const unreadConversationState = () => {
    const ignoreMuted = ignoresMutedConversations(window.__CARRIER_SETTINGS__);
    const openId = threadIdFromHref(location.pathname);
    if (openId) {
      observeOpenThreadMute(openId, [
        ...document.querySelectorAll('[role="main"]'),
        ...document.querySelectorAll('[role="complementary"], [role="dialog"]'),
      ]);
    }
    const links = chatRows();
    const listedIds: string[] = [];
    const seen = new Set<string>();
    let count = 0;
    const rowObservations: (MutedUnreadObservation & { hasTitle: boolean })[] = [];
    for (const a of links) {
      const id = threadIdFromHref(a.getAttribute("href"));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      listedIds.push(id);
      const known = threadStates.get(id);
      const row = a.closest('[role="row"]') || a;
      const spans = [...row.querySelectorAll<HTMLElement>("span")];
      let unread = known?.unread ?? false;
      for (const span of known ? [] : spans) {
        if (
          isUnreadConversationText(getComputedStyle(span).fontWeight, conversationNodeText(span))
        ) {
          unread = true;
          break;
        }
      }
      const candidates = spans.map((span) => {
        const rect = span.getBoundingClientRect();
        return {
          node: span,
          text: conversationNodeText(span),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          ariaHidden: span.getAttribute("aria-hidden") === "true",
          inAbbreviation: !!span.closest("abbr"),
          hasTextChild: hasCandidateTextChild(span),
        };
      });
      const hydrated = conversationTextParts(candidates).body.length > 0;
      const hasTitle = candidates.some(
        (candidate) =>
          !candidate.ariaHidden &&
          !candidate.inAbbreviation &&
          !candidate.hasTextChild &&
          candidate.width > 1 &&
          candidate.height > 1 &&
          candidate.text.trim().length > 0,
      );
      const muted = known ? observeDatabaseMute(id, known.muted) : observeConversationMute(id, row);
      rowObservations.push({ id, unread, muted, hydrated, hasTitle });
      if (!unread) continue;
      if (ignoreMuted && muted) continue;
      count++;
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
    refreshThreadStates(listedIds);
    const listHydrated =
      rowObservations.length > 0 && rowObservations.every(({ hydrated }) => hydrated === true);
    const ready = listReadiness.observe(rowObservations);
    return {
      count,
      // Settled title-only rows can drive the badge, but keep the stricter
      // preview requirement before retiring persisted muted-unread evidence.
      muteObservations: rowObservations.map((observation) => ({
        ...observation,
        hydrated: listHydrated,
      })),
      ready,
      trustworthy: ready && !scrolledFromTop,
    };
  };

  let last: number | null = null;
  let lastDockError = false;
  const isMac = /mac/i.test(navigator.platform);
  let filteredUnreadBaseline: number | null = null;
  const knownMutedUnreads = new MutedUnreadStore(
    accountStorageKey ? unreadStorage : null,
    accountStorageKey || "__carrier_muted_unreads_anonymous__",
  );
  let ignoreMutedPolicy: boolean | null = null;
  const setBadge = (n: number, force: boolean) => {
    const dockError = isMac && rateLimitRemainingMs() > 0;
    if (n === last && dockError === lastDockError && !force) return;
    last = n;
    lastDockError = dockError;
    // NB: the command's argument is `value` (the Tauri `setter!` macro names
    // it that), not `count` — passing `count` silently clears the badge.
    // Use a single setter on macOS so an unread update cannot race ERR away.
    const command = isMac ? "plugin:window|set_badge_label" : "plugin:window|set_badge_count";
    const value = isMac ? (dockError ? "ERR" : n > 0 ? String(n) : null) : n > 0 ? n : null;
    invoke(command, { value })?.catch?.(() => diag("badge.set", "badge update failed"));
    invoke("plugin:event|emit", { event: "carrier:unread", payload: n })?.catch?.(() =>
      diag("badge.emit", "carrier:unread emit failed"),
    );
  };

  // `force` re-applies even when the count is unchanged — used for the initial
  // applications, which must survive the async macOS badge-authorization grant
  // (it lands shortly after launch) and the chat list's first render.
  const apply = (force: boolean) => {
    const s = window.__CARRIER_SETTINGS__ || {};
    const ignoreMuted = ignoresMutedConversations(s);
    if (didMutedFilterPolicyChange(ignoreMutedPolicy, ignoreMuted)) {
      filteredUnreadBaseline = null;
    }
    ignoreMutedPolicy = ignoreMuted;
    const conversations = unreadConversationState();
    // Persisted evidence remains an account-level fact even while the badge UI
    // is disabled. Keep mounted-row read/unmute confirmation current so a
    // later re-enable cannot resurrect stale virtualized state.
    knownMutedUnreads.reconcile(conversations.muteObservations);
    if (s.unread_badge === false) {
      setBadge(0, force);
      return;
    }
    const titleCount = unreadCountFromTitle(document.title || "");
    if (ignoreMuted && conversations.trustworthy) {
      filteredUnreadBaseline = conversations.count;
    }
    const conv = s.badge_mode === "conversations";
    const n = conv
      ? reconcileUnreadConversationCount(
          conversations.count,
          conversations.trustworthy,
          ignoreMuted,
          filteredUnreadBaseline,
        )
      : reconcileUnreadMessageCount(
          titleCount,
          conversations.count,
          conversations.trustworthy,
          ignoreMuted && knownMutedUnreads.size > 0,
          filteredUnreadBaseline,
        );
    // While Facebook is reloading the page, the title carries no "(N)" and the
    // chat list hasn't rendered yet, so both counts read 0. The OS keeps the
    // Dock badge across the reload on its own, so don't clear it during that
    // window — it would blink off and back. Only a "ready" page can be trusted
    // to mean 0 unread. (A non-zero count only happens once ready anyway.)
    const ready = conv
      ? conversations.ready
      : document.readyState === "complete" && (document.title || "").trim().length > 0;
    if (n === null || (n === 0 && !ready)) {
      // Errors must be visible even before Messenger manages to render chats.
      if (isMac && rateLimitRemainingMs() > 0) setBadge(last ?? 0, force);
      return;
    }
    setBadge(n, force);
  };

  window.addEventListener("carrier:thread-mute", (event) => {
    const detail = (event as CustomEvent<{ id?: unknown; muted?: unknown }>).detail;
    if (typeof detail?.muted !== "boolean" || typeof detail.id !== "string") return;
    if (!detail.muted) knownMutedUnreads.invalidate(detail.id);
    // The user's action outranks any database answer read before it.
    stateEpoch++;
    muteActions.set(detail.id, { muted: detail.muted, at: Date.now() });
    if (muteActions.size > THREAD_STATE_LIMIT) {
      muteActions.delete(muteActions.keys().next().value!);
    }
    const cached = threadStates.get(detail.id);
    if (cached) threadStates.set(detail.id, { ...cached, muted: detail.muted });
    // The click is captured before Messenger updates aria-checked/the row icon.
    // Repaint both directions after that render: the old glyph must not add an
    // explicitly unmuted identity back, and muting does not change the title
    // count that normally drives badge updates.
    setTimeout(() => apply(true), 500);
  });

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
  window.addEventListener(RATE_LIMIT_EVENT, () => apply(true));
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
