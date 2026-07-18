import { describe, expect, test } from "bun:test";
import { isMessengerHeaderOverflowControl } from "./settings-button";

describe("isMessengerHeaderOverflowControl", () => {
  test("recognizes Messenger's overflow icon independently of locale", () => {
    expect(isMessengerHeaderOverflowControl("M2.25 10a1.75 1.75 0 1 1 3.5 0")).toBe(true);
    expect(isMessengerHeaderOverflowControl("  M2.25 10a1.75 1.75 0 1 1 3.5 0")).toBe(true);
  });

  test("rejects unrelated controls", () => {
    expect(isMessengerHeaderOverflowControl("")).toBe(false);
    expect(isMessengerHeaderOverflowControl("M2.25 10a2 2 0 1 1 4 0")).toBe(false);
  });
});
