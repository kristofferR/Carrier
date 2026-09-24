import { type NicknameMode, type NicknamePreference, showNicknames } from "./nicknames";
import {
  type ConversationNotificationNames,
  notificationSenderPrefix,
  participantFirstName,
  readConversationNotificationNames,
} from "./notification-names";

/** Undo only the sender prefix that Carrier rendered, before notification truncation. */
export class NativeSnippetPrefixes {
  private readonly entries = new Map<string, { original: string; displayed: string }>();
  private readonly drafts = new Map<string, Map<object, string>>();

  rememberDraft(thread: string, owner: object, snippet: string, draft: boolean) {
    if (!/^\d+$/.test(thread)) return;
    if (!draft) return this.forgetDraft(thread, owner);
    const entries = this.drafts.get(thread) ?? new Map<object, string>();
    entries.set(owner, snippet.replace(/\s+/g, " ").trim());
    this.drafts.set(thread, entries);
  }

  forgetDraft(thread: string, owner: object) {
    const entries = this.drafts.get(thread);
    entries?.delete(owner);
    if (entries?.size === 0) this.drafts.delete(thread);
  }

  isDraft(thread: string, body: string) {
    const preview = body.replace(/\s+/g, " ").trim();
    return [...(this.drafts.get(thread)?.values() ?? [])].some((snippet) => {
      if (snippet.slice(0, 240) === preview) return true;
      // A generic colon prefix can also be a group sender ("Alice: hello").
      // Match only known draft labels when Messenger renders one separately.
      const label = /^(?:Draft|Utkast): /iu.exec(preview)?.[0];
      return label !== undefined && `${label}${snippet}`.slice(0, 240) === preview;
    });
  }

  remember(thread: string, original: string, displayed: string) {
    this.entries.delete(thread);
    if (!/^\d+$/.test(thread) || original === displayed) return;
    const normalize = (text: string) => text.replace(/\s+/g, " ");
    this.entries.set(thread, { original: normalize(original), displayed: normalize(displayed) });
    if (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value!);
  }

  original(thread: string, text: string) {
    const entry = this.entries.get(thread);
    return entry && text.startsWith(entry.displayed)
      ? entry.original + text.slice(entry.displayed.length)
      : text;
  }
}

export const nativeSnippetPrefixes = new NativeSnippetPrefixes();

interface SnippetReact {
  createElement(component: unknown, props: unknown): unknown;
  useSyncExternalStore(
    subscribe: NicknamePreference["subscribe"],
    snapshot: () => NicknameMode,
  ): NicknameMode;
  useState<T>(initial: T): [T, (value: T) => void];
  useRef<T>(initial: T): { current: T };
  useLayoutEffect(effect: () => undefined | (() => void), dependencies: unknown[]): void;
  useEffect(effect: () => (() => void) | undefined, dependencies: unknown[]): void;
}
type Names = { key: string; snippet: string; info: ConversationNotificationNames | null };
const wrapped = new WeakSet<object>();

/** Saved snippets already contain nicknames, outside Messenger's contact provider. */
export function patchNicknameSnippets(
  value: unknown,
  importModule: (name: string) => unknown,
  preference: NicknamePreference,
  loadNames = (key: string) =>
    readConversationNotificationNames(
      key,
      (globalThis as unknown as { require?: unknown }).require,
    ),
  prefixes = nativeSnippetPrefixes,
) {
  if (!value || typeof value !== "object") return;
  const exports = value as Record<string, unknown>;
  const original = exports.default;
  if (typeof original !== "function" || wrapped.has(original)) return;
  const react = importModule("react") as Partial<SnippetReact>;
  const i64 = importModule("I64") as { to_string?: unknown };
  const vault = importModule("ReStoreVaulting") as { maybeUnvault?: unknown };
  if (
    typeof react?.createElement !== "function" ||
    typeof react.useSyncExternalStore !== "function" ||
    typeof react.useState !== "function" ||
    typeof react.useRef !== "function" ||
    typeof react.useEffect !== "function" ||
    typeof react.useLayoutEffect !== "function" ||
    typeof i64?.to_string !== "function" ||
    typeof vault?.maybeUnvault !== "function"
  )
    return;
  const { createElement, useSyncExternalStore, useState, useRef, useEffect, useLayoutEffect } =
    react;
  const { to_string: threadKey } = i64;
  const { maybeUnvault } = vault;
  const component = function CarrierNicknameSnippet(props: unknown) {
    const mode = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
    const [names, setNames] = useState<Names | null>(null);
    const owner = useRef({}).current;
    const record = props && typeof props === "object" ? (props as Record<string, unknown>) : {};
    const thread = record.thread;
    let key = "",
      snippet = "";
    try {
      if (thread && typeof thread === "object" && "threadKey" in thread) {
        const id: unknown = threadKey(thread.threadKey);
        if (typeof id === "string") key = id;
      }
      const raw: unknown =
        typeof record.snippetRaw === "string"
          ? (maybeUnvault(record.snippetRaw) ?? record.snippetRaw)
          : null;
      if (typeof raw === "string") snippet = raw;
    } catch (_) {}
    const draft = record.isDraftMessage === true;
    useEffect(() => {
      if (!key || !snippet.includes(": ") || draft || showNicknames(mode, true)) return;
      let cancelled = false;
      loadNames(key)
        .then((info) => {
          if (!cancelled) setNames({ key, snippet, info });
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [key, snippet, draft, mode]);
    const info = !draft && names?.key === key && names.snippet === snippet ? names.info : null;
    const sender = info ? notificationSenderPrefix(snippet, info) : undefined;
    let displayed = snippet;
    if (sender && info?.isGroup) {
      const name =
        (showNicknames(mode, info.isGroup) && sender.person.nickname) ||
        participantFirstName(sender.person);
      displayed = `${name}: ${snippet.slice(sender.end)}`;
    }
    const tail = sender ? snippet.slice(sender.end) : snippet;
    const originalPrefix = sender ? snippet.slice(0, sender.end) : "";
    const displayedPrefix = displayed.slice(0, displayed.length - tail.length);
    // Match committed DOM only; an abandoned concurrent render must not change
    // the identity used by the notification observer.
    useLayoutEffect(() => {
      prefixes.remember(key, originalPrefix, displayedPrefix);
    }, [key, originalPrefix, displayedPrefix]);
    useLayoutEffect(() => {
      prefixes.rememberDraft(key, owner, snippet, draft);
      return () => prefixes.forgetDraft(key, owner);
    }, [key, owner, snippet, draft]);
    return createElement(
      original,
      displayed !== snippet ? { ...record, snippetRaw: displayed } : props,
    );
  };
  try {
    exports.default = component;
    wrapped.add(component);
  } catch (_) {}
}
