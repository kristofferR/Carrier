export const REALTIME_CONNECT_GRACE_MS = 15_000;
export const REALTIME_SILENCE_MS = 90_000;
export const REALTIME_NEVER_CONNECTED_MS = 90_000;
/**
 * How recently another source must have reported healthy for it to vouch for
 * a source that reports stale. Comfortably longer than the five-second health
 * tick, so an in-flight worker probe never leaves a gap a stale socket could
 * exploit.
 */
export const REALTIME_CORROBORATION_MS = 30_000;
/**
 * How long a previously healthy transport may go with no source able to
 * confirm it before that silence is treated as a fault in its own right.
 *
 * Reached when the worker bridge is unavailable *and* the page owns no socket:
 * nobody reports stale, so without this the tracker would sit on its last
 * "ok" forever and disarm both page-side and native recovery while the inbox
 * quietly froze. Deliberately far longer than the recovery gap — this is the
 * last resort for a case nothing else can see, not a routine trigger.
 */
export const REALTIME_UNOBSERVED_MS = 300_000;

export type RealtimeHealth = "healthy" | "recovering" | "stale" | "starting";
export type RealtimeHealthSource = "socket" | "worker";
/**
 * Transport status reported to the native watchdog in every heartbeat.
 * "never" flags a page whose realtime transport has not connected once since
 * load — the state where both health sources are mute and only the native
 * side (which can check DNS and rebuild the webview) can still recover.
 * "error" flags Facebook's static error document, which is unambiguous the
 * moment it renders and gets a much faster native recovery ladder.
 */
export type RealtimeStatus = "ok" | "pending" | "stale" | "never" | "error";

/**
 * Facebook's static "Sorry, something went wrong." document, served in place
 * of Messenger. Detection is structural (its `#back` / `#icon` skeleton on a
 * near-empty page) rather than textual, because the page is localized. A miss
 * just falls back to the slower never-connected path.
 */
export function looksLikeFacebookErrorPage(doc: {
  hasBackLink: boolean;
  hasIconImage: boolean;
  elementCount: number;
}): boolean {
  return doc.hasBackLink && doc.hasIconImage && doc.elementCount < 100;
}

type SocketState = {
  state: "connecting" | "open";
  since: number;
  lastInboundAt: number;
};

const elapsed = (now: number, since: number) => Math.max(0, now - since);

export class ConsecutiveFailureThreshold {
  private failures = 0;

  constructor(private readonly limit: number) {}

  succeeded(): void {
    this.failures = 0;
  }

  failed(): boolean {
    this.failures += 1;
    return this.failures >= this.limit;
  }
}

export class RealtimeRecoveryTracker {
  private readonly staleSources = new Set<RealtimeHealthSource>();
  private readonly lastHealthyAt = new Map<RealtimeHealthSource, number>();
  private everHealthy = false;

  constructor(private readonly startedAt: number) {}

  healthy(source: RealtimeHealthSource, at = Date.now()): void {
    this.everHealthy = true;
    this.lastHealthyAt.set(source, at);
    this.staleSources.delete(source);
  }

  stale(source: RealtimeHealthSource): void {
    this.staleSources.add(source);
  }

  /**
   * Withdraw a source's verdict without claiming health — it can no longer
   * observe the transport at all (e.g. the page owns no realtime socket). An
   * unobservable source must not keep asserting the staleness it reported
   * while it could still see something.
   */
  withdraw(source: RealtimeHealthSource): void {
    this.staleSources.delete(source);
  }

  /**
   * Recovery is only warranted when no source can still vouch for the
   * transport. A recently healthy source proves messages are flowing, so a
   * different source's staleness must not force a reload on its own — a dead
   * page socket alongside a responsive worker is the normal shape of current
   * Messenger, not a fault.
   */
  needsRecovery(now = Date.now()): boolean {
    if (this.staleSources.size === 0) return this.unobserved(now);
    for (const [source, at] of this.lastHealthyAt) {
      if (this.staleSources.has(source)) continue;
      if (elapsed(now, at) <= REALTIME_CORROBORATION_MS) return false;
    }
    return true;
  }

  /**
   * A transport that was healthy but that no source has been able to confirm
   * for [[REALTIME_UNOBSERVED_MS]]. Not knowing is not the same as being fine,
   * so this still warrants recovery. A page that never connected at all is
   * excluded — [[status]] already reports that as "never".
   */
  private unobserved(now: number): boolean {
    if (!this.everHealthy) return false;
    let lastConfirmedAt: number | null = null;
    for (const at of this.lastHealthyAt.values()) {
      if (lastConfirmedAt === null || at > lastConfirmedAt) lastConfirmedAt = at;
    }
    if (lastConfirmedAt === null) return false;
    return elapsed(now, lastConfirmedAt) >= REALTIME_UNOBSERVED_MS;
  }

  // "pending" (fresh page, transport still unproven) deliberately differs from
  // "ok": the native side pauses its bad-transport timer on both, but only a
  // proven-healthy "ok" resets its escalation counters.
  status(now: number): RealtimeStatus {
    if (this.needsRecovery(now)) return "stale";
    if (this.everHealthy) return "ok";
    return elapsed(now, this.startedAt) >= REALTIME_NEVER_CONNECTED_MS ? "never" : "pending";
  }
}

/** Messenger's messaging-critical MQTT-over-WebSocket endpoints. */
export function isMessengerRealtimeUrl(raw: string | URL, base: string): boolean {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch (_) {
    return false;
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") return false;

  const host = url.hostname.toLowerCase();
  return (
    host === "edge-chat.facebook.com" ||
    host.endsWith(".edge-chat.facebook.com") ||
    host === "gateway.facebook.com" ||
    host.endsWith(".gateway.facebook.com") ||
    host === "gateway.messenger.com"
  );
}

/**
 * Tracks all Messenger realtime sockets because Meta may overlap an old socket
 * and its replacement. One recently active open socket is enough to call the
 * transport healthy.
 */
export class RealtimeHealthWatchdog<T> {
  private readonly sockets = new Map<T, SocketState>();
  private everOpened = false;
  private recoveryStartedAt: number | null = null;

  created(socket: T, now: number): void {
    if (this.everOpened && !this.hasOpenSocket()) this.recoveryStartedAt ??= now;
    this.sockets.set(socket, { state: "connecting", since: now, lastInboundAt: now });
  }

  opened(socket: T, now: number): void {
    if (!this.sockets.has(socket)) return;
    this.everOpened = true;
    this.recoveryStartedAt = null;
    this.sockets.set(socket, { state: "open", since: now, lastInboundAt: now });
  }

  received(socket: T, now: number): void {
    const state = this.sockets.get(socket);
    if (state?.state !== "open") return;
    state.lastInboundAt = now;
  }

  closed(socket: T, now: number): void {
    this.sockets.delete(socket);
    if (this.everOpened && !this.hasOpenSocket()) this.recoveryStartedAt ??= now;
  }

  private hasOpenSocket(): boolean {
    return [...this.sockets.values()].some((state) => state.state === "open");
  }

  health(now: number): RealtimeHealth {
    const states = [...this.sockets.values()];
    const open = states.filter((state) => state.state === "open");
    if (open.length) {
      const freshestInbound = Math.max(...open.map((state) => state.lastInboundAt));
      return elapsed(now, freshestInbound) >= REALTIME_SILENCE_MS ? "stale" : "healthy";
    }

    const connecting = states.filter((state) => state.state === "connecting");
    if (!this.everOpened) return "starting";
    if (
      this.recoveryStartedAt !== null &&
      elapsed(now, this.recoveryStartedAt) < REALTIME_CONNECT_GRACE_MS
    ) {
      return "recovering";
    }

    // A socket still trying to connect past the grace period is a genuine
    // failure. Owning no socket at all is not: current Messenger runs sync in
    // a worker and simply stops replacing the page-owned socket, which this
    // used to report as permanently stale — an unrecoverable verdict that
    // drove a full page reload every recovery interval, forever, while
    // messages kept arriving over the worker. Report "starting" (unknown) and
    // let the worker probe speak for the transport instead.
    if (connecting.length) return "stale";
    // Entering the unobservable state closes out the recovery epoch. Left set,
    // it would be held against a socket created much later — Messenger falling
    // back from worker to page transport — so that replacement would be judged
    // stale immediately instead of getting its documented connection grace.
    this.recoveryStartedAt = null;
    return "starting";
  }
}
