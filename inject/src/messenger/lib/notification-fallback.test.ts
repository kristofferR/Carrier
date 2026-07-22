import { describe, expect, test } from "bun:test";
import {
  ConversationNotificationTracker,
  isOwnMessagePreview,
  NotifiedSignatureStore,
  notificationDedupeKey,
  notificationTextMatches,
  PageNotificationQueue,
  READ_TRANSITION_CONFIRM_MS,
  STABLE_READ_MS,
  StableMismatchTracker,
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

  test("exposes the delivered fingerprint for mismatch detection", () => {
    const store = new NotifiedSignatureStore();
    expect(store.notifiedFingerprint("1")).toBeUndefined();
    store.markNotified("1", "aaaa");
    expect(store.notifiedFingerprint("1")).toBe("aaaa");
  });

  test("survives a page reload via the backing storage", () => {
    const storage = memoryStorage();
    new NotifiedSignatureStore(storage).markNotified("1", "aaaa");
    // A reload constructs a fresh store over the same storage.
    expect(new NotifiedSignatureStore(storage).alreadyNotified("1", "aaaa")).toBe(true);
  });

  test("forgets a conversation after a continuously stable read interval", () => {
    const storage = memoryStorage();
    new NotifiedSignatureStore(storage).markNotified("1", "aaaa");
    // Recreate the store so the entry starts as persisted state whose unread
    // styling has not yet been established in this document.
    const store = new NotifiedSignatureStore(storage);
    // Rendered rows: "1" no longer unread, "2" was never tracked.
    store.observeRead(new Set(["2"]), ["1", "2"], 1_000);
    store.observeRead(new Set(["2"]), ["1", "2"], 1_000 + STABLE_READ_MS - 1);
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
    store.observeRead(new Set(["2"]), ["1", "2"], 1_000 + STABLE_READ_MS);
    expect(store.alreadyNotified("1", "aaaa")).toBe(false);
    expect(new NotifiedSignatureStore(storage).alreadyNotified("1", "aaaa")).toBe(false);
  });

  test("rapid hydration scans do not clear a delivered entry", () => {
    const storage = memoryStorage();
    new NotifiedSignatureStore(storage).markNotified("1", "aaaa");
    // Recreate the store as a real document reload does.
    const store = new NotifiedSignatureStore(storage);
    // A reload can produce far more than the old three-scan threshold while
    // the row temporarily lacks its unread styling.
    for (let scan = 0; scan < 100; scan++) {
      store.observeRead(new Set(), ["1"], scan * 100);
    }
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
    expect(new NotifiedSignatureStore(storage).alreadyNotified("1", "aaaa")).toBe(true);
  });

  test("an unread observation resets pending read confirmation", () => {
    const storage = memoryStorage();
    new NotifiedSignatureStore(storage).markNotified("1", "aaaa");
    const store = new NotifiedSignatureStore(storage);
    store.observeRead(new Set(), ["1"], 1_000);
    store.observeRead(new Set(), ["1"], 1_000 + STABLE_READ_MS - 1);
    store.observeRead(new Set(["1"]), ["1"], 1_000 + STABLE_READ_MS);
    store.observeRead(new Set(), ["1"], 2_000 + STABLE_READ_MS);
    store.observeRead(new Set(), ["1"], 2_000 + STABLE_READ_MS + READ_TRANSITION_CONFIRM_MS - 1);
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
    store.observeRead(new Set(), ["1"], 2_000 + STABLE_READ_MS + READ_TRANSITION_CONFIRM_MS);
    expect(store.alreadyNotified("1", "aaaa")).toBe(false);
  });

  test("a missing row resets pending read confirmation", () => {
    const storage = memoryStorage();
    new NotifiedSignatureStore(storage).markNotified("1", "aaaa");
    const store = new NotifiedSignatureStore(storage);
    store.observeRead(new Set(), ["1"], 1_000);
    store.observeRead(new Set(), [], 1_000 + STABLE_READ_MS);
    store.observeRead(new Set(), ["1"], 2_000 + STABLE_READ_MS);
    store.observeRead(new Set(), ["1"], 2_000 + STABLE_READ_MS * 2 - 1);
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
    store.observeRead(new Set(), ["1"], 2_000 + STABLE_READ_MS * 2);
    expect(store.alreadyNotified("1", "aaaa")).toBe(false);
  });

  test("a backward clock jump restarts read confirmation", () => {
    const storage = memoryStorage();
    new NotifiedSignatureStore(storage).markNotified("1", "aaaa");
    const store = new NotifiedSignatureStore(storage);
    store.observeRead(new Set(), ["1"], 10_000);
    store.observeRead(new Set(), ["1"], 5_000);
    store.observeRead(new Set(), ["1"], 5_000 + STABLE_READ_MS - 1);
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
    store.observeRead(new Set(), ["1"], 5_000 + STABLE_READ_MS);
    expect(store.alreadyNotified("1", "aaaa")).toBe(false);
  });

  test("a confirmed unread-to-read transition uses the short guard", () => {
    const storage = memoryStorage();
    new NotifiedSignatureStore(storage).markNotified("1", "aaaa");
    const store = new NotifiedSignatureStore(storage);
    store.observeRead(new Set(["1"]), ["1"], 1_000);
    store.observeRead(new Set(), ["1"], 2_000);
    store.observeRead(new Set(), ["1"], 2_000 + READ_TRANSITION_CONFIRM_MS - 1);
    expect(store.alreadyNotified("1", "aaaa")).toBe(true);
    store.observeRead(new Set(), ["1"], 2_000 + READ_TRANSITION_CONFIRM_MS);
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

    expect(queue.consumeMatching({ title: "Jane", body: "First" }, 1_200, 2_000)).not.toBeNull();
    expect(queue.consumeMatching({ title: "John", body: "Second" }, 1_300, 2_000)).not.toBeNull();
  });

  test("returns the matched signal so its native id can be routed later", () => {
    const queue = new PageNotificationQueue();
    const signal = queue.add({ at: 1_000, title: "Jane", body: "First", nativeId: 42 });
    expect(signal.nativeId).toBe(42);
    expect(queue.consumeMatching({ title: "Jane", body: "First" }, 1_100, 2_000)?.nativeId).toBe(
      42,
    );
  });

  test("expires stale signals without consuming unrelated ones", () => {
    const queue = new PageNotificationQueue();
    queue.add({ at: 1_000, title: "Jane", body: "First" });
    expect(queue.consumeMatching({ title: "Jane", body: "First" }, 3_001, 2_000)).toBeNull();
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

  test("absorbs the title hydrating from zero as the baseline", () => {
    const tracker = new UnreadArrivalTracker(10_000);
    // Post-reload: the title has no "(N)" yet, rows mutate while hydrating.
    expect(tracker.observeUnreadCount(0, 1_000, 2_000)).toEqual([]);
    tracker.markRowsChanged(["a"], 1_100);
    // The hydrated count primes silently instead of replaying row "a".
    expect(tracker.observeUnreadCount(3, 1_200, 2_000)).toEqual([]);
  });

  test("still reports a real arrival right after the baseline settles", () => {
    const tracker = new UnreadArrivalTracker(10_000);
    tracker.observeUnreadCount(0, 1_000, 2_000);
    tracker.observeUnreadCount(3, 1_200, 2_000);
    tracker.markRowsChanged(["b"], 1_300);
    expect(tracker.observeUnreadCount(4, 1_400, 2_000)).toEqual(["b"]);
  });

  test("a zero count that outlives the settle window is a real baseline", () => {
    const tracker = new UnreadArrivalTracker(10_000);
    expect(tracker.observeUnreadCount(0, 1_000, 2_000)).toEqual([]);
    expect(tracker.observeUnreadCount(0, 12_000, 2_000)).toEqual([]);
    tracker.markRowsChanged(["a"], 12_100);
    expect(tracker.observeUnreadCount(1, 12_200, 2_000)).toEqual(["a"]);
  });

  test("a count already present at first observation primes silently", () => {
    const tracker = new UnreadArrivalTracker(10_000);
    expect(tracker.observeUnreadCount(5, 1_000, 2_000)).toEqual([]);
    tracker.markRowsChanged(["a"], 1_100);
    expect(tracker.observeUnreadCount(6, 1_200, 2_000)).toEqual(["a"]);
  });
});

describe("StableMismatchTracker", () => {
  test("reports a stable mismatch exactly once at the threshold", () => {
    const tracker = new StableMismatchTracker(2);
    expect(tracker.observe([["1", "bbbb"]])).toEqual([]);
    expect(tracker.observe([["1", "bbbb"]])).toEqual(["1"]);
    expect(tracker.observe([["1", "bbbb"]])).toEqual([]);
  });

  test("restarts the streak when a key stops mismatching", () => {
    const tracker = new StableMismatchTracker(2);
    tracker.observe([["1", "bbbb"]]);
    tracker.observe([]);
    expect(tracker.observe([["1", "bbbb"]])).toEqual([]);
    expect(tracker.observe([["1", "bbbb"]])).toEqual(["1"]);
  });

  test("restarts the streak when the fingerprint keeps shifting", () => {
    const tracker = new StableMismatchTracker(2);
    tracker.observe([["1", "bbbb"]]);
    expect(tracker.observe([["1", "cccc"]])).toEqual([]);
    expect(tracker.observe([["1", "cccc"]])).toEqual(["1"]);
  });

  test("counts a duplicated key once per scan", () => {
    const tracker = new StableMismatchTracker(2);
    // The DOM can briefly render two anchors for one thread — a single scan
    // must not reach the stability threshold on its own.
    expect(
      tracker.observe([
        ["1", "bbbb"],
        ["1", "bbbb"],
      ]),
    ).toEqual([]);
    expect(tracker.observe([["1", "bbbb"]])).toEqual(["1"]);
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

  test("keeps different group senders of the same short text separate", () => {
    // Two members posting identical short previews close together must each
    // notify — stripping both senders would wrongly collapse them into one.
    expect(notificationTextMatches("Project group", "Jane: OK", "Project group", "John: OK")).toBe(
      false,
    );
    // The same sender still pairs (page and row describe one message).
    expect(notificationTextMatches("Project group", "Jane: OK", "Project group", "Jane: OK")).toBe(
      true,
    );
  });
});
