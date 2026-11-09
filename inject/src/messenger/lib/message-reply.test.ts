import { describe, expect, test } from "bun:test";
import { besideInk, isInk, isTransparent } from "./message-reply";

const layout = {
  tag: "DIV",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  radii: ["0px", "0px", "0px", "0px"],
};

describe("double-click beside a message", () => {
  test("reads computed colors without alpha as transparent", () => {
    expect(isTransparent("rgba(0, 0, 0, 0)")).toBe(true);
    expect(isTransparent("rgb(0 0 0 / 0)")).toBe(true);
    expect(isTransparent("transparent")).toBe(true);
    expect(isTransparent("rgb(0, 132, 255)")).toBe(false);
    expect(isTransparent("rgba(0, 0, 0, 0.05)")).toBe(false);
    expect(isTransparent("color(srgb 0 0.5 1 / 0.4)")).toBe(false);
  });

  test("counts bubbles, media and icons as ink, not layout boxes", () => {
    expect(isInk(layout)).toBe(false);
    expect(isInk({ ...layout, tag: "IMG" })).toBe(true);
    expect(isInk({ ...layout, tag: "svg" })).toBe(true);
    expect(isInk({ ...layout, backgroundColor: "rgb(48, 48, 48)" })).toBe(true);
    // An outgoing bubble shows the chat's gradient through a rounded box.
    expect(isInk({ ...layout, radii: ["18px", "18px", "4px", "18px"] })).toBe(true);
    expect(isInk({ ...layout, backgroundImage: "linear-gradient(red, blue)" })).toBe(true);
  });

  test("doesn't count the row's full-width boxes painted in the chat's background", () => {
    const row = { ...layout, backgroundColor: "rgb(36, 37, 38)" };
    expect(isInk(row, "rgb(36, 37, 38)")).toBe(false);
    expect(isInk({ ...row, backgroundColor: "rgb(48, 48, 48)" }, "rgb(36, 37, 38)")).toBe(true);
  });

  test("is beside only left or right of everything the row draws", () => {
    // An incoming message: avatar, then bubble, then a reaction pill below.
    const row = [
      { left: 20, right: 48 },
      { left: 56, right: 300 },
      { left: 260, right: 310 },
    ];
    expect(besideInk(500, row)).toBe(true);
    expect(besideInk(10, row)).toBe(true);
    expect(besideInk(305, row)).toBe(false);
    expect(besideInk(52, row)).toBe(false);
    expect(besideInk(500, [])).toBe(false);
  });
});
