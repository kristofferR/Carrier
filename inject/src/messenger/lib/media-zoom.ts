/* Zoom math for the media overlay (features/media-viewer.ts). The wheel and
 * pinch curves are adapted from fMess (github.com/toanbku/fmess, MIT). */

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

export interface ZoomWheel {
  deltaY: number;
  /** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  ctrlKey: boolean;
  /** Whether a real Ctrl key is down, as last seen on a key or pointer event. */
  ctrlKeyHeld: boolean;
}

/**
 * How much one wheel event zooms. Chromium (WebView2) reports a touchpad
 * pinch as Ctrl + wheel with no Ctrl key down and deltaY = -100 × ln(scale),
 * so exp(-deltaY / 100) follows the fingers. Anything else is a wheel or a
 * two-finger scroll and zooms by distance, about 15% per 100 px notch, so a
 * touchpad's many small events zoom as much as one notch over the same
 * distance.
 */
export function wheelZoomFactor({ deltaY, deltaMode, ctrlKey, ctrlKeyHeld }: ZoomWheel): number {
  const pixels = deltaY * (deltaMode === 1 ? 40 : deltaMode === 2 ? 800 : 1);
  if (ctrlKey && !ctrlKeyHeld && Math.abs(pixels) < 50) return Math.exp(-pixels / 100);
  return 2 ** (-Math.min(Math.max(pixels, -120), 120) * 0.002);
}

export interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Zoom to `scale` (clamped) keeping the point under (x, y) where it is. The
 * element is transformed `translate(tx, ty) scale(scale)` about its centre,
 * and `rect` is its current, transformed bounding box. Back at 1 it is
 * centred again.
 */
export function zoomAround(
  state: ZoomState,
  scale: number,
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): ZoomState {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  if (next <= MIN_SCALE) return { scale: MIN_SCALE, tx: 0, ty: 0 };
  const k = next / state.scale;
  return {
    scale: next,
    tx: state.tx + (x - (rect.left + rect.width / 2)) * (1 - k),
    ty: state.ty + (y - (rect.top + rect.height / 2)) * (1 - k),
  };
}
