const SAFE_TOP = 8;
const MAX_OFFSET = 64;

/**
 * Calculate the smallest downward offset that keeps every viewer control
 * inside the webview, clear of `reserved` pixels at the top. `appliedOffset` removes our existing translation from
 * measured rectangles, making repeated measurements stable.
 */
export function viewerControlOffset(
  controlTops: number[],
  appliedOffset = 0,
  // Extra room at the top: Chatpane's window controls on Windows and Linux.
  reserved = 0,
): number {
  const naturalTops = controlTops
    .filter(Number.isFinite)
    .map((top) => top - (Number.isFinite(appliedOffset) ? appliedOffset : 0));
  if (!naturalTops.length) return 0;
  // The cap guards against pathological layouts, on top of what is reserved.
  return Math.min(
    MAX_OFFSET + Math.max(0, reserved),
    Math.max(0, Math.ceil(SAFE_TOP + reserved - Math.min(...naturalTops))),
  );
}
