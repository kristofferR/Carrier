/* --------------------- Double-click beside a message -------------------- */
// Double-clicking the empty space in a message's row, left or right of what
// the row shows, starts a reply to that message, as the old Messenger desktop
// app did. It presses Messenger's own Reply (see message-menu.ts) and puts the
// cursor in the message box. Inside a bubble a double-click still selects a
// word, and on a photo or video media-viewer.ts (registered first) opens the
// viewer. Messages Messenger offers no Reply for are left alone.

import { besideInk, type InkShape, isInk, isTransparent } from "../lib/message-reply";
import { focusComposer } from "./conversation-actions";
import { messageFor, pressMessageAction } from "./message-menu";

const CONTROL = 'a, button, input, textarea, [role="button"], [role="link"], [contenteditable]';

function shapeOf(element: Element, style: CSSStyleDeclaration): InkShape {
  return {
    tag: element.tagName,
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
    radii: [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ],
  };
}

/** The first opaque background color behind the row. */
function backdropOf(message: HTMLElement): string {
  for (let node = message.parentElement; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (!isTransparent(color)) return color;
  }
  return "";
}

/** The boxes of everything the row draws. The hover toolbar is left out: it
 * stretches across the empty space beside the bubble. */
function inkBoxes(message: HTMLElement): DOMRect[] {
  const boxes: DOMRect[] = [];
  const backdrop = backdropOf(message);
  // Screen-reader-only text is clipped to a 1px box wherever it sits.
  const add = (box: DOMRect) => {
    if (box.width > 1 && box.height > 1) boxes.push(box);
  };
  const walker = document.createTreeWalker(
    message,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node instanceof Element && node.matches('[role="toolbar"]')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  );
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Element) {
      const style = getComputedStyle(node);
      if (style.visibility !== "hidden" && isInk(shapeOf(node, style), backdrop))
        add(node.getBoundingClientRect());
    } else if (
      node.nodeValue?.trim() &&
      node.parentElement &&
      getComputedStyle(node.parentElement).visibility !== "hidden"
    ) {
      range.selectNodeContents(node);
      add(range.getBoundingClientRect());
    }
  }
  return boxes;
}

export function initMessageReply() {
  document.addEventListener(
    "dblclick",
    (event) => {
      if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey)
        return;
      const target = event.target instanceof Element ? event.target : null;
      const message = target && messageFor(target);
      if (!target || !message) return;
      const control = target.closest(CONTROL);
      if (control && message.contains(control)) return;
      // The double-click selected a word, or text was already selected.
      if (getSelection()?.isCollapsed === false) return;
      if (!besideInk(event.clientX, inkBoxes(message))) return;
      void pressMessageAction(message, "shared.context.reply").then((replied) => {
        if (!replied) return;
        // Closing a More menu hands focus back to its button; take it after.
        focusComposer();
        requestAnimationFrame(() => {
          if (!document.activeElement?.closest('[contenteditable="true"]')) focusComposer();
        });
      });
    },
    { capture: true },
  );
}
