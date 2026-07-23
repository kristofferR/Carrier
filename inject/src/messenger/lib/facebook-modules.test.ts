import { describe, expect, mock, test } from "bun:test";
import {
  createFacebookModuleDefineInterceptor,
  type FacebookModuleDefine,
} from "./facebook-modules";

type ModuleFactory = (...args: unknown[]) => unknown;

function definitionHarness() {
  const definitions = new Map<string, ModuleFactory>();
  const define: FacebookModuleDefine = (name, _dependencies, factory) => {
    if (typeof name === "string" && typeof factory === "function") {
      definitions.set(name, factory as ModuleFactory);
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

    const { exports } = execute(definitions.get("CometBaseAppNavigation.react")!);
    expect(exports.default).toBeFunction();
    expect((exports.default as () => unknown)()).toBeNull();
  });

  test("removes Messenger's promotion wrapper", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    defineDefaultExport(intercepted, "MWInboxQuickPromotionWrapper.react", () => "promotion");

    const { exports } = execute(definitions.get("MWInboxQuickPromotionWrapper.react")!);
    expect((exports.default as () => unknown)()).toBeNull();
  });

  test("turns per-message logging wrappers into child passthroughs", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    defineDefaultExport(intercepted, "MWPMessageLoggingWrapper.react", () => "logged");

    const { exports } = execute(definitions.get("MWPMessageLoggingWrapper.react")!);
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

    expect(definitions.get("CometBaseAppNavigation.react")?.length).toBe(7);
  });

  test("leaves unrelated Facebook modules untouched", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    const factory = mock(() => "messaging result");

    intercepted("MAWMessagingCore", [], factory);

    const registered = definitions.get("MAWMessagingCore")!;
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

    const { exports } = execute(definitions.get("Banzai")!);
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

    const { exports } = execute(definitions.get("ODS")!);
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

    const { exports } = execute(definitions.get("FalcoLoggerInternal")!);
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

    const { exports } = execute(definitions.get("TimeSpentImmediateActiveSecondsLoggerComet")!);
    expect((exports.maybeReportActiveSecond as () => unknown)()).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });
});
