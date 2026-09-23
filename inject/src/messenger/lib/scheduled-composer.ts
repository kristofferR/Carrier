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
    // The conversation's quick-reaction button can itself be an emoji image.
    // A clickable attachment preview is still media, not a toolbar control.
    if (control && /^(send|choose|attach)\b/i.test(control.getAttribute("aria-label") || ""))
      continue;
    return true;
  }
  return !!buttonByLabel(
    ["remove attachment", "remove photo", "remove video", "remove file"],
    region,
  );
}

export function findSendButton(box: HTMLElement): HTMLElement | null {
  const region = composerRegion(box);
  if (!region) return null;
  for (const button of region.querySelectorAll<HTMLElement>(
    'button[aria-label], [role="button"][aria-label]',
  )) {
    if (
      button.hasAttribute("data-carrier-schedule") ||
      !isShown(button) ||
      button.getAttribute("aria-disabled") === "true" ||
      button.matches(":disabled")
    )
      continue;
    const label = (button.getAttribute("aria-label") || "").toLowerCase();
    if (label === "send" || label.includes("press enter to send") || label.includes("send message"))
      return button;
  }
  return null;
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
