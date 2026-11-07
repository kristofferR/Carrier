/*
 * Export the open conversation to HTML or JSON (Ref #371). The rows come from
 * Messenger's local database, the same tables its own conversation view
 * renders from, so encrypted chats export too. Nothing leaves the machine:
 * the page renders the file and the native shell saves it where the user
 * chooses.
 */

export const EXPORT_FORMAT = "carrier-conversation-export";
export const EXPORT_VERSION = 1;

/** Newest messages kept when a conversation has more than this stored locally. */
export const EXPORT_MESSAGE_LIMIT = 50_000;
const PARTICIPANT_LIMIT = 1_000;
const ROW_LIMIT = 200_000;
const UNKNOWN_SENDER_LIMIT = 200;

export type ExportFormat = "html" | "json";

/**
 * Whether the file holds the whole conversation: "complete" when Messenger
 * reports no older history, "partial" when it does (or the export was capped),
 * "unknown" when the database has no record either way.
 */
export type ExportHistory = "complete" | "partial" | "unknown";

export interface ExportPerson {
  id: string;
  name: string;
  nickname: string | null;
}

export interface ExportReaction {
  actorId: string | null;
  actorName: string | null;
  reaction: string;
  timestampMs: number | null;
}

export type ExportAttachmentKind = "image" | "video" | "audio" | "file" | "link" | "other";

export interface ExportAttachment {
  kind: ExportAttachmentKind;
  filename: string | null;
  title: string | null;
  mimeType: string | null;
}

export interface ExportReply {
  messageId: string;
  senderId: string | null;
  senderName: string | null;
  text: string | null;
}

export interface ExportMessage {
  id: string;
  senderId: string | null;
  senderName: string | null;
  timestamp: string;
  timestampMs: number;
  text: string | null;
  /** Messenger's own notices ("Alex named the group …"). */
  system: boolean;
  unsent: boolean;
  forwarded: boolean;
  edited: boolean;
  sticker: boolean;
  replyTo: ExportReply | null;
  reactions: ExportReaction[];
  attachments: ExportAttachment[];
}

export interface ConversationExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  conversation: {
    id: string;
    title: string;
    isGroup: boolean;
    participants: ExportPerson[];
  };
  history: ExportHistory;
  /** Plain-language notes on what the file leaves out. */
  notes: string[];
  messages: ExportMessage[];
}

type Row = Record<string, unknown>;
type I64ToString = (value: unknown) => unknown;

/** A database 64-bit integer as decimal text, or null when it is not one. */
export function i64Text(value: unknown, i64ToText?: I64ToString): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value === "string") return /^-?\d+$/.test(value) ? value : null;
  if (value == null || !i64ToText) return null;
  try {
    const text = i64ToText(value);
    return typeof text === "string" && /^-?\d+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

const isRow = (value: unknown): value is Row => !!value && typeof value === "object";
const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

function attachmentKind(row: Row, mimeType: string | null): ExportAttachmentKind {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (row.hasXma === true) return "link";
  if (nonEmpty(row.filename)) return "file";
  return "other";
}

export interface ExportRows {
  threadId: string;
  threadName: string;
  isGroup: boolean;
  /** The signed-in account, used to title a one-to-one chat after the other person. */
  viewerId: string | null;
  /** `[participant, contact]` pairs from the participants ⋈ contacts join. */
  participants: unknown[];
  /** Contact rows for senders who are no longer participants. */
  contacts: unknown[];
  /** Message rows in any order. */
  messages: unknown[];
  reactions: unknown[];
  attachments: unknown[];
  /** Loaded-range rows, oldest first. */
  ranges: unknown[];
  /** True when the message read hit EXPORT_MESSAGE_LIMIT. */
  truncated: boolean;
  /** Tables that could not be read; named in the notes. */
  unreadable: string[];
  now: number;
}

/** Whether Messenger has more history than it stored locally. */
export function exportHistory(ranges: unknown[], truncated: boolean): ExportHistory {
  if (truncated) return "partial";
  const rows = ranges.filter(isRow);
  // More than one loaded range means there is a gap between them.
  if (rows.length > 1) return "partial";
  const oldest = rows[0];
  if (!oldest || typeof oldest.hasMoreBefore !== "boolean") return "unknown";
  return oldest.hasMoreBefore ? "partial" : "complete";
}

function exportNotes(history: ExportHistory, truncated: boolean, unreadable: string[]): string[] {
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `Only the newest ${EXPORT_MESSAGE_LIMIT.toLocaleString("en-US")} messages are included.`,
    );
  } else if (history === "partial") {
    notes.push(
      "Older messages are not included because Messenger has not loaded them on this device. Scroll up in the conversation to load more, then export again.",
    );
  } else if (history === "unknown") {
    notes.push(
      "Includes the messages Messenger has stored on this device. Older messages may be missing; scroll up in the conversation to load more, then export again.",
    );
  }
  notes.push(
    "Photos, videos, and files are not included. Attachments are listed by type and name.",
  );
  for (const table of unreadable) notes.push(`${table} could not be read and are not included.`);
  return notes;
}

/** Map raw database rows to the export model. Never throws on unexpected rows: it skips them. */
export function buildConversationExport(
  rows: ExportRows,
  i64ToText?: I64ToString,
): ConversationExport {
  const id = (value: unknown) => i64Text(value, i64ToText);
  const people = new Map<string, ExportPerson>();
  const participants: ExportPerson[] = [];
  for (const pair of rows.participants) {
    if (!Array.isArray(pair)) continue;
    const [participant, contact] = pair as unknown[];
    if (!isRow(participant)) continue;
    const personId = id(participant.contactId) ?? (isRow(contact) ? id(contact.id) : null);
    const name = isRow(contact) ? nonEmpty(contact.name) : null;
    if (!personId || people.has(personId)) continue;
    const person = { id: personId, name: name ?? "", nickname: nonEmpty(participant.nickname) };
    people.set(personId, person);
    participants.push(person);
  }
  for (const contact of rows.contacts) {
    if (!isRow(contact)) continue;
    const personId = id(contact.id);
    const name = nonEmpty(contact.name);
    if (personId && name && !people.has(personId)) {
      people.set(personId, { id: personId, name, nickname: null });
    }
  }
  const nameOf = (personId: string | null) => (personId && people.get(personId)?.name) || null;

  const reactionsByMessage = new Map<string, ExportReaction[]>();
  for (const row of rows.reactions) {
    if (!isRow(row) || typeof row.messageId !== "string") continue;
    const reaction = nonEmpty(row.reaction);
    if (!reaction) continue;
    const actorId = id(row.actorId);
    const timestamp = id(row.timestampMs);
    const list = reactionsByMessage.get(row.messageId) ?? [];
    list.push({
      actorId,
      actorName: nameOf(actorId),
      reaction,
      timestampMs: timestamp === null ? null : Number(timestamp),
    });
    reactionsByMessage.set(row.messageId, list);
  }
  for (const list of reactionsByMessage.values()) {
    list.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  }

  const attachmentsByMessage = new Map<string, { index: number; value: ExportAttachment }[]>();
  for (const row of rows.attachments) {
    if (!isRow(row) || typeof row.messageId !== "string") continue;
    const mimeType = nonEmpty(row.playableUrlMimeType) ?? nonEmpty(row.previewUrlMimeType);
    const list = attachmentsByMessage.get(row.messageId) ?? [];
    list.push({
      index: Number(id(row.attachmentIndex) ?? list.length),
      value: {
        kind: attachmentKind(row, mimeType),
        filename: nonEmpty(row.filename),
        title: nonEmpty(row.titleText),
        mimeType,
      },
    });
    attachmentsByMessage.set(row.messageId, list);
  }

  const messages: ExportMessage[] = [];
  const seen = new Set<string>();
  for (const row of rows.messages) {
    if (!isRow(row) || typeof row.messageId !== "string" || !row.messageId) continue;
    if (seen.has(row.messageId)) continue;
    const timestamp = id(row.timestampMs);
    const timestampMs = timestamp === null ? Number.NaN : Number(timestamp);
    if (!Number.isFinite(timestampMs)) continue;
    seen.add(row.messageId);
    const senderId = id(row.senderId);
    const unsent = row.isUnsent === true;
    const replySource = nonEmpty(row.replySourceId);
    const replySenderId = id(row.replyToUserId);
    const sticker = id(row.stickerId);
    messages.push({
      id: row.messageId,
      senderId,
      senderName: nameOf(senderId),
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      text: unsent ? null : nonEmpty(row.text),
      system: row.isAdminMessage === true,
      unsent,
      forwarded: row.isForwarded === true,
      edited: Number(id(row.editCount) ?? 0) > 0,
      sticker: sticker !== null && sticker !== "0",
      replyTo: replySource
        ? {
            messageId: replySource,
            senderId: replySenderId,
            senderName: nameOf(replySenderId),
            text: nonEmpty(row.replyMessageText) ?? nonEmpty(row.replySnippet),
          }
        : null,
      reactions: reactionsByMessage.get(row.messageId) ?? [],
      attachments: (attachmentsByMessage.get(row.messageId) ?? [])
        .sort((a, b) => a.index - b.index)
        .map(({ value }) => value),
    });
  }
  messages.sort(
    (a, b) => a.timestampMs - b.timestampMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const history = exportHistory(rows.ranges, rows.truncated);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(rows.now).toISOString(),
    conversation: {
      id: rows.threadId,
      title: conversationTitle(rows, participants),
      isGroup: rows.isGroup,
      participants,
    },
    history,
    notes: exportNotes(history, rows.truncated, rows.unreadable),
    messages,
  };
}

function conversationTitle(rows: ExportRows, participants: ExportPerson[]): string {
  const named = nonEmpty(rows.threadName);
  if (named) return named.trim();
  const others = participants.filter((person) => person.id !== rows.viewerId && person.name);
  if (!rows.isGroup && others[0]) return others[0].name;
  if (others.length) return others.map((person) => person.name).join(", ");
  return "Conversation";
}

/* ------------------------------ Rendering ------------------------------ */

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

/** Versioned JSON for archiving; `JSON.parse` returns the export model unchanged. */
export function renderConversationJson(data: ConversationExport): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

const ATTACHMENT_LABELS: Record<ExportAttachmentKind, string> = {
  image: "Photo",
  video: "Video",
  audio: "Audio",
  file: "File",
  link: "Link",
  other: "Attachment",
};

function attachmentLabel(attachment: ExportAttachment): string {
  const label = ATTACHMENT_LABELS[attachment.kind];
  const detail = attachment.filename ?? attachment.title;
  return detail ? `${label}: ${detail}` : label;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1e21;--muted:#65676b;--line:#e4e6eb;--quote:#f0f2f5}
@media (prefers-color-scheme:dark){:root{--bg:#18191a;--fg:#e4e6eb;--muted:#b0b3b8;--line:#3a3b3c;--quote:#242526}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main{max-width:760px;margin:0 auto;padding:16px 20px}
header{border-bottom:1px solid var(--line)}
h1{margin:0 0 4px;font-size:22px}
.meta{margin:2px 0;color:var(--muted);font-size:13px}
.notes{margin:10px 0 0;padding-left:18px;color:var(--muted);font-size:13px}
.day{margin:24px 0 8px;font-size:13px;font-weight:600;color:var(--muted);text-align:center}
.msg{padding:6px 0}
.head{display:flex;gap:8px;align-items:baseline}
.sender{font-weight:600}
time,.flags{color:var(--muted);font-size:12px}
.text{margin:2px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.system{margin:8px 0;color:var(--muted);font-size:13px;text-align:center;white-space:pre-wrap}
.reply{margin:4px 0;padding:4px 10px;border-left:3px solid var(--line);background:var(--quote);border-radius:4px;font-size:13px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.reply a{color:inherit}
.attachments{margin:2px 0;padding-left:18px;color:var(--muted);font-size:13px}
.reactions{margin:2px 0;font-size:13px;color:var(--muted)}
`;

export interface HtmlOptions {
  locale?: string;
  timeZone?: string;
}

/**
 * Self-contained HTML for reading: inline styles only, no scripts, and a CSP
 * that forbids every network load, so the file opens offline and stays
 * offline. Every value from Messenger is escaped.
 */
export function renderConversationHtml(
  data: ConversationExport,
  options: HtmlOptions = {},
): string {
  const day = new Intl.DateTimeFormat(options.locale, {
    dateStyle: "full",
    timeZone: options.timeZone,
  });
  const time = new Intl.DateTimeFormat(options.locale, {
    timeStyle: "short",
    timeZone: options.timeZone,
  });
  const stamp = new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: options.timeZone,
  });
  const anchors = new Map(data.messages.map((message, index) => [message.id, `m${index + 1}`]));
  const title = escapeHtml(data.conversation.title);
  const count = data.messages.length;
  const people = data.conversation.participants
    .map((person) => person.name || person.nickname)
    .filter((name): name is string => !!name);

  const out: string[] = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Carrier">',
    `<title>${title}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<header>",
    `<h1>${title}</h1>`,
    `<p class="meta">${count.toLocaleString("en-US")} ${count === 1 ? "message" : "messages"}, exported ${escapeHtml(stamp.format(new Date(data.exportedAt)))}</p>`,
  ];
  if (people.length) {
    out.push(`<p class="meta">Participants: ${escapeHtml(people.join(", "))}</p>`);
  }
  if (data.notes.length) {
    out.push(
      `<ul class="notes">${data.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`,
    );
  }
  out.push("</header>", "<main>");

  let lastDay = "";
  for (const [index, message] of data.messages.entries()) {
    const date = new Date(message.timestampMs);
    const dayLabel = day.format(date);
    if (dayLabel !== lastDay) {
      out.push(`<h2 class="day">${escapeHtml(dayLabel)}</h2>`);
      lastDay = dayLabel;
    }
    const anchor = `m${index + 1}`;
    const when = `<time datetime="${escapeHtml(message.timestamp)}">${escapeHtml(time.format(date))}</time>`;
    if (message.system) {
      const text = message.text ?? "Conversation update";
      out.push(`<p class="system" id="${anchor}">${escapeHtml(text)} · ${when}</p>`);
      continue;
    }
    const parts: string[] = [`<article class="msg" id="${anchor}">`];
    const flags = [message.forwarded && "Forwarded", message.edited && "Edited"].filter(Boolean);
    parts.push(
      `<div class="head"><span class="sender">${escapeHtml(message.senderName ?? "Unknown sender")}</span>${when}${flags.length ? `<span class="flags">${flags.join(" · ")}</span>` : ""}</div>`,
    );
    if (message.replyTo) {
      const who = message.replyTo.senderName ?? "a message";
      const target = anchors.get(message.replyTo.messageId);
      const label = `Replying to ${escapeHtml(who)}`;
      const quoted = message.replyTo.text ? `: ${escapeHtml(message.replyTo.text)}` : "";
      parts.push(
        `<blockquote class="reply">${target ? `<a href="#${target}">${label}</a>` : label}${quoted}</blockquote>`,
      );
    }
    if (message.unsent) parts.push('<p class="text flags">Message unsent</p>');
    else if (message.text) parts.push(`<p class="text">${escapeHtml(message.text)}</p>`);
    else if (message.sticker) parts.push('<p class="text flags">Sticker</p>');
    if (message.attachments.length) {
      parts.push(
        `<ul class="attachments">${message.attachments
          .map((attachment) => `<li>${escapeHtml(attachmentLabel(attachment))}</li>`)
          .join("")}</ul>`,
      );
    }
    if (message.reactions.length) {
      parts.push(
        `<p class="reactions">${message.reactions
          .map((reaction) =>
            escapeHtml(
              reaction.actorName ? `${reaction.reaction} ${reaction.actorName}` : reaction.reaction,
            ),
          )
          .join(" · ")}</p>`,
      );
    }
    parts.push("</article>");
    out.push(parts.join(""));
  }
  if (!count) out.push('<p class="system">No messages are stored on this device yet.</p>');
  out.push("</main>", "</body>", "</html>", "");
  return out.join("\n");
}

/** A file name stem from the conversation title; the native side adds the extension. */
export function exportFileName(title: string): string {
  const cleaned = title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from file names
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return Array.from(cleaned).slice(0, 80).join("").trim() || "Conversation";
}

/* --------------------------- Database reading -------------------------- */

interface Query {
  getKeyRange(...keys: unknown[]): Query;
  take(limit: number): Query;
}
interface MessengerQueries {
  fromTableAscending(table: unknown): Query;
  fromTableDescending(table: unknown): Query;
  leftJoin(left: Query, right: Query): Query;
  toArrayAsync(query: Query): Promise<unknown>;
}
interface MessengerDatabase {
  tables: Record<string, unknown> & {
    threads: { get(key: unknown): Promise<unknown> };
  };
}

/**
 * Read one conversation's locally stored history. Null when Messenger's
 * database or the conversation is unavailable. Only Messenger's read APIs are
 * used; nothing is written and no history is fetched from Facebook.
 */
export async function readConversationExport(
  threadId: string,
  importModule: unknown,
  options: { now: number; viewerId: string | null; timeoutMs?: number },
): Promise<ConversationExport | null> {
  if (!/^\d+$/.test(threadId) || typeof importModule !== "function") return null;
  const load = importModule as (name: string) => unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<ConversationExport | null> => {
    const singleton = load("LSDatabaseSingleton") as {
      LSDatabaseSingleton: Promise<MessengerDatabase>;
    };
    const db = await singleton.LSDatabaseSingleton;
    const i64 = load("I64") as {
      of_string(value: string): unknown;
      to_string?: I64ToString;
    };
    const q = load("ReQL") as MessengerQueries;
    const i64ToText = i64.to_string?.bind(i64);
    const key = i64.of_string(threadId);
    const thread = await db.tables.threads.get(key);
    if (!isRow(thread)) return null;
    let isGroup = false;
    try {
      const types = load("LSMessagingThreadTypeUtil") as { isGroup(type: unknown): boolean };
      isGroup = types.isGroup(thread.threadType) === true;
    } catch (_) {}

    const rows = async (query: Query) => {
      const result = await q.toArrayAsync(query);
      if (!Array.isArray(result)) throw new Error("unexpected query result");
      return result as unknown[];
    };
    const unreadable: string[] = [];
    const optional = async (label: string, query: () => Query) => {
      try {
        return await rows(query());
      } catch (_) {
        unreadable.push(label);
        return [];
      }
    };

    // Newest first so a capped read keeps the latest messages.
    const messages = await rows(
      q
        .fromTableDescending(db.tables.messages)
        .getKeyRange(key)
        .take(EXPORT_MESSAGE_LIMIT + 1),
    );
    const truncated = messages.length > EXPORT_MESSAGE_LIMIT;
    if (truncated) messages.length = EXPORT_MESSAGE_LIMIT;
    const participants = await optional("Participant names", () =>
      q
        .leftJoin(
          q.fromTableAscending(db.tables.participants).getKeyRange(key),
          q.fromTableAscending(db.tables.contacts),
        )
        .take(PARTICIPANT_LIMIT),
    );
    const reactions = await optional("Reactions", () =>
      q.fromTableAscending(db.tables.reactions).getKeyRange(key).take(ROW_LIMIT),
    );
    const attachments = await optional("Attachment details", () =>
      q.fromTableAscending(db.tables.attachments).getKeyRange(key).take(ROW_LIMIT),
    );
    let ranges: unknown[] = [];
    try {
      ranges = await rows(
        q.fromTableAscending(db.tables.messages_ranges_v2__generated).getKeyRange(key),
      );
    } catch (_) {}

    // People who left a group still sent messages; look up their names.
    const known = new Set<string>();
    for (const pair of participants) {
      if (Array.isArray(pair) && isRow(pair[0])) {
        const personId = i64Text(pair[0].contactId, i64ToText);
        if (personId) known.add(personId);
      }
    }
    const missing = new Set<string>();
    for (const row of [...messages, ...reactions]) {
      if (!isRow(row)) continue;
      for (const value of [row.senderId, row.actorId, row.replyToUserId]) {
        const personId = i64Text(value, i64ToText);
        if (personId && !known.has(personId)) missing.add(personId);
      }
    }
    const contacts: unknown[] = [];
    for (const personId of [...missing].slice(0, UNKNOWN_SENDER_LIMIT)) {
      try {
        contacts.push(
          ...(await rows(
            q.fromTableAscending(db.tables.contacts).getKeyRange(i64.of_string(personId)).take(1),
          )),
        );
      } catch (_) {}
    }

    return buildConversationExport(
      {
        threadId,
        threadName: typeof thread.threadName === "string" ? thread.threadName : "",
        isGroup,
        viewerId: options.viewerId,
        participants,
        contacts,
        messages,
        reactions,
        attachments,
        ranges,
        truncated,
        unreadable,
        now: options.now,
      },
      i64ToText,
    );
  };
  try {
    return await Promise.race([
      read().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), options.timeoutMs ?? 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
