import { describe, expect, test } from "bun:test";
import {
  ConversationNotificationTracker,
  isOwnMessagePreview,
  notificationTextMatches,
  PageNotificationQueue,
  UnreadArrivalTracker,
} from "./notification-fallback";

describe("ConversationNotificationTracker", () => {
  test("primes existing unread conversations without notifying", () => {
    const tracker = new ConversationNotificationTracker();
    expect(tracker.observe([{ key: "1", signature: "hello" }])).toEqual([]);
    expect(tracker.observe([{ key: "1", signature: "hello" }])).toEqual([]);
  });

  test("reports changed previews but primes first-seen conversations", () => {
    const tracker = new ConversationNotificationTracker();
    tracker.observe([{ key: "1", signature: "hello" }]);
    expect(
      tracker.observe([
        { key: "1", signature: "new message" },
        { key: "2", signature: "first message" },
      ]),
    ).toEqual(["1"]);
  });

  test("keeps virtualized rows but forgets rows observed as no longer unread", () => {
    const tracker = new ConversationNotificationTracker();
    tracker.observe([{ key: "1", signature: "hello" }]);
    expect(tracker.observe([])).toEqual([]);
    expect(tracker.observe([{ key: "1", signature: "hello" }])).toEqual([]);
    expect(tracker.observe([], ["1"])).toEqual([]);
    expect(tracker.observe([{ key: "1", signature: "hello" }])).toEqual([]);
  });
});

describe("PageNotificationQueue", () => {
  test("keeps and consumes concurrent page notifications independently", () => {
    const queue = new PageNotificationQueue();
    queue.add({ at: 1_000, title: "Jane", body: "First" });
    queue.add({ at: 1_100, title: "John", body: "Second" });

    expect(queue.consumeMatching({ title: "Jane", body: "First" }, 1_200, 2_000)).toBe(true);
    expect(queue.consumeMatching({ title: "John", body: "Second" }, 1_300, 2_000)).toBe(true);
  });

  test("expires stale signals without consuming unrelated ones", () => {
    const queue = new PageNotificationQueue();
    queue.add({ at: 1_000, title: "Jane", body: "First" });
    expect(queue.consumeMatching({ title: "Jane", body: "First" }, 3_001, 2_000)).toBe(false);
  });
});

describe("UnreadArrivalTracker", () => {
  test("returns the most recently changed rows when the unread count increases", () => {
    const tracker = new UnreadArrivalTracker();
    expect(tracker.observeUnreadCount(2, 1_000, 2_000)).toEqual([]);
    tracker.markRowsChanged(["older"], 1_100);
    tracker.markRowsChanged(["newer"], 1_200);
    expect(tracker.observeUnreadCount(3, 1_300, 2_000)).toEqual(["newer"]);
  });

  test("ignores count decreases and stale row mutations", () => {
    const tracker = new UnreadArrivalTracker();
    tracker.observeUnreadCount(2, 1_000, 2_000);
    tracker.markRowsChanged(["stale"], 1_100);
    expect(tracker.observeUnreadCount(1, 1_200, 2_000)).toEqual([]);
    expect(tracker.observeUnreadCount(2, 3_101, 2_000)).toEqual([]);
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
