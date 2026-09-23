import { describe, expect, test } from "bun:test";
import {
  formatScheduleTime,
  localScheduleTime,
  schedulePresets,
  sendWindow,
  withComposerDelivery,
} from "./scheduled-send";

describe("scheduled sending", () => {
  test("allows exactly two minutes of grace, never an early or late submission", () => {
    expect(sendWindow(1000, 999)).toBe("early");
    expect(sendWindow(1000, 1000)).toBe("due");
    expect(sendWindow(1000, 121000)).toBe("due");
    expect(sendWindow(1000, 121001)).toBe("missed");
  });
  test("accepts 24-hour times and rejects invalid or rolled dates", () => {
    const time = localScheduleTime("2026-09-24", "23:45");
    expect(time).not.toBeNull();
    expect(new Date(time!).getHours()).toBe(23);
    expect(localScheduleTime("2026-09-24", "00:00")).not.toBeNull();
    for (const invalid of ["24:00", "12:60", "9:30", "9:30 PM"])
      expect(localScheduleTime("2026-09-24", invalid)).toBeNull();
    expect(localScheduleTime("2026-02-30", "09:00")).toBeNull();
    expect(formatScheduleTime(time!)).toContain("23:45");
  });
  test("presets are future times and omit an evening that already passed", () => {
    const now = new Date(2026, 8, 23, 19, 0).getTime();
    const presets = schedulePresets(now);
    expect(presets.map((p) => p.label)).not.toContain("This evening");
    expect(presets.every((p) => p.due > now)).toBe(true);
    expect(new Date(presets.at(-1)!.due).getHours()).toBe(9);
    expect(new Date(presets.at(-1)!.due).getDate()).toBe(24);
  });
  test("serializes composer users and releases after failure", async () => {
    let release: () => void = () => {};
    const held = withComposerDelivery(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(await withComposerDelivery(async () => "collision")).toBeUndefined();
    release();
    await held;
    await expect(
      withComposerDelivery(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow();
    expect(await withComposerDelivery(async () => "free")).toBe("free");
  });
});
