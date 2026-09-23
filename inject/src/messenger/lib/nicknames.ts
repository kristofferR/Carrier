export interface NicknamePreference {
  subscribe(listener: () => void): () => void;
  getSnapshot(): boolean;
}

interface MessengerReact {
  createElement(component: unknown, props: unknown): unknown;
  useSyncExternalStore(
    subscribe: NicknamePreference["subscribe"],
    getSnapshot: () => boolean,
  ): boolean;
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

  const { createElement, useSyncExternalStore } = runtime;
  const provider = function CarrierNicknameProvider(props: unknown) {
    const enabled = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
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
