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
