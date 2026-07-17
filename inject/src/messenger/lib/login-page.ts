export interface LoginLinkDescriptor {
  href: string;
  text: string;
}

const FOOTER_NOISE_RE =
  /registrer|logg inn|messenger|facebook|lite|video|meta(?:\s|$)|instagram|threads|quest|ray-ban|personvern|privacy|cookie|informasjonskaps|annonse|annonsevalg|utviklere|developer|jobber|hjelp|help|betingelser|terms|opplasting/i;

export function isLanguageFooterLink(link: LoginLinkDescriptor): boolean {
  return link.href.trim() === "#" || link.href.trim().endsWith("#");
}

export function isFooterNoiseLink(link: LoginLinkDescriptor): boolean {
  return FOOTER_NOISE_RE.test(link.text.replace(/\s+/g, " ").trim());
}

export function topLanguageLinkIndexes(links: LoginLinkDescriptor[]): number[] {
  const indexes = links.flatMap((link, index) =>
    isLanguageFooterLink(link) && !isFooterNoiseLink(link) ? [index] : [],
  );
  return indexes.length >= 2 ? indexes : [];
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
