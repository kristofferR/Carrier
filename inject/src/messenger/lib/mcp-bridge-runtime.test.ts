import { beforeAll, describe, expect, mock, test } from "bun:test";

const bridgePath = new URL("../../../../src-tauri/inject/mcp-bridge.js", import.meta.url);

class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly childNodes: Array<{ nodeType: number; textContent: string }> = [];
  readonly attributes = new Map<string, string>();
  hidden = false;
  id = "";
  tabIndex = -1;
  checked: boolean | undefined;
  disabled: boolean | undefined;
  display = "block";
  visibility = "visible";
  outerHTML = "<fake></fake>";

  constructor(tagName: string, text = "") {
    this.tagName = tagName.toUpperCase();
    if (text) this.childNodes.push({ nodeType: 3, textContent: text });
  }

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    if (name === "id") return this.id || null;
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return (name === "id" && !!this.id) || this.attributes.has(name);
  }

  get textContent(): string {
    return [
      ...this.childNodes.map((node) => node.textContent),
      ...this.children.map((child) => child.textContent),
    ].join("");
  }

  get innerText(): string {
    return this.textContent;
  }
}

interface PageMapResult {
  elements: Array<{ depth: number; text?: string }>;
  content: string;
  maxDepth: number;
  truncated?: boolean;
}

type BridgeListener = (event: { payload: Record<string, unknown> }) => void;

interface BridgeHarness {
  document: {
    documentElement: FakeElement;
    querySelectorAll(selector: string): FakeElement[];
  };
  execute(code: string): unknown;
  sessionStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  window: Record<string, unknown>;
  map(payload: Record<string, unknown>): PageMapResult;
}

let bridgeSource = "";

beforeAll(async () => {
  bridgeSource = await Bun.file(bridgePath).text();
});

function createHarness(
  root: FakeElement,
  configureWindow?: (window: Record<string, unknown>) => void,
  initialStorage: Record<string, string> = {},
): BridgeHarness {
  const listeners = new Map<string, BridgeListener>();
  const callbacks = new Map<number, BridgeListener>();
  const emissions: Array<{ event: string; payload: unknown }> = [];
  let nextCallback = 1;
  const scopes = new Map<string, FakeElement[]>();
  const document = {
    readyState: "complete",
    title: "MCP bridge test",
    documentElement: root,
    querySelectorAll(selector: string) {
      if (selector === "[") throw new Error("invalid selector");
      return scopes.get(selector) ?? [];
    },
  };
  const internals = {
    metadata: {
      currentWebview: { label: "main" },
      currentWindow: { label: "main" },
    },
    transformCallback(callback: BridgeListener) {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    invoke(command: string, args: Record<string, unknown>) {
      if (command === "plugin:event|listen") {
        const callback = callbacks.get(Number(args.handler));
        if (!callback) throw new Error(`missing callback ${String(args.handler)}`);
        listeners.set(String(args.event), callback);
      } else if (command === "plugin:event|emit") {
        emissions.push({ event: String(args.event), payload: args.payload });
      }
      return Promise.resolve();
    },
  };
  const window = { __TAURI_INTERNALS__: internals } as Record<string, unknown>;
  const storage = new Map(Object.entries(initialStorage));
  const sessionStorage = {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    },
  };
  configureWindow?.(window);
  const location = { href: "https://www.facebook.com/messages" };
  const quietConsole = { log() {} };

  // Execute the exact committed bridge against a deliberately tiny DOM/Tauri
  // shim. This makes the cap tests exercise the live handler, not a copy.
  new Function(
    "window",
    "document",
    "location",
    "innerWidth",
    "innerHeight",
    "getComputedStyle",
    "console",
    "sessionStorage",
    bridgeSource,
  )(
    window,
    document,
    location,
    1200,
    800,
    (element: FakeElement) => ({
      display: element.display,
      visibility: element.visibility,
    }),
    quietConsole,
    sessionStorage,
  );

  return {
    document,
    execute(code) {
      emissions.length = 0;
      const handler = listeners.get("execute-js");
      if (!handler) throw new Error("execute-js listener was not registered");
      handler({ payload: { _payload: code, _correlationId: "test" } });
      const response = emissions.find((emission) => emission.event === "execute-js-response-test");
      if (!response?.payload || typeof response.payload !== "object") {
        throw new Error("execute-js did not emit a response");
      }
      const result = (response.payload as { result?: unknown }).result;
      if (typeof result !== "string") return result;
      try {
        return JSON.parse(result);
      } catch {
        return result;
      }
    },
    sessionStorage,
    window,
    map(payload) {
      emissions.length = 0;
      const handler = listeners.get("get-page-map");
      if (!handler) throw new Error("get-page-map listener was not registered");
      handler({ payload: { ...payload, _correlationId: "test" } });
      const response = emissions.find(
        (emission) => emission.event === "get-page-map-response-test",
      );
      if (!response || typeof response.payload !== "string") {
        throw new Error("get-page-map did not emit a serialized response");
      }
      return JSON.parse(response.payload) as PageMapResult;
    },
  };
}

describe("runtime MCP page-map bounds", () => {
  test("composes its Haste instrumentation with an existing define accessor", () => {
    let assigned: unknown;
    const inheritedAssignments: unknown[] = [];
    const root = new FakeElement("div");
    const harness = createHarness(root, (window) => {
      Object.defineProperty(window, "__d", {
        configurable: true,
        get: () => assigned,
        set: (value) => {
          inheritedAssignments.push(value);
          assigned = value;
        },
      });
    });
    const nativeDefine = mock(() => undefined);

    harness.window.__d = nativeDefine;
    expect(inheritedAssignments).toHaveLength(1);
    expect(inheritedAssignments[0]).not.toBe(nativeDefine);

    (harness.window.__d as (...args: unknown[]) => unknown)(
      "CometNavigationTracing",
      [],
      () => undefined,
    );
    expect(nativeDefine).toHaveBeenCalledTimes(1);
  });

  test("profiles and replaces an exact React component before its dependencies execute", () => {
    for (let arity = 6; arity <= 10; arity++) {
      const root = new FakeElement("div");
      const originalFactory = mock(() => undefined);
      Object.defineProperty(originalFactory, "length", { value: arity });
      let definition:
        | { dependencies: unknown[]; factory: (...args: unknown[]) => unknown }
        | undefined;
      const nativeDefine = (_name: unknown, dependencies: unknown, factory: unknown) => {
        definition = {
          dependencies: dependencies as unknown[],
          factory: factory as (...args: unknown[]) => unknown,
        };
      };
      const harness = createHarness(root, undefined, {
        __carrier_mcp_component_null__: "OptionalFeature.react",
      });

      harness.window.__d = nativeDefine;
      (harness.window.__d as (...args: unknown[]) => unknown)(
        "OptionalFeature.react",
        ["ExpensiveDependency"],
        originalFactory,
      );

      expect(definition?.dependencies).toEqual([]);
      expect(definition?.factory.length).toBe(arity);
      const unrelatedDefault = () => "unrelated";
      const unrelated = { default: unrelatedDefault };
      const exports: Record<string, unknown> = {};
      const module = { exports };
      const factoryArgs = Array.from({ length: arity }, () => undefined as unknown);
      if (arity > 6) factoryArgs[4] = unrelated;
      factoryArgs[arity - 2] = module;
      factoryArgs[arity - 1] = exports;
      definition?.factory(...factoryArgs);
      expect(originalFactory).not.toHaveBeenCalled();
      expect((exports.default as () => unknown)()).toBeNull();
      expect((module.exports as unknown as () => unknown)()).toBeNull();
      if (arity > 6) expect(unrelated.default).toBe(unrelatedDefault);
      const runtime = harness.window.__CARRIER_MCP_MODULE_RUNTIME__ as {
        replacedDefinitions: number;
      };
      expect(runtime.replacedDefinitions).toBe(1);
      definition?.factory(...factoryArgs);
      expect(runtime.replacedDefinitions).toBe(1);
    }
  });

  test("records component replacement only after an export mutation succeeds", () => {
    const root = new FakeElement("div");
    let replacementFactory: ((...args: unknown[]) => unknown) | undefined;
    const harness = createHarness(
      root,
      (window) => {
        window.__d = (_name: unknown, _dependencies: unknown, factory: unknown) => {
          replacementFactory = factory as (...args: unknown[]) => unknown;
        };
      },
      { __carrier_mcp_component_null__: "ReadOnlyFeature.react" },
    );

    (harness.window.__d as (...args: unknown[]) => unknown)(
      "ReadOnlyFeature.react",
      [],
      () => undefined,
    );
    const original = () => "original";
    const exports = {};
    Object.defineProperty(exports, "default", { value: original });
    const module = {};
    Object.defineProperty(module, "exports", { value: original });
    replacementFactory?.(undefined, undefined, undefined, undefined, undefined, module, exports);

    const runtime = harness.window.__CARRIER_MCP_MODULE_RUNTIME__ as {
      replacedDefinitions: number;
    };
    expect(runtime.replacedDefinitions).toBe(0);
  });

  test("keeps dependencies keyed by exact component experiment", () => {
    const root = new FakeElement("div");
    const harness = createHarness(
      root,
      (window) => {
        window.__d = () => undefined;
      },
      {
        __carrier_mcp_component_null__: "NullFeature.react",
        __carrier_mcp_component_passthrough__: "BoundaryFeature.react",
      },
    );

    const define = harness.window.__d as (...args: unknown[]) => unknown;
    define("NullFeature.react", ["NullDependency"], () => undefined);
    define("BoundaryFeature.react", ["BoundaryDependency"], () => undefined);

    const runtime = harness.window.__CARRIER_MCP_MODULE_RUNTIME__ as {
      componentDependencies: Record<string, string[]>;
    };
    expect(runtime.componentDependencies).toEqual({
      "NullFeature.react": ["NullDependency"],
      "BoundaryFeature.react": ["BoundaryDependency"],
    });
  });

  test.each([5, 11])("profiles React factories with arity %i", (arity) => {
    const root = new FakeElement("div");
    const originalFactory = mock(() => "factory result");
    Object.defineProperty(originalFactory, "length", { value: arity });
    let instrumentedFactory: ((...args: unknown[]) => unknown) | undefined;
    const harness = createHarness(
      root,
      (window) => {
        window.__d = (_name: unknown, _dependencies: unknown, factory: unknown) => {
          instrumentedFactory = factory as (...args: unknown[]) => unknown;
        };
      },
      { __carrier_mcp_react_profile__: "on" },
    );

    (harness.window.__d as (...args: unknown[]) => unknown)("OddArity.react", [], originalFactory);

    expect(instrumentedFactory?.length).toBe(arity);
    expect(instrumentedFactory?.(...Array.from({ length: arity }))).toBe("factory result");
    expect(originalFactory).toHaveBeenCalledTimes(1);
    const runtime = harness.window.__CARRIER_MCP_MODULE_RUNTIME__ as {
      reactExecuted: number;
      reactModules: Record<string, { executions: number }>;
    };
    expect(runtime.reactExecuted).toBe(1);
    expect(runtime.reactModules["OddArity.react"]?.executions).toBe(1);
  });

  test("passes through falsy children and persists exact experiment selections", () => {
    const root = new FakeElement("div");
    let factory: ((...args: unknown[]) => unknown) | undefined;
    const harness = createHarness(
      root,
      (window) => {
        window.__d = (_name: unknown, _dependencies: unknown, replacementFactory: unknown) => {
          factory = replacementFactory as (...args: unknown[]) => unknown;
        };
      },
      {
        __carrier_mcp_component_passthrough__: "LoggingBoundary.react",
      },
    );

    (harness.window.__d as (...args: unknown[]) => unknown)(
      "LoggingBoundary.react",
      ["Logger"],
      () => undefined,
    );
    const exports: Record<string, unknown> = {};
    const module = { exports };
    factory?.(undefined, undefined, undefined, undefined, undefined, module, exports);
    expect((exports.default as (props: { children: unknown }) => unknown)({ children: 0 })).toBe(0);

    expect(harness.execute("__carrier_mcp_react_profile__:on")).toEqual({
      applied: true,
      reactProfile: "on",
      reloadRequired: true,
    });
    expect(harness.sessionStorage.getItem("__carrier_mcp_react_profile__")).toBe("on");
  });

  test("records only credential-free HTTPS JavaScript bundles from Facebook's CDN", () => {
    const root = new FakeElement("div");
    const harness = createHarness(root);

    expect(harness.execute("__carrier_mcp_static_bundle_test_probe__")).toEqual([
      "static.xx.fbcdn.net/bundle.js",
    ]);
  });

  test("clamps depth against a synthetic deep tree", () => {
    const root = new FakeElement("section");
    let parent = root;
    for (let depth = 0; depth < 50; depth++) {
      const child = new FakeElement("section");
      parent.append(child);
      parent = child;
    }
    const harness = createHarness(root);

    const result = harness.map({ maxDepth: 999, includeContent: false });
    expect(result.maxDepth).toBe(30);
    expect(Math.max(...result.elements.map((element) => element.depth))).toBe(30);
  });

  test("truncates excessive visited nodes and element counts", () => {
    const nodeRoot = new FakeElement("div");
    nodeRoot.append(...Array.from({ length: 10_050 }, () => new FakeElement("div")));
    const nodeResult = createHarness(nodeRoot).map({ includeContent: false });
    expect(nodeResult.truncated).toBe(true);

    const elementRoot = new FakeElement("div");
    elementRoot.append(...Array.from({ length: 2_100 }, () => new FakeElement("button")));
    const elementResult = createHarness(elementRoot).map({ includeContent: false });
    expect(elementResult.truncated).toBe(true);
    expect(elementResult.elements).toHaveLength(2_000);
  });

  test("truncates serialized output before the element cap", () => {
    const root = new FakeElement("div");
    root.append(
      ...Array.from({ length: 1_000 }, (_, index) => {
        const button = new FakeElement("button", `${index}-${"x".repeat(300)}`);
        button.id = `button-${index}`;
        return button;
      }),
    );

    const result = createHarness(root).map({ includeContent: true });
    expect(result.truncated).toBe(true);
    expect(result.elements.length).toBeLessThan(2_000);
    expect(JSON.stringify(result).length).toBeLessThan(221_000);
  });
});
