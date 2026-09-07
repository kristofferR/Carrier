export const RATE_LIMIT_CODE = 1675004;
export const RATE_LIMIT_BASE_MS = 15 * 60_000;
export const RATE_LIMIT_MAX_MS = 24 * 60 * 60_000;
const EPISODE_RESET_MS = 24 * 60 * 60_000;

export interface RateLimitState {
  until: number;
  detectedAt: number;
  attempts: number;
}

export function readRateLimitState(value: unknown, now: number): RateLimitState | undefined {
  if (!value || typeof value !== "object") return;
  const { until, detectedAt, attempts } = value as Partial<RateLimitState>;
  if (
    typeof until !== "number" ||
    !Number.isFinite(until) ||
    typeof detectedAt !== "number" ||
    !Number.isFinite(detectedAt) ||
    typeof attempts !== "number" ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 3 ||
    detectedAt > now ||
    now - detectedAt > EPISODE_RESET_MS ||
    until < detectedAt ||
    until - detectedAt > RATE_LIMIT_MAX_MS
  )
    return;
  return { until, detectedAt, attempts };
}

/** Only the normalized GraphQL code, never chat content or a fuzzy error string. */
export function isFacebookRateLimitError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  return (
    typeof error.messageFormat === "string" &&
    error.messageFormat.startsWith("GraphQL operation responded with error %s:") &&
    Array.isArray(error.messageParams) &&
    (error.messageParams[0] === RATE_LIMIT_CODE ||
      error.messageParams[0] === String(RATE_LIMIT_CODE))
  );
}

export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header?.trim()) return;
  const value = header.trim();
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms) || ms <= 0) return;
  return Math.min(ms, RATE_LIMIT_MAX_MS);
}

export function nextRateLimit(
  previous: RateLimitState | undefined,
  now: number,
  retryMs?: number,
): RateLimitState {
  const current = readRateLimitState(previous, now);
  // An error burst is one episode, not a reason to keep postponing the deadline.
  if (current && current.until > now) {
    if (retryMs && now + retryMs > current.until) {
      return { ...current, detectedAt: now, until: now + Math.min(retryMs, RATE_LIMIT_MAX_MS) };
    }
    return current;
  }
  const attempts = Math.min(3, (current?.attempts ?? 0) + 1);
  const delay = retryMs ?? RATE_LIMIT_BASE_MS * 2 ** (attempts - 1);
  return {
    detectedAt: now,
    until: now + Math.min(RATE_LIMIT_MAX_MS, Math.max(1000, delay)),
    attempts,
  };
}
