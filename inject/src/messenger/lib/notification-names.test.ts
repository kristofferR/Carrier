import { describe, expect, test } from "bun:test";
import { nicknameMode, showNicknames } from "./nicknames";
import { notificationDedupeKey, notificationPresentation } from "./notification-fallback";
import {
  type ConversationNotificationNames,
  notificationNames,
  notificationSender,
  readConversationNotificationNames,
} from "./notification-names";

const alex = { name: "Alex Example", firstName: "Alex", nickname: "Captain", avatar: "alex.jpg" };
const group: ConversationNotificationNames = {
  title: "Weekend",
  isGroup: true,
  participants: [alex],
};

describe("notification nickname presentation", () => {
  test("uses the preference with a sender photo or a group-photo fallback", () => {
    const original = { title: "Weekend", body: "Captain: hello Captain" };
    const fingerprint = notificationDedupeKey(original.title, original.body);
    for (const sender of ["alex.jpg", ""]) {
      const presentation = notificationPresentation(original.title, original.body, true, {
        sender,
        thread: "group.jpg",
      });
      const kind = presentation.subtitle ? "sender" : "group";
      expect(notificationNames(presentation.title, presentation.body, group, false, kind)).toEqual(
        sender
          ? { title: "Alex", body: "hello Captain" }
          : { title: "Weekend", body: "Alex: hello Captain" },
      );
      expect(notificationNames(presentation.title, presentation.body, group, true, kind)).toEqual({
        title: presentation.title,
        body: presentation.body,
      });
    }
    expect(notificationSender(original.body, group)?.avatar).toBe("alex.jpg");
    expect(notificationDedupeKey(original.title, original.body)).toBe(fingerprint);
  });

  test("group-only and master settings apply to group and one-to-one notifications", () => {
    for (const enabled of [true, false]) {
      for (const groupOnly of [true, false]) {
        const mode = nicknameMode({ show_nicknames: enabled, nicknames_group_only: groupOnly });
        expect(
          notificationNames("Weekend", "Alex: hello", group, showNicknames(mode, true), "group")
            .body,
        ).toBe(enabled ? "Captain: hello" : "Alex: hello");
        const direct = { ...group, isGroup: false };
        expect(
          notificationNames("Captain", "Captain: hello", direct, showNicknames(mode, false)),
        ).toEqual({
          title: enabled && !groupOnly ? "Captain" : "Alex Example",
          body: "Captain: hello",
        });
      }
    }
  });

  test("one-to-one only uses nicknames in private notifications and real names in groups", () => {
    const mode = nicknameMode({ nickname_scope: "direct" });
    expect(
      notificationNames(
        "Captain",
        "hello",
        { ...group, isGroup: false },
        showNicknames(mode, false),
      ),
    ).toEqual({ title: "Captain", body: "hello" });
    expect(
      notificationNames("Weekend", "Captain: hello", group, showNicknames(mode, true), "group"),
    ).toEqual({ title: "Weekend", body: "Alex: hello" });
  });

  test("handles native page titles without changing message text or a member-named group", () => {
    expect(notificationNames("Captain", "Alex: is a label I typed", group, false)).toEqual({
      title: "Alex",
      body: "Alex: is a label I typed",
    });
    expect(notificationNames("Alex Example", "hi", group, true)).toEqual({
      title: "Captain",
      body: "hi",
    });
    expect(
      notificationNames("Captain", "Captain: hi", { ...group, title: "Captain" }, false),
    ).toEqual({
      title: "Captain",
      body: "Alex: hi",
    });
    expect(notificationNames("Weekend", "Captain: hi", null, false)).toEqual({
      title: "Weekend",
      body: "Captain: hi",
    });
  });

  test("scopes nicknames to the group and falls back to real names when unset", () => {
    const other = { ...group, participants: [{ ...alex, nickname: "Skipper" }] };
    expect(notificationNames("Weekend", "Alex: hi", other, true, "group").body).toBe("Skipper: hi");
    expect(notificationNames("Weekend", "Alex: hi", group, true, "group").body).toBe("Captain: hi");
    expect(
      notificationNames(
        "Weekend",
        "Alex: hi",
        { ...group, participants: [{ ...alex, nickname: "" }] },
        true,
        "group",
      ).body,
    ).toBe("Alex: hi");
    expect(
      notificationNames(
        "Weekend",
        "Captain: hi",
        { ...group, participants: [{ ...alex, firstName: "" }] },
        false,
        "group",
      ).body,
    ).toBe("Alex Example: hi");
  });

  test("does not guess between shared nicknames, first names, or colon prefixes", () => {
    for (const other of [
      { name: "Sam Example", firstName: "Sam", nickname: "Captain", avatar: "sam.jpg" },
      { name: "Captain Example", firstName: "Captain", nickname: "Sam", avatar: "sam.jpg" },
      { name: "Sam Example", firstName: "Sam", nickname: "Captain: Jr", avatar: "sam.jpg" },
    ]) {
      const ambiguous = { ...group, participants: [alex, other] };
      const body = "Captain: Jr: hello";
      expect(notificationNames("Weekend", body, ambiguous, false, "group").body).toBe(body);
      expect(notificationSender(body, ambiguous)).toBeUndefined();
    }
    const colon = { ...group, participants: [{ ...alex, nickname: "Captain: Jr" }] };
    expect(notificationNames("Weekend", "Captain: Jr: hello", colon, false, "group").body).toBe(
      "Alex: hello",
    );
  });

  test("requires an explicit field role when a native page title cannot identify the group", () => {
    const unnamed = { ...group, title: "" };
    expect(notificationNames("Captain", "Alex: hello", unnamed, false)).toEqual({
      title: "Captain",
      body: "Alex: hello",
    });
    expect(notificationNames("Captain", "Alex: hello", unnamed, false, "sender")).toEqual({
      title: "Alex",
      body: "Alex: hello",
    });
  });
});

function databaseHarness(
  rows: unknown = [[{ nickname: "Captain" }, { name: "Alex Example", firstName: "Alex" }]],
  isGroup = true,
) {
  const keys: unknown[] = [];
  const limits: number[] = [];
  const participants = {};
  const contacts = {};
  const query = {
    getKeyRange: (key: unknown) => {
      keys.push(key);
      return query;
    },
    take: (limit: number) => {
      limits.push(limit);
      return query;
    },
  };
  const modules: Record<string, unknown> = {
    LSDatabaseSingleton: {
      LSDatabaseSingleton: Promise.resolve({
        tables: {
          participants,
          contacts,
          threads: {
            get: async (key: unknown) => {
              keys.push(key);
              return { threadName: "Weekend", threadType: isGroup ? 2 : 1 };
            },
          },
        },
      }),
    },
    I64: { of_string: (value: string) => `key:${value}` },
    LSMessagingThreadTypeUtil: {
      isGroup: (value: unknown) => value === 2,
      isOneToOne: (value: unknown) => value === 1,
    },
    ReQL: {
      fromTableAscending: (table: unknown) => {
        expect(table === participants || table === contacts).toBe(true);
        return query;
      },
      leftJoin: () => query,
      toArrayAsync: async () => rows,
    },
    getLSMediaContactProfilePictureUrl: () => "alex.jpg",
  };
  return { modules, keys, limits, load: (name: string) => modules[name] };
}

describe("Messenger group-name reader", () => {
  test("reads only the requested group's bounded membership and its contact photos", async () => {
    const h = databaseHarness();
    expect(await readConversationNotificationNames("123", h.load)).toEqual(group);
    expect(h.keys).toEqual(["key:123", "key:123"]);
    expect(h.limits).toEqual([501]);
  });

  test("reads one-to-one chats without parsing their message body as a sender prefix", async () => {
    const direct = databaseHarness(undefined, false);
    const names = await readConversationNotificationNames("123", direct.load);
    expect(names?.isGroup).toBe(false);
    expect(notificationNames("Captain", "Alex: hello", names, false)).toEqual({
      title: "Alex Example",
      body: "Alex: hello",
    });
    expect(notificationNames("Alex Example", "Captain: hello", names, true)).toEqual({
      title: "Captain",
      body: "Captain: hello",
    });
    expect(notificationSender("Captain: hello", names)).toBeUndefined();
  });

  test("leaves incomplete membership, missing APIs and timeouts alone", async () => {
    for (const rows of [
      null,
      [],
      [[{ nickname: "Captain" }, null]],
      Array(501).fill([{}, { name: "Alex" }]),
    ]) {
      expect(await readConversationNotificationNames("123", databaseHarness(rows).load)).toBeNull();
    }
    expect(await readConversationNotificationNames("123", undefined)).toBeNull();
    expect(
      await readConversationNotificationNames("123", () => {
        throw new Error("module unavailable");
      }),
    ).toBeNull();
    expect(
      await readConversationNotificationNames("not-a-thread", () => {
        throw new Error("should not load");
      }),
    ).toBeNull();
    const pending = databaseHarness();
    pending.modules.LSDatabaseSingleton = { LSDatabaseSingleton: new Promise(() => {}) };
    expect(await readConversationNotificationNames("123", pending.load, 1)).toBeNull();
  });
});
