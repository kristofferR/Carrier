import { describe, expect, test } from "bun:test";
import { notificationLinkBody } from "./notification-links";

const video = "https://youtube.com/watch?v=_TP-ZzKbXJk&si=sharing";
const card = { href: video, title: "Japanese toilet experience 1" };

describe("notificationLinkBody", () => {
  test("names Spotify links and matches the card across locale and sharing parameters", () => {
    const href = "https://open.spotify.com/track/0123456789ABCDEFGHIJKL?si=shared";
    const spotifyCard = {
      href: "https://open.spotify.com/intl-no/track/0123456789ABCDEFGHIJKL?si=card",
      title: "Example song",
    };
    expect(notificationLinkBody(href)).toBe("Sent a Spotify link");
    expect(notificationLinkBody(href, [spotifyCard])).toBe("Sent a Spotify link: Example song");
    expect(notificationLinkBody("https://spotify.link/example")).toBe("Sent a Spotify link");
    expect(notificationLinkBody(href.replace("track", "album"), [spotifyCard])).toBe(
      "Sent a Spotify link",
    );
    expect(notificationLinkBody(href.replace("0123456789", "9876543210"), [spotifyCard])).toBe(
      "Sent a Spotify link",
    );
    const impostor = href.replace("open.spotify.com", "open.spotify.com.example.org");
    expect(notificationLinkBody(impostor, [spotifyCard])).toBe(impostor);
    expect(notificationLinkBody(`Listen: ${href}`, [spotifyCard])).toBe(`Listen: ${href}`);
  });

  test("uses the matching card title and provider", () => {
    expect(notificationLinkBody(video, [card])).toBe(
      "Sent a YouTube link: Japanese toilet experience 1",
    );
    expect(notificationLinkBody("https://youtu.be/_TP-ZzKbXJk", [card])).toBe(
      "Sent a YouTube link: Japanese toilet experience 1",
    );
    expect(
      notificationLinkBody(video, [
        { ...card, href: `https://l.facebook.com/l.php?u=${encodeURIComponent(video)}` },
      ]),
    ).toContain(card.title);
  });

  test("does not borrow a different video's title or guess from generic previews", () => {
    expect(notificationLinkBody("https://youtube.com/watch?v=abcdefghijk", [card])).toBe(
      "Sent a YouTube link",
    );
    expect(notificationLinkBody("Shared a link. (youtube.com)", [card])).toBe(
      "Shared a link. (youtube.com)",
    );
    expect(notificationLinkBody(video, [card, { ...card, title: "Conflicting title" }])).toBe(
      "Sent a YouTube link",
    );
  });

  test("preserves captions and rejects lookalike providers and unsafe URLs", () => {
    for (const body of [
      `Watch this: ${video}`,
      "https://youtube.com.example.org/watch?v=_TP-ZzKbXJk",
      "javascript:alert(1)",
      "Not a URL",
    ])
      expect(notificationLinkBody(body, [card])).toBe(body);
  });

  test("supports other link cards without discarding unknown bare URLs", () => {
    const href = "https://example.org/article";
    expect(notificationLinkBody(href, [{ href, title: "An interesting article" }])).toBe(
      "Sent a link: An interesting article (example.org)",
    );
    expect(notificationLinkBody(href)).toBe(href);
    expect(notificationLinkBody(video, [{ ...card, title: "T".repeat(400) }])).toHaveLength(240);
  });
});
