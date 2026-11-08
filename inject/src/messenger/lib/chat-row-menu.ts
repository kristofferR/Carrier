// Pure logic for the chat-list row menu: which rows of a conversation's own
// "More options" menu Chatpane repeats on right-click, and in what order. The
// DOM driving lives in features/chat-row-menu.ts.

// Keep in sync with CHAT_ROW_CONTEXT_MENU_LABELS in src-tauri/src/menu.rs; a
// Rust test reads this declaration. Audio call and Video chat are left out:
// a call opens a popup window, which WebKit blocks without a user gesture,
// and a native menu's choice reaches the page without one.
export const CHAT_ROW_CONTEXT_MENU_LABELS = [
  "Mark as read",
  "Mark as unread",
  "Mute notifications",
  "Unmute notifications",
  "View profile",
  "Start end-to-end encrypted chat",
  "Block",
  "Unblock",
  "Archive chat",
  "Unarchive chat",
  "Delete chat",
  "Report",
  "Leave group",
] as const;

export type ChatRowAction = (typeof CHAT_ROW_CONTEXT_MENU_LABELS)[number];

/** The action a menu row offers, by its visible text; unknown rows are null. */
export function chatRowAction(text: string): ChatRowAction | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  return CHAT_ROW_CONTEXT_MENU_LABELS.find((action) => action === normalized) ?? null;
}

/** The known actions among a menu's row texts, in Chatpane's menu order. */
export function chatRowActions(texts: string[]): ChatRowAction[] {
  const offered = new Set(texts.map(chatRowAction));
  return CHAT_ROW_CONTEXT_MENU_LABELS.filter((action) => offered.has(action));
}

// Chatpane's own rows, after Messenger's: export that conversation (Ref #371).
// Keep in sync with CHAT_EXPORT_CONTEXT_MENU_LABELS in src-tauri/src/menu.rs.
export const CHAT_EXPORT_CONTEXT_MENU_LABELS = [
  "Export chat as HTML…",
  "Export chat as JSON…",
] as const;
