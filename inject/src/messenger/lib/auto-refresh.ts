export const PERIODIC_REFRESH_MS = 15 * 60 * 1000;
export const NOTIFICATION_REFRESH_GAP_MS = 5 * 60 * 1000;
export const RESUME_GAP_MS = 20_000;

export type RefreshReason = "background" | "foreground" | "realtime" | "resume";

const elapsed = (now: number, since: number) => Math.max(0, now - since);

/**
 * Tracks the lifecycle signals that make Messenger's live connection suspect.
 * Visibility alone is intentionally not considered activity: a Carrier window
 * can remain visible for hours while another app is frontmost.
 */
export class AutoRefreshWatchdog {
  private inactiveSince: number | null;
  private lastHeartbeatAt: number;
  private lastFreshAt: number;

  constructor(now: number, active: boolean) {
    this.lastFreshAt = now;
    this.lastHeartbeatAt = now;
    this.inactiveSince = active ? null : now;
  }

  setActive(active: boolean, now: number): RefreshReason | null {
    if (!active) {
      this.inactiveSince ??= now;
      return null;
    }

    const inactiveFor = this.inactiveSince === null ? 0 : elapsed(now, this.inactiveSince);
    this.inactiveSince = null;
    this.lastFreshAt = Math.max(this.lastFreshAt, now);
    return inactiveFor >= PERIODIC_REFRESH_MS ? "foreground" : null;
  }

  heartbeat(active: boolean, now: number): RefreshReason | null {
    const heartbeatGap = elapsed(now, this.lastHeartbeatAt);
    this.lastHeartbeatAt = Math.max(this.lastHeartbeatAt, now);

    const transition = this.setActive(active, now);
    if (heartbeatGap >= RESUME_GAP_MS) return "resume";
    if (transition) return transition;

    if (
      !active &&
      this.inactiveSince !== null &&
      elapsed(now, this.inactiveSince) >= PERIODIC_REFRESH_MS
    ) {
      return "background";
    }
    return null;
  }

  canRefreshFromNotification(now: number): boolean {
    return elapsed(now, this.lastFreshAt) >= NOTIFICATION_REFRESH_GAP_MS;
  }
}
