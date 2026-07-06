/** Clamp a page-zoom percentage to the supported range (30–200; NaN/0 → 100). */
export const clampZoom = (p: number): number => Math.min(200, Math.max(30, Math.round(p) || 100));
