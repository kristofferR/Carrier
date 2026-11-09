/*
 * Reactions to the signed-in account's messages. Messenger's web app never
 * notifies about them: its notification hook (useMWLSChatPopperUpper) watches
 * only new message rows. Its `reactions` table holds one row per person and
 * message, upserted for encrypted chats by MAWBridgeReactionUpsertHandler and
 * otherwise by LSMailboxUpsertReactionStoredProcedure.
 */
import { isOldNews, messengerMillis, pageId } from "./page-notifications";

export interface Reaction {
  thread: string;
  message: string;
  actor: string;
  emoji: string;
  /** No later than the reaction, on Facebook's clock; null when unknown. */
  at: number | null;
}

/**
 * The reaction a change to the `reactions` table adds or replaces, or null
 * for a removal or a row missing what a notification needs.
 */
export function changedReaction(change: unknown, load: unknown): Reaction | null {
  if (!change || typeof change !== "object") return null;
  const { operation, value } = change as { operation?: unknown; value?: unknown };
  if ((operation !== "add" && operation !== "put") || !value || typeof value !== "object") {
    return null;
  }
  const row = value as Record<string, unknown>;
  const thread = pageId(row.threadKey, load);
  const actor = pageId(row.actorId, load);
  const message = typeof row.messageId === "string" ? row.messageId : "";
  const emoji = typeof row.reaction === "string" ? row.reaction.trim() : "";
  if (!thread || !actor || !message || !emoji) return null;
  // Encrypted chats store the reaction's time in both fields. Otherwise
  // timestampMs is the reacted message's, which can only be earlier.
  const at =
    messengerMillis(row.reactionCreationTimestampMs, load) ||
    messengerMillis(row.timestampMs, load) ||
    null;
  return { thread, message, actor, emoji, at };
}

/** One reaction, as made: a changed or re-added reaction is a new one. */
export const reactionKey = (reaction: Reaction) =>
  `${reaction.thread}:${reaction.message}:${reaction.actor}:${reaction.emoji}:${reaction.at}`;

const ANNOUNCED_LIMIT = 200;

/** Which reactions to announce, each once. */
export class ReactionAnnouncements {
  private readonly announced = new Set<string>();

  /** `since`: when watching began, on Facebook's clock. */
  constructor(private readonly since: number) {}

  /**
   * Whether `reaction` is news to `account`: someone else's, made since
   * watching began and not caught up late (after sleep), and not announced
   * already. Whose message it reacts to is for the caller to check.
   */
  first(reaction: Reaction, account: string, now: number): boolean {
    if (reaction.actor === account || reaction.at === null || reaction.at < this.since) {
      return false;
    }
    if (isOldNews(reaction.at, now, null)) return false;
    const key = reactionKey(reaction);
    if (this.announced.has(key)) return false;
    this.announced.add(key);
    if (this.announced.size > ANNOUNCED_LIMIT) {
      this.announced.delete(this.announced.values().next().value!);
    }
    return true;
  }
}
