import { describe, expect, test } from "bun:test";
import {
  AutoRefreshWatchdog,
  NOTIFICATION_REFRESH_GAP_MS,
  PERIODIC_REFRESH_MS,
  RESUME_GAP_MS,
} from "./auto-refresh";

describe("AutoRefreshWatchdog", () => {
  test("refreshes a visible but unfocused window after the background limit", () => {
    const watchdog = new AutoRefreshWatchdog(0, true);
    watchdog.setActive(false, 1_000);

    for (let now = 5_000; now <= PERIODIC_REFRESH_MS; now += 5_000) {
      expect(watchdog.heartbeat(false, now)).toBeNull();
    }
    expect(watchdog.heartbeat(false, PERIODIC_REFRESH_MS + 1_000)).toBe("background");
  });

  test("refreshes on focus after a long background period", () => {
    const watchdog = new AutoRefreshWatchdog(0, true);
    watchdog.setActive(false, 1_000);

    expect(watchdog.setActive(true, PERIODIC_REFRESH_MS + 1_000)).toBe("foreground");
  });

  test("does not refresh after a short focus change", () => {
    const watchdog = new AutoRefreshWatchdog(0, true);
    watchdog.setActive(false, 1_000);

    expect(watchdog.setActive(true, PERIODIC_REFRESH_MS)).toBeNull();
  });

  test("detects a suspended webview even when it remains focused", () => {
    const watchdog = new AutoRefreshWatchdog(0, true);

    expect(watchdog.heartbeat(true, RESUME_GAP_MS - 1)).toBeNull();
    expect(watchdog.heartbeat(true, 2 * RESUME_GAP_MS)).toBe("resume");
  });

  test("does not mistake ordinary heartbeats or a backwards clock for resume", () => {
    const watchdog = new AutoRefreshWatchdog(10_000, true);

    expect(watchdog.heartbeat(true, 20_000)).toBeNull();
    expect(watchdog.heartbeat(true, 5_000)).toBeNull();
    expect(watchdog.heartbeat(true, 25_000)).toBeNull();
  });

  test("rate-limits notification-triggered refreshes from page load", () => {
    const watchdog = new AutoRefreshWatchdog(10_000, false);

    expect(watchdog.canRefreshFromNotification(10_000 + NOTIFICATION_REFRESH_GAP_MS - 1)).toBe(
      false,
    );
    expect(watchdog.canRefreshFromNotification(10_000 + NOTIFICATION_REFRESH_GAP_MS)).toBe(true);
  });

  test("does not refresh for a notification immediately after active use", () => {
    const watchdog = new AutoRefreshWatchdog(0, true);
    watchdog.heartbeat(true, PERIODIC_REFRESH_MS);
    watchdog.setActive(false, PERIODIC_REFRESH_MS + 1_000);

    expect(
      watchdog.canRefreshFromNotification(PERIODIC_REFRESH_MS + NOTIFICATION_REFRESH_GAP_MS - 1),
    ).toBe(false);
    expect(
      watchdog.canRefreshFromNotification(PERIODIC_REFRESH_MS + NOTIFICATION_REFRESH_GAP_MS),
    ).toBe(true);
  });
});
