/* ----------------------- In-page Settings button ---------------------- */
// Messenger's chat-list header already has an overflow control and a compose
// button. Add a Carrier-owned gear immediately before the overflow control so
// Settings stays reachable even when the native menu bar is hidden.
import { isMessengerHeaderOverflowControl } from "../lib/settings-button";

const SLOT_ATTR = "data-carrier-settings-slot";
const BUTTON_ATTR = "data-carrier-settings-button";

function findOverflowButton(): HTMLElement | null {
  const buttons = document.querySelectorAll<HTMLElement>(
    `[role="button"][aria-label]:not([${BUTTON_ATTR}]), button[aria-label]:not([${BUTTON_ATTR}])`,
  );
  let iconFallback: HTMLElement | null = null;
  for (const button of buttons) {
    const label = button.getAttribute("aria-label") || "";
    const iconPath = button.querySelector("svg path")?.getAttribute("d") || "";
    if (!isMessengerHeaderOverflowControl(label, iconPath)) continue;
    const rect = button.getBoundingClientRect();
    if (rect.width < 28 || rect.height < 28) continue;
    if (label.trim() === "Settings, help and more") return button;
    if (!iconFallback || rect.top < iconFallback.getBoundingClientRect().top) {
      iconFallback = button;
    }
  }
  return iconFallback;
}

function placementFor(button: HTMLElement): { row: HTMLElement; before: HTMLElement } | null {
  let wrapper = button.parentElement;
  for (let depth = 0; wrapper && depth < 4; depth += 1) {
    const row = wrapper.parentElement;
    if (!row) return null;
    if (row.children.length > 1) return { row, before: wrapper };
    wrapper = row;
  }
  return null;
}

function createGearIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "3");
  svg.appendChild(circle);

  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.5 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z",
  );
  svg.appendChild(path);
  return svg;
}

function createSettingsSlot(): HTMLDivElement {
  const slot = document.createElement("div");
  slot.setAttribute(SLOT_ATTR, "");

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(BUTTON_ATTR, "");
  button.setAttribute("aria-label", "Carrier Settings");
  button.title = "Carrier Settings";
  button.appendChild(createGearIcon());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.__carrierToggleSettings?.();
  });
  slot.appendChild(button);
  return slot;
}

export function initSettingsButton() {
  let scheduled = false;

  const ensureButton = () => {
    scheduled = false;
    if (!location.pathname.startsWith("/messages")) return;
    const overflow = findOverflowButton();
    if (!overflow) return;
    const placement = placementFor(overflow);
    if (!placement) return;

    const slots = Array.from(document.querySelectorAll<HTMLDivElement>(`[${SLOT_ATTR}]`));
    const slot = slots.shift() || createSettingsSlot();
    for (const duplicate of slots) duplicate.remove();
    if (slot.parentElement !== placement.row || slot.nextElementSibling !== placement.before) {
      placement.row.insertBefore(slot, placement.before);
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(ensureButton);
  };

  const start = () => {
    schedule();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
