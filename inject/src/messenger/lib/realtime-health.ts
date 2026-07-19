export const REALTIME_CONNECT_GRACE_MS = 15_000;
export const REALTIME_SILENCE_MS = 90_000;

export type RealtimeHealth = "healthy" | "recovering" | "stale" | "starting";

type SocketState = {
  state: "connecting" | "open";
  since: number;
  lastInboundAt: number;
};

const elapsed = (now: number, since: number) => Math.max(0, now - since);

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
