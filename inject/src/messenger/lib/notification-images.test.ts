import { expect, test } from "bun:test";
import { notificationPhotoText, notificationThumbnailSize } from "./notification-images";

test("photo notifications introduce the thumbnail with the sender and a colon", () => {
  for (const body of [
    "",
    "Sent a photo",
    "Sent an image.",
    "Har sendt et bilde",
    "Sendte et bilde.",
  ]) {
    expect(notificationPhotoText("Person", body, true)).toEqual({
      title: "Person sent an image:",
      body: "",
    });
  }
  expect(notificationPhotoText("Person", "Sent a photo", false)).toEqual({
    title: "Person",
    body: "Sent a photo",
  });
  for (const body of [
    "Sent a YouTube link: Video",
    "Sent a Spotify link: Song",
    "Look at this view!",
  ]) {
    expect(notificationPhotoText("Person", body, true)).toEqual({ title: "Person", body });
  }
});

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
