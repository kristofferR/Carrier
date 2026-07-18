import { describe, expect, test } from "bun:test";
import { isMessengerHeaderOverflowControl } from "./settings-button";

describe("isMessengerHeaderOverflowControl", () => {
  test("recognizes Messenger's accessible overflow label", () => {
    expect(isMessengerHeaderOverflowControl("Settings, help and more", "")).toBe(true);
    expect(isMessengerHeaderOverflowControl(" Settings, help and more ", "")).toBe(true);
  });

  test("rejects Carrier's button and unrelated controls", () => {
    expect(isMessengerHeaderOverflowControl("Carrier Settings", "")).toBe(false);
    expect(isMessengerHeaderOverflowControl("More actions", "M2.25 10a2 2 0 1 1 4 0")).toBe(false);
  });
});
