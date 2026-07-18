/* ------------------ Facebook optional-cookie refusal ------------------ */
import { rgb } from "../lib/color";
import { lowestScoreIndex, qualifiesCookieActionRow } from "../lib/login-page";

export const COOKIE_TEXT_RE =
  /\b(cookie|cookies)\b|informasjonskapsl|tillat alle informasjonskapsler|avvis valgfrie informasjonskapsler/i;
export const COOKIE_ACTION_RE =
  /allow all|reject optional|accept all|decline optional|tillat alle|avvis valgfrie|godta alle|avsl[aå] valgfrie/i;

export const hasCookieConsentText = (el: Element) => {
  const text = (el.textContent || "").replace(/\s+/g, " ").slice(0, 4000);
  if (!COOKIE_TEXT_RE.test(text)) return false;
  return COOKIE_ACTION_RE.test(text) || /privacy|personvern|Meta|Facebook/i.test(text);
};

// `aria-labelledby` holds space-separated element IDs, not label text, so its
// accessible name is the text of the referenced elements. Resolve them (capped
// so a stray huge target can't drive the regex) and fold that in with the direct
// `aria-label` text — matching the raw ID tokens would miss externally labelled
// consent dialogs and let required login UI slip through.
const accessibleLabelText = (el: Element) => {
  let text = el.getAttribute("aria-label") || "";
  const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  const doc = el.ownerDocument;
  for (const id of ids) {
    text += ` ${doc?.getElementById(id)?.textContent || ""}`;
  }
  return text.slice(0, 4000);
};

export const hasCookieConsentLabel = (el: Element) => {
  const matches = (text: string) => COOKIE_TEXT_RE.test(text) || COOKIE_ACTION_RE.test(text);
  if (matches(accessibleLabelText(el))) return true;

  for (const node of el.querySelectorAll?.("[aria-label], [aria-labelledby]") || []) {
    if (matches(accessibleLabelText(node))) return true;
  }
  return false;
};

export const hasCookieConsentContext = (el: Element) =>
  hasCookieConsentText(el) || hasCookieConsentLabel(el);

export const onFacebookHost = () => /(^|\.)facebook\.com$/i.test(location.hostname);

export const onFacebookLoginSurface = () =>
  onFacebookHost() &&
  (/\/login(?:\.php)?$/i.test(location.pathname) ||
    location.pathname === "/" ||
    !!document.querySelector('input[name="email"], input[name="pass"], input[type="password"]'));

const visibleBox = (el: Element | null | undefined) => {
  if (el?.nodeType !== 1) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const s = getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden") return null;
  return r;
};

const primaryBlueScore = (el: Element) => {
  let best = 0;
  for (
    let cur: Element | null = el;
    cur && cur !== document.documentElement;
    cur = cur.parentElement
  ) {
    const c = rgb(getComputedStyle(cur).backgroundColor);
    if (!c || c.a < 0.35) continue;
    best = Math.max(best, c.b - Math.max(c.r, c.g) + Math.max(0, c.b - 120));
    if (c.a > 0.9) break;
  }
  return best;
};

const actionButtonsIn = (root: Element | Document) => {
  const selector = 'button, [role="button"]';
  const buttons: HTMLElement[] = [];
  if ((root as Element).matches?.(selector)) buttons.push(root as HTMLElement);
  buttons.push(...(root.querySelectorAll?.<HTMLElement>(selector) || []));
  return buttons.filter((button) => {
    if (button.closest('[aria-hidden="true"]')) return false;
    const r = visibleBox(button);
    if (!r || r.width < 90 || r.height < 28) return false;
    if ((button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true")
      return false;
    if (button.hasAttribute("aria-expanded")) return false;
    if (button.getAttribute("aria-haspopup")) return false;
    return true;
  });
};

const bottomActionRow = (root: Element) => {
  const rootRect = visibleBox(root);
  if (!rootRect) return null;
  const buttons = actionButtonsIn(root)
    .map((button) => ({ button, rect: button.getBoundingClientRect() }))
    .sort((a, b) => a.rect.top - b.rect.top);
  const rows: { center: number; items: { button: HTMLElement; rect: DOMRect }[] }[] = [];
  for (const item of buttons) {
    const center = item.rect.top + item.rect.height / 2;
    let row = rows.find((candidate) => Math.abs(candidate.center - center) < 24);
    if (!row) {
      row = { center, items: [] };
      rows.push(row);
    }
    row.items.push(item);
    row.center =
      row.items.reduce((sum, i) => sum + i.rect.top + i.rect.height / 2, 0) / row.items.length;
  }

  return rows
    .filter((row) => row.items.length >= 2)
    .map((row) => ({
      ...row,
      bottom: Math.max(...row.items.map((i) => i.rect.bottom)),
      primaryScore: Math.max(...row.items.map((i) => primaryBlueScore(i.button))),
    }))
    .filter((row) =>
      qualifiesCookieActionRow(row.items.map((item) => primaryBlueScore(item.button))),
    )
    .sort((a, b) => b.bottom - a.bottom)[0]?.items;
};

export function findOptionalCookieDeclineButton(
  root: Element | Document = document,
): HTMLElement | null {
  if (!onFacebookLoginSurface()) return null;
  const roots = new Set<Element>();
  for (const button of actionButtonsIn(root)) {
    let node = button.parentElement;
    for (
      let depth = 0;
      node && node !== document.body && depth < 12;
      depth++, node = node.parentElement
    ) {
      const row = bottomActionRow(node);
      if (
        row?.length === 2 &&
        hasCookieConsentContext(node) &&
        !node.querySelector?.('input[name="email"], input[name="pass"], input[type="password"]')
      ) {
        roots.add(node);
      }
    }
  }

  const candidates = [...roots].sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return ar.width * ar.height - br.width * br.height;
  });
  for (const candidate of candidates) {
    const row = bottomActionRow(candidate);
    if (!row) continue;
    const target = lowestScoreIndex(row.map((item) => primaryBlueScore(item.button)));
    if (target !== null) return row[target]!.button;
  }
  return null;
}

export function initCookieAutoDecline() {
  if (!onFacebookHost()) return;
  let done = false;
  let scheduled = false;
  let retryTimer = 0;
  const deadline = Date.now() + 60000;
  let observer: MutationObserver | undefined;

  const stop = () => {
    observer?.disconnect();
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = 0;
    }
  };

  const decline = (button: HTMLElement) => {
    done = true;
    document.documentElement.setAttribute("data-carrier-cookie-decline", "attempted");
    stop();
    button.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }),
    );
    button.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }),
    );
    button.click();
  };

  const scan = () => {
    scheduled = false;
    if (done) return;
    const button = findOptionalCookieDeclineButton();
    if (button) {
      decline(button);
    } else if (Date.now() < deadline && !retryTimer) {
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        schedule();
      }, 250);
    } else if (Date.now() >= deadline) {
      stop();
    }
  };

  const schedule = () => {
    if (scheduled || done) return;
    scheduled = true;
    requestAnimationFrame(scan);
  };

  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-checked", "aria-expanded", "class", "role", "style"],
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  }
  window.addEventListener("pageshow", schedule);
  schedule();
}
