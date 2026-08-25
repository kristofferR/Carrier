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
}

const MUTED_UNREAD_STORE_VERSION = 1;
const MUTED_UNREAD_STORE_LIMIT = 500;
const VALID_THREAD_ID_RE = /^\d{1,32}$/;

/** Retain each muted unread until that same thread is observed read or unmuted. */
export function reconcileMutedUnreadIds(
  previous: Iterable<string>,
  observed: Iterable<MutedUnreadObservation>,
): Set<string> {
  const next = new Set(previous);
  for (const thread of observed) {
    if (thread.unread && thread.muted) next.add(thread.id);
    else next.delete(thread.id);
  }
  return next;
}

/**
 * Keeps positive muted-unread evidence across Carrier's periodic page reloads.
 * Missing virtualized rows are inconclusive; a stored id is removed only when
 * that same thread is rendered read or unmuted, or the filtering policy resets.
 */
export class MutedUnreadStore {
  private ids = new Set<string>();

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

  reconcile(observed: Iterable<MutedUnreadObservation>): void {
    const next = reconcileMutedUnreadIds(this.ids, observed);
    while (next.size > MUTED_UNREAD_STORE_LIMIT) next.delete(next.values().next().value!);
    if (next.size === this.ids.size && [...next].every((id) => this.ids.has(id))) return;
    this.ids = next;
    this.persist();
  }

  clear(): void {
    if (this.ids.size === 0) return;
    this.ids.clear();
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
