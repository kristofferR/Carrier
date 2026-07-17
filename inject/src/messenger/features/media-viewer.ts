/* -------------------- Image / video zoom + pan viewer ----------------- */
// Double-click a message image or video to enter a zoom/pan overlay:
//   wheel = zoom, drag or arrow keys = pan, Esc / click-away = exit.

export function initMediaViewer() {
  const MIN = 1;
  const MAX = 8;
  const STEP = 1.15;
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

  function pickTarget(e: MouseEvent): HTMLElement | null {
    const t = e.target as Element;
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

  function exit() {
    if (!active) return;
    active = false;
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

  const onWheel = (e: WheelEvent) => {
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const r = target.getBoundingClientRect();
    const prev = scale;
    scale = e.deltaY < 0 ? Math.min(MAX, scale * STEP) : Math.max(MIN, scale / STEP);
    if (scale <= 1) {
      tx = 0;
      ty = 0;
    } else {
      const k = scale / prev;
      tx += (e.clientX - (r.left + r.width / 2)) * (1 - k);
      ty += (e.clientY - (r.top + r.height / 2)) * (1 - k);
    }
    render();
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
    if (!dragging) return;
    tx = stx + (e.clientX - sx);
    ty = sty + (e.clientY - sy);
    render();
  };
  const onUp = () => {
    dragging = false;
    render();
  };
  const onKey = (e: KeyboardEvent) => {
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
    ["click", onClick as EventListener, { capture: true }],
  ];

  document.addEventListener(
    "dblclick",
    (e) => {
      const t = pickTarget(e);
      if (!t) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (active) return exit();
      active = true;
      target = t;
      targetCssText = t.style.cssText;
      targetTabIndex = t.getAttribute("tabindex");
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      t.setAttribute("tabindex", "-1");
      const r = t.getBoundingClientRect();
      scale = 2;
      tx = (e.clientX - (r.left + r.width / 2)) * (1 - scale);
      ty = (e.clientY - (r.top + r.height / 2)) * (1 - scale);
      render(false);
      t.focus({ preventScroll: true });
      handlers.forEach(([type, f, o]) => {
        document.addEventListener(type, f, o);
      });
    },
    { capture: true },
  );
}
