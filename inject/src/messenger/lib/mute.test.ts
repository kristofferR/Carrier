import { describe, expect, test } from "bun:test";
import {
  badgeIgnoresMutedConversations,
  ignoresMutedConversations,
  isMutedRowIconShape,
  MutedThreadStore,
  mutedConversationPolicy,
  suppressMutedDelivery,
  suppressNotificationDelivery,
} from "./mute";

describe("suppressMutedDelivery", () => {
  test("skips muted threads only while the setting is on", () => {
    expect(suppressMutedDelivery(true, {})).toBe(true);
    expect(suppressMutedDelivery(true, { ignore_muted_conversations: false })).toBe(false);
    expect(suppressMutedDelivery(false, {})).toBe(false);
  });
});

describe("suppressNotificationDelivery", () => {
  test("uses the settings and mute state present at the delivery boundary", () => {
    const settings = { mute_notifications: false, ignore_muted_conversations: false };
    expect(suppressNotificationDelivery(true, settings)).toBe(false);
    settings.ignore_muted_conversations = true;
    expect(suppressNotificationDelivery(true, settings)).toBe(true);
    settings.mute_notifications = true;
    expect(suppressNotificationDelivery(false, settings)).toBe(true);
  });

  test("does not treat an unresolved thread as muted", () => {
    expect(suppressNotificationDelivery(false, {})).toBe(false);
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

describe("isMutedRowIconShape", () => {
  const mutedBell = {
    width: 16,
    height: 16,
    rightGap: 16,
    interactive: false,
    ariaHidden: true,
    viewBox: "0 0 16 16",
    pathCount: 1,
    shapeHash: 0x774a4a14,
    pathPrefixMatched: false,
  };

  test("recognizes Messenger's live unlabeled slashed-bell row icon", () => {
    expect(isMutedRowIconShape(mutedBell)).toBe(true);
  });

  test("still recognizes the icon when an unread dot shifts it left", () => {
    expect(isMutedRowIconShape({ ...mutedBell, rightGap: 38 })).toBe(true);
    expect(isMutedRowIconShape({ ...mutedBell, rightGap: 120 })).toBe(false);
  });

  test("accepts the current path prefix only inside the verified row-icon geometry", () => {
    expect(
      isMutedRowIconShape({
        ...mutedBell,
        shapeHash: 0x12345678,
        pathPrefixMatched: true,
      }),
    ).toBe(true);
    expect(
      isMutedRowIconShape({
        ...mutedBell,
        width: 20,
        shapeHash: 0x12345678,
        pathPrefixMatched: true,
      }),
    ).toBe(false);
  });

  test("rejects the adjacent interactive row action and lookalike status icons", () => {
    expect(
      isMutedRowIconShape({
        ...mutedBell,
        width: 20,
        height: 20,
        rightGap: 44,
        interactive: true,
        viewBox: "0 0 20 20",
        shapeHash: 0x59ac161b,
      }),
    ).toBe(false);
    expect(isMutedRowIconShape({ ...mutedBell, shapeHash: 0x12345678 })).toBe(false);
  });
});

describe("MutedThreadStore", () => {
  test("remembers mute while a row is virtualized, then accepts an unmuted observation", () => {
    const store = new MutedThreadStore();
    store.observe("1", true);
    expect(store.isMuted("1")).toBe(true);
    store.observe("1", undefined);
    expect(store.isMuted("1")).toBe(true);
    store.observe("1", false);
    expect(store.isMuted("1")).toBe(false);
  });

  test("clears a cached mute only after mounted signal absence is stable", () => {
    const store = new MutedThreadStore();
    store.observe("1", true);
    store.observeMountedRow("1", undefined, 1_000);
    expect(store.isMuted("1")).toBe(true);
    store.observeMountedRow("1", undefined, 1_999);
    expect(store.isMuted("1")).toBe(true);
    store.observeMountedRow("1", undefined, 2_000);
    expect(store.isMuted("1")).toBe(false);
  });

  test("a positive row signal cancels pending absence confirmation", () => {
    const store = new MutedThreadStore();
    store.observe("1", true);
    store.observeMountedRow("1", undefined, 1_000);
    store.observeMountedRow("1", true, 1_500);
    store.observeMountedRow("1", undefined, 2_000);
    store.observeMountedRow("1", undefined, 2_500);
    expect(store.isMuted("1")).toBe(true);
  });

  test("invalidates a cached mute after an explicit unmute action", () => {
    const store = new MutedThreadStore();
    store.observe("1", true);
    store.invalidateMute("1");
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

describe("mutedConversationPolicy", () => {
  test("keeps the legacy switch until a policy is chosen", () => {
    expect(mutedConversationPolicy({})).toBe("ignore");
    expect(mutedConversationPolicy({ ignore_muted_conversations: false })).toBe("include");
    expect(
      mutedConversationPolicy({ ignore_muted_conversations: false, muted_conversations: "badge" }),
    ).toBe("badge");
    expect(mutedConversationPolicy({ muted_conversations: null })).toBe("ignore");
  });

  test("badge only counts muted chats on the badge but never notifies for them", () => {
    const badgeOnly = { muted_conversations: "badge" as const };
    expect(badgeIgnoresMutedConversations(badgeOnly)).toBe(false);
    expect(ignoresMutedConversations(badgeOnly)).toBe(true);
    expect(suppressMutedDelivery(true, badgeOnly)).toBe(true);

    const include = { muted_conversations: "include" as const };
    expect(badgeIgnoresMutedConversations(include)).toBe(false);
    expect(suppressMutedDelivery(true, include)).toBe(false);

    const ignore = { muted_conversations: "ignore" as const };
    expect(badgeIgnoresMutedConversations(ignore)).toBe(true);
    expect(suppressMutedDelivery(true, ignore)).toBe(true);
  });
});
