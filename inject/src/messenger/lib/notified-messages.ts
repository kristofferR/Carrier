/** What each emitted notification announced, keyed by the page's notification
 * id, so its 👍 action can find the message: the raw text (before link or
 * photo rewording) and when the page saw it. Kept in sessionStorage so a 👍
 * that forces a hard navigation still finds it in the reloaded page; ids are
 * time-based, so they never collide across reloads. */
export interface NotifiedMessage {
  body: string;
  at: number;
}

const KEY = "carrier-notified-messages";
// Matches the native route cap, so every still-actionable notification keeps
// its record.
const LIMIT = 256;

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

const session = () => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

export function rememberNotifiedMessage(
  id: number,
  body: string,
  at = Date.now(),
  storage = session(),
) {
  const entries = [...load(storage).filter(([known]) => known !== id), [id, { body, at }] as Entry];
  try {
    storage?.setItem(KEY, JSON.stringify(entries.slice(-LIMIT)));
  } catch {}
}

export const notifiedMessage = (id: number, storage = session()) =>
  load(storage).find(([known]) => known === id)?.[1];
