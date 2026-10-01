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

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * When a bubble was sent, to the minute. Messenger words the label relative to
 * now: a bare time is today, then "Yesterday" or a weekday within the last
 * week. Older or unrecognized labels give null.
 */
export function bubbleSentAt(label: string, now: number): number | null {
  const match =
    /^Enter, Message sent (?:(\p{Letter}+) )?(\d{1,2}):(\d{2})(?:\s?([ap])\.?m\.?)? by /iu.exec(
      label,
    );
  if (!match) return null;
  const today = new Date(now);
  const day = match[1]?.toLowerCase();
  let daysBack = 0;
  if (day === "yesterday") daysBack = 1;
  else if (day) {
    const weekday = WEEKDAYS.indexOf(day);
    if (weekday < 0) return null;
    // Today's own name never labels a bubble, so it means a week ago.
    daysBack = (today.getDay() - weekday + 7) % 7 || 7;
  }
  const meridiem = match[4]?.toLowerCase();
  const hour = meridiem ? (Number(match[2]) % 12) + (meridiem === "p" ? 12 : 0) : Number(match[2]);
  const sent = new Date(today);
  sent.setDate(today.getDate() - daysBack);
  sent.setHours(hour, Number(match[3]), 0, 0);
  return sent.getTime();
}

/** How long after a message was sent its notification may still have fired. */
const FRESH_MINUTES = 5;
const MINUTE_MS = 60_000;

/**
 * Whether a bubble was sent around when its notification fired. This keeps an
 * older message with the same text from standing in for one still rendering.
 */
export function bubbleIsFresh(label: string, notifiedAt: number, now = Date.now()): boolean {
  const sent = bubbleSentAt(label, now);
  if (sent === null) return false;
  // The label is to the minute; allow a minute of clock skew the other way.
  const lag = notifiedAt - sent;
  return lag >= -MINUTE_MS && lag < (FRESH_MINUTES + 1) * MINUTE_MS;
}
