import { expect, test } from "bun:test";
import { notificationThumbnailSize } from "./notification-images";

test("notification thumbnails preserve portrait and landscape aspect ratios without upscaling", () => {
  expect(notificationThumbnailSize(900, 1600)).toEqual({ width: 144, height: 256 });
  expect(notificationThumbnailSize(1600, 900)).toEqual({ width: 256, height: 144 });
  expect(notificationThumbnailSize(80, 60)).toEqual({ width: 80, height: 60 });
  for (const [width, height] of [
    [0, 1],
    [1, -1],
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
  ]) {
    expect(notificationThumbnailSize(width!, height!)).toBeNull();
  }
});
