import { conversationNodeText, hasCandidateTextChild } from "./conversation-row";
import { EMOJI_SOURCE_RE } from "./emoji";
import { stripFacebookTracking } from "./links";

export interface NotificationLinkCard {
  href: string;
  title: string;
  image?: Pick<HTMLImageElement, "currentSrc" | "src">;
}

function linkTarget(value: string) {
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    const url = new URL(stripFacebookTracking(value, value));
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const youtube = ["youtube.com", "m.youtube.com", "youtu.be"].includes(host);
    const spotify = ["spotify.com", "open.spotify.com", "spotify.link"].includes(host);
    const video = youtube
      ? host === "youtu.be"
        ? url.pathname.slice(1)
        : url.pathname === "/watch"
          ? url.searchParams.get("v")
          : /^\/(?:shorts|live)\/([^/]+)$/.exec(url.pathname)?.[1]
      : null;
    // Locale and sharing parameters do not change which Spotify item was sent.
    const spotifyItem =
      host === "open.spotify.com"
        ? /^\/(?:intl-[a-z]{2}\/)?(track|album|artist|playlist|episode|show)\/([A-Za-z0-9]{22})\/?$/.exec(
            url.pathname,
          )
        : null;
    let key = url.href;
    if (video && /^[\w-]{11}$/.test(video)) key = `youtube:${video}`;
    else if (spotifyItem) key = `spotify:${spotifyItem[1]}:${spotifyItem[2]}`;
    return {
      key,
      host,
      provider: youtube ? "YouTube" : spotify ? "Spotify" : host,
    };
  } catch {
    return null;
  }
}

/** Read labels belonging to links, never neighbouring messages or image alt text. */
export function notificationLinkCards(root: ParentNode): NotificationLinkCard[] {
  const cards: NotificationLinkCard[] = [];
  for (const link of root.querySelectorAll<HTMLAnchorElement>('[role="article"] a[href]')) {
    const target = linkTarget(link.href);
    if (!target || link.closest('[aria-hidden="true"]')) continue;
    const leaves = [...link.querySelectorAll<HTMLElement>("span")].filter(
      (span) => !span.closest('[aria-hidden="true"]') && !hasCandidateTextChild(span),
    );
    const labels = (leaves.length ? leaves.map(conversationNodeText) : [conversationNodeText(link)])
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter((text) => {
        const label = text.toLowerCase().replace(/^www\./, "");
        return (
          text &&
          !linkTarget(text) &&
          label !== target.host &&
          label !== target.provider.toLowerCase()
        );
      });
    const title = labels[0] || "";
    const image = [...link.querySelectorAll<HTMLImageElement>("img")].find((image) => {
      const rect = image.getBoundingClientRect();
      return (
        !image.closest('[aria-hidden="true"]') &&
        !EMOJI_SOURCE_RE.test(image.currentSrc || image.src) &&
        rect.width >= 96 &&
        rect.height >= 96
      );
    });
    if (title || image) cards.push({ href: link.href, title, image });
  }
  return cards;
}

/** Only attach a thumbnail when the notification identifies its exact link. */
export function notificationLinkImage(body: string, cards: NotificationLinkCard[]): string {
  const target = linkTarget(body.trim());
  if (!target) return "";
  const sources = new Set(
    cards
      .filter((card) => linkTarget(card.href)?.key === target.key)
      .map((card) => card.image?.currentSrc || card.image?.src || "")
      .filter(Boolean),
  );
  return sources.size === 1 ? [...sources][0]! : "";
}

/** Enrich a bare shared URL without rewriting the sender's accompanying text. */
export function notificationLinkBody(body: string, cards: NotificationLinkCard[] = []): string {
  const target = linkTarget(body.trim());
  if (!target) return body;
  const titles = new Set(
    cards
      .filter((card) => linkTarget(card.href)?.key === target.key)
      .map((card) => card.title.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
  // Conflicting cards are not enough evidence to pick a title.
  const title = titles.size === 1 ? [...titles][0] : "";
  if (target.provider === "YouTube" || target.provider === "Spotify") {
    const summary = `Sent a ${target.provider} link`;
    return title ? `${summary}: ${title}`.slice(0, 240) : summary;
  }
  return title ? `Sent a link: ${title} (${target.host})`.slice(0, 240) : body;
}
