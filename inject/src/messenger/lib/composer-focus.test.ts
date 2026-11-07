import { describe, expect, test } from "bun:test";
import { shouldFocusComposerOnReturn } from "./composer-focus";

const base = { enabled: true, threadOpen: true, dialogOpen: false, focus: "nothing" as const };

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
