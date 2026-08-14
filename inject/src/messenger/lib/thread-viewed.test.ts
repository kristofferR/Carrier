import { describe, expect, test } from "bun:test";
import {
  advanceThreadViewed,
  initialThreadViewedState,
  THREAD_VIEW_RECHECK_MS,
} from "./thread-viewed";

describe("visible thread reporting", () => {
  test("deduplicates a visible conversation until its periodic recheck", () => {
    const first = advanceThreadViewed(initialThreadViewedState(), "/t/123/", true, 0);
    expect(first.emit).toBe("/t/123/");
    expect(advanceThreadViewed(first.state, "/t/123/", true, 1_000).emit).toBeNull();
    expect(advanceThreadViewed(first.state, "/t/123/", true, THREAD_VIEW_RECHECK_MS).emit).toBe(
      "/t/123/",
    );
  });

  test("emits when the conversation changes", () => {
    const first = advanceThreadViewed(initialThreadViewedState(), "/t/123/", true, 0);
    expect(advanceThreadViewed(first.state, "/t/456/", true, 1).emit).toBe("/t/456/");
  });

  test("re-emits the same conversation after focus returns", () => {
    const focused = advanceThreadViewed(initialThreadViewedState(), "/t/123/", true, 0);
    const blurred = advanceThreadViewed(focused.state, "/t/123/", false, 1);
    expect(blurred.emit).toBeNull();
    expect(advanceThreadViewed(blurred.state, "/t/123/", true, 2).emit).toBe("/t/123/");
  });

  test("never emits inbox or hidden states", () => {
    expect(advanceThreadViewed(initialThreadViewedState(), null, true, 0).emit).toBeNull();
    expect(advanceThreadViewed(initialThreadViewedState(), "/t/123/", false, 0).emit).toBeNull();
  });
});
