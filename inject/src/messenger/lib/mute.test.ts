import { describe, expect, test } from "bun:test";
import {
  conversationMuteFromLabel,
  ignoresMutedConversations,
  isExplicitUnmuteAction,
  isMutedRowIconShape,
  MutedThreadStore,
  muteSignalFromLabels,
  muteSignalFromSource,
  muteStateAfterExplicitAction,
  resolveMuteActionThreadId,
  resolveMuteObservation,
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

  test("defers an uncorrelated page notification while muted chats are filtered", () => {
    expect(suppressNotificationDelivery(false, {}, false)).toBe(true);
    expect(suppressNotificationDelivery(false, { ignore_muted_conversations: false }, false)).toBe(
      false,
    );
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
    expect(conversationMuteFromLabel("Notifications are off")).toBe(true);
    expect(conversationMuteFromLabel("Stummgeschaltet")).toBe(true);
  });

  test("treats Unmute as currently muted and Mute as currently unmuted", () => {
    expect(conversationMuteFromLabel("Unmute")).toBe(true);
    expect(conversationMuteFromLabel("Unmute notifications")).toBe(true);
    expect(conversationMuteFromLabel("Mute")).toBe(false);
    expect(conversationMuteFromLabel("Mute notifications")).toBe(false);
    expect(conversationMuteFromLabel("Turn off notifications")).toBe(false);
  });

  test("ignores names and unrelated chrome", () => {
    expect(conversationMuteFromLabel("Muted Group")).toBeNull();
    expect(conversationMuteFromLabel("Jane")).toBeNull();
    expect(conversationMuteFromLabel("Search")).toBeNull();
    expect(conversationMuteFromLabel("")).toBeNull();
  });
});

describe("muteSignalFromSource", () => {
  test("rejects avatar alt text and content labels", () => {
    expect(
      muteSignalFromSource({
        value: "Muted",
        tagName: "img",
        attribute: "alt",
      }),
    ).toBeNull();
    expect(
      muteSignalFromSource({
        value: "Muted",
        tagName: "a",
        role: "link",
        attribute: "aria-label",
      }),
    ).toBeNull();
  });

  test("accepts icon status and scoped action controls", () => {
    expect(
      muteSignalFromSource({
        value: "Muted",
        tagName: "div",
        attribute: "aria-label",
        containsSvg: true,
      }),
    ).toBe(true);
    expect(
      muteSignalFromSource({
        value: "Unmute notifications",
        tagName: "div",
        role: "menuitem",
        attribute: "aria-label",
      }),
    ).toBe(true);
    expect(
      muteSignalFromSource({
        value: "Mute notifications",
        tagName: "button",
        attribute: "aria-label",
      }),
    ).toBe(false);
  });
});

describe("isExplicitUnmuteAction", () => {
  test("distinguishes an Unmute action from a muted status", () => {
    expect(isExplicitUnmuteAction("Unmute notifications")).toBe(true);
    expect(isExplicitUnmuteAction("Muted")).toBe(false);
    expect(isExplicitUnmuteAction("Mute notifications")).toBe(false);
  });
});

describe("muteStateAfterExplicitAction", () => {
  test("mirrors both mute action directions into cached state", () => {
    expect(muteStateAfterExplicitAction("Mute notifications")).toBe(true);
    expect(muteStateAfterExplicitAction("Turn off notifications")).toBe(true);
    expect(muteStateAfterExplicitAction("Unmute notifications")).toBe(false);
    expect(muteStateAfterExplicitAction("Notifications are off")).toBeUndefined();
    expect(muteStateAfterExplicitAction("Muted")).toBeUndefined();
  });
});

describe("muteSignalFromLabels", () => {
  test("prefers a muted signal when both action kinds are present", () => {
    expect(muteSignalFromLabels(["Mute", "Unmute"])).toBe(true);
    expect(muteSignalFromLabels(["Mute"])).toBe(false);
    expect(muteSignalFromLabels(["Search", "Jane"])).toBeNull();
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

describe("resolveMuteActionThreadId", () => {
  test("uses the row that directly owns an action", () => {
    expect(resolveMuteActionThreadId("row", "open", "recent", true)).toBe("row");
  });

  test("prefers the open thread for header and info surfaces", () => {
    expect(resolveMuteActionThreadId("", "open", "unrelated-recent", true)).toBe("open");
  });

  test("uses the recent row for its portalled context menu", () => {
    expect(resolveMuteActionThreadId("", "open", "recent", false)).toBe("recent");
  });
});

describe("resolveMuteObservation", () => {
  test("keeps a row without a scoped mute signal inconclusive", () => {
    expect(resolveMuteObservation([])).toBeUndefined();
    expect(resolveMuteObservation(["Jane"])).toBeUndefined();
  });

  test("an explicit mute signal wins", () => {
    expect(resolveMuteObservation(["Muted"])).toBe(true);
    expect(resolveMuteObservation(["Mute"])).toBe(false);
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
