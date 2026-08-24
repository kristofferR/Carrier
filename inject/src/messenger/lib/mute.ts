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

const LABEL_ATTRS = ["aria-label", "title", "aria-description"] as const;
const MUTE_ACTION_ROLES = new Set(["button", "menuitem", "menuitemcheckbox", "switch"]);

const MUTED_ROW_ICON_SHAPE = 0x774a4a14;

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

export function suppressNotificationDelivery(
  muted: boolean,
  settings:
    | { mute_notifications?: boolean; ignore_muted_conversations?: boolean }
    | null
    | undefined,
): boolean {
  return settings?.mute_notifications === true || suppressMutedDelivery(muted, settings);
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

export function isExplicitUnmuteAction(value: string): boolean {
  const text = (value || "").replace(/\s+/g, " ").trim();
  return text.length <= MUTE_LABEL_LIMIT && UNMUTE_ACTION_RE.test(text);
}

/**
 * Accessible labels qualify only when they belong to mute UI, never message
 * content or an avatar. This prevents a contact whose image alt is "Muted"
 * from being treated as a muted conversation.
 */
export function muteSignalFromSource(source: {
  value: string;
  tagName: string;
  role?: string | null;
  attribute: string;
  containsSvg?: boolean;
}): boolean | null {
  if (source.attribute === "alt") return null;
  const signal = conversationMuteFromLabel(source.value);
  if (signal === null) return null;
  const tag = source.tagName.toLowerCase();
  const role = (source.role || "").toLowerCase();
  if (UNMUTE_ACTION_RE.test(source.value) || MUTE_ACTION_RE.test(source.value)) {
    return tag === "button" || MUTE_ACTION_ROLES.has(role) ? signal : null;
  }
  if (tag === "a" || tag === "img" || role === "link" || role === "row" || role === "gridcell") {
    return null;
  }
  return tag === "svg" || role === "img" || source.containsSvg === true ? signal : null;
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

export interface MutedRowIconShape {
  width: number;
  height: number;
  rightGap: number;
  interactive: boolean;
  ariaHidden: boolean;
  viewBox: string;
  pathCount: number;
  shapeHash: number;
}

/** Messenger's unlabeled, aria-hidden 16px slashed-bell row status icon. */
export function isMutedRowIconShape(shape: MutedRowIconShape): boolean {
  return (
    shape.width >= 14 &&
    shape.width <= 18 &&
    shape.height >= 14 &&
    shape.height <= 18 &&
    shape.rightGap >= 8 &&
    shape.rightGap <= 24 &&
    !shape.interactive &&
    shape.ariaHidden &&
    shape.viewBox.replace(/\s+/g, " ").trim() === "0 0 16 16" &&
    shape.pathCount === 1 &&
    shape.shapeHash === MUTED_ROW_ICON_SHAPE
  );
}

const svgShapeHash = (svg: Element): number => {
  let shapeText = "";
  for (const shape of svg.querySelectorAll("path, line, polyline, circle")) {
    shapeText += `${shape.tagName}:${shape.getAttribute("d") || ""}:${shape.getAttribute("points") || ""}:${shape.getAttribute("cx") || ""}:${shape.getAttribute("cy") || ""};`;
  }
  let hash = 2166136261;
  for (let index = 0; index < shapeText.length; index++) {
    hash ^= shapeText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export function hasMutedRowIcon(root: ParentNode): boolean {
  if (!(root instanceof Element)) return false;
  const rootRect = root.getBoundingClientRect();
  for (const svg of root.querySelectorAll("svg")) {
    const rect = svg.getBoundingClientRect();
    if (
      isMutedRowIconShape({
        width: rect.width,
        height: rect.height,
        rightGap: rootRect.right - rect.right,
        interactive: !!svg.closest(
          'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="switch"]',
        ),
        ariaHidden: svg.getAttribute("aria-hidden") === "true",
        viewBox: svg.getAttribute("viewBox") || "",
        pathCount: svg.querySelectorAll("path").length,
        shapeHash: svgShapeHash(svg),
      })
    ) {
      return true;
    }
  }
  return false;
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

export function collectMuteLabels(root: ParentNode, includeActions = true): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const text = (value || "").replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    labels.push(text);
  };
  const inspect = (el: Element) => {
    for (const attr of LABEL_ATTRS) {
      const value = el.getAttribute(attr);
      if (
        !includeActions &&
        value &&
        (isExplicitUnmuteAction(value) || MUTE_ACTION_RE.test(value.replace(/\s+/g, " ").trim()))
      ) {
        continue;
      }
      if (
        value &&
        muteSignalFromSource({
          value,
          tagName: el.tagName,
          role: el.getAttribute("role"),
          attribute: attr,
          containsSvg: [...el.children].some((child) => child.tagName.toLowerCase() === "svg"),
        }) !== null
      ) {
        push(value);
      }
    }
  };
  if (root instanceof Element) inspect(root);
  for (const el of root.querySelectorAll("[aria-label], [title], [aria-description]")) {
    inspect(el);
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

  invalidateMute(id: string): void {
    if (id) this.observe(id, false);
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

let actionInvalidationStarted = false;

const threadIdFromActionTarget = (target: Element): string => {
  const row = target.closest('[role="row"]');
  const href = row?.querySelector<HTMLAnchorElement>('a[href*="/t/"]')?.getAttribute("href") || "";
  return /\/t\/([^/?#]+)/.exec(href)?.[1] || "";
};

/** Clear cached mute state after Messenger's explicit Unmute action. */
export function initMuteActionInvalidation(): void {
  if (actionInvalidationStarted) return;
  actionInvalidationStarted = true;
  let recentRow: { id: string; at: number } | null = null;
  const rememberRow = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    const id = threadIdFromActionTarget(target);
    if (id) recentRow = { id, at: Date.now() };
  };
  document.addEventListener("pointerdown", (event) => rememberRow(event.target), true);
  document.addEventListener("contextmenu", (event) => rememberRow(event.target), true);
  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) return;
      if (!(event.target instanceof Element)) return;
      rememberRow(event.target);
      const action = event.target.closest<HTMLElement>(
        'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"]',
      );
      if (!action) return;
      const label =
        action.getAttribute("aria-label") ||
        action.getAttribute("title") ||
        action.textContent ||
        "";
      if (!isExplicitUnmuteAction(label)) return;
      const rowId = threadIdFromActionTarget(action);
      const openId = /\/t\/([^/?#]+)/.exec(location.pathname)?.[1] || "";
      const recentId = recentRow && Date.now() - recentRow.at <= 15_000 ? recentRow.id : "";
      const id = rowId || recentId || openId;
      if (id) mutedThreads.invalidateMute(id);
    },
    true,
  );
}

export function observeConversationMute(id: string, root: ParentNode, unread: boolean): boolean {
  mutedThreads.observe(
    id,
    hasMutedRowIcon(root) ? true : resolveMuteObservation(collectMuteLabels(root, false), unread),
  );
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
