import { expect, test } from "bun:test";
import { NotifiedSignatureStore } from "./notification-fallback";
import { reloadSafeStorage } from "./reload-safe-storage";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};

test("a reload that wipes localStorage still remembers delivered notifications", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  new NotifiedSignatureStore(reloadSafeStorage(local, session)).markNotified("thread", "fp", "bh");

  // Facebook's macOS client drops unrecognised localStorage keys on load.
  local.data.clear();
  const reloaded = new NotifiedSignatureStore(reloadSafeStorage(local, session));

  expect(reloaded.alreadyNotified("thread", "fp")).toBe(true);
});

test("localStorage wins so windows keep sharing state where it persists", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  session.setItem("key", "this window");
  local.setItem("key", "shared");

  expect(reloadSafeStorage(local, session)?.getItem("key")).toBe("shared");
});

test("a failed localStorage write cannot shadow the newer session copy", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  const storage = reloadSafeStorage(local, session);
  storage?.setItem("key", "old");
  local.setItem = () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  storage?.setItem("key", "new");

  expect(storage?.getItem("key")).toBe("new");
});
