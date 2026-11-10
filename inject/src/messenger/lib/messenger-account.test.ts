import { describe, expect, test } from "bun:test";
import { applied, dndUntilFor, readReceiptsOn, stateFromViewer } from "./messenger-account";

describe("stateFromViewer", () => {
  test("resolves Active Status with Messenger's rule and keeps unknowns null", () => {
    const calls: unknown[][] = [];
    const resolve = (...args: unknown[]) => {
      calls.push(args);
      return args[1];
    };
    expect(
      stateFromViewer(
        { chat_sounds_on: false, chat_visibility: true, chat_visibility_on_messenger: false },
        resolve,
        -1,
        false,
      ),
    ).toEqual({ activeStatus: false, sounds: false, dndUntil: -1, readReceipts: false });
    expect(calls).toEqual([[true, false, null]]);
    expect(stateFromViewer({ chat_sounds_on: "yes" }, () => undefined, 0, null)).toEqual({
      activeStatus: null,
      sounds: null,
      dndUntil: 0,
      readReceipts: null,
    });
  });
});

describe("readReceiptsOn", () => {
  test("reads the account's row first, where unset and default mean on", () => {
    expect(readReceiptsOn({ setting: 1 }, 0)).toBe(false);
    expect(readReceiptsOn({ setting: 2 }, 1)).toBe(true);
    expect(readReceiptsOn({ setting: 0 }, 1)).toBe(true);
    expect(readReceiptsOn({ setting: null }, 1)).toBe(true);
  });

  test("falls back to the page's own setting, and reports unknown as null", () => {
    expect(readReceiptsOn(null, 1)).toBe(false);
    expect(readReceiptsOn(null, 0)).toBe(true);
    expect(readReceiptsOn(null, undefined)).toBe(null);
  });
});

describe("dndUntilFor", () => {
  test("keeps off and until-turned-off, and adds minutes to now", () => {
    const now = 1_800_000_000_500;
    expect(dndUntilFor(0, now)).toBe(0);
    expect(dndUntilFor(-1, now)).toBe(-1);
    expect(dndUntilFor(60, now)).toBe(1_800_000_000 + 3600);
  });
});

describe("applied", () => {
  test("checks Do Not Disturb against the requested end, not just on or off", () => {
    const state = (dndUntil: number | null) => ({
      activeStatus: false,
      sounds: false,
      dndUntil,
      readReceipts: true,
    });
    const inAnHour = Math.floor(Date.now() / 1000) + 3600;
    expect(applied(state(inAnHour), { setting: "doNotDisturb", value: 60 })).toBe(true);
    expect(applied(state(inAnHour), { setting: "doNotDisturb", value: -1 })).toBe(false);
    expect(applied(state(-1), { setting: "doNotDisturb", value: 60 })).toBe(false);
    expect(applied(state(null), { setting: "doNotDisturb", value: 60 })).toBe(false);
    expect(applied(state(0), { setting: "doNotDisturb", value: 0 })).toBe(true);
  });

  test("checks read receipts against the requested value", () => {
    const state = (readReceipts: boolean | null) => ({
      activeStatus: true,
      sounds: true,
      dndUntil: 0,
      readReceipts,
    });
    expect(applied(state(false), { setting: "readReceipts", value: false })).toBe(true);
    expect(applied(state(true), { setting: "readReceipts", value: false })).toBe(false);
    expect(applied(state(null), { setting: "readReceipts", value: true })).toBe(false);
  });
});
