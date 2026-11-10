/* ----------------------------- Pinned chats ---------------------------- */
// Pin a chat from its right-click menu to keep it in a Pinned section above
// the chat list (Ref #457). facebook.com has no pinning of its own. Pins are
// per Facebook account and kept by the native side, reached through the signed
// bridge; a change in one window makes the others ask again. Log Out deletes
// them.
import { t } from "../../i18n";
import { diag } from "../bridge";
import {
  MAX_PINNED_CHATS,
  type PinnedChat,
  parsePinnedSnapshot,
  pinnedChats,
  withName,
  withoutPin,
  withPin,
} from "../lib/pinned-chats";
import { interceptThreadListModule } from "../lib/pinned-chats-section";
import { accountId } from "../lib/threads";
import { chatRowName } from "./conversation-actions";

/** Native to page: another window changed the pins; ask again. */
const CHANGED_EVENT = "chatpane:pinned-chats-changed";

let account: string | null = null;
/** The newest native snapshot applied; older answers are dropped. */
let revision = 0;

/** Ask for the account's pins, or save `pins`, and apply the answer. */
function sync(pins?: readonly PinnedChat[]) {
  const owner = account;
  if (!owner || typeof chatpanePinnedChats !== "function") return;
  chatpanePinnedChats(pins ? { account: owner, pins: [...pins] } : { account: owner })
    .then((data) => {
      const snapshot = parsePinnedSnapshot(data);
      if (!snapshot || owner !== account || snapshot.revision <= revision) return;
      revision = snapshot.revision;
      pinnedChats.replace(snapshot.pins);
    })
    .catch(() => diag("pinned-chats.sync", "request failed"));
}

function save(next: readonly PinnedChat[]) {
  if (!account) return;
  pinnedChats.replace(next);
  sync(next);
}

export function isChatPinned(id: string): boolean {
  return pinnedChats.getIds().has(id);
}

/** Whether "Pin chat" can be offered: the account is known and there's room. */
export function canPinChat(): boolean {
  return account !== null && pinnedChats.getSnapshot().length < MAX_PINNED_CHATS;
}

export function setChatPinned(id: string, name: string, pinned: boolean) {
  const list = pinnedChats.getSnapshot();
  const next = pinned ? withPin(list, { id, name }) : withoutPin(list, id);
  if (next !== list) save(next);
}

/** Fill Messenger's pinned-section slot in the chat list (see pinned-chats-section.ts). */
export function interceptPinnedChatModules(define: (...args: unknown[]) => unknown) {
  return interceptThreadListModule(define, pinnedChats, {
    title: () => t("page.pinned_chats.title"),
    // Keep the remembered name in step with what the chat list shows, for
    // when the chat isn't loaded on a later start.
    onRow(id, row) {
      const list = pinnedChats.getSnapshot();
      const next = withName(list, id, chatRowName(row));
      if (next !== list) save(next);
    },
    onError: (error) =>
      diag("pinned-chats.section", error instanceof Error ? error.name : "render failed"),
  });
}

export function initPinnedChats() {
  if (!window.__TAURI_INTERNALS__) return;
  account = accountId(document.cookie);
  if (!account) return;
  window.addEventListener(CHANGED_EVENT, () => sync());
  sync();
}
