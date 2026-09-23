import { expect, test } from "bun:test";
import { NativeThreadTitles, patchNicknameThreadTitles } from "./nickname-thread-titles";
import type { NicknameMode } from "./nicknames";
import { ConversationNotificationTracker, notificationDedupeKey } from "./notification-fallback";

test("one-to-one titles toggle without changing subscribed participant records or notification identity", () => {
  let mode: NicknameMode = "all";
  const participant = Object.freeze({ nickname: "Captain", contactId: "456" });
  const contact = Object.freeze({ name: "Alex Example" });
  const pairs = Object.freeze([Object.freeze([participant, contact])]);
  const result = Object.freeze({
    threadTitle: "Captain",
    actorId: "viewer",
    participantsAndContacts: pairs,
  });
  const thread = { threadType: "direct", threadKey: "123" };
  const exports = { default: (_thread: unknown): unknown => result };
  const modules: Record<string, unknown> = {
    react: {
      useSyncExternalStore: (_subscribe: unknown, snapshot: () => NicknameMode) => snapshot(),
      useMemo: (compute: () => unknown) => compute(),
    },
    I64: { to_string: (key: unknown) => key },
    intlList: { default: { CONJUNCTIONS: { NONE: "none" } } },
    LSMessagingThreadTypeUtil: { isGroup: (type: unknown) => type === "group" },
    MWPGetThreadTitle: {
      computeThreadTitle: (
        conjunction: unknown,
        type: unknown,
        input: Array<[{ nickname?: string }, { name: string }]>,
        actor: unknown,
      ) => {
        expect(conjunction).toBe("none");
        expect(["direct", "group"]).toContain(String(type));
        expect(actor).toBe("viewer");
        return input[0]![0].nickname ?? input[0]![1].name;
      },
    },
  };
  const titles = new NativeThreadTitles();
  patchNicknameThreadTitles(
    exports,
    (name) => modules[name],
    {
      getSnapshot: () => mode,
      subscribe: () => () => {},
    },
    titles,
  );
  expect(exports.default(thread)).toBe(result);
  const tracker = new ConversationNotificationTracker();
  const signature = (displayed: string) => ({
    key: "123",
    signature: notificationDedupeKey(titles.original("123", displayed), "hello"),
  });
  expect(tracker.observe([signature("Captain")])).toEqual([]);
  mode = "off";
  expect(exports.default(thread)).toEqual({ ...result, threadTitle: "Alex Example" });
  expect(tracker.observe([signature("Alex Example")])).toEqual([]);
  mode = "groups";
  expect(exports.default(thread)).toEqual({ ...result, threadTitle: "Alex Example" });
  expect(exports.default({ ...thread, threadType: "group" })).toBe(result);
  mode = "direct";
  expect(exports.default(thread)).toBe(result);
  expect(exports.default({ ...thread, threadType: "group" })).toEqual({
    ...result,
    threadTitle: "Alex Example",
  });
  expect(participant.nickname).toBe("Captain");
  mode = "all";
  expect(exports.default(thread)).toBe(result);
  expect(tracker.observe([signature("Captain")])).toEqual([]);
  expect(titles.original("123", "New custom title")).toBe("New custom title");
  expect(titles.original("999", "Alex Example")).toBe("Alex Example");
});

test("changed title hook exports keep their original behavior", () => {
  const original = () => ({ changed: true });
  const exports = { default: original };
  patchNicknameThreadTitles(exports, () => ({}), {
    getSnapshot: () => "off",
    subscribe: () => () => {},
  });
  expect(exports.default).toBe(original);
});

test("generated group titles use current presentation while matching retains the original", () => {
  const titles = new NativeThreadTitles();
  titles.remember("123", "Captain, Skipper", "Alex, Sam");
  const original = titles.original("123", "Alex, Sam");
  expect(original).toBe("Captain, Skipper");
  expect(titles.displayed("123", original)).toBe("Alex, Sam");
  // A setting change during notification enrichment uses the latest title.
  titles.remember("123", "Captain, Skipper", "Captain, Skipper");
  expect(titles.displayed("123", original, "Alex, Sam")).toBe("Captain, Skipper");
  expect(titles.displayed("123", "Custom group name")).toBe("Custom group name");
  expect(titles.displayed("999", "Native", "Displayed")).toBe("Displayed");
});
