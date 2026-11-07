import { afterEach, describe, expect, test } from "bun:test";
import {
  messengerDndActive,
  muteUntilFromDatabase,
  readMessengerDndUntil,
  setMessengerDndUntil,
} from "./messenger-dnd";
import { suppressNotificationDelivery } from "./mute";

const NOW_MS = 1_800_000_000_000;

afterEach(() => setMessengerDndUntil(null));

describe("messengerDndActive", () => {
  test("is on until the end time, forever for -1, and off for 0 or unknown", () => {
    setMessengerDndUntil(NOW_MS / 1000 + 60);
    expect(messengerDndActive(NOW_MS)).toBe(true);
    setMessengerDndUntil(NOW_MS / 1000 - 1);
    expect(messengerDndActive(NOW_MS)).toBe(false);
    setMessengerDndUntil(-1);
    expect(messengerDndActive(NOW_MS)).toBe(true);
    setMessengerDndUntil(0);
    expect(messengerDndActive(NOW_MS)).toBe(false);
    setMessengerDndUntil(null);
    expect(messengerDndActive(NOW_MS)).toBe(false);
  });

  test("suppresses notification delivery like Mute Notifications", () => {
    expect(suppressNotificationDelivery(false, {})).toBe(false);
    setMessengerDndUntil(-1);
    expect(suppressNotificationDelivery(false, {})).toBe(true);
  });
});

describe("muteUntilFromDatabase", () => {
  test("reads numbers, bigints, digit strings and I64 values", () => {
    expect(muteUntilFromDatabase(1_800_000_060)).toBe(1_800_000_060);
    expect(muteUntilFromDatabase(-1n)).toBe(-1);
    expect(muteUntilFromDatabase("0")).toBe(0);
    expect(muteUntilFromDatabase({ hi: 0 }, () => "42")).toBe(42);
    expect(muteUntilFromDatabase(undefined)).toBeNull();
    expect(muteUntilFromDatabase({}, () => "soon")).toBeNull();
  });
});

describe("readMessengerDndUntil", () => {
  const harness = (row: unknown) => {
    const keys: unknown[] = [];
    const modules: Record<string, unknown> = {
      LSDatabaseSingleton: {
        LSDatabaseSingleton: Promise.resolve({
          tables: {
            notification_settings: {
              get: async (key: unknown) => {
                keys.push(key);
                return row;
              },
            },
          },
        }),
      },
      I64: { of_string: (value: string) => `key:${value}` },
    };
    return { keys, modules, load: (name: string) => modules[name] };
  };

  test("reads the signed-in account's settings row", async () => {
    const h = harness({ globalMuteUntil: -1 });
    expect(await readMessengerDndUntil("100", h.load)).toBe(-1);
    expect(h.keys).toEqual(["key:100"]);
    expect(await readMessengerDndUntil("100", harness(undefined).load)).toBe(0);
  });

  test("is null without an account, a database or a working API", async () => {
    expect(await readMessengerDndUntil("", harness({}).load)).toBeNull();
    expect(await readMessengerDndUntil("100", undefined)).toBeNull();
    expect(
      await readMessengerDndUntil("100", () => {
        throw new Error("module unavailable");
      }),
    ).toBeNull();
    const pending = harness({});
    pending.modules.LSDatabaseSingleton = { LSDatabaseSingleton: new Promise(() => {}) };
    expect(await readMessengerDndUntil("100", pending.load, 1)).toBeNull();
  });
});

describe("notificationsGloballyMuted", () => {
  test("a tray pause silences notifications until its end time", async () => {
    const { notificationsGloballyMuted } = await import("./mute");
    expect(notificationsGloballyMuted({ notifications_paused_until: NOW_MS + 1 }, NOW_MS)).toBe(
      true,
    );
    expect(notificationsGloballyMuted({ notifications_paused_until: NOW_MS }, NOW_MS)).toBe(false);
    expect(notificationsGloballyMuted({ notifications_paused_until: null }, NOW_MS)).toBe(false);
  });
});
