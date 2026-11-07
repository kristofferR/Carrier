import { describe, expect, test } from "bun:test";
import {
  EXPLICIT_ACTION_HOLD_MS,
  explicitActionRecent,
  noteExplicitAction,
  shouldFocusComposerOnReturn,
} from "./composer-focus";

const base = { enabled: true, threadOpen: true, dialogOpen: false, focus: "nothing" as const };

describe("explicitActionRecent", () => {
  test("holds for a short while after a native action", () => {
    noteExplicitAction(1_000);
    expect(explicitActionRecent(1_000 + EXPLICIT_ACTION_HOLD_MS - 1)).toBe(true);
    expect(explicitActionRecent(1_000 + EXPLICIT_ACTION_HOLD_MS)).toBe(false);
  });
});

describe("shouldFocusComposerOnReturn", () => {
  test("focuses the composer when nothing, or only a chat row, holds focus", () => {
    expect(shouldFocusComposerOnReturn(base)).toBe(true);
    expect(shouldFocusComposerOnReturn({ ...base, focus: "chat-list" })).toBe(true);
  });

  test("leaves focus alone when the user is elsewhere or it is off", () => {
    expect(shouldFocusComposerOnReturn({ ...base, focus: "elsewhere" })).toBe(false);
    expect(shouldFocusComposerOnReturn({ ...base, dialogOpen: true })).toBe(false);
    expect(shouldFocusComposerOnReturn({ ...base, threadOpen: false })).toBe(false);
    expect(shouldFocusComposerOnReturn({ ...base, enabled: false })).toBe(false);
  });
});
