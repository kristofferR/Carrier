/*
 * Resizable chat list and details panes: the pure parts. Idea and approach
 * from fMess (https://github.com/toanbku/fmess, MIT,
 * src-tauri/src/inject/08-panes.js).
 */

export type Pane = "list" | "details";

export interface PaneWidths {
  list: number | null;
  details: number | null;
}

/** Sanity bounds for a stored width, in CSS pixels. Mirrors `PANE_WIDTH_MIN/MAX` in settings.rs. */
export const PANE_WIDTH_MIN = 160;
export const PANE_WIDTH_MAX = 1600;
/** The chat between the panes keeps at least this much room. */
export const MIN_CHAT_WIDTH = 360;
/** Facebook's own minimum for the details pane. */
export const MIN_DETAILS_WIDTH = 300;
/** The chat list never drags narrower than this. */
export const MIN_LIST_WIDTH = 200;

const width = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(PANE_WIDTH_MAX, Math.max(PANE_WIDTH_MIN, Math.round(value)));
};

/** Stored widths from an untrusted settings value; anything malformed is Facebook's default (null). */
export function sanitizePaneWidths(value: unknown): PaneWidths {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return { list: width(record.list), details: width(record.details) };
}

/**
 * Which side of a pane its drag edge sits on: the side facing `other` (the
 * chat). Read from layout rather than `dir`, so right-to-left pages work.
 */
export function edgeSide(
  pane: { left: number; right: number },
  other: { left: number; right: number },
): "left" | "right" {
  return pane.left + pane.right <= other.left + other.right ? "right" : "left";
}

export interface DragInput {
  startWidth: number;
  startX: number;
  x: number;
  side: "left" | "right";
  min: number;
  max: number;
}

/** A pane's width while its edge is dragged from `startX` to `x`. */
export function dragWidth({ startWidth, startX, x, side, min, max }: DragInput): number {
  const delta = side === "right" ? x - startX : startX - x;
  return Math.round(Math.min(Math.max(min, max), Math.max(min, startWidth + delta)));
}

/** How far a pane may grow before the chat drops under its minimum. */
export function dragBounds(
  pane: Pane,
  startWidth: number,
  chatWidth: number,
  facebookMin: number,
): { min: number; max: number } {
  const floor = pane === "list" ? MIN_LIST_WIDTH : MIN_DETAILS_WIDTH;
  const min = Math.max(floor, Number.isFinite(facebookMin) ? facebookMin : 0);
  const max = Math.max(min, startWidth + Math.max(0, chatWidth - MIN_CHAT_WIDTH));
  return { min, max: Math.min(max, PANE_WIDTH_MAX) };
}

/**
 * The cap on a stored width, relative to the pane's flex row, so a narrower
 * window shrinks the pane instead of squeezing the chat.
 */
export function paneCap(pane: Pane): string {
  return pane === "list"
    ? `calc(100% - ${MIN_CHAT_WIDTH + MIN_DETAILS_WIDTH}px)`
    : `calc(100% - ${MIN_CHAT_WIDTH}px)`;
}

/** The rules pinning each stored width; empty for Facebook's widths. */
export function paneWidthCss(widths: PaneWidths, selectors: Record<Pane, string>): string {
  return (["list", "details"] as const)
    .filter((pane) => widths[pane] !== null)
    .map(
      (pane) =>
        `${selectors[pane]} { flex: 0 0 ${widths[pane]}px !important; width: ${widths[pane]}px !important; max-width: ${paneCap(pane)} !important; }`,
    )
    .join("\n");
}
