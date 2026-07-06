/* ----------------------- Login page tidy-up --------------------------- */
// On the logged-out page, hide Facebook's marketing collage and centre the
// login box, so the window shows just the login form.
import { isLightFill } from "../lib/color";
import { findOptionalCookieDeclineButton, onFacebookHost } from "./cookie-consent";

const HIDE = "data-carrier-hide";
const COL = "data-carrier-login-col";
const ANC = "data-carrier-login-anc";
const FORM = "data-carrier-login-form";
const CARD = "data-carrier-login-card";
const REQUIRED = "data-carrier-login-required";
const FOOTER = "data-carrier-login-footer";
const FOOTER_KEEP = "data-carrier-login-footer-keep";
const FOOTER_LINKS = "data-carrier-login-footer-links";
const LANGUAGES = "data-carrier-login-languages";
const LANGUAGE_LINK = "data-carrier-login-language-link";

export function initLoginTidy() {
  let scheduled = false;
  let tidyObserver: MutationObserver | null = null;

  const prefersDark = () => !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  // Follow the forced theme (Settings → Theme) when set, else the system. FB's
  // login page ships only a light theme, so this drives our dark swap.
  const wantDark = () => {
    const t = window.__CARRIER_SETTINGS__?.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return prefersDark();
  };

  // Only Facebook's own login page — not the in-app OAuth provider pages
  // (Google/Apple/Microsoft), which also have password fields.
  const COOKIE_TEXT_RE =
    /\b(cookie|cookies)\b|informasjonskapsl|tillat alle informasjonskapsler|avvis valgfrie informasjonskapsler/i;
  const COOKIE_ACTION_RE =
    /allow all|reject optional|accept all|decline optional|tillat alle|avvis valgfrie|godta alle|avsl[aå] valgfrie/i;

  const hasCookieConsentText = (el: Element) => {
    const text = (el.textContent || "").replace(/\s+/g, " ").slice(0, 4000);
    if (!COOKIE_TEXT_RE.test(text)) return false;
    return COOKIE_ACTION_RE.test(text) || /privacy|personvern|Meta|Facebook/i.test(text);
  };

  const hasCookieConsentLabel = (el: Element) => {
    const ownAria = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("aria-labelledby") || ""}`;
    if (COOKIE_TEXT_RE.test(ownAria) || COOKIE_ACTION_RE.test(ownAria)) return true;

    const nodes = el.querySelectorAll?.("[aria-label], [aria-labelledby]") || [];
    for (const node of nodes) {
      const aria = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("aria-labelledby") || ""}`;
      if (COOKIE_TEXT_RE.test(aria) || COOKIE_ACTION_RE.test(aria)) return true;
    }
    return false;
  };

  const isRequiredLoginUi = (el: Element | null): boolean => {
    if (el?.nodeType !== 1) return false;
    if (el === document.documentElement || el === document.body) return false;
    const role = el.getAttribute("role");
    if (role === "dialog" || role === "alertdialog") return true;
    if (el.querySelector?.('[role="dialog"], [role="alertdialog"]')) return true;
    if (findOptionalCookieDeclineButton(el)) return true;
    return hasCookieConsentLabel(el) || hasCookieConsentText(el);
  };

  const restoreRequiredLoginUi = () => {
    for (const el of document.querySelectorAll(`[${HIDE}], [${REQUIRED}]`)) {
      if (isRequiredLoginUi(el)) {
        el.removeAttribute(HIDE);
        el.setAttribute(REQUIRED, "");
      } else {
        el.removeAttribute(REQUIRED);
      }
    }
  };

  const clearFooterMarks = () => {
    document.querySelectorAll(`[${FOOTER}]`).forEach((el) => el.removeAttribute(FOOTER));
    document.querySelectorAll(`[${FOOTER_KEEP}]`).forEach((el) => el.removeAttribute(FOOTER_KEEP));
    document
      .querySelectorAll(`[${FOOTER_LINKS}]`)
      .forEach((el) => el.removeAttribute(FOOTER_LINKS));
    document.querySelectorAll(`[${LANGUAGES}]`).forEach((el) => el.removeAttribute(LANGUAGES));
    document
      .querySelectorAll(`[${LANGUAGE_LINK}]`)
      .forEach((el) => el.removeAttribute(LANGUAGE_LINK));
  };

  const FOOTER_NOISE_RE =
    /registrer|logg inn|messenger|facebook|lite|video|meta(?:\s|$)|instagram|threads|quest|ray-ban|personvern|privacy|cookie|informasjonskaps|annonse|annonsevalg|utviklere|developer|jobber|hjelp|help|betingelser|terms|opplasting/i;

  const isLanguageFooterLink = (link: Element) => {
    if (link.hasAttribute(LANGUAGE_LINK)) return true;
    const href = (link.getAttribute("href") || "").trim();
    return href === "#" || href.endsWith("#");
  };

  const isFooterNoiseLink = (link: Element) =>
    FOOTER_NOISE_RE.test((link.textContent || "").replace(/\s+/g, " ").trim());

  // Facebook's footer language switcher is a row of locale links whose href is
  // just "#" (they swap the page locale via JS). Identify them by that — NOT by
  // on-screen geometry — so detection still works before the strip has been
  // laid out, and even if a previous pass had hidden it (geometry-based
  // detection was the bug: it failed on the FDSIntlLocaleSelectorList variant
  // that has no #pageFooter, then the strip got swept into the hidden chrome).
  const topLanguageLinks = (links: Element[]) => {
    const langs = links.filter((link) => isLanguageFooterLink(link) && !isFooterNoiseLink(link));
    return langs.length >= 2 ? langs : [];
  };

  const linksOutside = (root: Element, inner: Element) =>
    [...(root.querySelectorAll?.("a[href]") || [])].filter((link) => !inner.contains(link));

  const isFooterContainer = (el: Element | null, inner: Element) => {
    if (!el?.querySelector) return false;
    if (el.querySelector("#pageFooter, .localeSelectorList")) return true;
    const links = linksOutside(el, inner);
    return (
      links.length >= 6 &&
      (topLanguageLinks(links).length >= 2 || links.filter(isLanguageFooterLink).length >= 2)
    );
  };

  const commonAncestor = (nodes: Element[]) => {
    let root: Element | null | undefined = nodes[0];
    while (root && !nodes.every((node) => root!.contains(node))) root = root.parentElement;
    return root;
  };

  // Keep the language switcher visible (pinned across the bottom by CSS) and
  // exempt it from the chrome-hiding pass. `languageRoot` is the smallest box
  // holding every locale link; `footer` is the highest ancestor that doesn't
  // also contain the login column — i.e. the sibling branch the hide pass would
  // otherwise blank out. Marking that branch FOOTER tells the hide pass to keep
  // it; the inner chain is FOOTER_KEEP (display:contents) so only the strip
  // itself paints.
  const keepLanguageStrip = (col: Element, languageLinks: Element[]) => {
    const languageRoot = commonAncestor(languageLinks);
    if (!languageRoot || languageRoot === document.body || languageRoot.contains(col)) return;
    let footer = languageRoot;
    while (
      footer.parentElement &&
      footer.parentElement !== document.body &&
      !footer.parentElement.contains(col)
    ) {
      footer = footer.parentElement;
    }
    languageLinks.forEach((link) => link.setAttribute(LANGUAGE_LINK, ""));
    languageRoot.setAttribute(LANGUAGES, "");
    footer.setAttribute(FOOTER, "");
    for (let node: Element | null = footer; node; node = node.parentElement) {
      node.removeAttribute(HIDE);
      node.removeAttribute(FOOTER_LINKS);
      if (node !== footer && node !== languageRoot) node.setAttribute(FOOTER_KEEP, "");
      if (node === languageRoot) break;
    }
  };

  const tidyFooter = (col: Element) => {
    clearFooterMarks();
    const allLinks = [...document.querySelectorAll("a[href]")].filter(
      (link) => !col.contains(link),
    );
    const languageLinks = topLanguageLinks(allLinks);
    const languageSet = new Set(languageLinks);
    if (languageLinks.length >= 2) keepLanguageStrip(col, languageLinks);

    // Hide every other footer anchor (Register, privacy, Meta family, app
    // links, …) and the Meta copyright line — everything but the languages.
    for (const link of allLinks) {
      if (languageSet.has(link) || link.hasAttribute(LANGUAGE_LINK)) continue;
      (link.closest("li") || link).setAttribute(FOOTER_LINKS, "");
    }
    for (const el of document.body.querySelectorAll("div, span")) {
      if (el.contains(col) || col.contains(el)) continue;
      if (languageLinks.some((link) => el.contains(link))) continue;
      if (/(\bMeta\s*©|\bMeta\s+\d{4}\b|©\s*\d{4})/i.test(el.textContent || "")) {
        el.setAttribute(FOOTER_LINKS, "");
      }
    }
  };

  function tidy() {
    const html = document.documentElement;
    // Facebook's logged-out auth interstitials (verify-with-provider /
    // checkpoint / 2FA) render their body copy in near-black even though the
    // page is in Facebook's dark theme, leaving it unreadable. Flag them by URL
    // path so CSS can force the text light. This only sets one of *our* data
    // attributes — it never touches Facebook's own theme class, which is what
    // broke Comet's rendering when we tried swapping the theme directly.
    if (
      onFacebookHost() &&
      /^\/(?:auth_platform|checkpoint|two_factor|two_step|authentication|recover|confirmemail|device-based)/i.test(
        location.pathname,
      )
    ) {
      html.setAttribute("data-carrier-authtext", "");
    } else {
      html.removeAttribute("data-carrier-authtext");
    }
    // The login page has both an identifier and a password field. Checkpoint /
    // re-auth / recovery forms have only a password field, so require both to
    // avoid hiding their required UI.
    const pass = document.querySelector('input[name="pass"]');
    const isLogin = onFacebookHost() && !!pass && !!document.querySelector('input[name="email"]');
    if (!isLogin) {
      if (html.hasAttribute("data-carrier-login")) {
        html.removeAttribute("data-carrier-login");
        document.querySelectorAll(`[${HIDE}]`).forEach((el) => el.removeAttribute(HIDE));
        document.querySelectorAll(`[${COL}]`).forEach((el) => el.removeAttribute(COL));
        document.querySelectorAll(`[${ANC}]`).forEach((el) => el.removeAttribute(ANC));
        document.querySelectorAll(`[${FORM}]`).forEach((el) => el.removeAttribute(FORM));
        document.querySelectorAll(`[${CARD}]`).forEach((el) => el.removeAttribute(CARD));
        document.querySelectorAll(`[${REQUIRED}]`).forEach((el) => el.removeAttribute(REQUIRED));
        clearFooterMarks();
        // Undo our login dark swap so the logged-in app keeps FB's own theme.
        if (html.hasAttribute("data-carrier-darkswap")) {
          html.classList.replace("__fb-dark-mode", "__fb-light-mode");
          html.removeAttribute("data-carrier-darkswap");
        }
      }
      // Once confidently logged in (auth cookie set, not on a checkpoint/2FA
      // interstitial, page fully loaded), stop watching: this observer fires
      // on every DOM mutation forever otherwise, and login surfaces can only
      // come back via a logout — a full navigation that re-injects and
      // re-arms everything.
      if (
        tidyObserver &&
        /\bc_user=/.test(document.cookie) &&
        !html.hasAttribute("data-carrier-authtext") &&
        document.readyState === "complete"
      ) {
        tidyObserver.disconnect();
        tidyObserver = null;
        window.removeEventListener("resize", schedule);
      }
      return;
    }
    html.setAttribute("data-carrier-login", "");
    // Use Facebook's native dark palette on the login page when the system is
    // dark (the login page itself ships only a light theme). Reacts to the
    // system theme changing while the login screen is open.
    const dark = wantDark();
    if (dark && html.classList.contains("__fb-light-mode")) {
      html.classList.replace("__fb-light-mode", "__fb-dark-mode");
      html.setAttribute("data-carrier-darkswap", "");
    } else if (!dark && html.hasAttribute("data-carrier-darkswap")) {
      html.classList.replace("__fb-dark-mode", "__fb-light-mode");
      html.removeAttribute("data-carrier-darkswap");
    }
    const form = pass.closest("form");
    if (!form) return;
    document.querySelectorAll(`[${FORM}]`).forEach((el) => {
      if (el !== form) el.removeAttribute(FORM);
    });
    form.setAttribute(FORM, "");
    let card: Element = form;
    for (let i = 0; i < 4 && card.parentElement; i++) {
      const parent = card.parentElement;
      if (
        parent === document.body ||
        parent.getBoundingClientRect().width >= window.innerWidth * 0.92
      )
        break;
      if (isFooterContainer(parent, form)) break;
      if (linksOutside(parent, form).length > 4) break;
      card = parent;
    }
    document.querySelectorAll(`[${CARD}]`).forEach((el) => {
      if (el !== card) el.removeAttribute(CARD);
    });
    card.setAttribute(CARD, "");
    // Climb to the column that holds the login card (the widest box that
    // still isn't basically the full viewport width).
    let col: Element = card;
    while (
      col.parentElement &&
      col.parentElement !== document.body &&
      col.parentElement.getBoundingClientRect().width < window.innerWidth * 0.92 &&
      !isFooterContainer(col.parentElement, form) &&
      linksOutside(col.parentElement, form).length <= 4
    ) {
      col = col.parentElement;
    }
    document.querySelectorAll(`[${COL}]`).forEach((el) => {
      if (el !== col) el.removeAttribute(COL);
    });
    document.querySelectorAll(`[${ANC}]`).forEach((el) => el.removeAttribute(ANC));
    for (
      let node: Element | null = col;
      node && node !== document.body;
      node = node.parentElement
    ) {
      node.removeAttribute(HIDE);
      node.removeAttribute(FOOTER_LINKS);
    }
    form.querySelectorAll(`[${HIDE}], [${FOOTER_LINKS}]`).forEach((el) => {
      el.removeAttribute(HIDE);
      el.removeAttribute(FOOTER_LINKS);
    });
    if (!col.hasAttribute(COL)) col.setAttribute(COL, "");
    html.setAttribute("data-carrier-login-vw", String(Math.round(window.innerWidth)));
    html.setAttribute("data-carrier-login-vh", String(Math.round(window.innerHeight)));
    html.setAttribute(
      "data-carrier-login-col-w",
      String(Math.round(col.getBoundingClientRect().width)),
    );
    html.setAttribute(
      "data-carrier-login-card-w",
      String(Math.round(card.getBoundingClientRect().width)),
    );
    html.setAttribute(
      "data-carrier-login-form-w",
      String(Math.round(form.getBoundingClientRect().width)),
    );
    restoreRequiredLoginUi();
    tidyFooter(col);
    // Hide every sibling of the login column, up the ancestor chain, and mark
    // the ancestor wrappers so their (often white) backgrounds can be cleared.
    let node: Element | null = col;
    while (node?.parentElement && node !== document.body) {
      for (const sib of node.parentElement.children) {
        if (sib !== node && sib.hasAttribute(FOOTER)) {
          sib.removeAttribute(HIDE);
          continue;
        }
        if (sib !== node && isRequiredLoginUi(sib)) {
          sib.removeAttribute(HIDE);
          sib.setAttribute(REQUIRED, "");
          continue;
        }
        if (sib !== node && !sib.hasAttribute(HIDE) && !sib.hasAttribute(COL)) {
          sib.setAttribute(HIDE, "");
        }
      }
      if (node !== col && !node.hasAttribute(ANC)) node.setAttribute(ANC, "");
      node = node.parentElement;
    }
    // Belt-and-braces: clear any large opaque-light backdrop the ancestor walk
    // didn't catch, so nothing white surrounds the (dark) login card. Undo it
    // first so switching back to light/system restores the white backgrounds.
    for (const el of document.querySelectorAll<HTMLElement>("[data-carrier-cleared-bg]")) {
      el.style.removeProperty("background-color");
      el.removeAttribute("data-carrier-cleared-bg");
    }
    if (dark) {
      const clearLight = (el: HTMLElement) => {
        if (!isLightFill(getComputedStyle(el).backgroundColor)) return;
        el.setAttribute("data-carrier-cleared-bg", "");
        el.style.setProperty("background-color", "transparent", "important");
      };
      // Large light backdrops anywhere — the ancestor wrappers behind the card.
      for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
        const r = el.getBoundingClientRect();
        if (r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.5)
          clearLight(el);
      }
      // Light bands *inside* the login column (e.g. the logo/title header),
      // which the size heuristic above misses at narrow/tall window shapes.
      // Safe: isLightFill only matches near-white opaque fills, so FB's dark
      // inputs and the blue submit button are left untouched.
      for (const el of col.querySelectorAll<HTMLElement>("*")) clearLight(el);
    }
  }

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        tidy();
      } catch (_) {}
    });
  };
  schedule();
  tidyObserver = new MutationObserver(schedule);
  tidyObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("carrier:settings", schedule);
  // The language strip can mount slightly after our first pass, so re-run on
  // resize and a couple of short delays after load (cheap; tidy() no-ops off
  // the login page).
  window.addEventListener("resize", schedule);
  for (const delay of [300, 1200]) setTimeout(schedule, delay);
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", schedule);
  }
}
