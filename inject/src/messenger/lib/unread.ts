import { accountScopedStorageKey } from "./threads";

/** Unread messages: Facebook prefixes the page title with "(N)". */
export function unreadCountFromTitle(title: string): number {
  const m = (title || "").match(/^\s*\((\d+)\)/);
  return m ? parseInt(m[1]!, 10) : 0;
}

export function didMutedFilterPolicyChange(previous: boolean | null, current: boolean): boolean {
  return previous !== null && previous !== current;
}

export interface MutedUnreadObservation {
  id: string;
  unread: boolean;
  muted: boolean;
  /** False while the row/list can still be missing preview text or styling. */
  hydrated?: boolean;
}

const MUTED_UNREAD_STORE_VERSION = 1;
const MUTED_UNREAD_STORE_LIMIT = 500;
const VALID_THREAD_ID_RE = /^\d{1,32}$/;
export const MUTED_UNREAD_CLEAR_CONFIRM_MS = 20_000;
export const MUTED_UNREAD_CLEAR_MIN_OBSERVATIONS = 3;

/** Namespace persisted unread evidence to the logged-in Facebook account. */
export function mutedUnreadStorageKey(cookie: string): string | null {
  return accountScopedStorageKey("__carrier_muted_unreads__", cookie);
}

/** Retain each muted unread until that same thread is observed read or unmuted. */
export function reconcileMutedUnreadIds(
  previous: Iterable<string>,
  observed: Iterable<MutedUnreadObservation>,
): Set<string> {
  const next = new Set(previous);
  for (const thread of observed) {
    if (thread.unread && thread.muted) next.add(thread.id);
    else if (thread.hydrated !== false) next.delete(thread.id);
  }
  return next;
}

/**
 * Keeps positive muted-unread evidence across Carrier's periodic page reloads.
 * Missing virtualized rows are inconclusive; a stored id is removed only when
 * that same thread is rendered stably read or unmuted, or the account changes.
 */
export class MutedUnreadStore {
  private ids = new Set<string>();
  private readonly clearCandidates = new Map<string, { since: number; observations: number }>();

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = null,
    private readonly storageKey = "__carrier_muted_unreads__",
  ) {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(this.storageKey) || "null");
      if (
        parsed &&
        typeof parsed === "object" &&
        "version" in parsed &&
        parsed.version === MUTED_UNREAD_STORE_VERSION &&
        "ids" in parsed &&
        Array.isArray(parsed.ids)
      ) {
        for (const id of parsed.ids.slice(-MUTED_UNREAD_STORE_LIMIT)) {
          if (typeof id === "string" && VALID_THREAD_ID_RE.test(id)) this.ids.add(id);
        }
      }
    } catch (_) {}
    this.persist();
  }

  get size(): number {
    return this.ids.size;
  }

  reconcile(observed: Iterable<MutedUnreadObservation>, observedAt = Date.now()): void {
    const rows = [...observed].filter(({ id }) => VALID_THREAD_ID_RE.test(id));
    const observedIds = new Set(rows.map(({ id }) => id));
    for (const id of this.clearCandidates.keys()) {
      if (!observedIds.has(id)) this.clearCandidates.delete(id);
    }
    let changed = false;
    for (const thread of rows) {
      if (thread.unread && thread.muted) {
        this.clearCandidates.delete(thread.id);
        if (!this.ids.has(thread.id)) {
          this.ids.add(thread.id);
          changed = true;
        }
        continue;
      }
      if (thread.hydrated === false) {
        this.clearCandidates.delete(thread.id);
        continue;
      }
      if (!this.ids.has(thread.id)) {
        this.clearCandidates.delete(thread.id);
        continue;
      }
      const candidate = this.clearCandidates.get(thread.id);
      if (candidate === undefined || observedAt < candidate.since) {
        this.clearCandidates.set(thread.id, { since: observedAt, observations: 1 });
        continue;
      }
      candidate.observations += 1;
      if (
        observedAt - candidate.since >= MUTED_UNREAD_CLEAR_CONFIRM_MS &&
        candidate.observations >= MUTED_UNREAD_CLEAR_MIN_OBSERVATIONS
      ) {
        this.clearCandidates.delete(thread.id);
        this.ids.delete(thread.id);
        changed = true;
      }
    }
    while (this.ids.size > MUTED_UNREAD_STORE_LIMIT) {
      const oldest = this.ids.values().next().value!;
      this.ids.delete(oldest);
      this.clearCandidates.delete(oldest);
      changed = true;
    }
    if (changed) this.persist();
  }

  invalidate(id: string): void {
    this.clearCandidates.delete(id);
    if (!this.ids.delete(id)) return;
    this.persist();
  }

  private persist(): void {
    try {
      this.storage?.setItem(
        this.storageKey,
        JSON.stringify({ version: MUTED_UNREAD_STORE_VERSION, ids: [...this.ids] }),
      );
    } catch (_) {}
  }
}

/**
 * The title count can lag behind Messenger's rendered read state (and a
 * parenthesized number later in a thread title is not a badge at all). Once the
 * hydrated chat list is trustworthy, use it to reject a stale zero/non-zero
 * disagreement while preserving the title's per-message total.
 *
 * `mutedUnreadKnown` means Facebook's "(N)" includes muted chats we must not
 * badge: fall back to the unmuted conversation count instead of the title.
 */
export function reconcileUnreadMessageCount(
  titleCount: number,
  unreadConversations: number,
  conversationListTrustworthy: boolean,
  mutedUnreadKnown = false,
  previousFilteredCount: number | null = null,
): number | null {
  // Facebook's "(N)" includes muted chats. Once any muted unread is known,
  // the title total cannot be split, so the unmuted conversation count is
  // the badge. A scrolled virtualized list cannot produce a new trustworthy
  // filtered total, so retain the last filtered result instead of clearing or
  // under-counting it from whichever rows happen to be mounted.
  if (mutedUnreadKnown) {
    return conversationListTrustworthy ? unreadConversations : previousFilteredCount;
  }
  if (!conversationListTrustworthy) return titleCount;
  if (unreadConversations === 0) return 0;
  return Math.max(titleCount, unreadConversations);
}

/** Preserve the last full filtered count while Messenger virtualizes rows. */
export function reconcileUnreadConversationCount(
  unreadConversations: number,
  conversationListTrustworthy: boolean,
  ignoresMuted: boolean,
  previousFilteredCount: number | null,
): number | null {
  return ignoresMuted && !conversationListTrustworthy ? previousFilteredCount : unreadConversations;
}
