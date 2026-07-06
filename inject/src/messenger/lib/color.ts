/* Computed-color parsing for the login-page heuristics (cookie-banner
 * primary-button detection, light-backdrop clearing in dark mode). */

/** Parse "rgb(…)"/"rgba(…)" into channels; null when unparseable. */
export const rgb = (
  color: string | null | undefined,
): { r: number; g: number; b: number; a: number } | null => {
  const m = color?.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r = NaN, g = NaN, b = NaN, a = 1] = m[1]!.split(",").map((v) => parseFloat(v));
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? { r, g, b, a } : null;
};

/** A near-opaque light fill (Facebook's login wrappers) we want to clear so
 * the dark backdrop shows through. Reuses `rgb()` as the single parse. */
export const isLightFill = (bg: string | null | undefined): boolean => {
  const c = rgb(bg);
  return !!c && c.a > 0.9 && (c.r + c.g + c.b) / 3 > 200;
};
