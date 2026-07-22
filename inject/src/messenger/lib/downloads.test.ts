import { describe, expect, test } from "bun:test";
import {
  canRevealDownload,
  downloadRevealLabel,
  filenameFromUrl,
  friendlyDownloadName,
  splitDownloadName,
} from "./downloads";

const BASE = "https://www.facebook.com/messages/";

describe("filenameFromUrl", () => {
  test("takes the URL path basename when it looks like a filename", () => {
    expect(filenameFromUrl("https://scontent.fbcdn.net/v/photo_1.jpg?x=1", BASE)).toBe(
      "photo_1.jpg",
    );
    expect(filenameFromUrl("/files/report%20final.pdf", BASE)).toBe("report final.pdf");
  });

  test("returns '' when there is no extension or the URL is junk", () => {
    expect(filenameFromUrl("https://example.com/download", BASE)).toBe("");
    expect(filenameFromUrl("https://example.com/", BASE)).toBe("");
    expect(filenameFromUrl("::not a url::", "also not a base")).toBe("");
  });
});

describe("splitDownloadName", () => {
  test("splits stem and extension", () => {
    expect(splitDownloadName("video.mp4")).toEqual({ stem: "video", ext: ".mp4" });
    expect(splitDownloadName("archive.tar.gz")).toEqual({ stem: "archive.tar", ext: ".gz" });
  });

  test("handles missing extensions and path prefixes", () => {
    expect(splitDownloadName("README")).toEqual({ stem: "README", ext: "" });
    expect(splitDownloadName(".hidden")).toEqual({ stem: ".hidden", ext: "" });
    expect(splitDownloadName("dir/photo.jpg")).toEqual({ stem: "photo", ext: ".jpg" });
    expect(splitDownloadName("C:\\dir\\photo.jpg")).toEqual({ stem: "photo", ext: ".jpg" });
    expect(splitDownloadName(null)).toEqual({ stem: "", ext: "" });
  });
});

describe("friendlyDownloadName", () => {
  test("replaces Facebook's generic stems, keeping the extension", () => {
    expect(friendlyDownloadName("download.jpg")).toBe("Messenger.jpg");
    expect(friendlyDownloadName("image.png")).toBe("Messenger.png");
    expect(friendlyDownloadName("Video.mp4")).toBe("Messenger.mp4");
    expect(friendlyDownloadName("")).toBe("Messenger");
  });

  test("keeps real filenames untouched", () => {
    expect(friendlyDownloadName("holiday_2025.jpg")).toBe("holiday_2025.jpg");
    expect(friendlyDownloadName("report final.pdf")).toBe("report final.pdf");
  });
});

describe("downloadRevealLabel", () => {
  test("uses Finder only for the macOS user agent", () => {
    expect(downloadRevealLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
      "Show in Finder",
    );
    expect(downloadRevealLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Show in folder");
    expect(downloadRevealLabel("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Show in folder");
  });
});

describe("canRevealDownload", () => {
  test("requires both a trusted event and an active user gesture", () => {
    expect(canRevealDownload(true, true)).toBe(true);
    expect(canRevealDownload(false, true)).toBe(false);
    expect(canRevealDownload(true, false)).toBe(false);
    expect(canRevealDownload(false, false)).toBe(false);
  });
});
