import { describe, expect, test } from "bun:test";
import { isMediaViewerShape, type MediaViewerShape } from "./media-viewer";

const viewport = { left: 0, top: 0, right: 1000, bottom: 800 };
const imageViewer: MediaViewerShape = {
  rect: viewport,
  viewport,
  overlay: true,
  excluded: false,
  hasMedia: true,
  hasDownload: true,
  hasVideoControls: false,
};

describe("media viewer classification", () => {
  test("accepts image/gallery viewers and native video controls", () => {
    expect(isMediaViewerShape(imageViewer)).toBe(true);
    expect(isMediaViewerShape({ ...imageViewer, hasDownload: false, hasVideoControls: true })).toBe(
      true,
    );
  });

  test("rejects compact dialogs even with media and download controls", () => {
    expect(
      isMediaViewerShape({
        ...imageViewer,
        rect: { left: 600, top: 400, right: 950, bottom: 750 },
      }),
    ).toBe(false);
  });

  test("requires viewer evidence in addition to a large overlay", () => {
    expect(isMediaViewerShape({ ...imageViewer, hasMedia: false })).toBe(false);
    expect(isMediaViewerShape({ ...imageViewer, hasDownload: false })).toBe(false);
    expect(isMediaViewerShape({ ...imageViewer, overlay: false })).toBe(false);
    expect(isMediaViewerShape({ ...imageViewer, excluded: true })).toBe(false);
  });

  test("rejects offscreen, hidden, narrow, and invalid geometry", () => {
    for (const rect of [
      { left: 1000, top: 0, right: 2000, bottom: 800 },
      { left: 0, top: 0, right: 0, bottom: 0 },
      { left: 700, top: 0, right: 1000, bottom: 800 },
      { ...viewport, right: Number.NaN },
    ])
      expect(isMediaViewerShape({ ...imageViewer, rect })).toBe(false);
    expect(isMediaViewerShape({ ...imageViewer, viewport: { ...viewport, right: 0 } })).toBe(false);
  });

  test.each([0.3, 0.8, 1, 1.5, 2])("keeps viewport-sized viewers at %f rendered scale", (scale) => {
    const scaled = {
      ...viewport,
      right: viewport.right * scale,
      bottom: viewport.bottom * scale,
    };
    expect(isMediaViewerShape({ ...imageViewer, rect: scaled, viewport: scaled })).toBe(true);
  });
});
