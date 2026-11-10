/* ------------------------ Message context menu ------------------------- */
// Right-clicking a message offers Messenger's own message actions: quick
// reactions, Reply, Forward, Pin, Unsend/Remove. Nothing is reimplemented:
// Chatpane reads what the message's hover toolbar offers and, when a row is
// chosen, presses the same toolbar button or menu row. Messenger mounts the
// toolbar only on hover, and its React and More menus are opened briefly while
// hidden (see hidden-menu.ts) to learn which reactions and actions this
// message has. Toolbar buttons and More rows are recognised by the Messenger
// component that rendered them, the same in every language, with English
// labels (and Reply's icon) as the fallback; reactions by their emoji.

import { t } from "../../i18n";
import { diag, toast } from "../bridge";
import { pageRequire } from "../lib/facebook-loader";
import {
  classifyMoreRow,
  classifyToolbarButton,
  type DrivenAction,
  type MessageMenuComponents,
  type MessageOffer,
  type MoreRowKind,
  menuRowAction,
  messageNodeText,
  pinAction,
  type Reaction,
  type ToolbarKind,
  toolbarAction,
  uniqueReactions,
} from "../lib/message-menu";
import { fiberOf, moduleExport } from "../lib/react-fiber";
import { accountId } from "../lib/threads";
import { waitFor, withHiddenMenu } from "./hidden-menu";

// The message cell, by its message id: its role description is translated.
const MESSAGE = "[data-message-id]";
const TOOLBAR_WAIT_MS = 600;
const MAX_REACTIONS = 12;

export const messageFor = (target: Element) => target.closest<HTMLElement>(MESSAGE);

/** The components behind the toolbar and its More menu; their code is loaded with them. */
function messageMenuComponents(): MessageMenuComponents {
  const load = pageRequire();
  const get = (name: string) => moduleExport(load, name);
  return {
    reactButton: get("MWV2MessageReactionButton.react"),
    replyButton: get("MWV2ReplyButton.react"),
    forwardButton: get("MWV2ForwardMessageButton.react"),
    moreButton: get("MWV2ContextualActionsButton.react"),
    replyRow: get("MWV2ReplyMenuItem.react"),
    editRow: get("MAWEditMenuItem.react"),
    forwardRow: get("MWV2ForwardMenuItem.react"),
    pinRow: get("MWPinMessageMenuItem.react"),
    removeRow: get("MWV2RemoveMenuItem.react"),
    menu: get("MWV2ContextualActionsMenu.react"),
  };
}

/** Each toolbar button with its job: by component, else by English label or icon. */
function toolbarButtons(message: HTMLElement): [HTMLElement, ToolbarKind | null][] {
  const components = messageMenuComponents();
  const load = pageRequire();
  return [
    ...message.querySelectorAll<HTMLElement>('[role="toolbar"] [role="button"][aria-label]'),
  ].map((button) => {
    const kind = classifyToolbarButton(fiberOf(button, load), components);
    if (kind) return [button, kind];
    const label = button.getAttribute("aria-label") ?? "";
    if (/^React\b/.test(label)) return [button, "react"];
    if (/^More\b/.test(label)) return [button, "more"];
    return [
      button,
      toolbarAction(label, button.querySelector("svg path")?.getAttribute("d") ?? ""),
    ];
  });
}

const toolbarButton = (message: HTMLElement, kind: "react" | "more") =>
  toolbarButtons(message).find(([, found]) => found === kind)?.[0] ?? null;

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

/** Whether a message's sender is the signed-in account. */
function isOwnSender(senderId: unknown): boolean {
  const account = accountId(document.cookie);
  try {
    const i64 = pageRequire()?.("I64") as { to_string?(value: unknown): unknown } | undefined;
    return account !== null && senderId != null && String(i64?.to_string?.(senderId)) === account;
  } catch {
    return false;
  }
}

/** Each More row with what it offers: by component, else by English text. */
function moreRowKinds(menu: Element): [HTMLElement, MoreRowKind | null][] {
  const components = messageMenuComponents();
  const load = pageRequire();
  return [...moreRows(menu)].map((row) => [
    row,
    classifyMoreRow(fiberOf(row, load), components, isOwnSender) ??
      menuRowAction(row.textContent ?? ""),
  ]);
}

interface PinnedMessage {
  threadKey?: unknown;
  messageId?: unknown;
  offlineThreadingId?: unknown;
  isUnsent?: unknown;
}

/** Whether a message is pinned, read as useMWPIsMessagePinned does. Null when unknown. */
async function isPinned(message: unknown): Promise<boolean | null> {
  try {
    const load = pageRequire();
    const m = message as PinnedMessage | null;
    const ReQL = load?.("ReQL") as {
      fromTableAscending(table: unknown): { getKeyRange(...key: unknown[]): unknown };
      firstAsync(query: unknown): Promise<unknown>;
    };
    const singleton = load?.("LSDatabaseSingleton") as {
      LSDatabaseSingleton?: Promise<{ tables: Record<string, unknown> }>;
    };
    const db = await singleton?.LSDatabaseSingleton;
    if (!m || !db || typeof ReQL?.firstAsync !== "function") return null;
    const first = (table: string, ...key: unknown[]) =>
      ReQL.firstAsync(ReQL.fromTableAscending(db.tables[table]).getKeyRange(...key));
    if (await first("msg_pinned_messages_v2", m.threadKey, m.messageId)) return true;
    if (m.isUnsent) return false;
    return !!(await first("client_web_pinned_messages", m.threadKey, m.offlineThreadingId));
  } catch {
    return null;
  }
}

/** The action a More row offers; a Pin row's follows the message's current
 * pinned state, and is null while that is unknown. */
async function offeredMoreAction(kind: MoreRowKind | null): Promise<DrivenAction | null> {
  if (kind === null || typeof kind !== "object") return kind;
  const pinned = await isPinned(kind.pinMessage);
  return pinned === null ? null : pinAction(pinned);
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
  return block ? messageNodeText(block).trim() : "";
}

/** Toolbar buttons that perform a message action directly. */
function toolbarActions(message: HTMLElement): [DrivenAction, HTMLElement][] {
  const found: [DrivenAction, HTMLElement][] = [];
  for (const [button, kind] of toolbarButtons(message))
    if (kind && kind !== "react" && kind !== "more") found.push([kind, button]);
  return found;
}

/** What Messenger offers for this message right now. */
export async function readMessageOffer(message: HTMLElement): Promise<MessageOffer> {
  const text = messageText(message);
  if (!(await ensureToolbar(message))) return { reactions: [], text, actions: [] };
  const react = toolbarButton(message, "react");
  const reactions: Reaction[] = react
    ? ((await withHiddenMenu(react, (menu) =>
        [...reactionRows(menu)].map((row) => ({
          emoji: reactionEmoji(row),
          checked: row.getAttribute("aria-checked") === "true",
        })),
      )) ?? [])
    : [];
  const actions = toolbarActions(message).map(([action]) => action);
  const more = toolbarButton(message, "more");
  if (more) {
    const kinds =
      (await withHiddenMenu(more, (menu) => moreRowKinds(menu).map(([, kind]) => kind))) ?? [];
    for (const kind of kinds) {
      const action = await offeredMoreAction(kind);
      if (action !== null) actions.push(action);
    }
  }
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
      const react = (await ensureToolbar(message)) ? toolbarButton(message, "react") : null;
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
  const more = toolbarButton(message, "more");
  if (!more) return false;
  const picked = await withHiddenMenu(
    more,
    // A Pin row is checked again here: someone may have pinned or unpinned
    // the message since the menu was read.
    async (menu) => {
      for (const [row, kind] of moreRowKinds(menu))
        if ((await offeredMoreAction(kind)) === action) {
          row.click();
          return true;
        }
      return false;
    },
    true,
  );
  return picked === true;
}

export const runMessageAction = (message: HTMLElement, action: DrivenAction) =>
  drive(message, () => pressMessageAction(message, action), action);
