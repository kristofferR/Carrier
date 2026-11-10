/*
 * Messenger's own new-message notifications (Ref #351).
 *
 * Messenger only raises a Web Notification when it believes it runs as the
 * installed messenger.com app (`isMessengerPWA() && justknobx._("1465")`) and
 * the page is hidden. Neither holds in Chatpane, so Messenger never notified and
 * every Chatpane notification was reconstructed from the chat list. Rewriting
 * exactly those two checks in `useMWLSChatPopperUpper` lets Messenger notify
 * whenever the window is hidden or unfocused, like the old desktop app.
 *
 * `MWDesktopNotifications.triggerLocalNotification(db, message)` is where it
 * decides to notify. Its message row carries the exact thread, and the
 * notification's `tag` is that row's message id, so recording one against the
 * other gives each page notification its real conversation instead of one
 * inferred from its text.
 *
 * Idea from fMess (github.com/toanbku/fmess, MIT).
 */

export const CHAT_POPPER_MODULE = "useMWLSChatPopperUpper";
export const DESKTOP_NOTIFICATIONS_MODULE = "MWDesktopNotifications";

const CHAT_POPPER_REWRITES: [RegExp, string][] = [
  // Notify while the window is merely unfocused, not only when hidden.
  [
    /(\w+)\("VisibilityAPI"\)\.isVisibilityHidden\(\)===!0/,
    '($1("VisibilityAPI").isVisibilityHidden()===!0||!document.hasFocus())',
  ],
  // The installed-app gate.
  [/\w+\("isMessengerPWA"\)\(\)&&\w+\("justknobx"\)\._\("1465"\)/, "!0"],
];

/**
 * The chat-popper factory source with both checks rewritten, or null unless
 * each pattern matches exactly once. A changed module keeps its original code.
 */
export function rewriteChatPopperSource(source: string): string | null {
  let rewritten = source;
  for (const [pattern, replacement] of CHAT_POPPER_REWRITES) {
    if (rewritten.match(new RegExp(pattern.source, "g"))?.length !== 1) return null;
    rewritten = rewritten.replace(pattern, replacement);
  }
  return rewritten;
}

/** A decimal id from Messenger's number, bigint, string or opaque I64 value. */
export function messengerId(
  value: unknown,
  i64ToString?: (value: unknown) => unknown,
): string | null {
  let text: unknown = value;
  if (typeof value === "number" || typeof value === "bigint") text = String(value);
  else if (typeof value !== "string" && value != null && i64ToString) {
    try {
      text = i64ToString(value);
    } catch {
      return null;
    }
  }
  return typeof text === "string" && /^\d+$/.test(text) ? text : null;
}

const MESSAGE_LIMIT = 100;

/** Recently notified message ids and their conversations, newest last. */
export class PageMessageIndex {
  private readonly threads = new Map<string, string>();
  private readonly stale = new Set<string>();
  private readonly raised = new Set<string>();
  private readonly textless = new Set<string>();

  record(messageId: string, threadId: string, textless = false): void {
    this.threads.delete(messageId);
    this.threads.set(messageId, threadId);
    if (this.threads.size > MESSAGE_LIMIT) {
      const oldest = this.threads.keys().next().value!;
      this.threads.delete(oldest);
      this.textless.delete(oldest);
    }
    if (textless) this.textless.add(messageId);
    else this.textless.delete(messageId);
  }

  /** The message has no text of its own, only attachments: Messenger's
   * notification body is its translated summary of them. */
  isTextless(tag: unknown): boolean {
    return typeof tag === "string" && this.textless.has(tag);
  }

  /** The conversation of the notification tagged with this message id. */
  threadFor(tag: unknown): string | undefined {
    return typeof tag === "string" ? this.threads.get(tag) : undefined;
  }

  /** The message is old news (see {@link isOldNews}): its notification is suppressed. */
  markStale(messageId: string): void {
    this.stale.add(messageId);
    if (this.stale.size > MESSAGE_LIMIT) this.stale.delete(this.stale.values().next().value!);
  }

  isStale(tag: unknown): boolean {
    return typeof tag === "string" && this.stale.has(tag);
  }

  /** Messenger raised a Notification for this message. */
  wasRaised(tag: unknown): boolean {
    return typeof tag === "string" && this.raised.has(tag);
  }

  /**
   * Whether a Notification with this tag was already raised; records it if
   * not. Messenger can notify twice about one message, and a web notification
   * reusing a shown tag replaces it rather than adding another.
   */
  repeats(tag: unknown): boolean {
    if (typeof tag !== "string" || !tag) return false;
    if (this.raised.has(tag)) return true;
    this.raised.add(tag);
    if (this.raised.size > MESSAGE_LIMIT) this.raised.delete(this.raised.values().next().value!);
    return false;
  }
}

/** Shared by the module hook (writer) and the Notification bridge (reader). */
export const pageMessages = new PageMessageIndex();

/**
 * How Messenger titles a named group's notification in its UI language,
 * "{senderName} to {threadName}" in English. Read from its notification
 * module's source when the module is defined; empty if that fails.
 */
export const groupTitleTemplates: string[] = [];

/** The string literals in `source` that place both a sender and a group. */
export function readGroupTitleTemplates(source: string): string[] {
  const templates = new Set<string>();
  for (const [, literal = ""] of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    if (!literal.includes("{senderName}") || !literal.includes("{threadName}")) continue;
    try {
      templates.add(JSON.parse(`"${literal}"`));
    } catch {}
  }
  return [...templates];
}

type Load = (name: string) => unknown;

/** Record a message Messenger is about to notify about. Malformed rows are ignored. */
export function recordNotifiedMessage(message: unknown, load: unknown): void {
  if (!message || typeof message !== "object") return;
  const row = message as { messageId?: unknown; text?: unknown };
  if (typeof row.messageId !== "string" || !row.messageId) return;
  const threadId = messageThreadId(message, load);
  // A vaulted text is still a non-empty string.
  if (threadId) pageMessages.record(row.messageId, threadId, row.text == null || row.text === "");
}

/** The conversation id of a Messenger message row, or null. */
export function messageThreadId(message: unknown, load: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  return pageId((message as { threadKey?: unknown }).threadKey, load);
}

/** A decimal id from a Messenger value, reading I64s with the page's own module. */
export function pageId(value: unknown, load: unknown): string | null {
  let i64ToString: ((value: unknown) => unknown) | undefined;
  try {
    const i64 =
      typeof load === "function" ? ((load as Load)("I64") as { to_string?: unknown }) : null;
    if (typeof i64?.to_string === "function") {
      i64ToString = i64.to_string.bind(i64) as (value: unknown) => unknown;
    }
  } catch {}
  return messengerId(value, i64ToString);
}

/** A message notified this late is old news: a computer back from sleep catching up. */
export const LATE_NOTIFICATION_MS = 2 * 60_000;

/**
 * Whether a message Messenger is about to notify about needs no notification:
 * it was sent over {@link LATE_NOTIFICATION_MS} ago, or its conversation was
 * already read past it (on another device). Unknown values never suppress.
 */
export function isOldNews(
  sentMs: number | null,
  nowMs: number | null,
  readUpToMs: number | null,
): boolean {
  if (sentMs === null) return false;
  if (nowMs !== null && nowMs - sentMs > LATE_NOTIFICATION_MS) return true;
  return readUpToMs !== null && readUpToMs >= sentMs;
}

interface I64Module {
  to_string?(value: unknown): unknown;
}

/** Milliseconds from Messenger's number or I64 value, or null. */
export function messengerMillis(value: unknown, load: unknown): number | null {
  let i64ToString: ((value: unknown) => unknown) | undefined;
  try {
    const i64 = typeof load === "function" ? ((load as Load)("I64") as I64Module) : null;
    if (typeof i64?.to_string === "function") i64ToString = i64.to_string.bind(i64);
  } catch {}
  const digits = messengerId(value, i64ToString);
  const millis = digits === null ? Number.NaN : Number(digits);
  return Number.isSafeInteger(millis) ? millis : null;
}

/** Facebook's server clock, or null when it can't be read (never the local clock). */
export function serverNowMs(load: unknown): number | null {
  try {
    const time = typeof load === "function" ? (load as Load)("ServerTime") : null;
    const millis = (time as { getMillis?: () => unknown } | null)?.getMillis?.();
    return typeof millis === "number" && Number.isFinite(millis) ? millis : null;
  } catch {
    return null;
  }
}

interface ThreadsTable {
  get(key: unknown): Promise<unknown>;
}

/**
 * Whether `message` is old news, reading its conversation's read watermark
 * from the database Messenger notifies from. False when anything is missing,
 * fails or takes longer than `timeoutMs`: a check that can't run notifies.
 * Adapted from fMess (github.com/toanbku/fmess, MIT): `isOldNews` in
 * src-tauri/src/inject/14-notifications.js.
 */
export async function readOldNews(
  db: unknown,
  message: unknown,
  load: unknown,
  timeoutMs = 750,
): Promise<boolean> {
  if (!message || typeof message !== "object") return false;
  const row = message as { timestampMs?: unknown; threadKey?: unknown };
  const sentMs = messengerMillis(row.timestampMs, load);
  if (sentMs === null) return false;
  const nowMs = serverNowMs(load);
  if (isOldNews(sentMs, nowMs, null)) return true;
  const threads = (db as { tables?: { threads?: ThreadsTable } } | null)?.tables?.threads;
  if (typeof threads?.get !== "function") return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const thread = (await threads.get(row.threadKey)) as {
      lastReadWatermarkTimestampMs?: unknown;
    } | null;
    if (!thread || typeof thread !== "object") return false;
    return isOldNews(sentMs, nowMs, messengerMillis(thread.lastReadWatermarkTimestampMs, load));
  };
  try {
    return await Promise.race([
      read().catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Factory = (...args: unknown[]) => unknown;

/** Keep Haste's arity-based invocation ABI intact for a wrapped factory. */
export function sameArity(wrapped: Factory, original: Factory): Factory {
  try {
    Object.defineProperty(wrapped, "length", { value: original.length });
  } catch {}
  return wrapped;
}

/**
 * Wrap a Haste module factory so `patch` can adjust its exports once it has
 * run. Haste hands exports in the last two arguments (module, exports) or
 * returns them; `patch` returns true once it recognised them, and anything it
 * doesn't recognise is left as Facebook shipped it.
 */
export function wrapFactoryExports(
  factory: Factory,
  patch: (exports: Record<string, unknown>) => boolean,
): Factory {
  const tryPatch = (exports: unknown) =>
    Boolean(exports) && typeof exports === "object" && patch(exports as Record<string, unknown>);
  return sameArity(function (this: unknown, ...args: unknown[]) {
    const result = Reflect.apply(factory, this, args);
    for (const candidate of [result, ...args.slice(-2)]) {
      try {
        if (tryPatch(candidate)) break;
        if (
          candidate &&
          typeof candidate === "object" &&
          tryPatch((candidate as { exports?: unknown }).exports)
        ) {
          break;
        }
      } catch {}
    }
    return result;
  }, factory);
}

/**
 * Wrap MWDesktopNotifications so each message it notifies about is recorded
 * first, and marked stale when it is old news. Messenger still notifies: the
 * Notification bridge suppresses a stale one the way it suppresses a muted
 * one, which also keeps its unread row from raising a fallback. Its group
 * title templates are read here too (see {@link groupTitleTemplates}).
 */
export function wrapDesktopNotificationsFactory(factory: Factory, load: () => unknown): Factory {
  const templates = readGroupTitleTemplates(Function.prototype.toString.call(factory));
  groupTitleTemplates.splice(0, groupTitleTemplates.length, ...templates);
  return wrapFactoryExports(factory, (exports) => {
    const trigger = exports.triggerLocalNotification;
    if (typeof trigger !== "function") return false;
    exports.triggerLocalNotification = function (this: unknown, ...args: unknown[]) {
      const notify = () => Reflect.apply(trigger, this, args);
      let check: Promise<boolean>;
      try {
        const page = load();
        recordNotifiedMessage(args[1], page);
        check = readOldNews(args[0], args[1], page);
      } catch {
        return notify();
      }
      return check.then((old) => {
        const messageId = (args[1] as { messageId?: unknown } | null)?.messageId;
        if (old && typeof messageId === "string") pageMessages.markStale(messageId);
        return notify();
      }, notify);
    };
    return true;
  });
}

/**
 * Wrap the chat popper's factory so it runs the rewritten source once that has
 * loaded (as a blob: script; the page forbids eval). Modules run when first
 * required, normally well after definition; until the rewrite is ready, or if
 * it cannot be built, the original runs.
 */
export function wrapChatPopperFactory(
  factory: Factory,
  loadRewritten: (source: string, ready: (rewritten: Factory) => void) => void,
  onUnmatched: () => void,
): Factory {
  let rewritten: Factory | null = null;
  const source = rewriteChatPopperSource(Function.prototype.toString.call(factory));
  if (source === null) onUnmatched();
  else {
    loadRewritten(source, (ready) => {
      rewritten = ready;
    });
  }
  return sameArity(function (this: unknown, ...args: unknown[]) {
    return Reflect.apply(rewritten ?? factory, this, args);
  }, factory);
}

let rewriteSeq = 0;

interface ScriptHost {
  createElement(tag: "script"): {
    src: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    remove(): void;
  };
  head: { append(node: unknown): void } | null;
  documentElement: { append(node: unknown): void };
}

/**
 * Evaluate `source` (a function expression) as a blob: script and hand the
 * resulting function to `ready`. The page forbids eval but allows blob:
 * scripts; if it refuses this one too, the caller's original code stays.
 */
export function loadRewrittenScript(
  source: string,
  ready: (rewritten: Factory) => void,
  doc: ScriptHost,
  global: Record<string, unknown>,
  report: (outcome: "loaded" | "refused" | "invalid") => void,
): void {
  const key = `__chatpaneRewritten${++rewriteSeq}`;
  const url = URL.createObjectURL(
    new Blob([`window[${JSON.stringify(key)}] = (${source});`], { type: "text/javascript" }),
  );
  const script = doc.createElement("script");
  script.src = url;
  const done = () => {
    URL.revokeObjectURL(url);
    script.remove();
  };
  script.onload = () => {
    const rewritten = global[key];
    delete global[key];
    done();
    if (typeof rewritten === "function") {
      ready(rewritten as Factory);
      report("loaded");
    } else report("invalid");
  };
  script.onerror = () => {
    done();
    report("refused");
  };
  (doc.head ?? doc.documentElement).append(script);
}
