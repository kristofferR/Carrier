import { describe, expect, test } from "bun:test";
import {
  createPinnedChatsStore,
  MAX_PINNED_CHATS,
  MAX_PINNED_NAME_CHARS,
  parsePinnedChats,
  parsePinnedSnapshot,
  withName,
  withoutPin,
  withPin,
} from "./pinned-chats";

describe("pinned chats", () => {
  test("keeps valid pins from untrusted input once, in order", () => {
    expect(
      parsePinnedChats([
        { id: "12", name: "  Ada \n Lovelace " },
        { id: "12", name: "again" },
        { id: "x1", name: "bad id" },
        { id: "34" },
        "junk",
        { id: "56", name: "n".repeat(200) },
      ]),
    ).toEqual([
      { id: "12", name: "Ada Lovelace" },
      { id: "34", name: "" },
      { id: "56", name: "n".repeat(MAX_PINNED_NAME_CHARS) },
    ]);
    expect(parsePinnedChats({ id: "1" })).toEqual([]);
    const many = Array.from({ length: MAX_PINNED_CHATS + 3 }, (_, i) => ({ id: `${i}`, name: "" }));
    expect(parsePinnedChats(many)).toHaveLength(MAX_PINNED_CHATS);
  });

  test("reads native snapshots only when they carry a revision", () => {
    expect(
      parsePinnedSnapshot({ revision: 3, pins: [{ id: "1", name: "Ada" }, { id: "x" }] }),
    ).toEqual({ revision: 3, pins: [{ id: "1", name: "Ada" }] });
    expect(parsePinnedSnapshot({ pins: [] })).toBeNull();
    expect(parsePinnedSnapshot({ revision: "3", pins: [] })).toBeNull();
    expect(parsePinnedSnapshot(null)).toBeNull();
  });

  test("pins last, unpins, and renames without changing what didn't change", () => {
    const one = withPin([], { id: "1", name: "Ada" });
    const two = withPin(one, { id: "2", name: "Grace" });
    expect(two.map((pin) => pin.id)).toEqual(["1", "2"]);
    expect(withPin(two, { id: "1", name: "Ada" })).toBe(two);
    expect(withPin(two, { id: "nope", name: "" })).toBe(two);
    expect(withoutPin(two, "1")).toEqual([{ id: "2", name: "Grace" }]);
    expect(withoutPin(two, "9")).toBe(two);
    expect(withName(two, "2", "Grace Hopper")[1]).toEqual({ id: "2", name: "Grace Hopper" });
    expect(withName(two, "2", "Grace")).toBe(two);
    expect(withName(two, "2", " ")).toBe(two);
  });

  test("the store notifies only on a real change and keeps its snapshots stable", () => {
    const store = createPinnedChatsStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    const empty = store.getSnapshot();
    store.replace([]);
    expect(calls).toBe(0);
    store.replace([{ id: "1", name: "Ada" }]);
    const ids = store.getIds();
    expect(calls).toBe(1);
    expect(ids.has("1")).toBe(true);
    store.replace([{ id: "1", name: "Ada" }]);
    expect(calls).toBe(1);
    expect(store.getIds()).toBe(ids);
    expect(store.getSnapshot()).not.toBe(empty);
  });
});
