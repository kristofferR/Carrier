import { describe, expect, test } from "bun:test";
import {
  isMessengerSyncRequest,
  SYNC_FAILURE_LIMIT,
  SYNC_REQUEST_TIMEOUT_MS,
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
  test("flags failing sync only after consecutive failures", () => {
    const tracker = new SyncHealthTracker();
    for (let i = 0; i < SYNC_FAILURE_LIMIT - 1; i++) {
      tracker.failed(tracker.started(0));
      expect(tracker.failing()).toBe(false);
    }
    tracker.failed(tracker.started(0));
    expect(tracker.failing()).toBe(true);
  });

  test("a single success resets the streak", () => {
    const tracker = new SyncHealthTracker();
    for (let i = 0; i < SYNC_FAILURE_LIMIT; i++) tracker.failed(tracker.started(0));
    expect(tracker.failing()).toBe(true);

    tracker.succeeded(tracker.started(0));
    expect(tracker.failing()).toBe(false);
    expect(tracker.streak()).toBe(0);
  });

  test("counts a hung request as one failure via sweep", () => {
    const tracker = new SyncHealthTracker();
    tracker.started(0);

    tracker.sweep(SYNC_REQUEST_TIMEOUT_MS - 1);
    expect(tracker.streak()).toBe(0);

    tracker.sweep(SYNC_REQUEST_TIMEOUT_MS);
    expect(tracker.streak()).toBe(1);
    tracker.sweep(SYNC_REQUEST_TIMEOUT_MS * 2);
    expect(tracker.streak()).toBe(1);
  });

  test("a late success after being swept still resets the streak", () => {
    const tracker = new SyncHealthTracker();
    const slow = tracker.started(0);
    for (let i = 0; i < SYNC_FAILURE_LIMIT; i++) tracker.failed(tracker.started(0));
    tracker.sweep(SYNC_REQUEST_TIMEOUT_MS);
    expect(tracker.failing()).toBe(true);

    tracker.succeeded(slow);
    expect(tracker.failing()).toBe(false);
  });
});
