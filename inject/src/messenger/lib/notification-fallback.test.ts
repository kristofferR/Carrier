import { describe, expect, test } from "bun:test";
import {
  ConversationNotificationTracker,
  isOwnMessagePreview,
  NotifiedSignatureStore,
  notificationDedupeKey,
  notificationTextMatches,
  PageNotificationQueue,
  UnreadArrivalTracker,
} from "./notification-fallback";

describe("notificationDedupeKey", () => {
  test("normalizes equivalent notification text to the same opaque key", () => {
    const key = notificationDedupeKey(" Jane ", "Hello\nthere");
    expect(notificationDedupeKey("jane", "hello there")).toBe(key);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(key).not.toContain("jane");
  });

  test("distinguishes different senders and message previews", () => {
    const key = notificationDedupeKey("Jane", "First");
    expect(notificationDedupeKey("John", "First")).not.toBe(key);
    expect(notificationDedupeKey("Jane", "Second")).not.toBe(key);
  });
});

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

describe("NotifiedSignatureStore", () => {
  const memoryStorage = () => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
  };

  test("recognizes a fingerprint it delivered and distinguishes new ones", () => {
    const store = new NotifiedSignatureStore();
    store.markNotified("1", "aaaa");
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
    expect(store.alreadyNotified("1", "bbbb")).toBe(false);
    expect(store.alreadyNotified("2", "aaaa")).toBe(false);
  });

  test("survives a page reload via the backing storage", () => {
    const storage = memoryStorage();
    new NotifiedSignatureStore(storage).markNotified("1", "aaaa");
    // A reload constructs a fresh store over the same storage.
    expect(new NotifiedSignatureStore(storage).alreadyNotified("1", "aaaa")).toBe(true);
  });

  test("forgets a conversation after stable read observations", () => {
    const storage = memoryStorage();
    const store = new NotifiedSignatureStore(storage);
    store.markNotified("1", "aaaa");
    // Rendered rows: "1" no longer unread, "2" was never tracked.
    store.observeRead(new Set(["2"]), ["1", "2"]);
    store.observeRead(new Set(["2"]), ["1", "2"]);
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
    store.observeRead(new Set(["2"]), ["1", "2"]);
    expect(store.alreadyNotified("1", "aaaa")).toBe(false);
    expect(new NotifiedSignatureStore(storage).alreadyNotified("1", "aaaa")).toBe(false);
  });

  test("a transient read flicker does not clear a delivered entry", () => {
    const store = new NotifiedSignatureStore();
    store.markNotified("1", "aaaa");
    // Two hydration scans render the row as read, then it settles unread
    // again — the streak resets and the suppression entry survives further
    // read flickers short of a stable streak.
    store.observeRead(new Set(), ["1"]);
    store.observeRead(new Set(), ["1"]);
    store.observeRead(new Set(["1"]), ["1"]);
    store.observeRead(new Set(), ["1"]);
    store.observeRead(new Set(), ["1"]);
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
  });

  test("counts repeated keys in one scan as a single observation", () => {
    const store = new NotifiedSignatureStore();
    store.markNotified("1", "aaaa");
    store.observeRead(new Set(), ["1", "1", "1"]);
    store.observeRead(new Set(), ["1", "1", "1"]);
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
    store.observeRead(new Set(), ["1", "1", "1"]);
    expect(store.alreadyNotified("1", "aaaa")).toBe(false);
  });

  test("keeps entries for unread rows that are merely still rendered", () => {
    const store = new NotifiedSignatureStore();
    store.markNotified("1", "aaaa");
    for (let scan = 0; scan < 5; scan++) store.observeRead(new Set(["1"]), ["1"]);
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
  });

  test("evicts the oldest entry beyond the limit; re-marking refreshes position", () => {
    const store = new NotifiedSignatureStore();
    for (let n = 0; n < 300; n++) store.markNotified(`k${n}`, "f");
    // Refreshing "k0" moves it to the newest slot, so "k1" is now oldest.
    store.markNotified("k0", "f2");
    store.markNotified("k300", "f");
    expect(store.alreadyNotified("k1", "f")).toBe(false);
    expect(store.alreadyNotified("k0", "f2")).toBe(true);
    expect(store.alreadyNotified("k300", "f")).toBe(true);
  });

  test("trims oversized persisted state to the newest entries and persists the trim", () => {
    const storage = memoryStorage();
    const oversized = Array.from({ length: 301 }, (_, n) => [`k${n}`, "f"]);
    storage.setItem("__carrier_notified_previews__", JSON.stringify(oversized));
    const store = new NotifiedSignatureStore(storage);
    expect(store.alreadyNotified("k0", "f")).toBe(false);
    expect(store.alreadyNotified("k300", "f")).toBe(true);
    const persisted = JSON.parse(storage.getItem("__carrier_notified_previews__")!);
    expect(persisted.length).toBe(300);
  });

  test("tolerates malformed persisted state", () => {
    const storage = memoryStorage();
    storage.setItem("__carrier_notified_previews__", "{not json");
    const store = new NotifiedSignatureStore(storage);
    expect(store.alreadyNotified("1", "aaaa")).toBe(false);
    store.markNotified("1", "aaaa");
    expect(new NotifiedSignatureStore(storage).alreadyNotified("1", "aaaa")).toBe(true);
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

  test("matches row text truncated at the scraper caps", () => {
    const title = "A very long group conversation name that keeps going well beyond the row cap";
    const body =
      "A long preview that Messenger renders in full when constructing the page notification but truncates in the conversation row snapshot";
    expect(notificationTextMatches(`${title} with more text`, body, title, body.slice(0, 80))).toBe(
      true,
    );
  });

  test("matches group-chat previews with or without a sender prefix", () => {
    expect(
      notificationTextMatches(
        "Project group",
        "Deployment finished",
        "Project group",
        "Jane: Deployment finished",
      ),
    ).toBe(true);
    expect(
      notificationTextMatches(
        "Project group",
        "Jane: Deployment finished",
        "Project group",
        "Deployment finished",
      ),
    ).toBe(true);
  });

  test("keeps unrelated conversations and messages separate", () => {
    expect(notificationTextMatches("Jane", "Hello", "John", "Hello")).toBe(false);
    expect(notificationTextMatches("Jane", "First", "Jane", "Second")).toBe(false);
    expect(notificationTextMatches("Jane", "OK", "Jane", "OK then")).toBe(false);
  });
});
