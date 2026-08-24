/* Per-conversation mute: whether Messenger has silenced a thread.
 *
 * Facebook's title "(N)" and bold chat rows still count muted chats. Carrier
 * reads mute from accessible names on the row (and the open-thread Mute /
 * Unmute control), then remembers the thread id so a virtualized list or a
 * momentarily missing glyph does not forget a mute we already saw.
 */

const MUTE_LABEL_LIMIT = 60;

/** Localized status words that sit alone on Messenger's mute glyph. */
const MUTED_STATUS_RE =
  /^(?:(?:notifications?\s+)?muted(?:\s+notifications?)?|this chat is muted|notifications are muted|stummgeschaltet|en sourdine|silenciado|silenziata|dempet|gedempt|tystad)$/i;

/** Action that un-silences a thread — the conversation is currently muted. */
const UNMUTE_ACTION_RE = /^un(?:-)?mute\b|^turn on notifications\b|^stummschaltung aufheben\b/i;

/** Action that silences a thread — the conversation is currently unmuted. */
const MUTE_ACTION_RE = /^mute(?:\s|$)/i;

const LABEL_ATTRS = ["aria-label", "title", "alt", "aria-description"] as const;

const MUTED_THREAD_LIMIT = 500;

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

/**
 * Whether an accessible name is a mute *status* or mute *action*, not a
 * contact named "Muted Group". Null when the string is unrelated.
 *
 * - `"Muted"` / `"Unmute"` → the thread is muted (`true`)
 * - `"Mute"` / `"Mute notifications"` → the thread is not muted (`false`)
 */
export function conversationMuteFromLabel(value: string): boolean | null {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MUTE_LABEL_LIMIT) return null;
  if (UNMUTE_ACTION_RE.test(text) || MUTED_STATUS_RE.test(text)) return true;
  if (MUTE_ACTION_RE.test(text) && !/\bmuted\b/i.test(text)) return false;
  return null;
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
): boolean | undefined {
  const signal = muteSignalFromLabels(labels);
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
  return labels;
}

export class MutedThreadStore {
  private readonly states = new Map<string, boolean>();

  observe(id: string, muted: boolean | undefined): void {
    if (!id || muted === undefined) return;
    if (this.states.has(id)) this.states.delete(id);
    this.states.set(id, muted);
    if (this.states.size > MUTED_THREAD_LIMIT) {
      this.states.delete(this.states.keys().next().value!);
    }
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
}

/** Shared across the unread badge and the notification scanner. */
export const mutedThreads = new MutedThreadStore();

export function observeConversationMute(id: string, root: ParentNode, unread: boolean): boolean {
  mutedThreads.observe(id, resolveMuteObservation(collectMuteLabels(root), unread));
  return mutedThreads.isMuted(id);
}

/** Info-sidebar / header Mute and Unmute controls for the open thread. */
export function observeOpenThreadMute(id: string, roots: Iterable<ParentNode>): boolean {
  const labels: string[] = [];
  for (const root of roots) {
    for (const label of collectMuteLabels(root)) {
      if (conversationMuteFromLabel(label) !== null) labels.push(label);
    }
  }
  mutedThreads.observe(id, muteSignalFromLabels(labels) ?? undefined);
  return mutedThreads.isMuted(id);
}
