import { describe, expect, test } from "bun:test";
import { emojiGlyph, isReactionMenuShape } from "./emoji";

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

describe("isReactionMenuShape", () => {
  test("accepts reaction slots plus one add-reaction button", () => {
    expect(
      isReactionMenuShape([
        ...Array.from({ length: 6 }, () => ({ glyphs: 1, role: null })),
        { glyphs: 0, role: "button" },
      ]),
    ).toBe(true);
  });

  test("rejects ordinary menus and a plus button containing an emoji", () => {
    expect(
      isReactionMenuShape([
        { glyphs: 1, role: null },
        { glyphs: 0, role: "button" },
      ]),
    ).toBe(false);
    expect(
      isReactionMenuShape([
        ...Array.from({ length: 6 }, () => ({ glyphs: 1, role: null })),
        { glyphs: 1, role: "button" },
      ]),
    ).toBe(false);
  });
});
