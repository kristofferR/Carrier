import { expect, test } from "bun:test";
import { patchNicknameContext } from "./nicknames";

function harness(initial = true) {
  let enabled = initial;
  const listeners = new Set<() => void>();
  const preference = {
    getSnapshot: () => enabled,
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
