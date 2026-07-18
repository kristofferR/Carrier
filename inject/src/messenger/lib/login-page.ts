export interface LoginLinkDescriptor {
  href: string;
  text: string;
}

// Facebook's login-page language strip is a row of raw `href="#"` anchors. Match
// only that exact contract — a path that merely ends in "#" (e.g. "/help#") is a
// real destination, not a language switch, and must not be treated as one.
export function isLanguageFooterLink(link: LoginLinkDescriptor): boolean {
  return link.href.trim() === "#";
}

export function topLanguageLinkIndexes(links: LoginLinkDescriptor[]): number[] {
  const indexes = links.flatMap((link, index) => (isLanguageFooterLink(link) ? [index] : []));
  return indexes.length >= 2 ? indexes : [];
}

/** A Meta-owned privacy/cookie policy link that can anchor a consent dialog. */
export function isCookiePolicyHref(href: string): boolean {
  try {
    const url = new URL(href, "https://www.facebook.com/");
    const host = url.hostname.toLowerCase();
    const metaOwned =
      host === "facebook.com" ||
      host.endsWith(".facebook.com") ||
      host === "meta.com" ||
      host.endsWith(".meta.com") ||
      host === "instagram.com" ||
      host.endsWith(".instagram.com");
    if (!metaOwned) return false;
    return /(?:^|\/)(?:privacy|policies|cookie|cookies)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function qualifiesCookieActionRow(scores: number[]): boolean {
  return scores.length >= 2 && (Math.max(...scores) > 40 || scores.length === 2);
}

export function lowestScoreIndex(scores: number[]): number | null {
  if (!scores.length) return null;
  let lowest = 0;
  for (let index = 1; index < scores.length; index++) {
    if (scores[index]! < scores[lowest]!) lowest = index;
  }
  return lowest;
}
