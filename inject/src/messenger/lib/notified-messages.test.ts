import { describe, expect, test } from "bun:test";
import { notifiedMessage, rememberNotifiedMessage } from "./notified-messages";

const memoryStorage = (): Storage => {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => items.delete(key),
    setItem: (key, value) => items.set(key, value),
  };
};

describe("notified messages", () => {
  test("survive a reload through storage and keep the newest fifty", () => {
    const storage = memoryStorage();
    for (let id = 1; id <= 60; id++) rememberNotifiedMessage(id, `m${id}`, id, storage);
    expect(notifiedMessage(60, storage)).toEqual({ body: "m60", at: 60 });
    expect(notifiedMessage(11, storage)).toEqual({ body: "m11", at: 11 });
    expect(notifiedMessage(10, storage)).toBeUndefined();
  });

  test("ignores corrupt storage", () => {
    const storage = memoryStorage();
    storage.setItem("carrier-notified-messages", "{not json");
    expect(notifiedMessage(1, storage)).toBeUndefined();
    rememberNotifiedMessage(1, "hi", 5, storage);
    expect(notifiedMessage(1, storage)).toEqual({ body: "hi", at: 5 });
  });
});
