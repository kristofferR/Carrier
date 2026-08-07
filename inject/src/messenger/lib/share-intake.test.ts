import { describe, expect, test } from "bun:test";
import {
  dispatchTransferEvent,
  MAX_SHARED_FILES,
  MAX_SHARED_NAME_BYTES,
  mimeForName,
  SHARE_DELIVERY_TTL_MS,
  sanitizeSharedFiles,
  shareIsDeliverable,
} from "./share-intake";

describe("dispatchTransferEvent", () => {
  const transfer = { files: ["photo.png"] };

  test("requires both payload inspection and cancellation", () => {
    const target = {
      dispatchEvent(dispatched: Event) {
        void (dispatched as Event & { clipboardData: unknown }).clipboardData;
        return false;
      },
    };
    expect(dispatchTransferEvent(target, {} as Event, "clipboardData", transfer)).toEqual({
      acknowledged: true,
      payloadRead: true,
    });
  });

  test("does not accept unrelated cancellation or inspection alone", () => {
    expect(
      dispatchTransferEvent({ dispatchEvent: () => false }, {} as Event, "dataTransfer", transfer),
    ).toEqual({ acknowledged: false, payloadRead: false });

    const target = {
      dispatchEvent(dispatched: Event) {
        void (dispatched as Event & { dataTransfer: unknown }).dataTransfer;
        return true;
      },
    };
    expect(dispatchTransferEvent(target, {} as Event, "dataTransfer", transfer)).toEqual({
      acknowledged: false,
      payloadRead: true,
    });
  });
});

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
    expect(sanitizeSharedFiles(many)).toHaveLength(MAX_SHARED_FILES);
  });

  test("enforces the aggregate encoded-data cap", () => {
    const payload = [
      { name: "one.png", data: "1234" },
      { name: "two.png", data: "5678" },
    ];
    expect(sanitizeSharedFiles(payload, 7)).toEqual([{ name: "one.png", data: "1234" }]);
    expect(sanitizeSharedFiles(payload, 8)).toEqual(payload);
  });

  test("measures attachment names as UTF-8 bytes", () => {
    const atLimit = `${"a".repeat(MAX_SHARED_NAME_BYTES - 4)}.png`;
    const overLimit = `é${"a".repeat(MAX_SHARED_NAME_BYTES - 5)}.png`;
    expect(overLimit).toHaveLength(MAX_SHARED_NAME_BYTES);
    expect(sanitizeSharedFiles([{ name: atLimit, data: "aGk=" }])).toHaveLength(1);
    expect(sanitizeSharedFiles([{ name: overLimit, data: "aGk=" }])).toEqual([]);
  });

  test("does not accept inherited payload fields", () => {
    const inherited = Object.create({ name: "photo.png", data: "aGk=" });
    expect(sanitizeSharedFiles([inherited])).toEqual([]);
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
    expect(mimeForName("payload.__proto__")).toBe("application/octet-stream");
  });
});
