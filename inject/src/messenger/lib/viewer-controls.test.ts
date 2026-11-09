import { describe, expect, test } from "bun:test";
import { viewerControlOffset } from "./viewer-controls";

describe("viewerControlOffset", () => {
  test("does not move controls that already have a safe top inset", () => {
    expect(viewerControlOffset([8, 14, 28])).toBe(0);
  });

  test("moves the most clipped control to eight pixels inside the webview", () => {
    expect(viewerControlOffset([-20, 14])).toBe(28);
  });

  test("is stable when measuring controls with its previous offset applied", () => {
    expect(viewerControlOffset([8, 42], 28)).toBe(28);
  });

  test("keeps controls clear of Chatpane's window controls", () => {
    expect(viewerControlOffset([8, 14], 0, 32)).toBe(32);
  });

  test("keeps clear of a strip taller than the usual cap (low page zoom)", () => {
    expect(viewerControlOffset([8], 0, 107)).toBe(107);
  });

  test("caps pathological layout offsets and ignores invalid measurements", () => {
    expect(viewerControlOffset([Number.NaN, -500])).toBe(64);
    expect(viewerControlOffset([Number.NaN])).toBe(0);
  });
});
