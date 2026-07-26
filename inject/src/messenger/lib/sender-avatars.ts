/* ------------------- Group notification sender avatars ------------------ */
// A group's conversation row only carries the thread picture, so a fallback
// notification for "Kim: ..." has no way to show Kim. Messenger does pair a
// name with an avatar wherever it renders people — message rows in an open
// thread, the Chat Members list — so those pairs are harvested as they are
// seen and cached by name for later notifications.

const SENDER_AVATAR_LIMIT = 120;
const SENDER_AVATAR_VERSION = 3;

export const SENDER_AVATAR_STORAGE_KEY = "__carrier_sender_avatars__";

/** Names are matched case- and whitespace-insensitively. */
export const normalizeSenderName = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

// Entries are scoped to the thread they were harvested in: Messenger gives us
// no stable identity for a person, so two contacts sharing a display name are
// only told apart by where they were seen. A thread's own members are exactly
// who its previews can name.
const entryKey = (threadId: string, name: string) =>
  `${threadId}\u0000${normalizeSenderName(name)}`;

/**
 * The stable part of an avatar URL. Facebook signs these and encodes the
 * requested size in the query, so the same photo arrives under many URLs; the
 * path names the photo itself, which is what tells two people apart.
 */
export function avatarPhotoId(url: string): string {
  try {
    return new URL(url, "https://www.facebook.com/").pathname;
  } catch (_) {
    return url;
  }
}

interface SenderAvatarEntry {
  url: string;
  /** The name that supplied this URL — an alias's owner is its full name. */
  owner: string;
  /** The photo behind the URL, which its signature and size do not change. */
  photo: string;
  /** When this pairing was last seen, for telling a namesake from a new photo. */
  at: number;
}

// Virtualization can surface two namesakes seconds apart rather than in one
// pass, so a name whose photo changes again this quickly is two people; over a
// longer gap the likelier story is that one person changed their picture.
const COLLISION_WINDOW_MS = 5 * 60_000;

const GROUP_THREAD_LIMIT = 200;
// Collisions are kept apart from the avatars they invalidate: "this name means
// two people" must outlive the eviction of either face, or the next harvest of
// one namesake would quietly re-arm the wrong-face bug.
const AMBIGUOUS_LIMIT = 200;

/**
 * Thread + sender name → avatar URL, most recently updated last, plus the
 * threads known to be groups (only a group preview names a sender at all).
 * Bounded and persisted: the auto-refresh reloads the page regularly, and a
 * cache that died with the document would be empty exactly when a notification
 * needs it.
 */
export class SenderAvatarStore {
  private readonly entries = new Map<string, SenderAvatarEntry>();
  private readonly ambiguous = new Set<string>();
  private readonly groupThreads = new Set<string>();

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = null,
    private readonly limit = SENDER_AVATAR_LIMIT,
  ) {
    try {
      const raw = this.storage?.getItem(SENDER_AVATAR_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      const persisted =
        parsed &&
        typeof parsed === "object" &&
        "version" in parsed &&
        parsed.version === SENDER_AVATAR_VERSION &&
        "entries" in parsed &&
        Array.isArray(parsed.entries)
          ? parsed.entries
          : [];
      for (const entry of persisted) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          typeof entry[2] === "string"
        ) {
          // Earlier builds recorded a collision as an entry with no URL.
          if (entry[1]) {
            this.entries.set(entry[0], {
              url: entry[1],
              owner: entry[2],
              photo: typeof entry[3] === "string" ? entry[3] : avatarPhotoId(entry[1]),
              at: typeof entry[4] === "number" ? entry[4] : 0,
            });
          } else {
            this.ambiguous.add(entry[0]);
          }
        }
      }
      const ambiguous =
        parsed &&
        typeof parsed === "object" &&
        "ambiguous" in parsed &&
        Array.isArray(parsed.ambiguous)
          ? parsed.ambiguous
          : [];
      for (const key of ambiguous) {
        if (typeof key === "string" && key) this.ambiguous.add(key);
      }
      const groups =
        parsed && typeof parsed === "object" && "groups" in parsed && Array.isArray(parsed.groups)
          ? parsed.groups
          : [];
      for (const id of groups) {
        if (typeof id === "string" && id) this.groupThreads.add(id);
      }
    } catch (_) {}
    // Never trust storage to respect the bound it was written under.
    if (this.trim()) this.persist();
  }

  private trim(): boolean {
    let trimmed = false;
    while (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value!);
      trimmed = true;
    }
    while (this.ambiguous.size > AMBIGUOUS_LIMIT) {
      this.ambiguous.delete(this.ambiguous.values().next().value!);
      trimmed = true;
    }
    while (this.groupThreads.size > GROUP_THREAD_LIMIT) {
      this.groupThreads.delete(this.groupThreads.values().next().value!);
      trimmed = true;
    }
    return trimmed;
  }

  private persist(): void {
    try {
      this.storage?.setItem(
        SENDER_AVATAR_STORAGE_KEY,
        JSON.stringify({
          version: SENDER_AVATAR_VERSION,
          entries: [...this.entries].map(([key, entry]) => [
            key,
            entry.url,
            entry.owner,
            entry.photo,
            entry.at,
          ]),
          ambiguous: [...this.ambiguous],
          groups: [...this.groupThreads],
        }),
      );
    } catch (_) {}
  }

  /**
   * Record one name/avatar pairing; returns whether anything changed. `owner`
   * names who the URL belongs to when the key is an alias for them ("Kim" for
   * "Kim Andersen"): an alias two different people answer to identifies
   * neither, so the second claim retires it and the group photo wins instead.
   * Two contacts who share a name across different threads never meet here.
   * Re-seeing an unchanged pairing writes nothing — a rendered thread repeats
   * the same faces on every scan.
   */
  remember(threadId: string, name: string, url: string, owner = name, at = 0): boolean {
    const normalized = normalizeSenderName(name);
    const ownerKey = normalizeSenderName(owner) || normalized;
    if (!threadId || !normalized || !url) return false;
    const key = entryKey(threadId, name);
    if (this.ambiguous.has(key)) return false;
    const photo = avatarPhotoId(url);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.owner !== ownerKey) return this.markAmbiguous(threadId, name);
      // A second face under the same name, moments after the first, is a
      // second person — nobody replaces their profile picture mid-thread.
      if (existing.photo !== photo && at - existing.at < COLLISION_WINDOW_MS) {
        return this.markAmbiguous(threadId, name);
      }
      if (existing.url === url) return false;
    }
    // Re-insert so the most recently updated sender is the last one evicted.
    this.entries.delete(key);
    this.entries.set(key, { url, owner: ownerKey, photo, at });
    this.trim();
    this.persist();
    return true;
  }

  /**
   * The avatar for a preview's sender prefix. Group previews name the sender
   * the same way the thread does ("Kim"), but a members list may hold the full
   * name — so a unique "Kim …" match counts, while an ambiguous one does not:
   * showing the wrong person's face is worse than showing the group photo.
   */
  /** Why a sender resolves the way it does — for the dev-only MCP probe. */
  describe(threadId: string, name: string): string {
    const normalized = normalizeSenderName(name);
    if (!threadId || !normalized) return "no-sender";
    const key = entryKey(threadId, name);
    if (this.ambiguous.has(key)) return "ambiguous";
    if (this.entries.has(key)) return "exact";
    const prefixed = [...this.entries].filter(([candidate]) => candidate.startsWith(`${key} `));
    return prefixed.length === 1 ? "full-name" : prefixed.length ? "ambiguous" : "miss";
  }

  lookup(threadId: string, name: string): string {
    const normalized = normalizeSenderName(name);
    if (!threadId || !normalized) return "";
    const key = entryKey(threadId, name);
    if (this.ambiguous.has(key)) return "";
    const exact = this.entries.get(key);
    if (exact) return exact.url;
    const prefixed = [...this.entries].filter(([candidate]) => candidate.startsWith(`${key} `));
    return prefixed.length === 1 ? (prefixed[0]?.[1].url ?? "") : "";
  }

  /**
   * Remember that a thread is a group, which only its own message rows can
   * prove (they print the sender's name above each message). A direct message
   * that happens to start with "John: " must not be read as a sender prefix.
   */
  rememberGroupThread(id: string): boolean {
    if (!id || this.groupThreads.has(id)) return false;
    this.groupThreads.add(id);
    this.trim();
    this.persist();
    return true;
  }

  /**
   * Give up on a name: two people in this thread answer to it. Sticky, and
   * held outside the avatar entries so evicting a face cannot resurrect it.
   */
  markAmbiguous(threadId: string, name: string): boolean {
    const normalized = normalizeSenderName(name);
    if (!threadId || !normalized) return false;
    const key = entryKey(threadId, name);
    if (this.ambiguous.has(key)) return false;
    this.ambiguous.add(key);
    this.entries.delete(key);
    // Every short name this one answers to is just as ambiguous: an alias
    // outliving its owner would hand one namesake's face to the other.
    const prefix = `${threadId}\u0000`;
    for (const [candidate, entry] of [...this.entries]) {
      if (!candidate.startsWith(prefix) || entry.owner !== normalized) continue;
      this.entries.delete(candidate);
      this.ambiguous.add(candidate);
    }
    this.trim();
    this.persist();
    return true;
  }

  isGroupThread(id: string): boolean {
    return this.groupThreads.has(id);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Counts only, for the dev-only MCP probe. */
  get stats(): { avatars: number; groups: number; retired: number } {
    return {
      avatars: this.entries.size,
      groups: this.groupThreads.size,
      retired: this.ambiguous.size,
    };
  }
}
