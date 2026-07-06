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
    return { external: tracking || !internal };
  } catch {
    return { external: false };
  }
}
