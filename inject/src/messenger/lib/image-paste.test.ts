import { describe, expect, test } from "bun:test";
import { isImageWithOnlyItsAddress } from "./image-paste";

const image = { fileTypes: ["image/png"], text: "", htmlText: null, htmlHasImage: false };

describe("isImageWithOnlyItsAddress", () => {
  test("WebKit's Copy Image: picture plus its address as text and an <img>", () => {
    expect(
      isImageWithOnlyItsAddress({
        ...image,
        text: "https://scontent.xx.fbcdn.net/v/photo.jpg?x=1",
        htmlText: "",
        htmlHasImage: true,
      }),
    ).toBe(true);
    expect(isImageWithOnlyItsAddress({ ...image, text: "blob:https://www.facebook.com/abc" })).toBe(
      true,
    );
  });

  test("leaves every other paste alone", () => {
    // A screenshot: only the file, nothing to strip.
    expect(isImageWithOnlyItsAddress(image)).toBe(false);
    // Text that is more than an address.
    expect(isImageWithOnlyItsAddress({ ...image, text: "look at this https://x.com/a" })).toBe(
      false,
    );
    // HTML with visible text, or without an image.
    expect(isImageWithOnlyItsAddress({ ...image, htmlText: "A caption", htmlHasImage: true })).toBe(
      false,
    );
    expect(isImageWithOnlyItsAddress({ ...image, htmlText: "", htmlHasImage: false })).toBe(false);
    // Not only images.
    expect(
      isImageWithOnlyItsAddress({
        ...image,
        fileTypes: ["image/png", "application/pdf"],
        text: "https://example.com/a.png",
      }),
    ).toBe(false);
    expect(
      isImageWithOnlyItsAddress({ ...image, fileTypes: [], text: "https://example.com/a.png" }),
    ).toBe(false);
  });
});
