export type NicknameMode = "all" | "groups" | "off";

export function nicknameMode(settings?: {
  show_nicknames?: boolean;
  nicknames_group_only?: boolean;
}): NicknameMode {
  return settings?.show_nicknames === false
    ? "off"
    : settings?.nicknames_group_only
      ? "groups"
      : "all";
}

/** Unknown conversation types retain Messenger's presentation. */
export function showNicknames(mode: NicknameMode, isGroup?: boolean) {
  return mode === "all" || (mode === "groups" && isGroup !== false);
}

export interface NicknamePreference {
  subscribe(listener: () => void): () => void;
  getSnapshot(): NicknameMode;
}

interface MessengerReact {
  createContext?(value: boolean | undefined): { Provider: unknown };
  useContext?(context: unknown): boolean | undefined;
  createElement(component: unknown, props: unknown): unknown;
  useSyncExternalStore(
    subscribe: NicknamePreference["subscribe"],
    getSnapshot: () => NicknameMode,
  ): NicknameMode;
}

const threadContexts = new WeakMap<object, { Provider: unknown }>();
function threadContext(react: object, runtime: Partial<MessengerReact>) {
  let context = threadContexts.get(react);
  if (!context && runtime.createContext) {
    context = runtime.createContext(undefined);
    threadContexts.set(react, context);
  }
  return context;
}

/** The same provider surrounds both encrypted and unencrypted message lists. */
export function patchNicknameThreadContext(value: unknown, react: unknown, isGroup: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !react ||
    typeof react !== "object" ||
    typeof isGroup !== "function"
  )
    return;
  const exports = value as Record<string, unknown>;
  const runtime = react as Partial<MessengerReact>;
  const original = exports.Provider;
  if (typeof original !== "function" || wrappedProviders.has(original) || !runtime.createElement)
    return;
  const context = threadContext(react, runtime);
  if (!context) return;
  const { createElement } = runtime;
  const provider = (props: unknown) => {
    let group: boolean | undefined;
    try {
      if (
        props &&
        typeof props === "object" &&
        "thread" in props &&
        props.thread &&
        typeof props.thread === "object" &&
        "threadType" in props.thread
      ) {
        const result: unknown = isGroup(props.thread.threadType);
        if (typeof result === "boolean") group = result;
      }
    } catch (_) {}
    return createElement(context.Provider, {
      value: group,
      children: createElement(original, props),
    });
  };
  try {
    exports.Provider = provider;
    wrappedProviders.add(provider);
  } catch (_) {}
}

const wrappedProviders = new WeakSet<object>();

/** Change only presentation props; Messenger's saved nicknames stay intact. */
export function patchNicknameContext(
  value: unknown,
  react: unknown,
  preference: NicknamePreference,
) {
  if (!value || typeof value !== "object" || !react || typeof react !== "object") return;
  const exports = value as Record<string, unknown>;
  const runtime = react as Partial<MessengerReact>;
  const original = exports.MWPContactContextProvider;
  if (
    typeof original !== "function" ||
    wrappedProviders.has(original) ||
    typeof runtime.createElement !== "function" ||
    typeof runtime.useSyncExternalStore !== "function"
  )
    return;

  const { createElement, useSyncExternalStore, useContext } = runtime;
  const context = threadContext(react, runtime);
  const provider = function CarrierNicknameProvider(props: unknown) {
    const mode = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
    const group = context && useContext ? useContext(context) : undefined;
    const enabled = showNicknames(mode, group);
    if (!enabled && props && typeof props === "object") {
      const record = props as Record<string, unknown>;
      // Fail open if Facebook changes this component's props or lacks a real
      // contact name. Passing no nickname lets its own fallback choose the name.
      const contact = record.contact;
      if (
        typeof record.nickname === "string" &&
        contact &&
        typeof contact === "object" &&
        typeof (contact as Record<string, unknown>).name === "string"
      ) {
        return createElement(original, { ...record, nickname: undefined });
      }
    }
    return createElement(original, props);
  };
  try {
    exports.MWPContactContextProvider = provider;
    wrappedProviders.add(provider);
  } catch (_) {
    // Frozen or changed exports retain Messenger's normal rendering.
  }
}
