/*
 * Unread and mute state straight from Messenger's local database (Ref #352).
 * The chat list's bold text and mute icons are a rendering of the same facts;
 * reading the source is exact in every language and theme. Messenger's own
 * "Unread message:" label uses MWPIsThreadUnread, and its top-bar badge leaves
 * out chats whose muteExpireTimeMs is -1 (forever) or still in the future.
 * Idea from fMess (github.com/toanbku/fmess, MIT).
 */

export interface ThreadState {
  unread: boolean;
  muted: boolean;
}

type Load = (name: string) => unknown;

interface ThreadReaderModules {
  db: { tables: { threads: { get(key: unknown): Promise<unknown> } } };
  i64: { of_string(value: string): unknown; to_string?(value: unknown): unknown };
  isThreadUnreadForViewer: (thread: unknown) => unknown;
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

async function loadModules(load: Load): Promise<ThreadReaderModules> {
  const singleton = load("LSDatabaseSingleton") as { LSDatabaseSingleton: Promise<unknown> };
  const db = (await singleton.LSDatabaseSingleton) as ThreadReaderModules["db"];
  const i64 = load("I64") as ThreadReaderModules["i64"];
  const { isThreadUnreadForViewer } = load("MWPIsThreadUnread") as {
    isThreadUnreadForViewer: ThreadReaderModules["isThreadUnreadForViewer"];
  };
  if (
    typeof db?.tables?.threads?.get !== "function" ||
    typeof i64?.of_string !== "function" ||
    typeof isThreadUnreadForViewer !== "function"
  ) {
    throw new Error("Messenger thread APIs changed");
  }
  return { db, i64, isThreadUnreadForViewer };
}

/**
 * Reads the given chats' state. Chats missing from the database, or whose
 * fields are not understood, are left out so the caller keeps its own
 * evidence for them. Null when the database or its APIs are unavailable.
 * Never writes to Messenger.
 */
export async function readThreadStates(
  ids: readonly string[],
  load: unknown,
  now: number,
  timeoutMs = 750,
): Promise<Map<string, ThreadState> | null> {
  if (typeof load !== "function") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const { db, i64, isThreadUnreadForViewer } = await loadModules(load as Load);
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
  };
  try {
    return await Promise.race([
      read().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
