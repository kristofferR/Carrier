import { describe, expect, test } from "bun:test";
import { PowerStateTracker } from "./auto-refresh";

describe("PowerStateTracker", () => {
  test("repairs a missed resume once, without postponing a protected reload", () => {
    const tracker = new PowerStateTracker(100);
    expect(tracker.update({ sleeping: true, resume_generation: 0 })).toBe(false);
    expect(tracker.update({ sleeping: false, resume_generation: 1 })).toBe(true);
    expect(tracker.update({ sleeping: false, resume_generation: 1 })).toBe(false);
  });

  test("detects sleep and wake missed between native pings", () => {
    const tracker = new PowerStateTracker(100);
    expect(tracker.update({ sleeping: false, resume_generation: 3 })).toBe(false);
    expect(tracker.update({ sleeping: false, resume_generation: 4 })).toBe(true);
  });

  test("fresh documents adopt the current generation without a reload loop", () => {
    const tracker = new PowerStateTracker(100);
    const snapshot = { sleeping: false, resume_generation: 7, last_resume_at_ms: 99 };
    expect(tracker.update(snapshot)).toBe(false);
    expect(tracker.update(snapshot)).toBe(false);
  });

  test("recovers a document that missed every snapshot before wake", () => {
    const tracker = new PowerStateTracker(100);
    const snapshot = { sleeping: false, resume_generation: 7, last_resume_at_ms: 101 };
    expect(tracker.update(snapshot)).toBe(true);
    expect(tracker.update(snapshot)).toBe(false);
  });
});
