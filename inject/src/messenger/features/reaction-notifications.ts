/* --------------------- Reactions to your messages --------------------- */
// Messenger's web app never notifies about reactions (see
// lib/reaction-notifications.ts). Watch its reactions table the way its own
// notification hook watches messages, and pass on someone else's reaction to
// one of the signed-in account's messages.
import { diag } from "../bridge";
import { revealText } from "../lib/conversation-export";
import { loadFacebookModules, pageRequire } from "../lib/facebook-loader";
import { messageThreadId, pageId, serverNowMs } from "../lib/page-notifications";
import {
  changedReaction,
  type Reaction,
  ReactionAnnouncements,
} from "../lib/reaction-notifications";
import { accountId } from "../lib/threads";
import { chatRows } from "./conversation-actions";

interface Query {
  subscribe?(listener: (event: unknown, change: unknown) => void): unknown;
}
interface ReQL {
  fromTableAscending(table: unknown): Query;
}
interface Database {
  tables?: { reactions?: unknown };
  runInTransaction?(
    run: (tx: { messages: { index(name: string): { get(key: unknown): unknown } } }) => unknown,
    mode: "readonly",
    a: undefined,
    b: undefined,
    trace: string,
  ): Promise<unknown>;
}

const TRACE = "ChatpaneReactionNotifications";

/**
 * Call `announce` with each new reaction to one of the account's messages,
 * and that message's text (null when it has none or this page can't read it).
 */
export function watchReactions(announce: (reaction: Reaction, text: string | null) => void) {
  // Call windows share the session; notifications belong to the main window.
  if (window.opener) return;
  const start = window.setInterval(() => {
    if (!chatRows().length) return;
    window.clearInterval(start);
    loadFacebookModules(pageRequire(), ["ReQL", "LSDatabaseSingleton", "I64"])
      .then(async ([q, singleton]) => {
        const load = pageRequire();
        const db = (await (singleton as { LSDatabaseSingleton?: Promise<unknown> })
          ?.LSDatabaseSingleton) as Database | undefined;
        const table = db?.tables?.reactions;
        const reactions = table ? (q as ReQL).fromTableAscending(table) : undefined;
        if (
          typeof reactions?.subscribe !== "function" ||
          typeof db?.runInTransaction !== "function"
        ) {
          diag("notify.reactions", "Messenger's reaction APIs changed");
          return;
        }
        const now = () => serverNowMs(load) ?? Date.now();
        const announcements = new ReactionAnnouncements(now());
        reactions.subscribe((_event, change) => {
          const reaction = changedReaction(change, load);
          const account = accountId(document.cookie);
          if (!reaction || !account || !announcements.first(reaction, account, now())) return;
          ownMessageText(db, load, reaction, account)
            .then((text) => {
              if (text !== undefined) announce(reaction, text);
            })
            .catch(() => {});
        });
      })
      .catch(() => diag("notify.reactions", "Messenger's reaction APIs did not load"));
  }, 1_000);
}

/**
 * The text of the message `reaction` is on, when `account` sent it; null when
 * it has no text this page can read, undefined when it isn't the account's.
 */
async function ownMessageText(
  db: Database,
  load: unknown,
  reaction: Reaction,
  account: string,
): Promise<string | null | undefined> {
  const message = await db.runInTransaction?.(
    (tx) => tx.messages.index("messageId").get(reaction.message),
    "readonly",
    undefined,
    undefined,
    TRACE,
  );
  if (!message || typeof message !== "object") return undefined;
  const row = message as { senderId?: unknown; text?: unknown };
  if (messageThreadId(row, load) !== reaction.thread) return undefined;
  if (pageId(row.senderId, load) !== account) return undefined;
  let unvault: ((value: string) => unknown) | undefined;
  try {
    const vault = (load as (name: string) => unknown)("MAWVault") as { unvault?: unknown };
    if (typeof vault?.unvault === "function") {
      unvault = (value) => (vault.unvault as (value: string) => unknown)(value);
    }
  } catch {}
  return revealText(row.text, unvault).text;
}
