import { describe, expect, test } from "bun:test";
import { muteIsActive, readNewestMessageId, readThreadStates } from "./thread-state";

const NOW = 1_800_000_000_000;

describe("muteIsActive", () => {
  test("reads forever, future, past and unmuted expiries in every representation", () => {
    expect(muteIsActive(-1, NOW)).toBe(true);
    expect(muteIsActive("-1", NOW)).toBe(true);
    expect(muteIsActive(BigInt(NOW + 60_000), NOW)).toBe(true);
    expect(muteIsActive(NOW - 1, NOW)).toBe(false);
    expect(muteIsActive(0, NOW)).toBe(false);
    // Messenger's I64 values are opaque; their string form decides.
    expect(muteIsActive({ i64: true }, NOW, () => String(NOW + 1))).toBe(true);
  });

  test("returns null for values it does not understand", () => {
    expect(muteIsActive(undefined, NOW)).toBeNull();
    expect(muteIsActive("soon", NOW)).toBeNull();
    expect(muteIsActive({}, NOW)).toBeNull();
    expect(muteIsActive({}, NOW, () => undefined)).toBeNull();
  });
});

function harness(threads: Record<string, unknown>) {
  const modules: Record<string, unknown> = {
    LSDatabaseSingleton: {
      LSDatabaseSingleton: Promise.resolve({
        tables: { threads: { get: async (key: unknown) => threads[String(key)] } },
      }),
    },
    I64: { of_string: (value: string) => value, to_string: (value: unknown) => String(value) },
    MWPIsThreadUnread: {
      isThreadUnreadForViewer: (thread: { unread?: unknown }) => thread.unread,
    },
  };
  return { modules, load: (name: string) => modules[name] };
}

describe("readThreadStates", () => {
  test("reads unread and mute state for known chats and skips the rest", async () => {
    const h = harness({
      "1": { unread: true, muteExpireTimeMs: 0 },
      "2": { unread: false, muteExpireTimeMs: -1 },
      "3": { unread: "maybe", muteExpireTimeMs: 0 },
    });
    const states = await readThreadStates(["1", "2", "3", "4", "x"], h.load, NOW);
    expect(states).toEqual(
      new Map([
        ["1", { unread: true, muted: false }],
        ["2", { unread: false, muted: true }],
      ]),
    );
  });

  test("is null when Messenger's modules are missing, changed or never ready", async () => {
    expect(await readThreadStates(["1"], undefined, NOW)).toBeNull();
    expect(
      await readThreadStates(
        ["1"],
        () => {
          throw new Error("module unavailable");
        },
        NOW,
      ),
    ).toBeNull();
    const changed = harness({});
    changed.modules.MWPIsThreadUnread = {};
    expect(await readThreadStates(["1"], changed.load, NOW)).toBeNull();
    const pending = harness({});
    pending.modules.LSDatabaseSingleton = { LSDatabaseSingleton: new Promise(() => {}) };
    expect(await readThreadStates(["1"], pending.load, NOW, 1)).toBeNull();
  });
});

describe("readNewestMessageId", () => {
  const messages = { name: "messages" };
  const load = (byThread: Record<string, { messageId: unknown }[]>) => (name: string) =>
    ({
      LSDatabaseSingleton: {
        LSDatabaseSingleton: Promise.resolve({ tables: { threads: { get() {} }, messages } }),
      },
      I64: { of_string: (value: string) => `i64:${value}` },
      ReQL: {
        fromTableDescending: (table: unknown) => ({
          getKeyRange: (key: string) => ({
            take: (limit: number) =>
              table === messages ? (byThread[key.slice(4)] ?? []).slice(0, limit) : [],
          }),
        }),
        toArrayAsync: async (query: unknown) => query,
      },
    })[name];

  test("reads the newest message's id, newest first as Messenger stores them", async () => {
    const db = load({ "10": [{ messageId: "mid.new" }, { messageId: "mid.old" }] });
    expect(await readNewestMessageId("10", db)).toBe("mid.new");
  });

  test("is null for an empty or unreadable conversation", async () => {
    expect(await readNewestMessageId("10", load({}))).toBeNull();
    expect(await readNewestMessageId("10", load({ "10": [{ messageId: 7 }] }))).toBeNull();
    expect(await readNewestMessageId("x", load({}))).toBeNull();
    expect(await readNewestMessageId("10", undefined)).toBeNull();
  });
});
