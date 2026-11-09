/* ------------------------------ Scroll bars ----------------------------- */
// Thin scroll bars that stay out of the way. Where the engine draws overlay
// scroll bars (macOS, where Chatpane asks AppKit for them, and GTK's overlay
// scrolling), messenger.css only makes them thin, and the engine keeps moving
// them on its scrolling thread. Where it draws classic always-on tracks
// (Windows), they take room from the panes, so in the chats they are hidden
// and a thin indicator floats over the pane while it scrolls. Wheel, touchpad
// and keyboard scrolling are unchanged. Adapted from fMess
// (github.com/toanbku/fmess, MIT; notice in lib/typing-block.ts).
import { indicatorPlace } from "../lib/scrollbars";

/** "overlay" or "classic" on <html>: which scroll bars the engine draws. */
const KIND_ATTR = "data-chatpane-scrollbars";
const INDICATOR_ID = "chatpane-scroll-indicator";
const CHATS_ATTR = "data-chatpane-chats";
// Finding what covers a point is costly: a few times a second while scrolling.
const COVER_CHECK_MS = 250;
const HIDE_AFTER_MS = 800;

/** Measured in a closed shadow root, where the page's styles don't reach. */
function drawsOverlayScrollbars(root: HTMLElement): boolean {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;top:-200px;left:0;width:0;height:0;overflow:hidden;";
  const box = document.createElement("div");
  box.style.cssText = "width:100px;height:100px;overflow:scroll;";
  host.attachShadow({ mode: "closed" }).append(box);
  root.append(host);
  const overlay = box.offsetWidth === box.clientWidth;
  host.remove();
  return overlay;
}

export function initScrollbars() {
  const html = document.documentElement;
  const overlay = drawsOverlayScrollbars(html);
  html.setAttribute(KIND_ATTR, overlay ? "overlay" : "classic");
  if (overlay) return;

  const indicator = document.createElement("div");
  indicator.id = INDICATOR_ID;
  indicator.setAttribute("aria-hidden", "true");
  html.append(indicator);

  let scrolled: Element | null = null;
  let frame = 0;
  let shownHeight = 0;
  let coverPane: Element | null = null;
  let coverCheckedAt = Number.NEGATIVE_INFINITY;
  let covered = false;
  let hideTimer = 0;

  const hide = () => {
    indicator.style.opacity = "0";
  };

  // Once per frame however many scroll events arrive, when the page lays
  // itself out anyway.
  const draw = (now: number) => {
    frame = 0;
    const pane = scrolled;
    scrolled = null;
    if (!pane?.isConnected) return;
    const rect = pane.getBoundingClientRect();
    const place = indicatorPlace(rect, pane);
    if (!place) return;
    // The indicator floats over the whole page, so it hides where a menu or
    // dialog covers the pane (it lets pointers through to them).
    if (pane !== coverPane || now - coverCheckedAt > COVER_CHECK_MS) {
      coverPane = pane;
      coverCheckedAt = now;
      const x = place.left + 3;
      covered = [place.top + 2, place.top + place.height / 2, place.top + place.height - 2].some(
        (y) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && hit !== indicator && !pane.contains(hit);
        },
      );
    }
    window.clearTimeout(hideTimer);
    if (covered) return hide();
    if (place.height !== shownHeight) {
      shownHeight = place.height;
      indicator.style.height = `${place.height}px`;
    }
    indicator.style.transform = `translate(${place.left}px, ${place.top}px)`;
    indicator.style.opacity = "1";
    hideTimer = window.setTimeout(() => {
      hide();
      coverPane = null;
    }, HIDE_AFTER_MS);
  };

  document.addEventListener(
    "scroll",
    (event) => {
      // Classic scroll bars stay outside the chats (login and checkpoint
      // pages), so the indicator does too.
      if (!html.hasAttribute(CHATS_ATTR) || !(event.target instanceof Element)) return;
      scrolled = event.target;
      if (!frame) frame = requestAnimationFrame(draw);
    },
    { capture: true, passive: true },
  );
}
