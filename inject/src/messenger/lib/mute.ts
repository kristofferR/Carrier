/* Per-conversation mute: whether Messenger has silenced a thread.
 *
 * Facebook's title "(N)" and bold chat rows still count muted chats. Carrier
 * reads mute from accessible names on the row (and the open-thread Mute /
 * Unmute control), the mute-icon SVG path, GraphQL `mute_until`, and Mute /
 * Unmute menu clicks, then remembers the thread id so a virtualized list or a
 * momentarily missing glyph does not forget a mute we already saw.
 */

const MUTE_LABEL_LIMIT = 60;
const MUTE_COMPOSITE_LIMIT = MUTE_LABEL_LIMIT * 6;
const MUTED_THREAD_LIMIT = 500;
const MUTE_WALK_DEPTH = 24;
const MUTE_WALK_NODES = 40_000;
const MUTE_STORAGE_KEY = "__carrier_muted_threads";

/** Localized status words that sit alone on Messenger's mute glyph. */
const MUTED_STATUS_RE =
  /^(?:(?:notifications?\s+)?muted(?:\s+notifications?)?|this chat is muted|notifications are (?:muted|off)|stummgeschaltet|en sourdine|silenciado|silenziata|dempet|gedempt|tystad)$/i;

/** Action that un-silences a thread — the conversation is currently muted. */
const UNMUTE_ACTION_RE = /^un(?:-)?mute\b|^turn on notifications\b|^stummschaltung aufheben\b/i;

/** Action that silences a thread — the conversation is currently unmuted. */
const MUTE_ACTION_RE = /^mute(?:\s|$)|^turn off notifications\b/i;

const LABEL_ATTRS = ["aria-label", "title", "alt", "aria-description"] as const;

const MUTE_HINT_RE = /mute|stumm|sourdine|silenci|silenzi|demp|gedempt|tyst/i;

/** Older Messenger speaker-off glyph (Caprine `muteIconNewDesign`). */
export const MUTE_SVG_PATH_PREFIXES = ["M29.676 7.746"] as const;

const MUTE_UNTIL_KEYS = new Set(["mute_until", "muteUntil", "mute_until_ms", "muteUntilMs"]);
const MUTED_BOOL_KEYS = new Set(["is_muted", "isMuted"]);

export type MuteStorage = Pick<Storage, "getItem" | "setItem">;

export function ignoresMutedConversations(
  settings: { ignore_muted_conversations?: boolean } | null | undefined,
): boolean {
  return settings?.ignore_muted_conversations !== false;
}

export function suppressMutedDelivery(
  muted: boolean,
  settings: { ignore_muted_conversations?: boolean } | null | undefined,
): boolean {
  return muted && ignoresMutedConversations(settings);
}

function classifyMutePhrase(text: string): boolean | null {
  if (!text || text.length > MUTE_LABEL_LIMIT) return null;
  if (UNMUTE_ACTION_RE.test(text) || MUTED_STATUS_RE.test(text)) return true;
  if (MUTE_ACTION_RE.test(text) && !/\bmuted\b/i.test(text)) return false;
  return null;
}

function muteLabelSegments(text: string): string[] {
  return text
    .split(/[,;·•|/()[\]{}]|\s[-–—]\s|\.(?:\s+|$)/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Whether an accessible name is a mute *status* or mute *action*, not a
 * contact named "Muted Group". Null when the string is unrelated.
 *
 * - `"Muted"` / `"Unmute"` → the thread is muted (`true`)
 * - `"Mute"` / `"Mute notifications"` → the thread is not muted (`false`)
 * - `"Jane Doe, muted"` → muted (status sits in a composite row name)
 */
export function conversationMuteFromLabel(value: string): boolean | null {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const whole = classifyMutePhrase(text);
  if (whole !== null) return whole;
  if (text.length > MUTE_COMPOSITE_LIMIT) return null;
  let muted = false;
  let unmuted = false;
  for (const segment of muteLabelSegments(text)) {
    const signal = classifyMutePhrase(segment);
    if (signal === true) muted = true;
    else if (signal === false) unmuted = true;
  }
  if (muted) return true;
  if (unmuted) return false;
  return null;
}

/** Clicking Mute silences the thread; clicking Unmute restores it. */
export function muteStateAfterMenuLabel(value: string): boolean | null {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MUTE_COMPOSITE_LIMIT) return null;
  const phrases = [text, ...muteLabelSegments(text)];
  let muted: boolean | null = null;
  for (const phrase of phrases) {
    if (!phrase || phrase.length > MUTE_LABEL_LIMIT) continue;
    if (UNMUTE_ACTION_RE.test(phrase)) muted = false;
    else if (MUTE_ACTION_RE.test(phrase) && !/\bmuted\b/i.test(phrase)) muted = true;
  }
  return muted;
}

/** Combine labels from one surface: muted wins if both action kinds appear. */
export function muteSignalFromLabels(labels: Iterable<string>): boolean | null {
  let muted = false;
  let unmuted = false;
  for (const label of labels) {
    const signal = conversationMuteFromLabel(label);
    if (signal === true) muted = true;
    else if (signal === false) unmuted = true;
  }
  if (muted) return true;
  if (unmuted) return false;
  return null;
}

export function muteSignalFromSvgPaths(paths: Iterable<string>): boolean | null {
  for (const raw of paths) {
    const d = (raw || "").replace(/\s+/g, " ").trim();
    if (!d) continue;
    if (MUTE_SVG_PATH_PREFIXES.some((prefix) => d.startsWith(prefix))) return true;
  }
  return null;
}

/**
 * Turn this scan's labels into a cache write.
 *
 * Unread rows sometimes omit the mute glyph (the same failure Caprine hit),
 * so "no label" on an unread row is unknown. A read row would still show the
 * icon if the thread were muted, so "no label" there means unmuted.
 */
export function resolveMuteObservation(
  labels: Iterable<string>,
  unread: boolean,
  svgPaths: Iterable<string> = [],
): boolean | undefined {
  const signal = muteSignalFromLabels(labels) ?? muteSignalFromSvgPaths(svgPaths);
  if (signal !== null) return signal;
  if (!unread) return false;
  return undefined;
}

export function collectMuteLabels(root: ParentNode): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const text = (value || "").replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    labels.push(text);
  };
  if (root instanceof Element) {
    for (const attr of LABEL_ATTRS) push(root.getAttribute(attr));
  }
  for (const el of root.querySelectorAll("[aria-label], [title], [alt], [aria-description]")) {
    for (const attr of LABEL_ATTRS) push(el.getAttribute(attr));
  }
  for (const el of root.querySelectorAll("svg title, svg desc")) push(el.textContent);
  for (const el of root.querySelectorAll("span, div, i")) {
    if (el.childElementCount > 0) continue;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text && text.length <= MUTE_LABEL_LIMIT && MUTE_HINT_RE.test(text)) push(text);
  }
  return labels;
}

export function collectMuteSvgPaths(root: ParentNode): string[] {
  const paths: string[] = [];
  for (const el of root.querySelectorAll("path[d]")) {
    const d = el.getAttribute("d");
    if (d) paths.push(d);
  }
  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isThreadId(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && value >= 1e6;
  return typeof value === "string" && /^\d{6,}$/.test(value);
}

function threadIdFromMuteNode(rec: Record<string, unknown>): string | null {
  const key = rec.thread_key ?? rec.threadKey;
  if (isRecord(key)) {
    const fbid = key.thread_fbid ?? key.threadFbid;
    if (isThreadId(fbid)) return String(fbid);
    const other = key.other_user_id ?? key.otherUserId;
    if (isThreadId(other)) return String(other);
  }
  for (const field of ["thread_fbid", "threadFbid", "thread_id", "threadId"]) {
    if (isThreadId(rec[field])) return String(rec[field]);
  }
  return null;
}

function muteFlagFromNode(rec: Record<string, unknown>): boolean | null {
  for (const key of MUTED_BOOL_KEYS) {
    if (typeof rec[key] === "boolean") return rec[key];
  }
  for (const key of MUTE_UNTIL_KEYS) {
    const value = rec[key];
    if (value === null || value === 0 || value === "0") return false;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value) !== 0;
  }
  return null;
}

/** Thread ids paired with mute flags in a GraphQL / mercury JSON payload. */
export function muteStatesFromPayload(payload: unknown): Array<{ id: string; muted: boolean }> {
  const out: Array<{ id: string; muted: boolean }> = [];
  const seen = new Set<string>();
  const walking = new WeakSet<object>();
  let nodes = 0;
  const walk = (node: unknown, depth: number) => {
    if (depth > MUTE_WALK_DEPTH || nodes > MUTE_WALK_NODES || !node || typeof node !== "object") {
      return;
    }
    if (walking.has(node)) return;
    walking.add(node);
    nodes += 1;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    const id = threadIdFromMuteNode(rec);
    const muted = muteFlagFromNode(rec);
    if (id && muted !== null && !seen.has(id)) {
      seen.add(id);
      out.push({ id, muted });
    }
    for (const value of Object.values(rec)) walk(value, depth + 1);
  };
  walk(payload, 0);
  return out;
}

/** Facebook sometimes prefixes JSON with `for (;;);` or sends JSONL. */
export function parseFacebookPayload(text: string): unknown {
  const stripped = (text || "").replace(/^(?:for\s*\(;;\);\s*)+/, "").trim();
  if (!stripped) return null;
  try {
    return JSON.parse(stripped);
  } catch (_) {}
  const objects: unknown[] = [];
  for (const line of stripped.split("\n")) {
    const part = line.replace(/^(?:for\s*\(;;\);\s*)+/, "").trim();
    if (!part) continue;
    try {
      objects.push(JSON.parse(part));
    } catch (_) {}
  }
  return objects.length ? objects : null;
}

export class MutedThreadStore {
  private readonly states = new Map<string, boolean>();
  private readonly holdUntil = new Map<string, number>();

  constructor(private readonly storage: MuteStorage | null = null) {
    this.restore();
  }

  observe(id: string, muted: boolean | undefined, holdMs = 0): void {
    if (!id || muted === undefined) return;
    const until = this.holdUntil.get(id) || 0;
    if (holdMs <= 0 && Date.now() < until && this.states.get(id) !== muted) return;
    const previous = this.states.get(id);
    if (this.states.has(id)) this.states.delete(id);
    this.states.set(id, muted);
    if (this.states.size > MUTED_THREAD_LIMIT) {
      this.states.delete(this.states.keys().next().value!);
    }
    if (holdMs > 0) this.holdUntil.set(id, Date.now() + holdMs);
    if (previous !== muted) this.persist();
  }

  isMuted(id: string): boolean {
    return this.states.get(id) === true;
  }

  knownMutedUnread(unreadIds: Iterable<string>): boolean {
    for (const id of unreadIds) {
      if (this.states.get(id) === true) return true;
    }
    return false;
  }

  private restore(): void {
    if (!this.storage) return;
    try {
      const raw = JSON.parse(this.storage.getItem(MUTE_STORAGE_KEY) || "null") as unknown;
      if (!isRecord(raw)) return;
      for (const [id, muted] of Object.entries(raw)) {
        if (muted === true && /^\d+$/.test(id)) this.states.set(id, true);
      }
    } catch (_) {}
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const raw: Record<string, true> = {};
      for (const [id, muted] of this.states) {
        if (muted) raw[id] = true;
      }
      this.storage.setItem(MUTE_STORAGE_KEY, JSON.stringify(raw));
    } catch (_) {}
  }
}

/** Shared across the unread badge and the notification scanner. */
export const mutedThreads = new MutedThreadStore(
  typeof localStorage === "undefined" ? null : localStorage,
);

export function observeConversationMute(id: string, root: ParentNode, unread: boolean): boolean {
  mutedThreads.observe(
    id,
    resolveMuteObservation(collectMuteLabels(root), unread, collectMuteSvgPaths(root)),
  );
  return mutedThreads.isMuted(id);
}

/** Info-sidebar / header Mute and Unmute controls for the open thread. */
export function observeOpenThreadMute(id: string, roots: Iterable<ParentNode>): boolean {
  const labels: string[] = [];
  const svgPaths: string[] = [];
  for (const root of roots) {
    for (const label of collectMuteLabels(root)) {
      if (conversationMuteFromLabel(label) !== null) labels.push(label);
    }
    svgPaths.push(...collectMuteSvgPaths(root));
  }
  mutedThreads.observe(
    id,
    muteSignalFromLabels(labels) ?? muteSignalFromSvgPaths(svgPaths) ?? undefined,
  );
  return mutedThreads.isMuted(id);
}
