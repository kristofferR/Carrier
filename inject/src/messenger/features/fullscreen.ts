/* --------------------------- Fullscreen polyfill ---------------------- */
// Some WebViews don't implement the Fullscreen API the way FB's video player
// expects. Emulate it by promoting the element to a fixed, full-window layer.

export function initFullscreenPolyfill() {
  // Feature-detect at runtime — the lib.dom types claim requestFullscreen
  // always exists, but the WebViews this polyfill targets are the ones without it.
  if (
    document.fullscreenEnabled &&
    (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen
  )
    return;
  let current: HTMLElement | null = null;
  const enter = (el: HTMLElement) => {
    current = el;
    el.dataset.carrierPrevStyle = el.getAttribute("style") || "";
    Object.assign(el.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      zIndex: "2147483647",
      background: "#000",
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  };
  const leave = () => {
    if (current) {
      current.setAttribute("style", current.dataset.carrierPrevStyle || "");
      delete current.dataset.carrierPrevStyle;
      current = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    }
    return Promise.resolve();
  };
  Object.defineProperty(document, "fullscreenElement", { get: () => current, configurable: true });
  Element.prototype.requestFullscreen = function () {
    return enter(this as HTMLElement);
  };
  Element.prototype.webkitRequestFullscreen = Element.prototype.requestFullscreen;
  document.exitFullscreen = leave;
  document.webkitExitFullscreen = leave;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && current) leave();
    },
    true,
  );
}
