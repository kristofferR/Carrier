import { describe, expect, test } from "bun:test";
import {
  type ConversationTextCandidate,
  conversationTextParts,
  isUnreadConversationText,
} from "./conversation-row";

const candidate = (
  text: string,
  overrides: Partial<ConversationTextCandidate> = {},
): ConversationTextCandidate => ({
  text,
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  ariaHidden: false,
  inAbbreviation: false,
  hasTextChild: false,
  ...overrides,
});

describe("conversationTextParts", () => {
  test("orders visible deepest leaves and removes adjacent wrapper duplicates", () => {
    expect(
      conversationTextParts([
        candidate("10:30", { y: 0, inAbbreviation: true }),
        candidate("Preview", { y: 20 }),
        candidate("Jane", { y: 0 }),
        candidate("Jane", { y: 0, x: 20 }),
        candidate("wrapper", { y: 0, hasTextChild: true }),
        candidate("hidden", { y: 0, ariaHidden: true }),
      ]),
    ).toEqual({ title: "Jane", body: "Preview" });
  });

  test("uses safe defaults and caps scraped text", () => {
    expect(conversationTextParts([])).toEqual({
      title: "Messenger",
      body: "",
    });
    const parts = conversationTextParts([
      candidate("T".repeat(100)),
      candidate("B".repeat(300), { y: 20 }),
    ]);
    expect(parts.title).toHaveLength(80);
    expect(parts.body).toHaveLength(240);
  });
});

describe("isUnreadConversationText", () => {
  test("accepts semibold meaningful text", () => {
    expect(isUnreadConversationText("600", "Jane")).toBe(true);
    expect(isUnreadConversationText(700, "Preview")).toBe(true);
  });

  test("rejects light, empty, and one-character surfaces", () => {
    expect(isUnreadConversationText("500", "Jane")).toBe(false);
    expect(isUnreadConversationText("bold", "Jane")).toBe(false);
    expect(isUnreadConversationText("700", " ")).toBe(false);
    expect(isUnreadConversationText("700", "·")).toBe(false);
  });
});
