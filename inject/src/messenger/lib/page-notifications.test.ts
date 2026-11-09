import { describe, expect, test } from "bun:test";
import {
  isOldNews,
  LATE_NOTIFICATION_MS,
  loadRewrittenScript,
  messengerId,
  PageMessageIndex,
  pageMessages,
  readGroupTitleTemplates,
  readOldNews,
  rewriteChatPopperSource,
  wrapChatPopperFactory,
  wrapDesktopNotificationsFactory,
} from "./page-notifications";

const GATED =
  'function(a,b,c,d,e,f){if(d("isMessengerPWA")()&&d("justknobx")._("1465")&&b("VisibilityAPI").isVisibilityHidden()===!0)notify()}';

describe("rewriteChatPopperSource", () => {
  test("opens both of Messenger's gates", () => {
    expect(rewriteChatPopperSource(GATED)).toBe(
      'function(a,b,c,d,e,f){if(!0&&(b("VisibilityAPI").isVisibilityHidden()===!0||!document.hasFocus()))notify()}',
    );
  });

  test("leaves a changed module alone", () => {
    expect(rewriteChatPopperSource("function(){notify()}")).toBeNull();
    // Only one gate still present.
    expect(
      rewriteChatPopperSource('function(b){b("VisibilityAPI").isVisibilityHidden()===!0}'),
    ).toBeNull();
    // A gate that appears twice is ambiguous.
    expect(rewriteChatPopperSource(GATED + GATED)).toBeNull();
  });
});

describe("messengerId", () => {
  test("reads numbers, bigints, digit strings and I64 values", () => {
    expect(messengerId(42)).toBe("42");
    expect(messengerId(7987654321098765432n)).toBe("7987654321098765432");
    expect(messengerId("123")).toBe("123");
    expect(messengerId({ i64: true }, () => "99")).toBe("99");
    expect(messengerId({}, () => "x")).toBeNull();
    expect(messengerId(undefined)).toBeNull();
  });
});

describe("PageMessageIndex", () => {
  test("finds a conversation by notification tag and forgets the oldest", () => {
    const index = new PageMessageIndex();
    index.record("mid.1", "10");
    expect(index.threadFor("mid.1")).toBe("10");
    expect(index.threadFor(undefined)).toBeUndefined();
    for (let i = 0; i < 100; i++) index.record(`m${i}`, "20");
    expect(index.threadFor("mid.1")).toBeUndefined();
  });

  test("a notification tag repeats only after it was raised", () => {
    const index = new PageMessageIndex();
    expect(index.repeats("mid.1")).toBe(false);
    expect(index.repeats("mid.1")).toBe(true);
    expect(index.repeats("mid.2")).toBe(false);
    expect(index.repeats(undefined)).toBe(false);
    expect(index.repeats(undefined)).toBe(false);
  });
});

describe("readGroupTitleTemplates", () => {
  test("finds the group title in Messenger's module, whatever the language", () => {
    // Messenger's title function as shipped in English.
    const english =
      'function d(e,t,n,r){var o=n!=null?n:r;return e&&t!=null?s._(/*BTDS*/"{senderName} to {threadName}",[s._param("senderName",o),s._param("threadName",t)]).toString():e?s._(/*BTDS*/"{senderName} to your group",[s._param("senderName",o)]).toString():o}';
    expect(readGroupTitleTemplates(english)).toEqual(["{senderName} to {threadName}"]);
    const escaped = 's._(/*BTDS*/"\\u00ab{threadName}\\u00bb \\"{senderName}\\"",[])';
    expect(readGroupTitleTemplates(escaped)).toEqual(['«{threadName}» "{senderName}"']);
    expect(readGroupTitleTemplates("function d(){}")).toEqual([]);
  });
});

describe("isOldNews", () => {
  const sent = 1_000_000;
  test("a late catch-up or a message already read elsewhere is old news", () => {
    expect(isOldNews(sent, sent + LATE_NOTIFICATION_MS + 1, null)).toBe(true);
    expect(isOldNews(sent, sent + 5_000, sent)).toBe(true);
    expect(isOldNews(sent, sent + 5_000, sent - 1)).toBe(false);
  });

  test("unknown times never suppress", () => {
    expect(isOldNews(null, sent * 2, sent * 2)).toBe(false);
    expect(isOldNews(sent, null, null)).toBe(false);
  });
});

describe("readOldNews", () => {
  const load = (now: number) => (name: string) =>
    name === "ServerTime"
      ? { getMillis: () => now }
      : name === "I64"
        ? { to_string: (value: unknown) => String(value) }
        : undefined;
  const db = (watermark: unknown) => ({
    tables: {
      threads: {
        get: async (key: unknown) =>
          key === 9 ? { lastReadWatermarkTimestampMs: watermark } : null,
      },
    },
  });

  test("reads the conversation's read watermark", async () => {
    const message = { timestampMs: 5_000, threadKey: 9 };
    expect(await readOldNews(db(5_000), message, load(6_000))).toBe(true);
    expect(await readOldNews(db(4_000), message, load(6_000))).toBe(false);
    expect(await readOldNews(db(0), message, load(5_000 + LATE_NOTIFICATION_MS + 1))).toBe(true);
  });

  test("notifies when the check can't run", async () => {
    const message = { timestampMs: 5_000, threadKey: 9 };
    expect(await readOldNews(null, message, load(6_000))).toBe(false);
    expect(await readOldNews(db(5_000), { threadKey: 9 }, load(6_000))).toBe(false);
    const failing = { tables: { threads: { get: async () => Promise.reject(new Error("x")) } } };
    expect(await readOldNews(failing, message, load(6_000))).toBe(false);
    const hanging = { tables: { threads: { get: () => new Promise(() => {}) } } };
    expect(await readOldNews(hanging, message, load(6_000), 10)).toBe(false);
  });
});

describe("wrapDesktopNotificationsFactory", () => {
  test("records each notified message before Messenger notifies, keeping the factory's arity", async () => {
    const calls: unknown[] = [];
    function factory(
      _a: unknown,
      _b: unknown,
      _c: unknown,
      _d: unknown,
      _module: unknown,
      exports: Record<string, unknown>,
    ) {
      exports.triggerLocalNotification = (_db: unknown, message: unknown) => {
        calls.push(message);
        return "shown";
      };
    }
    const wrapped = wrapDesktopNotificationsFactory(
      factory as never,
      () => (name: string) =>
        name === "I64" ? { to_string: (value: unknown) => String(value) } : undefined,
    );
    expect(wrapped.length).toBe(6);
    const exports: Record<string, unknown> = {};
    wrapped(null, null, null, null, {}, exports);
    const trigger = exports.triggerLocalNotification as (db: unknown, message: unknown) => unknown;
    expect(await trigger({}, { messageId: "mid.tagged", threadKey: 555 })).toBe("shown");
    expect(calls).toHaveLength(1);
    expect(pageMessages.threadFor("mid.tagged")).toBe("555");
    expect(pageMessages.isStale("mid.tagged")).toBe(false);
  });

  test("still lets Messenger notify about old news, marked stale for the bridge", async () => {
    let notified = 0;
    function factory(_module: unknown, exports: Record<string, unknown>) {
      exports.triggerLocalNotification = () => {
        notified += 1;
      };
    }
    const wrapped = wrapDesktopNotificationsFactory(
      factory as never,
      () => (name: string) =>
        name === "ServerTime"
          ? { getMillis: () => 10_000_000 }
          : name === "I64"
            ? { to_string: (value: unknown) => String(value) }
            : undefined,
    );
    const exports: Record<string, unknown> = {};
    wrapped({}, exports);
    const trigger = exports.triggerLocalNotification as (db: unknown, message: unknown) => unknown;
    await trigger({}, { messageId: "mid.old", threadKey: 1, timestampMs: 1_000 });
    expect(notified).toBe(1);
    expect(pageMessages.isStale("mid.old")).toBe(true);
  });
});

describe("wrapChatPopperFactory", () => {
  test("runs the rewritten factory once it has loaded, the original before", () => {
    const matching = new Function(`return ${GATED}`)() as (...args: unknown[]) => unknown;
    let loaded: ((rewritten: (...args: unknown[]) => unknown) => void) | undefined;
    const gated = wrapChatPopperFactory(
      matching,
      (source, done) => {
        expect(source).toContain("!document.hasFocus()");
        loaded = done;
      },
      () => {
        throw new Error("should match");
      },
    );
    expect(gated.length).toBe(6);
    loaded?.(() => "rewritten");
    expect(gated()).toBe("rewritten");
  });

  test("reports a module whose gates changed and keeps it", () => {
    let unmatched = false;
    const factory = () => "original";
    const wrapped = wrapChatPopperFactory(
      factory,
      () => {
        throw new Error("nothing to load");
      },
      () => {
        unmatched = true;
      },
    );
    expect(unmatched).toBe(true);
    expect(wrapped()).toBe("original");
  });
});

describe("loadRewrittenScript", () => {
  const host = () => {
    const appended: { src: string; onload: (() => void) | null; onerror: (() => void) | null }[] =
      [];
    const doc = {
      createElement: () => ({ src: "", onload: null, onerror: null, remove: () => {} }),
      head: { append: (node: unknown) => appended.push(node as (typeof appended)[number]) },
      documentElement: { append: () => {} },
    };
    return { appended, doc };
  };

  test("loads the rewritten source from a blob: URL and hands over the function", async () => {
    const { appended, doc } = host();
    const global: Record<string, unknown> = {};
    const outcomes: string[] = [];
    let loaded: unknown;
    loadRewrittenScript(
      "function(){return 1}",
      (fn) => {
        loaded = fn;
      },
      doc,
      global,
      (outcome) => outcomes.push(outcome),
    );
    const script = appended[0]!;
    expect(script.src.startsWith("blob:")).toBe(true);
    // The blob assigns the function to a one-off global the onload reads.
    const text = await (await fetch(script.src)).text();
    const key = /window\[("[^"]+")\]/.exec(text)?.[1];
    expect(key).toBeDefined();
    global[JSON.parse(key!)] = () => 1;
    script.onload?.();
    expect(typeof loaded).toBe("function");
    expect(outcomes).toEqual(["loaded"]);
    expect(Object.keys(global)).toEqual([]);
  });

  test("reports a refused script and keeps the original", () => {
    const { appended, doc } = host();
    const outcomes: string[] = [];
    loadRewrittenScript(
      "function(){}",
      () => {
        throw new Error("must not load");
      },
      doc,
      {},
      (outcome) => outcomes.push(outcome),
    );
    appended[0]!.onerror?.();
    expect(outcomes).toEqual(["refused"]);
  });
});
