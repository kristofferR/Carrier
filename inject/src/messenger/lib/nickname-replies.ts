import { type NicknameMode, type NicknamePreference, showNicknames } from "./nicknames";
import {
  type ConversationNotificationNames,
  type NotificationParticipant,
  participantFirstName,
  readConversationNotificationNames,
} from "./notification-names";

/** Reply attribution is saved text, separate from the quoted message body. */
export function replyAttribution(
  text: string,
  sender: string,
  recipient: string,
  info: ConversationNotificationNames,
  mode: NicknameMode,
) {
  if (showNicknames(mode, info.isGroup)) return text;
  const person = (id: string) => info.participants.find((p) => p.id === id);
  const name = (p: NotificationParticipant) => (info.isGroup ? participantFirstName(p) : p.name);
  const from = person(sender),
    to = person(recipient);
  let result = text;
  // Use message identities and attribution boundaries, never replace words in
  // the middle of a localized sentence or in the quoted message itself.
  if (from) {
    const alias = [from.nickname, from.name].find(
      (value) => value && result.startsWith(`${value} `),
    );
    if (alias) result = name(from) + result.slice(alias.length);
  }
  if (to) {
    const alias = [to.nickname, to.name].find((value) => value && result.endsWith(` ${value}`));
    if (alias) result = result.slice(0, -alias.length) + name(to);
  }
  return result;
}

interface ReplyReact {
  useSyncExternalStore(
    subscribe: NicknamePreference["subscribe"],
    snapshot: () => NicknameMode,
  ): NicknameMode;
  useState<T>(initial: T): [T, (value: T) => void];
  useEffect(effect: () => (() => void) | undefined, dependencies: unknown[]): void;
}
const wrapped = new WeakSet<object>();

export function patchNicknameReplies(
  value: unknown,
  importModule: (name: string) => unknown,
  preference: NicknamePreference,
  loadNames = (key: string) =>
    readConversationNotificationNames(
      key,
      (globalThis as unknown as { require?: unknown }).require,
    ),
) {
  if (!value || typeof value !== "object") return;
  const exports = value as Record<string, unknown>,
    original = exports.default;
  if (typeof original !== "function" || wrapped.has(original)) return;
  const react = importModule("react") as Partial<ReplyReact>;
  const i64 = importModule("I64") as { to_string?: unknown };
  if (
    typeof react?.useSyncExternalStore !== "function" ||
    typeof react.useState !== "function" ||
    typeof react.useEffect !== "function" ||
    typeof i64?.to_string !== "function"
  )
    return;
  const { useSyncExternalStore, useState, useEffect } = react,
    { to_string: stringify } = i64;
  // All mounted replies in a thread share one in-flight participant read.
  // Discard settled requests so later renders can pick up changed nicknames.
  const pending = new Map<string, Promise<ConversationNotificationNames | null>>();
  const readNames = (key: string) => {
    const existing = pending.get(key);
    if (existing) return existing;
    const request = loadNames(key);
    pending.set(key, request);
    void request.then(
      () => pending.delete(key),
      () => pending.delete(key),
    );
    return request;
  };
  const hook = function useCarrierReplyAttribution(this: unknown, ...args: unknown[]) {
    const text: unknown = Reflect.apply(original, this, args);
    const mode = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
    const [names, setNames] = useState<{
      key: string;
      info: ConversationNotificationNames | null;
    } | null>(null);
    const message = args[0];
    const id = (field: string) => {
      try {
        if (message && typeof message === "object" && field in message) {
          const value: unknown = stringify((message as Record<string, unknown>)[field]);
          if (typeof value === "string" && /^\d+$/.test(value)) return value;
        }
      } catch (_) {}
      return "";
    };
    const key = id("threadKey"),
      sender = id("senderId"),
      recipient = id("replyToUserId");
    useEffect(() => {
      if (!key || typeof text !== "string" || !text) return;
      let cancelled = false;
      readNames(key)
        .then((info) => {
          if (!cancelled) setNames({ key, info });
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [key, text, mode]);
    return typeof text === "string" && names?.key === key && names.info
      ? replyAttribution(text, sender, recipient, names.info, mode)
      : text;
  };
  try {
    exports.default = hook;
    wrapped.add(hook);
  } catch (_) {}
}
