import { describe, expect, test } from "bun:test";
import {
  ConversationNotificationTracker,
  isOwnMessagePreview,
  notificationTextMatches,
  pageNotificationMatches,
} from "./notification-fallback";

describe("ConversationNotificationTracker", () => {
  test("primes existing unread conversations without notifying", () => {
    const tracker = new ConversationNotificationTracker();
    expect(tracker.observe([{ key: "1", signature: "hello" }])).toEqual([]);
    expect(tracker.observe([{ key: "1", signature: "hello" }])).toEqual([]);
  });

  test("reports changed previews and newly unread conversations after priming", () => {
    const tracker = new ConversationNotificationTracker();
    tracker.observe([{ key: "1", signature: "hello" }]);
    expect(
      tracker.observe([
        { key: "1", signature: "new message" },
        { key: "2", signature: "first message" },
      ]),
    ).toEqual(["1", "2"]);
  });

  test("keeps virtualized rows but forgets rows observed as no longer unread", () => {
    const tracker = new ConversationNotificationTracker();
    tracker.observe([{ key: "1", signature: "hello" }]);
    expect(tracker.observe([])).toEqual([]);
    expect(tracker.observe([{ key: "1", signature: "hello" }])).toEqual([]);
    expect(tracker.observe([], ["1"])).toEqual([]);
    expect(tracker.observe([{ key: "1", signature: "hello" }])).toEqual(["1"]);
  });
});

describe("isOwnMessagePreview", () => {
  test("recognizes the supported first-person preview forms", () => {
    expect(isOwnMessagePreview("You: hello")).toBe(true);
    expect(isOwnMessagePreview("Du sendte et bilde")).toBe(true);
    expect(isOwnMessagePreview("Meg: hello")).toBe(true);
  });

  test("does not suppress incoming previews", () => {
    expect(isOwnMessagePreview("Jane: hello")).toBe(false);
    expect(isOwnMessagePreview("New message")).toBe(false);
  });
});

describe("pageNotificationMatches", () => {
  test("matches a page notification immediately before an unread increase", () => {
    expect(pageNotificationMatches(1_000, 1_500, 2_000)).toBe(true);
    expect(pageNotificationMatches(1_000, 3_000, 2_000)).toBe(true);
  });

  test("rejects missing, stale, and future page notifications", () => {
    expect(pageNotificationMatches(0, 1_500, 2_000)).toBe(false);
    expect(pageNotificationMatches(1_000, 3_001, 2_000)).toBe(false);
    expect(pageNotificationMatches(2_000, 1_500, 2_000)).toBe(false);
  });
});

describe("notificationTextMatches", () => {
  test("normalizes matching sender and preview text", () => {
    expect(notificationTextMatches(" Jane ", "Hello\nthere", "jane", "hello there")).toBe(true);
    expect(notificationTextMatches("Jane", "", "Jane", "New message")).toBe(true);
  });

  test("keeps unrelated conversations and messages separate", () => {
    expect(notificationTextMatches("Jane", "Hello", "John", "Hello")).toBe(false);
    expect(notificationTextMatches("Jane", "First", "Jane", "Second")).toBe(false);
  });
});
