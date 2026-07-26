import { describe, expect, test } from "bun:test";
import {
  ConsecutiveFailureThreshold,
  isMessengerRealtimeUrl,
  looksLikeFacebookErrorPage,
  REALTIME_CONNECT_GRACE_MS,
  REALTIME_CORROBORATION_MS,
  REALTIME_NEVER_CONNECTED_MS,
  REALTIME_SILENCE_MS,
  REALTIME_UNOBSERVED_MS,
  RealtimeHealthWatchdog,
  RealtimeRecoveryTracker,
} from "./realtime-health";

describe("isMessengerRealtimeUrl", () => {
  test("recognizes Meta's Messenger MQTT websocket endpoints", () => {
    expect(
      isMessengerRealtimeUrl("wss://edge-chat.facebook.com/chat", "https://facebook.com"),
    ).toBe(true);
    expect(
      isMessengerRealtimeUrl("wss://gateway.facebook.com/ws/realtime", "https://facebook.com"),
    ).toBe(true);
    expect(isMessengerRealtimeUrl("wss://gateway.messenger.com/ws", "https://messenger.com")).toBe(
      true,
    );
    expect(
      isMessengerRealtimeUrl("wss://a.edge-chat.facebook.com/chat", "https://facebook.com"),
    ).toBe(true);
  });

  test("rejects lookalikes, ordinary requests, and malformed URLs", () => {
    expect(
      isMessengerRealtimeUrl("wss://edge-chat.facebook.com.evil.test/chat", "https://facebook.com"),
    ).toBe(false);
    expect(
      isMessengerRealtimeUrl("https://edge-chat.facebook.com/chat", "https://facebook.com"),
    ).toBe(false);
    expect(
      isMessengerRealtimeUrl("wss://gateway.messenger.com.evil.test/ws", "https://facebook.com"),
    ).toBe(false);
    expect(isMessengerRealtimeUrl("not a websocket", "not a base")).toBe(false);
  });
});

describe("RealtimeHealthWatchdog", () => {
  test("does not reload-loop when the first connection cannot open", () => {
    const watchdog = new RealtimeHealthWatchdog<string>();
    watchdog.created("first", 0);

    expect(watchdog.health(REALTIME_CONNECT_GRACE_MS * 2)).toBe("starting");
    watchdog.closed("first", REALTIME_CONNECT_GRACE_MS * 2);
    expect(watchdog.health(REALTIME_CONNECT_GRACE_MS * 3)).toBe("starting");
  });

  test("stops judging the transport once the page owns no realtime socket", () => {
    const watchdog = new RealtimeHealthWatchdog<string>();
    watchdog.created("first", 0);
    watchdog.opened("first", 100);
    watchdog.closed("first", 200);

    expect(watchdog.health(200 + REALTIME_CONNECT_GRACE_MS - 1)).toBe("recovering");
    // Messenger moves sync into a worker and never replaces the page socket.
    // Owning none is unobservable, not dead — calling it stale here reloaded
    // the page every recovery interval, indefinitely, while messages arrived.
    expect(watchdog.health(200 + REALTIME_CONNECT_GRACE_MS)).toBe("starting");
  });

  test("allows a replacement socket a bounded connection grace period", () => {
    const watchdog = new RealtimeHealthWatchdog<string>();
    watchdog.created("old", 0);
    watchdog.opened("old", 100);
    watchdog.closed("old", 200);
    watchdog.created("replacement", 200);

    expect(watchdog.health(200 + REALTIME_CONNECT_GRACE_MS - 1)).toBe("recovering");
    expect(watchdog.health(200 + REALTIME_CONNECT_GRACE_MS)).toBe("stale");
  });

  test("does not extend reconnect grace for repeated replacement attempts", () => {
    const watchdog = new RealtimeHealthWatchdog<string>();
    watchdog.created("old", 0);
    watchdog.opened("old", 100);
    watchdog.closed("old", 200);
    watchdog.created("replacement-1", 300);
    watchdog.created("replacement-2", 200 + REALTIME_CONNECT_GRACE_MS - 1);

    expect(watchdog.health(200 + REALTIME_CONNECT_GRACE_MS)).toBe("stale");
  });

  test("detects a half-open socket from missing inbound MQTT traffic", () => {
    const watchdog = new RealtimeHealthWatchdog<string>();
    watchdog.created("socket", 0);
    watchdog.opened("socket", 100);

    expect(watchdog.health(100 + REALTIME_SILENCE_MS - 1)).toBe("healthy");
    expect(watchdog.health(100 + REALTIME_SILENCE_MS)).toBe("stale");

    watchdog.received("socket", 100 + REALTIME_SILENCE_MS);
    expect(watchdog.health(100 + REALTIME_SILENCE_MS)).toBe("healthy");
  });

  test("gives a socket created after the unobservable state a fresh grace period", () => {
    const watchdog = new RealtimeHealthWatchdog<string>();
    watchdog.created("first", 0);
    watchdog.opened("first", 100);
    watchdog.closed("first", 200);
    // Settle into the no-socket state, closing out the recovery epoch.
    expect(watchdog.health(200 + REALTIME_CONNECT_GRACE_MS)).toBe("starting");

    // Messenger later falls back to a page-owned socket. It must get its own
    // connection grace rather than be judged against the old socket's close.
    const createdAt = 10 * REALTIME_CONNECT_GRACE_MS;
    watchdog.created("replacement", createdAt);
    expect(watchdog.health(createdAt + REALTIME_CONNECT_GRACE_MS - 1)).toBe("recovering");
    expect(watchdog.health(createdAt + REALTIME_CONNECT_GRACE_MS)).toBe("stale");
  });

  test("keeps the transport healthy while any open socket receives traffic", () => {
    const watchdog = new RealtimeHealthWatchdog<string>();
    watchdog.created("old", 0);
    watchdog.opened("old", 10);
    watchdog.created("new", 20);
    watchdog.opened("new", 30);
    watchdog.received("new", REALTIME_SILENCE_MS);

    expect(watchdog.health(REALTIME_SILENCE_MS + 1)).toBe("healthy");
  });
});

describe("realtime recovery signals", () => {
  test("lets a recently healthy source vouch for a stale one", () => {
    const tracker = new RealtimeRecoveryTracker(0);
    tracker.stale("socket");
    tracker.stale("worker");

    tracker.healthy("worker", 0);
    // A responsive worker proves messages are still flowing, so a dead page
    // socket alongside it must not force a reload.
    expect(tracker.needsRecovery(REALTIME_CORROBORATION_MS)).toBe(false);
    // Once that proof goes stale the socket's verdict stands on its own.
    expect(tracker.needsRecovery(REALTIME_CORROBORATION_MS + 1)).toBe(true);

    tracker.healthy("socket", REALTIME_CORROBORATION_MS + 1);
    expect(tracker.needsRecovery(REALTIME_CORROBORATION_MS * 10)).toBe(false);
  });

  test("a withdrawn source stops asserting the staleness it reported", () => {
    const tracker = new RealtimeRecoveryTracker(0);
    tracker.stale("socket");
    expect(tracker.needsRecovery(0)).toBe(true);

    // Withdrawal is not a health claim: it only retracts an opinion the
    // source can no longer form.
    tracker.withdraw("socket");
    expect(tracker.needsRecovery(0)).toBe(false);
    expect(tracker.status(REALTIME_NEVER_CONNECTED_MS)).toBe("never");
  });

  test("treats an unconfirmable transport as needing recovery, not as ok", () => {
    const tracker = new RealtimeRecoveryTracker(0);
    tracker.healthy("socket", 0);
    // The socket closes and is never replaced, and the worker bridge is
    // unavailable, so no source reports anything either way.
    tracker.withdraw("socket");

    expect(tracker.needsRecovery(REALTIME_UNOBSERVED_MS - 1)).toBe(false);
    expect(tracker.status(REALTIME_UNOBSERVED_MS - 1)).toBe("ok");
    // Silence for this long is a fault of its own: leaving it "ok" disarmed
    // both page-side and native recovery while the inbox sat frozen.
    expect(tracker.needsRecovery(REALTIME_UNOBSERVED_MS)).toBe(true);
    expect(tracker.status(REALTIME_UNOBSERVED_MS)).toBe("stale");
  });

  test("a live source keeps an unobserved sibling from forcing recovery", () => {
    const tracker = new RealtimeRecoveryTracker(0);
    tracker.healthy("socket", 0);
    tracker.withdraw("socket");
    // The worker keeps answering its probe, so the transport is confirmed.
    tracker.healthy("worker", REALTIME_UNOBSERVED_MS);

    expect(tracker.needsRecovery(REALTIME_UNOBSERVED_MS)).toBe(false);
    expect(tracker.status(REALTIME_UNOBSERVED_MS * 2 - 1)).toBe("ok");
  });

  test("restarts the unobserved window when the clock jumps backwards", () => {
    const tracker = new RealtimeRecoveryTracker(0);
    tracker.healthy("socket", REALTIME_UNOBSERVED_MS * 4);
    tracker.withdraw("socket");

    // Wall time is corrected backwards, leaving the report dated in the
    // future. Without rebasing, the window could not elapse until real time
    // caught up — hours of "ok" over a frozen inbox.
    expect(tracker.needsRecovery(0)).toBe(false);
    expect(tracker.needsRecovery(REALTIME_UNOBSERVED_MS)).toBe(true);
  });

  test("a future-dated report cannot vouch for a stale source indefinitely", () => {
    const tracker = new RealtimeRecoveryTracker(0);
    tracker.healthy("worker", REALTIME_UNOBSERVED_MS * 4);
    tracker.stale("socket");

    expect(tracker.needsRecovery(0)).toBe(false);
    expect(tracker.needsRecovery(REALTIME_CORROBORATION_MS + 1)).toBe(true);
  });

  test("a page that never connected is left to the never ladder", () => {
    const tracker = new RealtimeRecoveryTracker(0);

    expect(tracker.needsRecovery(REALTIME_UNOBSERVED_MS * 10)).toBe(false);
    expect(tracker.status(REALTIME_UNOBSERVED_MS * 10)).toBe("never");
  });

  test("a withdrawn source vouches only as long as its last healthy report", () => {
    const tracker = new RealtimeRecoveryTracker(0);
    tracker.healthy("socket", 0);
    // The page loses sight of its socket, then the worker probe starts failing.
    tracker.withdraw("socket");
    tracker.stale("worker");

    // The socket was proven live moments ago, so hold off briefly...
    expect(tracker.needsRecovery(REALTIME_CORROBORATION_MS)).toBe(false);
    // ...but an unobservable source cannot vouch indefinitely.
    expect(tracker.needsRecovery(REALTIME_CORROBORATION_MS + 1)).toBe(true);
  });

  test("reports pending then never when no source ever connects", () => {
    const tracker = new RealtimeRecoveryTracker(0);

    expect(tracker.status(REALTIME_NEVER_CONNECTED_MS - 1)).toBe("pending");
    expect(tracker.status(REALTIME_NEVER_CONNECTED_MS)).toBe("never");
  });

  test("reports ok once any source has been healthy", () => {
    const tracker = new RealtimeRecoveryTracker(0);
    tracker.healthy("worker");

    expect(tracker.status(REALTIME_NEVER_CONNECTED_MS * 10)).toBe("ok");
  });

  test("a healthy history prevents never", () => {
    const tracker = new RealtimeRecoveryTracker(0);
    tracker.healthy("socket");
    tracker.stale("socket");
    tracker.healthy("socket");

    expect(tracker.status(REALTIME_NEVER_CONNECTED_MS * 10)).toBe("ok");
  });

  test("recognizes Facebook's static error page skeleton and nothing bigger", () => {
    expect(
      looksLikeFacebookErrorPage({ hasBackLink: true, hasIconImage: true, elementCount: 30 }),
    ).toBe(true);
    expect(
      looksLikeFacebookErrorPage({ hasBackLink: true, hasIconImage: true, elementCount: 100 }),
    ).toBe(false);
    expect(
      looksLikeFacebookErrorPage({ hasBackLink: false, hasIconImage: true, elementCount: 30 }),
    ).toBe(false);
    expect(
      looksLikeFacebookErrorPage({ hasBackLink: true, hasIconImage: false, elementCount: 30 }),
    ).toBe(false);
  });

  test("reports stale while an uncorroborated source is stale and ok after all recover", () => {
    const tracker = new RealtimeRecoveryTracker(0);
    tracker.healthy("socket", 0);
    tracker.stale("socket");
    tracker.stale("worker");

    tracker.healthy("worker", 0);
    expect(tracker.status(REALTIME_CORROBORATION_MS + 1)).toBe("stale");

    tracker.healthy("socket", REALTIME_CORROBORATION_MS + 1);
    expect(tracker.status(REALTIME_CORROBORATION_MS + 1)).toBe("ok");
  });

  test("reports a worker that misses its first three probes", () => {
    const failures = new ConsecutiveFailureThreshold(3);

    expect(failures.failed()).toBe(false);
    expect(failures.failed()).toBe(false);
    expect(failures.failed()).toBe(true);

    failures.succeeded();
    expect(failures.failed()).toBe(false);
  });
});
