/// <reference path="../types.d.ts" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canActivateToastAction, installToast } from "./toast";

class FakeElement extends EventTarget {
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  textContent = "";
  type = "";
  removed = false;

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = children;
  }

  remove() {
    this.removed = true;
  }
}

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
let body: FakeElement;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  body = new FakeElement();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body,
      createElement: () => new FakeElement(),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: originalRequestAnimationFrame,
  });
});

describe("installToast", () => {
  test("renders an inert action description, then clears it for a plain toast", () => {
    cleanup = installToast();

    window.__carrierToast?.("Saved to Downloads", {
      label: "Show in folder",
      kind: "reveal-download",
      url: "blob:test-download",
    });

    const toast = body.children[0];
    expect(toast?.style.pointerEvents).toBe("auto");
    expect(toast?.children[0]?.textContent).toBe("Saved to Downloads");
    expect(toast?.children[1]?.textContent).toBe("Show in folder");
    expect(toast?.children[1]?.type).toBe("button");
    toast?.children[1]?.dispatchEvent(new Event("click"));

    window.__carrierToast?.("Download failed");
    expect(toast?.style.pointerEvents).toBe("none");
    expect(toast?.children).toHaveLength(1);
    expect(toast?.children[0]?.textContent).toBe("Download failed");
  });

  test("installs an immutable page hook", () => {
    cleanup = installToast();
    const descriptor = Object.getOwnPropertyDescriptor(window, "__carrierToast");

    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
  });
});

describe("canActivateToastAction", () => {
  test("requires both a trusted event and an active user gesture", () => {
    expect(canActivateToastAction(true, true)).toBe(true);
    expect(canActivateToastAction(false, true)).toBe(false);
    expect(canActivateToastAction(true, false)).toBe(false);
    expect(canActivateToastAction(false, false)).toBe(false);
  });
});
