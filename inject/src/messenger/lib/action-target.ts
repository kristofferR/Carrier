import { accountId } from "./threads";

/** What a notification announced, as native recorded it for its quick
 * actions: the account it arrived for, Messenger's id for the message (empty
 * when unknown), and the reaction React adds. */
export interface ActionTarget {
  account: string;
  message: string;
  reaction: string;
}

/** The target, if well-formed and for the signed-in account. Acting under
 * another account could mute or react in a conversation both can see. */
export function actionTargetFor(value: unknown, cookie: string): ActionTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const { account, message = "", reaction = "" } = value as Record<string, unknown>;
  if (typeof account !== "string" || typeof message !== "string" || typeof reaction !== "string")
    return null;
  return account !== "" && account === accountId(cookie) ? { account, message, reaction } : null;
}
