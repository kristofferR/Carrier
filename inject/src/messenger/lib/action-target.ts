import { accountId } from "./threads";

/** What a notification announced, as native recorded it for 👍 and Mute: the
 * raw message text, when Carrier saw it, and the account it arrived for. */
export interface ActionTarget {
  body: string;
  at: number;
  account: string;
}

/** The target, if well-formed and for the signed-in account. Acting under
 * another account could mute or react in a conversation both can see. */
export function actionTargetFor(value: unknown, cookie: string): ActionTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const { body, at, account } = value as Record<string, unknown>;
  if (typeof body !== "string" || typeof at !== "number" || typeof account !== "string")
    return null;
  return account !== "" && account === accountId(cookie) ? { body, at, account } : null;
}
