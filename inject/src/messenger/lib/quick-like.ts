export type QuickLikePhase = "waiting" | "menu" | "confirming";

export interface QuickLikeSnapshot {
  threadMatches: boolean;
  /** The newest message from someone else is rendered. */
  targetFound: boolean;
  /** Its hover toolbar's React button is mounted. */
  reactButton: boolean;
  /** The reaction menu: absent, 👍 unselected/selected, or open without 👍. */
  menu: "none" | "unselected" | "selected" | "missing";
  /** The message's reaction summary shows 👍. */
  thumbShown: boolean;
}

export type QuickLikeAction =
  | "wait"
  | "hover"
  | "open-menu"
  | "select"
  | "close-menu"
  | "success"
  | "failure";

/**
 * Pure notification-like state machine: hover the newest incoming message,
 * open its reaction menu, and pick 👍. An existing 👍 is left alone, since
 * picking it again would remove it.
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

  if (!snapshot.targetFound) return { action: "wait", phase };
  if (!snapshot.reactButton) return { action: "hover", phase };
  return { action: "open-menu", phase: "menu" };
}
