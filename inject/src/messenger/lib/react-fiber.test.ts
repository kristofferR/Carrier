import { describe, expect, test } from "bun:test";
import { isRenderedBy, moduleExport, renderDepth, renders } from "./react-fiber";

describe("moduleExport", () => {
  const icons = { ViewProfile: () => null };
  const component = () => null;
  const modules: Record<string, unknown> = {
    // Facebook's require hands back a default export unwrapped.
    Icons: icons,
    Component: component,
    // Without one it hands back the exports object.
    Named: { Archive: component },
    Wrapped: { default: component },
  };
  const load = (name: string) => {
    if (!(name in modules)) throw new Error(`Requiring unknown module "${name}"`);
    return modules[name];
  };

  test("reads unwrapped defaults, wrapped defaults and named exports", () => {
    expect(moduleExport(load, "Icons")).toBe(icons);
    expect(moduleExport(load, "Component")).toBe(component);
    expect(moduleExport(load, "Wrapped")).toBe(component);
    expect(moduleExport(load, "Named", "Archive")).toBe(component);
  });

  test("is undefined for a module that isn't loaded", () => {
    expect(moduleExport(load, "Missing")).toBeUndefined();
    expect(moduleExport(null, "Icons")).toBeUndefined();
  });
});

describe("renders", () => {
  test("matches plain, memo and forwardRef components, never null", () => {
    const fn = () => null;
    expect(renders({ type: fn }, fn)).toBe(true);
    expect(renders({ type: fn }, { $$typeof: "memo", type: fn })).toBe(true);
    expect(renders({ type: fn }, { $$typeof: "forward_ref", render: fn })).toBe(true);
    expect(renders({ type: fn }, () => null)).toBe(false);
    expect(renders({ type: undefined }, undefined)).toBe(false);
  });
});

describe("renderDepth", () => {
  const Component = () => null;
  const node = {} as Element;
  // A host fiber two levels under the component, read through ReactDOM's accessor.
  const fiber = {
    stateNode: node,
    type: "svg",
    return: { type: "div", return: { type: Component } },
  };
  const load = (found: unknown) => (name: string) =>
    name === "ReactDOM"
      ? { __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { Events: [() => found] } }
      : undefined;

  test("counts the fibers between a node and its nearest component", () => {
    expect(renderDepth(node, Component, load(fiber))).toBe(2);
    expect(renderDepth(node, "svg", load(fiber))).toBe(0);
    expect(isRenderedBy(node, Component, load(fiber))).toBe(true);
  });

  test("stops at the limit and without a component or a matching fiber", () => {
    expect(renderDepth(node, Component, load(fiber), 2)).toBeNull();
    expect(isRenderedBy(node, Component, load(fiber), 3)).toBe(true);
    expect(renderDepth(node, undefined, load(fiber))).toBeNull();
    expect(renderDepth(node, () => null, load(fiber))).toBeNull();
    // A fiber that belongs to another node is not this node's.
    expect(renderDepth(node, Component, load({ ...fiber, stateNode: {} }))).toBeNull();
  });
});
