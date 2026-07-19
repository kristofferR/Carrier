import { describe, expect, test } from "bun:test";
import {
  isMessengerRealtimeUrl,
  REALTIME_CONNECT_GRACE_MS,
  REALTIME_SILENCE_MS,
  RealtimeHealthWatchdog,
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
    watchdog.closed("first");
    expect(watchdog.health(REALTIME_CONNECT_GRACE_MS * 3)).toBe("starting");
  });

  test("reports a previously connected transport as stale when it closes", () => {
    const watchdog = new RealtimeHealthWatchdog<string>();
    watchdog.created("first", 0);
    watchdog.opened("first", 100);
    watchdog.closed("first");

    expect(watchdog.health(200)).toBe("stale");
  });

  test("allows a replacement socket a bounded connection grace period", () => {
    const watchdog = new RealtimeHealthWatchdog<string>();
    watchdog.created("old", 0);
    watchdog.opened("old", 100);
    watchdog.closed("old");
    watchdog.created("replacement", 200);

    expect(watchdog.health(200 + REALTIME_CONNECT_GRACE_MS - 1)).toBe("recovering");
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
