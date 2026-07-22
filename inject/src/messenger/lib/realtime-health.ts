export const REALTIME_CONNECT_GRACE_MS = 15_000;
export const REALTIME_SILENCE_MS = 90_000;
export const REALTIME_NEVER_CONNECTED_MS = 90_000;

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
  private everHealthy = false;

  constructor(private readonly startedAt: number) {}

  healthy(source: RealtimeHealthSource): void {
    this.everHealthy = true;
    this.staleSources.delete(source);
  }

  stale(source: RealtimeHealthSource): void {
    this.staleSources.add(source);
  }

  needsRecovery(): boolean {
    return this.staleSources.size > 0;
  }

  // "pending" (fresh page, transport still unproven) deliberately differs from
  // "ok": the native side pauses its bad-transport timer on both, but only a
  // proven-healthy "ok" resets its escalation counters.
  status(now: number): RealtimeStatus {
    if (this.staleSources.size > 0) return "stale";
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

    return connecting.length || this.recoveryStartedAt !== null ? "stale" : "starting";
  }
}
