import { describe, expect, test } from "bun:test";
import { clampZoom } from "./zoom";

describe("clampZoom", () => {
  test("clamps to 30–200 and rounds", () => {
    expect(clampZoom(100)).toBe(100);
    expect(clampZoom(250)).toBe(200);
    expect(clampZoom(10)).toBe(30);
    expect(clampZoom(149.6)).toBe(150);
  });

  test("falls back to 100 for NaN/0", () => {
    expect(clampZoom(Number.NaN)).toBe(100);
    expect(clampZoom(0)).toBe(100);
  });
});
