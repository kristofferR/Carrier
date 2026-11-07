import { describe, expect, test } from "bun:test";
import { readThreadIsGroup, suppressGroupChat, ThreadKindCache } from "./thread-kind";

function harness(threadType: unknown) {
  const modules: Record<string, unknown> = {
    LSDatabaseSingleton: {
      LSDatabaseSingleton: Promise.resolve({
        tables: {
          threads: { get: async () => (threadType === undefined ? undefined : { threadType }) },
        },
      }),
    },
    I64: { of_string: (value: string) => value },
    LSMessagingThreadTypeUtil: {
      isGroup: (type: unknown) => type === 2,
      isOneToOne: (type: unknown) => type === 1,
    },
  };
  return { modules, load: (name: string) => modules[name] };
}

describe("readThreadIsGroup", () => {
  test("tells group and one-to-one chats apart", async () => {
    expect(await readThreadIsGroup("1", harness(2).load)).toBe(true);
    expect(await readThreadIsGroup("1", harness(1).load)).toBe(false);
  });

  test("is null when unsure", async () => {
    expect(await readThreadIsGroup("1", harness(9).load)).toBeNull();
    expect(await readThreadIsGroup("1", harness(undefined).load)).toBeNull();
    expect(await readThreadIsGroup("x", harness(2).load)).toBeNull();
    expect(await readThreadIsGroup("1", undefined)).toBeNull();
    const pending = harness(2);
    pending.modules.LSDatabaseSingleton = { LSDatabaseSingleton: new Promise(() => {}) };
    expect(await readThreadIsGroup("1", pending.load, 1)).toBeNull();
  });
});

describe("ThreadKindCache", () => {
  test("reads each conversation once and keeps only definite answers", async () => {
    let reads = 0;
    const cache = new ThreadKindCache(async (id) => {
      reads++;
      return id === "1" ? true : id === "2" ? false : null;
    });
    expect(cache.isGroup("1")).toBeUndefined();
    await Promise.all([cache.ensure("1"), cache.ensure("1")]);
    expect(reads).toBe(1);
    expect(cache.isGroup("1")).toBe(true);
    await cache.ensure("2");
    expect(cache.isGroup("2")).toBe(false);
    await cache.ensure("3");
    expect(cache.isGroup("3")).toBeUndefined();
  });
});

describe("suppressGroupChat", () => {
  test("holds back only known group chats, and only when switched off", () => {
    expect(suppressGroupChat({ notify_group_chats: false }, true)).toBe(true);
    expect(suppressGroupChat({ notify_group_chats: false }, false)).toBe(false);
    expect(suppressGroupChat({ notify_group_chats: false }, undefined)).toBe(false);
    expect(suppressGroupChat({ notify_group_chats: true }, true)).toBe(false);
    expect(suppressGroupChat({}, true)).toBe(false);
  });
});
