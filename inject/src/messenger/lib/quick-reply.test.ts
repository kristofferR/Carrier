import { describe, expect, test } from "bun:test";
import { composerContainsReply, decideQuickReply, type QuickReplySnapshot } from "./quick-reply";

const ready: QuickReplySnapshot = {
  threadMatches: true,
  composerReady: true,
  draftMatches: false,
  sendAvailable: false,
  composerEmpty: true,
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
});

describe("composerContainsReply", () => {
  test("verifies the inserted reply without normalizing its content", () => {
    expect(composerContainsReply("hello there", "hello")).toBe(true);
    expect(composerContainsReply("hello there", "HELLO")).toBe(false);
    expect(composerContainsReply(null, "hello")).toBe(false);
  });
});
