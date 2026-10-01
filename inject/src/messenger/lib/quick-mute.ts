/** Messenger's mute dialog radios carry their duration in milliseconds, so the
 * notification Mute action can pick one without reading localized copy. */
export const QUICK_MUTE_DURATION_MS = "28800000"; // 8 hours

export type QuickMutePhase = "waiting" | "dialog" | "confirming";

export interface QuickMuteSnapshot {
  threadMatches: boolean;
  /** The open thread's Mute / Unmute control: null until the info pane renders it. */
  muted: boolean | null;
  infoRequested: boolean;
  /** A mute dialog this flow opened, and whether the wanted duration is selected. */
  dialog: "none" | "unselected" | "ready";
}

export type QuickMuteAction =
  | "wait"
  | "open-info"
  | "open-dialog"
  | "select"
  | "confirm"
  | "success"
  | "failure";

/**
 * Pure notification-mute state machine: open the conversation info pane, open
 * Messenger's mute dialog, pick the duration, confirm, then wait for the
 * thread's control to flip to Unmute. An already-muted thread succeeds at once.
 */
export function decideQuickMute(
  phase: QuickMutePhase,
  snapshot: QuickMuteSnapshot,
  expired: boolean,
): { action: QuickMuteAction; phase: QuickMutePhase } {
  if (snapshot.threadMatches && snapshot.muted === true) return { action: "success", phase };
  if (expired) return { action: "failure", phase };
  if (!snapshot.threadMatches) {
    // Navigating away after the dialog opened could mute the wrong thread.
    return phase === "waiting" ? { action: "wait", phase } : { action: "failure", phase };
  }

  if (phase === "waiting") {
    if (snapshot.muted === false) return { action: "open-dialog", phase: "dialog" };
    if (!snapshot.infoRequested) return { action: "open-info", phase };
    return { action: "wait", phase };
  }
  if (phase === "dialog") {
    if (snapshot.dialog === "unselected") return { action: "select", phase };
    if (snapshot.dialog === "ready") return { action: "confirm", phase: "confirming" };
  }
  return { action: "wait", phase };
}
