import { describe, expect, mock, test } from "bun:test";
import {
  createFacebookModuleDefineInterceptor,
  FacebookFTSIdleCoordinator,
  type FacebookModuleDefine,
} from "./facebook-modules";

type ModuleFactory = (...args: unknown[]) => unknown;

function definitionHarness() {
  const definitions = new Map<string, { dependencies: unknown[]; factory: ModuleFactory }>();
  const define: FacebookModuleDefine = (name, dependencies, factory) => {
    if (typeof name === "string" && typeof factory === "function") {
      definitions.set(name, {
        dependencies: Array.isArray(dependencies) ? dependencies : [],
        factory: factory as ModuleFactory,
      });
    }
  };
  return { define, definitions };
}

function execute(factory: ModuleFactory) {
  const exports: Record<string, unknown> = {};
  const module = { exports };
  const result = factory(undefined, undefined, undefined, undefined, undefined, module, exports);
  return { exports, module, result };
}

function defineDefaultExport(
  intercepted: FacebookModuleDefine,
  moduleName: string,
  value: unknown,
) {
  intercepted(moduleName, [], (...args: unknown[]) => {
    (args[6] as Record<string, unknown>).default = value;
  });
}

describe("Facebook module interception", () => {
  test("replaces only the already-hidden Facebook navigation root", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    defineDefaultExport(intercepted, "CometBaseAppNavigation.react", () => "facebook chrome");

    const { exports } = execute(definitions.get("CometBaseAppNavigation.react")!.factory);
    expect(exports.default).toBeFunction();
    expect((exports.default as () => unknown)()).toBeNull();
  });

  test("removes Messenger's promotion wrapper", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    defineDefaultExport(intercepted, "MWInboxQuickPromotionWrapper.react", () => "promotion");

    const { exports } = execute(definitions.get("MWInboxQuickPromotionWrapper.react")!.factory);
    expect((exports.default as () => unknown)()).toBeNull();
  });

  test("turns per-message logging wrappers into child passthroughs", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    defineDefaultExport(intercepted, "MWPMessageLoggingWrapper.react", () => "logged");

    const { exports } = execute(definitions.get("MWPMessageLoggingWrapper.react")!.factory);
    const wrapper = exports.default as (props: { children?: unknown }) => unknown;
    expect(wrapper({ children: "message" })).toBe("message");
    expect(wrapper({})).toBeNull();
  });

  test("preserves factory arity because Haste uses it to choose an ABI", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    const factory = (
      _a: unknown,
      _b: unknown,
      _c: unknown,
      _d: unknown,
      _e: unknown,
      _f: unknown,
      _g: unknown,
    ) => {};

    intercepted("CometBaseAppNavigation.react", [], factory);

    expect(definitions.get("CometBaseAppNavigation.react")?.factory.length).toBe(7);
  });

  test.each([
    "MWInboxQuickPromotionWrapperImportUnconditionally.react",
    "MAWSecureThreadQuickPromotion.react",
    "MWThreadListQP.react",
    "MWMessageSearchEBRestoreUpsell.react",
    "CometBrowserPushRoot.react",
    "CometCastingMiniplayerRoot.react",
  ])("removes the optional feature component %s", (moduleName) => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);

    defineDefaultExport(intercepted, moduleName, () => "optional feature");

    const { exports } = execute(definitions.get(moduleName)!.factory);
    expect((exports.default as () => unknown)()).toBeNull();
  });

  test("only replaces the terminal Haste module and exports arguments", () => {
    for (let arity = 6; arity <= 10; arity++) {
      const { define, definitions } = definitionHarness();
      const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
      const originalFactory = (...args: unknown[]) => {
        (args[arity - 1] as Record<string, unknown>).default = () => "optional feature";
      };
      Object.defineProperty(originalFactory, "length", { value: arity });

      intercepted("CometBrowserPushRoot.react", [], originalFactory);

      const unrelatedDefault = () => "unrelated";
      const unrelated = { default: unrelatedDefault };
      const exports: Record<string, unknown> = {};
      const module = { exports };
      const factoryArgs = Array.from({ length: arity }, () => undefined as unknown);
      if (arity > 6) factoryArgs[4] = unrelated;
      factoryArgs[arity - 2] = module;
      factoryArgs[arity - 1] = exports;
      definitions.get("CometBrowserPushRoot.react")!.factory(...factoryArgs);

      expect((exports.default as () => unknown)()).toBeNull();
      expect((module.exports as { default: () => unknown }).default()).toBeNull();
      if (arity > 6) expect(unrelated.default).toBe(unrelatedDefault);
    }
  });

  test("preserves declared dependencies and replaces a CommonJS function export", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);

    intercepted("CometCastingMiniplayerRoot.react", ["VideoDependency"], (...args: unknown[]) => {
      (args[5] as { exports: unknown }).exports = () => "casting";
    });

    const definition = definitions.get("CometCastingMiniplayerRoot.react")!;
    expect(definition.dependencies).toEqual(["VideoDependency"]);
    const { module } = execute(definition.factory);
    expect((module.exports as unknown as () => unknown)()).toBeNull();
  });

  test("leaves unrelated Facebook modules untouched", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    const factory = mock(() => "messaging result");

    intercepted("MAWMessagingCore", [], factory);

    const registered = definitions.get("MAWMessagingCore")!.factory;
    expect(registered).toBe(factory);
    expect(registered()).toBe("messaging result");
  });

  test("Banzai producer follows live telemetry setting changes", () => {
    const { define, definitions } = definitionHarness();
    let blocked = true;
    const intercepted = createFacebookModuleDefineInterceptor(define, () => blocked);
    const post = mock(() => "posted");

    intercepted("Banzai", [], (...args: unknown[]) => {
      (args[6] as Record<string, unknown>).post = post;
    });

    const { exports } = execute(definitions.get("Banzai")!.factory);
    expect((exports.post as () => unknown)()).toBeUndefined();
    expect(post).not.toHaveBeenCalled();

    blocked = false;
    expect((exports.post as () => unknown)()).toBe("posted");
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("suppresses each ODS metrics producer", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    const producers = {
      bumpEntityKey: mock(() => 1),
      bumpFraction: mock(() => 2),
      flush: mock(() => 3),
      setEntitySample: mock(() => 4),
    };

    intercepted("ODS", [], (...args: unknown[]) => {
      Object.assign(args[6] as Record<string, unknown>, producers);
    });

    const { exports } = execute(definitions.get("ODS")!.factory);
    for (const method of Object.keys(producers)) {
      expect((exports[method] as () => unknown)()).toBeUndefined();
    }
    for (const producer of Object.values(producers)) expect(producer).not.toHaveBeenCalled();
  });

  test("Falco skips payload producers while blocked and resumes live", () => {
    const { define, definitions } = definitionHarness();
    let blocked = true;
    const intercepted = createFacebookModuleDefineInterceptor(define, () => blocked);
    const log = mock(() => "logged");
    const create = mock(() => ({ log }));

    intercepted("FalcoLoggerInternal", [], (...args: unknown[]) => {
      (args[6] as Record<string, unknown>).create = create;
    });

    const { exports } = execute(definitions.get("FalcoLoggerInternal")!.factory);
    const logger = (exports.create as () => { log: () => unknown })();
    expect(logger.log()).toBeUndefined();
    expect(log).not.toHaveBeenCalled();

    blocked = false;
    expect(logger.log()).toBe("logged");
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("suppresses the active-seconds producer while telemetry is blocked", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    const report = mock(() => "reported");

    intercepted("TimeSpentImmediateActiveSecondsLoggerComet", [], (...args: unknown[]) => {
      (args[6] as Record<string, unknown>).maybeReportActiveSecond = report;
    });

    const { exports } = execute(
      definitions.get("TimeSpentImmediateActiveSecondsLoggerComet")!.factory,
    );
    expect((exports.maybeReportActiveSecond as () => unknown)()).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });

  test("pauses history indexing until conversation search wakes it", () => {
    const { define, definitions } = definitionHarness();
    const searchIndex = new FacebookFTSIdleCoordinator();
    const keepRunning = mock((_keep: boolean) => {});
    const setIsStarted = mock((_started: boolean) => {});
    const startSyncingLoop = mock(() => Promise.resolve());
    const restore = {
      setKeepWhileLoop_FOR_TESTING_ONLY: keepRunning,
      setIsStarted,
      startSyncingLoop,
    };
    const intercepted = createFacebookModuleDefineInterceptor(
      define,
      () => true,
      (value) => searchIndex.register(value),
    );

    intercepted("MAWFTSRestoreSync", [], (...args: unknown[]) => {
      (args[6] as Record<string, unknown>).getFTSRestoreSync = () => restore;
    });
    execute(definitions.get("MAWFTSRestoreSync")!.factory);

    expect(keepRunning).toHaveBeenLastCalledWith(false);
    expect(startSyncingLoop).not.toHaveBeenCalled();

    searchIndex.wake();
    expect(keepRunning).toHaveBeenLastCalledWith(true);
    expect(setIsStarted).toHaveBeenLastCalledWith(false);
    expect(startSyncingLoop).toHaveBeenCalledTimes(1);

    searchIndex.wake();
    expect(startSyncingLoop).toHaveBeenCalledTimes(1);

    searchIndex.pause();
    expect(keepRunning).toHaveBeenLastCalledWith(false);
  });
});
