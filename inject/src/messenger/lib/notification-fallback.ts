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
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const titlesMatch = normalize(pageTitle) === normalize(rowTitle);
  const normalizedPageBody = normalize(pageBody);
  const normalizedRowBody = normalize(rowBody);
  return (
    titlesMatch &&
    (!normalizedPageBody || !normalizedRowBody || normalizedPageBody === normalizedRowBody)
  );
}
