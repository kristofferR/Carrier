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

interface PageNotificationSignal extends NotificationText {
  at: number;
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

const withoutGroupSender = (value: string): string => {
  const separator = value.indexOf(": ");
  if (separator <= 0 || separator > 80) return value;
  return value.slice(separator + 2);
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
// Consecutive read observations required before a delivered entry is dropped —
// hydration can transiently render an unread row as read, and a single such
// flicker must not clear the replay suppression.
const STABLE_READ_SCANS = 3;

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
  /** In-memory only: read-observation streaks per conversation (see observeRead). */
  private readonly readStreak = new Map<string, number>();

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
    // A fresh delivery means the row is unread again — restart read counting.
    this.readStreak.delete(conversationKey);
    if (this.entries.get(conversationKey) === fingerprint) return;
    // Re-insert so the map stays ordered oldest-notified-first for eviction.
    this.entries.delete(conversationKey);
    this.entries.set(conversationKey, fingerprint);
    while (this.entries.size > NOTIFIED_STORE_LIMIT) {
      const oldest = this.entries.keys().next().value!;
      this.entries.delete(oldest);
      this.readStreak.delete(oldest);
    }
    this.persist();
  }

  /**
   * Forget conversations that are rendered without an unread preview — the
   * user has read them, so an identical future preview must notify again.
   * Requires STABLE_READ_SCANS consecutive read observations (an unread
   * observation resets the count) because hydration can transiently render
   * an unread row as read, and one flicker must not clear the suppression.
   */
  observeRead(unreadKeys: ReadonlySet<string>, observedKeys: Iterable<string>): void {
    let dropped = false;
    // Dedupe: the DOM can briefly render two anchors for one thread, and a
    // key must count as at most one observation per scan.
    for (const key of new Set(observedKeys)) {
      if (unreadKeys.has(key)) {
        this.readStreak.delete(key);
        continue;
      }
      if (!this.entries.has(key)) continue;
      const streak = (this.readStreak.get(key) || 0) + 1;
      if (streak < STABLE_READ_SCANS) {
        this.readStreak.set(key, streak);
        continue;
      }
      this.readStreak.delete(key);
      this.entries.delete(key);
      dropped = true;
    }
    if (dropped) this.persist();
  }
}

/** Keeps concurrent page signals until their matching row update arrives. */
export class PageNotificationQueue {
  private readonly signals: PageNotificationSignal[] = [];

  add(signal: PageNotificationSignal): void {
    this.signals.push(signal);
    if (this.signals.length > 20) this.signals.shift();
  }

  consumeMatching(row: NotificationText, rowChangeAt: number, matchWindowMs: number): boolean {
    for (let index = this.signals.length - 1; index >= 0; index--) {
      const signal = this.signals[index]!;
      const age = rowChangeAt - signal.at;
      if (age > matchWindowMs) {
        this.signals.splice(index, 1);
        continue;
      }
      if (age >= 0 && notificationTextMatches(signal.title, signal.body, row.title, row.body)) {
        this.signals.splice(index, 1);
        return true;
      }
    }
    return false;
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
  const pageWithoutSender = withoutGroupSender(normalizedPageBody);
  const rowWithoutSender = withoutGroupSender(normalizedRowBody);
  return (
    titlesMatch &&
    (!normalizedPageBody ||
      !normalizedRowBody ||
      matchesExactOrTruncated(normalizedPageBody, normalizedRowBody) ||
      matchesExactOrTruncated(pageWithoutSender, rowWithoutSender))
  );
}
