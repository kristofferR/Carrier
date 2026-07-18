/* ---------------------------- System emoji --------------------------- */
// Facebook usually renders emoji as CDN sprites with the Unicode glyph in
// alt/aria-label. When enabled, hide those sprites and insert a native text
// glyph next to each one so the OS emoji font is used instead.
import { EMOJI_SOURCE_RE, emojiGlyph, isReactionMenuShape } from "../lib/emoji";

const SOURCE_ATTR = "data-carrier-emoji-sprite";
const GLYPH_ATTR = "data-carrier-system-emoji-glyph";
const REACTION_ATTR = "data-carrier-reaction-emoji";
const CANDIDATE_SEL = "img[alt], [aria-label]";
const INTERACTIVE_SEL =
  'button, a[href], input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]';

export function initSystemEmoji() {
  const html = document.documentElement;
  let observer: MutationObserver | null = null;
  let pending = false;
  const queuedRoots = new Set<Element>();

  const on = () => window.__CARRIER_SETTINGS__?.system_emoji === true;

  function sourceGlyph(el: Element) {
    if (el?.nodeType !== 1 || el.hasAttribute(GLYPH_ATTR)) return "";
    if (el.matches?.("img[alt]")) {
      const img = el as HTMLImageElement;
      const src = img.currentSrc || img.src || img.getAttribute("src") || "";
      if (!EMOJI_SOURCE_RE.test(src)) return "";
      return emojiGlyph(img.getAttribute("alt"));
    }
    if (el.matches?.(INTERACTIVE_SEL)) return "";
    const label = emojiGlyph(el.getAttribute("aria-label"));
    if (!label) return "";
    const bg = getComputedStyle(el).backgroundImage || "";
    return EMOJI_SOURCE_RE.test(bg) ? label : "";
  }

  function clearGlyph(el: Element) {
    el.__carrierSystemEmojiGlyph?.remove?.();
    el.removeAttribute(SOURCE_ATTR);
    el.removeAttribute("data-carrier-emoji-glyph");
    delete el.__carrierSystemEmojiGlyph;
  }

  function ensureGlyph(el: Element) {
    const glyph = sourceGlyph(el);
    if (!glyph || !el.parentNode) {
      if (el?.hasAttribute?.(SOURCE_ATTR)) clearGlyph(el);
      return;
    }
    el.setAttribute(SOURCE_ATTR, "");
    el.setAttribute("data-carrier-emoji-glyph", glyph);
    let span = el.__carrierSystemEmojiGlyph;
    if (!span?.isConnected) {
      span = document.createElement("span");
      span.setAttribute(GLYPH_ATTR, "");
      span.setAttribute("role", "img");
      el.__carrierSystemEmojiGlyph = span;
      el.after(span);
    }
    if (span.previousSibling !== el) el.after(span);
    if (span.textContent !== glyph) span.textContent = glyph;
    if (span.getAttribute("aria-label") !== glyph) span.setAttribute("aria-label", glyph);
  }

  function scan(root: Element) {
    if (!on() || !root || root.nodeType !== 1) return;
    ensureGlyph(root);
    root.querySelectorAll?.(CANDIDATE_SEL).forEach(ensureGlyph);
  }

  function sweepOrphanGlyphs() {
    for (const glyph of document.querySelectorAll(`[${GLYPH_ATTR}]`)) {
      const source = glyph.previousElementSibling;
      if (
        !source?.hasAttribute(SOURCE_ATTR) ||
        source.__carrierSystemEmojiGlyph !== glyph ||
        !source.isConnected
      ) {
        glyph.remove();
      }
    }
  }

  function markReactionGlyphs() {
    const reactions = new Set<Element>();
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const children = [...menu.children].map((child) => ({
        glyphs: child.querySelectorAll(`[${GLYPH_ATTR}]`).length,
        role: child.getAttribute("role"),
      }));
      if (!isReactionMenuShape(children)) continue;
      menu.querySelectorAll(`[${GLYPH_ATTR}]`).forEach((glyph) => reactions.add(glyph));
    }
    document.querySelectorAll(`[${REACTION_ATTR}]`).forEach((glyph) => {
      if (!reactions.has(glyph)) glyph.removeAttribute(REACTION_ATTR);
    });
    reactions.forEach((glyph) => glyph.setAttribute(REACTION_ATTR, ""));
  }

  function schedule(root: Element = document.documentElement) {
    if (!on()) return;
    queuedRoots.add(root);
    // While the window is hidden, rAF never fires to drain the queue but
    // mutations keep arriving — without a cap the Set would retain every
    // mutated (often since-detached) node until the window is shown again.
    // Past the cap, collapse to one full-document rescan on the next drain.
    if (queuedRoots.size > 50) {
      queuedRoots.clear();
      queuedRoots.add(document.documentElement);
    }
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const roots = [...queuedRoots];
      queuedRoots.clear();
      roots.forEach(scan);
      sweepOrphanGlyphs();
      markReactionGlyphs();
    });
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "attributes") {
          schedule(m.target as Element);
        } else {
          schedule(m.target as Element);
          for (const n of m.addedNodes) schedule(n as Element);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["alt", "aria-label", "src", "style", "role"],
    });
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    pending = false;
    queuedRoots.clear();
    document.querySelectorAll(`[${GLYPH_ATTR}]`).forEach((el) => el.remove());
    document.querySelectorAll(`[${SOURCE_ATTR}]`).forEach((el) => {
      clearGlyph(el);
    });
  }

  const apply = () => {
    html.toggleAttribute("data-carrier-system-emoji", on());
    if (on()) {
      start();
      schedule();
    } else {
      stop();
    }
  };

  apply();
  window.addEventListener("carrier:settings", apply);
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => on() && schedule(), { once: true });
}
