/*
 * The most recent conversations, read from Messenger's local database for the
 * Dock, tray and jump-list menus (Ref #362). Unlike the rendered chat list,
 * the database is complete regardless of scrolling, filters or rendering.
 * Query shape from fMess (github.com/toanbku/fmess, MIT).
 */
import { readMessengerDatabase } from "./messenger-db";
import { type NicknameMode, showNicknames } from "./nicknames";
import {
  type ConversationNotificationNames,
  participantFirstName,
  readConversationNotificationNames,
} from "./notification-names";

export interface RecentThread {
  name: string;
  href: string;
}

interface Query {
  take(limit: number): Query;
}
interface ReQL {
  fromTableDescending(table: unknown): Query;
  toArrayAsync(query: Query): Promise<unknown>;
}
interface ThreadTypes {
  isMessengerOrE2EEInbox(folderName: unknown): unknown;
  isArmadilloSecure(threadType: unknown): unknown;
  isGroup(threadType: unknown): unknown;
}

const MAX_NAME_CHARS = 60;

/** The menu title Messenger's chat list would show, or "" when unknown. */
export function conversationTitle(
  names: ConversationNotificationNames,
  viewer: string,
  mode: NicknameMode,
): string {
  const nicknames = showNicknames(mode, names.isGroup);
  const others = names.participants.filter((person) => person.id !== viewer);
  if (!names.isGroup) {
    const [person, extra] = others;
    return person && !extra ? (nicknames && person.nickname) || person.name : "";
  }
  if (names.title.trim()) return names.title;
  return others
    .map((person) => (nicknames && person.nickname) || participantFirstName(person))
    .filter(Boolean)
    .join(", ");
}

/**
 * Inbox conversations by last activity, newest first. Archived chats, message
 * requests and spam live outside the inbox folders and are skipped. A
 * conversation whose name the database cannot give takes `fallbackName`, or is
 * left out. Null when the database or its APIs are unavailable.
 */
export function readRecentThreads(
  load: unknown,
  options: {
    viewer: string;
    mode: NicknameMode;
    limit: number;
    fallbackName?: (id: string) => string;
  },
  timeoutMs = 2000,
): Promise<RecentThread[] | null> {
  const { viewer, mode, limit, fallbackName } = options;
  return readMessengerDatabase(
    load,
    async ({ db, i64, load }) => {
      const q = load("ReQL") as ReQL;
      const types = load("LSMessagingThreadTypeUtil") as ThreadTypes;
      if (
        typeof q?.toArrayAsync !== "function" ||
        typeof types?.isMessengerOrE2EEInbox !== "function" ||
        typeof types.isArmadilloSecure !== "function" ||
        typeof types.isGroup !== "function" ||
        typeof i64.to_string !== "function"
      ) {
        throw new Error("Messenger thread APIs changed");
      }
      // Over-read: some of the newest rows are hidden, archived or requests.
      const rows = await q.toArrayAsync(
        q.fromTableDescending(db.tables.threads.index("lastActivityTimestampMs")).take(limit * 4),
      );
      if (!Array.isArray(rows)) throw new Error("Messenger thread APIs changed");
      const out: RecentThread[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (out.length >= limit) break;
        if (!row || typeof row !== "object") continue;
        const thread = row as Record<string, unknown>;
        if (types.isMessengerOrE2EEInbox(thread.folderName) !== true) continue;
        // Encrypted chats' rows are all marked hidden (the chat list shows them
        // through other tables), so isHidden only rules out plain ones.
        if (thread.isHidden === true && types.isArmadilloSecure(thread.threadType) !== true)
          continue;
        const id = i64.to_string(thread.threadKey);
        if (typeof id !== "string" || !/^\d+$/.test(id) || seen.has(id)) continue;
        let name =
          types.isGroup(thread.threadType) === true && typeof thread.threadName === "string"
            ? thread.threadName.trim()
            : "";
        if (!name) {
          const names = await readConversationNotificationNames(id, load);
          name = names ? conversationTitle(names, viewer, mode).trim() : "";
        }
        name ||= fallbackName?.(id) ?? "";
        if (!name) continue;
        seen.add(id);
        out.push({ name: name.slice(0, MAX_NAME_CHARS), href: `/t/${id}/` });
      }
      return out;
    },
    timeoutMs,
  );
}
