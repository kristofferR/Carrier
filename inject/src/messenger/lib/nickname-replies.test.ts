import { expect, test } from "bun:test";
import { patchNicknameReplies, replyAttribution } from "./nickname-replies";
import type { NicknameMode } from "./nicknames";
import type { ConversationNotificationNames } from "./notification-names";

const info: ConversationNotificationNames = {
  title: "Weekend",
  isGroup: true,
  participants: [
    { id: "1", name: "Ola Example", firstName: "", nickname: "Captain", avatar: "" },
    { id: "2", name: "Alex Example", firstName: "Alex", nickname: "Skipper", avatar: "" },
  ],
};
test("reply attribution uses message identities and the independent scope", () => {
  for (const mode of ["off", "direct"] as const) {
    expect(replyAttribution("Captain replied to Skipper", "1", "2", info, mode)).toBe(
      "Ola replied to Alex",
    );
  }
  for (const mode of ["all", "groups"] as const) {
    expect(replyAttribution("Captain replied to Skipper", "1", "2", info, mode)).toBe(
      "Captain replied to Skipper",
    );
  }
  expect(
    replyAttribution("Captain replied to Skipper", "1", "2", { ...info, isGroup: false }, "groups"),
  ).toBe("Ola Example replied to Alex Example");
  expect(
    replyAttribution("Captain replied to Skipper", "1", "2", { ...info, isGroup: false }, "direct"),
  ).toBe("Captain replied to Skipper");
  expect(replyAttribution("Captain replied to Skipper", "3", "4", info, "off")).toBe(
    "Captain replied to Skipper",
  );
  expect(replyAttribution("You replied to Captain", "2", "1", info, "off")).toBe(
    "You replied to Ola",
  );
  expect(replyAttribution("Captain America replied to Skipperton", "2", "1", info, "off")).toBe(
    "Captain America replied to Skipperton",
  );
  expect(replyAttribution("Pinned Captain's reply", "1", "2", info, "off")).toBe(
    "Pinned Captain's reply",
  );
});

test("reply hook preserves the original hook, message, quoted text, and async lifecycle", async () => {
  let mode: NicknameMode = "off",
    state: unknown = null;
  let effect: () => (() => void) | undefined = () => undefined;
  const modules: Record<string, unknown> = {
    react: {
      useSyncExternalStore: (_subscribe: unknown, snapshot: () => NicknameMode) => snapshot(),
      useState: () => [
        state,
        (next: unknown) => {
          state = next;
        },
      ],
      useEffect: (next: typeof effect) => {
        effect = next;
      },
    },
    I64: { to_string: (id: unknown) => id },
  };
  const message = Object.freeze({
    threadKey: "123",
    senderId: "1",
    replyToUserId: "2",
    replySnippet: "Captain replied to Skipper",
    replyMessageText: "Captain's message",
  });
  let calls = 0;
  const original = (value: unknown, outgoing: unknown): string => {
    calls++;
    expect(value).toBe(message);
    expect(outgoing).toBe(false);
    return message.replySnippet;
  };
  const exports = { default: original };
  patchNicknameReplies(
    exports,
    (name) => modules[name],
    { getSnapshot: () => mode, subscribe: () => () => {} },
    async () => info,
  );
  expect(exports.default(message, false)).toBe(message.replySnippet);
  effect();
  await Promise.resolve();
  expect(exports.default(message, false)).toBe("Ola replied to Alex");
  mode = "groups";
  expect(exports.default(message, false)).toBe(message.replySnippet);
  expect(message.replyMessageText).toBe("Captain's message");
  expect(calls).toBe(3);
  const cleanup = effect();
  state = null;
  cleanup?.();
  await Promise.resolve();
  expect(state).toBeNull();
});

test("mounted replies share an in-flight read but later renders fetch fresh names", async () => {
  let reads = 0;
  const effects: Array<() => unknown> = [];
  const modules: Record<string, unknown> = {
    react: {
      useSyncExternalStore: (_subscribe: unknown, snapshot: () => NicknameMode) => snapshot(),
      useState: () => [null, () => {}],
      useEffect: (effect: () => unknown) => effects.push(effect),
    },
    I64: { to_string: (id: unknown) => id },
  };
  const exports = { default: (_message: unknown) => "Captain replied to Skipper" };
  patchNicknameReplies(
    exports,
    (name) => modules[name],
    { getSnapshot: () => "off", subscribe: () => () => {} },
    async () => {
      reads++;
      return info;
    },
  );
  const message = { threadKey: "123", senderId: "1", replyToUserId: "2" };
  exports.default(message);
  exports.default(message);
  for (const effect of effects) effect();
  expect(reads).toBe(1);
  await Promise.resolve();
  effects[0]!();
  expect(reads).toBe(2);
});
