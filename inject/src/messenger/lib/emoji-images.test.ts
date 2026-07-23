import { describe, expect, test } from "bun:test";
import {
  expandedImageClip,
  intersectImageClips,
  intersectsImageClip,
  isFacebookEmojiImage,
} from "./emoji-images";

describe("emoji image loading", () => {
  test("matches only Facebook's emoji image endpoint", () => {
    expect(
      isFacebookEmojiImage("https://static.xx.fbcdn.net/images/emoji.php/v9/example.png"),
    ).toBeTrue();
    expect(
      isFacebookEmojiImage("https://static.xx.fbcdn.net/images/stickers/example.png"),
    ).toBeFalse();
    expect(isFacebookEmojiImage("https://example.com/images/emoji.php/example.png")).toBeTrue();
    expect(isFacebookEmojiImage(undefined)).toBeFalse();
  });

  test("intersects viewport and scroll-container clips", () => {
    const viewport = { top: -80, right: 1080, bottom: 800, left: -80 };
    const scroller = { top: 500, right: 700, bottom: 780, left: 300 };
    expect(intersectImageClips(viewport, scroller)).toEqual(scroller);
    expect(
      intersectsImageClip({ top: 520, right: 360, bottom: 550, left: 330 }, scroller),
    ).toBeTrue();
    expect(
      intersectsImageClip({ top: 900, right: 360, bottom: 930, left: 330 }, scroller),
    ).toBeFalse();
  });

  test("expands a clip by its prefetch margin", () => {
    expect(expandedImageClip({ top: 100, right: 300, bottom: 200, left: 50 }, 80)).toEqual({
      top: 20,
      right: 380,
      bottom: 280,
      left: -30,
    });
  });
});
