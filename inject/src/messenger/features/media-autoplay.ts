/* ------------------------ Media autoplay guard ----------------------- */
// Pause video/GIF media that starts without a recent physical user action.
// Messenger renders animated GIFs as videos, so this covers both without
// relying on its frequently-changing class names. A short activation grace
// keeps native and custom play buttons working normally.
import { diag } from "../bridge";
import { shouldSuppressMediaPlay } from "../lib/media-autoplay";

const VIDEO_SELECTOR = "video";

export function initMediaAutoplay() {
  const on = () => window.__CARRIER_SETTINGS__?.stop_media_autoplay === true;
  let lastActivationAt = Number.NEGATIVE_INFINITY;
  let observer: MutationObserver | null = null;

  const noteActivation = (event: Event) => {
    if (event.isTrusted) lastActivationAt = performance.now();
  };
  window.addEventListener("pointerdown", noteActivation, true);
  window.addEventListener("keydown", noteActivation, true);

  const shouldSuppress = () => shouldSuppressMediaPlay(on(), lastActivationAt, performance.now());

  const suppress = (video: HTMLVideoElement, force = false) => {
    if (!on() || (!force && !shouldSuppress())) return;
    video.autoplay = false;
    video.removeAttribute("autoplay");
    if (!video.paused) video.pause();
  };

  const scan = (root: Node, force = false) => {
    if (!on()) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      const element = root as Element;
      if (element.matches(VIDEO_SELECTOR)) suppress(element as HTMLVideoElement, force);
      element
        .querySelectorAll<HTMLVideoElement>(VIDEO_SELECTOR)
        .forEach((video) => suppress(video, force));
    } else if (root === document) {
      document
        .querySelectorAll<HTMLVideoElement>(VIDEO_SELECTOR)
        .forEach((video) => suppress(video, force));
    }
  };

  try {
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (this instanceof HTMLVideoElement && shouldSuppress()) {
        this.autoplay = false;
        this.removeAttribute("autoplay");
        this.pause();
        diag("media.autoplay", "automatic video or GIF playback suppressed");
        return Promise.resolve();
      }
      return originalPlay.call(this);
    };
  } catch (_) {
    diag("media.autoplay.patch", "could not install media playback guard");
  }

  const start = () => {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) scan(node);
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  };

  const stop = () => {
    observer?.disconnect();
    observer = null;
  };

  const apply = () => {
    if (on()) {
      start();
      // Enabling the setting is explicit: pause media already playing even if
      // the last in-page action happened within the normal grace window.
      scan(document, true);
    } else {
      stop();
    }
  };

  apply();
  window.addEventListener("carrier:settings", apply);
}
