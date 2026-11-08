type MigratableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/**
 * The Chatpane name for page state stored under the app's old name, Carrier:
 * `__carrier_*` keys (the settings cache and notification memory),
 * `carrier-*` keys (rate limit, worker health, restored thread, including their
 * `:<account>` scopes) and the login redirect marker. `null` for any other key.
 */
export function chatpaneStorageKey(key: string): string | null {
  if (key.startsWith("__carrier_")) return `__chatpane_${key.slice("__carrier_".length)}`;
  if (key.startsWith("carrier-")) return `chatpane-${key.slice("carrier-".length)}`;
  if (key === "carrier:login-redirect") return "chatpane:login-redirect";
  return null;
}

/**
 * Move state stored under Carrier's key names to Chatpane's. A value already
 * stored under the new name wins. The old key goes only once its value is safe,
 * so a full storage leaves it for the next page load to try again.
 */
export function migrateStorageKeys(storage: MigratableStorage | null): void {
  if (!storage) return;
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }
  } catch (_) {
    return;
  }
  for (const key of keys) {
    const renamed = chatpaneStorageKey(key);
    if (!renamed) continue;
    try {
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(renamed) === null) storage.setItem(renamed, value);
      storage.removeItem(key);
    } catch (_) {}
  }
}

/** Migrate the page's localStorage and sessionStorage. Either may be blocked. */
export function migratePageStorage(): void {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      migrateStorageKeys(window[name]);
    } catch (_) {}
  }
}
