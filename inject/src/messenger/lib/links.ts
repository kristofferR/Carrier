/*
 * Link classification: which hrefs stay in the app and which open in the real
 * browser. Facebook's l.php tracking redirect always counts as external (it is
 * unwrapped to its real destination on the Rust side).
 */
export const INTERNAL_HOSTS = [
  "facebook.com",
  "messenger.com",
  "fbcdn.net",
  "fbsbx.com",
  "meta.com",
  "oculus.com",
];

// Facebook's "continue with Google/Apple/Microsoft" social logins use these
// dedicated auth hosts; keep them in-app so the popup flow works.
export const AUTH_HOSTS = ["accounts.google.com", "login.microsoftonline.com", "appleid.apple.com"];

function isAuth(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  return AUTH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// facebook.com paths that belong to the Messenger app or its login/auth flows.
// Any other facebook.com content (posts, profiles, groups, reels, …) opens in
// the real browser — Carrier only wraps Messenger, and the stripped-chrome CSS
// renders the rest of Facebook broken.
const FACEBOOK_APP_PATH_RE =
  /^\/(messages|t|login(\.php)?|checkpoint|two_step_verification|two_factor|recover|reg|r\.php)(\/|$)/;

/** Classify an href (resolved against `base`) as external (real browser) or not. */
export function classifyHref(href: string, base: string): { external: boolean } {
  try {
    const u = new URL(href, base);
    // mailto:/tel: links open in the OS handler.
    if (u.protocol === "mailto:" || u.protocol === "tel:") return { external: true };
    if (!/^https?:$/.test(u.protocol)) return { external: false };
    // Keep OAuth/login popups inside the app so social logins work.
    if (isAuth(u)) return { external: false };
    const host = u.hostname.replace(/^www\./, "");
    const tracking =
      host === "l.facebook.com" ||
      host === "lm.facebook.com" ||
      (host === "facebook.com" && u.pathname === "/l.php");
    const internal = INTERNAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
    // On facebook.com only Messenger + auth surfaces stay in-app.
    const isFacebook = host === "facebook.com" || host.endsWith(".facebook.com");
    const inApp = isFacebook ? FACEBOOK_APP_PATH_RE.test(u.pathname) : internal;
    return { external: tracking || !inApp };
  } catch {
    return { external: false };
  }
}
