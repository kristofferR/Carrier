/** What each emitted notification announced, keyed by the page's notification
 * id, so its 👍 action can find the message: the raw text (before link or
 * photo rewording) and when the page saw it. Lost on reload, which makes 👍
 * fall back to opening the conversation. */
export interface NotifiedMessage {
  body: string;
  at: number;
}

const LIMIT = 50;
const messages = new Map<number, NotifiedMessage>();

export function rememberNotifiedMessage(id: number, body: string, at = Date.now()) {
  messages.set(id, { body, at });
  if (messages.size > LIMIT) messages.delete(messages.keys().next().value!);
}

export const notifiedMessage = (id: number) => messages.get(id);
