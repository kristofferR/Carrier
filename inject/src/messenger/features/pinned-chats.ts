/* ----------------------------- Pinned chats ---------------------------- */
// Pin a chat from its right-click menu to keep it in a Pinned section above
// the chat list (Ref #457). facebook.com has no pinning of its own. Pins are
// per Facebook account and kept by the native side, reached through the signed
// bridge. Each window sends single changes, so changes from several windows
// all land, and a change in one makes the others ask again. Log Out deletes
// them.
import { t } from "../../i18n";
import { diag } from "../bridge";
import {
  createPinnedChatsSync,
  MAX_PINNED_CHATS,
  type PinChange,
  parsePinnedSnapshot,
  pinnedChats,
} from "../lib/pinned-chats";
import { interceptThreadListModule } from "../lib/pinned-chats-section";
import { accountId } from "../lib/threads";
import { chatRowName } from "./conversation-actions";

/** Native to page: another window changed the pins; ask again. */
const CHANGED_EVENT = "chatpane:pinned-chats-changed";

let account: string | null = null;

/** Ask native code for the pins, or make `change`. Null when there's no answer. */
async function request(change?: PinChange) {
  const owner = account;
  if (!owner || typeof chatpanePinnedChats !== "function") return null;
  try {
    const snapshot = parsePinnedSnapshot(
      await chatpanePinnedChats(change ? { account: owner, ...change } : { account: owner }),
    );
    return owner === account ? snapshot : null;
  } catch (_) {
    diag("pinned-chats.sync", "request failed");
    return null;
  }
}

const sync = createPinnedChatsSync(pinnedChats, request);

export function isChatPinned(id: string): boolean {
  return pinnedChats.getIds().has(id);
}

/** Whether "Pin chat" can be offered: the account is known and there's room. */
export function canPinChat(): boolean {
  return account !== null && pinnedChats.getSnapshot().length < MAX_PINNED_CHATS;
}

export function setChatPinned(id: string, name: string, pinned: boolean) {
  if (account) void sync.change(pinned ? { op: "pin", id, name } : { op: "unpin", id });
}

/** Fill Messenger's pinned-section slot in the chat list (see pinned-chats-section.ts). */
export function interceptPinnedChatModules(define: (...args: unknown[]) => unknown) {
  const rowNames = new WeakMap<Element, string>();
  return interceptThreadListModule(define, pinnedChats, {
    title: () => t("page.pinned_chats.title"),
    // Keep the remembered name in step with what the chat list shows, for
    // when the chat isn't loaded on a later start.
    onRow(id, row) {
      const name = chatRowName(row);
      if (!account || rowNames.get(row) === name) return;
      // A rejected save can rerender this row with the old remembered name.
      rowNames.set(row, name);
      void sync.change({ op: "rename", id, name });
    },
    onError: (error) =>
      diag("pinned-chats.section", error instanceof Error ? error.name : "render failed"),
  });
}

export function initPinnedChats() {
  if (!window.__TAURI_INTERNALS__) return;
  account = accountId(document.cookie);
  if (!account) return;
  window.addEventListener(CHANGED_EVENT, () => void sync.refresh());
  void sync.refresh();
}
