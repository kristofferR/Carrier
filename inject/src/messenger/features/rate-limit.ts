import { diag } from "../bridge";
import { nextRateLimit, type RateLimitState, readRateLimitState } from "../lib/rate-limit";
import { accountScopedStorageKey } from "../lib/threads";

export const RATE_LIMIT_RETRY_STATE_EVENT = "carrier:rate-limit-retry-state";
export const RATE_LIMIT_RETRY_EVENT = "carrier:rate-limit-retry";
export const RATE_LIMIT_EVENT = "carrier:rate-limit-change";
export const RATE_LIMIT_STORAGE_KEY = "carrier-rate-limit";
let state: RateLimitState | undefined;
let storageKey: string | null = null;
export const rateLimitAccountScope = () => storageKey ?? "";

function restore() {
  if (!storageKey) return;
  try {
    const stored = readRateLimitState(
      JSON.parse(localStorage.getItem(storageKey) || "null"),
      Date.now(),
    );
    if (stored && (!state || stored.until > state.until)) state = stored;
    else if (!stored && rateLimitRemainingMs() <= 0) state = undefined;
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
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify(state));
  } catch (_) {}
  diag(
    "sync.rate-limit",
    `${source}: automatic recovery backing off until ${new Date(state.until).toISOString()} (attempt ${state.attempts})`,
  );
  window.dispatchEvent(new Event(RATE_LIMIT_EVENT));
}

export function hasRateLimitEpisode() {
  return state !== undefined;
}

export function clearRateLimitOnRecovery(): boolean {
  restore();
  if (!state || rateLimitRemainingMs() > 0) return false;
  state = undefined;
  try {
    if (storageKey) localStorage.removeItem(storageKey);
  } catch (_) {}
  diag("sync.rate-limit-recovered", "requests recovered after cooldown; reset backoff episode");
  window.dispatchEvent(new CustomEvent(RATE_LIMIT_EVENT, { detail: "recovered-here" }));
  return true;
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
  const key = accountScopedStorageKey(RATE_LIMIT_STORAGE_KEY, document.cookie);
  if (key !== storageKey) state = undefined;
  storageKey = key;
  restore();
  window.addEventListener("storage", (event) => {
    if (!storageKey || event.key !== storageKey) return;
    restore();
    window.dispatchEvent(new Event(RATE_LIMIT_EVENT));
  });
  if (rateLimitRemainingMs() > 0) {
    diag("sync.rate-limit", `restored cooldown until ${new Date(state!.until).toISOString()}`);
  }
}
