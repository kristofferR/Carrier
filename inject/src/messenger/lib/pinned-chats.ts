/*
 * Pinned chats (Ref #457): the conversations the user pinned to the top of
 * the chat list, kept natively per Facebook account (src-tauri/src/pinned_chats.rs)
 * because Facebook clears unknown localStorage keys on Mac page loads. Each pin
 * keeps the name the chat list last showed, for a pinned chat Messenger has not
 * loaded yet. The section itself is drawn by pinned-chats-section.ts.
 */

/** Mirrors MAX_PINS and MAX_NAME_CHARS in src-tauri/src/pinned_chats.rs. */
export const MAX_PINNED_CHATS = 50;
export const MAX_PINNED_NAME_CHARS = 60;

export interface PinnedChat {
  id: string;
  name: string;
}

const THREAD_ID_RE = /^\d{1,32}$/;

function cleanName(name: unknown): string {
  if (typeof name !== "string") return "";
  return [...name.replace(/\s+/g, " ").trim()].slice(0, MAX_PINNED_NAME_CHARS).join("");
}

/** Pins from untrusted input: valid ids only, each once, in order, capped. */
export function parsePinnedChats(value: unknown): PinnedChat[] {
  if (!Array.isArray(value)) return [];
  const out: PinnedChat[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (out.length >= MAX_PINNED_CHATS) break;
    if (!item || typeof item !== "object") continue;
    const { id, name } = item as Record<string, unknown>;
    if (typeof id !== "string" || !THREAD_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: cleanName(name) });
  }
  return out;
}

/** `list` with `chat` pinned last, or `list` itself when it can't be added. */
export function withPin(list: readonly PinnedChat[], chat: PinnedChat): readonly PinnedChat[] {
  if (!THREAD_ID_RE.test(chat.id) || list.length >= MAX_PINNED_CHATS) return list;
  if (list.some((pin) => pin.id === chat.id)) return list;
  return [...list, { id: chat.id, name: cleanName(chat.name) }];
}

export function withoutPin(list: readonly PinnedChat[], id: string): readonly PinnedChat[] {
  return list.some((pin) => pin.id === id) ? list.filter((pin) => pin.id !== id) : list;
}

/** `list` with a pin's remembered name updated; unchanged for an empty name. */
export function withName(
  list: readonly PinnedChat[],
  id: string,
  name: string,
): readonly PinnedChat[] {
  const clean = cleanName(name);
  if (!clean || !list.some((pin) => pin.id === id && pin.name !== clean)) return list;
  return list.map((pin) => (pin.id === id ? { id, name: clean } : pin));
}

export interface PinnedChatsStore {
  subscribe(listener: () => void): () => void;
  /** Stable until the pins change, as React's external-store hook needs. */
  getSnapshot(): readonly PinnedChat[];
  /** The pinned ids, stable alongside the snapshot. */
  getIds(): ReadonlySet<string>;
  replace(next: readonly PinnedChat[]): void;
}

export function createPinnedChatsStore(): PinnedChatsStore {
  let pins: readonly PinnedChat[] = [];
  let ids: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => pins,
    getIds: () => ids,
    replace(next) {
      if (
        next.length === pins.length &&
        next.every((pin, i) => pin.id === pins[i]?.id && pin.name === pins[i]?.name)
      )
        return;
      pins = next;
      ids = new Set(next.map((pin) => pin.id));
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The page's pins. One per page: the section and the menus share it. */
export const pinnedChats = createPinnedChatsStore();
