import { isMediaViewerDialog, MEDIA_VIEWER_ATTR } from "../lib/media-viewer";
import { viewerControlOffset } from "../lib/viewer-controls";

const DIALOG = '[role="dialog"]';
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
  if (!element.hasAttribute(attr)) element.setAttribute(attr, "");
  const value = `${offset}px`;
  if (element.style.getPropertyValue(OFFSET) !== value) {
    element.style.setProperty(OFFSET, value);
  }
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
  let viewers = new Set<HTMLElement>();
  let markedControls = new Set<HTMLElement>();
  let observedDialogs = new Set<HTMLElement>();

  const refresh = () => {
    frame = 0;
    const dialogs = new Set(document.querySelectorAll<HTMLElement>(DIALOG));
    for (const dialog of observedDialogs) {
      if (!dialogs.has(dialog)) resizeObserver.unobserve(dialog);
    }
    for (const dialog of dialogs) {
      if (!observedDialogs.has(dialog)) resizeObserver.observe(dialog);
    }
    observedDialogs = dialogs;
    const nextViewers = new Set([...dialogs].filter(isMediaViewerDialog));
    for (const dialog of viewers) {
      if (!nextViewers.has(dialog)) dialog.removeAttribute(MEDIA_VIEWER_ATTR);
    }
    for (const dialog of nextViewers) {
      if (!dialog.hasAttribute(MEDIA_VIEWER_ATTR)) dialog.setAttribute(MEDIA_VIEWER_ATTR, "");
    }
    viewers = nextViewers;
    const previouslyMarked = markedControls;
    markedControls = new Set();

    if (viewers.size) {
      for (const banner of document.querySelectorAll<HTMLElement>(BANNER)) {
        if (
          applyOffset(
            banner,
            visibleControls(banner).map((rect) => rect.top),
            BANNER_ATTR,
          )
        ) {
          markedControls.add(banner);
        }
      }

      // Facebook renders Download and Share in a compact action group inside
      // the dialog rather than in the banner. Find that group structurally
      // from the locale-independent `download` attribute and move it as one
      // unit, preserving spacing and hover transforms on both controls.
      for (const dialog of viewers) {
        for (const download of dialog.querySelectorAll<HTMLElement>("a[download]")) {
          if (download.closest(DIALOG) !== dialog) continue;
          const group = actionGroupFor(download, dialog);
          if (
            applyOffset(
              group,
              visibleControls(group).map((rect) => rect.top),
              ACTIONS_ATTR,
            )
          ) {
            markedControls.add(group);
          }
        }
      }
    }

    for (const element of previouslyMarked) {
      if (markedControls.has(element)) continue;
      element.removeAttribute(BANNER_ATTR);
      element.removeAttribute(ACTIONS_ATTR);
      element.style.removeProperty(OFFSET);
    }
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(refresh);
  };

  const resizeObserver = new ResizeObserver(schedule);
  const affectsControls = (element: Element) =>
    !!element.closest(`${DIALOG}, ${BANNER}`) ||
    [...observedDialogs, ...markedControls].some((control) => element.contains(control));

  // Chat updates outside a dialog cannot change its controls. Inspect changed
  // subtrees for new dialogs, and retain tracked nodes to catch removal or role loss.
  new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          (record.target instanceof Element && affectsControls(record.target)) ||
          (record.type === "childList" &&
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (affectsControls(node) || node.querySelector(`${DIALOG}, ${BANNER}`)),
            )),
      )
    )
      schedule();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "hidden",
      "aria-hidden",
      "inert",
      "role",
      "aria-modal",
      "class",
      "style",
      "download",
      "controls",
    ],
  });
  const mediaLoaded = (event: Event) => {
    if (event.target instanceof Element && event.target.closest(DIALOG)) schedule();
  };
  document.addEventListener("load", mediaLoaded, true);
  document.addEventListener("loadedmetadata", mediaLoaded, true);
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) schedule();
  });
  schedule();
}
