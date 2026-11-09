/* ------------------------ Message context menu ------------------------- */
// Right-clicking a message offers Messenger's own message actions: quick
// reactions, Reply, Forward, Pin, Unsend/Remove. Nothing is reimplemented:
// Chatpane reads what the message's hover toolbar offers and, when a row is
// chosen, presses the same toolbar button or menu row. Messenger mounts the
// toolbar only on hover, and its React and More menus are opened briefly while
// hidden (see hidden-menu.ts) to learn which reactions and actions this
// message has. Toolbar buttons are matched by English accessible labels (Reply
// also by its icon), reactions by their emoji, which is locale-independent.

import { t } from "../../i18n";
import { diag, toast } from "../bridge";
import {
  type DrivenAction,
  type MessageOffer,
  menuRowAction,
  messageNodeText,
  type Reaction,
  toolbarAction,
  uniqueReactions,
} from "../lib/message-menu";
import { waitFor, withHiddenMenu } from "./hidden-menu";

// The message cell. Its role description is translated; its message id is not.
const MESSAGE = '[data-message-id], [aria-roledescription="message"]';
const TOOLBAR_WAIT_MS = 600;
const MAX_REACTIONS = 12;

export const messageFor = (target: Element) => target.closest<HTMLElement>(MESSAGE);

const toolbarButton = (message: HTMLElement, label: "React" | "More") =>
  message.querySelector<HTMLElement>(`[role="toolbar"] [role="button"][aria-label^="${label}"]`);

/** Mount the message's hover toolbar. A pointer right-click already hovers
 * it; a keyboard-opened menu or a later action needs a synthetic hover. */
async function ensureToolbar(message: HTMLElement): Promise<boolean> {
  const mounted = () => message.querySelector('[role="toolbar"] [role="button"][aria-label]');
  if (mounted()) return true;
  const rect = message.getBoundingClientRect();
  const point = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + 4 };
  message.dispatchEvent(new MouseEvent("mouseover", point));
  message.dispatchEvent(new MouseEvent("mousemove", point));
  return (await waitFor(mounted, TOOLBAR_WAIT_MS)) !== null;
}

const reactionRows = (menu: Element) =>
  menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]');

const reactionEmoji = (row: Element) =>
  (row.querySelector("img[alt]")?.getAttribute("alt") || row.textContent || "").trim();

const moreRows = (menu: Element) => menu.querySelectorAll<HTMLElement>('[role="menuitem"]');

/** The message's own text block. A reply's quoted message renders first, so
 * the last block is the message itself. */
export function messageTextBlock(message: HTMLElement): HTMLElement | null {
  const blocks = [
    ...message.querySelectorAll<HTMLElement>('span[dir="auto"] > div[dir="auto"]'),
  ].filter((block) => !block.closest('[role="toolbar"]'));
  return blocks[blocks.length - 1] ?? null;
}

export function messageText(message: HTMLElement): string {
  const block = messageTextBlock(message);
  return block ? messageNodeText(block).trim() : "";
}

/** Toolbar buttons that perform a message action directly. */
function toolbarActions(message: HTMLElement): [DrivenAction, HTMLElement][] {
  const found: [DrivenAction, HTMLElement][] = [];
  for (const button of message.querySelectorAll<HTMLElement>(
    '[role="toolbar"] [role="button"][aria-label]',
  )) {
    const action = toolbarAction(
      button.getAttribute("aria-label") ?? "",
      button.querySelector("svg path")?.getAttribute("d") ?? "",
    );
    if (action) found.push([action, button]);
  }
  return found;
}

/** What Messenger offers for this message right now. */
export async function readMessageOffer(message: HTMLElement): Promise<MessageOffer> {
  const text = messageText(message);
  if (!(await ensureToolbar(message))) return { reactions: [], text, actions: [] };
  const react = toolbarButton(message, "React");
  const reactions: Reaction[] = react
    ? ((await withHiddenMenu(react, (menu) =>
        [...reactionRows(menu)].map((row) => ({
          emoji: reactionEmoji(row),
          checked: row.getAttribute("aria-checked") === "true",
        })),
      )) ?? [])
    : [];
  const actions = toolbarActions(message).map(([action]) => action);
  const more = toolbarButton(message, "More");
  if (more)
    actions.push(
      ...((await withHiddenMenu(more, (menu) =>
        [...moreRows(menu)]
          .map((row) => menuRowAction(row.textContent ?? ""))
          .filter((action): action is DrivenAction => action !== null),
      )) ?? []),
    );
  return { reactions: uniqueReactions(reactions).slice(0, MAX_REACTIONS), text, actions };
}

/** Press the toolbar control behind a chosen menu row. */
async function drive(message: HTMLElement, run: () => Promise<boolean>, what: string) {
  if (!message.isConnected) {
    toast(t("page.context.message_gone"));
    return;
  }
  if (await run()) return;
  diag("message-menu.action", `${what} was not offered when chosen`);
  toast(t("page.context.action_unavailable"));
}

export const reactTo = (message: HTMLElement, emoji: string) =>
  drive(
    message,
    async () => {
      const react = (await ensureToolbar(message)) ? toolbarButton(message, "React") : null;
      if (!react) return false;
      const picked = await withHiddenMenu(
        react,
        (menu) => {
          const row = [...reactionRows(menu)].find((item) => reactionEmoji(item) === emoji);
          row?.click();
          return row !== undefined;
        },
        true,
      );
      return picked === true;
    },
    "reaction",
  );

/** Press an action's control wherever Messenger put it: a toolbar button,
 * or a row in the toolbar's More menu. False when the message doesn't offer it. */
export async function pressMessageAction(
  message: HTMLElement,
  action: DrivenAction,
): Promise<boolean> {
  if (!(await ensureToolbar(message))) return false;
  const button = toolbarActions(message).find(([offered]) => offered === action)?.[1];
  if (button) {
    button.click();
    return true;
  }
  const more = toolbarButton(message, "More");
  if (!more) return false;
  const picked = await withHiddenMenu(
    more,
    (menu) => {
      const row = [...moreRows(menu)].find(
        (item) => menuRowAction(item.textContent ?? "") === action,
      );
      row?.click();
      return row !== undefined;
    },
    true,
  );
  return picked === true;
}

export const runMessageAction = (message: HTMLElement, action: DrivenAction) =>
  drive(message, () => pressMessageAction(message, action), action);
