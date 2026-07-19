import { diag } from "../bridge";
import { isMessengerRealtimeUrl, RealtimeHealthWatchdog } from "../lib/realtime-health";

type RealtimeHealthCallbacks = {
  onHealthy: () => void;
  onStale: () => void;
};

export type RealtimeHealthMonitor = {
  check: () => void;
};

const WORKER_HEARTBEAT_TIMEOUT_MS = 8_000;

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
  let workerHeartbeatHealthy = false;
  let workerProbePending = false;

  const checkSockets = () => {
    const health = watchdog.health(Date.now());
    if (health === "stale") callbacks.onStale();
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
        workerHeartbeatHealthy = true;
        callbacks.onHealthy();
      })
      .catch(() => {
        if (workerHeartbeatHealthy) callbacks.onStale();
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
          callbacks.onHealthy();
        });
        socket.addEventListener("message", () => {
          watchdog.received(socket, Date.now());
          callbacks.onHealthy();
        });
        const failed = () => setTimeout(checkSockets, 1000);
        socket.addEventListener("error", failed);
        socket.addEventListener("close", () => {
          watchdog.closed(socket);
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
