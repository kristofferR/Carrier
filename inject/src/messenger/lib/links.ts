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

// Parameters Facebook adds for cross-site attribution. Keep this deliberately
// narrow: arbitrary query parameters (including CDN signatures and a site's
// own analytics parameters) may be required for the destination to work.
const FACEBOOK_TRACKING_PARAMS = new Set([
  "fbclid",
  "mibextid",
  "fb_action_ids",
  "fb_action_types",
  "fb_ref",
  "fb_source",
]);

function isAuth(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  return AUTH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function facebookRedirectTarget(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const isRedirect =
    (host === "l.facebook.com" || host === "lm.facebook.com" || host === "facebook.com") &&
    url.pathname === "/l.php";
  if (!isRedirect) return null;

  const target = url.searchParams.get("u");
  if (!target) return null;
  try {
    return /^https?:$/.test(new URL(target).protocol) ? target : null;
  } catch {
    return null;
  }
}

function trackingKey(rawPair: string): string | null {
  const rawKey = rawPair.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, " ")).toLowerCase();
  } catch {
    return null;
  }
}

function stripRawFacebookParams(href: string): { href: string; removed: boolean } {
  const hashAt = href.indexOf("#");
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : href.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt < 0) return { href, removed: false };

  const prefix = beforeHash.slice(0, queryAt);
  const pairs = beforeHash.slice(queryAt + 1).split("&");
  const kept = pairs.filter((pair) => {
    const key = trackingKey(pair);
    return !key || !FACEBOOK_TRACKING_PARAMS.has(key);
  });
  if (kept.length === pairs.length) return { href, removed: false };
  return {
    href: `${prefix}${kept.length ? `?${kept.join("&")}` : ""}${hash}`,
    removed: true,
  };
}

/**
 * Remove Facebook's cross-site tracking from a URL copied or opened by
 * Carrier. Unwrap Facebook's link-shim redirect, then remove only known
 * Facebook attribution parameters from the real destination.
 */
export function stripFacebookTracking(href: string, base: string): string {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return href;
  }
  if (!/^https?:$/.test(url.protocol)) return href;

  // Facebook can nest its l.php link shim. Bound the loop and reject repeated
  // targets so malformed links cannot keep the copy/open path spinning.
  const seen = new Set<string>();
  let unwrapped = false;
  for (let depth = 0; depth < 4; depth++) {
    const target = facebookRedirectTarget(url);
    if (!target || seen.has(target)) break;
    seen.add(target);
    url = new URL(target);
    unwrapped = true;
  }

  // Work on the raw serialized query instead of URLSearchParams: mutating the
  // latter rewrites unrelated bytes (`%20` → `+`, `~` → `%7E`), which can
  // invalidate signed destination URLs.
  const cleaned = stripRawFacebookParams(url.href);

  // Avoid normalizing untouched URLs. This matters for signed media URLs and
  // also preserves the user's exact spelling/encoding when there is no spam.
  return unwrapped || cleaned.removed ? cleaned.href : href;
}

// facebook.com paths that belong to the Messenger app or its login/auth flows.
// Any other facebook.com content (posts, profiles, groups, reels, …) opens in
// the real browser — Carrier only wraps Messenger, and the stripped-chrome CSS
// renders the rest of Facebook broken.
const FACEBOOK_APP_PATH_RE =
  /^\/(messages|messenger_media|t|login(\.php)?|checkpoint|two_step_verification|two_factor|recover|reg|r\.php)(\/|$)/;

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
