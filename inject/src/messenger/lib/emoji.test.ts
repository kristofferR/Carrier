import { describe, expect, test } from "bun:test";
import { emojiGlyph } from "./emoji";

describe("emojiGlyph", () => {
  test("passes through bare emoji", () => {
    expect(emojiGlyph("😀")).toBe("😀");
    expect(emojiGlyph("👍🏽")).toBe("👍🏽");
    expect(emojiGlyph("❤️")).toBe("❤️");
  });

  test("rejects labels, long strings, and empties", () => {
    expect(emojiGlyph("smiling face")).toBe("");
    expect(emojiGlyph("😀 yes")).toBe(""); // letters mixed in
    expect(emojiGlyph("😀".repeat(20))).toBe(""); // > 24 chars
    expect(emojiGlyph("")).toBe("");
    expect(emojiGlyph(null)).toBe("");
  });
});
