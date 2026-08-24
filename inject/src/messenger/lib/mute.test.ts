import { describe, expect, test } from "bun:test";
import {
  conversationMuteFromLabel,
  ignoresMutedConversations,
  MUTE_SVG_PATH_PREFIXES,
  MutedThreadStore,
  muteSignalFromLabels,
  muteSignalFromSvgPaths,
  muteStateAfterMenuLabel,
  muteStatesFromPayload,
  parseFacebookPayload,
  resolveMuteObservation,
  suppressMutedDelivery,
} from "./mute";

const CAPRINE_MUTE_PATH =
  "M29.676 7.746c.353-.352.44-.92.15-1.324a1 1 0 00-1.524-.129L6.293 28.29a1 1 0 00.129 1.523c.404.29.972.204 1.324-.148l3.082-3.08A2.002 2.002 0 0112.242 26h15.244c.848 0 1.57-.695 1.527-1.541-.084-1.643-1.87-1.145-2.2-3.515l-1.073-8.157-.002-.01a1.976 1.976 0 01.562-1.656l3.376-3.375zm-9.165 20.252H15.51c-.313 0-.565.275-.506.575.274 1.38 1.516 2.422 3.007 2.422 1.49 0 2.731-1.042 3.005-2.422.06-.3-.193-.575-.505-.575zm-10.064-6.719L22.713 9.02a.997.997 0 00-.124-1.51 7.792 7.792 0 00-12.308 5.279l-1.04 7.897c-.089.672.726 1.074 1.206.594z";

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

  test("reads muted as a status segment in composite row names", () => {
    expect(conversationMuteFromLabel("Jane Doe, muted")).toBe(true);
    expect(conversationMuteFromLabel("Jane Doe · Muted")).toBe(true);
    expect(conversationMuteFromLabel("Jane (Muted)")).toBe(true);
    expect(conversationMuteFromLabel("Conversation with Jane. Notifications muted.")).toBe(true);
  });
});

describe("muteStateAfterMenuLabel", () => {
  test("Mute silences the thread and Unmute restores it", () => {
    expect(muteStateAfterMenuLabel("Mute notifications")).toBe(true);
    expect(muteStateAfterMenuLabel("Mute")).toBe(true);
    expect(muteStateAfterMenuLabel("Unmute notifications")).toBe(false);
    expect(muteStateAfterMenuLabel("Jane")).toBeNull();
  });
});

describe("muteSignalFromLabels", () => {
  test("prefers a muted signal when both action kinds are present", () => {
    expect(muteSignalFromLabels(["Mute", "Unmute"])).toBe(true);
    expect(muteSignalFromLabels(["Mute"])).toBe(false);
    expect(muteSignalFromLabels(["Search", "Jane"])).toBeNull();
  });
});

describe("muteSignalFromSvgPaths", () => {
  test("recognises the Caprine mute-icon path", () => {
    expect(MUTE_SVG_PATH_PREFIXES[0]).toBe("M29.676 7.746");
    expect(muteSignalFromSvgPaths([CAPRINE_MUTE_PATH])).toBe(true);
    expect(muteSignalFromSvgPaths(["M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10"])).toBeNull();
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

  test("an unlabeled mute-icon path counts as muted", () => {
    expect(resolveMuteObservation([], true, [CAPRINE_MUTE_PATH])).toBe(true);
    expect(resolveMuteObservation([], false, [CAPRINE_MUTE_PATH])).toBe(true);
  });
});

describe("muteStatesFromPayload", () => {
  test("reads mute_until on a thread_key node", () => {
    expect(
      muteStatesFromPayload({
        data: {
          viewer: {
            thread: {
              thread_key: { thread_fbid: "123456789012" },
              mute_until: -1,
            },
          },
        },
      }),
    ).toEqual([{ id: "123456789012", muted: true }]);
    expect(
      muteStatesFromPayload({
        thread_key: { other_user_id: "987654321000" },
        mute_until: 0,
      }),
    ).toEqual([{ id: "987654321000", muted: false }]);
  });

  test("ignores objects that are not a thread mute pair", () => {
    expect(muteStatesFromPayload({ mute_until: -1, id: "not-a-thread" })).toEqual([]);
    expect(muteStatesFromPayload({ thread_fbid: "123456789012" })).toEqual([]);
  });
});

describe("parseFacebookPayload", () => {
  test("strips the for(;;); anti-hijack prefix", () => {
    expect(parseFacebookPayload('for (;;);{"ok":true}')).toEqual({ ok: true });
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

  test("a payload mute survives an unread row with no glyph", () => {
    const store = new MutedThreadStore();
    for (const { id, muted } of muteStatesFromPayload({
      thread_key: { thread_fbid: "123456789012" },
      mute_until: -1,
    })) {
      store.observe(id, muted);
    }
    store.observe("123456789012", resolveMuteObservation(["Jane"], true));
    expect(store.isMuted("123456789012")).toBe(true);
    expect(suppressMutedDelivery(store.isMuted("123456789012"), {})).toBe(true);
  });

  test("a local mute hold rejects a conflicting payload", () => {
    const store = new MutedThreadStore();
    store.observe("1", true, 10_000);
    store.observe("1", false);
    expect(store.isMuted("1")).toBe(true);
  });

  test("restores muted ids from storage", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
    };
    const first = new MutedThreadStore(storage);
    first.observe("123", true);
    first.observe("123", false);
    first.observe("456", true);
    const second = new MutedThreadStore(storage);
    expect(second.isMuted("456")).toBe(true);
    expect(second.isMuted("123")).toBe(false);
  });
});
