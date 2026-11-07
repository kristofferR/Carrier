/*
 * Messenger's own new-message notifications (Ref #351).
 *
 * Messenger only raises a Web Notification when it believes it runs as the
 * installed messenger.com app (`isMessengerPWA() && justknobx._("1465")`) and
 * the page is hidden. Neither holds in Carrier, so Messenger never notified and
 * every Carrier notification was reconstructed from the chat list. Rewriting
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

  record(messageId: string, threadId: string): void {
    this.threads.delete(messageId);
    this.threads.set(messageId, threadId);
    if (this.threads.size > MESSAGE_LIMIT) this.threads.delete(this.threads.keys().next().value!);
  }

  /** The conversation of the notification tagged with this message id. */
  threadFor(tag: unknown): string | undefined {
    return typeof tag === "string" ? this.threads.get(tag) : undefined;
  }
}

/** Shared by the module hook (writer) and the Notification bridge (reader). */
export const pageMessages = new PageMessageIndex();

type Load = (name: string) => unknown;

/** Record a message Messenger is about to notify about. Malformed rows are ignored. */
export function recordNotifiedMessage(message: unknown, load: unknown): void {
  if (!message || typeof message !== "object") return;
  const row = message as { messageId?: unknown; threadKey?: unknown };
  if (typeof row.messageId !== "string" || !row.messageId) return;
  let i64ToString: ((value: unknown) => unknown) | undefined;
  try {
    const i64 =
      typeof load === "function" ? ((load as Load)("I64") as { to_string?: unknown }) : null;
    if (typeof i64?.to_string === "function") {
      i64ToString = i64.to_string.bind(i64) as (value: unknown) => unknown;
    }
  } catch {}
  const threadId = messengerId(row.threadKey, i64ToString);
  if (threadId) pageMessages.record(row.messageId, threadId);
}

type Factory = (...args: unknown[]) => unknown;

/** Keep Haste's arity-based invocation ABI intact for a wrapped factory. */
function sameArity(wrapped: Factory, original: Factory): Factory {
  try {
    Object.defineProperty(wrapped, "length", { value: original.length });
  } catch {}
  return wrapped;
}

/**
 * Wrap MWDesktopNotifications so each message it notifies about is recorded
 * first. Only the exports' own function is replaced; anything unexpected
 * leaves the module as Facebook shipped it.
 */
export function wrapDesktopNotificationsFactory(factory: Factory, load: () => unknown): Factory {
  const patch = (exports: unknown) => {
    if (!exports || typeof exports !== "object") return false;
    const record = exports as Record<string, unknown>;
    const trigger = record.triggerLocalNotification;
    if (typeof trigger !== "function") return false;
    record.triggerLocalNotification = function (this: unknown, ...args: unknown[]) {
      try {
        recordNotifiedMessage(args[1], load());
      } catch {}
      return Reflect.apply(trigger, this, args);
    };
    return true;
  };
  return sameArity(function (this: unknown, ...args: unknown[]) {
    const result = Reflect.apply(factory, this, args);
    for (const candidate of [result, ...args.slice(-2)]) {
      if (patch(candidate)) break;
      if (
        candidate &&
        typeof candidate === "object" &&
        patch((candidate as { exports?: unknown }).exports)
      ) {
        break;
      }
    }
    return result;
  }, factory);
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
