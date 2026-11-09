/* -------------------- Composer Enter-key handling -------------------- */
// Chatpane runs at document start, before Messenger registers its handlers.
// Stopping propagation here keeps a composing Enter from reaching Messenger's
// send handler while preserving the browser default that commits the IME text.
import {
  isVoiceClipCancelIcon,
  shouldEscapeCancelVoiceClip,
  shouldKeepEnterInComposer,
} from "../lib/composer-keys";
import { isMediaZoomActive } from "./media-viewer";

const isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
const composerSelector =
  '[contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"], textarea';

export function isComposerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const editor = target.closest(composerSelector);
  return !!editor?.closest('[role="main"]');
}

const isShown = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

/** The visible X of a voice clip being recorded or replayed, if any. */
function voiceClipCancelButton(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="main"] [role="button"]')].find(
    (button) =>
      isVoiceClipCancelIcon(button.querySelector("svg path")?.getAttribute("d")) && isShown(button),
  );
}

// Escape discards a voice clip being recorded or replayed, like its X button.
// Dialogs, menus, Chatpane's zoom overlay and fullscreen media keep Escape.
function onVoiceClipEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  const target = event.target;
  const inChat =
    target === document.body ||
    target === document.documentElement ||
    (target instanceof Element && !!target.closest('[role="main"]'));
  const escapeOwnedElsewhere =
    isMediaZoomActive() ||
    !!document.fullscreenElement ||
    [...document.querySelectorAll('[role="dialog"], [role="menu"]')].some(isShown);
  if (
    !shouldEscapeCancelVoiceClip({
      key: event.key,
      isComposing: event.isComposing,
      defaultPrevented: event.defaultPrevented,
      escapeOwnedElsewhere,
      inChat,
    })
  )
    return;
  const cancel = voiceClipCancelButton();
  if (!cancel) return;
  event.preventDefault();
  event.stopPropagation();
  cancel.click();
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
          requireAccelerator: window.__CHATPANE_SETTINGS__?.send_with_accelerator === true,
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
  document.addEventListener("keydown", onVoiceClipEscape, true);
}
