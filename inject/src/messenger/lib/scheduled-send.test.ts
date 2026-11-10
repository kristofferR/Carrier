import { describe, expect, test } from "bun:test";
import { formatLocale } from "../../i18n";
import {
  formatScheduleTime,
  isComposerDeliveryActive,
  localScheduleTime,
  nextDueMessage,
  schedulePresets,
  sendWindow,
  withComposerDelivery,
  withComposerDeliveryWhenAvailable,
} from "./scheduled-send";

describe("scheduled sending", () => {
  test("allows exactly two minutes of grace, never an early or late submission", () => {
    expect(sendWindow(1000, 999)).toBe("early");
    expect(sendWindow(1000, 1000)).toBe("due");
    expect(sendWindow(1000, 121000)).toBe("due");
    expect(sendWindow(1000, 121001)).toBe("missed");
  });
  test("delivers the earliest due message after the app wakes", () => {
    const later = { id: "later", status: "scheduled" as const, due: 61_000 };
    const earlier = { id: "earlier", status: "scheduled" as const, due: 60_000 };
    const draft = { id: "draft", status: "draft" as const, due: 59_000 };
    const items = [later, earlier, draft].map((item) => ({
      ...item,
      account: "account",
      thread: "/t/1/",
      text: "message",
      toast_seen: false,
    }));
    expect(nextDueMessage(items, 61_000)?.id).toBe("earlier");
    expect(nextDueMessage(items, 59_000)).toBeUndefined();
  });
  test("accepts 24-hour times and rejects invalid or rolled dates", () => {
    const time = localScheduleTime("2026-09-24", "23:45");
    expect(time).not.toBeNull();
    expect(new Date(time!).getHours()).toBe(23);
    expect(localScheduleTime("2026-09-24", "00:00")).not.toBeNull();
    for (const invalid of ["24:00", "12:60", "9:30", "9:30 PM"])
      expect(localScheduleTime("2026-09-24", invalid)).toBeNull();
    expect(localScheduleTime("2026-02-30", "09:00")).toBeNull();
    expect(formatScheduleTime(time!, time!, "en-GB")).toMatch(/^23\D+45$/u);
  });
  test("shows a send time on the locale's clock", () => {
    const evening = new Date(2026, 8, 23, 21, 5).getTime();
    expect(formatScheduleTime(evening, evening, "en-GB")).toMatch(/^21\D+05$/u);
    const us = formatScheduleTime(evening, evening, "en-US");
    expect(us.match(/\d+/gu)).toEqual(["9", "05"]);
    const period = new Intl.DateTimeFormat("en-US", { hour: "numeric" })
      .formatToParts(evening)
      .find((part) => part.type === "dayPeriod")?.value;
    expect(period).toBeDefined();
    expect(us).toContain(period!);
    expect(formatScheduleTime(evening - 12 * 3_600_000, evening, "nb-NO")).toMatch(/^09\D+05$/u);
  });
  test("shows only as much date as a send time needs", () => {
    const at = (day: number, hour = 9) => new Date(2026, 8, day, hour, 0).getTime();
    const now = at(23, 18);
    const name = (time: number, options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(formatLocale(), options).format(time);
    expect(formatScheduleTime(at(23, 23), now, "en-GB")).toMatch(/^23\D+00$/u);
    // Tomorrow through six days out name the weekday; a week out names the date.
    for (const day of [24, 29])
      expect(formatScheduleTime(at(day), now)).toContain(name(at(day), { weekday: "short" }));
    for (const day of [30, 22]) {
      const text = formatScheduleTime(at(day), now);
      expect(text).toContain(name(at(day), { month: "short" }));
      expect(text).not.toContain(name(at(day), { weekday: "short" }));
    }
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
    expect(isComposerDeliveryActive()).toBe(false);
    let release: () => void = () => {};
    const held = withComposerDelivery(
      () =>
        new Promise<void>((resolve) => {
          expect(isComposerDeliveryActive()).toBe(true);
          release = resolve;
        }),
    );
    expect(await withComposerDelivery(async () => "collision")).toBeUndefined();
    release();
    await held;
    expect(isComposerDeliveryActive()).toBe(false);
    await expect(
      withComposerDelivery(async () => {
        expect(isComposerDeliveryActive()).toBe(true);
        throw new Error("failed");
      }),
    ).rejects.toThrow();
    expect(isComposerDeliveryActive()).toBe(false);
    expect(await withComposerDelivery(async () => "free")).toBe("free");
  });

  test("holds a draft fallback until the composer is free", async () => {
    let release: () => void = () => {};
    const held = withComposerDelivery(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const order: number[] = [];
    const first = withComposerDeliveryWhenAvailable(async () => {
      expect(isComposerDeliveryActive()).toBe(true);
      order.push(1);
    });
    const second = withComposerDeliveryWhenAvailable(async () => {
      expect(isComposerDeliveryActive()).toBe(true);
      order.push(2);
    });
    expect(order).toEqual([]);
    release();
    await Promise.all([held, first, second]);
    expect(order).toEqual([1, 2]);
    expect(isComposerDeliveryActive()).toBe(false);
    expect(await withComposerDelivery(async () => "free")).toBe("free");
  });
});
