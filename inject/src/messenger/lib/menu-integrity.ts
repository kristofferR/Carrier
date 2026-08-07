/**
 * Geometry checks that keep a trusted click on Carrier's context menu from
 * being harvested for the wrong action.
 *
 * The menu is rendered into a closed shadow root, so page script cannot move
 * individual rows — but it can still move the host element between the frame
 * the user saw and the click that follows. Comparing each row's rectangle at
 * activation against the one measured when the menu was laid out catches that:
 * a row that has moved is no longer the row the user aimed at.
 */

export type MenuRect = { x: number; y: number; width: number; height: number };

/** Sub-pixel layout jitter is normal; anything larger is a real move. */
const RECT_TOLERANCE = 1;
const nativeAbs = Math.abs;
const nativeCharCodeAt = String.prototype.charCodeAt;
const nativeFromCharCode = String.fromCharCode;
const nativeReflectApply = Reflect.apply;

/** Convert a DOM style key without consulting page-replaceable regex hooks. */
export function cssPropertyName(property: string): string {
  let result = "";
  for (let index = 0; index < property.length; index += 1) {
    const code = nativeReflectApply(nativeCharCodeAt, property, [index]) as number;
    result +=
      code >= 65 && code <= 90
        ? `-${nativeReflectApply(nativeFromCharCode, undefined, [code + 32])}`
        : (property[index] ?? "");
  }
  return result;
}

export function rectsMatch(a: MenuRect, b: MenuRect, tolerance = RECT_TOLERANCE): boolean {
  return (
    nativeAbs(a.x - b.x) <= tolerance &&
    nativeAbs(a.y - b.y) <= tolerance &&
    nativeAbs(a.width - b.width) <= tolerance &&
    nativeAbs(a.height - b.height) <= tolerance
  );
}

export function pointInRect(rect: MenuRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/**
 * A pointer activation counts only when the row still occupies the rectangle it
 * was measured at and the pointer landed inside it.
 */
export function pointerActivationIsSound(
  expected: MenuRect,
  current: MenuRect,
  x: number,
  y: number,
): boolean {
  return rectsMatch(expected, current) && pointInRect(current, x, y);
}
