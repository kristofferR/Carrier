/* ------------------- Passkey two-factor login notice -------------------- */
// When a passkey is an account's only two-factor method, Facebook's login
// stops on a passkey step whose Continue button spins forever in webviews
// that can't complete passkeys (lib/passkey-login.ts). Explain why above the
// page and point to Accounts Center, where another method can be added (#470).
import { language, t } from "../../i18n";
import { diag, openUrl } from "../bridge";
import {
  isPasskeyAssertFrame,
  isTwoStepVerificationPath,
  passkeysCanWork,
} from "../lib/passkey-login";
import { onFacebookHost } from "./cookie-consent";

const ACCOUNTS_CENTER_URL = "https://accountscenter.facebook.com/password_and_security/two_factor";

const onPasskeyStep = () =>
  isTwoStepVerificationPath(location.pathname) &&
  [...document.querySelectorAll("iframe")].some((frame) => isPasskeyAssertFrame(frame.src));

export function initPasskeyLoginNotice() {
  if (!onFacebookHost()) return;
  if (passkeysCanWork(chatpaneMediaPlatform, typeof PublicKeyCredential !== "undefined")) return;

  // A custom element, so the auth pages' text recoloring in messenger.css
  // (which targets div, span, …) leaves it alone.
  const host = document.createElement("chatpane-passkey-notice");
  Object.assign(host, language());
  const root = host.attachShadow({ mode: "closed" });
  // The palette is the login page's (messenger.css), light and dark.
  root.innerHTML = `<style>
    :host { all: initial; display: block; position: relative; z-index: 2147483646;
      box-sizing: border-box; width: min(440px, calc(100% - 24px)); margin: 12px auto;
      color-scheme: light dark; --surface: #fff; --text: #1c1e21; --muted: #65676b;
      --border: #dddfe2; --link: #0866ff; }
    @media (prefers-color-scheme: dark) { :host { --surface: #242526; --text: #f3f4f5;
      --muted: #a1a4a8; --border: #525456; --link: #58a7ff; } }
    :host([data-theme="dark"]) { --surface: #242526; --text: #f3f4f5; --muted: #a1a4a8;
      --border: #525456; --link: #58a7ff; }
    :host([data-theme="light"]) { --surface: #fff; --text: #1c1e21; --muted: #65676b;
      --border: #dddfe2; --link: #0866ff; }
    section { position: relative; padding: 14px 40px 14px 16px; border: 1px solid var(--border);
      border-radius: 12px; background: var(--surface); color: var(--text);
      box-shadow: 0 4px 16px #0002; font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    :host([dir="rtl"]) section { padding: 14px 16px 14px 40px; }
    strong { display: block; margin-bottom: 4px; font-size: 15px; font-weight: 600; }
    p { margin: 0 0 8px; color: var(--muted); }
    button { all: unset; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; border-radius: 4px; }
    .open { color: var(--link); font-weight: 600; }
    .open:hover { text-decoration: underline; }
    .close { position: absolute; top: 8px; inset-inline-end: 8px; width: 24px; height: 24px;
      border-radius: 50%; text-align: center; font-size: 18px; line-height: 24px; color: var(--muted); }
    .close:hover { background: color-mix(in srgb, var(--muted) 18%, transparent); }
  </style><section role="note"><strong></strong><p></p>
    <button class="open" type="button"></button><button class="close" type="button">×</button></section>`;
  root.querySelector("strong")!.textContent = t("page.passkey_login.title");
  root.querySelector("p")!.textContent = t("page.passkey_login.body");
  const open = root.querySelector<HTMLButtonElement>(".open")!;
  open.textContent = t("page.passkey_login.open");
  open.addEventListener("click", () => openUrl(ACCOUNTS_CENTER_URL));
  const close = root.querySelector<HTMLButtonElement>(".close")!;
  close.setAttribute("aria-label", t("page.media.dismiss"));

  // Dismissed for this passkey step; it shows again if the step comes back.
  let dismissed = false;
  close.addEventListener("click", () => {
    dismissed = true;
    host.remove();
  });

  let scheduled = false;
  const scan = () => {
    scheduled = false;
    if (!onPasskeyStep()) {
      dismissed = false;
      host.remove();
      // Past the login, the step can only come back after a navigation,
      // which injects this script again.
      if (/\bc_user=/.test(document.cookie) && !isTwoStepVerificationPath(location.pathname)) {
        observer.disconnect();
      }
      return;
    }
    if (dismissed || host.isConnected || !document.body) return;
    host.dataset.theme = window.__CHATPANE_SETTINGS__?.theme ?? "system";
    // Above Facebook's React root, outside the tree it manages.
    document.body.prepend(host);
    diag("passkey-login", "showed the passkey two-factor notice");
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("chatpane:settings", () => {
    if (host.isConnected) host.dataset.theme = window.__CHATPANE_SETTINGS__?.theme ?? "system";
  });
  schedule();
}
