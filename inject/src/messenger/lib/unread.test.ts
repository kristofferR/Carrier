import { describe, expect, test } from "bun:test";
import {
  didMutedFilterPolicyChange,
  reconcileMutedUnreadIds,
  reconcileUnreadConversationCount,
  reconcileUnreadMessageCount,
  unreadCountFromTitle,
} from "./unread";

describe("didMutedFilterPolicyChange", () => {
  test("invalidates state in both policy directions, but not on initialization", () => {
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
});
