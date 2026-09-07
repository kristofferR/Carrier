import { describe, expect, test } from "bun:test";
import {
  isMessengerSyncOperation,
  isMessengerSyncRequest,
  SampledPersistence,
  SYNC_FAILURE_FLOOR,
  SYNC_REQUEST_TIMEOUT_MS,
  SYNC_WINDOW_MS,
  SyncHealthTracker,
  syncResponseSucceeded,
} from "./sync-health";

describe("isMessengerSyncRequest", () => {
  test("recognizes Messenger's GraphQL sync endpoint", () => {
    expect(
      isMessengerSyncRequest("https://www.facebook.com/api/graphql/", "https://facebook.com"),
    ).toBe(true);
    expect(isMessengerSyncRequest("/api/graphql/", "https://www.facebook.com/messages")).toBe(true);
    expect(
      isMessengerSyncRequest("https://www.messenger.com/api/graphql/", "https://messenger.com"),
    ).toBe(true);
  });

  test("rejects other requests, hosts, and malformed URLs", () => {
    expect(isMessengerSyncRequest("https://www.facebook.com/ajax/bz", "https://facebook.com")).toBe(
      false,
    );
    expect(
      isMessengerSyncRequest("https://facebook.com.evil.test/api/graphql/", "https://facebook.com"),
    ).toBe(false);
    expect(
      isMessengerSyncRequest("wss://edge-chat.facebook.com/chat", "https://facebook.com"),
    ).toBe(false);
    expect(isMessengerSyncRequest("not a url", "not a base")).toBe(false);
  });
});

describe("syncResponseSucceeded", () => {
  test("treats answered queries as success and walls or errors as failure", () => {
    expect(syncResponseSucceeded(200)).toBe(true);
    expect(syncResponseSucceeded(302)).toBe(true);
    expect(syncResponseSucceeded(0)).toBe(false);
    expect(syncResponseSucceeded(401)).toBe(false);
    expect(syncResponseSucceeded(429)).toBe(false);
    expect(syncResponseSucceeded(500)).toBe(false);
  });
});

describe("SyncHealthTracker", () => {
  test("flags a blackout once enough requests fail in the window", () => {
    const tracker = new SyncHealthTracker();
    for (let i = 0; i < SYNC_FAILURE_FLOOR - 1; i++) {
      tracker.failed(tracker.started(0), 0);
      expect(tracker.degraded(0)).toBe(false);
    }
    tracker.failed(tracker.started(0), 0);
    expect(tracker.degraded(0)).toBe(true);
  });

  test("flags a brownout where failures outnumber the successes", () => {
    const tracker = new SyncHealthTracker();
    for (let i = 0; i < 4; i++) tracker.succeeded(tracker.started(0), 0);
    for (let i = 0; i < 5; i++) tracker.failed(tracker.started(0), 0);
    expect(tracker.degraded(0)).toBe(true);
  });

  test("stays healthy while successes keep pace with failures", () => {
    const tracker = new SyncHealthTracker();
    for (let i = 0; i < 5; i++) tracker.succeeded(tracker.started(0), 0);
    for (let i = 0; i < 5; i++) tracker.failed(tracker.started(0), 0);
    expect(tracker.degraded(0)).toBe(false);
  });

  test("old outcomes fall out of the rolling window", () => {
    const tracker = new SyncHealthTracker();
    for (let i = 0; i < SYNC_FAILURE_FLOOR; i++) tracker.failed(tracker.started(0), 0);
    expect(tracker.degraded(0)).toBe(true);

    expect(tracker.degraded(SYNC_WINDOW_MS)).toBe(false);
  });

  test("counts a hung request as one failure via sweep", () => {
    const tracker = new SyncHealthTracker();
    tracker.started(0);

    tracker.sweep(SYNC_REQUEST_TIMEOUT_MS - 1);
    expect(tracker.summary(SYNC_REQUEST_TIMEOUT_MS - 1)).toBe("0 failed / 0 ok in window");

    tracker.sweep(SYNC_REQUEST_TIMEOUT_MS);
    tracker.sweep(SYNC_REQUEST_TIMEOUT_MS + 1);
    expect(tracker.summary(SYNC_REQUEST_TIMEOUT_MS + 1)).toBe("1 failed / 0 ok in window");
  });

  test("a condition becomes persistent only after enough consecutive samples", () => {
    const persistence = new SampledPersistence(3);
    persistence.observe(true);
    persistence.observe(true);
    expect(persistence.persistent()).toBe(false);

    persistence.observe(true);
    expect(persistence.persistent()).toBe(true);
    persistence.observe(true);
    expect(persistence.persistent()).toBe(true);

    persistence.observe(false);
    expect(persistence.persistent()).toBe(false);
    persistence.observe(true);
    expect(persistence.persistent()).toBe(false);
  });

  test("recovery needs fresh successes, not just time passing failures out", () => {
    const tracker = new SyncHealthTracker();
    for (let i = 0; i < SYNC_FAILURE_FLOOR + 1; i++) tracker.failed(tracker.started(0), 0);
    expect(tracker.degraded(1_000)).toBe(true);

    for (let i = 0; i < SYNC_FAILURE_FLOOR + 2; i++) {
      tracker.succeeded(tracker.started(2_000), 2_000);
    }
    expect(tracker.degraded(2_000)).toBe(false);
  });

  test("a completion after being swept records no second outcome", () => {
    const tracker = new SyncHealthTracker();
    const slow = tracker.started(0);
    tracker.sweep(SYNC_REQUEST_TIMEOUT_MS);
    expect(tracker.summary(SYNC_REQUEST_TIMEOUT_MS)).toBe("1 failed / 0 ok in window");

    tracker.succeeded(slow, SYNC_REQUEST_TIMEOUT_MS + 1);
    tracker.failed(slow, SYNC_REQUEST_TIMEOUT_MS + 1);
    expect(tracker.summary(SYNC_REQUEST_TIMEOUT_MS + 1)).toBe("1 failed / 0 ok in window");
  });

  test("an abandoned request records no outcome at all", () => {
    const tracker = new SyncHealthTracker();
    tracker.abandoned(tracker.started(0));
    tracker.sweep(SYNC_REQUEST_TIMEOUT_MS);
    expect(tracker.summary(SYNC_REQUEST_TIMEOUT_MS)).toBe("0 failed / 0 ok in window");
  });

  test("abandoning everything in flight leaves nothing for the sweep", () => {
    const tracker = new SyncHealthTracker();
    for (let i = 0; i < SYNC_FAILURE_FLOOR; i++) tracker.started(0);
    tracker.abandonOutstanding();
    tracker.sweep(SYNC_REQUEST_TIMEOUT_MS);
    expect(tracker.summary(SYNC_REQUEST_TIMEOUT_MS)).toBe("0 failed / 0 ok in window");
  });
});

test("isolated GraphQL throttles do not imply session-wide rate limiting", () => {
  const tracker = new SyncHealthTracker();
  const response = (status: number) => tracker.response(tracker.started(1000), status, 1001, true);
  expect(response(429)).toBe(false);
  for (let i = 0; i < 10; i++) expect(response(200)).toBe(false);
  for (let i = 0; i < 5; i++) expect(response(429)).toBe(false);
});

test("corroborated HTTP throttles trigger backoff but offline and abandoned requests do not", () => {
  const tracker = new SyncHealthTracker();
  for (let i = 0; i < 4; i++)
    expect(tracker.response(tracker.started(1000), 429, 1001, true)).toBe(false);
  expect(tracker.response(tracker.started(1000), 429, 1001, true)).toBe(true);
  expect(tracker.response(tracker.started(1000), 429, 1001, false)).toBe(false);
  const abandoned = tracker.started(1000);
  tracker.abandoned(abandoned);
  expect(tracker.response(abandoned, 429, 1001, true)).toBe(false);
  expect(tracker.response(tracker.started(1_000_000), 429, 1_000_001, true)).toBe(false);
});

test("recovery recognizes sync metadata without consuming opaque bodies", () => {
  const name = "LSPlatformGraphQLLightspeedRequestQuery";
  expect(isMessengerSyncOperation(null, name)).toBe(true);
  expect(isMessengerSyncOperation(new URLSearchParams({ fb_api_req_friendly_name: name }))).toBe(
    true,
  );
  expect(isMessengerSyncOperation(`x=1&fb_api_req_friendly_name=${name}`)).toBe(true);
  expect(isMessengerSyncOperation("fb_api_req_friendly_name=SearchQuery")).toBe(false);
  expect(isMessengerSyncOperation("fb_api_req_friendly_name=%not-encoded")).toBe(false);
  expect(isMessengerSyncOperation(new ReadableStream())).toBe(false);
});
