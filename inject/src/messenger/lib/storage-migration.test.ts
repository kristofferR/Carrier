import { describe, expect, test } from "bun:test";
import { chatpaneStorageKey, migrateStorageKeys } from "./storage-migration";

function memoryStorage(entries: Record<string, string>, failWrites = false) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("Carrier storage keys", () => {
  test("map to Chatpane names, including account scopes", () => {
    expect(chatpaneStorageKey("__carrier_settings")).toBe("__chatpane_settings");
    expect(chatpaneStorageKey("__carrier_muted_unreads_anonymous__")).toBe(
      "__chatpane_muted_unreads_anonymous__",
    );
    expect(chatpaneStorageKey("carrier-rate-limit:123")).toBe("chatpane-rate-limit:123");
    expect(chatpaneStorageKey("carrier:login-redirect")).toBe("chatpane:login-redirect");
    // The pre-native zoom key has its own migration in zoom.ts.
    expect(chatpaneStorageKey("carrier:zoom")).toBeNull();
    expect(chatpaneStorageKey("fb_session")).toBeNull();
  });

  test("move to their new names, keeping newer Chatpane values", () => {
    const storage = memoryStorage({
      __carrier_notified_previews__: "old-previews",
      "carrier-worker-connected:42": "1",
      __carrier_settings: "old",
      __chatpane_settings: "new",
      unrelated: "kept",
    });
    migrateStorageKeys(storage);
    expect(Object.fromEntries(storage.map)).toEqual({
      __chatpane_notified_previews__: "old-previews",
      "chatpane-worker-connected:42": "1",
      __chatpane_settings: "new",
      unrelated: "kept",
    });
  });

  test("stay put when the copy can't be written", () => {
    const storage = memoryStorage({ __carrier_sender_avatars__: "faces" }, true);
    migrateStorageKeys(storage);
    expect(Object.fromEntries(storage.map)).toEqual({ __carrier_sender_avatars__: "faces" });
  });
});
