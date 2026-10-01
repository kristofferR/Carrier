/** Messenger's mute dialog radios carry their duration in milliseconds, so the
 * notification Mute action can pick one without reading localized copy. */
export const QUICK_MUTE_DURATION_MS = "28800000"; // 8 hours

export type QuickMutePhase = "waiting" | "chooser" | "dialog" | "confirming";

export interface QuickMuteSnapshot {
  threadMatches: boolean;
  /** The info pane's Mute / Unmute control: null until rendered, or absent in
   * the Messenger variant that has "Chat notifications" instead. */
  muted: boolean | null;
  /** That variant's "Chat notifications" control is rendered. */
  chatNotifications: boolean;
  /** Its "Notifications for this chat" dialog, offering Mute or Unmute. */
  chooser: "none" | "mute" | "unmute";
  infoRequested: boolean;
  /** A mute dialog this flow opened, and whether the wanted duration is selected. */
  dialog: "none" | "unselected" | "ready";
  /** After confirming: the duration dialog closed, or Carrier saw the thread muted. */
  confirmed: boolean;
}

export type QuickMuteAction =
  | "wait"
  | "open-info"
  | "open-dialog"
  | "open-chooser"
  | "choose-mute"
  | "select"
  | "confirm"
  | "success"
  | "failure";

/**
 * Pure notification-mute state machine: open the conversation info pane, open
 * Messenger's mute dialog (directly, or through "Chat notifications"), pick
 * the duration, confirm, then wait for evidence it applied. An already-muted
 * thread succeeds at once.
 */
export function decideQuickMute(
  phase: QuickMutePhase,
  snapshot: QuickMuteSnapshot,
  expired: boolean,
): { action: QuickMuteAction; phase: QuickMutePhase } {
  if (
    snapshot.threadMatches &&
    (snapshot.muted === true ||
      (phase === "chooser" && snapshot.chooser === "unmute") ||
      (phase === "confirming" && snapshot.confirmed))
  ) {
    return { action: "success", phase };
  }
  if (expired) return { action: "failure", phase };
  if (!snapshot.threadMatches) {
    // Navigating away after the dialog opened could mute the wrong thread.
    return phase === "waiting" ? { action: "wait", phase } : { action: "failure", phase };
  }

  if (phase === "waiting") {
    if (snapshot.muted === false) return { action: "open-dialog", phase: "dialog" };
    if (snapshot.chatNotifications) return { action: "open-chooser", phase: "chooser" };
    if (!snapshot.infoRequested) return { action: "open-info", phase };
    return { action: "wait", phase };
  }
  if (phase === "chooser") {
    if (snapshot.chooser === "mute") return { action: "choose-mute", phase: "dialog" };
    return { action: "wait", phase };
  }
  if (phase === "dialog") {
    if (snapshot.dialog === "unselected") return { action: "select", phase };
    if (snapshot.dialog === "ready") return { action: "confirm", phase: "confirming" };
  }
  return { action: "wait", phase };
}
