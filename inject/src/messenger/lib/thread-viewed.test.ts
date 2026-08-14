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
    expect(first.state.lastReportedAt).toBe(0);
    const held = advanceThreadViewed(first.state, "/t/123/", true, 1_000);
    expect(held.emit).toBeNull();
    expect(held.state.lastReportedAt).toBe(0);
    const recheck = advanceThreadViewed(first.state, "/t/123/", true, THREAD_VIEW_RECHECK_MS);
    expect(recheck.emit).toBe("/t/123/");
    expect(recheck.state.lastReportedAt).toBe(THREAD_VIEW_RECHECK_MS);
    expect(
      advanceThreadViewed(recheck.state, "/t/123/", true, THREAD_VIEW_RECHECK_MS + 1).emit,
    ).toBeNull();
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
    const focused = advanceThreadViewed(initialThreadViewedState(), "/t/123/", true, 0);
    const inbox = advanceThreadViewed(focused.state, null, true, 1);
    expect(inbox.emit).toBeNull();
    expect(inbox.state.lastReportedAt).toBeNull();
    const hidden = advanceThreadViewed(focused.state, "/t/123/", false, 1);
    expect(hidden.emit).toBeNull();
    expect(hidden.state.lastReportedAt).toBeNull();
  });
});
