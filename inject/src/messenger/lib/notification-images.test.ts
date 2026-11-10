import { expect, test } from "bun:test";
import {
  notificationPhotoText,
  notificationThumbnailSize,
  readSinglePhoto,
} from "./notification-images";

test("photo notifications introduce the thumbnail with the sender and a colon", () => {
  // Messenger's body for a message without text is its own translated summary.
  for (const body of ["", "Sent a photo.", "Hat ein Foto gesendet."]) {
    expect(notificationPhotoText("Person", body, true, true)).toEqual({
      title: "Person sent an image:",
      body: "",
    });
  }
  expect(notificationPhotoText("Person", "", true, false)).toEqual({
    title: "Person sent an image:",
    body: "",
  });
  // Without a thumbnail the summary stays visible.
  expect(notificationPhotoText("Person", "Sent a photo.", false, true)).toEqual({
    title: "Person",
    body: "Sent a photo.",
  });
  // A caption or link is the message's own text, whatever its words.
  for (const body of ["Sent a photo", "Sent a YouTube link: Video", "Look at this view!"]) {
    expect(notificationPhotoText("Person", body, true, false)).toEqual({ title: "Person", body });
  }
});

test("only a message of one photo counts as a photo, whatever its summary says", async () => {
  const attachments = { name: "attachments" };
  const load = (rows: unknown[]) => (name: string) =>
    ({
      LSDatabaseSingleton: {
        LSDatabaseSingleton: Promise.resolve({ tables: { threads: { get() {} }, attachments } }),
      },
      I64: { of_string: (value: string) => `i64:${value}` },
      LSIntEnum: { unwrapIntEnum: Number },
      MessagingAttachmentType: { STICKER: 1, IMAGE: 2, ANIMATED_IMAGE: 3, EPHEMERAL_IMAGE: 8 },
      ReQL: {
        fromTableAscending: (table: unknown) => ({
          getKeyRange: (...key: unknown[]) =>
            table === attachments && key[0] === "i64:10" && key[1] === "mid.1" ? rows : [],
        }),
        toArrayAsync: async (query: unknown) => query,
      },
    })[name];
  expect(await readSinglePhoto(load([{ attachmentType: 2 }]), "10", "mid.1")).toBe(true);
  expect(await readSinglePhoto(load([{ attachmentType: 8 }]), "10", "mid.1")).toBe(true);
  for (const kind of [1, 3]) {
    expect(await readSinglePhoto(load([{ attachmentType: kind }]), "10", "mid.1")).toBe(false);
  }
  const two = [{ attachmentType: 2 }, { attachmentType: 2 }];
  expect(await readSinglePhoto(load(two), "10", "mid.1")).toBe(false);
  expect(await readSinglePhoto(load([{ attachmentType: 2 }]), "10", "mid.2")).toBe(false);
  expect(await readSinglePhoto(null, "10", "mid.1")).toBe(false);
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
