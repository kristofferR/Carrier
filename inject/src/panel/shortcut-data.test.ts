import { describe, expect, test } from "bun:test";
import { shortcutGroups } from "./shortcut-data";

describe("shortcutGroups", () => {
  test("lists every supported shortcut chord", () => {
    const items = shortcutGroups(false).flatMap((group) => group.items);
    expect(items).toHaveLength(21);
    expect(new Set(items.map((item) => item.keys)).size).toBe(items.length);
    expect(items.some((item) => item.action === "Keyboard shortcuts")).toBe(true);
  });

  test("uses platform-native modifier labels", () => {
    const windows = shortcutGroups(false).flatMap((group) => group.items);
    const mac = shortcutGroups(true).flatMap((group) => group.items);

    expect(windows.some((item) => item.keys.includes("Ctrl + K"))).toBe(true);
    expect(windows.some((item) => item.keys.includes("Ctrl + Shift + Alt + V"))).toBe(true);
    expect(mac.some((item) => item.keys.includes("⌘ + K"))).toBe(true);
    expect(mac.some((item) => item.keys.includes("⌘ + ⇧ + ⌥ + V"))).toBe(true);
  });
});
