export type FacebookModuleDefine = (this: unknown, ...args: unknown[]) => unknown;

type FacebookModuleFactory = (this: unknown, ...args: unknown[]) => unknown;

export interface FacebookFTSRestoreSync {
  setKeepWhileLoop_FOR_TESTING_ONLY(keepRunning: boolean): void;
  setIsStarted(started: boolean): void;
  startSyncingLoop(): unknown;
}

export interface FacebookSearchInputDescriptor {
  hasAccessibleName: boolean;
  insideForm: boolean;
  insideMain: boolean;
  role: string | null;
  type: string;
}

export function isConversationSearchInput({
  hasAccessibleName,
  insideForm,
  insideMain,
  role,
  type,
}: FacebookSearchInputDescriptor): boolean {
  if (!insideMain || insideForm) return false;
  return (
    type === "search" ||
    role === "searchbox" ||
    (type === "text" && role === null && hasAccessibleName)
  );
}

const NULL_COMPONENT_MODULES = new Set([
  // Carrier's CSS already hides this entire Facebook-wide header tree. Removing
  // the React root prevents its search, notification, account, and portal work.
  "CometBaseAppNavigation.react",
  // Messenger's server-driven promotion banner is not part of messaging.
  "MWInboxQuickPromotionWrapper.react",
  "MWInboxQuickPromotionWrapperImportUnconditionally.react",
  "MAWSecureThreadQuickPromotion.react",
  "MWThreadListQP.react",
  "MWMessageSearchEBRestoreUpsell.react",
  // Carrier owns desktop notification delivery; Facebook's browser-push root
  // is redundant inside the native WebView.
  "CometBrowserPushRoot.react",
  // Casting is Facebook-wide video chrome, not Messenger media playback.
  "CometCastingMiniplayerRoot.react",
]);

const TELEMETRY_MODULES = new Set([
  "Banzai",
  "FalcoLoggerInternal",
  "ODS",
  "TimeSpentImmediateActiveSecondsLogger",
  "TimeSpentImmediateActiveSecondsLoggerComet",
]);
const BACKGROUND_SERVICE_MODULES = new Set(["MAWFTSRestoreSync"]);
const ODS_METHODS = ["bumpEntityKey", "bumpFraction", "flush", "setEntitySample"] as const;
const FALCO_METHODS = ["log", "logAsync", "logCritical", "logImmediately"] as const;
const wrappedTelemetryMethods = new WeakSet<object>();
const wrappedFalcoFactories = new WeakSet<object>();

function nullComponent() {
  return null;
}

Object.defineProperty(nullComponent, "displayName", {
  value: "CarrierNullFacebookComponent",
});

type ComponentReplacement = typeof nullComponent;

function replaceFunctionExport(value: unknown, replacement: ComponentReplacement): unknown {
  if (typeof value === "function") return replacement;
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (typeof record.default === "function") {
    try {
      record.default = replacement;
    } catch (_) {}
  }
  return value;
}

function replaceComponentExports(
  result: unknown,
  factoryArgs: unknown[],
  replacement: ComponentReplacement,
): unknown {
  // Facebook's Haste factory ABI exposes module and exports in the final two
  // positions. Do not inspect dependency arguments: some are objects with
  // unrelated default exports that must remain untouched.
  const firstExportIndex = Math.max(0, factoryArgs.length - 2);
  for (let index = firstExportIndex; index < factoryArgs.length; index++) {
    const candidate = factoryArgs[index];
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is ES2022; the inject target is ES2020.
    if (Object.prototype.hasOwnProperty.call(record, "exports")) {
      try {
        record.exports = replaceFunctionExport(record.exports, replacement);
      } catch (_) {}
    }
    replaceFunctionExport(record, replacement);
  }
  return replaceFunctionExport(result, replacement);
}

function findFTSRestoreSync(
  value: unknown,
  seen: WeakSet<object>,
): FacebookFTSRestoreSync | undefined {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  const record = value as Record<string, unknown>;
  const getter = record.getFTSRestoreSync;
  if (typeof getter === "function") {
    try {
      const restore = Reflect.apply(getter, value, []) as
        | Partial<FacebookFTSRestoreSync>
        | undefined;
      if (
        restore &&
        typeof restore.setKeepWhileLoop_FOR_TESTING_ONLY === "function" &&
        typeof restore.setIsStarted === "function" &&
        typeof restore.startSyncingLoop === "function"
      ) {
        return restore as FacebookFTSRestoreSync;
      }
    } catch (_) {}
  }
  return findFTSRestoreSync(record.default, seen);
}

function captureFTSRestoreSync(
  result: unknown,
  factoryArgs: unknown[],
  onFTSRestoreSync: (restore: FacebookFTSRestoreSync) => void,
) {
  const seen = new WeakSet<object>();
  const inspect = (value: unknown) => {
    const restore = findFTSRestoreSync(value, seen);
    if (restore) onFTSRestoreSync(restore);
  };
  inspect(result);
  for (let index = 4; index < factoryArgs.length; index++) {
    const candidate = factoryArgs[index];
    inspect(candidate);
    if (candidate && typeof candidate === "object") {
      inspect((candidate as Record<string, unknown>).exports);
    }
  }
}

/**
 * Keeps Messenger's expensive encrypted-history index restoration asleep until
 * the user explicitly opens conversation search.
 */
export class FacebookFTSIdleCoordinator {
  private active = false;
  private readonly restores = new Set<FacebookFTSRestoreSync>();

  register(restore: FacebookFTSRestoreSync) {
    if (this.restores.has(restore)) return;
    this.restores.add(restore);
    if (this.active) this.start(restore);
    else this.stop(restore);
  }

  wake() {
    if (this.active) return;
    this.active = true;
    for (const restore of this.restores) this.start(restore);
  }

  pause() {
    this.active = false;
    for (const restore of this.restores) this.stop(restore);
  }

  private start(restore: FacebookFTSRestoreSync) {
    try {
      restore.setKeepWhileLoop_FOR_TESTING_ONLY(true);
      restore.setIsStarted(false);
      const result = restore.startSyncingLoop();
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        Promise.resolve(result).catch(() => {});
      }
    } catch (_) {}
  }

  private stop(restore: FacebookFTSRestoreSync) {
    try {
      restore.setKeepWhileLoop_FOR_TESTING_ONLY(false);
    } catch (_) {}
  }
}

function wrapTelemetryMethod(
  record: Record<string, unknown>,
  key: string,
  shouldBlockTelemetry: () => boolean,
) {
  const original = record[key];
  if (typeof original !== "function" || wrappedTelemetryMethods.has(original)) return;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (shouldBlockTelemetry()) return undefined;
    return Reflect.apply(original, this, args);
  };
  wrappedTelemetryMethods.add(wrapped);
  try {
    record[key] = wrapped;
  } catch (_) {}
}

function patchFalcoLogger(value: unknown, shouldBlockTelemetry: () => boolean) {
  if (!value || typeof value !== "object") return;
  const logger = value as Record<string, unknown>;
  for (const method of FALCO_METHODS) {
    wrapTelemetryMethod(logger, method, shouldBlockTelemetry);
  }
}

function wrapFalcoFactory(record: Record<string, unknown>, shouldBlockTelemetry: () => boolean) {
  const original = record.create;
  if (typeof original !== "function" || wrappedFalcoFactories.has(original)) return;

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const logger = Reflect.apply(original, this, args);
    patchFalcoLogger(logger, shouldBlockTelemetry);
    return logger;
  };
  wrappedFalcoFactories.add(wrapped);
  try {
    record.create = wrapped;
  } catch (_) {}
}

function patchTelemetryValue(
  moduleName: string,
  value: unknown,
  shouldBlockTelemetry: () => boolean,
) {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;

  if (moduleName === "FalcoLoggerInternal") {
    wrapFalcoFactory(record, shouldBlockTelemetry);
  } else {
    const methods =
      moduleName === "Banzai"
        ? ["post"]
        : moduleName === "ODS"
          ? ODS_METHODS
          : ["maybeReportActiveSecond"];
    for (const method of methods) wrapTelemetryMethod(record, method, shouldBlockTelemetry);
  }

  if (record.default && record.default !== value && typeof record.default === "object") {
    patchTelemetryValue(moduleName, record.default, shouldBlockTelemetry);
  }
}

function patchTelemetryExports(
  moduleName: string,
  result: unknown,
  factoryArgs: unknown[],
  shouldBlockTelemetry: () => boolean,
) {
  patchTelemetryValue(moduleName, result, shouldBlockTelemetry);
  for (let index = 4; index < factoryArgs.length; index++) {
    const candidate = factoryArgs[index];
    patchTelemetryValue(moduleName, candidate, shouldBlockTelemetry);
    if (!candidate || typeof candidate !== "object") continue;
    patchTelemetryValue(
      moduleName,
      (candidate as Record<string, unknown>).exports,
      shouldBlockTelemetry,
    );
  }
  return result;
}

function wrapFactory(
  moduleName: string,
  factory: FacebookModuleFactory,
  shouldBlockTelemetry: () => boolean,
  onFTSRestoreSync: (restore: FacebookFTSRestoreSync) => void,
): FacebookModuleFactory {
  const wrapped = function (this: unknown, ...factoryArgs: unknown[]) {
    const result = Reflect.apply(factory, this, factoryArgs);
    if (NULL_COMPONENT_MODULES.has(moduleName)) {
      return replaceComponentExports(result, factoryArgs, nullComponent);
    }
    if (BACKGROUND_SERVICE_MODULES.has(moduleName)) {
      captureFTSRestoreSync(result, factoryArgs, onFTSRestoreSync);
      return result;
    }
    return patchTelemetryExports(moduleName, result, factoryArgs, shouldBlockTelemetry);
  };
  // Haste records the generated factory arity and uses it to select the
  // invocation ABI. Rest-parameter wrappers otherwise report length 0.
  try {
    Object.defineProperty(wrapped, "length", { value: factory.length });
  } catch (_) {}
  return wrapped;
}

/**
 * Wrap Facebook's Haste module registration function. Exact module names keep
 * the optimization fail-open when Facebook changes its internals: unknown
 * names and loader shapes pass through untouched.
 */
export function createFacebookModuleDefineInterceptor(
  define: FacebookModuleDefine,
  shouldBlockTelemetry: () => boolean,
  onFTSRestoreSync: (restore: FacebookFTSRestoreSync) => void = () => {},
): FacebookModuleDefine {
  return new Proxy(define, {
    apply(target, thisArg, args: unknown[]) {
      const moduleName = args[0];
      const factory = args[2];
      if (
        typeof moduleName === "string" &&
        typeof factory === "function" &&
        (NULL_COMPONENT_MODULES.has(moduleName) ||
          TELEMETRY_MODULES.has(moduleName) ||
          BACKGROUND_SERVICE_MODULES.has(moduleName))
      ) {
        args[2] = wrapFactory(
          moduleName,
          factory as FacebookModuleFactory,
          shouldBlockTelemetry,
          onFTSRestoreSync,
        );
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}
