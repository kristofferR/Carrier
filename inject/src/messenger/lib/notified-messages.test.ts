import { describe, expect, test } from "bun:test";
import {
  notifiedMessage,
  rememberNotifiedMessage,
  settleNotifiedMessage,
} from "./notified-messages";

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

const store = (storage = memoryStorage(), prefix = "carrier-notified-message:1:") => ({
  storage,
  prefix,
});

type TestStore = ReturnType<typeof store>;

const accept = (target: TestStore, id: number, body = `m${id}`, at = id) => {
  rememberNotifiedMessage(id, body, at, target);
  settleNotifiedMessage(id, true, at, target);
};

describe("notified messages", () => {
  test("count only once native accepts them", () => {
    const storage = store();
    rememberNotifiedMessage(1, "hi", 1, storage);
    expect(notifiedMessage(1, storage)).toBeUndefined();
    settleNotifiedMessage(1, true, 1, storage);
    expect(notifiedMessage(1, storage)).toEqual({ body: "hi", at: 1 });
  });

  test("a suppressed burst never evicts an accepted record", () => {
    const storage = store();
    accept(storage, 1);
    for (let id = 2; id <= 400; id++) {
      rememberNotifiedMessage(id, `m${id}`, id, storage);
      settleNotifiedMessage(id, false, id, storage);
    }
    expect(notifiedMessage(1, storage)).toEqual({ body: "m1", at: 1 });
  });

  test("keep the newest 256 accepted records", () => {
    const storage = store();
    for (let id = 1; id <= 300; id++) accept(storage, id);
    expect(notifiedMessage(300, storage)).toEqual({ body: "m300", at: 300 });
    expect(notifiedMessage(45, storage)).toEqual({ body: "m45", at: 45 });
    expect(notifiedMessage(44, storage)).toBeUndefined();
  });

  test("drop records older than a week", () => {
    const storage = store();
    const week = 7 * 24 * 60 * 60 * 1000;
    accept(storage, 1, "old", 0);
    accept(storage, 2, "new", week);
    expect(notifiedMessage(1, storage)).toBeUndefined();
    expect(notifiedMessage(2, storage)).toEqual({ body: "new", at: week });
  });

  test("never read another account's records", () => {
    const shared = memoryStorage();
    const first = store(shared, "carrier-notified-message:1:");
    const second = store(shared, "carrier-notified-message:2:");
    accept(first, 7, "hi", 7);
    expect(notifiedMessage(7, second)).toBeUndefined();
    expect(notifiedMessage(7, first)).toEqual({ body: "hi", at: 7 });
  });

  test("ignore corrupt storage", () => {
    const storage = store();
    storage.storage.setItem(`${storage.prefix}1`, "{not json");
    expect(notifiedMessage(1, storage)).toBeUndefined();
    accept(storage, 1, "hi", 5);
    expect(notifiedMessage(1, storage)).toEqual({ body: "hi", at: 5 });
  });
});
