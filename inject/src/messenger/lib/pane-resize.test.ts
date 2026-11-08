import { describe, expect, test } from "bun:test";
import {
  dragBounds,
  dragWidth,
  edgeSide,
  MIN_CHAT_WIDTH,
  PANE_WIDTH_MAX,
  PANE_WIDTH_MIN,
  paneWidthCss,
  sanitizePaneWidths,
} from "./pane-resize";

describe("sanitizePaneWidths", () => {
  test("keeps finite widths, rounded and clamped", () => {
    expect(sanitizePaneWidths({ list: 320.4, details: 99999 })).toEqual({
      list: 320,
      details: PANE_WIDTH_MAX,
    });
    expect(sanitizePaneWidths({ list: 5 }).list).toBe(PANE_WIDTH_MIN);
  });

  test("treats junk as Facebook's width", () => {
    expect(sanitizePaneWidths(null)).toEqual({ list: null, details: null });
    expect(sanitizePaneWidths([1, 2])).toEqual({ list: null, details: null });
    expect(sanitizePaneWidths({ list: "300", details: Number.NaN })).toEqual({
      list: null,
      details: null,
    });
  });
});

describe("dragging", () => {
  test("the edge faces the chat, in either direction", () => {
    const chat = { left: 300, right: 900 };
    expect(edgeSide({ left: 0, right: 300 }, chat)).toBe("right");
    expect(edgeSide({ left: 900, right: 1200 }, chat)).toBe("left");
  });

  test("moving a right edge right widens; a left edge widens moving left", () => {
    const base = { startWidth: 300, startX: 300, min: 200, max: 600 };
    expect(dragWidth({ ...base, x: 350, side: "right" })).toBe(350);
    expect(dragWidth({ ...base, x: 250, side: "left" })).toBe(350);
    expect(dragWidth({ ...base, x: 2000, side: "right" })).toBe(600);
    expect(dragWidth({ ...base, x: -2000, side: "right" })).toBe(200);
  });

  test("the chat keeps its minimum and Facebook's minimum wins over ours", () => {
    expect(dragBounds("list", 300, MIN_CHAT_WIDTH + 100, 0)).toEqual({ min: 200, max: 400 });
    expect(dragBounds("details", 340, MIN_CHAT_WIDTH - 50, 320)).toEqual({ min: 320, max: 340 });
  });
});

test("only stored widths get a rule", () => {
  const css = paneWidthCss({ list: 280, details: null }, { list: ".l", details: ".d" });
  expect(css).toContain(".l { flex: 0 0 280px !important; width: 280px !important;");
  expect(css).not.toContain(".d");
});
