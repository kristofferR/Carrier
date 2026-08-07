import { describe, expect, test } from "bun:test";
import {
  cssPropertyName,
  pointerActivationIsSound,
  pointInRect,
  rectsMatch,
} from "./menu-integrity";

const row = { x: 100, y: 200, width: 170, height: 34 };

test("cssPropertyName ignores a replaced regex hook", () => {
  const replace = Object.getOwnPropertyDescriptor(RegExp.prototype, Symbol.replace);
  Object.defineProperty(RegExp.prototype, Symbol.replace, {
    configurable: true,
    value: () => {
      throw new Error("page regex hook called");
    },
  });
  try {
    expect(cssPropertyName("borderRadius")).toBe("border-radius");
  } finally {
    if (replace) Object.defineProperty(RegExp.prototype, Symbol.replace, replace);
  }
});

describe("rectsMatch", () => {
  test("accepts sub-pixel layout jitter", () => {
    expect(rectsMatch(row, { ...row, x: row.x + 0.4, y: row.y - 0.3 })).toBe(true);
  });

  test("rejects a row that was moved", () => {
    expect(rectsMatch(row, { ...row, y: row.y - 34 })).toBe(false);
  });

  test("rejects a row that was stretched over its neighbours", () => {
    expect(rectsMatch(row, { ...row, height: row.height * 4 })).toBe(false);
  });
});

describe("pointInRect", () => {
  test("accepts a point inside, including the edges", () => {
    expect(pointInRect(row, 150, 210)).toBe(true);
    expect(pointInRect(row, row.x, row.y)).toBe(true);
    expect(pointInRect(row, row.x + row.width, row.y + row.height)).toBe(true);
  });

  test("rejects a point outside", () => {
    expect(pointInRect(row, 150, 199)).toBe(false);
    expect(pointInRect(row, 271, 210)).toBe(false);
  });
});

describe("pointerActivationIsSound", () => {
  test("accepts a click on an untouched row", () => {
    expect(pointerActivationIsSound(row, row, 150, 210)).toBe(true);
  });

  test("rejects a click after the row was slid under the cursor", () => {
    // The row the user aimed at sat one line up; page script shifted this one
    // into its place, so the click lands inside the moved rectangle.
    const moved = { ...row, y: row.y - 34 };
    expect(pointerActivationIsSound(row, moved, 150, moved.y + 10)).toBe(false);
  });

  test("rejects a click that lands outside the row it targets", () => {
    expect(pointerActivationIsSound(row, row, 150, 400)).toBe(false);
  });
});
