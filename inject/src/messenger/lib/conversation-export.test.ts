import { describe, expect, test } from "bun:test";
import {
  buildConversationExport,
  type ConversationExport,
  EXPORT_MESSAGE_LIMIT,
  type ExportRows,
  escapeHtml,
  exportFileName,
  exportHistory,
  i64Text,
  readConversationExport,
  renderConversationHtml,
  renderConversationJson,
} from "./conversation-export";

// Messenger's I64 values are opaque objects; model them as tagged boxes.
const i64 = (value: string) => ({ i64: value });
const i64ToText = (value: unknown) => (value as { i64?: string }).i64;

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
        text: 'Sounds <good> & "fine"',
        replySourceId: "mid.1",
        replyToUserId: i64("2"),
        replyMessageText: "Lunch?",
        editCount: i64("1"),
      },
      {
        messageId: "mid.1",
        timestampMs: i64(String(T0)),
        senderId: i64("2"),
        text: "Lunch?",
      },
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
    unreadable: [],
    now: T0 + 3_600_000,
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

describe("buildConversationExport", () => {
  test("maps rows to chronological messages with senders, replies, reactions and attachments", () => {
    const data = buildConversationExport(rows(), i64ToText);
    expect(data.format).toBe("carrier-conversation-export");
    expect(data.version).toBe(1);
    expect(data.exportedAt).toBe(new Date(T0 + 3_600_000).toISOString());
    expect(data.conversation).toEqual({
      id: "100",
      title: "Alex Example",
      isGroup: true,
      participants: [
        { id: "1", name: "Kris Viewer", nickname: null },
        { id: "2", name: "Alex Example", nickname: "Captain" },
      ],
    });
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
      timestamp: new Date(T0).toISOString(),
      timestampMs: T0,
      text: "Lunch?",
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

  test("says what the file leaves out", () => {
    const partial = buildConversationExport(rows(), i64ToText);
    expect(partial.history).toBe("partial");
    expect(partial.notes[0]).toContain("Older messages are not included");
    expect(partial.notes.at(-1)).toContain("Photos, videos, and files are not included");

    const complete = buildConversationExport(
      rows({ ranges: [{ hasMoreBefore: false }] }),
      i64ToText,
    );
    expect(complete.history).toBe("complete");
    expect(complete.notes).toHaveLength(1);

    const capped = buildConversationExport(
      rows({ truncated: true, unreadable: ["Reactions"] }),
      i64ToText,
    );
    expect(capped.history).toBe("partial");
    expect(capped.notes[0]).toContain("newest 50,000");
    expect(capped.notes).toContain("Reactions could not be read and are not included.");
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

describe("renderConversationJson", () => {
  test("round-trips the versioned model", () => {
    const data = buildConversationExport(rows(), i64ToText);
    const parsed = JSON.parse(renderConversationJson(data)) as ConversationExport;
    expect(parsed).toEqual(data);
    expect(Object.keys(parsed)).toEqual([
      "format",
      "version",
      "exportedAt",
      "conversation",
      "history",
      "notes",
      "messages",
    ]);
  });
});

describe("renderConversationHtml", () => {
  const html = (data: ConversationExport) =>
    renderConversationHtml(data, { locale: "en-US", timeZone: "UTC" });

  test("is self-contained and blocks every network load", () => {
    const out = html(buildConversationExport(rows(), i64ToText));
    expect(out).toStartWith("<!doctype html>");
    expect(out).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    expect(out).not.toMatch(/<script|<link|<img|src=|https?:\/\//i);
  });

  test("escapes every value from Messenger", () => {
    const data = buildConversationExport(
      rows({
        threadName: "<script>alert(1)</script>",
        participants: [
          [{ contactId: i64("2") }, { id: i64("2"), name: `<img src=x onerror="a">` }],
        ],
        contacts: [],
        messages: [
          {
            messageId: "mid.1",
            timestampMs: i64(String(T0)),
            senderId: i64("2"),
            text: "</p><iframe src='https://evil.example'>",
            replySourceId: "mid.0",
            replyMessageText: "<b>bold</b>",
          },
        ],
        reactions: [{ messageId: "mid.1", actorId: i64("2"), reaction: "<3" }],
        attachments: [{ messageId: "mid.1", filename: '"><svg onload=x>' }],
      }),
      i64ToText,
    );
    const out = html(data);
    for (const raw of ["<script>alert", "<img src=x", "<iframe", "<b>bold", "<svg", "<3 "]) {
      expect(out).not.toContain(raw);
    }
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;/p&gt;&lt;iframe src=&#39;https://evil.example&#39;&gt;");
    expect(out).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(out).toContain("File: &quot;&gt;&lt;svg onload=x&gt;");
  });

  test("renders days, times, replies, reactions and attachments", () => {
    const out = html(buildConversationExport(rows(), i64ToText));
    expect(out).toContain('<h2 class="day">Saturday, November 7, 2026</h2>');
    expect(out).toContain('<time datetime="2026-11-07T09:30:00.000Z">9:30 AM</time>');
    expect(out).toContain('<a href="#m1">Replying to Alex Example</a>: Lunch?');
    expect(out).toContain("❤ Kris Viewer · 😂 Former Member");
    expect(out).toContain("<li>Photo</li><li>File: notes.pdf</li>");
    expect(out).toContain("Message unsent");
    expect(out).toContain("Edited");
    expect(out).toContain("Participants: Kris Viewer, Alex Example");
    expect(out).toContain("4 messages, exported");
  });

  test("escapeHtml covers the five significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("exportFileName", () => {
  test("makes a plain file name stem from the title", () => {
    expect(exportFileName("Weekend: plans/ideas?")).toBe("Weekend plans ideas");
    expect(exportFileName("  ..hidden..  ")).toBe("hidden");
    expect(exportFileName("\u0000\n")).toBe("Conversation");
    expect(exportFileName("x".repeat(200))).toHaveLength(80);
  });
});

function databaseHarness(messageRows: unknown[] = rows().messages) {
  const calls: { table: string; keys: unknown[]; limit?: number; descending: boolean }[] = [];
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
  type Q = { table: string; keys: unknown[]; limit?: number; descending: boolean };
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
  return { calls, data, load: (name: string) => modules[name] };
}

describe("readConversationExport", () => {
  test("reads only the requested conversation's local rows", async () => {
    const h = databaseHarness();
    const data = await readConversationExport("100", h.load, { now: T0, viewerId: "1" });
    expect(data?.messages).toHaveLength(4);
    expect(data?.conversation.isGroup).toBe(true);
    expect(data?.history).toBe("complete");
    const messages = h.calls.find((call) => call.table === "messages");
    expect(messages).toEqual({
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

  test("keeps the newest messages when the conversation is over the cap", async () => {
    const many = Array.from({ length: EXPORT_MESSAGE_LIMIT + 1 }, (_, index) => ({
      messageId: `mid.${index}`,
      timestampMs: String(T0 - index),
    }));
    const data = await readConversationExport("100", databaseHarness(many).load, {
      now: T0,
      viewerId: null,
    });
    expect(data?.messages).toHaveLength(EXPORT_MESSAGE_LIMIT);
    expect(data?.messages.at(-1)?.id).toBe("mid.0");
    expect(data?.history).toBe("partial");
  });

  test("notes optional tables it could not read", async () => {
    const h = databaseHarness();
    const reql = h.load("ReQL") as { toArrayAsync: (query: { q: { table: string } }) => unknown };
    const original = reql.toArrayAsync;
    reql.toArrayAsync = (query) =>
      query.q.table === "reactions" ? Promise.reject(new Error("gone")) : original(query);
    const data = await readConversationExport("100", h.load, { now: T0, viewerId: "1" });
    expect(data?.messages[0]?.reactions).toEqual([]);
    expect(data?.notes).toContain("Reactions could not be read and are not included.");
  });

  test("returns null for unknown threads, missing APIs and timeouts", async () => {
    const options = { now: T0, viewerId: null };
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
