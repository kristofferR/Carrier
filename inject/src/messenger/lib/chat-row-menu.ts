// Pure logic for the chat-list row menu: which rows of a conversation's own
// "More options" menu Chatpane repeats on right-click, and in what order, plus
// Chatpane's own rows. The DOM driving lives in features/chat-row-menu.ts.

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

/** Each row's text in Messenger's (English) menu, which finds the row. */
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

/** The known actions among a menu's row texts, in Chatpane's menu order. */
export function chatRowActions(texts: string[]): ChatRowAction[] {
  const offered = new Set(texts.map(chatRowAction));
  return CHAT_ROW_CONTEXT_MENU_KEYS.filter((action) => offered.has(action));
}

// Chatpane's own first row: pin or unpin the chat (Ref #457).
// Keep in sync with CHAT_PIN_CONTEXT_MENU_KEYS in src-tauri/src/menu.rs.
export const CHAT_PIN_CONTEXT_MENU_KEYS = [
  "shared.context.pin_chat",
  "shared.context.unpin_chat",
] as const;

// Chatpane's own rows, after Messenger's: export that conversation (Ref #371).
// Keep in sync with CHAT_EXPORT_CONTEXT_MENU_KEYS in src-tauri/src/menu.rs.
export const CHAT_EXPORT_CONTEXT_MENU_KEYS = [
  "shared.context.export_chat_html",
  "shared.context.export_chat_json",
] as const;
