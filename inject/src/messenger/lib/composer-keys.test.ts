import { describe, expect, test } from "bun:test";
import { type ComposerEnterState, shouldKeepEnterInComposer } from "./composer-keys";

const normalEnter: ComposerEnterState = {
  key: "Enter",
  isComposing: false,
  compositionActive: false,
  keyCode: 13,
  requireAccelerator: false,
  acceleratorPressed: false,
  shiftKey: false,
};

describe("shouldKeepEnterInComposer", () => {
  test("keeps every composing Enter away from Messenger", () => {
    expect(shouldKeepEnterInComposer({ ...normalEnter, isComposing: true })).toBe(true);
    expect(shouldKeepEnterInComposer({ ...normalEnter, compositionActive: true })).toBe(true);
    expect(shouldKeepEnterInComposer({ ...normalEnter, keyCode: 229 })).toBe(true);
  });

  test("does not affect ordinary keys or the default Enter behavior", () => {
    expect(shouldKeepEnterInComposer({ ...normalEnter, key: "a", isComposing: true })).toBe(false);
    expect(shouldKeepEnterInComposer(normalEnter)).toBe(false);
  });

  test("requires the platform accelerator only when the option is enabled", () => {
    const optIn = { ...normalEnter, requireAccelerator: true };
    expect(shouldKeepEnterInComposer(optIn)).toBe(true);
    expect(shouldKeepEnterInComposer({ ...optIn, acceleratorPressed: true })).toBe(false);
    expect(shouldKeepEnterInComposer({ ...optIn, shiftKey: true })).toBe(false);
  });
});
