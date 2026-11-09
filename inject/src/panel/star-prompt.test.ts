import { describe, expect, test } from "bun:test";
import { isQuietMoment, type StarPromptMoment } from "./star-prompt";

const quiet: StarPromptMoment = {
  focused: true,
  messengerUi: true,
  dialogOpen: false,
  msSinceKey: Number.POSITIVE_INFINITY,
  draftLength: 0,
};

describe("isQuietMoment", () => {
  test("allows a focused chat list with no typing and no draft", () => {
    expect(isQuietMoment(quiet)).toBe(true);
  });

  test("waits while typing, over a draft, on a dialog, or off Messenger", () => {
    expect(isQuietMoment({ ...quiet, msSinceKey: 3_000 })).toBe(false);
    expect(isQuietMoment({ ...quiet, draftLength: 4 })).toBe(false);
    expect(isQuietMoment({ ...quiet, dialogOpen: true })).toBe(false);
    expect(isQuietMoment({ ...quiet, messengerUi: false })).toBe(false);
    expect(isQuietMoment({ ...quiet, focused: false })).toBe(false);
  });
});
