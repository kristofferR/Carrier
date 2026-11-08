/* ----------------------- Login page tidy-up --------------------------- */
// On the logged-out page, hide Facebook's marketing collage and centre the
// login box, so the window shows just the login form.
import { isLightFill } from "../lib/color";
import {
  isLanguageFooterLink,
  type LoginLinkDescriptor,
  topLanguageLinkIndexes,
} from "../lib/login-page";
import {
  findOptionalCookieDeclineButton,
  hasCookieConsentContext,
  onFacebookHost,
} from "./cookie-consent";

const HIDE = "data-carrier-hide";
const COL = "data-carrier-login-col";
const ANC = "data-carrier-login-anc";
const FORM = "data-carrier-login-form";
const CARD = "data-carrier-login-card";
const LIGHT_BG = "data-carrier-login-light-bg";
const REQUIRED = "data-carrier-login-required";
const FOOTER = "data-carrier-login-footer";
const FOOTER_KEEP = "data-carrier-login-footer-keep";
const FOOTER_LINKS = "data-carrier-login-footer-links";
const LANGUAGES = "data-carrier-login-languages";
const LANGUAGE_LINK = "data-carrier-login-language-link";
const LOGO = "data-carrier-login-logo";
const LOGIN_REDIRECT = "carrier:login-redirect";
const LOADING = "data-carrier-login-loading";
const LOADER_LIMIT_MS = 15_000;

type LoginRecoveryState = "idle" | "pending" | "settled";

function returnToMessengerAfterLogin(): LoginRecoveryState {
  if (!onFacebookHost()) return "idle";
  const signedIn = /(?:^|;\s*)c_user=[^;]+/.test(document.cookie);
  const hasLoginFields = !!document.querySelector('input[name="email"], input[type="password"]');
  try {
    // Clear the guard after Messenger renders its chat list or another login starts.
    // If Facebook sends /messages straight back home, leave it set to avoid a loop.
    const messengerReady =
      /^\/messages(?:\/|$)/.test(location.pathname) &&
      document.readyState === "complete" &&
      document.querySelector('[role="navigation"] [role="grid"]');
    if (!signedIn || hasLoginFields || messengerReady) {
      sessionStorage.removeItem(LOGIN_REDIRECT);
      return messengerReady ? "settled" : "idle";
    }
    if (
      ["/", "/home.php"].includes(location.pathname) &&
      document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], form')
    ) {
      // Required UI may explain the bounce. Retry only after it has been removed.
      sessionStorage.removeItem(LOGIN_REDIRECT);
      return "idle";
    }
    // A plain-feed bounce cannot be retried in this document.
    if (sessionStorage.getItem(LOGIN_REDIRECT)) {
      return ["/", "/home.php"].includes(location.pathname) ? "settled" : "pending";
    }
    if (
      document.readyState !== "complete" ||
      !["/", "/home.php"].includes(location.pathname) ||
      !document.querySelector('[role="feed"], [data-pagelet^="FeedUnit_"]') ||
      document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], form')
    )
      return "idle";
    sessionStorage.setItem(LOGIN_REDIRECT, "1");
  } catch {
    // Without a persistent per-window guard, a failed redirect could loop.
    return "settled";
  }
  location.replace("https://www.facebook.com/messages");
  return "settled";
}

// Carrier's mark over a fresh login page until its text has rendered
// (messenger.css). WebKitGTK can hold Facebook's page for about 20 s, so this
// starts at document start, before the first paint.
function showLoaderUntilLoginRenders() {
  if (!onFacebookHost() || /(?:^|;\s*)c_user=/.test(document.cookie)) return;
  if (!/^\/(?:login(?:\.php)?\/?)?$/i.test(location.pathname)) return;
  const html = document.documentElement;
  html.setAttribute(LOADING, "");
  const started = performance.now();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    // Not faded in yet (400 ms delay + 300 ms fade): just remove it.
    if (performance.now() - started < 700) {
      html.removeAttribute(LOADING);
      return;
    }
    html.setAttribute(LOADING, "done");
    setTimeout(() => html.removeAttribute(LOADING), 300);
  };
  setTimeout(finish, LOADER_LIMIT_MS);
  // The form's text paints in the first frame after its fonts load; the
  // frame after that one means it reached the screen.
  const whenRendered = () => {
    if (done) return;
    if (!document.querySelector('input[name="pass"]')) {
      requestAnimationFrame(whenRendered);
      return;
    }
    document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(finish)));
  };
  requestAnimationFrame(whenRendered);
}

export function initLoginTidy() {
  showLoaderUntilLoginRenders();
  let scheduled = false;
  let tidyObserver: MutationObserver | null = null;

  const prefersDark = () => !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  // Follow the forced theme (Settings → Theme) when set, else the system. FB's
  // login page ships only a light theme, so this drives our scoped login palette.
  const wantDark = () => {
    const t = window.__CARRIER_SETTINGS__?.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return prefersDark();
  };

  // Only Facebook's own login page — not the in-app OAuth provider pages
  // (Google/Apple/Microsoft), which also have password fields.
  const isRequiredLoginUi = (el: Element | null): boolean => {
    if (el?.nodeType !== 1) return false;
    if (el === document.documentElement || el === document.body) return false;
    const role = el.getAttribute("role");
    if (role === "dialog" || role === "alertdialog") return true;
    if (el.querySelector?.('[role="dialog"], [role="alertdialog"]')) return true;
    if (findOptionalCookieDeclineButton(el)) return true;
    return hasCookieConsentContext(el);
  };

  // Facebook's "f" logo, copied for the CSS above the login column (see
  // messenger.css). Facebook colors it per theme, so copy it again when that
  // color changes.
  const copyLogo = (html: HTMLElement) => {
    const logo = document.querySelector('[role="banner"] svg');
    if (!logo) return;
    const color = getComputedStyle(logo).color || "#0866ff";
    if (html.getAttribute(LOGO) === color) return;
    const copy = logo.cloneNode(true) as SVGElement;
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    copy.setAttribute("fill", color);
    copy.removeAttribute("class");
    const data = encodeURIComponent(new XMLSerializer().serializeToString(copy));
    html.style.setProperty("--carrier-login-logo", `url("data:image/svg+xml,${data}")`);
    html.setAttribute(LOGO, color);
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

  const linkDescriptor = (link: Element): LoginLinkDescriptor => ({
    href: link.getAttribute("href") || "",
    text: link.textContent || "",
  });
  const isLanguageLink = (link: Element) =>
    link.hasAttribute(LANGUAGE_LINK) || isLanguageFooterLink(linkDescriptor(link));

  // Facebook's footer language switcher is a row of locale links whose href is
  // just "#" (they swap the page locale via JS). Identify them by that — NOT by
  // on-screen geometry — so detection still works before the strip has been
  // laid out, and even if a previous pass had hidden it (geometry-based
  // detection was the bug: it failed on the FDSIntlLocaleSelectorList variant
  // that has no #pageFooter, then the strip got swept into the hidden chrome).
  const topLanguageLinks = (links: Element[]) => {
    return topLanguageLinkIndexes(links.map(linkDescriptor)).map((index) => links[index]!);
  };

  const linksOutside = (root: Element, inner: Element) =>
    [...(root.querySelectorAll?.("a[href]") || [])].filter((link) => !inner.contains(link));

  const isFooterContainer = (el: Element | null, inner: Element) => {
    if (!el?.querySelector) return false;
    if (el.querySelector("#pageFooter, .localeSelectorList")) return true;
    const links = linksOutside(el, inner);
    return (
      links.length >= 6 &&
      (topLanguageLinks(links).length >= 2 || links.filter(isLanguageLink).length >= 2)
    );
  };

  const commonAncestor = (nodes: Element[]) => {
    let root: Element | null | undefined = nodes[0];
    while (root && !nodes.every((node) => root!.contains(node))) root = root.parentElement;
    return root;
  };

  // Keep the language switcher visible below the login column and
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
    for (let node: Element | null = languageRoot; node; node = node.parentElement) {
      node.removeAttribute(HIDE);
      node.removeAttribute(FOOTER_LINKS);
      if (node !== footer && node !== languageRoot) node.setAttribute(FOOTER_KEEP, "");
      if (node === footer) break;
      // Flattening the footer exposes decorative siblings such as its divider.
      // Keep only the language branch and any required consent/dialog UI.
      for (const sibling of node.parentElement?.children || []) {
        if (sibling !== node && !isRequiredLoginUi(sibling)) sibling.setAttribute(FOOTER_LINKS, "");
      }
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
    // Dialogs (the cookie consent) keep their links: they are part of the text.
    const inDialog = (el: Element) => !!el.closest('[role="dialog"], [role="alertdialog"]');
    for (const link of allLinks) {
      if (languageSet.has(link) || link.hasAttribute(LANGUAGE_LINK) || inDialog(link)) continue;
      (link.closest("li") || link).setAttribute(FOOTER_LINKS, "");
    }
    for (const el of document.body.querySelectorAll("div, span")) {
      if (el.contains(col) || col.contains(el) || inDialog(el)) continue;
      if (languageLinks.some((link) => el.contains(link))) continue;
      if (/(\bMeta\s*©|\bMeta\s+\d{4}\b|©\s*\d{4})/i.test(el.textContent || "")) {
        el.setAttribute(FOOTER_LINKS, "");
      }
    }
  };

  function tidy() {
    const loginRecovery = returnToMessengerAfterLogin();
    const html = document.documentElement;
    document.querySelectorAll(`[${LIGHT_BG}]`).forEach((el) => el.removeAttribute(LIGHT_BG));
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
        html.removeAttribute(LOGO);
        html.style.removeProperty("--carrier-login-logo");
        clearFooterMarks();
        html.removeAttribute("data-carrier-login-dark");
      }
      // Once confidently logged in (auth cookie set, not on a checkpoint/2FA
      // interstitial, page fully loaded), stop watching: this observer fires
      // on every DOM mutation forever otherwise, and login surfaces can only
      // come back via a logout — a full navigation that re-injects and
      // re-arms everything. Keep watching home while recovery can still run,
      // but retire after redirecting or when the loop guard prevents recovery.
      if (
        tidyObserver &&
        /\bc_user=/.test(document.cookie) &&
        (loginRecovery === "settled" ||
          (loginRecovery === "idle" && !["/", "/home.php"].includes(location.pathname))) &&
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
    // Newer login layouts define a light palette below <html>, so changing
    // Facebook's root class alone cannot theme them. Keep this independent of
    // force-theme, which may already have set the root class before we run.
    html.toggleAttribute("data-carrier-login-dark", wantDark());
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
    copyLogo(html);
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
    // Older login headers use literal white instead of a surface token. Keep
    // that fallback inside the login column, without mutating Facebook's styles.
    if (wantDark()) {
      for (const el of col.querySelectorAll("*")) {
        if (isLightFill(getComputedStyle(el).backgroundColor)) el.setAttribute(LIGHT_BG, "");
      }
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
  window.addEventListener("load", schedule, { once: true });
  for (const delay of [300, 1200]) setTimeout(schedule, delay);
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", schedule);
  }
}
