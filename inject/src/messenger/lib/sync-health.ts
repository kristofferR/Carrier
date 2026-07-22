export const SYNC_REQUEST_TIMEOUT_MS = 30_000;
export const SYNC_FAILURE_LIMIT = 5;

/**
 * Messenger's data-plane requests. The realtime transport can be healthy
 * (MQTT keepalives flowing) while every one of these fails — the
 * "transport ok but sync silent" state where the app quietly shows stale
 * chats. GraphQL carries thread lists, message history, and delta sync.
 */
export function isMessengerSyncRequest(raw: string | URL, base: string): boolean {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch (_) {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;

  const host = url.hostname.toLowerCase();
  const facebookHost =
    host === "facebook.com" ||
    host.endsWith(".facebook.com") ||
    host === "messenger.com" ||
    host.endsWith(".messenger.com");
  return facebookHost && url.pathname.startsWith("/api/graphql");
}

/** 2xx/3xx answer the query; auth walls, throttles, and errors do not. */
export function syncResponseSucceeded(status: number): boolean {
  return status >= 200 && status < 400;
}

/**
 * Consecutive-failure detector over Messenger's sync requests. A request
 * counts as failed when it rejects, returns a non-2xx/3xx status, or stays
 * outstanding past SYNC_REQUEST_TIMEOUT_MS (sweep). Any success resets the
 * streak, so normal traffic — even with occasional errors — never trips it.
 */
export class SyncHealthTracker {
  private readonly outstanding = new Map<number, number>();
  private nextId = 1;
  private failureStreak = 0;

  started(now: number): number {
    const id = this.nextId++;
    this.outstanding.set(id, now);
    return id;
  }

  succeeded(id: number): void {
    this.outstanding.delete(id);
    this.failureStreak = 0;
  }

  failed(id: number): void {
    this.outstanding.delete(id);
    this.failureStreak += 1;
  }

  /** Count requests hung past the deadline as failures, each once. */
  sweep(now: number): void {
    for (const [id, startedAt] of this.outstanding) {
      if (now - startedAt >= SYNC_REQUEST_TIMEOUT_MS) {
        this.outstanding.delete(id);
        this.failureStreak += 1;
      }
    }
  }

  failing(): boolean {
    return this.failureStreak >= SYNC_FAILURE_LIMIT;
  }

  streak(): number {
    return this.failureStreak;
  }
}
