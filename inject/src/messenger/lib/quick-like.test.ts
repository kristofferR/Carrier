import { describe, expect, test } from "bun:test";
import {
  bubbleIsFresh,
  bubbleMatchesNotification,
  bubbleSentAt,
  bubbleText,
  decideQuickLike,
  type QuickLikeSnapshot,
} from "./quick-like";

const snapshot = (overrides: Partial<QuickLikeSnapshot> = {}): QuickLikeSnapshot => ({
  threadMatches: true,
  targetFound: true,
  settled: true,
  ambiguous: false,
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

  test("gives up rather than guess between identical fresh messages", () => {
    expect(decideQuickLike("waiting", snapshot({ ambiguous: true }), false).action).toBe("failure");
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

  test("never matches a suffix of a message that contains a colon", () => {
    const older = "Enter, Message sent 4:20 PM by Kim: Question: OK";
    expect(bubbleMatchesNotification(older, "OK")).toBe(false);
    expect(bubbleMatchesNotification(older, "Question: OK")).toBe(true);
  });

  test("matches exact, truncated, and sender-prefixed previews", () => {
    expect(bubbleMatchesNotification(label, "See you at 5: bring snacks")).toBe(true);
    expect(bubbleMatchesNotification(label, "See you at 5…")).toBe(true);
    expect(bubbleMatchesNotification(label, "Kim: See you at 5: bring snacks")).toBe(true);
    expect(bubbleMatchesNotification(label, "Kim: See you at 5…")).toBe(true);
    const fullName = "Enter, Message sent 4:20 PM by Kim Andersen: See you at 5";
    expect(bubbleMatchesNotification(fullName, "Kim: See you at 5")).toBe(true);
  });

  test("requires an exact match unless the preview was truncated", () => {
    const older = "Enter, Message sent 4:20 PM by Kim: OK thanks";
    expect(bubbleMatchesNotification(older, "OK")).toBe(false);
    expect(bubbleMatchesNotification(older, "OK…")).toBe(true);
  });

  test("strips a prefix only when it names the sender", () => {
    const ok = "Enter, Message sent 4:20 PM by Kim: OK";
    expect(bubbleMatchesNotification(ok, "Question: OK")).toBe(false);
    expect(bubbleMatchesNotification(ok, "Kim: OK")).toBe(true);
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

describe("bubbleIsFresh", () => {
  // Thursday 1 October 2026, local time.
  const at = (day: number, hours: number, minutes: number, seconds = 30) =>
    new Date(2026, 9, day, hours, minutes, seconds).getTime();
  const now = at(1, 16, 30);

  test("reads labels relative to now, in both Messenger time formats", () => {
    expect(bubbleSentAt("Enter, Message sent 4:20 PM by Kim: hi", now)).toBe(at(1, 16, 20, 0));
    expect(bubbleSentAt("Enter, Message sent 16:20 by Kim: hi", now)).toBe(at(1, 16, 20, 0));
    expect(bubbleSentAt("Enter, Message sent 12:05 AM by Kim: hi", now)).toBe(at(1, 0, 5, 0));
    expect(bubbleSentAt("Enter, Message sent Yesterday 11:58pm by Kim: hi", now)).toBe(
      at(0, 23, 58, 0),
    );
    expect(bubbleSentAt("Enter, Message sent Tuesday 10:42pm by Kim: hi", now)).toBe(
      at(-1, 22, 42, 0),
    );
    expect(bubbleSentAt("Enter, Message sent Thursday 9:00am by Kim: hi", now)).toBe(
      at(-6, 9, 0, 0),
    );
    expect(bubbleSentAt("Enter, Message sent Sep 23 4:20pm by Kim: hi", now)).toBeNull();
  });

  test("accepts a message sent shortly before its notification", () => {
    expect(bubbleIsFresh("Enter, Message sent 4:20 PM by Kim: OK", at(1, 16, 20), now)).toBe(true);
    expect(bubbleIsFresh("Enter, Message sent 4:16 PM by Kim: OK", at(1, 16, 20), now)).toBe(true);
  });

  test("accepts an older notification acted on later, across midnight", () => {
    expect(
      bubbleIsFresh("Enter, Message sent Yesterday 11:58pm by Kim: OK", at(1, 0, 1), now),
    ).toBe(true);
    expect(
      bubbleIsFresh("Enter, Message sent Tuesday 10:42pm by Kim: OK", at(-1, 22, 43), now),
    ).toBe(true);
  });

  test("rejects an older message with the same text", () => {
    expect(bubbleIsFresh("Enter, Message sent 4:02 PM by Kim: OK", at(1, 16, 20), now)).toBe(false);
    expect(bubbleIsFresh("Enter, Message sent Tuesday 4:20pm by Kim: OK", at(1, 16, 20), now)).toBe(
      false,
    );
  });
});
