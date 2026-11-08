import { describe, expect, test } from "bun:test";
import { applied, dndUntilFor, stateFromViewer } from "./messenger-account";

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
      ),
    ).toEqual({ activeStatus: false, sounds: false, dndUntil: -1 });
    expect(calls).toEqual([[true, false, null]]);
    expect(stateFromViewer({ chat_sounds_on: "yes" }, () => undefined, 0)).toEqual({
      activeStatus: null,
      sounds: null,
      dndUntil: 0,
    });
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
    const state = (dndUntil: number | null) => ({ activeStatus: false, sounds: false, dndUntil });
    const inAnHour = Math.floor(Date.now() / 1000) + 3600;
    expect(applied(state(inAnHour), { setting: "doNotDisturb", value: 60 })).toBe(true);
    expect(applied(state(inAnHour), { setting: "doNotDisturb", value: -1 })).toBe(false);
    expect(applied(state(-1), { setting: "doNotDisturb", value: 60 })).toBe(false);
    expect(applied(state(null), { setting: "doNotDisturb", value: 60 })).toBe(false);
    expect(applied(state(0), { setting: "doNotDisturb", value: 0 })).toBe(true);
  });
});
