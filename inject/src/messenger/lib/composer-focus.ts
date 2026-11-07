/** How long an explicit native action owns focus and navigation. */
export const EXPLICIT_ACTION_HOLD_MS = 2_000;

let explicitActionAt = Number.NEGATIVE_INFINITY;

/**
 * Native actions (notification click, quick reply, Dock or tray conversation,
 * shortcuts) reveal the window and then navigate or focus on their own. Call
 * this before they do, so the return-focus below never lands in the
 * conversation being left.
 */
export function noteExplicitAction(now = performance.now()): void {
  explicitActionAt = now;
}

export function explicitActionRecent(now = performance.now()): boolean {
  return now - explicitActionAt < EXPLICIT_ACTION_HOLD_MS;
}

/** Where keyboard focus sits as the window comes back to the front. */
export type ReturnFocus = "nothing" | "chat-list" | "elsewhere";

export interface ReturnState {
  enabled: boolean;
  threadOpen: boolean;
  dialogOpen: boolean;
  focus: ReturnFocus;
}

/**
 * Coming back to Carrier with a conversation open should let you type at once
 * (Ref #359). Only take focus when nothing meaningful holds it: a search
 * field, dialog, viewer or the composer itself keeps it. A chat-list row
 * counts as nothing, since clicking a chat is how the conversation opened.
 */
export function shouldFocusComposerOnReturn(state: ReturnState): boolean {
  return state.enabled && state.threadOpen && !state.dialogOpen && state.focus !== "elsewhere";
}
