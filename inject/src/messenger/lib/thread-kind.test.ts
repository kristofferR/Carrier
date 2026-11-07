import { describe, expect, test } from "bun:test";
import { readThreadIsGroup, suppressAsGroupChat } from "./thread-kind";

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

describe("suppressAsGroupChat", () => {
  const group = async () => true;
  test("holds back only known group chats, and only when switched off", async () => {
    expect(await suppressAsGroupChat(false, "1", group)).toBe(true);
    expect(await suppressAsGroupChat(true, "1", group)).toBe(false);
    expect(await suppressAsGroupChat(undefined, "1", group)).toBe(false);
    expect(await suppressAsGroupChat(false, null, group)).toBe(false);
    expect(await suppressAsGroupChat(false, "1", async () => null)).toBe(false);
  });
});
