// Pure logic for double-click-to-reply: whether a double-click landed in a
// message row's empty space, left or right of everything the row shows. The
// DOM side lives in features/message-reply.ts.

/** What a message row shows: text, an image, an icon, or a box Messenger
 * paints (a bubble, a reaction pill). */
export interface InkShape {
  tag: string;
  backgroundColor: string;
  backgroundImage: string;
  /** The four computed corner radii. */
  radii: string[];
}

const REPLACED = new Set(["img", "video", "svg", "canvas", "picture", "iframe"]);

/** A computed color with no alpha: `transparent`, or a zero last component. */
export function isTransparent(color: string): boolean {
  const value = color.trim().toLowerCase();
  if (value === "" || value === "transparent") return true;
  if (!value.startsWith("rgba") && !value.includes("/")) return false;
  const alpha = /([\d.]+%?)\s*\)$/.exec(value)?.[1];
  return alpha !== undefined && Number.parseFloat(alpha) === 0;
}

/** Whether an element itself draws something, rather than only laying out its
 * children. `backdrop` is the color behind the row: Messenger paints the row's
 * full-width boxes in it, which shows nothing. */
export function isInk(shape: InkShape, backdrop = ""): boolean {
  return (
    REPLACED.has(shape.tag.toLowerCase()) ||
    (!isTransparent(shape.backgroundColor) && shape.backgroundColor !== backdrop) ||
    (shape.backgroundImage !== "" && shape.backgroundImage !== "none") ||
    shape.radii.some((radius) => Number.parseFloat(radius) > 0)
  );
}

/** A double-click at `x` is beside the row's content when it falls left or
 * right of every box the row draws. A row that draws nothing has no "beside". */
export function besideInk(x: number, boxes: { left: number; right: number }[]): boolean {
  if (!boxes.length) return false;
  const left = Math.min(...boxes.map((box) => box.left));
  const right = Math.max(...boxes.map((box) => box.right));
  return x < left || x > right;
}
