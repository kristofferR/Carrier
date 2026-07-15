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
