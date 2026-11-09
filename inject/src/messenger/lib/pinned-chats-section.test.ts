import { describe, expect, test } from "bun:test";
import { createPinnedChatsStore } from "./pinned-chats";
import {
  isPinnedListView,
  PINNED_SECTION_SLOT,
  wrapThreadListFactory,
} from "./pinned-chats-section";

type Props = Record<string, unknown>;
interface Element {
  type: unknown;
  props: Props;
}
interface Context {
  Provider: object;
  value: unknown;
}

/** Just enough of React for one render pass: hooks read their current value. */
function fakeReact() {
  const contexts: Context[] = [];
  return {
    contexts,
    createElement: (type: unknown, props: Props | null, ...children: unknown[]): Element => ({
      type,
      props: { ...props, children },
    }),
    createContext(value: unknown) {
      const context = { Provider: {}, value };
      contexts.push(context);
      return context;
    },
    useContext: (context: Context) => context.value,
    useSyncExternalStore: (_: unknown, snapshot: () => unknown) => snapshot(),
    useMemo: (create: () => unknown) => create(),
    useEffect() {},
    useRef: (current: unknown) => ({ current }),
    Suspense: "Suspense",
    Component: class {
      constructor(public props: Props) {}
    },
  };
}

const ThreadListItem = () => null;

/** A stand-in for MWThreadList.react's factory, keeping what it was handed. */
function loadThreadList(react: object | null) {
  const store = createPinnedChatsStore();
  const errors: unknown[] = [];
  const modules: Record<string, unknown> = {
    react,
    I64: {
      of_string: (value: string) => value,
      to_string: (value: unknown) => String(value),
      equal: (a: unknown, b: unknown) => String(a) === String(b),
    },
    ReQL: { fromTableAscending: () => ({ getKeyRange: () => null }) },
    ReQLSuspense: { useFirst: () => null },
    useReStore: { default: () => ({ tables: {} }) },
    "MWThreadListItem.react": { default: ThreadListItem },
    "MWThreadKey.react": { MWThreadKeyProvider: () => null },
    "CometTransientDialogProvider.react": { default: () => null },
    MWLSPinnedThreadUtils: { useFilterPinnedThreads: () => () => "facebook" },
  };
  const List = () => null;
  let require: (name: string) => unknown = () => undefined;
  let load: (name: string) => unknown = () => undefined;
  const exports: Props = {};
  const factory = (
    _global: unknown,
    req: (name: string) => unknown,
    _requireDefault: unknown,
    importNamespace: (name: string) => unknown,
    _lazy: unknown,
    _module: unknown,
    moduleExports: Props,
  ) => {
    require = req;
    load = importNamespace;
    moduleExports.default = List;
  };
  const wrapped = wrapThreadListFactory(factory as (...args: unknown[]) => unknown, store, {
    title: () => "Pinned",
    onRow() {},
    onError: (error) => errors.push(error),
  });
  wrapped(
    {},
    (name: string) => (name === PINNED_SECTION_SLOT ? null : `required ${name}`),
    () => undefined,
    (name: string) => modules[name],
    () => undefined,
    {},
    exports,
  );
  return { store, errors, List, exports, require, load };
}

describe("pinned chats section", () => {
  test("shows only in the inbox's unfiltered list", () => {
    const idString = (value: unknown) => String(value);
    expect(isPinnedListView({ lsEntryPoint: "inboxThreadList" }, idString)).toBe(true);
    expect(isPinnedListView({ lsEntryPoint: "inboxThreadList", filter: 0 }, idString)).toBe(true);
    expect(isPinnedListView({ lsEntryPoint: "inboxThreadList", filter: 1 }, idString)).toBe(false);
    expect(
      isPinnedListView(
        { lsEntryPoint: "inboxThreadList", customThreadFilter: () => true },
        idString,
      ),
    ).toBe(false);
    expect(isPinnedListView({ lsEntryPoint: "jewelNestedFolder" }, idString)).toBe(false);
    expect(isPinnedListView(null, idString)).toBe(false);
  });

  test("fills the chat list's pinned slot and hides pinned chats below it", () => {
    const react = fakeReact();
    const { store, errors, List, exports, require, load } = loadThreadList(react);
    expect(require("other")).toBe("required other");
    const Section = require(PINNED_SECTION_SLOT) as (props: Props) => Element | null;
    expect(typeof Section).toBe("function");

    // The wrapped list tells its section and filter whether it shows pins.
    const rendered = (exports.default as (props: Props) => Element)({
      lsEntryPoint: "inboxThreadList",
    });
    const view = react.contexts.find((context) => context.Provider === rendered.type);
    expect(view?.value).toBe(false);
    expect((rendered.props.children as Element[])[0]?.type).toBe(List);

    const filter = () =>
      (
        load("MWLSPinnedThreadUtils") as { useFilterPinnedThreads(): (thread: Props) => boolean }
      ).useFilterPinnedThreads();
    store.replace([{ id: "12", name: "Ada" }]);
    expect(Section({})).toBeNull();
    expect(filter()({ threadKey: "12" })).toBe(true);

    if (view) view.value = rendered.props.value;
    const section = Section({ parentThreadKey: "0" }) as Element;
    const group = (section.props.children as Element[])[0];
    expect(group?.props.className).toBe("chatpane-pinned-chats");
    expect(group?.props["aria-label"]).toBe("Pinned");
    expect(filter()({ threadKey: "12" })).toBe(false);
    expect(filter()({ threadKey: "34" })).toBe(true);

    store.replace([]);
    expect(Section({})).toBeNull();
    expect(errors).toEqual([]);
  });

  test("a failed section gives its pinned chats back to the list", () => {
    const react = fakeReact();
    const { store, errors, exports, require, load } = loadThreadList(react);
    const Section = require(PINNED_SECTION_SLOT) as (props: Props) => Element;
    const rendered = (exports.default as (props: Props) => Element)({
      lsEntryPoint: "inboxThreadList",
    });
    const view = react.contexts.find((context) => context.Provider === rendered.type);
    if (view) view.value = true;
    store.replace([{ id: "12", name: "Ada" }]);
    const filter = () =>
      (
        load("MWLSPinnedThreadUtils") as { useFilterPinnedThreads(): (thread: Props) => boolean }
      ).useFilterPinnedThreads();
    expect(filter()({ threadKey: "12" })).toBe(false);

    // React hands a row's error to the section's boundary.
    const Boundary = Section({}).type as new (
      props: Props,
    ) => { componentDidCatch(error: unknown): void };
    new Boundary({}).componentDidCatch(new Error("row failed"));
    expect(errors).toHaveLength(1);
    expect(filter()({ threadKey: "12" })).toBe(true);
    // A remounted section must not show them twice.
    expect(Section({})).toBeNull();
  });

  test("leaves the chat list as Facebook ships it when React is not as expected", () => {
    const { List, exports, require, load } = loadThreadList(null);
    expect(require(PINNED_SECTION_SLOT)).toBeNull();
    expect(
      (
        load("MWLSPinnedThreadUtils") as { useFilterPinnedThreads(): () => string }
      ).useFilterPinnedThreads()(),
    ).toBe("facebook");
    expect(exports.default).toBe(List);
  });
});
