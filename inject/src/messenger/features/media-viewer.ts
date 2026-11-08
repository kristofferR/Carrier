/* -------------------- Image / video zoom + pan viewer ----------------- */
// Double-click a message image or video, or pinch it on a macOS trackpad, to
// enter a zoom/pan overlay:
//   wheel or pinch = zoom, drag or arrow keys = pan, Esc / click-away = exit.
import { MIN_SCALE, wheelZoomFactor, zoomAround } from "../lib/media-zoom";

let zoomActive = false;

/** Whether the zoom overlay is open (it owns Escape then). */
export const isMediaZoomActive = () => zoomActive;

// WebKit's (macOS) pinch events; TypeScript's DOM types don't include them.
type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

export function initMediaViewer() {
  const PAN = 40;
  let target: HTMLElement | null = null;
  let targetCssText = "";
  let targetTabIndex: string | null = null;
  let previousFocus: HTMLElement | null = null;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let active = false;
  let dragging = false;
  let sx = 0;
  let sy = 0;
  let stx = 0;
  let sty = 0;
  // A real Ctrl key is down: a Ctrl + wheel without one is a WebView2 pinch.
  let ctrlKeyHeld = false;
  // A WebKit pinch in progress, and the scale it started from.
  let pinching = false;
  let pinchFrom = 1;

  function pickTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const t = target;
    const video = t.closest("video") || t.closest("div")?.querySelector("video");
    if (video) return video;
    const img = t.closest("img[alt]") as HTMLImageElement | null;
    if (!img) return null;
    const src = img.currentSrc || img.src || "";
    // Skip emoji / sticker sprites and data URIs.
    if (src.startsWith("data:") || src.includes("stp=dst-png_s")) return null;
    return img;
  }

  function render(animated = true) {
    if (!target) return;
    const reset = scale === 1 && tx === 0 && ty === 0;
    target.style.transition =
      !animated || dragging ? "none" : "transform .15s cubic-bezier(0,0,.2,1)";
    target.style.transformOrigin = "center center";
    target.style.zIndex = reset ? "" : "1000";
    target.style.maxWidth = reset ? "" : "none";
    target.style.maxHeight = reset ? "" : "none";
    target.style.transform = reset ? "" : `translate(${tx}px,${ty}px) scale(${scale})`;
    target.style.cursor = reset ? "zoom-in" : dragging ? "grabbing" : "grab";
  }

  function zoomTo(next: number, x: number, y: number, animated = true) {
    if (!target) return;
    ({ scale, tx, ty } = zoomAround({ scale, tx, ty }, next, x, y, target.getBoundingClientRect()));
    render(animated);
  }

  function exit() {
    if (!active) return;
    active = false;
    zoomActive = false;
    pinching = false;
    handlers.forEach(([t, f, o]) => {
      document.removeEventListener(t, f, o);
    });
    const closedTarget = target;
    if (closedTarget) {
      closedTarget.style.cssText = targetCssText;
      if (targetTabIndex === null) closedTarget.removeAttribute("tabindex");
      else closedTarget.setAttribute("tabindex", targetTabIndex);
    }
    target = null;
    targetCssText = "";
    targetTabIndex = null;
    scale = 1;
    tx = 0;
    ty = 0;
    dragging = false;
    previousFocus?.focus({ preventScroll: true });
    previousFocus = null;
  }

  // Added only while the overlay is open: a wheel listener that may cancel
  // scrolling makes WebKit hold the first event of every scroll gesture.
  const onWheel = (e: WheelEvent) => {
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // A WebKit pinch zooms through its gesture events.
    if (pinching) return;
    const factor = wheelZoomFactor({
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
      ctrlKeyHeld,
    });
    zoomTo(scale * factor, e.clientX, e.clientY, !e.ctrlKey && Math.abs(e.deltaY) >= 50);
  };
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0 || scale <= 1 || !target?.contains(e.target as Node)) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    stx = tx;
    sty = ty;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onMove = (e: MouseEvent) => {
    ctrlKeyHeld = e.ctrlKey;
    if (!dragging) return;
    tx = stx + (e.clientX - sx);
    ty = sty + (e.clientY - sy);
    render();
  };
  const onUp = () => {
    dragging = false;
    render();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    ctrlKeyHeld = e.ctrlKey;
  };
  const onKey = (e: KeyboardEvent) => {
    ctrlKeyHeld = e.ctrlKey;
    if (e.key === "Escape") return exit();
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopImmediatePropagation();
      target?.focus({ preventScroll: true });
      return;
    }
    const d = {
      ArrowLeft: [PAN, 0],
      ArrowRight: [-PAN, 0],
      ArrowUp: [0, PAN],
      ArrowDown: [0, -PAN],
    }[e.key];
    if (d && scale > 1) {
      e.preventDefault();
      e.stopImmediatePropagation();
      tx += d[0]!;
      ty += d[1]!;
      render();
    }
  };
  const onClick = (e: MouseEvent) => {
    if (active && target && !target.contains(e.target as Node)) exit();
  };

  const handlers: [string, EventListener, AddEventListenerOptions][] = [
    ["wheel", onWheel as EventListener, { passive: false, capture: true }],
    ["mousedown", onDown as EventListener, { capture: true }],
    ["mousemove", onMove as EventListener, { capture: true }],
    ["mouseup", onUp as EventListener, { capture: true }],
    ["keydown", onKey as EventListener, { capture: true }],
    ["keyup", onKeyUp as EventListener, { capture: true, passive: true }],
    ["click", onClick as EventListener, { capture: true }],
  ];

  function enter(t: HTMLElement) {
    active = true;
    zoomActive = true;
    target = t;
    targetCssText = t.style.cssText;
    targetTabIndex = t.getAttribute("tabindex");
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    t.setAttribute("tabindex", "-1");
    scale = 1;
    tx = 0;
    ty = 0;
    t.focus({ preventScroll: true });
    handlers.forEach(([type, f, o]) => {
      document.addEventListener(type, f, o);
    });
  }

  document.addEventListener(
    "dblclick",
    (e) => {
      const t = pickTarget(e.target);
      if (!t) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (active) return exit();
      enter(t);
      zoomTo(2, e.clientX, e.clientY, false);
    },
    { capture: true },
  );

  // A trackpad pinch on macOS arrives as WebKit gesture events (WebView2 and
  // WebKitGTK don't send them). Over a photo it opens the overlay; once open
  // it zooms around the fingers; elsewhere it is left alone.
  document.addEventListener(
    "gesturestart",
    (event) => {
      const e = event as GestureEvent;
      if (!active) {
        const t = pickTarget(e.target);
        if (!t) return;
        enter(t);
      }
      e.preventDefault();
      pinching = true;
      pinchFrom = scale;
    },
    { capture: true },
  );
  document.addEventListener(
    "gesturechange",
    (event) => {
      if (!pinching) return;
      const e = event as GestureEvent;
      e.preventDefault();
      zoomTo(pinchFrom * e.scale, e.clientX, e.clientY, false);
    },
    { capture: true },
  );
  document.addEventListener(
    "gestureend",
    (event) => {
      if (!pinching) return;
      event.preventDefault();
      pinching = false;
      // Pinching back to fit ends the zoom.
      if (scale <= MIN_SCALE) exit();
    },
    { capture: true },
  );
}
