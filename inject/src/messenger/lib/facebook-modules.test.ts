import { describe, expect, mock, test } from "bun:test";
import {
  createFacebookModuleDefineInterceptor,
  FacebookFTSIdleCoordinator,
  type FacebookModuleDefine,
  isConversationSearchInput,
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
  test("wraps the nickname provider before consumers read the module exports", () => {
    const { define, definitions } = definitionHarness();
    const preference = {
      getSnapshot: () => "off" as const,
      subscribe: (_listener: () => void) => () => {},
    };
    const intercepted = createFacebookModuleDefineInterceptor(
      define,
      () => false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      preference,
    );
    const original = (props: unknown): unknown => props;
    intercepted("MWPContactContext.react", ["react"], (...args: unknown[]) => {
      (args[6] as Record<string, unknown>).MWPContactContextProvider = original;
    });
    const exports = { MWPContactContextProvider: original };
    const importModule = (name: string) => {
      expect(name).toBe("react");
      return {
        createElement: (component: unknown, props: unknown) => ({ component, props }),
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => boolean) => snapshot(),
      };
    };
    definitions
      .get("MWPContactContext.react")!
      .factory(undefined, undefined, undefined, importModule, undefined, { exports }, exports);
    expect(exports.MWPContactContextProvider).not.toBe(original);
    const props = { contact: { name: "Alex" }, nickname: "Captain", children: {} };
    expect(exports.MWPContactContextProvider(props)).toEqual({
      component: original,
      props: { ...props, nickname: undefined },
    });
  });

  test("registers title and thread-scope dependencies before Haste factories execute", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(
      define,
      () => false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      {
        getSnapshot: () => "groups",
        subscribe: () => () => {},
      },
    );
    const original = (_thread: unknown): unknown => ({
      threadTitle: "Captain",
      participantsAndContacts: [[{ nickname: "Captain" }, { name: "Alex" }]],
    });
    defineDefaultExport(intercepted, "useLSGetThreadTitle.react", original);
    const definition = definitions.get("useLSGetThreadTitle.react")!;
    expect(definition.dependencies).toContain("react");
    expect(definition.dependencies).toContain("I64");
    expect(definition.dependencies).toContain("LSMessagingThreadTypeUtil");
    const modules: Record<string, unknown> = {
      react: {
        useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => string) => getSnapshot(),
        useMemo: (compute: () => unknown) => compute(),
      },
      I64: { to_string: (key: unknown) => key },
      intlList: { default: { CONJUNCTIONS: { NONE: "none" } } },
      LSMessagingThreadTypeUtil: { isGroup: (type: unknown) => type === "group" },
      MWPGetThreadTitle: { computeThreadTitle: () => "Alex" },
    };
    const exports = { default: original };
    definition.factory(
      undefined,
      undefined,
      undefined,
      (name: string) => modules[name],
      undefined,
      { exports },
      exports,
    );
    expect(exports.default({ threadKey: "123", threadType: "direct" })).toMatchObject({
      threadTitle: "Alex",
    });
    expect(exports.default({ threadKey: "456", threadType: "group" })).toMatchObject({
      threadTitle: "Captain",
    });
    const snippet = (props: unknown) => props;
    defineDefaultExport(intercepted, "MWThreadSnippetForDisplay.react", snippet);
    const snippetModule = definitions.get("MWThreadSnippetForDisplay.react")!;
    expect(snippetModule.dependencies).toContain("ReStoreVaulting");
    expect(snippetModule.dependencies).toContain("react");
    expect(snippetModule.dependencies).toContain("I64");
    const snippetExports = { default: snippet };
    const snippetModules = {
      ...modules,
      react: {
        createElement: (component: unknown, props: unknown) => ({ component, props }),
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => string) => snapshot(),
        useState: (initial: unknown) => [initial, () => {}],
        useEffect: () => {},
        useLayoutEffect: () => {},
      },
      ReStoreVaulting: { maybeUnvault: () => null },
    } as Record<string, unknown>;
    snippetModule.factory(
      undefined,
      undefined,
      undefined,
      (name: string) => snippetModules[name],
      undefined,
      { exports: snippetExports },
      snippetExports,
    );
    expect(snippetExports.default).not.toBe(snippet);
    const props = { thread: { threadKey: "123" }, snippetRaw: "hello" };
    expect(snippetExports.default(props)).toEqual({ component: snippet, props });
    const reply = () => "You replied to Captain";
    defineDefaultExport(intercepted, "useMWReplySnippetContent", reply);
    const replyModule = definitions.get("useMWReplySnippetContent")!;
    expect(replyModule.dependencies).toContain("react");
    expect(replyModule.dependencies).toContain("I64");
    const replyExports = { default: reply };
    replyModule.factory(
      undefined,
      undefined,
      undefined,
      (name: string) => snippetModules[name],
      undefined,
      { exports: replyExports },
      replyExports,
    );
    expect(replyExports.default).not.toBe(reply);
    expect(replyExports.default()).toBe("You replied to Captain");
    intercepted("MWPThreadCapabilitiesContext", ["react"], () => {});
    expect(definitions.get("MWPThreadCapabilitiesContext")!.dependencies).toContain(
      "LSMessagingThreadTypeUtil",
    );
  });

  test("selects Messenger's dedicated worker before consumers read its gate on macOS", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(
      define,
      () => false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const original = mock(function (this: unknown) {
      return this !== undefined;
    });
    intercepted("shouldUseMAWSharedWorker", [], (...args: unknown[]) => {
      (args[6] as Record<string, unknown>).shouldUseMAWSharedWorker = original;
    });
    const { exports } = execute(definitions.get("shouldUseMAWSharedWorker")!.factory);
    const gate = exports.shouldUseMAWSharedWorker as () => boolean;
    expect(gate.call(exports)).toBeFalse();
    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.contexts[0]).toBe(exports);
  });

  test("preserves Facebook's worker choice on other platforms", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(define, () => true);
    const gate = () => true;
    const factory = (...args: unknown[]) => {
      (args[6] as Record<string, unknown>).shouldUseMAWSharedWorker = gate;
    };
    intercepted("shouldUseMAWSharedWorker", [], factory);
    expect(definitions.get("shouldUseMAWSharedWorker")!.factory).toBe(factory);
    expect(execute(factory).exports.shouldUseMAWSharedWorker).toBe(gate);
  });

  test("leaves frozen or changed worker gate exports intact", () => {
    const { define, definitions } = definitionHarness();
    const intercepted = createFacebookModuleDefineInterceptor(
      define,
      () => false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const changed = () => ({ shared: true });
    intercepted("shouldUseMAWSharedWorker", [], () => ({ shouldUseMAWSharedWorker: changed }));
    const result = execute(definitions.get("shouldUseMAWSharedWorker")!.factory).result as {
      shouldUseMAWSharedWorker: typeof changed;
    };
    expect(result.shouldUseMAWSharedWorker()).toEqual({ shared: true });

    const gate = () => true;
    const frozen = Object.freeze({ shouldUseMAWSharedWorker: gate });
    intercepted("shouldUseMAWSharedWorker", [], () => frozen);
    expect(execute(definitions.get("shouldUseMAWSharedWorker")!.factory).result).toBe(frozen);
    expect(frozen.shouldUseMAWSharedWorker()).toBeTrue();

    const differentArity = (_options: unknown) => true;
    intercepted("shouldUseMAWSharedWorker", [], () => ({
      shouldUseMAWSharedWorker: differentArity,
    }));
    expect(
      (
        execute(definitions.get("shouldUseMAWSharedWorker")!.factory).result as {
          shouldUseMAWSharedWorker: typeof differentArity;
        }
      ).shouldUseMAWSharedWorker,
    ).toBe(differentArity);
  });

  test("recognizes conversation search inputs without localized labels", () => {
    expect(
      isConversationSearchInput({
        hasAccessibleName: false,
        insideForm: false,
        insideMain: true,
        role: null,
        type: "search",
      }),
    ).toBeTrue();
    expect(
      isConversationSearchInput({
        hasAccessibleName: false,
        insideForm: false,
        insideMain: true,
        role: "searchbox",
        type: "text",
      }),
    ).toBeTrue();
    expect(
      isConversationSearchInput({
        hasAccessibleName: true,
        insideForm: false,
        insideMain: true,
        role: null,
        type: "text",
      }),
    ).toBeTrue();
  });

  test("rejects composer and unrelated form fields", () => {
    expect(
      isConversationSearchInput({
        hasAccessibleName: true,
        insideForm: false,
        insideMain: true,
        role: "textbox",
        type: "text",
      }),
    ).toBeFalse();
    expect(
      isConversationSearchInput({
        hasAccessibleName: true,
        insideForm: true,
        insideMain: true,
        role: null,
        type: "text",
      }),
    ).toBeFalse();
    expect(
      isConversationSearchInput({
        hasAccessibleName: true,
        insideForm: false,
        insideMain: false,
        role: null,
        type: "search",
      }),
    ).toBeFalse();
  });

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

test("observes ErrorPubSub once, preserves exports, and isolates listener failures", () => {
  const { define, definitions } = definitionHarness();
  let observed = 0;
  let subscriptions = 0;
  let emit: ((error: unknown) => void) | undefined;
  const stream = {
    addListener(listener: (error: unknown) => void) {
      subscriptions++;
      emit = listener;
      listener({ messageParams: [1675004] });
    },
  };
  const intercepted = createFacebookModuleDefineInterceptor(
    define,
    () => false,
    undefined,
    () => {
      observed++;
      throw new Error("observer failure");
    },
  );
  defineDefaultExport(intercepted, "ErrorPubSub", stream);
  const factory = definitions.get("ErrorPubSub")!.factory;
  expect(execute(factory).exports.default).toBe(stream);
  execute(factory);
  expect(subscriptions).toBe(1);
  expect(observed).toBe(1);
  expect(() => emit?.({})).not.toThrow();
  expect(observed).toBe(2);
});
