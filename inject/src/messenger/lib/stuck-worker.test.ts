import { describe, expect, test } from "bun:test";
import {
  probeFacebook,
  STUCK_WORKER_MAX_MS,
  STUCK_WORKER_RELOAD_MS,
  StuckWorkerReload,
} from "./stuck-worker";

function fixture() {
  let now = 0;
  let reachable = false;
  let probes = 0;
  const gate = new StuckWorkerReload(
    async () => {
      probes++;
      return reachable;
    },
    () => now,
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Ticks every five seconds, like the page's health interval. */
  const run = async (ms: number) => {
    let due: ReturnType<StuckWorkerReload["due"]>;
    for (let elapsed = 0; elapsed <= ms; elapsed += 5_000) {
      due = gate.due();
      await settle();
      if (due) return due;
      now += 5_000;
    }
    return undefined;
  };
  return {
    gate,
    run,
    get probes() {
      return probes;
    },
    set reachable(value: boolean) {
      reachable = value;
    },
  };
}

describe("StuckWorkerReload", () => {
  test("waits while Facebook is unreachable, then for two retry rounds once it answers", async () => {
    const f = fixture();
    expect(await f.run(STUCK_WORKER_RELOAD_MS)).toBeUndefined();
    f.reachable = true;
    // The next probe can be up to 30 seconds away.
    expect(await f.run(STUCK_WORKER_RELOAD_MS - 35_000)).toBeUndefined();
    expect(await f.run(60_000)).toBe("reachable");
  });

  test("a failed probe restarts the reachability window", async () => {
    const f = fixture();
    f.reachable = true;
    expect(await f.run(60_000)).toBeUndefined();
    f.reachable = false;
    expect(await f.run(30_000)).toBeUndefined();
    f.reachable = true;
    expect(await f.run(STUCK_WORKER_RELOAD_MS - 5_000)).toBeUndefined();
  });

  test.each([true, false])(
    "waits for the threshold probe to settle (reachable=%s)",
    async (answer) => {
      let now = 0;
      let finishProbe: ((reachable: boolean) => void) | undefined;
      const gate = new StuckWorkerReload(
        () =>
          new Promise((resolve) => {
            finishProbe = resolve;
          }),
        () => now,
      );
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
      expect(gate.due()).toBeUndefined();
      finishProbe?.(true);
      await settle();
      now = STUCK_WORKER_RELOAD_MS;
      expect(gate.due()).toBeUndefined();
      expect(gate.due()).toBeUndefined();
      finishProbe?.(answer);
      await settle();
      expect(gate.due()).toBe(answer ? "reachable" : undefined);
      // The maximum stuck time still applies even if a probe hangs.
      now = STUCK_WORKER_MAX_MS;
      expect(gate.due()).toBe("timeout");
    },
  );

  test("reloads after the cap even if no probe ever succeeds", async () => {
    const f = fixture();
    expect(await f.run(STUCK_WORKER_MAX_MS)).toBe("timeout");
  });

  test("probes at most every 30 seconds", async () => {
    const f = fixture();
    await f.run(60_000);
    expect(f.probes).toBe(3);
  });

  test("reset starts a fresh episode", async () => {
    const f = fixture();
    f.reachable = true;
    expect(await f.run(STUCK_WORKER_RELOAD_MS + 30_000)).toBe("reachable");
    f.gate.reset();
    expect(await f.run(STUCK_WORKER_RELOAD_MS - 5_000)).toBeUndefined();
  });
});

describe("probeFacebook", () => {
  test("any HTTP answer counts as reachable; a network failure does not", async () => {
    const requests: RequestInit[] = [];
    const answering = (async (_input: unknown, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    expect(await probeFacebook(answering)).toBe(true);
    expect(requests[0]?.method).toBe("HEAD");
    expect(requests[0]?.credentials).toBe("omit");

    const failing = (async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof fetch;
    expect(await probeFacebook(failing)).toBe(false);
  });
});
