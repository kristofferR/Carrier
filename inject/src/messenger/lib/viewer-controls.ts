const SAFE_TOP = 8;
const MAX_OFFSET = 64;

/**
 * Calculate the smallest downward offset that keeps every viewer control
 * inside the webview. `appliedOffset` removes our existing translation from
 * measured rectangles, making repeated measurements stable.
 */
export function viewerControlOffset(controlTops: number[], appliedOffset = 0): number {
  const naturalTops = controlTops
    .filter(Number.isFinite)
    .map((top) => top - (Number.isFinite(appliedOffset) ? appliedOffset : 0));
  if (!naturalTops.length) return 0;
  return Math.min(MAX_OFFSET, Math.max(0, Math.ceil(SAFE_TOP - Math.min(...naturalTops))));
}
