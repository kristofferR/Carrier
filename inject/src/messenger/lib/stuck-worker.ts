/** Messenger's own socket retries back off to 60 seconds; allow two rounds. */
export const STUCK_WORKER_RELOAD_MS = 120_000;
/** Reload even if the reachability probe never succeeds, so a probe fault cannot strand the page. */
export const STUCK_WORKER_MAX_MS = 600_000;
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
const SECOND_PROBE_URL = "https://m.facebook.com/favicon.ico";
// Captured at document start, before Facebook wraps the scheduling APIs.
const nativeSetTimeout = setTimeout.bind(globalThis);
const nativeClearTimeout = clearTimeout.bind(globalThis);

/**
 * Any HTTP answer from Facebook proves the network path; only failures and
 * timeouts do not. After a network change WebKit keeps sending same-host
 * requests down the dead pooled connection for about 44 seconds, so race a
 * second host, which has to open a fresh connection.
 */
export async function probeFacebook(fetch: typeof globalThis.fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = nativeSetTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const request = (url: string, init: RequestInit) =>
    fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      ...init,
      signal: controller.signal,
    });
  try {
    // First answer wins, like Promise.any (absent before Safari 14).
    return await new Promise<boolean>((resolve) => {
      let failures = 0;
      const probes = [
        request("/favicon.ico", { method: "HEAD" }),
        // Cross-origin, so no-cors: an opaque response still proves
        // reachability. Fetch rejects no-cors requests that don't follow
        // redirects, so this one does.
        request(SECOND_PROBE_URL, { mode: "no-cors", redirect: "follow" }),
      ];
      for (const probe of probes) {
        probe.then(
          () => resolve(true),
          () => {
            if (++failures === probes.length) resolve(false);
          },
        );
      }
    });
  } catch (_) {
    return false;
  } finally {
    nativeClearTimeout(timer);
    controller.abort();
  }
}

/**
 * Decides when a stuck dedicated worker's page should reload. Waiting while
 * Facebook is unreachable avoids reloading into an outage; requiring Facebook
 * to answer for two retry rounds first lets the worker reconnect on its own.
 * Every reloaded document must collect this evidence again, which spaces any
 * repeats minutes apart. There is deliberately no backoff or give-up cap: a
 * page left broken is worse than steady retries (see docs/sync-recovery.md).
 */
export class StuckWorkerReload {
  private stuckSince: number | undefined;
  private reachableSince: number | undefined;
  private lastProbeAt: number | undefined;
  private probing = false;
  private episode = 0;

  constructor(
    private readonly probe: () => Promise<boolean>,
    private readonly now: () => number,
  ) {}

  reset(): void {
    this.episode++;
    this.stuckSince = undefined;
    this.reachableSince = undefined;
    this.lastProbeAt = undefined;
  }

  /** Call while the worker stays stuck; returns why a reload is now due. */
  due(): "reachable" | "timeout" | undefined {
    const now = this.now();
    this.stuckSince ??= now;
    if (
      !this.probing &&
      (this.lastProbeAt === undefined || now - this.lastProbeAt >= PROBE_INTERVAL_MS)
    ) {
      this.probing = true;
      this.lastProbeAt = now;
      const episode = this.episode;
      void this.probe()
        .catch(() => false)
        .then((reachable) => {
          if (episode !== this.episode) return;
          if (reachable) this.reachableSince ??= this.now();
          else this.reachableSince = undefined;
        })
        .finally(() => {
          this.probing = false;
        });
    }
    if (
      !this.probing &&
      this.reachableSince !== undefined &&
      now - this.reachableSince >= STUCK_WORKER_RELOAD_MS
    ) {
      return "reachable";
    }
    return now - this.stuckSince >= STUCK_WORKER_MAX_MS ? "timeout" : undefined;
  }
}
