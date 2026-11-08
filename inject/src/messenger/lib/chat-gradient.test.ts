import { describe, expect, test } from "bun:test";
import { chatGradientCss, collectBubbleClasses, type RuleLike } from "./chat-gradient";

const rule = (selectorText: string, backgroundColor: string): RuleLike => ({
  selectorText,
  style: { getPropertyValue: (name) => (name === "background-color" ? backgroundColor : "") },
});

describe("collectBubbleClasses", () => {
  test("finds single-class rules colored with the outgoing bubble color, nested ones too", () => {
    const found = new Set<string>();
    collectBubbleClasses(
      [
        rule(".x1abc", "var(--chat-outgoing-message-bubble-background-color)"),
        rule(".x2def", "var( --chat-outgoing-message-bubble-background-color , #0866ff )"),
        { cssRules: [rule(".x3ghi", "var(--chat-outgoing-message-bubble-background-color)")] },
      ],
      found,
    );
    expect([...found]).toEqual([".x1abc", ".x2def", ".x3ghi"]);
  });

  test("ignores other colors, other variables and compound selectors", () => {
    const found = new Set<string>();
    collectBubbleClasses(
      [
        rule(".x1", "var(--chat-incoming-message-bubble-background-color)"),
        rule(".x2", "var(--chat-outgoing-message-bubble-background-color-hover)"),
        rule(".x3:hover", "var(--chat-outgoing-message-bubble-background-color)"),
        rule(".x4 .x5", "var(--chat-outgoing-message-bubble-background-color)"),
        rule(".x6", "#0866ff"),
      ],
      found,
    );
    expect(found.size).toBe(0);
  });
});

describe("chatGradientCss", () => {
  test("moves the gradient onto the bubbles and off the box", () => {
    const css = chatGradientCss([".x1abc", ".x2def"]);
    expect(css).toContain(":is(.x1abc, .x2def)");
    expect(css).toContain("background-image: var(--chat-outgoing-message-background-gradient)");
    expect(css).toContain("background-attachment: fixed");
    // The box rule must carry no specificity, so themes that paint it win.
    expect(css).toMatch(/^:where\(.*\) \{\n {2}background-image: none !important;/m);
  });

  test("nothing without bubble classes, so the box keeps its gradient", () => {
    expect(chatGradientCss([])).toBe("");
  });
});
