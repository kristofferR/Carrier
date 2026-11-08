import { describe, expect, test } from "bun:test";
import {
  READ_AHEAD,
  readAheadWait,
  selectReadAheadThreads,
  type ThreadTypeUtil,
} from "./read-ahead";

const types: ThreadTypeUtil = {
  isMessengerOrE2EEInbox: (folder) => folder === "inbox",
  isOpenOrArmadilloFnFThread: (thread) => (thread as { fnf?: boolean }).fnf !== false,
  isArmadilloSecure: (type) => type === "secure",
};
const toId = (value: unknown) => (value == null ? null : String(value));
const row = (threadKey: number, extra: Record<string, unknown> = {}) => ({
  threadKey,
  folderName: "inbox",
  threadType: "secure",
  authorityLevel: 80,
  ...extra,
});

describe("selectReadAheadThreads", () => {
  test("keeps confirmed encrypted inbox chats, newest first", () => {
    const picked = selectReadAheadThreads(
      [
        row(1),
        row(2, { threadType: "plain" }),
        row(3, { folderName: "archived" }),
        row(4, { isDisappearingMode: true }),
        row(5, { authorityLevel: 20 }),
        row(6, { fnf: false }),
        row(7),
      ],
      types,
      toId,
      null,
    );
    expect(picked.map((thread) => thread.id)).toEqual(["1", "7"]);
    expect(picked[0]).toEqual({ id: "1", threadKey: 1, authorityLevel: 80 });
  });

  test("skips the open chat, duplicates and malformed rows, and stops at the limit", () => {
    const picked = selectReadAheadThreads(
      [null, row(1), row(2), row(2), row(3), row(4)],
      types,
      toId,
      "1",
      2,
    );
    expect(picked.map((thread) => thread.id)).toEqual(["2", "3"]);
  });
});

describe("readAheadWait", () => {
  test("runs at once the first time, then keeps the minimum gap", () => {
    expect(readAheadWait(null, 1_000)).toBe(0);
    expect(readAheadWait(1_000, 6_000)).toBe(READ_AHEAD.minGapMs - 5_000);
    expect(readAheadWait(1_000, 1_000 + READ_AHEAD.minGapMs + 1)).toBe(0);
  });
});
