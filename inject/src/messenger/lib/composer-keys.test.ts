import { describe, expect, test } from "bun:test";
import {
  type ComposerEnterState,
  isVoiceClipCancelIcon,
  shouldEscapeCancelVoiceClip,
  shouldKeepEnterInComposer,
  type VoiceClipEscapeState,
} from "./composer-keys";

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

describe("voice clip Escape", () => {
  const plainEscape: VoiceClipEscapeState = {
    key: "Escape",
    isComposing: false,
    defaultPrevented: false,
    escapeOwnedElsewhere: false,
    inChat: true,
  };

  test("recognizes the cancel icon by its path, not its label", () => {
    expect(isVoiceClipCancelIcon("M8 .5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM5 5l6 6")).toBe(
      true,
    );
    expect(isVoiceClipCancelIcon("M8 .5A3.5 3.5 0 0 0 4.5 4")).toBe(false);
    expect(isVoiceClipCancelIcon(null)).toBe(false);
  });

  test("cancels only for a plain Escape in the chat", () => {
    expect(shouldEscapeCancelVoiceClip(plainEscape)).toBe(true);
    expect(shouldEscapeCancelVoiceClip({ ...plainEscape, key: "Enter" })).toBe(false);
    expect(shouldEscapeCancelVoiceClip({ ...plainEscape, isComposing: true })).toBe(false);
    expect(shouldEscapeCancelVoiceClip({ ...plainEscape, defaultPrevented: true })).toBe(false);
    expect(shouldEscapeCancelVoiceClip({ ...plainEscape, escapeOwnedElsewhere: true })).toBe(false);
    expect(shouldEscapeCancelVoiceClip({ ...plainEscape, inChat: false })).toBe(false);
  });
});
