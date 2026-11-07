import { describe, expect, test } from "bun:test";
import {
  buildConversationExport,
  callFromAttachment,
  EXPORT_MESSAGE_LIMIT,
  type ExportRows,
  exportHistory,
  i64Text,
  readConversationExport,
  revealText,
} from "./conversation-export";

// Messenger's I64 values are opaque objects; model them as tagged boxes.
const i64 = (value: string) => ({ i64: value });
const i64ToText = (value: unknown) => (value as { i64?: string }).i64;

// Messenger's vault wraps ciphertext in its "<10>##<10>" marker on both sides.
const MARKER = "1234567890##0987654321";
const vaulted = (secret: string) => `${MARKER}AQ${btoa(secret)}${MARKER}`;
const unvault = (value: string) =>
  value.startsWith(MARKER) ? atob(value.slice(MARKER.length + 2, -MARKER.length)) : value;

const T0 = Date.UTC(2026, 10, 7, 9, 30);

function rows(overrides: Partial<ExportRows> = {}): ExportRows {
  return {
    threadId: "100",
    threadName: "",
    isGroup: true,
    viewerId: "1",
    participants: [
      [
        { contactId: i64("1"), nickname: null },
        { id: i64("1"), name: "Kris Viewer" },
      ],
      [
        { contactId: i64("2"), nickname: "Captain" },
        { id: i64("2"), name: "Alex Example" },
      ],
    ],
    contacts: [{ id: i64("3"), name: "Former Member" }],
    messages: [
      {
        messageId: "mid.2",
        timestampMs: i64(String(T0 + 60_000)),
        senderId: i64("1"),
        text: "Sounds good",
        replySourceId: "mid.1",
        replyToUserId: i64("2"),
        replyMessageText: "Lunch?",
        editCount: i64("1"),
      },
      { messageId: "mid.1", timestampMs: i64(String(T0)), senderId: i64("2"), text: "Lunch?" },
      {
        messageId: "mid.3",
        timestampMs: i64(String(T0 + 120_000)),
        senderId: i64("3"),
        text: null,
        stickerId: i64("0"),
      },
      { messageId: "mid.4", timestampMs: i64(String(T0 + 180_000)), isUnsent: true, text: "gone" },
      { messageId: "bad", timestampMs: "not a number" },
      "not a row",
    ],
    reactions: [
      {
        messageId: "mid.1",
        actorId: i64("3"),
        reaction: "😂",
        timestampMs: i64(String(T0 + 5_000)),
      },
      {
        messageId: "mid.1",
        actorId: i64("1"),
        reaction: "❤",
        timestampMs: i64(String(T0 + 1_000)),
      },
      { messageId: "mid.1", actorId: i64("2"), reaction: "" },
    ],
    attachments: [
      { messageId: "mid.3", attachmentIndex: i64("1"), filename: "notes.pdf" },
      { messageId: "mid.3", attachmentIndex: i64("0"), previewUrlMimeType: "image/jpeg" },
    ],
    ranges: [{ hasMoreBefore: true }],
    truncated: false,
    missing: [],
    utcOffsetMinutes: () => 60,
    ...overrides,
  };
}

describe("i64Text", () => {
  test("reads Messenger's integer encodings and rejects anything else", () => {
    expect(i64Text(42)).toBe("42");
    expect(i64Text(42n)).toBe("42");
    expect(i64Text("-1")).toBe("-1");
    expect(i64Text(i64("9007199254740993"), i64ToText)).toBe("9007199254740993");
    expect(i64Text(1.5)).toBeNull();
    expect(i64Text("12a")).toBeNull();
    expect(i64Text({}, () => ({}))).toBeNull();
    expect(
      i64Text({}, () => {
        throw new Error("bad");
      }),
    ).toBeNull();
  });
});

describe("revealText", () => {
  test("decrypts vaulted text the way Messenger's views do", () => {
    expect(revealText(vaulted("hei"), unvault)).toEqual({ text: "hei", unreadable: false });
    expect(revealText("plain", unvault)).toEqual({ text: "plain", unreadable: false });
    expect(revealText(null, unvault)).toEqual({ text: null, unreadable: false });
    expect(revealText("  ", unvault)).toEqual({ text: null, unreadable: false });
  });

  test("never passes ciphertext off as text", () => {
    const locked = { text: null, unreadable: true };
    expect(revealText(vaulted("hei"))).toEqual(locked);
    expect(revealText(vaulted("hei"), (value) => value)).toEqual(locked);
    expect(revealText(vaulted("hei"), () => 42)).toEqual(locked);
    expect(
      revealText(vaulted("hei"), () => {
        throw new Error("Encountered vaulted value with incorrect key");
      }),
    ).toEqual(locked);
  });
});

describe("callFromAttachment", () => {
  const dataclass = (data: Record<string, unknown>) =>
    JSON.stringify({
      content: {
        __typename: "XMSGXmaSingleContent",
        custom_template_data: { __typename: "XMSGXmaCallingTemplateData", ...data },
      },
    });

  test("reads encrypted chats' calling template, also when vaulted", () => {
    expect(
      callFromAttachment({ xmaDataclass: dataclass({ call_type: "VIDEO", call_state: "MISSED" }) }),
    ).toEqual({ type: "video", outcome: "missed", durationSec: null });
    expect(
      callFromAttachment(
        {
          xmaDataclass: vaulted(
            dataclass({ call_type: "AUDIO", call_state: "ENDED", call_duration_sec: 125.4 }),
          ),
        },
        unvault,
      ),
    ).toEqual({ type: "audio", outcome: "ended", durationSec: 125 });
    const list = JSON.stringify({
      content: {
        list: [{ custom_template_data: { __typename: "XMSGXmaCallingTemplateData" } }],
      },
    });
    expect(callFromAttachment({ xmaDataclass: list })).toEqual({
      type: "audio",
      outcome: null,
      durationSec: null,
    });
  });

  test("reads other chats' RTC call CTA types", () => {
    expect(callFromAttachment({ defaultCtaType: "xma_rtc_missed_video" })).toEqual({
      type: "video",
      outcome: "missed",
      durationSec: null,
    });
    expect(callFromAttachment({ cta1Type: "xma_rtc_ended_audio" })).toMatchObject({
      type: "audio",
      outcome: "ended",
    });
  });

  test("leaves other attachments alone", () => {
    expect(callFromAttachment({ hasXma: true, defaultCtaType: "xma_web_url" })).toBeNull();
    expect(callFromAttachment({ xmaDataclass: "{not json" })).toBeNull();
    expect(
      callFromAttachment({
        xmaDataclass: JSON.stringify({
          content: {
            __typename: "XMSGXmaSingleContent",
            custom_template_data: { __typename: "X" },
          },
        }),
      }),
    ).toBeNull();
  });
});

describe("buildConversationExport", () => {
  test("maps rows to chronological messages with senders, replies, reactions and attachments", () => {
    const data = buildConversationExport(rows(), i64ToText);
    expect(data.conversation).toEqual({
      id: "100",
      title: "Alex Example",
      isGroup: true,
      participants: [
        { id: "1", name: "Kris Viewer", nickname: null },
        { id: "2", name: "Alex Example", nickname: "Captain" },
      ],
    });
    expect(data.history).toBe("partial");
    expect(data.truncated).toBe(false);
    expect(data.messages.map((message) => message.id)).toEqual([
      "mid.1",
      "mid.2",
      "mid.3",
      "mid.4",
    ]);
    const [first, reply, attachmentOnly, unsent] = data.messages;
    expect(first).toMatchObject({
      senderId: "2",
      senderName: "Alex Example",
      timestampMs: T0,
      utcOffsetMinutes: 60,
      text: "Lunch?",
      unreadable: false,
      call: null,
      replyTo: null,
    });
    // Sorted by time; the empty reaction is dropped; a former member resolves by contact.
    expect(first?.reactions).toEqual([
      { actorId: "1", actorName: "Kris Viewer", reaction: "❤", timestampMs: T0 + 1_000 },
      { actorId: "3", actorName: "Former Member", reaction: "😂", timestampMs: T0 + 5_000 },
    ]);
    expect(reply).toMatchObject({
      edited: true,
      replyTo: { messageId: "mid.1", senderId: "2", senderName: "Alex Example", text: "Lunch?" },
    });
    expect(attachmentOnly).toMatchObject({
      senderName: "Former Member",
      text: null,
      sticker: false,
      attachments: [
        { kind: "image", filename: null, title: null, mimeType: "image/jpeg" },
        { kind: "file", filename: "notes.pdf", title: null, mimeType: null },
      ],
    });
    expect(unsent).toMatchObject({ unsent: true, text: null, senderId: null, senderName: null });
  });

  test("decrypts encrypted chats and marks what it cannot read", () => {
    const data = buildConversationExport(
      rows({
        threadName: vaulted("Trip"),
        messages: [
          { messageId: "mid.1", timestampMs: String(T0), text: vaulted("Hei!") },
          {
            messageId: "mid.2",
            timestampMs: String(T0 + 1),
            text: "5555555555##5555555555AQxyz5555555555##5555555555",
            replySourceId: "mid.1",
            replyMessageText: vaulted("Hei!"),
          },
          { messageId: "mid.3", timestampMs: String(T0 + 2) },
        ],
        attachments: [
          {
            messageId: "mid.3",
            hasXma: true,
            xmaDataclass: vaulted(
              JSON.stringify({
                content: {
                  __typename: "XMSGXmaSingleContent",
                  custom_template_data: {
                    __typename: "XMSGXmaCallingTemplateData",
                    call_type: "AUDIO",
                    call_state: "MISSED",
                  },
                },
              }),
            ),
          },
        ],
      }),
      i64ToText,
      unvault,
    );
    expect(data.conversation.title).toBe("Trip");
    const [hello, locked, call] = data.messages;
    expect(hello).toMatchObject({ text: "Hei!", unreadable: false });
    // Vaulted under a different key: never exported as text.
    expect(locked).toMatchObject({ text: null, unreadable: true, replyTo: { text: "Hei!" } });
    expect(call).toMatchObject({
      text: null,
      attachments: [],
      call: { type: "audio", outcome: "missed", durationSec: null },
    });
    expect(JSON.stringify(data)).not.toContain("##");
  });

  test("titles conversations from the thread name, the other person, or the members", () => {
    expect(
      buildConversationExport(rows({ threadName: " Trip " }), i64ToText).conversation.title,
    ).toBe("Trip");
    expect(buildConversationExport(rows({ isGroup: false }), i64ToText).conversation.title).toBe(
      "Alex Example",
    );
    expect(
      buildConversationExport(rows({ participants: [], isGroup: false }), i64ToText).conversation
        .title,
    ).toBe("Conversation");
  });
});

describe("exportHistory", () => {
  test("is partial for gaps or older history, unknown without range data", () => {
    expect(exportHistory([], false)).toBe("unknown");
    expect(exportHistory([{}], false)).toBe("unknown");
    expect(exportHistory([{ hasMoreBefore: false }], false)).toBe("complete");
    expect(exportHistory([{ hasMoreBefore: true }], false)).toBe("partial");
    expect(exportHistory([{ hasMoreBefore: false }, { hasMoreBefore: false }], false)).toBe(
      "partial",
    );
    expect(exportHistory([{ hasMoreBefore: false }], true)).toBe("partial");
  });
});

function databaseHarness(messageRows: unknown[] = rows().messages) {
  type Q = { table: string; keys: unknown[]; limit?: number; descending: boolean };
  const calls: Q[] = [];
  const tables: Record<string, unknown> = {};
  for (const name of [
    "messages",
    "participants",
    "contacts",
    "reactions",
    "attachments",
    "messages_ranges_v2__generated",
  ]) {
    tables[name] = { name };
  }
  const data: Record<string, unknown[]> = {
    messages: messageRows,
    participants: rows().participants,
    contacts: [{ id: i64("3"), name: "Former Member" }],
    reactions: rows().reactions,
    attachments: rows().attachments,
    messages_ranges_v2__generated: [{ hasMoreBefore: false }],
  };
  const query = (q: Q) => ({
    getKeyRange: (...keys: unknown[]) => query({ ...q, keys }),
    take: (limit: number) => query({ ...q, limit }),
    q,
  });
  const modules: Record<string, unknown> = {
    LSDatabaseSingleton: {
      LSDatabaseSingleton: Promise.resolve({
        tables: {
          ...tables,
          threads: {
            get: async (key: unknown) =>
              i64ToText(key) === "100" ? { threadName: "", threadType: 2 } : undefined,
          },
        },
      }),
    },
    I64: { of_string: (value: string) => i64(value), to_string: i64ToText },
    LSMessagingThreadTypeUtil: { isGroup: (type: unknown) => type === 2 },
    MAWVault: { unvault },
    ReQL: {
      fromTableAscending: (table: { name: string }) =>
        query({ table: table.name, keys: [], descending: false }),
      fromTableDescending: (table: { name: string }) =>
        query({ table: table.name, keys: [], descending: true }),
      leftJoin: (left: { q: Q }) => query({ ...left.q, table: "participants+contacts" }),
      toArrayAsync: async ({ q }: { q: Q }) => {
        calls.push(q);
        if (q.table === "participants+contacts") return data.participants;
        const all = data[q.table] ?? [];
        return q.limit === undefined ? all : all.slice(0, q.limit);
      },
    },
  };
  return { calls, data, modules, load: (name: string) => modules[name] };
}

const options = { viewerId: "1", utcOffsetMinutes: () => 0 };

describe("readConversationExport", () => {
  test("reads only the requested conversation's local rows", async () => {
    const h = databaseHarness();
    const data = await readConversationExport("100", h.load, options);
    expect(data?.messages).toHaveLength(4);
    expect(data?.conversation.isGroup).toBe(true);
    expect(data?.history).toBe("complete");
    expect(h.calls.find((call) => call.table === "messages")).toEqual({
      table: "messages",
      keys: [i64("100")],
      limit: EXPORT_MESSAGE_LIMIT + 1,
      descending: true,
    });
    // Only the one non-participant sender is looked up individually.
    expect(h.calls.filter((call) => call.table === "contacts")).toEqual([
      { table: "contacts", keys: [i64("3")], limit: 1, descending: false },
    ]);
  });

  test("decrypts with Messenger's vault, and marks text when the vault is missing", async () => {
    const encrypted = [{ messageId: "mid.1", timestampMs: String(T0), text: vaulted("Hei!") }];
    const h = databaseHarness(encrypted);
    expect((await readConversationExport("100", h.load, options))?.messages[0]?.text).toBe("Hei!");
    h.modules.MAWVault = undefined;
    expect((await readConversationExport("100", h.load, options))?.messages[0]).toMatchObject({
      text: null,
      unreadable: true,
    });
  });

  test("keeps the newest messages when the conversation is over the cap", async () => {
    const many = Array.from({ length: EXPORT_MESSAGE_LIMIT + 1 }, (_, index) => ({
      messageId: `mid.${index}`,
      timestampMs: String(T0 - index),
    }));
    const data = await readConversationExport("100", databaseHarness(many).load, options);
    expect(data?.messages).toHaveLength(EXPORT_MESSAGE_LIMIT);
    expect(data?.messages.at(-1)?.id).toBe("mid.0");
    expect(data?.truncated).toBe(true);
    expect(data?.history).toBe("partial");
  });

  test("reports optional tables it could not read", async () => {
    const h = databaseHarness();
    const reql = h.load("ReQL") as { toArrayAsync: (query: { q: { table: string } }) => unknown };
    const original = reql.toArrayAsync;
    reql.toArrayAsync = (query) =>
      query.q.table === "reactions" ? Promise.reject(new Error("gone")) : original(query);
    const data = await readConversationExport("100", h.load, options);
    expect(data?.messages[0]?.reactions).toEqual([]);
    expect(data?.missing).toEqual(["reactions"]);
  });

  test("returns null for unknown threads, missing APIs and timeouts", async () => {
    expect(await readConversationExport("999", databaseHarness().load, options)).toBeNull();
    expect(
      await readConversationExport("not-a-thread", databaseHarness().load, options),
    ).toBeNull();
    expect(await readConversationExport("100", undefined, options)).toBeNull();
    expect(
      await readConversationExport(
        "100",
        () => {
          throw new Error("module unavailable");
        },
        options,
      ),
    ).toBeNull();
    const pending = (name: string) =>
      name === "LSDatabaseSingleton" ? { LSDatabaseSingleton: new Promise(() => {}) } : {};
    expect(await readConversationExport("100", pending, { ...options, timeoutMs: 1 })).toBeNull();
  });
});
