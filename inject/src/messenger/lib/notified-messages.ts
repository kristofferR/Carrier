import { accountScopedStorageKey } from "./threads";

/** What each emitted notification announced, keyed by the page's notification
 * id, so its 👍 action can find the message: the raw text (before link or
 * photo rewording) and when the page saw it. Kept in localStorage: native runs
 * actions in the main window, which must find a record a secondary window or
 * a page since reloaded wrote. Ids are time-based, so they never collide.
 *
 * Each record has its own key under the signed-in account, so windows never
 * overwrite each other's updates and another account's records are never
 * read. A record counts only once native accepts its notification (settled
 * from the main window's delivery result), so duplicates and rate-limited
 * bursts never evict the record of a notification still on screen. */
export interface NotifiedMessage {
  body: string;
  at: number;
}

interface StoredMessage extends NotifiedMessage {
  accepted: boolean;
}

// Matches the native route cap, so every still-actionable notification keeps
// its record.
const ACCEPTED_LIMIT = 256;
// Awaiting native's verdict, which arrives within moments of the emit. Native
// accepts a burst oldest-first before rate limiting the rest, so the oldest
// pending records are the ones kept; an unsettled one ages out quickly.
const PENDING_LIMIT = 256;
const PENDING_MAX_AGE_MS = 60_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface Store {
  storage: Storage;
  prefix: string;
}

const isStored = (value: unknown): value is StoredMessage =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as StoredMessage).body === "string" &&
  typeof (value as StoredMessage).at === "number" &&
  typeof (value as StoredMessage).accepted === "boolean";

function read(store: Store, key: string): StoredMessage | undefined {
  try {
    const value: unknown = JSON.parse(store.storage.getItem(key) || "null");
    return isStored(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function write(store: Store, id: number, message: StoredMessage) {
  try {
    store.storage.setItem(`${store.prefix}${id}`, JSON.stringify(message));
  } catch {}
}

/** Drop expired records and the oldest beyond each cap. */
function prune(store: Store, now: number) {
  const records: [key: string, message: StoredMessage | undefined][] = [];
  for (let index = 0; index < store.storage.length; index++) {
    const key = store.storage.key(index);
    if (key?.startsWith(store.prefix)) records.push([key, read(store, key)]);
  }
  const live = records.filter(
    (record): record is [string, StoredMessage] =>
      record[1] !== undefined &&
      now - record[1].at < (record[1].accepted ? MAX_AGE_MS : PENDING_MAX_AGE_MS),
  );
  const oldestFirst = (accepted: boolean) =>
    live.filter(([, message]) => message.accepted === accepted).sort((a, b) => a[1].at - b[1].at);
  const keep = new Set(
    [
      ...oldestFirst(true).slice(-ACCEPTED_LIMIT),
      ...oldestFirst(false).slice(0, PENDING_LIMIT),
    ].map(([key]) => key),
  );
  for (const [key] of records) if (!keep.has(key)) store.storage.removeItem(key);
}

function accountStore(): Store | null {
  try {
    const prefix = accountScopedStorageKey("carrier-notified-message", document.cookie);
    return prefix ? { storage: window.localStorage, prefix: `${prefix}:` } : null;
  } catch {
    return null;
  }
}

export function rememberNotifiedMessage(
  id: number,
  body: string,
  at = Date.now(),
  store = accountStore(),
) {
  if (!store) return;
  write(store, id, { body, at, accepted: false });
  prune(store, at);
}

/** Native's verdict: keep an accepted notification's record, drop the rest. */
export function settleNotifiedMessage(
  id: number,
  accepted: boolean,
  now = Date.now(),
  store = accountStore(),
) {
  if (!store) return;
  const message = read(store, `${store.prefix}${id}`);
  if (!message) return;
  if (accepted) write(store, id, { ...message, accepted: true });
  else store.storage.removeItem(`${store.prefix}${id}`);
  prune(store, now);
}

export function notifiedMessage(id: number, store = accountStore()): NotifiedMessage | undefined {
  const message = store ? read(store, `${store.prefix}${id}`) : undefined;
  return message?.accepted ? { body: message.body, at: message.at } : undefined;
}
