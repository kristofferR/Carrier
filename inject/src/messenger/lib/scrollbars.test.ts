import { describe, expect, test } from "bun:test";
import { INDICATOR_INSET, INDICATOR_MIN_HEIGHT, indicatorPlace } from "./scrollbars";

const box = { top: 100, right: 400, height: 500 };

describe("indicatorPlace", () => {
  test("sizes the indicator to the visible share and follows the scroll position", () => {
    const scroll = { scrollHeight: 2000, clientHeight: 500 };
    expect(indicatorPlace(box, { ...scroll, scrollTop: 0 })).toEqual({
      left: 400 - INDICATOR_INSET,
      top: 100,
      height: 125,
    });
    expect(indicatorPlace(box, { ...scroll, scrollTop: 1500 })?.top).toBe(100 + 500 - 125);
    expect(indicatorPlace(box, { ...scroll, scrollTop: 750 })?.top).toBe(100 + 375 / 2);
  });

  test("keeps a long pane's indicator large enough to see", () => {
    const place = indicatorPlace(box, { scrollTop: 0, scrollHeight: 1_000_000, clientHeight: 500 });
    expect(place?.height).toBe(INDICATOR_MIN_HEIGHT);
  });

  test("stays inside the pane when the scroll position overshoots", () => {
    const scroll = { scrollHeight: 2000, clientHeight: 500 };
    expect(indicatorPlace(box, { ...scroll, scrollTop: -40 })?.top).toBe(100);
    expect(indicatorPlace(box, { ...scroll, scrollTop: 1600 })?.top).toBe(475);
  });

  test("nothing for a pane that can't scroll", () => {
    expect(indicatorPlace(box, { scrollTop: 0, scrollHeight: 500, clientHeight: 500 })).toBeNull();
    expect(indicatorPlace(box, { scrollTop: 0, scrollHeight: 501, clientHeight: 500 })).toBeNull();
  });
});
