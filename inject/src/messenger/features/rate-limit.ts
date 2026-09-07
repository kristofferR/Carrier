import { diag } from "../bridge";
import { nextRateLimit, type RateLimitState, readRateLimitState } from "../lib/rate-limit";

export const RATE_LIMIT_RETRY_STATE_EVENT = "carrier:rate-limit-retry-state";
export const RATE_LIMIT_RETRY_EVENT = "carrier:rate-limit-retry";
export const RATE_LIMIT_EVENT = "carrier:rate-limit-change";
export const RATE_LIMIT_STORAGE_KEY = "carrier-rate-limit";
let state: RateLimitState | undefined;

function restore() {
  try {
    const stored = readRateLimitState(
      JSON.parse(localStorage.getItem(RATE_LIMIT_STORAGE_KEY) || "null"),
      Date.now(),
    );
    if (stored && (!state || stored.until > state.until)) state = stored;
  } catch (_) {}
}

export function rateLimitRemainingMs(now = Date.now()): number {
  return Math.max(0, (state?.until ?? 0) - now);
}

export function reportRateLimit(source: "graphql-1675004" | "http-429", retryMs?: number) {
  restore();
  const next = nextRateLimit(state, Date.now(), retryMs);
  if (next.until === state?.until) return;
  state = next;
  try {
    localStorage.setItem(RATE_LIMIT_STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
  diag(
    "sync.rate-limit",
    `${source}: automatic recovery backing off until ${new Date(state.until).toISOString()} (attempt ${state.attempts})`,
  );
  window.dispatchEvent(new Event(RATE_LIMIT_EVENT));
}

/** A manual attempt is additional; it never changes the automatic deadline. */
export function retryRateLimitNow() {
  diag(
    "sync.rate-limit-manual",
    "user requested an extra recovery attempt; automatic cooldown unchanged",
  );
  window.dispatchEvent(new Event(RATE_LIMIT_RETRY_EVENT));
}

export function initRateLimit() {
  restore();
  window.addEventListener("storage", (event) => {
    if (event.key !== RATE_LIMIT_STORAGE_KEY) return;
    restore();
    window.dispatchEvent(new Event(RATE_LIMIT_EVENT));
  });
  if (rateLimitRemainingMs() > 0) {
    diag("sync.rate-limit", `restored cooldown until ${new Date(state!.until).toISOString()}`);
  }
}
