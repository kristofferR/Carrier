import { describe, expect, test } from "bun:test";
import { reconcileUnreadMessageCount, unreadCountFromTitle } from "./unread";

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
    expect(reconcileUnreadMessageCount(5, 1, false, true)).toBe(1);
  });

  test("keeps the title path when no muted unread is known", () => {
    expect(reconcileUnreadMessageCount(5, 1, true, false)).toBe(5);
    expect(reconcileUnreadMessageCount(5, 0, false, false)).toBe(5);
  });
});
