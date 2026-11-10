/*
 * Unread and mute state straight from Messenger's local database (Ref #352).
 * The chat list's bold text and mute icons are a rendering of the same facts;
 * reading the source is exact in every language and theme. Messenger's own
 * "Unread message:" label uses MWPIsThreadUnread, and its top-bar badge leaves
 * out chats whose muteExpireTimeMs is -1 (forever) or still in the future.
 * Idea from fMess (github.com/toanbku/fmess, MIT).
 */

import { readMessengerDatabase } from "./messenger-db";

export interface ThreadState {
  unread: boolean;
  muted: boolean;
}

/** True/false for a readable mute expiry; null when the value is not understood. */
export function muteIsActive(
  raw: unknown,
  now: number,
  i64ToString?: (value: unknown) => unknown,
): boolean | null {
  let value: bigint;
  try {
    if (typeof raw === "bigint") value = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) value = BigInt(Math.trunc(raw));
    else if (typeof raw === "string" && /^-?\d+$/.test(raw)) value = BigInt(raw);
    else if (raw != null && i64ToString) {
      const text = i64ToString(raw);
      if (typeof text !== "string" || !/^-?\d+$/.test(text)) return null;
      value = BigInt(text);
    } else return null;
  } catch {
    return null;
  }
  return value === -1n || value > BigInt(Math.floor(now));
}

/**
 * Reads the given chats' state. Chats missing from the database, or whose
 * fields are not understood, are left out so the caller keeps its own
 * evidence for them. Null when the database or its APIs are unavailable.
 * Never writes to Messenger.
 */
export function readThreadStates(
  ids: readonly string[],
  load: unknown,
  now: number,
  timeoutMs = 750,
): Promise<Map<string, ThreadState> | null> {
  return readMessengerDatabase(
    load,
    async ({ db, i64, load }) => {
      const { isThreadUnreadForViewer } = load("MWPIsThreadUnread") as {
        isThreadUnreadForViewer?: (thread: unknown) => unknown;
      };
      if (typeof isThreadUnreadForViewer !== "function") {
        throw new Error("Messenger thread APIs changed");
      }
      const states = new Map<string, ThreadState>();
      for (const id of ids) {
        if (!/^\d+$/.test(id)) continue;
        const thread = await db.tables.threads.get(i64.of_string(id));
        if (!thread || typeof thread !== "object") continue;
        const unread = isThreadUnreadForViewer(thread);
        const muted = muteIsActive(
          (thread as { muteExpireTimeMs?: unknown }).muteExpireTimeMs,
          now,
          i64.to_string?.bind(i64),
        );
        if (typeof unread !== "boolean" || muted === null) continue;
        states.set(id, { unread, muted });
      }
      return states;
    },
    timeoutMs,
  );
}

interface NewestMessageQueries {
  fromTableDescending(table: unknown): {
    getKeyRange(...key: unknown[]): { take(limit: number): unknown };
  };
  toArrayAsync(query: unknown): Promise<unknown>;
}

/**
 * The id of the conversation's newest message in Messenger's database, or
 * null when it can't be read. Never writes to Messenger.
 */
export async function readNewestMessageId(
  id: string,
  load: unknown,
  timeoutMs = 750,
): Promise<string | null> {
  if (!/^\d+$/.test(id)) return null;
  const newest = await readMessengerDatabase(
    load,
    async ({ db, i64, load }) => {
      const q = load("ReQL") as NewestMessageQueries;
      const messages = (db.tables as Record<string, unknown>).messages;
      const rows = await q.toArrayAsync(
        q.fromTableDescending(messages).getKeyRange(i64.of_string(id)).take(1),
      );
      const messageId = Array.isArray(rows)
        ? (rows[0] as { messageId?: unknown } | undefined)?.messageId
        : undefined;
      return typeof messageId === "string" && messageId ? messageId : null;
    },
    timeoutMs,
  );
  return newest ?? null;
}
