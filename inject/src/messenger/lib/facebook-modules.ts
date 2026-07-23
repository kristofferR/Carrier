export type FacebookModuleDefine = (this: unknown, ...args: unknown[]) => unknown;

type FacebookModuleFactory = (this: unknown, ...args: unknown[]) => unknown;

const NULL_COMPONENT_MODULES = new Set([
  // Carrier's CSS already hides this entire Facebook-wide header tree. Removing
  // the React root prevents its search, notification, account, and portal work.
  "CometBaseAppNavigation.react",
  // Messenger's server-driven promotion banner is not part of messaging.
  "MWInboxQuickPromotionWrapper.react",
]);

const PASSTHROUGH_COMPONENT_MODULES = new Set([
  // These wrappers only measure component/message visibility and mount spans.
  // Returning their children avoids one logging boundary per visible message.
  "MWPMessageLoggingWrapper.react",
  "ComponentMountUnmountSubspanLogger.react",
]);

const TELEMETRY_MODULES = new Set([
  "Banzai",
  "FalcoLoggerInternal",
  "ODS",
  "TimeSpentImmediateActiveSecondsLogger",
  "TimeSpentImmediateActiveSecondsLoggerComet",
]);
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

function passthroughComponent(props: { children?: unknown } | null | undefined) {
  return props?.children ?? null;
}

Object.defineProperty(passthroughComponent, "displayName", {
  value: "CarrierPassthroughFacebookComponent",
});

type ComponentReplacement = typeof nullComponent | typeof passthroughComponent;

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
  // Facebook's Haste factory ABI exposes module/exports objects near the end
  // of the argument list. Cover both CommonJS and default-export shapes; every
  // mutation is fail-open so a loader change leaves Facebook's module intact.
  for (let index = 4; index < factoryArgs.length; index++) {
    const candidate = factoryArgs[index];
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    if (Object.hasOwn(record, "exports")) {
      try {
        record.exports = replaceFunctionExport(record.exports, replacement);
      } catch (_) {}
    }
    replaceFunctionExport(record, replacement);
  }
  return replaceFunctionExport(result, replacement);
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
): FacebookModuleFactory {
  const wrapped = function (this: unknown, ...factoryArgs: unknown[]) {
    const result = Reflect.apply(factory, this, factoryArgs);
    if (NULL_COMPONENT_MODULES.has(moduleName)) {
      return replaceComponentExports(result, factoryArgs, nullComponent);
    }
    if (PASSTHROUGH_COMPONENT_MODULES.has(moduleName)) {
      return replaceComponentExports(result, factoryArgs, passthroughComponent);
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
): FacebookModuleDefine {
  return new Proxy(define, {
    apply(target, thisArg, args: unknown[]) {
      const moduleName = args[0];
      const factory = args[2];
      if (
        typeof moduleName === "string" &&
        typeof factory === "function" &&
        (NULL_COMPONENT_MODULES.has(moduleName) ||
          PASSTHROUGH_COMPONENT_MODULES.has(moduleName) ||
          TELEMETRY_MODULES.has(moduleName))
      ) {
        args[2] = wrapFactory(moduleName, factory as FacebookModuleFactory, shouldBlockTelemetry);
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}
