/* ------------------------- Resizable panes ---------------------------- */
// Drag the edge between the chat list and the chat, or between the chat and
// its details, as in the old desktop app; double-click an edge for Facebook's
// width again. Widths persist natively (Facebook clears unknown localStorage
// on Mac page loads): a drag reports both widths with a carrier:pane-widths
// event, Rust stores them in settings and pushes them back through
// __CARRIER_SETTINGS__ on every load. Adapted from fMess
// (https://github.com/toanbku/fmess, MIT, src-tauri/src/inject/08-panes.js).

import { invoke } from "../bridge";
import {
  dragBounds,
  dragWidth,
  edgeSide,
  type Pane,
  type PaneWidths,
  paneCap,
  paneWidthCss,
  sanitizePaneWidths,
} from "../lib/pane-resize";
import { isMessengerContentPath } from "../lib/threads";

const PANE_ATTR = "data-carrier-pane";
const CHAT_ROW_ATTR = "data-carrier-chat-row";
const RESIZING_ATTR = "data-carrier-resizing";
const EDGE_CLASS = "carrier-pane-edge";
const SELECTORS: Record<Pane, string> = {
  list: `[role="navigation"][${PANE_ATTR}="list"]`,
  details: `[${CHAT_ROW_ATTR}] > :nth-child(2)`,
};

const EDGE_CSS = `
  [${PANE_ATTR}="list"], [${CHAT_ROW_ATTR}] > :nth-child(2) { position: relative; }
  .${EDGE_CLASS} { position: absolute; top: 0; bottom: 0; width: 9px; z-index: 5; cursor: col-resize; touch-action: none; }
  /* The list's edge sits half over the chat (the list's scroll bar is at its
     own edge); the details' edge sits inside them (the chat's scroll bar is
     at theirs). */
  .${EDGE_CLASS}[data-pane="list"][data-side="right"] { right: -6px; }
  .${EDGE_CLASS}[data-pane="list"][data-side="left"] { left: -6px; }
  .${EDGE_CLASS}[data-pane="details"][data-side="left"] { left: 0; }
  .${EDGE_CLASS}[data-pane="details"][data-side="right"] { right: 0; }
  .${EDGE_CLASS}::after {
    content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px;
    background: var(--primary-button-background, #0866ff);
    opacity: 0; transition: opacity 0.15s;
  }
  .${EDGE_CLASS}[data-pane="details"][data-side="left"]::after { left: 0; }
  .${EDGE_CLASS}[data-pane="details"][data-side="right"]::after { left: auto; right: 0; }
  .${EDGE_CLASS}:hover::after { opacity: 0.6; transition-delay: 0.15s; }
  .${EDGE_CLASS}.dragging::after { opacity: 0.6; transition-delay: 0s; }
  html[${RESIZING_ATTR}], html[${RESIZING_ATTR}] * { cursor: col-resize !important; -webkit-user-select: none !important; user-select: none !important; }
`;

function storedWidths(): PaneWidths {
  return sanitizePaneWidths(window.__CARRIER_SETTINGS__?.pane_widths);
}

/** Keep the page-side settings snapshot and its reload cache in step with a drag. */
function rememberLocally(widths: PaneWidths) {
  try {
    const settings = window.__CARRIER_SETTINGS__;
    if (settings && typeof settings === "object") settings.pane_widths = { ...widths };
    const cached = JSON.parse(
      localStorage.getItem("__carrier_settings") || "null",
    ) as CarrierSettings | null;
    if (cached && typeof cached === "object" && !Array.isArray(cached)) {
      cached.pane_widths = { ...widths };
      localStorage.setItem("__carrier_settings", JSON.stringify(cached));
    }
  } catch (_) {}
}

/**
 * The flex row whose first child holds the messages and whose second is the
 * details pane (Facebook gives that a minimum width). Facebook adds and drops
 * the details in this row; the row itself stays while the chat is open.
 */
function findChatRow(log: Element, main: Element): HTMLElement | null {
  for (let el: Element | null = log; el && el !== main; el = el.parentElement) {
    const row: Element | null = el.parentElement;
    if (!row || row.children.length < 2 || row.firstElementChild !== el) continue;
    const details = el.nextElementSibling;
    if (!details) continue;
    const style = getComputedStyle(row);
    if (
      style.display === "flex" &&
      style.flexDirection.startsWith("row") &&
      Number.parseFloat(getComputedStyle(details).minWidth) >= 200
    ) {
      return row as HTMLElement;
    }
  }
  return null;
}

export function initPaneResize() {
  let widths = storedWidths();
  const widthStyle = document.createElement("style");
  widthStyle.setAttribute("data-carrier-pane-widths", "");
  const edgeStyle = document.createElement("style");
  edgeStyle.textContent = EDGE_CSS;
  const showWidths = () => {
    widthStyle.textContent = paneWidthCss(widths, SELECTORS);
  };
  showWidths();
  const attachStyles = () => {
    const root = document.documentElement;
    if (!root) return false;
    if (!edgeStyle.isConnected) root.append(edgeStyle);
    if (!widthStyle.isConnected) root.append(widthStyle);
    return true;
  };

  const save = () => {
    showWidths();
    rememberLocally(widths);
    invoke("plugin:event|emit", {
      event: "carrier:pane-widths",
      payload: { list: widths.list, details: widths.details },
    })?.catch?.(() => {});
  };

  const followSettings = () => {
    const next = storedWidths();
    if (next.list === widths.list && next.details === widths.details) return;
    widths = next;
    showWidths();
  };
  window.addEventListener("carrier:settings", followSettings);
  window.addEventListener("carrier:pane-widths", followSettings);

  const chatRow = () => document.querySelector<HTMLElement>(`[${CHAT_ROW_ATTR}]`);
  const chatBox = () =>
    chatRow()?.firstElementChild ?? document.querySelector('[role="main"]') ?? null;

  const startDrag = (event: PointerEvent, edge: HTMLElement) => {
    if (event.button !== 0) return;
    const pane = edge.dataset.pane as Pane;
    const el = edge.parentElement;
    const chat = chatBox();
    if (!el || !chat) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      edge.setPointerCapture(event.pointerId);
    } catch (_) {}
    const startX = event.clientX;
    const startWidth = el.getBoundingClientRect().width;
    const side = edgeSide(el.getBoundingClientRect(), chat.getBoundingClientRect());
    const { min, max } = dragBounds(
      pane,
      startWidth,
      chat.getBoundingClientRect().width,
      Number.parseFloat(getComputedStyle(el).minWidth),
    );
    let width = Math.round(startWidth);
    let frame = 0;
    document.documentElement.setAttribute(RESIZING_ATTR, "");
    edge.classList.add("dragging");
    // Only the dragged pane's own style changes per frame; rewriting a style
    // sheet would restyle the whole page each frame.
    const move = (moveEvent: PointerEvent) => {
      width = dragWidth({ startWidth, startX, x: moveEvent.clientX, side, min, max });
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        el.style.setProperty("flex", `0 0 ${width}px`, "important");
        el.style.setProperty("width", `${width}px`, "important");
        el.style.setProperty("max-width", paneCap(pane), "important");
      });
    };
    const end = () => {
      edge.removeEventListener("pointermove", move);
      edge.removeEventListener("lostpointercapture", end);
      cancelAnimationFrame(frame);
      document.documentElement.removeAttribute(RESIZING_ATTR);
      edge.classList.remove("dragging");
      if (width !== Math.round(startWidth)) {
        widths = { ...widths, [pane]: width };
        save();
      }
      for (const prop of ["flex", "width", "max-width"]) el.style.removeProperty(prop);
    };
    edge.addEventListener("pointermove", move);
    edge.addEventListener("lostpointercapture", end);
  };

  const makeEdge = (pane: Pane) => {
    const edge = document.createElement("div");
    edge.className = EDGE_CLASS;
    edge.dataset.pane = pane;
    edge.setAttribute("aria-hidden", "true");
    edge.addEventListener("pointerdown", (event) => startDrag(event, edge));
    edge.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (widths[pane] === null) return;
      widths = { ...widths, [pane]: null };
      save();
    });
    return edge;
  };
  const edges: Record<Pane, HTMLElement> = { list: makeEdge("list"), details: makeEdge("details") };

  const placeEdge = (pane: Pane, host: Element | null, chat: Element | null) => {
    const edge = edges[pane];
    if (!host || !chat) {
      edge.remove();
      return;
    }
    if (edge.parentElement !== host) host.append(edge);
    const side = edgeSide(host.getBoundingClientRect(), chat.getBoundingClientRect());
    if (edge.dataset.side !== side) edge.dataset.side = side;
  };

  // Finding the chat row reads computed styles, so it is looked for once per
  // chat (per message log) and again after a click or resize, not every tick.
  let searchedLog: Element | null = null;
  let sidesStale = true;
  const sync = () => {
    if (document.hidden || !attachStyles()) return;
    if (!isMessengerContentPath(location.pathname)) {
      edges.list.remove();
      edges.details.remove();
      return;
    }
    const main = document.querySelector('[role="main"]');
    const list =
      main?.parentElement?.querySelector<HTMLElement>(':scope > [role="navigation"]') ?? null;
    if (list && list.getAttribute(PANE_ATTR) !== "list") {
      for (const old of document.querySelectorAll(`[${PANE_ATTR}="list"]`)) {
        old.removeAttribute(PANE_ATTR);
      }
      list.setAttribute(PANE_ATTR, "list");
      sidesStale = true;
    }
    const log = main?.querySelector('[role="log"]') ?? null;
    let row = chatRow();
    if (main && log && !row?.contains(log) && log !== searchedLog) {
      searchedLog = log;
      const found = findChatRow(log, main);
      if (found && found !== row) {
        row?.removeAttribute(CHAT_ROW_ATTR);
        found.setAttribute(CHAT_ROW_ATTR, "");
        row = found;
        sidesStale = true;
      }
    }
    const details =
      row && log && row.contains(log) && row.children.length > 1 ? row.children[1]! : null;
    const listMoved = list !== null && edges.list.parentElement !== list;
    const detailsMoved = details !== null && edges.details.parentElement !== details;
    if (
      !sidesStale &&
      !listMoved &&
      !detailsMoved &&
      (details !== null) === edges.details.isConnected
    ) {
      return;
    }
    sidesStale = false;
    placeEdge("list", list, main);
    placeEdge("details", details, row?.firstElementChild ?? null);
  };

  setInterval(sync, 1000);
  document.addEventListener(
    "click",
    () => {
      searchedLog = null;
      setTimeout(sync, 50);
      setTimeout(sync, 400);
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "resize",
    () => {
      searchedLog = null;
      sidesStale = true;
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", sync);
}
