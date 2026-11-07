/*
 * Read access to Messenger's local database (LightSpeed) through the page's
 * module system. Shared by the unread/mute reader and the recent-conversations
 * menu. Never writes to Messenger.
 */

export type Load = (name: string) => unknown;

export interface MessengerDatabase {
  tables: {
    threads: { get(key: unknown): Promise<unknown>; index(name: string): unknown };
    participants: unknown;
    contacts: unknown;
  };
}

export interface I64 {
  of_string(value: string): unknown;
  to_string?(value: unknown): unknown;
}

export interface MessengerDatabaseAccess {
  db: MessengerDatabase;
  i64: I64;
  load: Load;
}

/**
 * Runs `read` against Messenger's database. Null when the page's module
 * system, the database or its APIs are unavailable, when `read` throws, or
 * when the read does not finish within `timeoutMs`.
 */
export async function readMessengerDatabase<T>(
  load: unknown,
  read: (access: MessengerDatabaseAccess) => Promise<T>,
  timeoutMs = 750,
): Promise<T | null> {
  if (typeof load !== "function") return null;
  const run = async () => {
    const singleton = load("LSDatabaseSingleton") as { LSDatabaseSingleton: Promise<unknown> };
    const db = (await singleton.LSDatabaseSingleton) as MessengerDatabase;
    const i64 = load("I64") as I64;
    if (typeof db?.tables?.threads?.get !== "function" || typeof i64?.of_string !== "function") {
      throw new Error("Messenger database APIs changed");
    }
    return read({ db, i64, load: load as Load });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
