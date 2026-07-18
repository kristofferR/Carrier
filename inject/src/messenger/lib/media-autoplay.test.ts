import { describe, expect, test } from "bun:test";
import { MEDIA_ACTIVATION_GRACE_MS, shouldSuppressMediaPlay } from "./media-autoplay";

describe("shouldSuppressMediaPlay", () => {
  test("never interferes while the preference is disabled", () => {
    expect(shouldSuppressMediaPlay(false, Number.NEGATIVE_INFINITY, 10)).toBe(false);
  });

  test("suppresses playback with no trusted activation", () => {
    expect(shouldSuppressMediaPlay(true, Number.NEGATIVE_INFINITY, 10)).toBe(true);
  });

  test("allows playback during the manual-activation grace window", () => {
    expect(shouldSuppressMediaPlay(true, 1_000, 1_000)).toBe(false);
    expect(shouldSuppressMediaPlay(true, 1_000, 1_000 + MEDIA_ACTIVATION_GRACE_MS)).toBe(false);
  });

  test("suppresses playback after the grace window expires", () => {
    expect(shouldSuppressMediaPlay(true, 1_000, 1_001 + MEDIA_ACTIVATION_GRACE_MS)).toBe(true);
  });

  test("fails closed for invalid or backwards clocks", () => {
    expect(shouldSuppressMediaPlay(true, 2_000, 1_000)).toBe(true);
    expect(shouldSuppressMediaPlay(true, 0, Number.NaN)).toBe(true);
    expect(shouldSuppressMediaPlay(true, 0, 1, -1)).toBe(true);
  });
});
