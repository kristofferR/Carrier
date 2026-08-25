import { describe, expect, test } from "bun:test";
import {
  didMutedFilterPolicyChange,
  MUTED_UNREAD_CLEAR_CONFIRM_MS,
  MutedUnreadStore,
  mutedUnreadStorageKey,
  reconcileMutedUnreadIds,
  reconcileUnreadConversationCount,
  reconcileUnreadMessageCount,
  unreadCountFromTitle,
} from "./unread";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

describe("didMutedFilterPolicyChange", () => {
  test("detects both policy transition directions, but not initialization", () => {
    expect(didMutedFilterPolicyChange(null, true)).toBe(false);
    expect(didMutedFilterPolicyChange(true, true)).toBe(false);
    expect(didMutedFilterPolicyChange(true, false)).toBe(true);
    expect(didMutedFilterPolicyChange(false, true)).toBe(true);
  });
});

describe("unreadCountFromTitle", () => {
  test("parses Facebook's '(N)' title prefix", () => {
    expect(unreadCountFromTitle("(3) Messenger")).toBe(3);
    expect(unreadCountFromTitle("(12) Chats | Messenger")).toBe(12);
  });

  test("reads 0 when no count is present", () => {
    expect(unreadCountFromTitle("Messenger")).toBe(0);
    expect(unreadCountFromTitle("")).toBe(0);
  });

  test("ignores non-numeric parentheses", () => {
    expect(unreadCountFromTitle("(draft) Messenger")).toBe(0);
  });

  test("takes a numeric prefix without mistaking thread-title text for a badge", () => {
    expect(unreadCountFromTitle("(2) Kim (1) something")).toBe(2);
    expect(unreadCountFromTitle("Kim (1) something | Messenger")).toBe(0);
  });
});

describe("reconcileUnreadMessageCount", () => {
  test("keeps the title count until the conversation list is trustworthy", () => {
    expect(reconcileUnreadMessageCount(2, 0, false)).toBe(2);
  });

  test("clears a stale title count after every hydrated conversation is read", () => {
    expect(reconcileUnreadMessageCount(2, 0, true)).toBe(0);
  });

  test("preserves per-message totals and never undercounts unread conversations", () => {
    expect(reconcileUnreadMessageCount(5, 2, true)).toBe(5);
    expect(reconcileUnreadMessageCount(1, 2, true)).toBe(2);
  });

  test("drops the title total when muted unreads contaminate it", () => {
    expect(reconcileUnreadMessageCount(5, 1, true, true)).toBe(1);
    expect(reconcileUnreadMessageCount(5, 0, true, true)).toBe(0);
  });

  test("retains the last filtered total while rows are virtualized", () => {
    expect(reconcileUnreadMessageCount(5, 1, false, true, 3)).toBe(3);
    expect(reconcileUnreadMessageCount(5, 1, false, true)).toBeNull();
  });

  test("keeps the title path when no muted unread is known", () => {
    expect(reconcileUnreadMessageCount(5, 1, true, false)).toBe(5);
    expect(reconcileUnreadMessageCount(5, 0, false, false)).toBe(5);
  });
});

describe("reconcileUnreadConversationCount", () => {
  test("retains the filtered baseline while muted rows are virtualized", () => {
    expect(reconcileUnreadConversationCount(1, false, true, 3)).toBe(3);
    expect(reconcileUnreadConversationCount(1, false, true, null)).toBeNull();
  });

  test("uses the live count when the list is trustworthy or filtering is off", () => {
    expect(reconcileUnreadConversationCount(2, true, true, 3)).toBe(2);
    expect(reconcileUnreadConversationCount(2, false, false, 3)).toBe(2);
  });
});

describe("reconcileMutedUnreadIds", () => {
  test("retains a muted unread while its row is virtualized", () => {
    let known = reconcileMutedUnreadIds([], [{ id: "1", unread: true, muted: true }]);
    known = reconcileMutedUnreadIds(known, []);
    expect([...known]).toEqual(["1"]);
    expect(reconcileUnreadMessageCount(5, 0, false, known.size > 0, 3)).toBe(3);
  });

  test("clears only after that thread is observed read or unmuted", () => {
    const known = reconcileMutedUnreadIds(
      ["1", "2"],
      [
        { id: "1", unread: false, muted: true },
        { id: "2", unread: true, muted: false },
      ],
    );
    expect(known.size).toBe(0);
  });

  test("keeps virtualized ids while reconciling other visible threads", () => {
    const known = reconcileMutedUnreadIds(
      ["virtualized"],
      [{ id: "visible", unread: true, muted: false }],
    );
    expect([...known]).toEqual(["virtualized"]);
  });

  test("keeps destructive hydration unknown while accepting a positive mute", () => {
    expect(
      reconcileMutedUnreadIds(
        ["1"],
        [
          { id: "1", unread: false, muted: false, hydrated: false },
          { id: "2", unread: true, muted: true, hydrated: false },
        ],
      ),
    ).toEqual(new Set(["1", "2"]));
  });
});

describe("mutedUnreadStorageKey", () => {
  test("scopes persisted evidence to the Facebook account cookie", () => {
    expect(mutedUnreadStorageKey("locale=en; c_user=12345; xs=secret")).toBe(
      "__carrier_muted_unreads__:12345",
    );
    expect(mutedUnreadStorageKey("locale=en")).toBeNull();
    expect(mutedUnreadStorageKey("c_user=not-an-id")).toBeNull();
  });
});

describe("MutedUnreadStore", () => {
  test("retains muted unread evidence across a document reload", () => {
    const storage = memoryStorage();
    const current = new MutedUnreadStore(storage);
    current.reconcile([{ id: "123", unread: true, muted: true }]);

    expect(new MutedUnreadStore(storage).size).toBe(1);
  });

  test("persists stable same-thread read and unmute invalidation", () => {
    const storage = memoryStorage();
    const current = new MutedUnreadStore(storage);
    current.reconcile([
      { id: "123", unread: true, muted: true },
      { id: "456", unread: true, muted: true },
    ]);
    const observations = [
      { id: "123", unread: false, muted: true, hydrated: true },
      { id: "456", unread: true, muted: false, hydrated: true },
    ];
    current.reconcile(observations, 1_000);
    current.reconcile(observations, 1_000 + MUTED_UNREAD_CLEAR_CONFIRM_MS - 1);
    expect(new MutedUnreadStore(storage).size).toBe(2);
    current.reconcile(observations, 1_000 + MUTED_UNREAD_CLEAR_CONFIRM_MS);

    expect(new MutedUnreadStore(storage).size).toBe(0);
  });

  test("does not retire persisted evidence from an unhydrated reload scan", () => {
    const storage = memoryStorage();
    const current = new MutedUnreadStore(storage);
    current.reconcile([{ id: "123", unread: true, muted: true }], 1_000);
    current.reconcile(
      [{ id: "123", unread: false, muted: false, hydrated: false }],
      1_000 + MUTED_UNREAD_CLEAR_CONFIRM_MS,
    );

    expect(new MutedUnreadStore(storage).size).toBe(1);
  });

  test("records positive muted-unread evidence during partial hydration", () => {
    const storage = memoryStorage();
    const current = new MutedUnreadStore(storage);
    current.reconcile([{ id: "123", unread: true, muted: true, hydrated: false }], 1_000);

    expect(new MutedUnreadStore(storage).size).toBe(1);
  });

  test("resets retirement evidence when the row virtualizes", () => {
    const storage = memoryStorage();
    const current = new MutedUnreadStore(storage);
    current.reconcile([{ id: "123", unread: true, muted: true }], 1_000);
    const read = [{ id: "123", unread: false, muted: true, hydrated: true }];
    current.reconcile(read, 2_000);
    current.reconcile([], 2_000 + MUTED_UNREAD_CLEAR_CONFIRM_MS);
    current.reconcile(read, 2_000 + MUTED_UNREAD_CLEAR_CONFIRM_MS + 1);

    expect(new MutedUnreadStore(storage).size).toBe(1);
  });

  test("isolates persisted evidence between Facebook accounts", () => {
    const storage = memoryStorage();
    const first = new MutedUnreadStore(storage, "__carrier_muted_unreads__:1");
    first.reconcile([{ id: "123", unread: true, muted: true }]);

    expect(new MutedUnreadStore(storage, "__carrier_muted_unreads__:1").size).toBe(1);
    expect(new MutedUnreadStore(storage, "__carrier_muted_unreads__:2").size).toBe(0);
  });

  test("immediately persists explicit unmute invalidation", () => {
    const storage = memoryStorage();
    const current = new MutedUnreadStore(storage);
    current.reconcile([{ id: "123", unread: true, muted: true }]);
    current.invalidate("123");

    expect(new MutedUnreadStore(storage).size).toBe(0);
  });

  test("preserves evidence while filtering is temporarily disabled", () => {
    const storage = memoryStorage();
    const current = new MutedUnreadStore(storage);
    current.reconcile([{ id: "123", unread: true, muted: true }]);

    expect(reconcileUnreadMessageCount(5, 1, true, false)).toBe(5);
    expect(current.size).toBe(1);
    expect(reconcileUnreadMessageCount(5, 1, true, current.size > 0)).toBe(1);
  });

  test("rejects malformed persisted thread identities", () => {
    const storage = memoryStorage();
    storage.setItem(
      "__carrier_muted_unreads__",
      JSON.stringify({ version: 1, ids: ["123", "group-name", "", 456] }),
    );

    expect(new MutedUnreadStore(storage).size).toBe(1);
  });
});
