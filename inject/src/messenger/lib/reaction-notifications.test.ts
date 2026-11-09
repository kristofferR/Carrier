import { describe, expect, test } from "bun:test";
import { LATE_NOTIFICATION_MS } from "./page-notifications";
import { changedReaction, type Reaction, ReactionAnnouncements } from "./reaction-notifications";

// Messenger's I64 values are opaque; its I64 module turns them into text.
const i64 = (value: string) => ({ value });
const load = (name: string) =>
  name === "I64" ? { to_string: (value: { value: string }) => value.value } : undefined;

const row = {
  threadKey: i64("7"),
  messageId: "mid.1",
  actorId: i64("42"),
  reaction: "❤",
  reactionCreationTimestampMs: i64("5000"),
  timestampMs: i64("5000"),
};

describe("changedReaction", () => {
  test("reads an added or replaced reaction", () => {
    const reaction = { thread: "7", message: "mid.1", actor: "42", emoji: "❤", at: 5000 };
    expect(changedReaction({ operation: "add", value: row }, load)).toEqual(reaction);
    expect(changedReaction({ operation: "put", value: row }, load)).toEqual(reaction);
    // Without a creation time, the reacted message's time stands in: never later.
    const untimed = { ...row, reactionCreationTimestampMs: i64("0"), timestampMs: i64("4000") };
    expect(changedReaction({ operation: "add", value: untimed }, load)?.at).toBe(4000);
  });

  test("ignores removals and rows a notification can't use", () => {
    expect(changedReaction({ operation: "delete", value: row }, load)).toBeNull();
    expect(changedReaction({ operation: "add", value: { ...row, reaction: "" } }, load)).toBeNull();
    expect(
      changedReaction({ operation: "add", value: { ...row, actorId: null } }, load),
    ).toBeNull();
    expect(changedReaction({ operation: "add" }, load)).toBeNull();
    expect(changedReaction(null, load)).toBeNull();
  });
});

describe("ReactionAnnouncements", () => {
  const reaction: Reaction = { thread: "7", message: "mid.1", actor: "42", emoji: "❤", at: 5000 };

  test("announces someone else's new reaction once, and again when it changes", () => {
    const announcements = new ReactionAnnouncements(4000);
    expect(announcements.first(reaction, "100", 6000)).toBe(true);
    expect(announcements.first(reaction, "100", 6000)).toBe(false);
    expect(announcements.first({ ...reaction, emoji: "😂", at: 5100 }, "100", 6000)).toBe(true);
    // Changed back: a new reaction, not the first one again.
    expect(announcements.first({ ...reaction, at: 5200 }, "100", 6000)).toBe(true);
  });

  test("skips the account's own, older and late reactions", () => {
    const announcements = new ReactionAnnouncements(4000);
    expect(announcements.first(reaction, "42", 6000)).toBe(false);
    expect(announcements.first({ ...reaction, at: 3999 }, "100", 6000)).toBe(false);
    expect(announcements.first({ ...reaction, at: null }, "100", 6000)).toBe(false);
    expect(announcements.first(reaction, "100", 5000 + LATE_NOTIFICATION_MS + 1)).toBe(false);
  });
});
