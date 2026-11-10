/*
 * Messenger's "Couldn't load chats" screen. MWErrorBlock.react renders it for
 * every load failure of the inbox, a chat or a chat tab, always with a Refresh
 * button (getMWErrorDefinition). Chatpane counts the mounted blocks so its
 * sync recovery can treat one as an error page and reload by itself, the way
 * it already does for Facebook's fatal dialog. Idea from fMess
 * (github.com/toanbku/fmess, MIT), which hooks getMWErrorDefinition instead.
 *
 * Only Messenger's plain reload is repeated. Some errors' own Refresh button
 * also deletes the local databases first (decryption and storage failures);
 * that stays the user's choice.
 */

export const ERROR_BLOCK_MODULE = "MWErrorBlock.react";

type Factory = (this: unknown, ...args: unknown[]) => unknown;
type Component = (props: unknown) => unknown;

export interface ReactLike {
  createElement(type: unknown, props: unknown): unknown;
  useEffect(effect: () => () => void, deps: unknown[]): void;
}

/** The error names of the blocks mounted right now, one entry per block. */
export class ErrorBlockTracker {
  private readonly shown = new Map<symbol, string>();

  constructor(private readonly onChange: (shown: boolean, error: string) => void) {}

  mount(error: string): () => void {
    const token = Symbol(error);
    this.shown.set(token, error);
    this.onChange(true, error);
    return () => {
      if (!this.shown.delete(token)) return;
      this.onChange(this.shown.size > 0, error);
    };
  }

  get isShown(): boolean {
    return this.shown.size > 0;
  }
}

/** A Messenger error's name, for logs: never its message, which can carry content. */
export function errorName(props: unknown): string {
  const error = (props as { error?: unknown } | null)?.error;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && /^[\w.:-]{1,80}$/.test(name) ? name : "unknown";
}

/**
 * The error block, rendered unchanged inside a component that reports while
 * it is mounted. Without React the original component is returned as is.
 */
export function trackedErrorBlock(
  original: Component,
  react: () => ReactLike | null,
  tracker: ErrorBlockTracker,
): Component {
  const tracked = (props: unknown) => {
    const React = react();
    if (!React) return original(props);
    const name = errorName(props);
    React.useEffect(() => tracker.mount(name), [name]);
    return React.createElement(original, props);
  };
  Object.defineProperty(tracked, "displayName", { value: "ChatpaneTrackedErrorBlock" });
  return tracked;
}

const wrappedComponents = new WeakSet<object>();

/** Swap the module's default export for the tracked component once it has run. */
export function wrapErrorBlockFactory(
  factory: Factory,
  react: () => ReactLike | null,
  tracker: ErrorBlockTracker,
): Factory {
  const patch = (exports: unknown) => {
    if (!exports || typeof exports !== "object") return false;
    const record = exports as { default?: unknown };
    const component = record.default;
    if (typeof component !== "function") return false;
    if (wrappedComponents.has(component)) return true;
    const tracked = trackedErrorBlock(component as Component, react, tracker);
    wrappedComponents.add(tracked);
    record.default = tracked;
    return true;
  };
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const result = Reflect.apply(factory, this, args);
    // Haste hands exports in the last two arguments (module, exports) or returns them.
    for (const candidate of [result, ...args.slice(-2)]) {
      try {
        if (patch(candidate)) break;
        const exports = (candidate as { exports?: unknown } | null)?.exports;
        if (candidate && typeof candidate === "object" && patch(exports)) break;
      } catch {}
    }
    return result;
  };
  // Haste chooses the factory's calling convention by its declared arity.
  try {
    Object.defineProperty(wrapped, "length", { value: factory.length });
  } catch {}
  return wrapped;
}
