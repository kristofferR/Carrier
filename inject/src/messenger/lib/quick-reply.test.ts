import { describe, expect, test } from "bun:test";
import {
  composerContainsReply,
  composerIncludesReply,
  decideQuickReply,
  type QuickReplySnapshot,
} from "./quick-reply";

const ready: QuickReplySnapshot = {
  threadMatches: true,
  composerReady: true,
  draftMatches: false,
  sendAvailable: false,
  composerEmpty: true,
  manualSubmitted: false,
};

describe("decideQuickReply", () => {
  test("waits for the validated thread and composer before inserting", () => {
    expect(decideQuickReply("waiting", { ...ready, threadMatches: false }, false)).toEqual({
      action: "wait",
      phase: "waiting",
    });
    expect(decideQuickReply("waiting", ready, false)).toEqual({
      action: "insert",
      phase: "inserted",
    });
  });

  test("fails immediately instead of merging into an existing draft", () => {
    const existingDraft = { ...ready, composerEmpty: false };
    expect(decideQuickReply("waiting", existingDraft, false)).toEqual({
      action: "failure",
      phase: "waiting",
    });
  });

  test("never sends after the page navigates to another recipient", () => {
    expect(
      decideQuickReply(
        "inserted",
        {
          ...ready,
          threadMatches: false,
          draftMatches: true,
          sendAvailable: true,
        },
        false,
      ),
    ).toEqual({ action: "failure", phase: "inserted" });
  });

  test("requires verified text and Messenger's send control", () => {
    expect(
      decideQuickReply("inserted", { ...ready, draftMatches: true, sendAvailable: true }, false),
    ).toEqual({ action: "send", phase: "confirming" });
    expect(decideQuickReply("inserted", { ...ready, sendAvailable: true }, false)).toEqual({
      action: "failure",
      phase: "inserted",
    });
  });

  test("confirms success only after the composer empties", () => {
    expect(decideQuickReply("confirming", { ...ready, composerEmpty: false }, false)).toEqual({
      action: "wait",
      phase: "confirming",
    });
    expect(decideQuickReply("confirming", ready, false)).toEqual({
      action: "success",
      phase: "confirming",
    });
  });

  test("recognizes a trusted manual submission after insertion", () => {
    expect(decideQuickReply("inserted", { ...ready, manualSubmitted: true }, false)).toEqual({
      action: "success",
      phase: "confirming",
    });
    expect(
      decideQuickReply(
        "inserted",
        {
          ...ready,
          composerEmpty: false,
          draftMatches: true,
          sendAvailable: true,
          manualSubmitted: true,
        },
        false,
      ),
    ).toEqual({ action: "wait", phase: "inserted" });
  });

  test("waits for React to render the send control, then sends without Enter", () => {
    const inserted = { ...ready, draftMatches: true, composerEmpty: false };
    expect(decideQuickReply("inserted", inserted, false).action).toBe("wait");
    expect(decideQuickReply("inserted", { ...inserted, sendAvailable: true }, false).action).toBe(
      "send",
    );
    expect(decideQuickReply("inserted", { ...inserted, sendAvailable: true }, true).action).toBe(
      "failure",
    );
  });
});

describe("composerContainsReply", () => {
  test("verifies the inserted reply without normalizing its content", () => {
    expect(composerContainsReply("hello there", "hello there")).toBe(true);
    expect(composerContainsReply("hello there", "hello")).toBe(false);
    expect(composerContainsReply("hello there", "HELLO")).toBe(false);
    expect(composerContainsReply(null, "hello")).toBe(false);
  });
});

test("draft fallback recognizes a reply the user has edited", () => {
  expect(composerContainsReply("hello there!", "hello there")).toBe(false);
  expect(composerIncludesReply("hello there!", "hello there")).toBe(true);
  expect(composerIncludesReply("other draft", "hello there")).toBe(false);
});
