import { viewerControlOffset } from "../lib/viewer-controls";

const DIALOG = 'div[role="dialog"][aria-label]:not([hidden] *)';
const BANNER = 'div[role="banner"]';
const CONTROL = 'a[href], button, [role="button"]';
const BANNER_ATTR = "data-carrier-media-controls";
const ACTIONS_ATTR = "data-carrier-media-actions";
const OFFSET = "--carrier-media-controls-offset";

const visibleControls = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(CONTROL)]
    .map((control) => control.getBoundingClientRect())
    .filter(
      (rect) =>
        rect.width >= 16 &&
        rect.height >= 16 &&
        rect.bottom > 0 &&
        rect.top < 96 &&
        rect.right > 0 &&
        rect.left < window.innerWidth,
    );

const applyOffset = (element: HTMLElement, controlTops: number[], attr: string) => {
  const currentOffset = Number.parseFloat(element.style.getPropertyValue(OFFSET)) || 0;
  const offset = viewerControlOffset(controlTops, currentOffset);
  if (!offset) return false;
  element.setAttribute(attr, "");
  element.style.setProperty(OFFSET, `${offset}px`);
  return true;
};

const actionGroupFor = (download: HTMLElement, dialog: HTMLElement) => {
  let candidate: HTMLElement = download;
  for (
    let parent = download.parentElement;
    parent && parent !== dialog;
    parent = parent.parentElement
  ) {
    const rect = parent.getBoundingClientRect();
    const controls = visibleControls(parent);
    if (controls.length >= 2 && rect.width <= 240 && rect.height <= 96) return parent;
    if (rect.width <= 240 && rect.height <= 96) candidate = parent;
  }
  return candidate;
};

export function initViewerControls() {
  let frame = 0;

  const refresh = () => {
    frame = 0;
    const previouslyMarked = new Set(
      document.querySelectorAll<HTMLElement>(`[${BANNER_ATTR}], [${ACTIONS_ATTR}]`),
    );

    const dialog = document.querySelector<HTMLElement>(DIALOG);
    if (dialog) {
      for (const banner of document.querySelectorAll<HTMLElement>(BANNER)) {
        if (
          applyOffset(
            banner,
            visibleControls(banner).map((rect) => rect.top),
            BANNER_ATTR,
          )
        ) {
          previouslyMarked.delete(banner);
        }
      }

      // Facebook renders Download and Share in a compact action group inside
      // the dialog rather than in the banner. Find that group structurally
      // from the locale-independent `download` attribute and move it as one
      // unit, preserving spacing and hover transforms on both controls.
      for (const download of dialog.querySelectorAll<HTMLElement>("a[download]")) {
        const group = actionGroupFor(download, dialog);
        if (
          applyOffset(
            group,
            visibleControls(group).map((rect) => rect.top),
            ACTIONS_ATTR,
          )
        ) {
          previouslyMarked.delete(group);
        }
      }
    }

    for (const element of previouslyMarked) {
      element.removeAttribute(BANNER_ATTR);
      element.removeAttribute(ACTIONS_ATTR);
      element.style.removeProperty(OFFSET);
    }
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(refresh);
  };

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) schedule();
  });
  schedule();
}
