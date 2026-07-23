/* ----------------- Conversation & composer shortcuts ------------------ */
// Caprine-parity actions (Ref #18, #30). Messenger is a minified React SPA
// with no callable API, so each action is either a plain DOM op
// (focus/navigate) or a click on Messenger's own control, resolved by stable
// roles and aria-labels. Every lookup bails quietly when the control is
// missing — Facebook reshuffles its markup often, and none of these exist on
// the login page.

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

// The visible button whose aria-label contains any of `needles` (lowercase).
export function buttonByLabel(needles: string[], root?: ParentNode): HTMLElement | null {
  for (const el of (root || document).querySelectorAll<HTMLElement>(
    '[role="button"][aria-label], button[aria-label]',
  )) {
    if (!isShown(el)) continue;
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    if (needles.some((n) => label.includes(n))) return el;
  }
  return null;
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

// The info sidebar's Search circle is labelled just "Search" (and lives
// inside [role=main]; the sidebar is not a complementary landmark). A bare
// "Search" button only exists in main while the sidebar is open, so an exact
// label match doubles as the "is the sidebar open?" check.
function searchInConvoButton(): HTMLElement | null {
  const root = document.querySelector('[role="main"]');
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLElement>('[role="button"][aria-label]')) {
    if (!isShown(el)) continue;
    const label = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    if (label === "search" || label === "search in conversation") return el;
  }
  return null;
}

export function searchInConversation(): boolean {
  window.__carrierWakeSearchIndex?.();
  const btn = searchInConvoButton();
  if (btn) {
    btn.click();
    return true;
  }
  // The control only exists inside the conversation-info sidebar: open that
  // first, then click Search once React has rendered the panel.
  if (typeof window.__carrierToggleInfo !== "function" || !window.__carrierToggleInfo())
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
function clickComposerButton(needles: string[]): boolean {
  const root = document.querySelector('[role="main"]');
  const btn = root && buttonByLabel(needles, root);
  btn?.click();
  return !!btn;
}
export const openEmojiPicker = () => clickComposerButton(["choose an emoji"]);
export const openGifPicker = () => clickComposerButton(["choose a gif"]);
export const attachFiles = () => clickComposerButton(["attach a photo or video", "attach a file"]);

export function newConversation(): boolean {
  // Prefer Messenger's own compose control (SPA navigation, no reload)…
  const link = firstShown<HTMLAnchorElement>('a[href*="/messages/new"]');
  if (link) {
    link.click();
    return true;
  }
  const btn = buttonByLabel(["new message"]);
  if (btn) {
    btn.click();
    return true;
  }
  // …falling back to the compose route (full page load).
  location.assign("/messages/new/");
  return true;
}
