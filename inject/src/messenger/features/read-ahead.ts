/* ------------------- Read ahead in encrypted chats -------------------- */
// Opening an encrypted chat is instant only when Messenger's worker has
// already loaded its newest messages into the page. Messenger does that for
// the chat row under the pointer (useMWPreloadThread); Carrier makes the same
// local call for the encrypted chats at the top of the list, so they open at
// once too. Idea and approach from fMess (github.com/toanbku/fmess, MIT).
//
// Plain chats are deliberately left out: reading ahead in them asks
// Facebook's servers for message pages, and Carrier has hit their rate limits.
//
// Preloading opens no chat, so nothing is marked as seen, and the older
// messages it loads raise no notification: Messenger notifies only for
// messages newer than any it has already seen.
import { diag } from "../bridge";
import { defaultExport, loadFacebookModules, pageRequire } from "../lib/facebook-loader";
import {
  READ_AHEAD,
  readAheadWait,
  selectReadAheadThreads,
  type ThreadTypeUtil,
} from "../lib/read-ahead";
import { accountId, isMessengerContentPath, threadIdFromHref } from "../lib/threads";
import { SILENT_RECOVERY_EVENT, SILENT_RECOVERY_RELOAD_EVENT } from "../lib/worker-recovery";
import { chatRows } from "./conversation-actions";
import { hasRateLimitEpisode } from "./rate-limit";

interface Query {
  take(limit: number): Query;
  getKeyRange(...key: unknown[]): Query;
  subscribe?(listener: () => void): unknown;
}
interface ReQL {
  fromTableAscending(table: unknown): Query;
  fromTableDescending(table: unknown): Query;
  toArrayAsync(query: Query): Promise<unknown>;
  firstAsync(query: Query): Promise<unknown>;
}
interface Database {
  tables: {
    threads: { index(name: string): unknown };
    mi_act_mapping_table?: unknown;
  };
}
interface I64 {
  to_string(value: unknown): unknown;
}
type Preload = (db: unknown, threadKey: unknown, count: number, authority: unknown) => unknown;

const MODULES = [
  "ReQL",
  "LSDatabaseSingleton",
  "LSMessagingThreadTypeUtil",
  "I64",
  "MAWPreloadSecureMessages",
];

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function initReadAhead() {
  // Call windows share the session; reading ahead belongs to the main window.
  if (window.opener) return;

  let unloading = false;
  let recoveryFailed = false;
  window.addEventListener("beforeunload", () => {
    unloading = true;
  });
  window.addEventListener(SILENT_RECOVERY_RELOAD_EVENT, () => {
    unloading = true;
  });
  window.addEventListener(SILENT_RECOVERY_EVENT, (event) => {
    recoveryFailed = (event as CustomEvent<unknown>).detail === true;
  });

  const allowed = () =>
    !unloading &&
    !recoveryFailed &&
    navigator.onLine &&
    !hasRateLimitEpisode() &&
    accountId(document.cookie) !== null &&
    isMessengerContentPath(location.pathname);

  let reported = false;
  const report = (detail: string) => {
    if (reported) return;
    reported = true;
    diag("read-ahead", detail);
  };

  const openThreadId = () => threadIdFromHref(location.pathname);

  let running = false;
  const round = async () => {
    if (running || !allowed()) return;
    running = true;
    try {
      const [q, singleton, types, i64, secure] = (await loadFacebookModules(
        pageRequire(),
        MODULES,
      )) as [ReQL, { LSDatabaseSingleton: Promise<unknown> }, ThreadTypeUtil, I64, unknown];
      const preload =
        (secure as { preloadSecureMessages?: Preload } | null)?.preloadSecureMessages ??
        (defaultExport(secure) as { preloadSecureMessages?: Preload } | null)
          ?.preloadSecureMessages;
      const db = (await singleton?.LSDatabaseSingleton) as Database | undefined;
      if (
        typeof preload !== "function" ||
        typeof q?.toArrayAsync !== "function" ||
        typeof q.firstAsync !== "function" ||
        typeof i64?.to_string !== "function" ||
        typeof types?.isOpenOrArmadilloFnFThread !== "function" ||
        typeof db?.tables?.threads?.index !== "function" ||
        !db.tables.mi_act_mapping_table
      ) {
        report("Messenger's preload APIs changed");
        return;
      }
      const toId = (value: unknown) => {
        const id = i64.to_string(value);
        return typeof id === "string" ? id : null;
      };
      const rows = await q.toArrayAsync(
        q
          .fromTableDescending(db.tables.threads.index("lastActivityTimestampMs"))
          .take(READ_AHEAD.rowsRead),
      );
      if (!Array.isArray(rows)) return report("Messenger's thread APIs changed");
      const threads = selectReadAheadThreads(rows, types, toId, openThreadId());
      let mappedCount = 0;
      let loaded = 0;
      for (const thread of threads) {
        if (!allowed() || thread.id === openThreadId()) break;
        // The worker knows a chat only once it is mapped.
        const mapped = await q.firstAsync(
          q.fromTableAscending(db.tables.mi_act_mapping_table).getKeyRange(thread.threadKey),
        );
        if (!mapped) continue;
        mappedCount += 1;
        const done = await Promise.race([
          Promise.resolve(
            preload(db, thread.threadKey, READ_AHEAD.messages, thread.authorityLevel),
          ).then(
            () => true,
            () => false,
          ),
          pause(READ_AHEAD.chatTimeoutMs).then(() => false),
        ]);
        if (done) loaded += 1;
        await pause(READ_AHEAD.chatGapMs);
      }
      diag("read-ahead.round", `chats=${threads.length} mapped=${mappedCount} loaded=${loaded}`);
    } catch (error) {
      // Facebook changed something this relies on; the next round tries again.
      report(error instanceof Error ? error.message.slice(0, 200) : "round failed");
    } finally {
      running = false;
    }
  };

  let timer = 0;
  let lastRunAt: number | null = null;
  const schedule = (delay: number) => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      const wait = readAheadWait(lastRunAt, Date.now());
      if (wait > 0) return schedule(wait);
      lastRunAt = Date.now();
      void round();
    }, delay);
  };

  // Start once the chat list is up; then again when the window is left, every
  // few minutes, and when a chat changes (a new message can leave Messenger
  // with only that one loaded, or move a chat into the top of the list).
  const start = window.setInterval(() => {
    if (!chatRows().length) return;
    window.clearInterval(start);
    schedule(8_000);
    window.addEventListener("blur", () => schedule(2_000));
    window.setInterval(() => schedule(0), 4 * 60_000);
    loadFacebookModules(pageRequire(), ["ReQL", "LSDatabaseSingleton"])
      .then(async ([q, singleton]) => {
        const db = (await (singleton as { LSDatabaseSingleton: Promise<unknown> })
          ?.LSDatabaseSingleton) as Database | undefined;
        const threads = db && (q as ReQL).fromTableAscending(db.tables.threads);
        if (typeof threads?.subscribe !== "function") return;
        threads.subscribe(() => schedule(5_000));
      })
      .catch(() => {});
  }, 1_000);
}
