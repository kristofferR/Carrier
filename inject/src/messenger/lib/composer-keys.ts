export interface ComposerEnterState {
  key: string;
  isComposing: boolean;
  compositionActive: boolean;
  keyCode: number;
  requireAccelerator: boolean;
  acceleratorPressed: boolean;
  shiftKey: boolean;
}

/**
 * Decide whether Messenger must be prevented from seeing an Enter keydown.
 * The caller deliberately leaves the browser default untouched so an IME can
 * commit its candidate, or the editor can insert a line break.
 */
export function shouldKeepEnterInComposer(state: ComposerEnterState): boolean {
  if (state.key !== "Enter") return false;

  // `isComposing` is the standards-based signal. The tracked composition
  // state and legacy keyCode 229 cover WebKit/IME combinations that clear the
  // flag too early while accepting a candidate.
  if (state.isComposing || state.compositionActive || state.keyCode === 229) return true;

  // Shift+Enter remains Messenger's normal explicit line-break shortcut.
  return state.requireAccelerator && !state.acceleratorPressed && !state.shiftKey;
}

/**
 * Messenger's X that discards a voice clip being recorded or replayed, by the
 * start of its icon's path rather than its translated label. From fMess
 * (github.com/toanbku/fmess, MIT).
 */
const VOICE_CLIP_CANCEL_ICON = "M8 .5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z";

export const isVoiceClipCancelIcon = (path: string | null | undefined) =>
  !!path?.startsWith(VOICE_CLIP_CANCEL_ICON);

export interface VoiceClipEscapeState {
  key: string;
  isComposing: boolean;
  defaultPrevented: boolean;
  /** A dialog, a menu, or Chatpane's zoom overlay is open and owns Escape. */
  escapeOwnedElsewhere: boolean;
  /** The key went to the chat (or to nothing focused), not to another surface. */
  inChat: boolean;
}

/** Whether Escape should discard a voice clip, when one is being recorded or replayed. */
export function shouldEscapeCancelVoiceClip(state: VoiceClipEscapeState): boolean {
  return (
    state.key === "Escape" &&
    !state.isComposing &&
    !state.defaultPrevented &&
    !state.escapeOwnedElsewhere &&
    state.inChat
  );
}
