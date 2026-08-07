import { describe, expect, test } from "bun:test";
import {
  mimeForName,
  SHARE_DELIVERY_TTL_MS,
  sanitizeSharedFiles,
  shareIsDeliverable,
} from "./share-intake";

describe("sanitizeSharedFiles", () => {
  test("keeps well-formed entries and drops the rest", () => {
    const files = sanitizeSharedFiles([
      { name: "photo.png", data: "aGk=" },
      { name: "", data: "aGk=" },
      { name: "../escape.png", data: "aGk=" },
      { name: ".hidden", data: "aGk=" },
      { name: "video.mov", data: "aGk=" },
      "not-an-object",
      { name: "no-data.png" },
    ]);
    expect(files.map((file) => file.name)).toEqual(["photo.png", "video.mov"]);
  });

  test("rejects a non-array payload", () => {
    expect(sanitizeSharedFiles({ name: "photo.png", data: "aGk=" })).toEqual([]);
    expect(sanitizeSharedFiles(null)).toEqual([]);
  });

  test("caps the file count at the largest advertised selection", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      name: `file-${index}.png`,
      data: "aGk=",
    }));
    expect(sanitizeSharedFiles(many)).toHaveLength(21);
  });
});

describe("shareIsDeliverable", () => {
  test("fresh shares deliver, stale and future ones do not", () => {
    const now = 1_000_000;
    expect(shareIsDeliverable(now - 1000, now)).toBe(true);
    expect(shareIsDeliverable(now - SHARE_DELIVERY_TTL_MS - 1, now)).toBe(false);
    expect(shareIsDeliverable(now + 1000, now)).toBe(false);
  });
});

describe("mimeForName", () => {
  test("maps known extensions and falls back to octet-stream", () => {
    expect(mimeForName("IMG_4649.PNG")).toBe("image/png");
    expect(mimeForName("clip.mov")).toBe("video/quicktime");
    expect(mimeForName("archive.zip")).toBe("application/octet-stream");
  });
});
