export const SYNC_REQUEST_TIMEOUT_MS = 30_000;
export const SYNC_WINDOW_MS = 180_000;
export const SYNC_FAILURE_FLOOR = 5;

/**
 * Messenger's data-plane requests. The realtime transport can be healthy
 * (MQTT keepalives flowing) while these fail — the "transport ok but sync
 * silent" state where the app quietly shows stale chats. GraphQL carries
 * thread lists, message history, and delta sync.
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
 * Rolling-window failure detector over Messenger's sync requests. A request
 * counts as failed when it rejects, returns a non-2xx/3xx status, or stays
 * outstanding past SYNC_REQUEST_TIMEOUT_MS (sweep). Sync is degraded when the
 * window holds at least SYNC_FAILURE_FLOOR failures and failures outnumber
 * successes — which catches both a total blackout and a brownout where some
 * queries still succeed (observed in Meta's 2026-07-22 outage: the unread
 * badge updated while every thread query hung), yet normal traffic with
 * sporadic errors can never trip it.
 */
export class SyncHealthTracker {
  private readonly outstanding = new Map<number, number>();
  private outcomes: Array<{ at: number; ok: boolean }> = [];
  private nextId = 1;

  started(now: number): number {
    const id = this.nextId++;
    this.outstanding.set(id, now);
    return id;
  }

  succeeded(id: number, now: number): void {
    this.outstanding.delete(id);
    this.outcomes.push({ at: now, ok: true });
  }

  failed(id: number, now: number): void {
    this.outstanding.delete(id);
    this.outcomes.push({ at: now, ok: false });
  }

  /** Count requests hung past the deadline as failures, each once. */
  sweep(now: number): void {
    for (const [id, startedAt] of this.outstanding) {
      if (now - startedAt >= SYNC_REQUEST_TIMEOUT_MS) {
        this.outstanding.delete(id);
        this.outcomes.push({ at: now, ok: false });
      }
    }
    this.outcomes = this.outcomes.filter((outcome) => now - outcome.at < SYNC_WINDOW_MS);
  }

  private counts(now: number): { ok: number; bad: number } {
    let ok = 0;
    let bad = 0;
    for (const outcome of this.outcomes) {
      if (now - outcome.at >= SYNC_WINDOW_MS) continue;
      if (outcome.ok) ok += 1;
      else bad += 1;
    }
    return { ok, bad };
  }

  degraded(now: number): boolean {
    const { ok, bad } = this.counts(now);
    return bad >= SYNC_FAILURE_FLOOR && bad > ok;
  }

  /** Content-free description of the current window for diagnostics. */
  summary(now: number): string {
    const { ok, bad } = this.counts(now);
    return `${bad} failed / ${ok} ok in window`;
  }
}
