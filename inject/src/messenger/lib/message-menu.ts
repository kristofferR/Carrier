// Pure logic for the message context menu: which of Messenger's hover-toolbar
// actions a message offers, in what order, and where a keyboard-opened menu
// pops up. The DOM driving lives in features/message-menu.ts.

// Keep in sync with MESSAGE_CONTEXT_MENU_LABELS in src-tauri/src/menu.rs; a
// Rust test reads this declaration.
export const MESSAGE_CONTEXT_MENU_LABELS = [
  "Reply",
  "Copy text",
  "Edit",
  "Forward",
  "Pin",
  "Unpin",
  "Unsend",
  "Remove",
] as const;

export type MessageAction = (typeof MESSAGE_CONTEXT_MENU_LABELS)[number];

/** Actions driven through Messenger's own controls. */
export type DrivenAction = Exclude<MessageAction, "Copy text">;

const DRIVEN_ACTIONS = MESSAGE_CONTEXT_MENU_LABELS.filter(
  (action): action is DrivenAction => action !== "Copy text",
);

/** The action a "More actions" row offers, by its visible text. Report and
 * anything unknown are left out. */
export function menuRowAction(text: string): DrivenAction | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  return DRIVEN_ACTIONS.find((action) => action === normalized) ?? null;
}

/** The action a hover-toolbar button performs, by its accessible label.
 * Text messages show "Reply to this message"; media messages show "Forward"
 * there and move Reply into More. */
export function toolbarAction(label: string): DrivenAction | null {
  if (/^Reply\b/.test(label)) return "Reply";
  if (/^Forward\b/.test(label)) return "Forward";
  return null;
}

export interface Reaction {
  emoji: string;
  /** Already the user's reaction to this message. */
  checked: boolean;
}

export interface MessageOffer {
  reactions: Reaction[];
  /** The message's text, when it has any. */
  text: string;
  /** What the toolbar and its More menu offer. */
  actions: DrivenAction[];
}

/** The message actions to show, in menu order. */
export function messageActions(offer: MessageOffer): MessageAction[] {
  return MESSAGE_CONTEXT_MENU_LABELS.filter((action) =>
    action === "Copy text" ? offer.text.length > 0 : offer.actions.includes(action),
  );
}

/** Text-style symbols such as ❤ get the emoji presentation selector so a
 * native menu draws them in color, as Messenger does. */
export function reactionLabel(emoji: string): string {
  const codePoints = [...emoji];
  const first = codePoints[0]?.codePointAt(0) ?? 0;
  return codePoints.length === 1 && first >= 0x2000 && first < 0x3300 ? `${emoji}\uFE0F` : emoji;
}

/** Messenger's reaction row may repeat an emoji or carry an empty image;
 * keep the first of each. */
export function uniqueReactions(reactions: Reaction[]): Reaction[] {
  const seen = new Set<string>();
  return reactions.filter(({ emoji }) => {
    if (!emoji || seen.has(emoji)) return false;
    seen.add(emoji);
    return true;
  });
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A context-menu key or Shift+F10 reports no pointer inside the target, so
 * its menu pops up at the message instead of wherever the cursor is.
 * Returns that point, or null for a pointer-opened menu.
 */
export function keyboardMenuPoint(
  point: { x: number; y: number },
  target: Rect,
  anchor: Rect,
): [number, number] | null {
  const inside =
    point.x >= target.x &&
    point.x <= target.x + target.width &&
    point.y >= target.y &&
    point.y <= target.y + target.height;
  if (inside && (point.x !== 0 || point.y !== 0)) return null;
  return [Math.max(0, Math.round(anchor.x)), Math.max(0, Math.round(anchor.y + anchor.height))];
}
