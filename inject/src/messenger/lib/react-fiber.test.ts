import { describe, expect, test } from "bun:test";
import { moduleExport, renders } from "./react-fiber";

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
