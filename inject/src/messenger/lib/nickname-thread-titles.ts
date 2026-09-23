import { type NicknameMode, type NicknamePreference, showNicknames } from "./nicknames";

/** Keep notification matching independent of Carrier's displayed thread title. */
export class NativeThreadTitles {
  private readonly titles = new Map<string, { original: string; displayed: string }>();

  remember(thread: string, original: string, displayed: string) {
    if (!/^\d+$/.test(thread)) return;
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 80);
    this.titles.delete(thread);
    this.titles.set(thread, { original: normalize(original), displayed: normalize(displayed) });
    if (this.titles.size > 500) this.titles.delete(this.titles.keys().next().value!);
  }

  displayed(thread: string, original: string, fallback = original) {
    const entry = this.titles.get(thread);
    return entry?.original === original ? entry.displayed : fallback;
  }

  original(thread: string, displayed: string) {
    const entry = this.titles.get(thread);
    return entry?.displayed === displayed ? entry.original : displayed;
  }
}

export const nativeThreadTitles = new NativeThreadTitles();

interface TitleReact {
  useSyncExternalStore(
    subscribe: NicknamePreference["subscribe"],
    snapshot: () => NicknameMode,
  ): NicknameMode;
  useMemo<T>(compute: () => T, dependencies: unknown[]): T;
}

const wrappedHooks = new WeakSet<object>();

/** Wrap the title hook, so both the chat header and sidebar react to settings. */
export function patchNicknameThreadTitles(
  value: unknown,
  importModule: (name: string) => unknown,
  preference: NicknamePreference,
  titles = nativeThreadTitles,
) {
  if (!value || typeof value !== "object") return;
  const exports = value as Record<string, unknown>;
  const original = exports.default;
  if (typeof original !== "function" || wrappedHooks.has(original)) return;
  const react = importModule("react") as Partial<TitleReact>;
  const compute = importModule("MWPGetThreadTitle") as { computeThreadTitle?: unknown };
  const i64 = importModule("I64") as { to_string?: unknown };
  const listModule = importModule("intlList") as {
    default?: unknown;
    CONJUNCTIONS?: { NONE?: unknown };
  };
  const intlList = (listModule?.default ?? listModule) as { CONJUNCTIONS?: { NONE?: unknown } };
  const types = importModule("LSMessagingThreadTypeUtil") as { isGroup?: unknown };
  const computeTitle = compute?.computeThreadTitle;
  const threadKey = i64?.to_string;
  if (
    typeof react?.useSyncExternalStore !== "function" ||
    typeof react.useMemo !== "function" ||
    typeof computeTitle !== "function" ||
    typeof threadKey !== "function"
  )
    return;
  const { useSyncExternalStore, useMemo } = react;
  const wrapped = new Proxy(original, {
    apply(target, receiver, args: unknown[]) {
      const mode = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
      const result: unknown = Reflect.apply(target, receiver, args);
      return useMemo(() => {
        if (!result || typeof result !== "object") return result;
        const record = result as Record<string, unknown>;
        const thread = args[0];
        if (
          !thread ||
          typeof thread !== "object" ||
          !("threadKey" in thread) ||
          !("threadType" in thread) ||
          typeof record.threadTitle !== "string" ||
          !Array.isArray(record.participantsAndContacts)
        )
          return result;
        try {
          let displayed = record.threadTitle;
          const group =
            typeof types?.isGroup === "function"
              ? types.isGroup(thread.threadType) === true
              : undefined;
          if (!showNicknames(mode, group)) {
            // Clone presentation inputs only. Never clear the database nickname
            // or mutate the subscribed rows Messenger shares with other views.
            const pairs = record.participantsAndContacts.map((pair: unknown) => {
              if (!Array.isArray(pair)) return pair;
              const [participant, contact]: unknown[] = pair;
              if (
                !participant ||
                typeof participant !== "object" ||
                !contact ||
                typeof contact !== "object" ||
                !("name" in contact) ||
                typeof contact.name !== "string"
              )
                return pair;
              return [{ ...participant, nickname: undefined }, contact];
            });
            const computed: unknown = computeTitle(
              intlList.CONJUNCTIONS?.NONE,
              thread.threadType,
              pairs,
              record.actorId,
            );
            if (typeof computed === "string") displayed = computed;
          }
          const key: unknown = threadKey(thread.threadKey);
          if (typeof key === "string") titles.remember(key, record.threadTitle, displayed);
          return displayed === record.threadTitle ? result : { ...record, threadTitle: displayed };
        } catch (_) {
          return result;
        }
      }, [result, args[0], mode]);
    },
  });
  try {
    exports.default = wrapped;
    wrappedHooks.add(wrapped);
  } catch (_) {}
}
