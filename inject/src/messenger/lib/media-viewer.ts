import { type ImageRect, intersectImageClips } from "./emoji-images";

export const MEDIA_VIEWER_ATTR = "data-carrier-media-viewer";
const DIALOG = '[role="dialog"]';
const HIDDEN = '[hidden], [aria-hidden="true"], [inert]';

export interface MediaViewerShape {
  rect: ImageRect;
  viewport: ImageRect;
  overlay: boolean;
  excluded: boolean;
  hasMedia: boolean;
  hasDownload: boolean;
  hasVideoControls: boolean;
}

/** A labelled dialog alone is also an emoji picker, people list, or chat. */
export function isMediaViewerShape(shape: MediaViewerShape): boolean {
  if (shape.excluded || !shape.overlay || !shape.hasMedia) return false;
  if (!shape.hasDownload && !shape.hasVideoControls) return false;
  return coversViewport(shape.rect, shape.viewport);
}

function coversViewport(rect: ImageRect, viewport: ImageRect): boolean {
  const visible = intersectImageClips(rect, viewport);
  const width = viewport.right - viewport.left;
  const height = viewport.bottom - viewport.top;
  return (
    width > 0 &&
    height > 0 &&
    visible.right - visible.left >= width * 0.75 &&
    visible.bottom - visible.top >= height * 0.7
  );
}

function isVisible(element: Element): boolean {
  if (element.closest(HIDDEN)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility === "visible" && rect.width > 0 && rect.height > 0;
}

export function isMediaViewerDialog(dialog: HTMLElement): boolean {
  if (!isVisible(dialog)) return false;
  // Bounding rectangles already include CSS zoom and body transforms.
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const rect = dialog.getBoundingClientRect();
  if (!coversViewport(rect, viewport)) return false;
  let overlay = dialog.getAttribute("aria-modal") === "true";
  let excluded = !!dialog.closest("[data-carrier-shortcuts-overlay]");
  for (let ancestor: HTMLElement | null = dialog; ancestor; ancestor = ancestor.parentElement) {
    const position = getComputedStyle(ancestor).position;
    if (position === "fixed" || position === "absolute") overlay = true;
  }
  const owns = (element: Element) => element.closest(DIALOG) === dialog;
  // The main Messenger surface contains media and download links too.
  excluded ||= [...dialog.querySelectorAll('[role="navigation"], [contenteditable="true"]')].some(
    owns,
  );
  if (excluded || !overlay) return false;
  const media = [
    ...dialog.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video"),
  ].filter((element) => {
    if (!owns(element) || !isVisible(element)) return false;
    const bounds = element.getBoundingClientRect();
    const visible = intersectImageClips(intersectImageClips(bounds, rect), viewport);
    // Ignore avatars, emoji, and gallery thumbnails. Use relative dimensions
    // so narrow windows and Carrier's zoom do not change the classification.
    return (
      visible.right - visible.left >= Math.min(rect.width, viewport.right) * 0.15 &&
      visible.bottom - visible.top >= Math.min(rect.height, viewport.bottom) * 0.15
    );
  });
  return isMediaViewerShape({
    rect,
    viewport,
    overlay,
    excluded,
    hasMedia: media.length > 0,
    hasDownload: [...dialog.querySelectorAll("a[download]")].some(
      (element) => owns(element) && isVisible(element),
    ),
    hasVideoControls: media.some(
      (element) => element instanceof HTMLVideoElement && element.controls,
    ),
  });
}
