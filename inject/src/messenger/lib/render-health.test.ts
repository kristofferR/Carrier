import { describe, expect, test } from "bun:test";
import { RenderHealthProbe } from "./render-health";

function harness() {
  let now = 0;
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const probe = new RenderHealthProbe(
    (callback) => {
      callbacks.set(++nextId, callback);
      return nextId;
    },
    (id) => callbacks.delete(id),
    () => now,
  );
  return {
    probe,
    callbacks,
    sample: (at: number, visible = true) => {
      now = at;
      return probe.sample(visible);
    },
    paint: () => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(now);
    },
  };
}

describe("render health", () => {
  test("detects live heartbeats without frames and keeps only one request queued", () => {
    const h = harness();
    expect(h.sample(0).state).toBe("pending");
    expect(h.sample(5_000).state).toBe("pending");
    expect(h.sample(10_000).state).toBe("pending");
    expect(h.sample(15_000)).toEqual({ state: "stalled", wait_ms: 15_000 });
    expect(h.callbacks.size).toBe(1);
    h.paint();
    expect(h.callbacks.size).toBe(0); // No self-scheduling animation loop.
    expect(h.sample(20_000)).toEqual({ state: "ok", wait_ms: 0 });
  });

  test("previously healthy frames do not mask a later stall", () => {
    const h = harness();
    h.sample(0);
    h.paint();
    expect(h.sample(5_000).state).toBe("ok");
    h.sample(10_000);
    h.sample(15_000);
    expect(h.sample(20_000).state).toBe("stalled");
  });

  test("hiding cancels the frame and a late callback cannot prove recovery", () => {
    const h = harness();
    h.sample(0);
    const lateCallback = [...h.callbacks.values()][0]!;
    expect(h.sample(10_000, false)).toEqual({ state: "pending", wait_ms: 0 });
    expect(h.callbacks.size).toBe(0);
    expect(h.sample(60_000)).toEqual({ state: "pending", wait_ms: 0 });
    lateCallback(60_000);
    expect(h.sample(65_000).state).toBe("pending");
  });

  test("a timer gap or visibility transition requires a fresh observation window", () => {
    const h = harness();
    h.sample(0);
    h.sample(5_000);
    expect(h.sample(120_000)).toEqual({ state: "pending", wait_ms: 0 });
    h.sample(125_000);
    h.sample(130_000);
    expect(h.sample(135_000).state).toBe("stalled");
    h.probe.reset();
    expect(h.callbacks.size).toBe(0);
    expect(h.sample(140_000)).toEqual({ state: "pending", wait_ms: 0 });
  });
});
