import { describe, expect, test } from "bun:test";
import {
  ConversationNotificationTracker,
  isOwnMessagePreview,
  NotifiedSignatureStore,
  notificationDedupeKey,
  notificationTextMatches,
  PAGE_NOTIFICATION_RECEIPT_TTL_MS,
  PageNotificationQueue,
  PageNotificationReceiptStore,
  READ_TRANSITION_CONFIRM_MS,
  STABLE_READ_MS,
  StableMismatchTracker,
  UnreadArrivalTracker,
} from "./notification-fallback";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

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

  test("silently migrates placeholder fingerprints only from the legacy schema", () => {
    const storage = memoryStorage();
    const placeholder = notificationDedupeKey("Jane", "New message");
    const hydrated = notificationDedupeKey("Jane", "Actual preview");
    storage.setItem("__carrier_notified_previews__", JSON.stringify([["1", placeholder]]));

    const store = new NotifiedSignatureStore(storage);
    expect(store.reconcileFingerprint("1", "Jane", hydrated)).toBe("migrated");
    expect(store.alreadyNotified("1", hydrated)).toBe(true);
    expect(new NotifiedSignatureStore(storage).alreadyNotified("1", hydrated)).toBe(true);
  });

  test("migrates the old fully generic placeholder fingerprint", () => {
    const storage = memoryStorage();
    const placeholder = notificationDedupeKey("Messenger", "New message");
    const hydrated = notificationDedupeKey("Jane", "Actual preview");
    storage.setItem("__carrier_notified_previews__", JSON.stringify([["1", placeholder]]));

    expect(new NotifiedSignatureStore(storage).reconcileFingerprint("1", "Jane", hydrated)).toBe(
      "migrated",
    );
  });

  test("never treats a new-schema literal New message as legacy poison", () => {
    const storage = memoryStorage();
    const placeholder = notificationDedupeKey("Jane", "New message");
    const next = notificationDedupeKey("Jane", "Actual preview");
    new NotifiedSignatureStore(storage).markNotified("1", placeholder);

    expect(new NotifiedSignatureStore(storage).reconcileFingerprint("1", "Jane", next)).toBe(
      "mismatched",
    );
  });

  test("an exact hydrated observation retires a legacy marker", () => {
    const storage = memoryStorage();
    const literal = notificationDedupeKey("Jane", "New message");
    const next = notificationDedupeKey("Jane", "Actual preview");
    storage.setItem("__carrier_notified_previews__", JSON.stringify([["1", literal]]));

    const store = new NotifiedSignatureStore(storage);
    expect(store.reconcileFingerprint("1", "Jane", literal)).toBe("matched");
    expect(store.reconcileFingerprint("1", "Jane", next)).toBe("mismatched");
  });

  test("title-only drift rekeys the delivered entry instead of mismatching", () => {
    const storage = memoryStorage();
    const bodyHash = notificationDedupeKey("", "Hello there");
    new NotifiedSignatureStore(storage).markNotified(
      "1",
      notificationDedupeKey("Old name", "Hello there"),
      bodyHash,
    );
    // Reload after a rename: same delivered content under a new title.
    const store = new NotifiedSignatureStore(storage);
    const renamed = notificationDedupeKey("New name", "Hello there");
    expect(store.reconcileFingerprint("1", "New name", renamed, bodyHash)).toBe("matched");
    expect(store.alreadyNotified("1", renamed)).toBe(true);
    // A real body change still reports as new content.
    expect(
      store.reconcileFingerprint(
        "1",
        "New name",
        notificationDedupeKey("New name", "Something new"),
        notificationDedupeKey("", "Something new"),
      ),
    ).toBe("mismatched");
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
    expect(persisted.version).toBe(2);
    expect(persisted.entries).toHaveLength(300);
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

describe("PageNotificationReceiptStore", () => {
  test("pairs a page notification after reload without persisting raw content", () => {
    const storage = memoryStorage();
    const title = "Project group with a deliberately long title that the row truncates later";
    const body =
      "Jane: Deployment finished and this deliberately long preview continues beyond the rendered row";
    new PageNotificationReceiptStore(storage, undefined, undefined, 1_000).add(
      title,
      body,
      42,
      1_000,
    );
    const persisted = storage.getItem("__carrier_page_notification_receipts__")!;
    expect(persisted).not.toContain("Project group");
    expect(persisted).not.toContain("Deployment finished");

    const reloaded = new PageNotificationReceiptStore(storage, undefined, undefined, 1_500);
    expect(
      reloaded.consumeMatching(
        {
          title: title.slice(0, 50),
          body: body.slice("Jane: ".length, 60),
        },
        1_500,
      ),
    ).toEqual({ nativeId: 42 });
    expect(reloaded.consumeMatching({ title, body }, 1_500)).toBeNull();
  });

  test("drops a receipt matched by several visible rows", () => {
    const store = new PageNotificationReceiptStore(memoryStorage());
    store.add("Jane", "OK", 42, 1_000);
    // Two different threads share the display text — guessing would route
    // the click to the wrong one, and virtualization could later make the
    // wrong twin look unique, so the receipt is dropped outright.
    const ambiguous = store.consumeUniquelyMatching(
      [
        { key: "1", title: "Jane", body: "OK" },
        { key: "2", title: "Jane", body: "OK" },
      ],
      1_100,
    );
    expect(ambiguous.size).toBe(0);
    expect(
      store.consumeUniquelyMatching([{ key: "1", title: "Jane", body: "OK" }], 1_200).size,
    ).toBe(0);
  });

  test("consumes a receipt for a uniquely matching visible row", () => {
    const store = new PageNotificationReceiptStore(memoryStorage());
    store.add("Jane", "OK", 42, 1_000);
    const unique = store.consumeUniquelyMatching([{ key: "1", title: "Jane", body: "OK" }], 1_100);
    expect(unique.get("1")).toEqual({ nativeId: 42 });
    expect(store.consumeMatching({ title: "Jane", body: "OK" }, 1_200)).toBeNull();
  });

  test("retires a receipt matching only read rows", () => {
    const store = new PageNotificationReceiptStore(memoryStorage());
    store.add("Jane", "OK", 42, 1_000);
    // The thread was read before its unread row ever paired — the receipt
    // must not linger and swallow a later identical message's pairing.
    store.discardReadMatches([{ title: "Jane", body: "OK" }], [], 1_100);
    expect(store.consumeMatching({ title: "Jane", body: "OK" }, 1_200)).toBeNull();
  });

  test("keeps a receipt when an unread row still matches it", () => {
    const store = new PageNotificationReceiptStore(memoryStorage());
    store.add("Jane", "OK", 42, 1_000);
    store.discardReadMatches(
      [{ title: "Jane", body: "OK" }],
      [{ title: "Jane", body: "OK" }],
      1_100,
    );
    expect(store.consumeMatching({ title: "Jane", body: "OK" }, 1_200)).toEqual({ nativeId: 42 });
  });

  test("duplicate anchors for one thread do not count as ambiguity", () => {
    const store = new PageNotificationReceiptStore(memoryStorage());
    store.add("Jane", "OK", 42, 1_000);
    const consumed = store.consumeUniquelyMatching(
      [
        { key: "1", title: "Jane", body: "OK" },
        { key: "1", title: "Jane", body: "OK" },
      ],
      1_100,
    );
    expect(consumed.get("1")).toEqual({ nativeId: 42 });
  });

  test("expires old and future-dated receipts across reloads", () => {
    const storage = memoryStorage();
    const receipts = new PageNotificationReceiptStore(storage, undefined, undefined, 1_000);
    receipts.add("Jane", "Old", 41, 1_000);
    receipts.add("Jane", "Future", 42, 1_000 + PAGE_NOTIFICATION_RECEIPT_TTL_MS + 1);

    const reloaded = new PageNotificationReceiptStore(
      storage,
      undefined,
      undefined,
      1_000 + PAGE_NOTIFICATION_RECEIPT_TTL_MS,
    );
    expect(reloaded.consumeMatching({ title: "Jane", body: "Old" })).toBeNull();
    expect(reloaded.consumeMatching({ title: "Jane", body: "Future" })).toBeNull();
  });

  test("keeps different group senders with identical short text separate", () => {
    const receipts = new PageNotificationReceiptStore();
    receipts.add("Project group", "Jane: OK", 42, 1_000);
    expect(
      receipts.consumeMatching({ title: "Project group", body: "John: OK" }, 1_100),
    ).toBeNull();
    expect(receipts.consumeMatching({ title: "Project group", body: "Jane: OK" }, 1_100)).toEqual({
      nativeId: 42,
    });
  });

  test("ignores malformed persisted receipts", () => {
    const storage = memoryStorage();
    storage.setItem(
      "__carrier_page_notification_receipts__",
      JSON.stringify([{ at: 1_000, nativeId: 42, identity: { title: "raw content" } }]),
    );
    expect(
      new PageNotificationReceiptStore(storage, undefined, undefined, 1_100).consumeMatching(
        { title: "raw content", body: "message" },
        1_100,
      ),
    ).toBeNull();
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

  test("marks a row-consumed signal but not an expired one", () => {
    const queue = new PageNotificationQueue();
    const consumed = queue.add({ at: 1_000, title: "Jane", body: "First" });
    const expired = queue.add({ at: 1_000, title: "John", body: "Second" });
    expect(queue.consumeMatching({ title: "Jane", body: "First" }, 1_100, 2_000)).not.toBeNull();
    expect(queue.consumeMatching({ title: "John", body: "Second" }, 3_001, 2_000)).toBeNull();
    // The async emitter skips the cross-reload receipt only for signals a row
    // actually paired with — an expired signal still deserves one.
    expect(consumed.matched).toBe(true);
    expect(expired.matched).toBeUndefined();
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

  test("a silent priming clears queued hydration mutations", () => {
    const tracker = new UnreadArrivalTracker(10_000);
    // Rows mutate while hydrating, then the first "(3)" primes silently.
    tracker.markRowsChanged(["a"], 1_100);
    expect(tracker.observeUnreadCount(3, 1_200, 2_000)).toEqual([]);
    // A second increase right behind it must not resurrect row "a" — only a
    // mutation recorded after the baseline may be attributed.
    expect(tracker.observeUnreadCount(4, 1_300, 2_000)).toEqual([]);
    tracker.markRowsChanged(["d"], 1_400);
    expect(tracker.observeUnreadCount(5, 1_500, 2_000)).toEqual(["d"]);
  });

  test("a corroborated zero baselines immediately for in-window arrivals", () => {
    const tracker = new UnreadArrivalTracker(10_000);
    // The scan saw a fully hydrated list with no unread rows — the zero is
    // the inbox's real state, not a still-unstamped title.
    expect(tracker.observeUnreadCount(0, 1_000, 2_000, true)).toEqual([]);
    tracker.markRowsChanged(["a"], 5_000);
    // A message arriving inside the settle window must still notify.
    expect(tracker.observeUnreadCount(1, 5_100, 2_000)).toEqual(["a"]);
  });

  test("a deferred zero becomes the baseline for a late first arrival", () => {
    const tracker = new UnreadArrivalTracker(10_000);
    // Reload into an all-read inbox: the only scan sees the still-hydrating
    // zero, then the hidden window goes quiet for a minute.
    expect(tracker.observeUnreadCount(0, 1_000, 2_000)).toEqual([]);
    // The first message's own mutation triggers the next scan — it must
    // report as an arrival, not prime silently as the baseline.
    tracker.markRowsChanged(["a"], 61_000);
    expect(tracker.observeUnreadCount(1, 61_100, 2_000)).toEqual(["a"]);
  });

  test("a count already present at first observation primes silently", () => {
    const tracker = new UnreadArrivalTracker(10_000);
    expect(tracker.observeUnreadCount(5, 1_000, 2_000)).toEqual([]);
    tracker.markRowsChanged(["a"], 1_100);
    expect(tracker.observeUnreadCount(6, 1_200, 2_000)).toEqual(["a"]);
  });
});

describe("StableMismatchTracker", () => {
  test("reports a stable mismatch exactly once after real elapsed time", () => {
    const tracker = new StableMismatchTracker(1_000);
    expect(tracker.observe([["1", "bbbb"]], 1_000)).toEqual({
      recovered: [],
      confirmInMs: 1_000,
    });
    expect(tracker.observe([["1", "bbbb"]], 1_999)).toEqual({
      recovered: [],
      confirmInMs: 1,
    });
    expect(tracker.observe([["1", "bbbb"]], 2_000)).toEqual({
      recovered: ["1"],
      confirmInMs: null,
    });
    expect(tracker.observe([["1", "bbbb"]], 3_000)).toEqual({
      recovered: [],
      confirmInMs: null,
    });
  });

  test("restarts the streak when a key stops mismatching", () => {
    const tracker = new StableMismatchTracker(1_000);
    tracker.observe([["1", "bbbb"]], 1_000);
    tracker.observe([], 1_500);
    expect(tracker.observe([["1", "bbbb"]], 2_000).recovered).toEqual([]);
    expect(tracker.observe([["1", "bbbb"]], 3_000).recovered).toEqual(["1"]);
  });

  test("restarts the streak when the fingerprint keeps shifting", () => {
    const tracker = new StableMismatchTracker(1_000);
    tracker.observe([["1", "bbbb"]], 1_000);
    expect(tracker.observe([["1", "cccc"]], 1_900).recovered).toEqual([]);
    expect(tracker.observe([["1", "cccc"]], 2_900).recovered).toEqual(["1"]);
  });

  test("duplicate keys cannot satisfy elapsed-time stability in one scan", () => {
    const tracker = new StableMismatchTracker(1_000);
    expect(
      tracker.observe(
        [
          ["1", "bbbb"],
          ["1", "bbbb"],
        ],
        1_000,
      ),
    ).toEqual({ recovered: [], confirmInMs: 1_000 });
    expect(tracker.observe([["1", "bbbb"]], 2_000).recovered).toEqual(["1"]);
  });

  test("a backward clock jump restarts mismatch confirmation", () => {
    const tracker = new StableMismatchTracker(1_000);
    tracker.observe([["1", "bbbb"]], 10_000);
    expect(tracker.observe([["1", "bbbb"]], 5_000).recovered).toEqual([]);
    expect(tracker.observe([["1", "bbbb"]], 5_999).recovered).toEqual([]);
    expect(tracker.observe([["1", "bbbb"]], 6_000).recovered).toEqual(["1"]);
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
