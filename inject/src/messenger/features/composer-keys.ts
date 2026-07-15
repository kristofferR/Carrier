/* -------------------- Composer Enter-key handling -------------------- */
// Carrier runs at document start, before Messenger registers its handlers.
// Stopping propagation here keeps a composing Enter from reaching Messenger's
// send handler while preserving the browser default that commits the IME text.
import { shouldKeepEnterInComposer } from "../lib/composer-keys";

const isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
const composerSelector =
  '[contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"], textarea';

function isComposerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const editor = target.closest(composerSelector);
  return !!editor?.closest('[role="main"]');
}

export function initComposerKeys() {
  let compositionActive = false;

  document.addEventListener(
    "compositionstart",
    (event) => {
      if (isComposerTarget(event.target)) compositionActive = true;
    },
    true,
  );
  document.addEventListener(
    "compositionend",
    () => {
      compositionActive = false;
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isComposerTarget(event.target)) return;
      if (
        !shouldKeepEnterInComposer({
          key: event.key,
          isComposing: event.isComposing,
          compositionActive,
          keyCode: event.keyCode,
          requireAccelerator: window.__CARRIER_SETTINGS__?.send_with_accelerator === true,
          acceleratorPressed: isMac ? event.metaKey : event.ctrlKey,
          shiftKey: event.shiftKey,
        })
      )
        return;

      // Do not call preventDefault: the IME still needs to commit its current
      // candidate, and opt-in plain Enter still needs to insert a line break.
      event.stopImmediatePropagation();
    },
    true,
  );
}
