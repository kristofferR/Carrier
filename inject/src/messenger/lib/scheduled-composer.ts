import { buttonByLabel, firstShown, isShown } from "../features/conversation-actions";

export const COMPOSER_SELECTOR = '[role="main"] [contenteditable="true"][role="textbox"]';
export const findComposer = () => firstShown<HTMLElement>(COMPOSER_SELECTOR);
export const composerText = (box: HTMLElement) => box.innerText.replace(/\r\n/g, "\n");

/** The footer region contains attachments too, but excludes conversation history. */
export function composerRegion(box: HTMLElement): HTMLElement | null {
  return box.closest<HTMLElement>('[role="region"], form');
}

export function hasComposerMedia(box: HTMLElement): boolean {
  const region = composerRegion(box);
  if (!region) return true; // Unknown markup must never turn a media draft into text-only.
  if (box.querySelector('img, video, [contenteditable="false"]')) return true;
  for (const input of region.querySelectorAll<HTMLInputElement>('input[type="file"]')) {
    if (input.files?.length) return true;
  }
  for (const media of region.querySelectorAll('img, video, [role="progressbar"]')) {
    if (!isShown(media)) continue;
    const control = media.closest('button, [role="button"]');
    // Toolbar icons are compact even when Messenger translates their labels.
    // Attachment previews occupy a larger surface and remain media when clickable.
    const bounds = control?.getBoundingClientRect();
    const configuredZoom = Number(window.__CARRIER_SETTINGS__?.zoom) || 100;
    const scale = Math.min(2, Math.max(0.3, configuredZoom / 100));
    if (
      media.tagName === "IMG" &&
      control &&
      bounds &&
      bounds.width / scale <= 48 &&
      bounds.height / scale <= 48 &&
      !control.closest('[contenteditable="true"]')
    )
      continue;
    return true;
  }
  return !!buttonByLabel(
    ["remove attachment", "remove photo", "remove video", "remove file"],
    region,
  );
}

/** Capture controls before insertion so the send action can be identified by
 * the change Messenger makes when text appears, regardless of locale. */
export function composerControls(box: HTMLElement): Map<HTMLElement, string> {
  const region = composerRegion(box);
  const controls = new Map<HTMLElement, string>();
  if (!region) return controls;
  for (const button of region.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (button.hasAttribute("data-carrier-schedule")) continue;
    controls.set(button, `${button.getAttribute("aria-label") ?? ""}\n${button.innerHTML}`);
  }
  return controls;
}

export function findSendButton(
  box: HTMLElement,
  before: Map<HTMLElement, string>,
): HTMLElement | null {
  const region = composerRegion(box);
  if (!region) return null;
  const changed: HTMLElement[] = [];
  for (const button of region.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (
      button.hasAttribute("data-carrier-schedule") ||
      !(box.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) ||
      !isShown(button) ||
      button.getAttribute("aria-disabled") === "true" ||
      button.matches(":disabled")
    )
      continue;
    if (before.get(button) !== `${button.getAttribute("aria-label") ?? ""}\n${button.innerHTML}`)
      changed.push(button);
  }
  return changed.length === 1 ? (changed[0] ?? null) : null;
}

export function replaceComposerText(box: HTMLElement, text: string): boolean {
  box.focus();
  const range = document.createRange();
  range.selectNodeContents(box);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return document.execCommand(text ? "insertText" : "delete", false, text);
}
