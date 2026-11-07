import { describe, expect, test } from "bun:test";
import { conversationTitle, readRecentThreads } from "./recent-threads";

const VIEWER = "100";

interface Thread {
  threadKey: string;
  lastActivityTimestampMs: number;
  threadType: "1:1" | "group" | "secure";
  folderName?: string;
  isHidden?: boolean;
  threadName?: string | null;
}
interface Participant {
  threadKey: string;
  contactId: string;
  nickname?: string;
}

// A stand-in for Messenger's modules, just wide enough for the reads made.
function harness(
  threads: Thread[],
  participants: Participant[] = [],
  contacts: Record<string, { name: string; firstName?: string }> = {},
) {
  type Query = { rows: unknown[]; take(n: number): Query; getKeyRange(key: unknown): Query };
  const query = (rows: unknown[], keyOf?: (row: unknown) => unknown): Query => ({
    rows,
    take: (n) => query(rows.slice(0, n), keyOf),
    getKeyRange: (key) => query(rows.filter((row) => keyOf?.(row) === key)),
  });
  const tables = {
    threads: {
      get: async (key: unknown) => threads.find((t) => t.threadKey === key),
      index: (name: string) => ({ index: name }),
    },
    participants: { name: "participants" },
    contacts: { name: "contacts" },
  };
  const modules: Record<string, unknown> = {
    LSDatabaseSingleton: { LSDatabaseSingleton: Promise.resolve({ tables }) },
    I64: { of_string: (v: string) => v, to_string: (v: unknown) => String(v) },
    ReQL: {
      fromTableDescending: (table: unknown) => {
        expect(table).toEqual({ index: "lastActivityTimestampMs" });
        return query(
          [...threads].sort((a, b) => b.lastActivityTimestampMs - a.lastActivityTimestampMs),
        );
      },
      fromTableAscending: (table: unknown) =>
        table === tables.participants
          ? query(participants, (row) => (row as Participant).threadKey)
          : query([]),
      leftJoin: (left: Query) =>
        query(
          left.rows.map((p) => {
            const id = (p as Participant).contactId;
            return [p, contacts[id] && { id, ...contacts[id] }];
          }),
        ),
      toArrayAsync: async (q: Query) => q.rows,
    },
    LSMessagingThreadTypeUtil: {
      isMessengerOrE2EEInbox: (folder: unknown) => folder === "inbox" || folder === "e2ee",
      isArmadilloSecure: (type: unknown) => type === "secure",
      isGroup: (type: unknown) => type === "group",
      isOneToOne: (type: unknown) => type === "1:1" || type === "secure",
    },
  };
  return { modules, load: (name: string) => modules[name] };
}

const thread = (key: string, at: number, extra: Partial<Thread> = {}): Thread => ({
  threadKey: key,
  lastActivityTimestampMs: at,
  threadType: "1:1",
  folderName: "inbox",
  ...extra,
});
const dm = (key: string, other: string, nickname = ""): Participant[] => [
  { threadKey: key, contactId: VIEWER },
  { threadKey: key, contactId: other, nickname },
];
const contacts = {
  [VIEWER]: { name: "Me Myself", firstName: "Me" },
  "2": { name: "Ada Lovelace", firstName: "Ada" },
  "3": { name: "Alan Turing", firstName: "Alan" },
  "4": { name: "Grace Hopper", firstName: "Grace" },
};
const options = { viewer: VIEWER, mode: "all" as const, limit: 9 };

describe("readRecentThreads", () => {
  test("lists inbox chats by last activity, skipping archived, requests and hidden ones", async () => {
    const h = harness(
      [
        thread("11", 10),
        thread("12", 50, { threadType: "group", threadName: "Book club" }),
        thread("13", 40, { folderName: "archived" }),
        thread("14", 30, { folderName: "pending" }),
        thread("15", 20, { isHidden: true }),
        thread("16", 60, { threadType: "secure", isHidden: true }),
      ],
      [...dm("11", "2"), ...dm("16", "3")],
      contacts,
    );
    expect(await readRecentThreads(h.load, options)).toEqual([
      { name: "Alan Turing", href: "/t/16/" },
      { name: "Book club", href: "/t/12/" },
      { name: "Ada Lovelace", href: "/t/11/" },
    ]);
  });

  test("stops at the limit", async () => {
    const h = harness(
      [thread("11", 1), thread("12", 2), thread("13", 3)],
      [...dm("11", "2"), ...dm("12", "3"), ...dm("13", "4")],
      contacts,
    );
    expect(await readRecentThreads(h.load, { ...options, limit: 2 })).toEqual([
      { name: "Grace Hopper", href: "/t/13/" },
      { name: "Alan Turing", href: "/t/12/" },
    ]);
  });

  test("reads further back when the newest rows are requests or archived", async () => {
    const requests = Array.from({ length: 40 }, (_, i) =>
      thread(`9${i}`, 100 + i, { folderName: i % 2 ? "pending" : "archived" }),
    );
    const h = harness([...requests, thread("11", 1)], dm("11", "2"), contacts);
    expect(await readRecentThreads(h.load, { ...options, limit: 2 })).toEqual([
      { name: "Ada Lovelace", href: "/t/11/" },
    ]);
  });

  test("uses the fallback name, or leaves the chat out, when the database has none", async () => {
    const h = harness([thread("11", 2), thread("12", 1)]);
    expect(
      await readRecentThreads(h.load, {
        ...options,
        fallbackName: (id) => (id === "12" ? "From the row" : ""),
      }),
    ).toEqual([{ name: "From the row", href: "/t/12/" }]);
  });

  test("is null when Messenger's modules are missing or changed", async () => {
    expect(await readRecentThreads(undefined, options)).toBeNull();
    const changed = harness([]);
    changed.modules.LSMessagingThreadTypeUtil = {};
    expect(await readRecentThreads(changed.load, options)).toBeNull();
    const noReql = harness([]);
    delete noReql.modules.ReQL;
    expect(await readRecentThreads(noReql.load, options)).toBeNull();
  });
});

describe("conversationTitle", () => {
  const person = (id: string, name: string, nickname = "") => ({
    id,
    name,
    firstName: name.split(" ")[0]!,
    nickname,
    avatar: "",
  });
  const me = person(VIEWER, "Me Myself", "Captain");

  test("names a direct chat after the other person, with their nickname when shown", () => {
    const names = {
      title: "",
      isGroup: false,
      participants: [me, person("2", "Ada Lovelace", "Ace")],
    };
    expect(conversationTitle(names, VIEWER, "all")).toBe("Ace");
    expect(conversationTitle(names, VIEWER, "groups")).toBe("Ada Lovelace");
    expect(conversationTitle(names, VIEWER, "off")).toBe("Ada Lovelace");
  });

  test("gives no name to a direct chat whose other person is unclear", () => {
    const anonymous = { ...person("", "Ada Lovelace"), id: undefined };
    const names = {
      title: "",
      isGroup: false,
      participants: [{ ...me, id: undefined }, anonymous],
    };
    expect(conversationTitle(names, VIEWER, "all")).toBe("");
  });

  test("names a group by its title, else by the other members' first names", () => {
    const participants = [me, person("2", "Ada Lovelace"), person("3", "Alan Turing", "Prof")];
    expect(
      conversationTitle({ title: "Book club", isGroup: true, participants }, VIEWER, "all"),
    ).toBe("Book club");
    expect(conversationTitle({ title: "", isGroup: true, participants }, VIEWER, "all")).toBe(
      "Ada, Prof",
    );
    expect(conversationTitle({ title: "", isGroup: true, participants }, VIEWER, "off")).toBe(
      "Ada, Alan",
    );
  });
});
