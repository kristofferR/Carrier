import { describe, expect, test } from "bun:test";
import { isLightFill, rgb } from "./color";

describe("rgb", () => {
  test("parses rgb()/rgba()", () => {
    expect(rgb("rgb(255, 255, 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(rgb("rgba(36, 37, 38, 0.5)")).toEqual({ r: 36, g: 37, b: 38, a: 0.5 });
  });

  test("returns null for anything else", () => {
    expect(rgb("transparent")).toBeNull();
    expect(rgb("")).toBeNull();
    expect(rgb(null)).toBeNull();
    expect(rgb("rgb(a, b, c)")).toBeNull();
  });
});

describe("isLightFill", () => {
  test("near-opaque light fills match", () => {
    expect(isLightFill("rgb(255, 255, 255)")).toBe(true);
    expect(isLightFill("rgba(240, 242, 245, 1)")).toBe(true);
  });

  test("dark or translucent fills don't", () => {
    expect(isLightFill("rgb(36, 37, 38)")).toBe(false);
    expect(isLightFill("rgba(255, 255, 255, 0.5)")).toBe(false);
    expect(isLightFill("transparent")).toBe(false);
    expect(isLightFill(null)).toBe(false);
  });
});
