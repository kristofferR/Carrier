/** Where a scrolling pane sits in the window, in CSS pixels. */
export interface PaneBox {
  top: number;
  right: number;
  height: number;
}

/** A pane's scroll position, as its element reports it. */
export interface PaneScroll {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface IndicatorPlace {
  /** Left edge of the indicator, inset from the pane's right edge. */
  left: number;
  top: number;
  height: number;
}

export const INDICATOR_MIN_HEIGHT = 24;
/** The indicator's distance from the pane's right edge to its own left edge. */
export const INDICATOR_INSET = 9;

/**
 * Where the floating scroll indicator goes for a pane, sized to the visible
 * share of its content like a scroll bar thumb; null when it can't scroll.
 */
export function indicatorPlace(box: PaneBox, scroll: PaneScroll): IndicatorPlace | null {
  const range = scroll.scrollHeight - scroll.clientHeight;
  if (range <= 1 || box.height <= 0 || scroll.scrollHeight <= 0) return null;
  const height = Math.min(
    box.height,
    Math.max(INDICATOR_MIN_HEIGHT, (box.height * scroll.clientHeight) / scroll.scrollHeight),
  );
  const progress = Math.min(1, Math.max(0, scroll.scrollTop / range));
  return {
    left: box.right - INDICATOR_INSET,
    top: box.top + (box.height - height) * progress,
    height,
  };
}
