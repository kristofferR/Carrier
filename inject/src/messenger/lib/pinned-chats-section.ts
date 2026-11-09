/*
 * The Pinned section above the chat list (Ref #457). Messenger's chat list
 * (MWThreadList.react) already renders an optional pinned section from the
 * `cr:34927` slot, and hides pinned chats from the list below it while that
 * slot is filled; facebook.com ships the slot empty. Chatpane fills it for this
 * one module, with Messenger's own chat rows for the chats in `PinnedChatsStore`,
 * and swaps the module's pinned-chat filter for one that hides those chats.
 *
 * Only the inbox's "All chats" list shows the section: filtered lists, the
 * archive and message requests keep every chat. A pinned chat Messenger has
 * not loaded yet shows a plain row with its remembered name until it loads.
 * Anything unexpected leaves the chat list exactly as Facebook ships it.
 */
import { defaultExport, pageRequire } from "./facebook-loader";
import { sameArity } from "./page-notifications";
import type { PinnedChat, PinnedChatsStore } from "./pinned-chats";

type Factory = (...args: unknown[]) => unknown;
type Define = (...args: unknown[]) => unknown;
type Load = (name: string) => unknown;
type Props = Record<string, unknown>;
type Component = (props: Props) => unknown;

export const THREAD_LIST_MODULE = "MWThreadList.react";
/** Messenger's pinned-section slot in the chat list; null on facebook.com. */
export const PINNED_SECTION_SLOT = "cr:34927";
const PINNED_UTILS_MODULE = "MWLSPinnedThreadUtils";
/** The main inbox list, as Messenger's left rail names it. */
const INBOX_ENTRY_POINT = "inboxThreadList";

export interface PinnedSectionHooks {
  /** The section's heading. */
  title(): string;
  /** A pinned chat's Messenger row rendered; its name can be refreshed. */
  onRow(id: string, row: Element): void;
  onError(error: unknown): void;
}

interface ReactContext {
  Provider: unknown;
}

interface ReactRuntime {
  createElement(type: unknown, props?: Props | null, ...children: unknown[]): unknown;
  createContext<T>(value: T): ReactContext;
  useContext<T>(context: ReactContext): T;
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T): T;
  useMemo<T>(create: () => T, deps: unknown[]): T;
  useEffect(effect: () => void, deps?: unknown[]): void;
  useRef<T>(value: T): { current: T };
  Suspense: unknown;
  Component: unknown;
}

interface I64 {
  of_string(value: string): unknown;
  to_string(value: unknown): unknown;
  equal(a: unknown, b: unknown): boolean;
}

interface ThreadQueries {
  fromTableAscending(table: unknown): { getKeyRange(key: unknown): unknown };
}

interface SuspenseQueries {
  useFirst(query: () => unknown, deps: unknown[], debugName: string): unknown;
}

interface RouterDispatcher {
  go(path: string, options: Props): unknown;
}

/** Whether a chat-list render is the inbox's unfiltered "All chats" list. */
export function isPinnedListView(props: unknown, idString: (value: unknown) => unknown): boolean {
  if (!props || typeof props !== "object") return false;
  const list = props as Props;
  if (list.lsEntryPoint !== INBOX_ENTRY_POINT || list.customThreadFilter != null) return false;
  if (list.filter == null) return true;
  try {
    return String(idString(list.filter)) === "0";
  } catch (_) {
    return false;
  }
}

function hasMethods<T>(value: unknown, names: string[]): value is T {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    names.every((name) => typeof (value as Props)[name] === "function")
  );
}

const keepEveryThread = () => true;

interface Parts {
  Section: Component;
  utils(original: unknown): unknown;
  wrapList(list: unknown): unknown;
}

function createParts(load: Load, store: PinnedChatsStore, hooks: PinnedSectionHooks): Parts | null {
  const react = load("react");
  const i64 = load("I64");
  const queries = load("ReQL");
  const suspense = load("ReQLSuspense");
  const useReStore = defaultExport(load("useReStore"));
  const ThreadListItem = defaultExport(load("MWThreadListItem.react"));
  const ThreadKeyProvider = (load("MWThreadKey.react") as Props | null)?.MWThreadKeyProvider;
  const DialogProvider = defaultExport(load("CometTransientDialogProvider.react"));
  if (
    !hasMethods<ReactRuntime>(react, [
      "createElement",
      "createContext",
      "useContext",
      "useSyncExternalStore",
      "useMemo",
      "useEffect",
      "useRef",
    ]) ||
    !react.Suspense ||
    typeof react.Component !== "function" ||
    !hasMethods<I64>(i64, ["of_string", "to_string", "equal"]) ||
    !hasMethods<ThreadQueries>(queries, ["fromTableAscending"]) ||
    !hasMethods<SuspenseQueries>(suspense, ["useFirst"]) ||
    typeof useReStore !== "function" ||
    !ThreadListItem ||
    !ThreadKeyProvider ||
    !DialogProvider
  )
    return null;

  const int64: I64 = i64;
  const threads: ThreadQueries = queries;
  const rows: SuspenseQueries = suspense;
  const h = react.createElement;
  const { Suspense, useContext, useEffect, useMemo, useRef, useSyncExternalStore } = react;
  const readStore = useReStore as () => { tables?: { threads?: unknown } } | null;
  // A row Messenger only partly synced lacks what its chat-list row shows.
  const authority = defaultExport(load("LSAuthorityLevel")) as Props | null;
  const intEnum = load("LSIntEnum");
  const partial = authority?.CLIENT_PARTIAL;
  const complete = (thread: Props) =>
    typeof partial !== "number" ||
    !hasMethods<{ toNumber(value: unknown): number }>(intEnum, ["toNumber"]) ||
    intEnum.toNumber(thread.authorityLevel) > partial;
  // The chat list doesn't import the router, so take it from the page if it can.
  let routerContext: ReactContext | null = null;
  try {
    routerContext = defaultExport(
      pageRequire()?.("CometRouterDispatcherContext"),
    ) as ReactContext | null;
  } catch (_) {}
  const router = routerContext?.Provider ? routerContext : react.createContext(null);
  const ListView = react.createContext(false);
  // Once the section fails, it stays away and the list below shows its
  // pinned chats again, until the page reloads.
  let failed = false;
  const failureListeners = new Set<() => void>();
  const subscribeFailure = (listener: () => void) => {
    failureListeners.add(listener);
    return () => failureListeners.delete(listener);
  };
  const hasFailed = () => failed;

  const Base = react.Component as new (props: Props) => { props: Props };
  class Boundary extends Base {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error: unknown) {
      hooks.onError(error);
      if (failed) return;
      failed = true;
      for (const listener of [...failureListeners]) listener();
    }
    render() {
      return this.state.failed ? null : (this.props.children ?? null);
    }
  }

  /** A pinned chat Messenger hasn't loaded: its remembered name, opened in-app. */
  function FallbackRow(props: Props) {
    const pin = props.pin as PinnedChat;
    const dispatcher = useContext<unknown>(router);
    const path = `/messages/t/${pin.id}/`;
    const initial = ([...pin.name][0] ?? "").toLocaleUpperCase();
    const open = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      if (!hasMethods<RouterDispatcher>(dispatcher, ["go"])) return;
      event.preventDefault();
      try {
        dispatcher.go(path, {});
      } catch (_) {
        location.assign(path);
      }
    };
    return h(
      "div",
      { role: "row", className: "chatpane-pinned-fallback", "data-chatpane-pinned-row": "" },
      h(
        "div",
        { role: "gridcell" },
        h(
          "a",
          { href: path, role: "link", "data-chatpane-pinned-chat": "", onClick: open },
          h(
            "svg",
            { viewBox: "0 0 40 40", "aria-hidden": "true" },
            h("circle", { cx: 20, cy: 20, r: 20 }),
            h("text", { x: 20, y: 20, textAnchor: "middle", dominantBaseline: "central" }, initial),
          ),
          h("span", null, pin.name),
        ),
      ),
    );
  }

  /** One pinned chat: Messenger's own row once its thread is loaded. */
  function PinnedRow(props: Props) {
    const pin = props.pin as PinnedChat;
    const list = props.list as Props;
    const db = readStore();
    const thread = rows.useFirst(
      () => threads.fromTableAscending(db?.tables?.threads).getKeyRange(int64.of_string(pin.id)),
      [db, pin.id],
      "ChatpanePinnedChats.row",
    ) as Props | null | undefined;
    const ref = useRef<Element | null>(null);
    useEffect(() => {
      if (ref.current) hooks.onRow(pin.id, ref.current);
    });
    if (!thread || !complete(thread)) return h(FallbackRow, { pin });
    // Archived and other folders' chats stay where Messenger lists them.
    if (!int64.equal(thread.parentThreadKey, list.parentThreadKey)) return null;
    const selected =
      list.selectedThreadKey != null && int64.equal(list.selectedThreadKey, thread.threadKey);
    return h(
      "div",
      { ref, "data-chatpane-pinned-row": "" },
      h(
        ThreadKeyProvider,
        { id: thread.threadKey },
        h(
          DialogProvider,
          null,
          h(ThreadListItem, {
            lsEntryPoint: list.lsEntryPoint,
            lsSubEntryPoint: list.lsSubEntryPoint,
            messagingEntrypoint: list.messagingEntrypoint,
            onClose: list.onClose,
            selected,
            showFollowUpReminder: false,
            size: 56,
            thread,
          }),
        ),
      ),
    );
  }

  function ChatpanePinnedChats(props: Props) {
    const shown = useContext<boolean>(ListView);
    const pins = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const broken = useSyncExternalStore(subscribeFailure, hasFailed);
    if (!shown || broken || pins.length === 0) return null;
    const title = hooks.title();
    return h(
      Boundary,
      null,
      h(
        "div",
        { className: "chatpane-pinned-chats", role: "rowgroup", "aria-label": title },
        h("div", { className: "chatpane-pinned-chats-title", "aria-hidden": "true" }, title),
        ...pins.map((pin) =>
          h(Suspense, { key: pin.id, fallback: null }, h(PinnedRow, { pin, list: props })),
        ),
      ),
    );
  }

  /** Messenger's pinned-chat filter, keeping every chat but Chatpane's pins. */
  function useChatpaneFilterPinnedThreads() {
    const shown = useContext<boolean>(ListView);
    const ids = useSyncExternalStore(store.subscribe, store.getIds);
    const broken = useSyncExternalStore(subscribeFailure, hasFailed);
    return useMemo(
      () =>
        shown && !broken && ids.size
          ? (thread: unknown) => {
              const key = (thread as Props | null)?.threadKey;
              return key == null || !ids.has(String(int64.to_string(key)));
            }
          : keepEveryThread,
      [shown, broken, ids],
    );
  }

  const utils = new WeakMap<object, unknown>();
  return {
    Section: ChatpanePinnedChats,
    utils(original) {
      if (!original || typeof original !== "object") return original;
      let patched = utils.get(original);
      if (!patched) {
        patched = { ...original, useFilterPinnedThreads: useChatpaneFilterPinnedThreads };
        utils.set(original, patched);
      }
      return patched;
    },
    wrapList(list) {
      return function ChatpaneThreadList(props: Props) {
        return h(
          ListView.Provider,
          { value: isPinnedListView(props, (value) => int64.to_string(value)) },
          h(list, props),
        );
      };
    },
  };
}

/** The module's exports object with a default component, wherever Haste put it. */
function listExports(result: unknown, args: unknown[]): Props | null {
  for (const candidate of [result, ...args.slice(-2)]) {
    for (const value of [candidate, (candidate as Props | null)?.exports]) {
      if (value && typeof value === "object" && typeof (value as Props).default === "function")
        return value as Props;
    }
  }
  return null;
}

/**
 * Wrap MWThreadList.react's factory: its `cr:34927` slot gets the Pinned
 * section, its pinned-chat filter Chatpane's pins, and its component the
 * context that says whether this list shows them.
 */
export function wrapThreadListFactory(
  factory: Factory,
  store: PinnedChatsStore,
  hooks: PinnedSectionHooks,
): Factory {
  return sameArity(function (this: unknown, ...args: unknown[]) {
    // Haste's factory ABI: (global, require, requireDefault, importNamespace, …).
    const require = args[1];
    const load = args[3];
    if (typeof require !== "function" || typeof load !== "function")
      return Reflect.apply(factory, this, args);
    // Built before the factory runs, so the slot and filter are swapped
    // together even if Messenger reads either while the module loads. They
    // stay inert until the list component below is wrapped.
    let parts: Parts | null = null;
    try {
      parts = createParts(load as Load, store, hooks);
    } catch (error) {
      hooks.onError(error);
    }
    args[1] = sameArity(function (this: unknown, ...names: unknown[]) {
      if (parts && names[0] === PINNED_SECTION_SLOT) return parts.Section;
      return Reflect.apply(require, this, names);
    }, require as Factory);
    args[3] = sameArity(function (this: unknown, ...names: unknown[]) {
      const value: unknown = Reflect.apply(load, this, names);
      return parts && names[0] === PINNED_UTILS_MODULE ? parts.utils(value) : value;
    }, load as Factory);
    const result = Reflect.apply(factory, this, args);
    try {
      const exports = parts && listExports(result, args);
      if (parts && exports) exports.default = parts.wrapList(exports.default);
    } catch (error) {
      hooks.onError(error);
    }
    return result;
  }, factory);
}

/** Wrap Facebook's module registration for the chat list. */
export function interceptThreadListModule(
  define: Define,
  store: PinnedChatsStore,
  hooks: PinnedSectionHooks,
): Define {
  return new Proxy(define, {
    apply(target, thisArg, args: unknown[]) {
      if (args[0] === THREAD_LIST_MODULE && typeof args[2] === "function") {
        args[2] = wrapThreadListFactory(args[2] as Factory, store, hooks);
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}
