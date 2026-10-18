/** Messenger's own socket retries back off to 60 seconds; allow two rounds. */
export const STUCK_WORKER_RELOAD_MS = 120_000;
/** Reload even if the reachability probe never succeeds, so a probe fault cannot strand the page. */
export const STUCK_WORKER_MAX_MS = 600_000;
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
// Captured at document start, before Facebook wraps the scheduling APIs.
const nativeSetTimeout = setTimeout.bind(globalThis);
const nativeClearTimeout = clearTimeout.bind(globalThis);

/** Any HTTP answer from facebook.com proves the network path; only failures and timeouts do not. */
export async function probeFacebook(fetch: typeof globalThis.fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = nativeSetTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch("/favicon.ico", {
      method: "HEAD",
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    return true;
  } catch (_) {
    return false;
  } finally {
    nativeClearTimeout(timer);
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
    if (this.reachableSince !== undefined && now - this.reachableSince >= STUCK_WORKER_RELOAD_MS) {
      return "reachable";
    }
    return now - this.stuckSince >= STUCK_WORKER_MAX_MS ? "timeout" : undefined;
  }
}
