// Pure logic for the message context menu: which of Messenger's hover-toolbar
// actions a message offers, in what order, and where a keyboard-opened menu
// pops up. The DOM driving lives in features/message-menu.ts.

import type { ConversationTextNode } from "./conversation-row";
import { SYSTEM_EMOJI_GLYPH_ATTR } from "./emoji";
import { ancestors, type Fiber, propsOf, renders } from "./react-fiber";

// The message actions in menu order, named by the string keys of their labels.
// Keep in sync with MESSAGE_CONTEXT_MENU_KEYS in src-tauri/src/menu.rs; a
// Rust test reads this declaration.
export const MESSAGE_CONTEXT_MENU_KEYS = [
  "shared.context.reply",
  "shared.context.copy_text",
  "shared.context.edit",
  "shared.context.forward",
  "shared.context.pin",
  "shared.context.unpin",
  "shared.context.unsend",
  "shared.context.remove",
] as const;

export type MessageAction = (typeof MESSAGE_CONTEXT_MENU_KEYS)[number];

const COPY_TEXT = "shared.context.copy_text" satisfies MessageAction;

/** Actions driven through Messenger's own controls. */
export type DrivenAction = Exclude<MessageAction, typeof COPY_TEXT>;

/** Each driven action's row text in Messenger's English More menu: the
 * fallback when a row's component isn't recognised (see {@link classifyMoreRow}). */
const MESSENGER_ROW_TEXT: Record<DrivenAction, string> = {
  "shared.context.reply": "Reply",
  "shared.context.edit": "Edit",
  "shared.context.forward": "Forward",
  "shared.context.pin": "Pin",
  "shared.context.unpin": "Unpin",
  "shared.context.unsend": "Unsend",
  "shared.context.remove": "Remove",
};

const DRIVEN_ACTIONS = MESSAGE_CONTEXT_MENU_KEYS.filter(
  (action): action is DrivenAction => action !== COPY_TEXT,
);

/** The action a "More actions" row offers, by its visible text. Report and
 * anything unknown are left out. */
export function menuRowAction(text: string): DrivenAction | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  return DRIVEN_ACTIONS.find((action) => MESSENGER_ROW_TEXT[action] === normalized) ?? null;
}

/** The path of the Reply button's icon (Messenger's FBNucleusReplyFilled16Icon),
 * which marks the button in every language. */
export const REPLY_ICON_PATH =
  "M6.497 1.035C7.593-.088 9.5.688 9.5 2.257V4.54c1.923.215 3.49 1.246 4.593 2.672C15.328 8.808 16 10.91 16 13v.305c0 .632-.465 1.017-.893 1.127-.422.11-.99.005-1.318-.493-.59-.894-1.2-1.482-1.951-1.859-.611-.307-1.359-.496-2.338-.558v2.23c0 1.57-1.908 2.346-3.003 1.222L.893 9.223a1.75 1.75 0 0 1 .001-2.444l5.603-5.744z";

/** The action a hover-toolbar button performs, by its icon or its English
 * accessible label: the fallback for {@link classifyToolbarButton}. Text
 * messages show "Reply to this message"; media messages show "Forward" there
 * and move Reply into More. */
export function toolbarAction(label: string, iconPath = ""): DrivenAction | null {
  if (iconPath === REPLY_ICON_PATH || /^Reply\b/.test(label)) return "shared.context.reply";
  if (/^Forward\b/.test(label)) return "shared.context.forward";
  return null;
}

/**
 * The components behind a message's hover toolbar (MWMessageRowActions.react)
 * and its More menu (MWV2ContextualActionsMenu.react).
 */
export interface MessageMenuComponents {
  reactButton: unknown;
  replyButton: unknown;
  forwardButton: unknown;
  moreButton: unknown;
  replyRow: unknown;
  editRow: unknown;
  forwardRow: unknown;
  /** MWPinMessageMenuItem.react: Pin or Unpin by the message's pinned state. */
  pinRow: unknown;
  /** MWV2RemoveMenuItem.react: Unsend for your own messages Messenger lets you
   * remove for everyone, else Remove. */
  removeRow: unknown;
  /** Where a More row's own components end. */
  menu: unknown;
}

/** A toolbar button: one opening the React or More menu, or an action. */
export type ToolbarKind = "react" | "more" | DrivenAction;

/** The toolbar button's job, from the component that rendered it: the same in every language. */
export function classifyToolbarButton(
  fiber: Fiber | null,
  c: MessageMenuComponents,
): ToolbarKind | null {
  for (const node of ancestors(fiber, 30)) {
    if (renders(node, c.reactButton)) return "react";
    if (renders(node, c.moreButton)) return "more";
    if (renders(node, c.replyButton)) return "shared.context.reply";
    if (renders(node, c.forwardButton)) return "shared.context.forward";
  }
  return null;
}

/** What a More row offers: an action, or Pin/Unpin for the given message. */
export type MoreRowKind = DrivenAction | { pinMessage: unknown };

/**
 * The action behind a More row, from the components that rendered it. Report
 * rows and unknown components are null. `isOwn` tells whether a sender id is
 * the signed-in account.
 */
export function classifyMoreRow(
  fiber: Fiber | null,
  c: MessageMenuComponents,
  isOwn: (senderId: unknown) => boolean,
): MoreRowKind | null {
  for (const node of ancestors(fiber)) {
    if (renders(node, c.menu)) break;
    const props = propsOf(node);
    if (renders(node, c.replyRow)) return "shared.context.reply";
    if (renders(node, c.editRow)) return "shared.context.edit";
    if (renders(node, c.forwardRow)) return "shared.context.forward";
    if (renders(node, c.pinRow)) return { pinMessage: props.message };
    if (renders(node, c.removeRow)) {
      const sender = (props.message as { senderId?: unknown } | null | undefined)?.senderId;
      return props.canRemoveMessageGlobally === true && isOwn(sender)
        ? "shared.context.unsend"
        : "shared.context.remove";
    }
  }
  return null;
}

export const pinAction = (pinned: boolean): DrivenAction =>
  pinned ? "shared.context.unpin" : "shared.context.pin";

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
  return MESSAGE_CONTEXT_MENU_KEYS.filter((action) =>
    action === COPY_TEXT ? offer.text.length > 0 : offer.actions.includes(action),
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

/**
 * A message's text with Messenger's emoji images read back as their
 * characters. Chatpane's own System emoji glyph spans are skipped, since the
 * image beside each one already contributes the character. Messenger renders
 * each line of a multi-line message as its own block.
 */
export function messageNodeText(node: ConversationTextNode | null | undefined): string {
  if (!node) return "";
  if (node.nodeType === 3) return node.nodeValue || "";
  if (node.nodeType !== 1) return "";
  if (node.getAttribute?.(SYSTEM_EMOJI_GLYPH_ATTR) != null) return "";
  const tag = (node.tagName || "").toUpperCase();
  if (tag === "IMG") return node.getAttribute?.("alt") || "";
  if (tag === "BR") return "\n";
  let text = "";
  for (const child of Array.from(node.childNodes || [])) {
    const part = messageNodeText(child);
    const block = (child.tagName || "").toUpperCase() === "DIV";
    if (part && text && block && !text.endsWith("\n")) text += "\n";
    text += part;
  }
  return text;
}
