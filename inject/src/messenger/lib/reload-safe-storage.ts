type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Storage for page state that must outlive a reload.
 *
 * Facebook's macOS client deletes localStorage keys it does not recognise on
 * every page load, so localStorage alone forgets Carrier's notification memory
 * at each reload and an old unread message notifies again. sessionStorage
 * survives reloads of the same window, so every write is mirrored there and
 * reads fall back to it. localStorage stays first: where Facebook leaves it
 * alone it also survives restarts and is shared between windows.
 */
export function reloadSafeStorage(
  local: KeyValueStorage | null,
  session: KeyValueStorage | null,
): KeyValueStorage | null {
  if (!local && !session) return null;
  const read = (storage: KeyValueStorage | null, key: string) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch (_) {
      return null;
    }
  };
  const remove = (storage: KeyValueStorage | null, key: string) => {
    try {
      storage?.removeItem(key);
    } catch (_) {}
  };
  return {
    getItem: (key) => read(local, key) ?? read(session, key),
    setItem: (key, value) => {
      try {
        local?.setItem(key, value);
      } catch (_) {
        // A copy that missed this write must not shadow the session copy.
        remove(local, key);
      }
      try {
        session?.setItem(key, value);
      } catch (_) {}
    },
    removeItem: (key) => {
      remove(local, key);
      remove(session, key);
    },
  };
}

/** The page's reload-safe storage. Either accessor throws when storage is blocked. */
export function pageReloadSafeStorage(): KeyValueStorage | null {
  const storage = (name: "localStorage" | "sessionStorage") => {
    try {
      return window[name];
    } catch (_) {
      return null;
    }
  };
  return reloadSafeStorage(storage("localStorage"), storage("sessionStorage"));
}
