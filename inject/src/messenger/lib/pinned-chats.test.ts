import { describe, expect, test } from "bun:test";
import {
  createPinnedChatsStore,
  createPinnedChatsSync,
  MAX_PINNED_CHATS,
  MAX_PINNED_NAME_CHARS,
  type PinChange,
  type PinnedSnapshot,
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

  test("a read answered during a change can't undo it, and changes go in order", async () => {
    const store = createPinnedChatsStore();
    const sent: (PinChange | undefined)[] = [];
    const answers: ((snapshot: PinnedSnapshot) => void)[] = [];
    const sync = createPinnedChatsSync(store, (change) => {
      sent.push(change);
      return new Promise((resolve) => answers.push(resolve));
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const ada = { id: "1", name: "Ada" };
    const bob = { id: "2", name: "Bob" };

    void sync.refresh();
    void sync.change({ op: "pin", ...ada });
    expect(store.getSnapshot()).toEqual([ada]);
    // The read was answered before native code saw the pin.
    answers[0]?.({ revision: 1, pins: [] });
    await settle();
    expect(store.getSnapshot()).toEqual([ada]);

    void sync.change({ op: "pin", ...bob });
    expect(sent).toEqual([undefined, { op: "pin", ...ada }]);
    answers[1]?.({ revision: 2, pins: [ada] });
    await settle();
    expect(store.getSnapshot()).toEqual([ada, bob]);
    expect(sent).toEqual([undefined, { op: "pin", ...ada }, { op: "pin", ...bob }]);
    answers[2]?.({ revision: 3, pins: [ada, bob] });
    await settle();

    // An older answer arriving late is dropped.
    void sync.refresh();
    answers[3]?.({ revision: 2, pins: [ada] });
    await settle();
    expect(store.getSnapshot()).toEqual([ada, bob]);
  });

  test("a failed change re-reads native pins even when their revision hasn't changed", async () => {
    const store = createPinnedChatsStore();
    const ada = { id: "1", name: "Ada" };
    const bob = { id: "2", name: "Bob" };
    const sent: (PinChange | undefined)[] = [];
    const sync = createPinnedChatsSync(store, async (change) => {
      sent.push(change);
      return change ? null : { revision: 1, pins: [ada] };
    });
    await sync.refresh();
    const change = sync.change({ op: "pin", ...bob });
    expect(store.getSnapshot()).toEqual([ada, bob]);
    await change;
    expect(sent).toEqual([undefined, { op: "pin", ...bob }, undefined]);
    expect(store.getSnapshot()).toEqual([ada]);
  });

  test("a listener error while showing an answer doesn't block later changes", async () => {
    const store = createPinnedChatsStore();
    const ada = { id: "1", name: "Ada" };
    const bob = { id: "2", name: "Bob" };
    const sent: (PinChange | undefined)[] = [];
    const sync = createPinnedChatsSync(store, async (change) => {
      sent.push(change);
      // Native rejected the first pin, so showing the answer changes the store.
      return { revision: sent.length, pins: change?.id === bob.id ? [bob] : [] };
    });
    const first = sync.change({ op: "pin", ...ada });
    const unsubscribe = store.subscribe(() => {
      throw new Error("listener failed");
    });
    await expect(first).rejects.toThrow("listener failed");
    unsubscribe();
    await sync.change({ op: "pin", ...bob });
    expect(sent).toEqual([
      { op: "pin", ...ada },
      { op: "pin", ...bob },
    ]);
    expect(store.getSnapshot()).toEqual([bob]);
  });
});
