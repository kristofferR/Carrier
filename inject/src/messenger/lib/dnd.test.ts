import { describe, expect, test } from "bun:test";
import { dndActive, parseDndTime } from "./dnd";

const at = (hour: number, minute = 0) => new Date(2026, 0, 1, hour, minute);

describe("parseDndTime", () => {
  test("parses HH:MM into minutes since midnight", () => {
    expect(parseDndTime("22:30")).toBe(22 * 60 + 30);
    expect(parseDndTime("7:05")).toBe(7 * 60 + 5);
    expect(parseDndTime("00:00")).toBe(0);
    expect(parseDndTime(" 08:00 ")).toBe(480);
  });

  test("rejects malformed or out-of-range values", () => {
    expect(parseDndTime("")).toBeNull();
    expect(parseDndTime("24:00")).toBeNull();
    expect(parseDndTime("12:60")).toBeNull();
    expect(parseDndTime("12:3")).toBeNull();
    expect(parseDndTime("noon")).toBeNull();
    expect(parseDndTime(null)).toBeNull();
    expect(parseDndTime(undefined)).toBeNull();
  });
});

describe("dndActive", () => {
  test("same-day window: start <= now < end", () => {
    const s = { dnd_start: "09:00", dnd_end: "17:00" };
    expect(dndActive(s, at(12))).toBe(true);
    expect(dndActive(s, at(9))).toBe(true);
    expect(dndActive(s, at(17))).toBe(false); // end is exclusive
    expect(dndActive(s, at(8, 59))).toBe(false);
  });

  test("overnight window spans midnight", () => {
    const s = { dnd_start: "22:00", dnd_end: "07:00" };
    expect(dndActive(s, at(23))).toBe(true);
    expect(dndActive(s, at(3))).toBe(true);
    expect(dndActive(s, at(12))).toBe(false);
    expect(dndActive(s, at(7))).toBe(false);
  });

  test("off when unset, malformed, or start === end", () => {
    expect(dndActive({ dnd_start: "", dnd_end: "" }, at(12))).toBe(false);
    expect(dndActive({ dnd_start: "12:00", dnd_end: "12:00" }, at(12))).toBe(false);
    expect(dndActive({ dnd_start: "9am", dnd_end: "17:00" }, at(12))).toBe(false);
    expect(dndActive(undefined, at(12))).toBe(false);
  });
});
