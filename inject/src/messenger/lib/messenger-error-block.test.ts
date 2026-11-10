import { describe, expect, test } from "bun:test";
import {
  ErrorBlockTracker,
  errorName,
  type ReactLike,
  trackedErrorBlock,
  wrapErrorBlockFactory,
} from "./messenger-error-block";

/** Just enough React: effects run on demand, elements are plain records. */
function fakeReact() {
  const effects: { effect: () => () => void; deps: unknown[] }[] = [];
  const react: ReactLike = {
    createElement: (type, props) => ({ type, props }),
    useEffect: (effect, deps) => {
      effects.push({ effect, deps });
    },
  };
  return { react, effects };
}

describe("ErrorBlockTracker", () => {
  test("is shown while any block is mounted and reports each change", () => {
    const changes: [boolean, string][] = [];
    const tracker = new ErrorBlockTracker((shown, error) => changes.push([shown, error]));
    expect(tracker.isShown).toBe(false);
    const unmountInbox = tracker.mount("MAWWorkerError");
    const unmountChat = tracker.mount("ReStoreDBCorruption");
    expect(tracker.isShown).toBe(true);
    unmountInbox();
    expect(tracker.isShown).toBe(true);
    unmountChat();
    expect(tracker.isShown).toBe(false);
    // React may run a cleanup twice in development; the second is ignored.
    unmountChat();
    expect(changes).toEqual([
      [true, "MAWWorkerError"],
      [true, "ReStoreDBCorruption"],
      [true, "MAWWorkerError"],
      [false, "ReStoreDBCorruption"],
    ]);
  });
});

describe("errorName", () => {
  test("keeps an identifier-like name and nothing else", () => {
    expect(errorName({ error: { name: "maw_worker_restart_failed" } })).toBe(
      "maw_worker_restart_failed",
    );
    expect(errorName({ error: { name: "Couldn't load: secret text" } })).toBe("unknown");
    expect(errorName({ error: { message: "only a message" } })).toBe("unknown");
    expect(errorName(null)).toBe("unknown");
  });
});

describe("trackedErrorBlock", () => {
  test("renders the original unchanged and is shown only while mounted", () => {
    const { react, effects } = fakeReact();
    const tracker = new ErrorBlockTracker(() => {});
    const original = (props: unknown) => props;
    const Tracked = trackedErrorBlock(original, () => react, tracker);
    const props = { error: { name: "ReStoreDecryptionFailure" }, plural: true };
    expect(Tracked(props)).toEqual({ type: original, props });
    expect(tracker.isShown).toBe(false);
    const cleanup = effects[0]?.effect();
    expect(effects[0]?.deps).toEqual(["ReStoreDecryptionFailure"]);
    expect(tracker.isShown).toBe(true);
    cleanup?.();
    expect(tracker.isShown).toBe(false);
    expect((Tracked as { displayName?: string }).displayName).toBe("ChatpaneTrackedErrorBlock");
  });

  test("falls back to the original when React is unavailable", () => {
    const tracker = new ErrorBlockTracker(() => {});
    const Tracked = trackedErrorBlock(
      () => "original output",
      () => null,
      tracker,
    );
    expect(Tracked({})).toBe("original output");
    expect(tracker.isShown).toBe(false);
  });
});

describe("wrapErrorBlockFactory", () => {
  const block = (props: unknown) => props;

  test("swaps the default export Haste hands in (module, exports) and keeps the arity", () => {
    const { react } = fakeReact();
    const tracker = new ErrorBlockTracker(() => {});
    // Facebook's generated factory: (global, require, requireDynamic, ..., module, exports).
    const factory = (
      _g: unknown,
      _r: unknown,
      _o: unknown,
      _a: unknown,
      _i: unknown,
      _m: unknown,
      exports: { default?: unknown },
    ) => {
      exports.default = block;
    };
    const wrapped = wrapErrorBlockFactory(factory as never, () => react, tracker);
    expect(wrapped.length).toBe(7);
    const module = { exports: {} as { default?: unknown } };
    wrapped(globalThis, null, null, null, null, module, module.exports);
    const exported = module.exports.default as (props: unknown) => unknown;
    expect(exported).not.toBe(block);
    expect(exported({ error: { name: "x" } })).toEqual({
      type: block,
      props: { error: { name: "x" } },
    });
  });

  test("patches returned exports, never wraps twice, and leaves other shapes alone", () => {
    const { react } = fakeReact();
    const tracker = new ErrorBlockTracker(() => {});
    const exports = { default: block as unknown };
    const wrapped = wrapErrorBlockFactory(
      () => exports,
      () => react,
      tracker,
    );
    wrapped();
    const once = exports.default;
    expect(once).not.toBe(block);
    // A second registration of the same exports keeps the tracked component.
    wrapErrorBlockFactory(
      () => exports,
      () => react,
      tracker,
    )();
    expect(exports.default).toBe(once);

    const odd = { default: "not a component" };
    wrapErrorBlockFactory(
      () => odd,
      () => react,
      tracker,
    )();
    expect(odd.default).toBe("not a component");
  });

  test("a factory that throws still throws", () => {
    const tracker = new ErrorBlockTracker(() => {});
    const wrapped = wrapErrorBlockFactory(
      () => {
        throw new Error("boom");
      },
      () => null,
      tracker,
    );
    expect(() => wrapped()).toThrow("boom");
  });
});
