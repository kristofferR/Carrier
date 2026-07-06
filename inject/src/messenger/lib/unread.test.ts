import { describe, expect, test } from "bun:test";
import { unreadCountFromTitle } from "./unread";

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

  test("takes the first numeric group", () => {
    expect(unreadCountFromTitle("(2) Kim (1) something")).toBe(2);
  });
});
