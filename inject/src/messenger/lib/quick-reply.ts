export type QuickReplyPhase = "waiting" | "inserted" | "confirming";

export interface QuickReplySnapshot {
  threadMatches: boolean;
  composerReady: boolean;
  draftMatches: boolean;
  sendAvailable: boolean;
  composerEmpty: boolean;
}

export type QuickReplyDecision =
  | { action: "wait"; phase: QuickReplyPhase }
  | { action: "insert"; phase: "inserted" }
  | { action: "send"; phase: "confirming" }
  | { action: "success"; phase: "confirming" }
  | { action: "failure"; phase: QuickReplyPhase };

/**
 * Pure quick-reply state machine. DOM polling feeds it sanitized booleans so
 * wrong-thread protection and timeout behavior stay independently testable.
 */
export function decideQuickReply(
  phase: QuickReplyPhase,
  snapshot: QuickReplySnapshot,
  expired: boolean,
): QuickReplyDecision {
  if (phase === "waiting") {
    if (expired) return { action: "failure", phase };
    if (!snapshot.threadMatches || !snapshot.composerReady) return { action: "wait", phase };
    return { action: "insert", phase: "inserted" };
  }

  // Once text has been inserted, any navigation away is a hard failure. Never
  // click a send control unless the validated destination is still current.
  if (!snapshot.threadMatches || !snapshot.composerReady) {
    return { action: "failure", phase };
  }

  if (phase === "inserted") {
    if (!snapshot.draftMatches || !snapshot.sendAvailable) {
      return { action: "failure", phase };
    }
    return { action: "send", phase: "confirming" };
  }

  if (snapshot.composerEmpty) return { action: "success", phase };
  if (expired) return { action: "failure", phase };
  return { action: "wait", phase };
}

export const composerContainsReply = (content: string | null, reply: string): boolean =>
  reply.length > 0 && (content || "").includes(reply);
