import { diag } from "../bridge";
import {
  ConsecutiveFailureThreshold,
  isMessengerRealtimeUrl,
  type RealtimeHealthSource,
  RealtimeHealthWatchdog,
} from "../lib/realtime-health";

type RealtimeHealthCallbacks = {
  onHealthy: (source: RealtimeHealthSource) => void;
  onStale: (source: RealtimeHealthSource) => void;
};

export type RealtimeHealthMonitor = {
  check: () => void;
};

const WORKER_HEARTBEAT_TIMEOUT_MS = 8_000;
const WORKER_FAILURE_LIMIT = 3;

type FacebookBridgeModule = {
  sendAndReceive?: (
    namespace: string,
    route: string,
    payload?: unknown,
    options?: { isLoggingDisabled?: boolean; timeoutMs?: number },
  ) => Promise<unknown>;
};

const facebookBridgeModule = (): FacebookBridgeModule | null => {
  try {
    const facebookRequire = (window as unknown as { require?: (name: string) => unknown }).require;
    const module = facebookRequire?.("MAWBridgeSendAndReceive");
    return module && typeof module === "object" ? (module as FacebookBridgeModule) : null;
  } catch (_) {
    return null;
  }
};

/**
 * Observe Messenger's live MQTT transport without reading or modifying any
 * payloads. Current Messenger keeps sync in a worker, so prefer its own
 * content-free heartbeat bridge. The WebSocket proxy covers page-owned and
 * fallback transports while preserving the native constructor.
 */
export function monitorRealtimeHealth(callbacks: RealtimeHealthCallbacks): RealtimeHealthMonitor {
  const watchdog = new RealtimeHealthWatchdog<WebSocket>();
  const workerFailures = new ConsecutiveFailureThreshold(WORKER_FAILURE_LIMIT);
  let workerProbePending = false;

  const checkSockets = () => {
    const health = watchdog.health(Date.now());
    if (health === "healthy") callbacks.onHealthy("socket");
    if (health === "stale") callbacks.onStale("socket");
    return health;
  };
  const checkWorker = () => {
    if (workerProbePending) return;
    const bridge = facebookBridgeModule();
    if (!bridge?.sendAndReceive) return;
    const sendAndReceive = bridge.sendAndReceive.bind(bridge);

    workerProbePending = true;
    let timeout: number | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Messenger worker heartbeat timed out")),
        WORKER_HEARTBEAT_TIMEOUT_MS,
      );
    });
    Promise.resolve()
      .then(() =>
        Promise.race([
          sendAndReceive("backend", "getWorkerHeartbeat", undefined, {
            isLoggingDisabled: true,
            timeoutMs: WORKER_HEARTBEAT_TIMEOUT_MS,
          }),
          deadline,
        ]),
      )
      .then(() => {
        workerFailures.succeeded();
        callbacks.onHealthy("worker");
      })
      .catch(() => {
        if (workerFailures.failed()) callbacks.onStale("worker");
      })
      .finally(() => {
        clearTimeout(timeout);
        workerProbePending = false;
      });
  };
  const check = () => {
    checkSockets();
    checkWorker();
  };

  try {
    const NativeWebSocket = window.WebSocket;
    const WrappedWebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        const rawUrl = args[0];
        if (!isMessengerRealtimeUrl(String(rawUrl || ""), location.href)) return socket;

        watchdog.created(socket, Date.now());
        socket.addEventListener("open", () => {
          watchdog.opened(socket, Date.now());
          callbacks.onHealthy("socket");
        });
        socket.addEventListener("message", () => {
          watchdog.received(socket, Date.now());
          callbacks.onHealthy("socket");
        });
        const failed = () => setTimeout(checkSockets, 1000);
        socket.addEventListener("error", failed);
        socket.addEventListener("close", () => {
          watchdog.closed(socket, Date.now());
          failed();
        });
        return socket;
      },
    });
    Object.defineProperty(window, "WebSocket", {
      value: WrappedWebSocket,
      writable: true,
      configurable: true,
    });
  } catch (_) {
    diag("sync.monitor", "could not observe Messenger realtime WebSockets");
  }

  return { check };
}
