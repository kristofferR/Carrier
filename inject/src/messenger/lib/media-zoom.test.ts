import { describe, expect, test } from "bun:test";
import { MAX_SCALE, wheelZoomFactor, zoomAround } from "./media-zoom";

const wheel = { deltaY: 0, deltaMode: 0, ctrlKey: false, ctrlKeyHeld: false };

describe("wheelZoomFactor", () => {
  test("a WebView2 pinch (Ctrl without the key) follows the fingers", () => {
    const factor = wheelZoomFactor({ ...wheel, deltaY: -100 * Math.log(1.1), ctrlKey: true });
    expect(factor).toBeCloseTo(1.1, 6);
  });

  test("a mouse notch zooms about 15%, the same with Ctrl held", () => {
    expect(wheelZoomFactor({ ...wheel, deltaY: -100 })).toBeCloseTo(2 ** 0.2, 6);
    expect(wheelZoomFactor({ ...wheel, deltaY: 100 })).toBeCloseTo(2 ** -0.2, 6);
    const held = { ...wheel, deltaY: -10, ctrlKey: true, ctrlKeyHeld: true };
    expect(wheelZoomFactor(held)).toBeCloseTo(2 ** 0.02, 6);
  });

  test("touchpad scrolling zooms by distance, not per event", () => {
    const small = wheelZoomFactor({ ...wheel, deltaY: -10 });
    expect(small ** 10).toBeCloseTo(wheelZoomFactor({ ...wheel, deltaY: -100 }), 6);
  });

  test("line and page deltas count as pixels, capped per event", () => {
    expect(wheelZoomFactor({ ...wheel, deltaY: -3, deltaMode: 1 })).toBeCloseTo(2 ** 0.24, 6);
    expect(wheelZoomFactor({ ...wheel, deltaY: 1, deltaMode: 2 })).toBeCloseTo(2 ** -0.24, 6);
  });
});

describe("zoomAround", () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };

  test("keeps the point under the pointer still", () => {
    const next = zoomAround({ scale: 1, tx: 0, ty: 0 }, 2, 150, 50, rect);
    // Local offset of (150, 50) from the centre is (50, 0); at scale 2 it
    // lands at centre + t + 2 × offset, which must still be 150.
    expect(next).toEqual({ scale: 2, tx: -50, ty: 0 });
    expect(100 + next.tx + 2 * 50).toBe(150);
  });

  test("clamps the scale and recentres at 1", () => {
    expect(zoomAround({ scale: 2, tx: 30, ty: 10 }, 0.5, 0, 0, rect)).toEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    });
    expect(zoomAround({ scale: 4, tx: 0, ty: 0 }, 100, 100, 50, rect).scale).toBe(MAX_SCALE);
  });
});
