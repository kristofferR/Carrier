import { describe, expect, test } from "bun:test";
import { markThreadRead, reactToMessage } from "./notification-actions";

// I64 values are strings in these fakes.
const i64 = {
  of_string: (value: string) => value,
  to_string: (value: unknown) => String(value),
  of_float: (value: number) => String(value),
  gt: (a: unknown, b: unknown) => Number(a) > Number(b),
};

function harness({ secure = false, v2 = false } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const threads: Record<string, Record<string, unknown>> = {
    "123": {
      threadType: secure ? 15 : 1,
      lastActivityTimestampMs: "20",
      lastReadWatermarkTimestampMs: "10",
    },
  };
  const messages: Record<string, unknown> = {
    "mid.$a": { messageId: "mid.$a", threadKey: "123", senderId: "7" },
    "mid.$mine": { messageId: "mid.$mine", threadKey: "123", senderId: "42" },
    "mid.$other": { messageId: "mid.$other", threadKey: "999", senderId: "7" },
  };
  const reactions: Record<string, unknown> = {};
  const tx = {
    messages: { index: () => ({ get: async (id: string) => messages[id] }) },
    reactions: {
      get: async (thread: unknown, message: unknown, actor: unknown) =>
        reactions[`${thread}/${message}/${actor}`],
    },
  };
  const db = {
    tables: { threads: { get: async (key: string) => threads[key] } },
    runInTransaction: async (run: (t: typeof tx) => unknown) => run(tx),
  };
  const record =
    (name: string, result?: unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return result;
    };
  const modules: Record<string, unknown> = {
    LSDatabaseSingleton: { LSDatabaseSingleton: Promise.resolve(db) },
    I64: i64,
    MWLSMarkThreadAsRead: (_db: unknown, key: string) => {
      calls.push({ name: "markRead", args: [key] });
      threads[key]!.lastReadWatermarkTimestampMs = "20";
      return Promise.resolve();
    },
    LSMessagingThreadTypeUtil: { isArmadilloSecure: (type: unknown) => type === 15 },
    LSThreadAttributionTypeUtil: { getSourceWithoutReset: () => "source" },
    MAWDbMsg: { toMsgId: (id: string) => `msg:${id}` },
    MAWMiActOnActThreadReady: {
      waitForACTThreadReady: async () => ({ chatJid: "chat@msgr" }),
    },
    MAWGetProtocolMsgIdByMsgIdInUI: {
      getProtocolMsgIdByMsgIdUI: async (id: string) => ({ externalId: id }),
    },
    MAWBridgeSendAndReceive: { sendAndReceive: record("bridge", Promise.resolve({})) },
    MAWExternalId: { generateExternalId: () => "ext" },
    qpl: { _: (id: number) => ({ i: id }) },
    useIsReactionsV2Enabled: { isReactionsV2Enabled: () => v2 },
    LSFactory: (t: unknown) => ({ factory: t }),
    LSOptimisticUpsertReactionStoredProcedure: record("upsert", Promise.resolve()),
  };
  const load = (name: string) => {
    if (!(name in modules)) throw new Error(`no ${name}`);
    return modules[name];
  };
  return { calls, threads, reactions, modules, load };
}

const request = {
  threadId: "123",
  messageId: "mid.$a",
  account: "42",
  reaction: "👍",
  deadline: Number.MAX_SAFE_INTEGER,
};

describe("markThreadRead", () => {
  test("marks the conversation read through Messenger and confirms it", async () => {
    const h = harness();
    expect(await markThreadRead(h.load, "123", Date.now() + 1000)).toBe("ok");
    expect(h.calls).toEqual([{ name: "markRead", args: ["123"] }]);
  });

  test("never marks read once native has given up", async () => {
    const h = harness();
    expect(await markThreadRead(h.load, "123", 0)).toBe("expired");
    expect(h.calls).toEqual([]);
  });

  test("fails when the read never lands or the module changed", async () => {
    const h = harness();
    h.modules.MWLSMarkThreadAsRead = async () => {};
    let now = Date.now();
    const deadline = now + 1000;
    const wait = async () => {
      now += 500;
    };
    const realNow = Date.now;
    Date.now = () => now;
    try {
      expect(await markThreadRead(h.load, "123", deadline, wait)).toBe("not-confirmed");
    } finally {
      Date.now = realNow;
    }
    expect(await markThreadRead(h.load, "404", Date.now() + 1000)).toBe("thread-missing");
    h.modules.MWLSMarkThreadAsRead = {};
    await expect(markThreadRead(h.load, "123", 0)).rejects.toThrow("changed");
  });
});

describe("reactToMessage", () => {
  test("sends an encrypted chat's reaction through the MAW bridge", async () => {
    const h = harness({ secure: true });
    expect(await reactToMessage(h.load, request)).toBe("ok");
    expect(h.calls).toEqual([
      {
        name: "bridge",
        args: [
          "backend",
          "sendReactionMsg",
          {
            args: {
              groupIndex: undefined,
              groupingKey: "",
              reaction: "👍",
              reactToAuthor: "7",
              reactToProtocolMsgId: { externalId: "msg:mid.$a" },
              source: "source",
            },
            chatJid: "chat@msgr",
            externalId: "ext",
            qplEventType: { i: 25313175 },
            qplInstanceKey: undefined,
          },
        ],
      },
    ]);
  });

  test("runs Messenger's reaction procedure for a regular chat", async () => {
    const h = harness();
    expect(await reactToMessage(h.load, request)).toBe("ok");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.name).toBe("upsert");
    expect(h.calls[0]?.args[1]).toMatchObject({
      actorId: "42",
      messageId: "mid.$a",
      reaction: "👍",
      sendAttribution: "source",
      threadKey: "123",
    });
    // Already reacted with it: nothing to send (a second press would not toggle it off).
    h.reactions["123/mid.$a/42"] = { reaction: "👍" };
    expect(await reactToMessage(h.load, request)).toBe("ok");
    expect(h.calls).toHaveLength(1);
  });

  test("acts only on the named message in its own conversation, never our own", async () => {
    const h = harness({ secure: true });
    expect(await reactToMessage(h.load, { ...request, messageId: "mid.$gone" })).toBe(
      "message-missing",
    );
    expect(await reactToMessage(h.load, { ...request, messageId: "mid.$other" })).toBe(
      "thread-mismatch",
    );
    expect(await reactToMessage(h.load, { ...request, messageId: "mid.$mine" })).toBe(
      "own-message",
    );
    expect(h.calls).toEqual([]);
  });

  test("never reacts once native has given up", async () => {
    for (const secure of [true, false]) {
      const h = harness({ secure });
      expect(await reactToMessage(h.load, { ...request, deadline: 0 })).toBe("expired");
      expect(h.calls).toEqual([]);
    }
  });

  test("refuses what it can't do the way Messenger does", async () => {
    expect(await reactToMessage(harness({ v2: true }).load, request)).toBe("reactions-v2");
    const h = harness({ secure: true });
    h.modules.MAWGetProtocolMsgIdByMsgIdInUI = { getProtocolMsgIdByMsgIdUI: async () => null };
    expect(await reactToMessage(h.load, request)).toBe("protocol-id");
    h.modules.MAWGetProtocolMsgIdByMsgIdInUI = {
      getProtocolMsgIdByMsgIdUI: async (id: string) => ({ externalId: id }),
    };
    h.modules.MAWBridgeSendAndReceive = {
      sendAndReceive: async () => ({ success: false }),
    };
    expect(await reactToMessage(h.load, request)).toBe("bridge-refused");
    delete h.modules.MAWBridgeSendAndReceive;
    await expect(reactToMessage(h.load, request)).rejects.toThrow();
  });
});
