import { expect, test } from "bun:test";
import {
  type NicknameMode,
  nicknameMode,
  patchNicknameContext,
  patchNicknameThreadContext,
  showNicknames,
} from "./nicknames";

function harness(initial = true) {
  let enabled = initial;
  const listeners = new Set<() => void>();
  const preference = {
    getSnapshot: () => nicknameMode({ show_nicknames: enabled }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const react = {
    createElement: (component: unknown, props: unknown) => ({ component, props }),
    useSyncExternalStore: (
      subscribe: typeof preference.subscribe,
      snapshot: typeof preference.getSnapshot,
    ) => {
      expect(subscribe).toBe(preference.subscribe);
      return snapshot();
    },
  };
  const original = (props: unknown): unknown => props;
  const exports = { MWPContactContextProvider: original };
  patchNicknameContext(exports, react, preference);
  return {
    original,
    exports,
    react,
    preference,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    render: (props: unknown) =>
      exports.MWPContactContextProvider(props) as {
        component: unknown;
        props: unknown;
      },
  };
}

test("switches message authors without changing saved participant data or children", () => {
  const h = harness();
  const contact = Object.freeze({ name: "Alex Example", firstName: "Alex" });
  const props = Object.freeze({ contact, nickname: "Captain", children: {} });
  expect(h.render(props)).toEqual({ component: h.original, props });
  h.setEnabled(false);
  expect(h.render(props)).toEqual({
    component: h.original,
    props: { contact, nickname: undefined, children: props.children },
  });
  expect(props.nickname).toBe("Captain");
  h.setEnabled(true);
  expect(h.render(props).props).toBe(props);
  // Each provider receives that chat's nickname, even for the same contact.
  const otherChat = { ...props, nickname: "Skipper" };
  expect(h.render(otherChat).props).toBe(otherChat);
});

test("preserves Messenger's fallback for missing names and unknown props", () => {
  const h = harness(false);
  for (const props of [null, {}, { nickname: "Captain" }, { contact: { name: "Alex" } }]) {
    expect(h.render(props).props).toBe(props);
  }
});

test("patches a provider once and leaves changed or frozen exports alone", () => {
  const h = harness();
  const provider = h.exports.MWPContactContextProvider;
  patchNicknameContext(h.exports, h.react, h.preference);
  expect(h.exports.MWPContactContextProvider).toBe(provider);
  const frozen = Object.freeze({ MWPContactContextProvider: h.original });
  expect(() => patchNicknameContext(frozen, h.react, h.preference)).not.toThrow();
  const changed = { MWPContactContextProvider: h.original };
  patchNicknameContext(changed, {}, h.preference);
  expect(changed.MWPContactContextProvider).toBe(h.original);
});

test("nickname scope covers all parent and child setting combinations", () => {
  expect(nicknameMode()).toBe("all");
  for (const enabled of [false, true]) {
    for (const groupOnly of [false, true]) {
      const mode = nicknameMode({ show_nicknames: enabled, nicknames_group_only: groupOnly });
      expect(showNicknames(mode, true)).toBe(enabled);
      expect(showNicknames(mode, false)).toBe(enabled && !groupOnly);
    }
  }
  expect(showNicknames("groups", undefined)).toBe(true);
});

test("message authors inherit their own message list's scope and react to preference changes", () => {
  let mode: NicknameMode = "groups";
  let current: boolean | undefined;
  const react = {
    createContext: () => ({ Provider: "context" }),
    useContext: () => current,
    createElement: (component: unknown, props: unknown) => ({ component, props }),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => NicknameMode) => snapshot(),
  };
  const lists = { Provider: (props: unknown): unknown => props };
  patchNicknameThreadContext(lists, react, (type: unknown) => type === "group");
  const authors = { MWPContactContextProvider: (props: unknown): unknown => props };
  patchNicknameContext(authors, react, { getSnapshot: () => mode, subscribe: () => () => {} });
  const props = { nickname: "Captain", contact: { name: "Alex" }, children: {} };
  const render = (type: string) => {
    const list = lists.Provider({ thread: { threadType: type }, children: {} }) as {
      props: { value: boolean };
    };
    current = list.props.value;
    return authors.MWPContactContextProvider(props) as { props: { nickname?: string } };
  };
  expect(render("group").props.nickname).toBe("Captain");
  expect(render("direct").props.nickname).toBeUndefined();
  mode = "all";
  expect(render("direct").props.nickname).toBe("Captain");
  mode = "off";
  expect(render("group").props.nickname).toBeUndefined();
});
