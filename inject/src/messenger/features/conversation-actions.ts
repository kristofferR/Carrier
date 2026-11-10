/* ----------------- Conversation & composer shortcuts ------------------ */
// Caprine-parity actions (Ref #18, #30). Messenger is a minified React SPA
// with no callable API, so each action is either a plain DOM op
// (focus/navigate) or a click on Messenger's own control, found by the
// component that rendered it, which is the same in every language. Every
// lookup bails quietly when the control is missing — Facebook reshuffles its
// markup often, and none of these exist on the login page.
import { emojiGlyph, SYSTEM_EMOJI_GLYPH_ATTR } from "../lib/emoji";
import { pageRequire } from "../lib/facebook-loader";
import {
  ancestors,
  fiberOf,
  moduleExport,
  propsOf,
  renderDepth,
  renders,
} from "../lib/react-fiber";
import { SEPARATOR_RE } from "../lib/threads";

export function isShown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function firstShown<E extends Element = HTMLElement>(
  sel: string,
  root?: ParentNode,
): E | null {
  for (const el of (root || document).querySelectorAll<E>(sel)) if (isShown(el)) return el;
  return null;
}

/**
 * The shown button in `root` that one of Messenger's `components` rendered:
 * a module's default export, or `[module, export]` for a named one. The one
 * closest to its component wins: an open popover's own buttons sit further
 * down the same component.
 */
export function componentButton(
  components: readonly (string | readonly [string, string])[],
  root: ParentNode,
): HTMLElement | null {
  const load = pageRequire();
  const rendered = components
    .map((ref) => (typeof ref === "string" ? moduleExport(load, ref) : moduleExport(load, ...ref)))
    .filter((c) => c != null);
  if (!rendered.length) return null;
  let best: HTMLElement | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const el of root.querySelectorAll<HTMLElement>('[role="button"], button')) {
    for (const component of rendered) {
      const depth = renderDepth(el, component, load);
      if (depth !== null && depth < bestDepth && isShown(el)) {
        best = el;
        bestDepth = depth;
      }
    }
  }
  return best;
}

/** An element's text, with Facebook's emoji images read back as emoji. A
 * group named "Trip 🏔️" otherwise reads as "Trip". System Emoji's glyphs
 * repeat those images, so they're skipped. */
function textWithEmoji(el: Element): string {
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) {
      if (!node.parentElement?.closest(`[${SYSTEM_EMOJI_GLYPH_ATTR}]`)) text += node.data;
    } else if (node instanceof HTMLImageElement) {
      text += emojiGlyph(node.getAttribute("alt"));
    }
  }
  return text;
}

/** A chat-list row's display name, from its link or anything around it.
 * Facebook's class names are hashed and unstable, so take the row's first
 * span with real text: the name renders before the preview and timestamp. */
export function chatRowName(el: Element): string {
  const row = el.closest('[role="row"]') || el;
  for (const span of row.querySelectorAll("span")) {
    const text = textWithEmoji(span).replace(/\s+/g, " ").trim();
    if (text && !SEPARATOR_RE.test(text)) return [...text].slice(0, 60).join("");
  }
  return "";
}

// Visible conversation links in the left chat list, in list order.
export function chatRows(): HTMLAnchorElement[] {
  const seen = new Set<string>();
  const out: HTMLAnchorElement[] = [];
  for (const a of document.querySelectorAll<HTMLAnchorElement>(
    '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]',
  )) {
    const href = a.getAttribute("href");
    if (!href || seen.has(href)) continue;
    const r = a.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // skip hidden
    seen.add(href);
    out.push(a);
  }
  return out;
}

// Open the previous/next conversation relative to the one on screen.
export function stepConversation(delta: number) {
  const rows = chatRows();
  if (!rows.length) return;
  const m = location.pathname.match(/\/t\/([^/]+)/);
  const idx = m ? rows.findIndex((a) => (a.getAttribute("href") || "").includes(`/t/${m[1]}`)) : -1;
  // No active row (e.g. on the requests view): start from the top or bottom.
  const nextIdx =
    idx === -1 ? (delta > 0 ? 0 : rows.length - 1) : (idx + delta + rows.length) % rows.length;
  rows[nextIdx]?.click();
}

export function focusChatSearch(): boolean {
  const input =
    firstShown<HTMLInputElement>('[role="navigation"] input[type="search"]') ||
    firstShown<HTMLInputElement>('input[type="search"]');
  if (input) {
    input.focus();
    input.select();
  }
  return !!input;
}

export function focusComposer(): boolean {
  const box =
    firstShown('[role="main"] [contenteditable="true"][role="textbox"]') ||
    firstShown('[contenteditable="true"][data-lexical-editor="true"]');
  box?.focus();
  return !!box;
}

// The info sidebar's Search circle: MWInboxInfoQuickActions' circle button
// with the magnifying-glass icon. It only exists while the sidebar is open.
function searchInConvoButton(): HTMLElement | null {
  const load = pageRequire();
  const glass = moduleExport(load, "FBNucleusMagnifyingGlassFilled16Icon.react");
  const quickActions = moduleExport(load, "MWInboxInfoQuickActions.react");
  if (glass == null || quickActions == null) return null;
  for (const el of document.querySelectorAll<HTMLElement>('[role="button"][aria-label]')) {
    if (!isShown(el)) continue;
    let searchIcon = false;
    for (const fiber of ancestors(fiberOf(el, load), 40)) {
      searchIcon ||= propsOf(fiber).icon === glass;
      if (searchIcon && renders(fiber, quickActions)) return el;
    }
  }
  return null;
}

export function searchInConversation(): boolean {
  window.__chatpaneWakeSearchIndex?.();
  const btn = searchInConvoButton();
  if (btn) {
    btn.click();
    return true;
  }
  // The control only exists inside the conversation-info sidebar: open that
  // first, then click Search once React has rendered the panel.
  if (typeof window.__chatpaneToggleInfo !== "function" || !window.__chatpaneToggleInfo())
    return false;
  let tries = 0;
  const timer = setInterval(() => {
    const b = searchInConvoButton();
    if (b) {
      clearInterval(timer);
      b.click();
    } else if (++tries >= 40) {
      clearInterval(timer);
    }
  }, 50);
  return true;
}

// Composer controls live in the open thread's footer; scope to [role=main]
// so chat-list controls can't match.
function clickComposerButton(components: readonly string[]): boolean {
  const root = document.querySelector('[role="main"]');
  const btn = root && componentButton(components, root);
  btn?.click();
  return !!btn;
}
// Each control in Messenger's composer and in its newer MWX composer.
export const EMOJI_BUTTONS = ["MWV2ComposerEmojiButton.react", "MWXComposerEmojiButton.react"];
export const openEmojiPicker = () => clickComposerButton(EMOJI_BUTTONS);
export const openGifPicker = () =>
  clickComposerButton(["MWV2ComposerGifButton.react", "MWXComposerGifButton.react"]);
export const attachFiles = () =>
  clickComposerButton(["MWV2ComposerFileButton.react", "MWXComposerAddFileButton.react"]);

export function newConversation(): boolean {
  // Prefer Messenger's own compose control (SPA navigation, no reload)…
  const link = firstShown<HTMLAnchorElement>('a[href*="/messages/new"]');
  if (link) {
    link.click();
    return true;
  }
  // …falling back to the compose route (full page load).
  location.assign("/messages/new/");
  return true;
}
