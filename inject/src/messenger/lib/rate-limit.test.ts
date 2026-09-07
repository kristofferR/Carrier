import { describe, expect, test } from "bun:test";
import { canReplacePendingRefresh } from "./auto-refresh";
import {
  isFacebookRateLimitError,
  nextRateLimit,
  RATE_LIMIT_BASE_MS,
  RATE_LIMIT_MAX_MS,
  readRateLimitState,
  retryAfterMs,
} from "./rate-limit";

describe("rate-limit recovery", () => {
  test("recognizes the normalized Facebook error without inspecting message content", () => {
    const error = {
      messageFormat: "GraphQL operation responded with error %s: %s",
      messageParams: ["1675004", "Rate limit exceeded"],
    };
    expect(isFacebookRateLimitError(error)).toBe(true);
    expect(isFacebookRateLimitError({ ...error, messageParams: [1675004] })).toBe(true);
    expect(
      isFacebookRateLimitError({ ...error, messageParams: ["123", "Rate limit exceeded"] }),
    ).toBe(false);
    expect(isFacebookRateLimitError({ message: "Rate limit exceeded" })).toBe(false);
    expect(isFacebookRateLimitError(null)).toBe(false);
  });

  test("bursts keep one deadline; retries back off and remain finite across reloads", () => {
    let state = nextRateLimit(undefined, 1000);
    expect(state.until).toBe(1000 + RATE_LIMIT_BASE_MS);
    expect(nextRateLimit(state, 2000)).toEqual(state);
    state = nextRateLimit(
      readRateLimitState(JSON.parse(JSON.stringify(state)), state.until),
      state.until,
    );
    expect(state.until - state.detectedAt).toBe(30 * 60_000);
    for (let retry = 0; retry < 5; retry++) {
      state = nextRateLimit(state, state.until);
      expect(state.until - state.detectedAt).toBe(60 * 60_000);
    }
    expect(nextRateLimit(state, state.until + RATE_LIMIT_MAX_MS).attempts).toBe(1);
  });

  test("honors server delay and rejects corrupt or obsolete persisted state", () => {
    const now = Date.parse("2026-09-07T12:00:00Z");
    expect(retryAfterMs("120", now)).toBe(120_000);
    expect(retryAfterMs("Mon, 07 Sep 2026 12:03:00 GMT", now)).toBe(180_000);
    expect(retryAfterMs("99999999", now)).toBe(RATE_LIMIT_MAX_MS);
    for (const header of [null, "", "nonsense", "0", "Mon, 07 Sep 2026 11:00:00 GMT"])
      expect(retryAfterMs(header, now)).toBeUndefined();
    const state = nextRateLimit(undefined, now, 120_000);
    expect(state.until).toBe(now + 120_000);
    expect(nextRateLimit(state, now + 1000, 180_000).until).toBe(now + 181_000);
    for (const bad of [
      null,
      {},
      { ...state, until: Infinity },
      { ...state, detectedAt: now + 1 },
      { ...state, attempts: 99 },
      { ...state, until: now + RATE_LIMIT_MAX_MS + 1 },
    ])
      expect(readRateLimitState(bad, now)).toBeUndefined();
  });

  test("ordinary recovery triggers cannot postpone a scheduled rate-limit retry", () => {
    for (const reason of ["background", "foreground", "resume", "realtime", "online"] as const) {
      expect(canReplacePendingRefresh("rate-limit", reason)).toBe(false);
      expect(canReplacePendingRefresh(reason, "rate-limit")).toBe(true);
      expect(canReplacePendingRefresh("rate-limit-manual", reason)).toBe(false);
    }
    expect(canReplacePendingRefresh("rate-limit-manual", "rate-limit-manual")).toBe(false);
    expect(canReplacePendingRefresh("rate-limit-manual", "rate-limit")).toBe(false);
  });
});
