import { conversationNodeText, hasCandidateTextChild } from "./conversation-row";
import { stripFacebookTracking } from "./links";

export interface NotificationLinkCard {
  href: string;
  title: string;
}

function linkTarget(value: string) {
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    const url = new URL(stripFacebookTracking(value, value));
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const youtube = ["youtube.com", "m.youtube.com", "youtu.be"].includes(host);
    const video = youtube
      ? host === "youtu.be"
        ? url.pathname.slice(1)
        : url.pathname === "/watch"
          ? url.searchParams.get("v")
          : /^\/(?:shorts|live)\/([^/]+)$/.exec(url.pathname)?.[1]
      : null;
    return {
      key: video && /^[\w-]{11}$/.test(video) ? `youtube:${video}` : url.href,
      host,
      provider: youtube ? "YouTube" : host,
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
    const title = labels[0];
    if (title) cards.push({ href: link.href, title });
  }
  return cards;
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
  if (target.provider === "YouTube") {
    return title ? `Sent a YouTube link: ${title}`.slice(0, 240) : "Sent a YouTube link";
  }
  return title ? `Sent a link: ${title} (${target.host})`.slice(0, 240) : body;
}
