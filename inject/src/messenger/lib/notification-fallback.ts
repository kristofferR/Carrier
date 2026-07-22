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

const hashText = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, "0");
};

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
  return hashText(value);
}

const NOTIFIED_STORE_LIMIT = 300;
const NOTIFIED_STORE_VERSION = 2;
const LEGACY_PLACEHOLDER_BODY = "New message";
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

interface NotifiedEntry {
  fingerprint: string;
  /** Loaded from the unversioned schema that could persist placeholder text. */
  legacy: boolean;
}

export type FingerprintReconciliation = "missing" | "matched" | "migrated" | "mismatched";

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
  private readonly entries = new Map<string, NotifiedEntry>();
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
      const legacy = Array.isArray(parsed);
      const persistedEntries = legacy
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            "version" in parsed &&
            parsed.version === NOTIFIED_STORE_VERSION &&
            "entries" in parsed &&
            Array.isArray(parsed.entries)
          ? parsed.entries
          : [];
      for (const entry of persistedEntries) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          (legacy || typeof entry[2] === "boolean")
        ) {
          this.entries.set(entry[0], { fingerprint: entry[1], legacy: legacy || entry[2] });
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
      this.storage?.setItem(
        this.storageKey,
        JSON.stringify({
          version: NOTIFIED_STORE_VERSION,
          entries: [...this.entries].map(([key, entry]) => [key, entry.fingerprint, entry.legacy]),
        }),
      );
    } catch (_) {}
  }

  alreadyNotified(conversationKey: string, fingerprint: string): boolean {
    return this.entries.get(conversationKey)?.fingerprint === fingerprint;
  }

  /** The fingerprint last delivered for this conversation, if any. */
  notifiedFingerprint(conversationKey: string): string | undefined {
    return this.entries.get(conversationKey)?.fingerprint;
  }

  /**
   * Compare a hydrated row with its persisted delivery. Old unversioned entries
   * may contain the synthetic "New message" body from pre-v2 hydration scans;
   * migrate only those proven-legacy placeholders, never a new-schema message
   * whose real text happens to be the same phrase.
   */
  reconcileFingerprint(
    conversationKey: string,
    title: string,
    fingerprint: string,
  ): FingerprintReconciliation {
    const entry = this.entries.get(conversationKey);
    if (!entry) return "missing";
    if (entry.fingerprint === fingerprint) {
      if (entry.legacy) {
        entry.legacy = false;
        this.persist();
      }
      return "matched";
    }
    const legacyPlaceholder =
      entry.legacy &&
      (entry.fingerprint === notificationDedupeKey(title, LEGACY_PLACEHOLDER_BODY) ||
        entry.fingerprint === notificationDedupeKey("Messenger", LEGACY_PLACEHOLDER_BODY));
    if (!legacyPlaceholder) return "mismatched";
    entry.fingerprint = fingerprint;
    entry.legacy = false;
    this.persist();
    return "migrated";
  }

  markNotified(conversationKey: string, fingerprint: string): void {
    // A fresh delivery means the row is unread again — cancel read confirmation.
    this.readSince.delete(conversationKey);
    const current = this.entries.get(conversationKey);
    if (current?.fingerprint === fingerprint && !current.legacy) return;
    // Re-insert so the map stays ordered oldest-notified-first for eviction.
    this.entries.delete(conversationKey);
    this.entries.set(conversationKey, { fingerprint, legacy: false });
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

const HASH_RE = /^[0-9a-f]{16}$/;
const MIN_TRUNCATED_MATCH_LENGTH = 40;
const TITLE_PREFIX_LIMIT = 80;
const BODY_PREFIX_LIMIT = 240;
const PAGE_RECEIPT_LIMIT = 20;
export const PAGE_NOTIFICATION_RECEIPT_TTL_MS = 120_000;

interface OpaqueTextIdentity {
  length: number;
  full: string;
  prefixes: [number, string][];
}

interface OpaqueNotificationIdentity {
  title: OpaqueTextIdentity;
  body: OpaqueTextIdentity;
  sender: string | null;
  message: OpaqueTextIdentity;
}

interface PageNotificationReceipt {
  at: number;
  nativeId: number;
  identity: OpaqueNotificationIdentity;
}

const opaqueTextIdentity = (value: string, prefixLimit: number): OpaqueTextIdentity => {
  const prefixes: [number, string][] = [];
  const lastPrefix = Math.min(value.length - 1, prefixLimit);
  for (let length = MIN_TRUNCATED_MATCH_LENGTH; length <= lastPrefix; length++) {
    prefixes.push([length, hashText(value.slice(0, length))]);
  }
  return { length: value.length, full: hashText(value), prefixes };
};

const opaqueNotificationIdentity = (title: string, body: string): OpaqueNotificationIdentity => {
  const normalizedTitle = normalizeNotificationText(title);
  const normalizedBody = normalizeNotificationText(body);
  const group = splitGroupSender(normalizedBody);
  return {
    title: opaqueTextIdentity(normalizedTitle, TITLE_PREFIX_LIMIT),
    body: opaqueTextIdentity(normalizedBody, BODY_PREFIX_LIMIT),
    sender: group.sender === null ? null : hashText(group.sender),
    message: opaqueTextIdentity(group.message, BODY_PREFIX_LIMIT),
  };
};

const opaqueTextMatches = (left: OpaqueTextIdentity, right: OpaqueTextIdentity): boolean => {
  if (left.full === right.full) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < MIN_TRUNCATED_MATCH_LENGTH) return false;
  return longer.prefixes.some(
    ([length, fingerprint]) => length === shorter.length && fingerprint === shorter.full,
  );
};

const opaqueNotificationMatches = (
  left: OpaqueNotificationIdentity,
  right: OpaqueNotificationIdentity,
): boolean => {
  if (!opaqueTextMatches(left.title, right.title)) return false;
  if (left.body.length === 0 || right.body.length === 0) return true;
  if (opaqueTextMatches(left.body, right.body)) return true;
  const sendersCompatible =
    left.sender === null || right.sender === null || left.sender === right.sender;
  return sendersCompatible && opaqueTextMatches(left.message, right.message);
};

const validOpaqueTextIdentity = (
  value: unknown,
  prefixLimit: number,
): value is OpaqueTextIdentity => {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<OpaqueTextIdentity>;
  return (
    Number.isSafeInteger(identity.length) &&
    identity.length! >= 0 &&
    typeof identity.full === "string" &&
    HASH_RE.test(identity.full) &&
    Array.isArray(identity.prefixes) &&
    identity.prefixes.length <= prefixLimit - MIN_TRUNCATED_MATCH_LENGTH + 1 &&
    identity.prefixes.every(
      (prefix) =>
        Array.isArray(prefix) &&
        Number.isSafeInteger(prefix[0]) &&
        prefix[0] >= MIN_TRUNCATED_MATCH_LENGTH &&
        prefix[0] <= prefixLimit &&
        prefix[0] < identity.length! &&
        typeof prefix[1] === "string" &&
        HASH_RE.test(prefix[1]),
    )
  );
};

const validOpaqueNotificationIdentity = (value: unknown): value is OpaqueNotificationIdentity => {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<OpaqueNotificationIdentity>;
  return (
    validOpaqueTextIdentity(identity.title, TITLE_PREFIX_LIMIT) &&
    validOpaqueTextIdentity(identity.body, BODY_PREFIX_LIMIT) &&
    validOpaqueTextIdentity(identity.message, BODY_PREFIX_LIMIT) &&
    (identity.sender === null ||
      (typeof identity.sender === "string" && HASH_RE.test(identity.sender)))
  );
};

/**
 * Short-lived, content-opaque receipts for page notifications. They survive a
 * reload so the first hydrated row can attach its route and mark the per-thread
 * fingerprint without waiting long enough to leak a fallback duplicate.
 */
export class PageNotificationReceiptStore {
  private readonly receipts: PageNotificationReceipt[] = [];

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = null,
    private readonly storageKey = "__carrier_page_notification_receipts__",
    private readonly ttlMs = PAGE_NOTIFICATION_RECEIPT_TTL_MS,
    now = Date.now(),
  ) {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(this.storageKey) || "[]");
      if (Array.isArray(parsed)) {
        for (const receipt of parsed) {
          if (!receipt || typeof receipt !== "object") continue;
          const candidate = receipt as Partial<PageNotificationReceipt>;
          if (
            typeof candidate.at === "number" &&
            Number.isFinite(candidate.at) &&
            typeof candidate.nativeId === "number" &&
            Number.isSafeInteger(candidate.nativeId) &&
            candidate.nativeId > 0 &&
            validOpaqueNotificationIdentity(candidate.identity) &&
            now - candidate.at >= 0 &&
            now - candidate.at <= this.ttlMs
          ) {
            this.receipts.push(candidate as PageNotificationReceipt);
          }
        }
      }
    } catch (_) {}
    if (this.receipts.length > PAGE_RECEIPT_LIMIT) {
      this.receipts.splice(0, this.receipts.length - PAGE_RECEIPT_LIMIT);
    }
    this.persist();
  }

  private persist(): void {
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(this.receipts));
    } catch (_) {}
  }

  private prune(now: number): void {
    let changed = false;
    for (let index = this.receipts.length - 1; index >= 0; index--) {
      const age = now - this.receipts[index]!.at;
      if (age < 0 || age > this.ttlMs) {
        this.receipts.splice(index, 1);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  add(title: string, body: string, nativeId: number, at = Date.now()): void {
    this.prune(at);
    this.receipts.push({ at, nativeId, identity: opaqueNotificationIdentity(title, body) });
    if (this.receipts.length > PAGE_RECEIPT_LIMIT) this.receipts.shift();
    this.persist();
  }

  consumeMatching(row: NotificationText, now = Date.now()): { nativeId: number } | null {
    this.prune(now);
    if (!this.receipts.length) return null;
    const identity = opaqueNotificationIdentity(row.title, row.body);
    for (let index = this.receipts.length - 1; index >= 0; index--) {
      const receipt = this.receipts[index]!;
      if (!opaqueNotificationMatches(receipt.identity, identity)) continue;
      this.receipts.splice(index, 1);
      this.persist();
      return { nativeId: receipt.nativeId };
    }
    return null;
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

/**
 * Reports a conversation whose current preview fingerprint has stably diverged
 * from the one [[NotifiedSignatureStore]] last delivered — meaning new content
 * arrived since that delivery (typically while a reload was in flight, when
 * every in-memory tracker primes silently and would otherwise stay quiet).
 * Requiring the same fingerprint for real elapsed time keeps rapid hydration
 * scans from satisfying the guard. The returned confirmation delay lets the
 * caller schedule proof promptly instead of waiting for a hidden-window poll.
 */
export class StableMismatchTracker {
  private readonly streaks = new Map<
    string,
    { fingerprint: string; since: number; reported: boolean }
  >();

  constructor(private readonly stableMs: number) {}

  observe(
    mismatches: Iterable<readonly [string, string]>,
    at = Date.now(),
  ): { recovered: string[]; confirmInMs: number | null } {
    const seen = new Set<string>();
    const recovered: string[] = [];
    let confirmInMs: number | null = null;
    for (const [key, fingerprint] of mismatches) {
      // The DOM can briefly render two anchors for one thread; a key counts
      // as at most one observation per scan or a duplicate could reach the
      // stability threshold in a single scan.
      if (seen.has(key)) continue;
      seen.add(key);
      const streak = this.streaks.get(key);
      if (streak?.fingerprint === fingerprint) {
        if (at < streak.since) {
          streak.since = at;
          streak.reported = false;
        }
        const remaining = Math.max(0, this.stableMs - (at - streak.since));
        if (!streak.reported && remaining === 0) {
          streak.reported = true;
          recovered.push(key);
        } else if (!streak.reported) {
          confirmInMs = confirmInMs === null ? remaining : Math.min(confirmInMs, remaining);
        }
        continue;
      }
      const reported = this.stableMs === 0;
      this.streaks.set(key, { fingerprint, since: at, reported });
      if (reported) {
        recovered.push(key);
      } else {
        confirmInMs = confirmInMs === null ? this.stableMs : Math.min(confirmInMs, this.stableMs);
      }
    }
    // A key no longer mismatching (delivered, read, or re-hydrated to match)
    // restarts from scratch if it ever diverges again.
    for (const key of this.streaks.keys()) {
      if (!seen.has(key)) this.streaks.delete(key);
    }
    return { recovered, confirmInMs };
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
