export interface ConversationSignature {
  key: string;
  signature: string;
}

/** Primes existing unread rows, then reports only new/changed conversations. */
export class ConversationNotificationTracker {
  private readonly signatures = new Map<string, string>();
  private primed = false;

  observe(current: ConversationSignature[], observedKeys?: Iterable<string>): string[] {
    const currentKeys = new Set<string>();
    const changed: string[] = [];
    for (const conversation of current) {
      currentKeys.add(conversation.key);
      const previous = this.signatures.get(conversation.key);
      this.signatures.set(conversation.key, conversation.signature);
      if (this.primed && previous !== undefined && previous !== conversation.signature) {
        changed.push(conversation.key);
      }
    }

    // Messenger virtualizes the list, so absence from this scan does not mean
    // a conversation was read. Forget only rows that were actually rendered
    // and observed without an incoming unread preview.
    for (const key of observedKeys || currentKeys) {
      if (!currentKeys.has(key)) this.signatures.delete(key);
    }
    this.primed = true;
    return changed;
  }
}

interface NotificationText {
  title: string;
  body: string;
}

export interface PageNotificationSignal extends NotificationText {
  at: number;
  /**
   * The native notification id emitted for a page-first Notification (one that
   * fires before its conversation row is known). Kept so the row-driven pairing
   * can attach a reload-safe route to that already-emitted notification.
   */
  nativeId?: number;
}

const normalizeNotificationText = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const matchesExactOrTruncated = (left: string, right: string): boolean => {
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  // The row scraper caps titles at 80 characters and previews at 240. Only
  // accept a prefix as truncation when it is long enough to be distinctive;
  // short previews such as "OK" must still compare exactly.
  return shorter.length >= 40 && longer.startsWith(shorter);
};

// Split a "Sender: message" group preview into its sender and message. The
// sender is null when the value carries no group-sender prefix.
const splitGroupSender = (value: string): { sender: string | null; message: string } => {
  const separator = value.indexOf(": ");
  if (separator <= 0 || separator > 80) return { sender: null, message: value };
  return { sender: value.slice(0, separator), message: value.slice(separator + 2) };
};

/**
 * A content-safe, deterministic identity shared by the page and row-driven
 * notification paths. Hash the original text before privacy redaction so
 * hidden-preview notifications from different conversations stay distinct.
 */
export function notificationDedupeKey(title: string, body: string): string {
  const value = `${normalizeNotificationText(title)}\0${normalizeNotificationText(body)}`;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
}

const NOTIFIED_STORE_LIMIT = 300;
// Messenger can produce many mutation-driven scans within a few hundred
// milliseconds while a reloaded row hydrates. Require a continuously observed
// read state for real elapsed time so those scans cannot erase replay
// suppression merely by arriving in a burst.
export const STABLE_READ_MS = 30_000;
// Once the current document has actually observed the row as unread, a later
// read-looking state is a real transition rather than initial hydration. Keep
// a short confirmation for ordinary styling flicker without suppressing an
// identical new message for the full reload guard.
export const READ_TRANSITION_CONFIRM_MS = 1_000;

/**
 * Remembers the last preview fingerprint (a [[notificationDedupeKey]] hash —
 * never raw text) that produced a native notification per conversation,
 * persisted via the given storage (localStorage in production) so the memory
 * survives the auto-refresh reload and app restarts. Without it, re-priming
 * the trackers after a reload races Facebook's hydration and can re-notify a
 * conversation that has been sitting unread for an hour. Entries are dropped
 * once the conversation is observed read, so a genuinely new message that
 * repeats the same preview text still notifies.
 */
export class NotifiedSignatureStore {
  private readonly entries = new Map<string, string>();
  /** In-memory only: when each continuously observed read state began. */
  private readonly readSince = new Map<string, number>();
  /** Entries whose unread state has been established in this document. */
  private readonly observedUnread = new Set<string>();

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = null,
    private readonly storageKey = "__carrier_notified_previews__",
  ) {
    try {
      const raw = this.storage?.getItem(this.storageKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
          this.entries.set(entry[0], entry[1]);
        }
      }
    } catch (_) {}
    // Persisted state is bounded by persist(), but never trust storage: keep
    // only the newest entries if an oversized payload is ever encountered,
    // and write the trimmed state back so the bound holds at rest too.
    let trimmed = false;
    while (this.entries.size > NOTIFIED_STORE_LIMIT) {
      this.entries.delete(this.entries.keys().next().value!);
      trimmed = true;
    }
    if (trimmed) this.persist();
  }

  private persist(): void {
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify([...this.entries]));
    } catch (_) {}
  }

  alreadyNotified(conversationKey: string, fingerprint: string): boolean {
    return this.entries.get(conversationKey) === fingerprint;
  }

  markNotified(conversationKey: string, fingerprint: string): void {
    // A fresh delivery means the row is unread again — cancel read confirmation.
    this.readSince.delete(conversationKey);
    if (this.entries.get(conversationKey) === fingerprint) return;
    // Re-insert so the map stays ordered oldest-notified-first for eviction.
    this.entries.delete(conversationKey);
    this.entries.set(conversationKey, fingerprint);
    while (this.entries.size > NOTIFIED_STORE_LIMIT) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
      this.readSince.delete(oldest);
      this.observedUnread.delete(oldest);
    }
    this.persist();
  }

  /**
   * Forget conversations that are rendered without an unread preview — the
   * user has read them, so an identical future preview must notify again.
   * Persisted entries must remain continuously observed read for
   * [[STABLE_READ_MS]] until this document has first established their unread
   * state. After that, [[READ_TRANSITION_CONFIRM_MS]] is enough to confirm a
   * real unread-to-read transition. An unread or missing observation resets
   * the timer so virtualized rows cannot accumulate read time off-screen.
   */
  observeRead(
    unreadKeys: ReadonlySet<string>,
    observedKeys: Iterable<string>,
    observedAt = Date.now(),
  ): void {
    let dropped = false;
    const observed = new Set(observedKeys);
    for (const key of this.readSince.keys()) {
      if (!observed.has(key)) this.readSince.delete(key);
    }
    for (const key of observed) {
      if (unreadKeys.has(key)) {
        this.readSince.delete(key);
        if (this.entries.has(key)) this.observedUnread.add(key);
        continue;
      }
      if (!this.entries.has(key)) continue;
      const since = this.readSince.get(key);
      if (since === undefined || observedAt < since) {
        // A backwards wall-clock adjustment restarts confirmation rather than
        // making an entry look older than it is.
        this.readSince.set(key, observedAt);
        continue;
      }
      const confirmAfter = this.observedUnread.has(key)
        ? READ_TRANSITION_CONFIRM_MS
        : STABLE_READ_MS;
      if (observedAt - since < confirmAfter) {
        continue;
      }
      this.readSince.delete(key);
      this.observedUnread.delete(key);
      this.entries.delete(key);
      dropped = true;
    }
    if (dropped) this.persist();
  }
}

/** Keeps concurrent page signals until their matching row update arrives. */
export class PageNotificationQueue {
  private readonly signals: PageNotificationSignal[] = [];

  add(signal: PageNotificationSignal): PageNotificationSignal {
    this.signals.push(signal);
    if (this.signals.length > 20) this.signals.shift();
    return signal;
  }

  /**
   * Return (and remove) the queued page signal that matches this row, or null.
   * Returning the signal — rather than a boolean — lets the caller reach its
   * `nativeId` and route the already-emitted page-first notification.
   */
  consumeMatching(
    row: NotificationText,
    rowChangeAt: number,
    matchWindowMs: number,
  ): PageNotificationSignal | null {
    for (let index = this.signals.length - 1; index >= 0; index--) {
      const signal = this.signals[index]!;
      const age = rowChangeAt - signal.at;
      if (age > matchWindowMs) {
        this.signals.splice(index, 1);
        continue;
      }
      if (age >= 0 && notificationTextMatches(signal.title, signal.body, row.title, row.body)) {
        this.signals.splice(index, 1);
        return signal;
      }
    }
    return null;
  }
}

/** Correlates unread-count increases with the rows most recently mutated. */
export class UnreadArrivalTracker {
  private readonly changedAt = new Map<string, number>();
  private unreadCount: number | null = null;

  markRowsChanged(keys: Iterable<string>, at: number): void {
    for (const key of keys) this.changedAt.set(key, at);
  }

  observeUnreadCount(count: number, at: number, maxMutationAgeMs: number): string[] {
    for (const [key, changedAt] of this.changedAt) {
      if (at - changedAt > maxMutationAgeMs) this.changedAt.delete(key);
    }

    const previous = this.unreadCount;
    this.unreadCount = count;
    if (previous === null || count <= previous) return [];

    const candidates = [...this.changedAt]
      .sort((left, right) => right[1] - left[1])
      .slice(0, count - previous)
      .map(([key]) => key);
    for (const key of candidates) this.changedAt.delete(key);
    return candidates;
  }
}

/** Best-effort suppression for previews produced by the signed-in user. */
export function isOwnMessagePreview(value: string): boolean {
  return /^(?:you|du|me|meg):|^(?:you|du|me|meg)\s+(?:sent|replied|forwarded|reacted|sendte|svarte|videresendte|reagerte)\b/i.test(
    value.trim().replace(/\s+/g, " "),
  );
}

/** Whether page and row signals describe the same conversation update. */
export function notificationTextMatches(
  pageTitle: string,
  pageBody: string,
  rowTitle: string,
  rowBody: string,
): boolean {
  const normalizedPageTitle = normalizeNotificationText(pageTitle);
  const normalizedRowTitle = normalizeNotificationText(rowTitle);
  const titlesMatch = matchesExactOrTruncated(normalizedPageTitle, normalizedRowTitle);
  const normalizedPageBody = normalizeNotificationText(pageBody);
  const normalizedRowBody = normalizeNotificationText(rowBody);
  const page = splitGroupSender(normalizedPageBody);
  const row = splitGroupSender(normalizedRowBody);
  // Compare with the group-sender prefix stripped only when that cannot conflate
  // two different senders: at least one side must lack a prefix (so "Jane: OK"
  // pairs with a bare "OK"), or both prefixes must name the same sender.
  // Otherwise "Jane: OK" and "John: OK" — different members sending the same
  // short text — would wrongly pair and suppress one native notification.
  const sendersCompatible =
    page.sender === null || row.sender === null || page.sender === row.sender;
  return (
    titlesMatch &&
    (!normalizedPageBody ||
      !normalizedRowBody ||
      matchesExactOrTruncated(normalizedPageBody, normalizedRowBody) ||
      (sendersCompatible && matchesExactOrTruncated(page.message, row.message)))
  );
}
