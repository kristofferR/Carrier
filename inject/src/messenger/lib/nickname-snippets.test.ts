import { expect, test } from "bun:test";
import { conversationTextParts } from "./conversation-row";
import { NativeSnippetPrefixes, patchNicknameSnippets } from "./nickname-snippets";
import type { NicknameMode } from "./nicknames";
import { ConversationNotificationTracker, notificationDedupeKey } from "./notification-fallback";
import type { ConversationNotificationNames } from "./notification-names";

const info: ConversationNotificationNames = {
  title: "Weekend",
  isGroup: true,
  participants: [{ name: "Alex Example", firstName: "Alex", nickname: "Captain", avatar: "" }],
};

test("vaulted sidebar prefixes follow scope without mutating messages or saved data", async () => {
  let mode: NicknameMode = "off",
    state: unknown = null;
  let effect: () => (() => void) | undefined = () => undefined;
  const react = {
    createElement: (component: unknown, props: unknown) => ({ component, props }),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => NicknameMode) => snapshot(),
    useState: () => [
      state,
      (next: unknown) => {
        state = next;
      },
    ],
    useLayoutEffect: (commit: () => void) => commit(),
    useEffect: (next: typeof effect) => {
      effect = next;
    },
  };
  const modules: Record<string, unknown> = {
    react,
    I64: { to_string: (id: unknown) => id },
    ReStoreVaulting: {
      maybeUnvault: (raw: string) => (raw.startsWith("vault:") ? raw.slice(6) : null),
    },
  };
  const original = (props: unknown): unknown => props;
  const exports = { default: original };
  const prefixes = new NativeSnippetPrefixes();
  patchNicknameSnippets(
    exports,
    (name) => modules[name],
    { getSnapshot: () => mode, subscribe: () => () => {} },
    async () => info,
    prefixes,
  );
  const props = Object.freeze({
    snippetRaw: "vault:Captain: hello Captain 🙂",
    thread: { threadKey: "123" },
  });
  const render = (input: unknown = props) =>
    exports.default(input) as { component: unknown; props: { snippetRaw: string } };
  expect(render().props).toBe(props);
  effect();
  await Promise.resolve();
  expect(render().props.snippetRaw).toBe("Alex: hello Captain 🙂");
  expect(prefixes.original("123", "Alex: hello Captain 🙂")).toBe("Captain: hello Captain 🙂");
  mode = "direct";
  expect(render().props.snippetRaw).toBe("Alex: hello Captain 🙂");
  mode = "groups";
  expect(render().props).toBe(props);
  mode = "off";
  expect(render({ ...props, isDraftMessage: true }).props.snippetRaw).toBe(props.snippetRaw);
  expect(prefixes.original("123", "Alex: draft")).toBe("Alex: draft");
  expect(render({ ...props, snippetRaw: "New message" }).props.snippetRaw).toBe("New message");
  expect(props.snippetRaw).toBe("vault:Captain: hello Captain 🙂");
  // A late read from the previous conversation must not update a reused row.
  render();
  const cleanup = effect();
  state = null;
  cleanup?.();
  await Promise.resolve();
  expect(state).toBeNull();
});

test("sidebar settings preserve notification identity before preview truncation and emoji rendering", () => {
  const prefixes = new NativeSnippetPrefixes();
  const body = "hello 🙂 ".repeat(50);
  const tracker = new ConversationNotificationTracker();
  const candidate = (text: string, y: number) => ({
    text,
    y,
    x: 0,
    width: 200,
    height: 20,
    ariaHidden: false,
    inAbbreviation: false,
    hasTextChild: false,
  });
  const signature = (sender: string) => {
    const parts = conversationTextParts(
      [candidate("Weekend", 0), candidate(`${sender}: ${body}`, 20)],
      (body) => prefixes.original("123", body),
    );
    return { key: "123", signature: notificationDedupeKey(parts.title, parts.body) };
  };
  expect(tracker.observe([signature("Captain")])).toEqual([]);
  prefixes.remember("123", "Captain: ", "Alexander Example: ");
  expect(tracker.observe([signature("Alexander Example")])).toEqual([]);
  prefixes.remember("123", "Captain: ", "Captain: ");
  expect(tracker.observe([signature("Captain")])).toEqual([]);
  expect(prefixes.original("999", "Alex: unrelated")).toBe("Alex: unrelated");
});
