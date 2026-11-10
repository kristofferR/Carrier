/* ----------------------- Chat-list row menu ---------------------------- */
// Right-clicking a conversation in the chat list offers that conversation's
// own "More options" menu (Mark as unread, Mute, Archive, Delete, ...) in
// place of the link's menu. Nothing is reimplemented: Chatpane opens the row's menu
// hidden (see hidden-menu.ts) to read which rows it offers, and presses the
// same row when one is chosen. Rows are recognised by the Messenger component
// that rendered them, so this works in every language; English row text is
// the fallback when a component isn't recognised.

import { t } from "../../i18n";
import { diag, toast } from "../bridge";
import {
  blockAction,
  type ChatRowAction,
  type ChatRowComponents,
  type ChatRowKind,
  chatRowAction,
  chatRowActions,
  classifyChatRow,
  rowPerforms,
} from "../lib/chat-row-menu";
import { pageRequire } from "../lib/facebook-loader";
import { fiberOf, moduleExport } from "../lib/react-fiber";
import { withHiddenMenu } from "./hidden-menu";

// Every row carries one menu button, in a gridcell beside the row's link.
const rowMenuButton = (link: Element) => {
  const row = link.closest('[role="row"]');
  const linkCell = link.closest('[role="gridcell"]');
  for (const button of row?.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]') ?? [])
    if (button.closest('[role="gridcell"]') !== linkCell) return button;
  return null;
};

/** The conversation link of a chat-list row with a menu, or null. */
export function chatRowFor(anchor: HTMLAnchorElement): HTMLAnchorElement | null {
  return anchor.getAttribute("href")?.includes("/t/") && rowMenuButton(anchor) ? anchor : null;
}

const menuRows = (menu: Element) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];

/** The components behind the menu's rows, read now: the menu's code loads with it. */
function chatRowComponents(): ChatRowComponents {
  const load = pageRequire();
  const icons = moduleExport(load, "MWThreadListHoverButtonDropdownMenuIcons") as
    | Record<string, unknown>
    | undefined;
  const archive = "MWV2ArchiveThreadMenuItem.react";
  return {
    markRead: moduleExport(load, "MAWMarkThreadAsReadMenuItem.react"),
    mute: moduleExport(load, "MWV2ChatSettingsMute.react"),
    unmute: moduleExport(load, "MWV2ChatSettingsUnmute.react"),
    archive: moduleExport(load, archive, "MWV2ArchiveThreadMenuItemArchive"),
    unarchive: moduleExport(load, archive, "MWV2ArchiveThreadMenuItemUnarchive"),
    deleteChat: moduleExport(load, "MWThreadListHoverButtonDropdownMenuDeleteThreadButton.react"),
    leaveGroup: moduleExport(load, "MWLSLeaveGroupMenuItem.react"),
    block: moduleExport(load, "MWInboxInfoBlockMessages.react"),
    menu: moduleExport(load, "FDSMenu.react"),
    viewProfileIcon: icons?.ViewProfile,
    reportIcons: [
      moduleExport(load, "FBNucleusCautionTriangleOutline20Icon.react"),
      icons?.SomethingIsWrong,
      icons?.Report,
    ].filter((icon) => icon != null),
  };
}

/** What each row of an open menu offers, with its English text as the fallback. */
function rowKinds(menu: Element): [HTMLElement, ChatRowKind | null][] {
  const components = chatRowComponents();
  const load = pageRequire();
  return menuRows(menu).map((row) => [
    row,
    classifyChatRow(fiberOf(row, load), components) ?? chatRowAction(row.textContent ?? ""),
  ]);
}

interface ContactRow {
  blockedByViewerStatus?: unknown;
}

/** The contact's block state from Messenger's database, as its Block row reads it. */
async function contactBlockStatus(contactId: unknown): Promise<number | null> {
  try {
    const load = pageRequire();
    const singleton = load?.("LSDatabaseSingleton") as {
      LSDatabaseSingleton?: Promise<{
        tables?: { contacts?: { get(key: unknown): Promise<unknown> } };
      }>;
    };
    const db = await singleton?.LSDatabaseSingleton;
    const intEnum = load?.("LSIntEnum") as { toNumber?(value: unknown): number } | undefined;
    const contact = (await db?.tables?.contacts?.get(contactId)) as ContactRow | null | undefined;
    const status = contact?.blockedByViewerStatus;
    return status == null || typeof intEnum?.toNumber !== "function"
      ? null
      : intEnum.toNumber(status);
  } catch {
    return null;
  }
}

/** What the row's menu offers right now, in Chatpane's menu order. */
export async function readChatRowActions(link: HTMLAnchorElement): Promise<ChatRowAction[]> {
  const button = rowMenuButton(link);
  if (!button) return [];
  const kinds =
    (await withHiddenMenu(button, (menu) => rowKinds(menu).map(([, kind]) => kind))) ?? [];
  const offered = await Promise.all(
    kinds.map(async (kind) =>
      kind !== null && typeof kind === "object"
        ? blockAction(await contactBlockStatus(kind.blockContact))
        : kind,
    ),
  );
  return chatRowActions(offered);
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
      const row = rowKinds(menu).find(([, kind]) => rowPerforms(kind, action))?.[0];
      row?.click();
      return row !== undefined;
    },
    true,
  );
  if (picked) return;
  diag("chat-row-menu.action", `${action} was not offered when chosen`);
  toast(t("page.context.action_unavailable"));
}
