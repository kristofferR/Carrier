/*
 * Messenger's own Do Not Disturb (Ref #353). Turning it on in Messenger or on
 * the phone syncs `notification_settings.globalMuteUntil` to the account:
 * seconds since 1970 when it ends, 0 when off, -1 until turned off. Carrier
 * keeps the latest value here and treats an active Do Not Disturb like Mute
 * Notifications. Idea from fMess (github.com/toanbku/fmess, MIT).
 */

type Load = (name: string) => unknown;

let muteUntilSeconds: number | null = null;

export function setMessengerDndUntil(seconds: number | null): void {
  muteUntilSeconds = seconds;
}

export function messengerDndActive(nowMs = Date.now()): boolean {
  const until = muteUntilSeconds;
  if (until === null) return false;
  return until < 0 || until * 1000 > nowMs;
}

/** Seconds from a database value (number, bigint, digit string or I64), or null. */
export function muteUntilFromDatabase(
  raw: unknown,
  i64ToString?: (value: unknown) => unknown,
): number | null {
  let text: unknown = raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.trunc(raw) : null;
  if (typeof raw === "bigint") text = raw.toString();
  else if (typeof raw !== "string" && raw != null && i64ToString) text = i64ToString(raw);
  if (typeof text !== "string" || !/^-?\d+$/.test(text)) return null;
  const seconds = Number(text);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * The signed-in account's Do Not Disturb end, in seconds. Null when it cannot
 * be read (no account, changed APIs, database not ready); 0 when Messenger has
 * no settings row yet. Never writes to Messenger.
 */
export async function readMessengerDndUntil(
  account: string,
  load: unknown,
  timeoutMs = 750,
): Promise<number | null> {
  if (!/^\d+$/.test(account) || typeof load !== "function") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const singleton = (load as Load)("LSDatabaseSingleton") as {
      LSDatabaseSingleton: Promise<{
        tables?: { notification_settings?: { get(key: unknown): Promise<unknown> } };
      }>;
    };
    const db = await singleton.LSDatabaseSingleton;
    const i64 = (load as Load)("I64") as {
      of_string(value: string): unknown;
      to_string?(value: unknown): unknown;
    };
    const table = db?.tables?.notification_settings;
    if (typeof table?.get !== "function" || typeof i64?.of_string !== "function") return null;
    const row = await table.get(i64.of_string(account));
    if (!row || typeof row !== "object") return 0;
    return muteUntilFromDatabase(
      (row as { globalMuteUntil?: unknown }).globalMuteUntil,
      i64.to_string?.bind(i64),
    );
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
