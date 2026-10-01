/** What each emitted notification announced, keyed by the page's notification
 * id, so its 👍 action can find the message: the raw text (before link or
 * photo rewording) and when the page saw it. Kept in localStorage: native runs
 * actions in the main window, which must find a record a secondary window or
 * a page since reloaded wrote. Ids are time-based, so they never collide, and
 * records outlive a week only as long as 👍 can still date a message. */
export interface NotifiedMessage {
  body: string;
  at: number;
}

const KEY = "carrier-notified-messages";
// Matches the native route cap, so every still-actionable notification keeps
// its record.
const LIMIT = 256;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Entry = [id: number, message: NotifiedMessage];

const isEntry = (value: unknown): value is Entry =>
  Array.isArray(value) &&
  typeof value[0] === "number" &&
  typeof value[1]?.body === "string" &&
  typeof value[1]?.at === "number";

function load(storage: Storage | undefined): Entry[] {
  try {
    const entries: unknown = JSON.parse(storage?.getItem(KEY) || "[]");
    return Array.isArray(entries) ? entries.filter(isEntry) : [];
  } catch {
    return [];
  }
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
  const entries = [
    ...load(storage).filter(([known, message]) => known !== id && at - message.at < MAX_AGE_MS),
    [id, { body, at }] as Entry,
  ];
  try {
    storage?.setItem(KEY, JSON.stringify(entries.slice(-LIMIT)));
  } catch {}
}

export const notifiedMessage = (id: number, storage = shared()) =>
  load(storage).find(([known]) => known === id)?.[1];
