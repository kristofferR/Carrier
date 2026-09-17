export type RenderState = "pending" | "ok" | "stalled";

const FRAME_TIMEOUT_MS = 15_000;

/** One frame per heartbeat, not an animation loop. A live JS timer does not
 * prove that WebKit is delivering frames to a visible window. */
export class RenderHealthProbe {
  private request: { handle: number; since: number } | undefined;
  private lastSample: number | undefined;
  private hasFrame = false;

  constructor(
    private readonly requestFrame: (callback: FrameRequestCallback) => number,
    private readonly cancelFrame: (handle: number) => void,
    private readonly now: () => number,
  ) {}

  reset() {
    if (this.request) this.cancelFrame(this.request.handle);
    this.request = undefined;
    this.lastSample = undefined;
    this.hasFrame = false;
  }

  sample(visible: boolean): { state: RenderState; wait_ms: number } {
    const now = this.now();
    // Hidden documents and long sampling gaps need a fresh observation window.
    if (!visible || (this.lastSample !== undefined && now - this.lastSample > FRAME_TIMEOUT_MS)) {
      this.reset();
    }
    if (!visible) return { state: "pending", wait_ms: 0 };
    this.lastSample = now;
    if (!this.request) {
      const request = {
        since: now,
        handle: this.requestFrame(() => {
          // A cancelled callback from an earlier visibility epoch is stale.
          if (this.request !== request) return;
          this.request = undefined;
          this.hasFrame = true;
        }),
      };
      this.request = request;
    }
    const wait_ms = Math.max(0, Math.round(now - this.request.since));
    return {
      state: wait_ms >= FRAME_TIMEOUT_MS ? "stalled" : this.hasFrame ? "ok" : "pending",
      wait_ms,
    };
  }
}
