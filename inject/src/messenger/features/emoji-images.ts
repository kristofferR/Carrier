import {
  expandedImageClip,
  FACEBOOK_EMOJI_PATH,
  hasImageArea,
  type ImageRect,
  intersectImageClips,
  intersectsImageClip,
  isFacebookEmojiImage,
} from "../lib/emoji-images";

const PREFETCH_MARGIN = 80;
const SCAN_DELAY_MS = 50;

function rectOf(element: Element): ImageRect {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
}

function visibleClipFor(image: HTMLImageElement): ImageRect {
  let clip: ImageRect = {
    top: -PREFETCH_MARGIN,
    right: innerWidth + PREFETCH_MARGIN,
    bottom: innerHeight + PREFETCH_MARGIN,
    left: -PREFETCH_MARGIN,
  };
  const dialog = image.closest('[role="dialog"]');
  if (!dialog) return clip;

  clip = intersectImageClips(clip, expandedImageClip(rectOf(dialog), PREFETCH_MARGIN));
  let ancestor = image.parentElement;
  while (ancestor && ancestor !== dialog) {
    if (ancestor.scrollHeight > ancestor.clientHeight + 2) {
      clip = intersectImageClips(clip, expandedImageClip(rectOf(ancestor), PREFETCH_MARGIN));
      break;
    }
    ancestor = ancestor.parentElement;
  }
  return clip;
}

/**
 * Facebook eagerly assigns `src` to every emoji in the picker (hundreds of
 * images). Defer those exact URLs, then promote only images near the viewport
 * or the picker's scrollport. Scrolling schedules a throttled follow-up scan.
 */
export function initEmojiImageLoading() {
  const sourceDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  const nativeSetAttribute = HTMLImageElement.prototype.setAttribute;
  if (!sourceDescriptor?.set) return;

  const pending = new Set<HTMLImageElement>();
  let scanTimer: number | undefined;

  const promote = (image: HTMLImageElement) => {
    image.loading = "eager";
    const source = image.currentSrc || image.getAttribute("src") || image.src;
    if (source) sourceDescriptor.set?.call(image, source);
    pending.delete(image);
  };

  const scan = () => {
    scanTimer = undefined;
    for (const image of pending) {
      if (!image.isConnected) {
        pending.delete(image);
        continue;
      }
      const imageRect = rectOf(image);
      if (hasImageArea(imageRect) && intersectsImageClip(imageRect, visibleClipFor(image))) {
        promote(image);
      }
    }
  };

  const scheduleScan = () => {
    if (scanTimer !== undefined) return;
    scanTimer = window.setTimeout(scan, SCAN_DELAY_MS);
  };

  const defer = (image: HTMLImageElement) => {
    image.loading = "lazy";
    pending.add(image);
    scheduleScan();
  };

  try {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: sourceDescriptor.configurable,
      enumerable: sourceDescriptor.enumerable,
      get: sourceDescriptor.get,
      set(this: HTMLImageElement, value: string) {
        if (isFacebookEmojiImage(value)) defer(this);
        return sourceDescriptor.set?.call(this, value);
      },
    });

    HTMLImageElement.prototype.setAttribute = function (name: string, value: string) {
      const emoji = name.toLowerCase() === "src" && isFacebookEmojiImage(value);
      if (emoji) defer(this);
      const result = nativeSetAttribute.call(this, name, value);
      if (emoji) scheduleScan();
      return result;
    };
  } catch (_) {
    return;
  }

  document.addEventListener("scroll", scheduleScan, true);
  window.addEventListener("resize", scheduleScan);

  // Intersection/loading primitives can retain observed images. Carrier uses
  // an explicit set instead and drops detached picker trees immediately.
  new MutationObserver((records) => {
    if (pending.size === 0) return;
    for (const record of records) {
      for (const removed of record.removedNodes) {
        if (removed instanceof HTMLImageElement) {
          pending.delete(removed);
        } else if (removed instanceof Element) {
          for (const image of removed.querySelectorAll<HTMLImageElement>(
            `img[src*="${FACEBOOK_EMOJI_PATH}"]`,
          )) {
            pending.delete(image);
          }
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
