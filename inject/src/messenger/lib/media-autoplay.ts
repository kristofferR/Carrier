export const MEDIA_ACTIVATION_GRACE_MS = 1_500;

/**
 * Whether a play request should be treated as automatic. The monotonic
 * timestamps come from performance.now(); invalid or backwards values fail
 * closed so page script cannot accidentally bypass the preference.
 */
export function shouldSuppressMediaPlay(
  enabled: boolean,
  lastActivationAt: number,
  now: number,
  graceMs = MEDIA_ACTIVATION_GRACE_MS,
) {
  if (!enabled) return false;
  if (
    !Number.isFinite(lastActivationAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(graceMs) ||
    graceMs < 0 ||
    lastActivationAt > now
  ) {
    return true;
  }
  return now - lastActivationAt > graceMs;
}
