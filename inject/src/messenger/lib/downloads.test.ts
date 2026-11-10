import { describe, expect, test } from "bun:test";
import {
  DOWNLOAD_ACCESS_DENIED,
  dataUrlBlob,
  downloadAccessDeniedToast,
  downloadRevealLabel,
  filenameFromUrl,
  friendlyDownloadName,
  isDownloadAccessDenied,
  isDownloadCancellation,
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

describe("isDownloadCancellation", () => {
  test("recognizes only an explicit native-picker cancellation", () => {
    expect(isDownloadCancellation(new Error("download cancelled"))).toBe(true);
    expect(isDownloadCancellation(new Error("download rejected"))).toBe(false);
    expect(isDownloadCancellation(new Error("native download failed"))).toBe(false);
    expect(isDownloadCancellation("download cancelled")).toBe(false);
  });
});

describe("downloadAccessDeniedToast", () => {
  test("offers the settings pane only where one grants the access", () => {
    expect(downloadAccessDeniedToast("macos").action).toEqual({
      label: "Open Settings",
      kind: "open-download-privacy",
    });
    for (const platform of ["windows", "linux"] as const) {
      const toast = downloadAccessDeniedToast(platform);
      expect(toast.action).toBeUndefined();
      expect(toast.message).toContain("Check the folder's permissions");
    }
  });

  test("is told apart from other download failures", () => {
    expect(isDownloadAccessDenied(new Error(DOWNLOAD_ACCESS_DENIED))).toBe(true);
    expect(isDownloadAccessDenied(new Error("native download failed"))).toBe(false);
  });
});

test("reads data: URLs without fetch", async () => {
  const png = dataUrlBlob("data:image/png;base64,iVBORw==");
  expect(png?.type).toBe("image/png");
  expect([...new Uint8Array(await png!.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  const svg = dataUrlBlob("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E");
  expect(svg?.type).toBe("image/svg+xml");
  expect(await svg!.text()).toBe("<svg/>");
  expect(dataUrlBlob("data:image/png;base64,***")).toBeNull();
  expect(dataUrlBlob("https://example.com/a.png")).toBeNull();
});
