export type QuickLikePhase = "waiting" | "menu" | "confirming";

export interface QuickLikeSnapshot {
  threadMatches: boolean;
  /** The newest message from someone else matching the notification is rendered. */
  targetFound: boolean;
  /** The list sits at its latest message. */
  settled: boolean;
  /** Its hover toolbar's React button is mounted. */
  reactButton: boolean;
  /** The reaction menu: absent, 👍 unselected/selected, or open without 👍. */
  menu: "none" | "unselected" | "selected" | "missing";
  /** The message's reaction summary shows 👍. */
  thumbShown: boolean;
}

export type QuickLikeAction =
  | "wait"
  | "settle"
  | "hover"
  | "open-menu"
  | "select"
  | "close-menu"
  | "success"
  | "failure";

/**
 * Pure notification-like state machine: bring the conversation to its latest
 * message, find the incoming message the notification announced (by its
 * text), hover it, open its reaction menu, and pick 👍. An existing 👍 is
 * left alone, since picking it again would remove it.
 */
export function decideQuickLike(
  phase: QuickLikePhase,
  snapshot: QuickLikeSnapshot,
  expired: boolean,
): { action: QuickLikeAction; phase: QuickLikePhase } {
  if (!snapshot.threadMatches) {
    if (phase === "waiting" && !expired) return { action: "wait", phase };
    return { action: "failure", phase };
  }

  if (phase === "confirming") {
    if (snapshot.thumbShown) return { action: "success", phase };
    return expired ? { action: "failure", phase } : { action: "wait", phase };
  }
  if (expired) return { action: "failure", phase };

  if (phase === "menu") {
    if (snapshot.menu === "selected") return { action: "close-menu", phase: "confirming" };
    if (snapshot.menu === "unselected") return { action: "select", phase: "confirming" };
    if (snapshot.menu === "missing") return { action: "failure", phase };
    return { action: "wait", phase };
  }

  if (!snapshot.settled) return { action: "settle", phase };
  if (!snapshot.targetFound) return { action: "wait", phase };
  if (!snapshot.reactButton) return { action: "hover", phase };
  return { action: "open-menu", phase: "menu" };
}

const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

/** The text of a bubble label: "Enter, Message sent <when> by <name>: <text>". */
export function bubbleText(label: string): string {
  const match = / by [^:]*: ([\s\S]*)$/.exec(label);
  return match?.[1] ? normalized(match[1]) : "";
}

/**
 * Whether a bubble is the message a notification announced. Previews can be
 * truncated, and group previews can carry a "Name: " prefix.
 */
export function bubbleMatchesNotification(label: string, body: string): boolean {
  const text = bubbleText(label);
  const preview = normalized(body)
    .replace(/(?:…|\.\.\.)$/, "")
    .trim();
  if (!text || !preview) return false;
  return text.startsWith(preview) || preview.endsWith(`: ${text}`);
}

/** Minute of the day a bubble was sent, or null when its label names another day. */
export function bubbleSentMinute(label: string): number | null {
  const match = /^Enter, Message sent (\d{1,2}):(\d{2})(?:\s?([ap])\.?m\.?)? by /i.exec(label);
  if (!match) return null;
  const meridiem = match[3]?.toLowerCase();
  const hour = meridiem ? (Number(match[1]) % 12) + (meridiem === "p" ? 12 : 0) : Number(match[1]);
  return hour * 60 + Number(match[2]);
}

/** How long after a message was sent its notification may still have fired. */
const FRESH_MINUTES = 5;

/**
 * Whether a bubble was sent around when its notification fired. This keeps an
 * older message with the same text from standing in for one still rendering.
 */
export function bubbleIsFresh(label: string, notifiedAt: number): boolean {
  const sent = bubbleSentMinute(label);
  if (sent === null) return false;
  const at = new Date(notifiedAt);
  const lag = at.getHours() * 60 + at.getMinutes() - sent;
  return lag >= -1 && lag <= FRESH_MINUTES;
}
