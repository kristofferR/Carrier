import { beforeAll, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { monitorRealtimeHealth } from "../features/realtime-health";
import { REALTIME_CONNECT_GRACE_MS, RealtimeRecoveryTracker } from "./realtime-health";

let source: string;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { monitorRealtimeHealth } from "../features/realtime-health";
        globalThis.monitor = monitorRealtimeHealth;`,
      resolveDir: import.meta.dir,
    },
    bundle: true,
    write: false,
  });
  source = bundle.outputFiles[0]!.text;
});

test("successful worker probes cannot cancel recovery for a disconnected encrypted transport", async () => {
  let now = 100_000;
  let connected: unknown = true;
  let probes = 0;
  let moduleAvailable = true;
  const tracker = new RealtimeRecoveryTracker(now);
  class Socket extends EventTarget {}
  const window = {
    WebSocket: Socket,
    require(name: string) {
      if (name === "WACommsConnectionState") {
        if (!moduleAvailable) throw new Error("module unavailable");
        return { WACommsConnectionState: { isConnected: () => connected } };
      }
      if (name === "MAWBridgeSendAndReceive") {
        return {
          sendAndReceive: async () => {
            probes += 1;
            return true;
          },
        };
      }
      throw new Error("unexpected module");
    },
  };
  const context: { monitor?: typeof monitorRealtimeHealth } = {};
  runInNewContext(source, {
    ...context,
    window,
    location: { href: "https://www.facebook.com/messages/" },
    URL,
    Date: { now: () => now },
    setTimeout,
    clearTimeout,
    globalThis: context,
  });
  const monitor = context.monitor!({
    onHealthy: (source) => tracker.healthy(source, now),
    onStale: (source) => tracker.stale(source),
    onUnknown: (source) => tracker.withdraw(source),
  });
  const socket = Reflect.construct(window.WebSocket, [
    "wss://edge-chat.facebook.com/chat",
  ]) as Socket;
  socket.dispatchEvent(new Event("open"));
  const check = async () => {
    socket.dispatchEvent(new Event("message"));
    monitor.check();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await check();
  expect(tracker.status(now)).toBe("ok");
  connected = false;
  await check();
  now += REALTIME_CONNECT_GRACE_MS - 1;
  await check();
  expect(tracker.needsRecovery(now)).toBe(false);
  now += 1;
  await check();
  expect(probes).toBe(4);
  expect(tracker.status(now)).toBe("stale");
  connected = true;
  await check();
  expect(tracker.status(now)).toBe("ok");
  connected = false;
  await check();
  now += REALTIME_CONNECT_GRACE_MS;
  await check();
  expect(tracker.status(now)).toBe("stale");
  // Missing or changed internal APIs must fall back to existing health probes.
  moduleAvailable = false;
  await check();
  expect(tracker.status(now)).toBe("ok");
  moduleAvailable = true;
  connected = "false";
  now += REALTIME_CONNECT_GRACE_MS;
  await check();
  expect(tracker.status(now)).toBe("ok");
  connected = true;
  await check();
  expect(tracker.status(now)).toBe("ok");
});
