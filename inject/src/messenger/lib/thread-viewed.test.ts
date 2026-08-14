import { describe, expect, test } from "bun:test";
import { advanceThreadViewed, initialThreadViewedState } from "./thread-viewed";

describe("visible thread reporting", () => {
  test("emits once for a continuously visible conversation", () => {
    const first = advanceThreadViewed(initialThreadViewedState(), "/t/123/", true);
    expect(first.emit).toBe("/t/123/");
    expect(advanceThreadViewed(first.state, "/t/123/", true).emit).toBeNull();
  });

  test("emits when the conversation changes", () => {
    const first = advanceThreadViewed(initialThreadViewedState(), "/t/123/", true);
    expect(advanceThreadViewed(first.state, "/t/456/", true).emit).toBe("/t/456/");
  });

  test("re-emits the same conversation after focus returns", () => {
    const focused = advanceThreadViewed(initialThreadViewedState(), "/t/123/", true);
    const blurred = advanceThreadViewed(focused.state, "/t/123/", false);
    expect(blurred.emit).toBeNull();
    expect(advanceThreadViewed(blurred.state, "/t/123/", true).emit).toBe("/t/123/");
  });

  test("never emits inbox or hidden states", () => {
    expect(advanceThreadViewed(initialThreadViewedState(), null, true).emit).toBeNull();
    expect(advanceThreadViewed(initialThreadViewedState(), "/t/123/", false).emit).toBeNull();
  });
});
