import { describe, expect, test } from "bun:test";
import {
  bubbleMatchesNotification,
  bubbleText,
  decideQuickLike,
  type QuickLikeSnapshot,
} from "./quick-like";

const snapshot = (overrides: Partial<QuickLikeSnapshot> = {}): QuickLikeSnapshot => ({
  threadMatches: true,
  targetFound: true,
  settled: true,
  reactButton: false,
  menu: "none",
  thumbShown: false,
  ...overrides,
});

describe("decideQuickLike", () => {
  test("hovers, opens the menu, picks 👍, and waits for the summary", () => {
    expect(decideQuickLike("waiting", snapshot({ targetFound: false }), false).action).toBe("wait");
    expect(decideQuickLike("waiting", snapshot(), false).action).toBe("hover");
    expect(decideQuickLike("waiting", snapshot({ reactButton: true }), false)).toEqual({
      action: "open-menu",
      phase: "menu",
    });
    expect(decideQuickLike("menu", snapshot(), false).action).toBe("wait");
    expect(decideQuickLike("menu", snapshot({ menu: "unselected" }), false)).toEqual({
      action: "select",
      phase: "confirming",
    });
    expect(decideQuickLike("confirming", snapshot({ menu: "unselected" }), false).action).toBe(
      "wait",
    );
    expect(
      decideQuickLike("confirming", snapshot({ menu: "selected", thumbShown: true }), false).action,
    ).toBe("success");
    expect(decideQuickLike("confirming", snapshot({ thumbShown: true }), false).action).toBe(
      "success",
    );
  });

  test("picks a target only after the list settles at the latest message", () => {
    expect(decideQuickLike("waiting", snapshot({ settled: false }), false).action).toBe("settle");
    expect(
      decideQuickLike("waiting", snapshot({ settled: false, reactButton: true }), false).action,
    ).toBe("settle");
  });

  test("never toggles off an existing 👍", () => {
    expect(decideQuickLike("menu", snapshot({ menu: "selected" }), false)).toEqual({
      action: "close-menu",
      phase: "confirming",
    });
  });

  test("fails when 👍 is not a quick reaction", () => {
    expect(decideQuickLike("menu", snapshot({ menu: "missing" }), false).action).toBe("failure");
  });

  test("fails when the thread changes after the menu opened", () => {
    expect(decideQuickLike("waiting", snapshot({ threadMatches: false }), false).action).toBe(
      "wait",
    );
    expect(
      decideQuickLike("menu", snapshot({ threadMatches: false, menu: "unselected" }), false).action,
    ).toBe("failure");
  });

  test("times out unless the reaction already landed", () => {
    expect(decideQuickLike("confirming", snapshot(), true).action).toBe("failure");
    expect(decideQuickLike("confirming", snapshot({ thumbShown: true }), true).action).toBe(
      "success",
    );
    expect(decideQuickLike("waiting", snapshot(), true).action).toBe("failure");
  });
});

describe("bubbleMatchesNotification", () => {
  const label = "Enter, Message sent Friday 9:34pm by Kim: See you at 5: bring snacks";

  test("reads the text after the sender, ignoring colons in the time", () => {
    expect(bubbleText(label)).toBe("See you at 5: bring snacks");
    expect(bubbleText("Enter, Message sent Friday 9:34pm by Kim")).toBe("");
  });

  test("matches exact, truncated, and sender-prefixed previews", () => {
    expect(bubbleMatchesNotification(label, "See you at 5: bring snacks")).toBe(true);
    expect(bubbleMatchesNotification(label, "See you at 5…")).toBe(true);
    expect(bubbleMatchesNotification(label, "Kim: See you at 5: bring snacks")).toBe(true);
  });

  test("rejects other messages and empty text", () => {
    expect(bubbleMatchesNotification(label, "Running late")).toBe(false);
    expect(bubbleMatchesNotification(label, "")).toBe(false);
    expect(
      bubbleMatchesNotification("Enter, Message sent Friday 9:34pm by Kim: ok", "is it ok"),
    ).toBe(false);
    expect(
      bubbleMatchesNotification("Enter, Message sent Friday 9:34pm by Kim", "Kim sent a photo"),
    ).toBe(false);
  });
});
