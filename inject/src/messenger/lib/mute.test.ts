import { describe, expect, test } from "bun:test";
import {
  conversationMuteFromLabel,
  ignoresMutedConversations,
  MutedThreadStore,
  muteSignalFromLabels,
  resolveMuteObservation,
  suppressMutedDelivery,
} from "./mute";

describe("suppressMutedDelivery", () => {
  test("skips muted threads only while the setting is on", () => {
    expect(suppressMutedDelivery(true, {})).toBe(true);
    expect(suppressMutedDelivery(true, { ignore_muted_conversations: false })).toBe(false);
    expect(suppressMutedDelivery(false, {})).toBe(false);
  });
});

describe("ignoresMutedConversations", () => {
  test("defaults to on when the setting is missing", () => {
    expect(ignoresMutedConversations(undefined)).toBe(true);
    expect(ignoresMutedConversations({})).toBe(true);
  });

  test("honours an explicit off", () => {
    expect(ignoresMutedConversations({ ignore_muted_conversations: false })).toBe(false);
    expect(ignoresMutedConversations({ ignore_muted_conversations: true })).toBe(true);
  });
});

describe("conversationMuteFromLabel", () => {
  test("reads mute status phrases", () => {
    expect(conversationMuteFromLabel("Muted")).toBe(true);
    expect(conversationMuteFromLabel("notifications muted")).toBe(true);
    expect(conversationMuteFromLabel("Muted notifications")).toBe(true);
    expect(conversationMuteFromLabel("Stummgeschaltet")).toBe(true);
  });

  test("treats Unmute as currently muted and Mute as currently unmuted", () => {
    expect(conversationMuteFromLabel("Unmute")).toBe(true);
    expect(conversationMuteFromLabel("Unmute notifications")).toBe(true);
    expect(conversationMuteFromLabel("Mute")).toBe(false);
    expect(conversationMuteFromLabel("Mute notifications")).toBe(false);
  });

  test("ignores names and unrelated chrome", () => {
    expect(conversationMuteFromLabel("Muted Group")).toBeNull();
    expect(conversationMuteFromLabel("Jane")).toBeNull();
    expect(conversationMuteFromLabel("Search")).toBeNull();
    expect(conversationMuteFromLabel("")).toBeNull();
  });
});

describe("muteSignalFromLabels", () => {
  test("prefers a muted signal when both action kinds are present", () => {
    expect(muteSignalFromLabels(["Mute", "Unmute"])).toBe(true);
    expect(muteSignalFromLabels(["Mute"])).toBe(false);
    expect(muteSignalFromLabels(["Search", "Jane"])).toBeNull();
  });
});

describe("resolveMuteObservation", () => {
  test("keeps an unread row without a glyph as unknown", () => {
    expect(resolveMuteObservation([], true)).toBeUndefined();
    expect(resolveMuteObservation(["Jane"], true)).toBeUndefined();
  });

  test("treats a read row without a glyph as unmuted", () => {
    expect(resolveMuteObservation([], false)).toBe(false);
  });

  test("an explicit glyph wins over read/unread", () => {
    expect(resolveMuteObservation(["Muted"], true)).toBe(true);
    expect(resolveMuteObservation(["Muted"], false)).toBe(true);
    expect(resolveMuteObservation(["Mute"], false)).toBe(false);
  });
});

describe("MutedThreadStore", () => {
  test("remembers mute until an unmuted observation", () => {
    const store = new MutedThreadStore();
    store.observe("1", true);
    expect(store.isMuted("1")).toBe(true);
    store.observe("1", undefined);
    expect(store.isMuted("1")).toBe(true);
    store.observe("1", false);
    expect(store.isMuted("1")).toBe(false);
  });

  test("reports a known muted unread", () => {
    const store = new MutedThreadStore();
    store.observe("muted", true);
    store.observe("open", false);
    expect(store.knownMutedUnread(["open", "muted"])).toBe(true);
    expect(store.knownMutedUnread(["open"])).toBe(false);
    expect(store.knownMutedUnread([])).toBe(false);
  });
});
