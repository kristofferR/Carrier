/** What each emitted notification announced, keyed by the page's notification
 * id, so its 👍 action can find the message: the raw text (before link or
 * photo rewording) and when the page saw it. Kept in localStorage: native runs
 * actions in the main window, which must find a record a secondary window or
 * a page since reloaded wrote. Ids are time-based, so they never collide.
 *
 * A record counts only once native accepts its notification (settled from the
 * main window's delivery result), so duplicates and rate-limited bursts never
 * evict the record of a notification still on screen. */
export interface NotifiedMessage {
  body: string;
  at: number;
}

interface StoredMessage extends NotifiedMessage {
  accepted: boolean;
}

const KEY = "carrier-notified-messages";
// Matches the native route cap, so every still-actionable notification keeps
// its record.
const ACCEPTED_LIMIT = 256;
// Awaiting native's verdict, which arrives within moments of the emit.
const PENDING_LIMIT = 64;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Entry = [id: number, message: StoredMessage];

const isEntry = (value: unknown): value is Entry =>
  Array.isArray(value) &&
  typeof value[0] === "number" &&
  typeof value[1]?.body === "string" &&
  typeof value[1]?.at === "number" &&
  typeof value[1]?.accepted === "boolean";

function load(storage: Storage | undefined): Entry[] {
  try {
    const entries: unknown = JSON.parse(storage?.getItem(KEY) || "[]");
    return Array.isArray(entries) ? entries.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function save(storage: Storage | undefined, entries: Entry[], now: number) {
  const live = entries.filter(([, message]) => now - message.at < MAX_AGE_MS);
  const accepted = live.filter(([, message]) => message.accepted).slice(-ACCEPTED_LIMIT);
  const pending = live.filter(([, message]) => !message.accepted).slice(-PENDING_LIMIT);
  try {
    storage?.setItem(KEY, JSON.stringify([...accepted, ...pending]));
  } catch {}
}

const shared = () => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export function rememberNotifiedMessage(
  id: number,
  body: string,
  at = Date.now(),
  storage = shared(),
) {
  const entries = load(storage).filter(([known]) => known !== id);
  save(storage, [...entries, [id, { body, at, accepted: false }]], at);
}

/** Native's verdict: keep an accepted notification's record, drop the rest. */
export function settleNotifiedMessage(
  id: number,
  accepted: boolean,
  now = Date.now(),
  storage = shared(),
) {
  const entries = load(storage);
  const entry = entries.find(([known]) => known === id);
  if (!entry) return;
  if (accepted) entry[1].accepted = true;
  save(storage, accepted ? entries : entries.filter(([known]) => known !== id), now);
}

export function notifiedMessage(id: number, storage = shared()): NotifiedMessage | undefined {
  const message = load(storage).find(([known]) => known === id)?.[1];
  return message?.accepted ? { body: message.body, at: message.at } : undefined;
}
