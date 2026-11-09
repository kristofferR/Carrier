/*
 * Export the open conversation (Ref #371). The rows come from Messenger's
 * local database, the same tables its own conversation view renders from, so
 * encrypted chats export too. This side only reads and maps rows: the native
 * shell validates the result, renders the HTML or JSON file, and saves it
 * where the user chooses. Nothing leaves the machine.
 */
import { t, tn } from "../../i18n";

/** Newest messages kept when a conversation has more than this stored locally. */
export const EXPORT_MESSAGE_LIMIT = 50_000;
const PARTICIPANT_LIMIT = 1_000;
const ROW_LIMIT = 200_000;
const UNKNOWN_SENDER_LIMIT = 200;

export type ExportFormat = "html" | "json";

/**
 * Whether the export holds the whole conversation: "complete" when Messenger
 * reports no older history, "partial" when it does (or the export was capped),
 * "unknown" when the database has no record either way.
 */
export type ExportHistory = "complete" | "partial" | "unknown";

/** Optional tables that could not be read; the native side names them in the file. */
export type ExportMissingPart = "participants" | "reactions" | "attachments";

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

export interface ExportCall {
  type: "audio" | "video";
  /** Null when Messenger's record doesn't say (older call records). */
  outcome: "missed" | "ended" | "started" | null;
  durationSec: number | null;
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
  timestampMs: number;
  /** The local time zone's offset at this message, for the rendered dates. */
  utcOffsetMinutes: number;
  text: string | null;
  /** Messenger's own notices ("Alex named the group …"). */
  system: boolean;
  unsent: boolean;
  /** Encrypted text this device could not decrypt; `text` is null. */
  unreadable: boolean;
  forwarded: boolean;
  edited: boolean;
  sticker: boolean;
  call: ExportCall | null;
  replyTo: ExportReply | null;
  reactions: ExportReaction[];
  attachments: ExportAttachment[];
}

/** What the page hands the native side; it adds notes, dates, and the file format. */
export interface ConversationExport {
  conversation: {
    id: string;
    title: string;
    isGroup: boolean;
    participants: ExportPerson[];
  };
  history: ExportHistory;
  truncated: boolean;
  missing: ExportMissingPart[];
  messages: ExportMessage[];
}

type Row = Record<string, unknown>;
type I64ToString = (value: unknown) => unknown;
/** Messenger's MAWVault.unvault: decrypts at-rest encrypted text, else returns it unchanged. */
type Unvault = (value: string) => unknown;

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

/*
 * Encrypted chats keep text encrypted at rest: Messenger's vault wraps the
 * ciphertext in a "<10 digits>##<10 digits>" marker on both sides
 * (MAWVaultMaterials / MAWVault) and its views call MAWVault.unvault()
 * synchronously before display. Text still carrying the marker after unvault
 * could not be decrypted here and must never be exported as if it were text.
 */
const VAULT_MARKER = /\d{10}##\d{10}/;

export function isVaulted(value: string): boolean {
  return VAULT_MARKER.test(value);
}

/** Plain text, or `unreadable` when it is vaulted and this page cannot decrypt it. */
export function revealText(
  value: unknown,
  unvault?: Unvault,
): { text: string | null; unreadable: boolean } {
  if (typeof value !== "string" || value.trim() === "") return { text: null, unreadable: false };
  if (!isVaulted(value)) return { text: value, unreadable: false };
  let plain: unknown;
  try {
    plain = unvault?.(value);
  } catch {
    plain = undefined;
  }
  if (typeof plain !== "string" || isVaulted(plain)) return { text: null, unreadable: true };
  return { text: plain.trim() === "" ? null : plain, unreadable: false };
}

const isRow = (value: unknown): value is Row => !!value && typeof value === "object";

function attachmentKind(row: Row, mimeType: string | null, filename: string | null) {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (row.hasXma === true) return "link";
  if (filename) return "file";
  return "other";
}

/*
 * Call records are XMA attachments. Encrypted chats store an XMA 2.0
 * dataclass (JSON) whose template is XMSGXmaCallingTemplateData with
 * call_type AUDIO/VIDEO and call_state MISSED/ENDED/STARTED, the fields
 * MWXMAV2RTCCallTemplate renders. Other chats mark them with an
 * "xma_rtc_*" CTA type (MWXMAUtils.isRTCXMA).
 */
export function callFromAttachment(row: Row, unvault?: Unvault): ExportCall | null {
  const dataclass = revealText(row.xmaDataclass, unvault).text;
  if (dataclass) {
    try {
      const parsed: unknown = JSON.parse(dataclass);
      const content = isRow(parsed) ? parsed.content : null;
      const items = !isRow(content)
        ? []
        : content.__typename === "XMSGXmaSingleContent"
          ? [content]
          : Array.isArray(content.list)
            ? content.list
            : [];
      for (const item of items) {
        const data = isRow(item) ? item.custom_template_data : null;
        if (!isRow(data) || data.__typename !== "XMSGXmaCallingTemplateData") continue;
        const state = data.call_state;
        const duration = Number(data.call_duration_sec);
        return {
          type: data.call_type === "VIDEO" ? "video" : "audio",
          outcome:
            state === "MISSED"
              ? "missed"
              : state === "ENDED"
                ? "ended"
                : state === "STARTED"
                  ? "started"
                  : null,
          durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
        };
      }
    } catch (_) {}
  }
  for (const cta of [row.defaultCtaType, row.cta1Type]) {
    if (typeof cta !== "string" || !cta.startsWith("xma_rtc_")) continue;
    return {
      type: cta.includes("video") ? "video" : "audio",
      outcome: cta.includes("missed") ? "missed" : cta.includes("ended") ? "ended" : null,
      durationSec: null,
    };
  }
  return null;
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
  missing: ExportMissingPart[];
  /** The local time zone's offset at a moment, in minutes east of UTC. */
  utcOffsetMinutes: (timestampMs: number) => number;
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

/** Map raw database rows to the export model. Never throws on unexpected rows: it skips them. */
export function buildConversationExport(
  rows: ExportRows,
  i64ToText?: I64ToString,
  unvault?: Unvault,
): ConversationExport {
  const id = (value: unknown) => i64Text(value, i64ToText);
  const plain = (value: unknown) => revealText(value, unvault).text;
  const people = new Map<string, ExportPerson>();
  const participants: ExportPerson[] = [];
  for (const pair of rows.participants) {
    if (!Array.isArray(pair)) continue;
    const [participant, contact] = pair as unknown[];
    if (!isRow(participant)) continue;
    const personId = id(participant.contactId) ?? (isRow(contact) ? id(contact.id) : null);
    if (!personId || people.has(personId)) continue;
    const person = {
      id: personId,
      name: (isRow(contact) && plain(contact.name)) || "",
      nickname: plain(participant.nickname),
    };
    people.set(personId, person);
    participants.push(person);
  }
  for (const contact of rows.contacts) {
    if (!isRow(contact)) continue;
    const personId = id(contact.id);
    const name = plain(contact.name);
    if (personId && name && !people.has(personId)) {
      people.set(personId, { id: personId, name, nickname: null });
    }
  }
  const nameOf = (personId: string | null) => (personId && people.get(personId)?.name) || null;

  const reactionsByMessage = new Map<string, ExportReaction[]>();
  for (const row of rows.reactions) {
    if (!isRow(row) || typeof row.messageId !== "string") continue;
    const reaction = plain(row.reaction);
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
  const callsByMessage = new Map<string, ExportCall>();
  for (const row of rows.attachments) {
    if (!isRow(row) || typeof row.messageId !== "string") continue;
    const call = callFromAttachment(row, unvault);
    if (call) {
      callsByMessage.set(row.messageId, call);
      continue;
    }
    const mimeType = plain(row.playableUrlMimeType) ?? plain(row.previewUrlMimeType);
    const filename = plain(row.filename);
    const list = attachmentsByMessage.get(row.messageId) ?? [];
    list.push({
      index: Number(id(row.attachmentIndex) ?? list.length),
      value: {
        kind: attachmentKind(row, mimeType, filename),
        filename,
        title: plain(row.titleText),
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
    const body = unsent ? { text: null, unreadable: false } : revealText(row.text, unvault);
    const replySource = typeof row.replySourceId === "string" ? row.replySourceId : "";
    const replySenderId = id(row.replyToUserId);
    const sticker = id(row.stickerId);
    messages.push({
      id: row.messageId,
      senderId,
      senderName: nameOf(senderId),
      timestampMs,
      utcOffsetMinutes: rows.utcOffsetMinutes(timestampMs),
      text: body.text,
      system: row.isAdminMessage === true,
      unsent,
      unreadable: body.unreadable,
      forwarded: row.isForwarded === true,
      edited: Number(id(row.editCount) ?? 0) > 0,
      sticker: sticker !== null && sticker !== "0",
      call: callsByMessage.get(row.messageId) ?? null,
      replyTo: replySource
        ? {
            messageId: replySource,
            senderId: replySenderId,
            senderName: nameOf(replySenderId),
            text: plain(row.replyMessageText) ?? plain(row.replySnippet),
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

  return {
    conversation: {
      id: rows.threadId,
      title: conversationTitle(rows, plain(rows.threadName), participants),
      isGroup: rows.isGroup,
      participants,
    },
    history: exportHistory(rows.ranges, rows.truncated),
    truncated: rows.truncated,
    missing: rows.missing,
    messages,
  };
}

function conversationTitle(
  rows: ExportRows,
  threadName: string | null,
  participants: ExportPerson[],
): string {
  if (threadName?.trim()) return threadName.trim();
  const others = participants.filter((person) => person.id !== rows.viewerId && person.name);
  if (!rows.isGroup && others[0]) return others[0].name;
  if (others.length) return listedNames(others.map((person) => person.name));
  return t("page.export.untitled");
}

/** Bytes a title may use; the native side refuses names over 1,024. */
const TITLE_BYTES = 900;

/** "Ada, Alan, Grace" for an unnamed group, ending in "and N more" before
 * a long member list outgrows the title limit. */
export function listedNames(names: string[]): string {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  let title = "";
  for (const [index, name] of names.entries()) {
    const next = title ? `${title}, ${name}` : name;
    const more = names.length - index - 1;
    const shown = more ? tn("page.export.names_and_more", more, { names: next }) : next;
    if (bytes(shown) > TITLE_BYTES) {
      return title
        ? tn("page.export.names_and_more", names.length - index, { names: title })
        : tn("page.export.people", names.length);
    }
    title = next;
  }
  return title;
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
  options: {
    viewerId: string | null;
    utcOffsetMinutes: (timestampMs: number) => number;
    timeoutMs?: number;
  },
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
    let unvault: Unvault | undefined;
    try {
      const vault = load("MAWVault") as { unvault?: unknown };
      if (typeof vault?.unvault === "function") {
        const fn = vault.unvault as (value: string) => unknown;
        unvault = (value) => fn(value);
      }
    } catch (_) {}
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
    const missing: ExportMissingPart[] = [];
    const optional = async (part: ExportMissingPart, query: () => Query) => {
      try {
        return await rows(query());
      } catch (_) {
        missing.push(part);
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
    const participants = await optional("participants", () =>
      q
        .leftJoin(
          q.fromTableAscending(db.tables.participants).getKeyRange(key),
          q.fromTableAscending(db.tables.contacts),
        )
        .take(PARTICIPANT_LIMIT),
    );
    // Newest first, like messages, and one row past the cap to notice when
    // it is reached: a capped read is incomplete and the file says so.
    const capped = async (part: ExportMissingPart, table: unknown) => {
      const found = await optional(part, () =>
        q
          .fromTableDescending(table)
          .getKeyRange(key)
          .take(ROW_LIMIT + 1),
      );
      if (found.length > ROW_LIMIT) {
        found.length = ROW_LIMIT;
        if (!missing.includes(part)) missing.push(part);
      }
      return found;
    };
    const reactions = await capped("reactions", db.tables.reactions);
    const attachments = await capped("attachments", db.tables.attachments);
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
    const unknown = new Set<string>();
    for (const row of [...messages, ...reactions]) {
      if (!isRow(row)) continue;
      for (const value of [row.senderId, row.actorId, row.replyToUserId]) {
        const personId = i64Text(value, i64ToText);
        if (personId && !known.has(personId)) unknown.add(personId);
      }
    }
    const contacts: unknown[] = [];
    for (const personId of [...unknown].slice(0, UNKNOWN_SENDER_LIMIT)) {
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
        missing,
        utcOffsetMinutes: options.utcOffsetMinutes,
      },
      i64ToText,
      unvault,
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
