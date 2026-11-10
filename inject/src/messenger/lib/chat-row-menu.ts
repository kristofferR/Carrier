// Pure logic for the chat-list row menu: which rows of a conversation's own
// "More options" menu Chatpane repeats on right-click, and in what order. The
// DOM driving lives in features/chat-row-menu.ts.

import { ancestors, type Fiber, propsOf, renders } from "./react-fiber";

// The rows in menu order, named by the string keys of their labels.
// Keep in sync with CHAT_ROW_CONTEXT_MENU_KEYS in src-tauri/src/menu.rs; a
// Rust test reads this declaration. Audio call and Video chat are left out:
// a call opens a popup window, which WebKit blocks without a user gesture,
// and a native menu's choice reaches the page without one.
export const CHAT_ROW_CONTEXT_MENU_KEYS = [
  "shared.context.mark_as_read",
  "shared.context.mark_as_unread",
  "shared.context.mute_notifications",
  "shared.context.unmute_notifications",
  "shared.context.view_profile",
  "shared.context.start_encrypted_chat",
  "shared.context.block",
  "shared.context.unblock",
  "shared.context.archive_chat",
  "shared.context.unarchive_chat",
  "shared.context.delete_chat",
  "shared.context.report",
  "shared.context.leave_group",
] as const;

export type ChatRowAction = (typeof CHAT_ROW_CONTEXT_MENU_KEYS)[number];

/** Each row's text in Messenger's English menu: the fallback when a row's
 * component isn't recognised (see {@link classifyChatRow}). */
const MESSENGER_ROW_TEXT: Record<ChatRowAction, string> = {
  "shared.context.mark_as_read": "Mark as read",
  "shared.context.mark_as_unread": "Mark as unread",
  "shared.context.mute_notifications": "Mute notifications",
  "shared.context.unmute_notifications": "Unmute notifications",
  "shared.context.view_profile": "View profile",
  "shared.context.start_encrypted_chat": "Start end-to-end encrypted chat",
  "shared.context.block": "Block",
  "shared.context.unblock": "Unblock",
  "shared.context.archive_chat": "Archive chat",
  "shared.context.unarchive_chat": "Unarchive chat",
  "shared.context.delete_chat": "Delete chat",
  "shared.context.report": "Report",
  "shared.context.leave_group": "Leave group",
};

/** The action a menu row offers, by its visible text; unknown rows are null. */
export function chatRowAction(text: string): ChatRowAction | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  return (
    CHAT_ROW_CONTEXT_MENU_KEYS.find((action) => MESSENGER_ROW_TEXT[action] === normalized) ?? null
  );
}

/** The known actions among a menu's rows, in Chatpane's menu order. */
export function chatRowActions(offered: Iterable<ChatRowAction | null>): ChatRowAction[] {
  const set = new Set(offered);
  return CHAT_ROW_CONTEXT_MENU_KEYS.filter((action) => set.has(action));
}

/**
 * The components behind the rows of Messenger's conversation menu
 * (MWThreadListHoverButtonDropdownMenu.react). Rows built from a plain menu
 * item are told apart by their icon.
 */
export interface ChatRowComponents {
  /** MAWMarkThreadAsReadMenuItem.react: Mark as read when `isUnread`, else unread. */
  markRead: unknown;
  /** MWV2ChatSettingsMute.react and MWV2ChatSettingsUnmute.react. */
  mute: unknown;
  unmute: unknown;
  /** MWV2ArchiveThreadMenuItem.react's Archive and Unarchive exports. */
  archive: unknown;
  unarchive: unknown;
  /** MWThreadListHoverButtonDropdownMenuDeleteThreadButton.react. */
  deleteChat: unknown;
  /** MWLSLeaveGroupMenuItem.react. */
  leaveGroup: unknown;
  /** MAWSecureConversationThreadListMenuItem.react, on chats that aren't encrypted. */
  startEncryptedChat: unknown;
  /** MWInboxInfoBlockMessages.react, whose row is Block or Unblock by the contact's state. */
  block: unknown;
  /** FDSMenu.react, where a row's own components end. */
  menu: unknown;
  /** Icons of rows without a component of their own. */
  viewProfileIcon: unknown;
  reportIcons: unknown[];
}

/** What a row offers: an action, or Block/Unblock for the given contact. */
export type ChatRowKind = ChatRowAction | { blockContact: unknown };

/**
 * The action behind a menu row, from the components that rendered it: the
 * same in every language. Null for rows Chatpane doesn't repeat (calls,
 * community rows) and for components it doesn't know.
 */
export function classifyChatRow(fiber: Fiber | null, c: ChatRowComponents): ChatRowKind | null {
  let icon: unknown;
  for (const node of ancestors(fiber)) {
    if (renders(node, c.menu)) break;
    const props = propsOf(node);
    // The nearest menu item with an icon carries the row's. Its inner base
    // component takes the rendered icon (iconNode) instead.
    if (icon === undefined && props.icon != null && "primaryText" in props) icon = props.icon;
    if (renders(node, c.markRead))
      return props.isUnread === true
        ? "shared.context.mark_as_read"
        : "shared.context.mark_as_unread";
    if (renders(node, c.mute)) return "shared.context.mute_notifications";
    if (renders(node, c.unmute)) return "shared.context.unmute_notifications";
    if (renders(node, c.archive)) return "shared.context.archive_chat";
    if (renders(node, c.unarchive)) return "shared.context.unarchive_chat";
    if (renders(node, c.deleteChat)) return "shared.context.delete_chat";
    if (renders(node, c.leaveGroup)) return "shared.context.leave_group";
    if (renders(node, c.startEncryptedChat)) return "shared.context.start_encrypted_chat";
    if (renders(node, c.block)) return { blockContact: props.contactId };
  }
  if (icon != null && icon === c.viewProfileIcon) return "shared.context.view_profile";
  if (icon != null && c.reportIcons.includes(icon)) return "shared.context.report";
  return null;
}

/** Messenger's LSContactBlockedByViewerStatus. */
const MESSAGE_BLOCKED = 1;
const FULLY_BLOCKED = 2;

/** Block or Unblock, as MWInboxInfoBlockMessages decides from the contact's row. */
export function blockAction(blockedByViewerStatus: number | null): ChatRowAction {
  return blockedByViewerStatus === MESSAGE_BLOCKED || blockedByViewerStatus === FULLY_BLOCKED
    ? "shared.context.unblock"
    : "shared.context.block";
}

/** Whether a row of `kind` performs `action`. */
export function rowPerforms(kind: ChatRowKind | null, action: ChatRowAction): boolean {
  if (kind === null) return false;
  if (typeof kind === "object")
    return action === "shared.context.block" || action === "shared.context.unblock";
  return kind === action;
}

// Chatpane's own rows, after Messenger's: export that conversation (Ref #371).
// Keep in sync with CHAT_EXPORT_CONTEXT_MENU_KEYS in src-tauri/src/menu.rs.
export const CHAT_EXPORT_CONTEXT_MENU_KEYS = [
  "shared.context.export_chat_html",
  "shared.context.export_chat_json",
] as const;
