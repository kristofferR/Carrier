/* ----------------------- Chat-list row menu ---------------------------- */
// Right-clicking a conversation in the chat list offers that conversation's
// own "More options" menu (Mark as unread, Mute, Archive, Delete, ...) in
// place of the link's menu. Nothing is reimplemented: Chatpane opens the row's menu
// hidden (see hidden-menu.ts) to read which rows it offers, and presses the
// same row when one is chosen. Rows are matched by their English text.

import { t } from "../../i18n";
import { diag, toast } from "../bridge";
import { type ChatRowAction, chatRowAction, chatRowActions } from "../lib/chat-row-menu";
import { withHiddenMenu } from "./hidden-menu";

// Every row carries this button, in a gridcell beside the row's link.
const ROW_MENU_BUTTON = '[aria-haspopup="menu"][aria-label^="More options for "]';

const rowMenuButton = (link: Element) =>
  link.closest('[role="row"]')?.querySelector<HTMLElement>(ROW_MENU_BUTTON) ?? null;

/** The conversation link of a chat-list row with a menu, or null. */
export function chatRowFor(anchor: HTMLAnchorElement): HTMLAnchorElement | null {
  return anchor.getAttribute("href")?.includes("/t/") && rowMenuButton(anchor) ? anchor : null;
}

const menuRows = (menu: Element) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];

/** What the row's menu offers right now, in Chatpane's menu order. */
export async function readChatRowActions(link: HTMLAnchorElement): Promise<ChatRowAction[]> {
  const button = rowMenuButton(link);
  if (!button) return [];
  return (
    (await withHiddenMenu(button, (menu) =>
      chatRowActions(menuRows(menu).map((row) => row.textContent ?? "")),
    )) ?? []
  );
}

/** The row's current menu button. The chat list recycles row elements as it
 * reorders, so the conversation is found again by its link. */
function currentMenuButton(href: string): HTMLElement | null {
  for (const link of document.querySelectorAll('[role="row"] a[href]'))
    if (link.getAttribute("href") === href) return rowMenuButton(link);
  return null;
}

/** Press the row of the conversation's menu behind a chosen action. */
export async function runChatRowAction(href: string, action: ChatRowAction) {
  const button = currentMenuButton(href);
  if (!button) {
    toast(t("page.context.conversation_gone"));
    return;
  }
  const picked = await withHiddenMenu(
    button,
    (menu) => {
      const row = menuRows(menu).find((item) => chatRowAction(item.textContent ?? "") === action);
      row?.click();
      return row !== undefined;
    },
    true,
  );
  if (picked) return;
  diag("chat-row-menu.action", `${action} was not offered when chosen`);
  toast(t("page.context.action_unavailable"));
}
