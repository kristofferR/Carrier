/* ------------------------ Message context menu ------------------------- */
// Right-clicking a message offers Messenger's own message actions: quick
// reactions, Reply, Forward, Pin, Unsend/Remove. Nothing is reimplemented:
// Carrier reads what the message's hover toolbar offers and, when a row is
// chosen, presses the same toolbar button or menu row. Messenger mounts the
// toolbar only on hover, and its React and More menus are opened briefly while
// hidden (data-carrier-message-menu-probe, see messenger.css) to learn which
// reactions and actions this message has. Toolbar buttons are matched by
// English accessible labels, reactions by their emoji, which is
// locale-independent.

import { diag, toast } from "../bridge";
import {
  type DrivenAction,
  type MessageOffer,
  menuRowAction,
  type Reaction,
  toolbarAction,
  uniqueReactions,
} from "../lib/message-menu";

const MESSAGE = '[aria-roledescription="message"]';
const PROBE_ATTRIBUTE = "data-carrier-message-menu-probe";
const POLL_MS = 16;
const TOOLBAR_WAIT_MS = 600;
const MENU_WAIT_MS = 800;
const MAX_REACTIONS = 12;

export const messageFor = (target: Element) => target.closest<HTMLElement>(MESSAGE);

const toolbarButton = (message: HTMLElement, label: "React" | "More") =>
  message.querySelector<HTMLElement>(`[role="toolbar"] [role="button"][aria-label^="${label}"]`);

async function waitFor<T>(read: () => T | null | undefined, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (true) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

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

const expanded = (button: HTMLElement) => button.getAttribute("aria-expanded") === "true";

/** The newest open menu that has rows; Messenger nests a labelled menu
 * inside an unlabelled one, and the inner one comes last. */
function openMenu(): Element | null {
  const menus = document.querySelectorAll('[role="menu"]');
  for (let index = menus.length - 1; index >= 0; index -= 1) {
    const menu = menus[index];
    if (menu?.querySelector('[role^="menuitem"]')) return menu;
  }
  return null;
}

/**
 * Open a toolbar menu hidden, hand it to `use`, and close it again unless
 * `use` picked a row (which closes it). Focus returns to where it was.
 */
async function withHiddenMenu<T>(
  button: HTMLElement,
  use: (menu: Element) => T,
  picks = false,
): Promise<T | null> {
  const root = document.documentElement;
  const focused = document.activeElement;
  root.setAttribute(PROBE_ATTRIBUTE, "");
  try {
    if (!expanded(button)) button.click();
    const menu = await waitFor(() => (expanded(button) ? openMenu() : null), MENU_WAIT_MS);
    if (!menu) return null;
    const result = use(menu);
    if (picks && result) await waitFor(() => !expanded(button), MENU_WAIT_MS);
    return result;
  } finally {
    if (expanded(button)) {
      button.click();
      await waitFor(() => !expanded(button), MENU_WAIT_MS);
    }
    root.removeAttribute(PROBE_ATTRIBUTE);
    if (!picks && focused instanceof HTMLElement && focused.isConnected)
      focused.focus({ preventScroll: true });
  }
}

const reactionRows = (menu: Element) =>
  menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]');

const reactionEmoji = (row: Element) =>
  (row.querySelector("img[alt]")?.getAttribute("alt") || row.textContent || "").trim();

const moreRows = (menu: Element) => menu.querySelectorAll<HTMLElement>('[role="menuitem"]');

/** Text with Messenger's emoji images read back as their characters. */
function readableText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (node.tagName === "IMG") return node.getAttribute("alt") ?? "";
  if (node.tagName === "BR") return "\n";
  let text = "";
  for (const child of node.childNodes) {
    const part = readableText(child);
    // Messenger renders each line of a multi-line message as its own block.
    if (part && text && child instanceof HTMLDivElement && !text.endsWith("\n")) text += "\n";
    text += part;
  }
  return text;
}

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
  return block ? readableText(block).trim() : "";
}

/** Toolbar buttons that perform a message action directly. */
function toolbarActions(message: HTMLElement): [DrivenAction, HTMLElement][] {
  const found: [DrivenAction, HTMLElement][] = [];
  for (const button of message.querySelectorAll<HTMLElement>(
    '[role="toolbar"] [role="button"][aria-label]',
  )) {
    const action = toolbarAction(button.getAttribute("aria-label") ?? "");
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
    toast("That message is no longer on screen");
    return;
  }
  if (await run()) return;
  diag("message-menu.action", `${what} was not offered when chosen`);
  toast("Messenger no longer offers that action");
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

/** Run an action from wherever Messenger put it: a toolbar button, or a row
 * in the toolbar's More menu. */
export const runMessageAction = (message: HTMLElement, action: DrivenAction) =>
  drive(
    message,
    async () => {
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
    },
    action,
  );
