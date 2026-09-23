import { diag } from "../bridge";
import {
  ConsecutiveFailureThreshold,
  isMessengerRealtimeUrl,
  REALTIME_CONNECT_GRACE_MS,
  REALTIME_NEVER_CONNECTED_MS,
  type RealtimeHealthSource,
  RealtimeHealthWatchdog,
  WorkerConnectionWatchdog,
} from "../lib/realtime-health";
import { accountScopedStorageKey } from "../lib/threads";
import {
  isMissingWorkerStateRoute,
  observeWorkerConnection,
  type WorkerConnectionState,
} from "../lib/worker-state";

type RealtimeHealthCallbacks = {
  onHealthy: (source: RealtimeHealthSource) => void;
  onStale: (source: RealtimeHealthSource) => void;
  /** The source can no longer observe the transport either way. */
  onUnknown: (source: RealtimeHealthSource) => void;
  /** Give a replacement worker time to answer before recovery can mutate it. */
  onWorkerChanged?: () => void;
};

export type RealtimeHealthMonitor = {
  check: () => void;
  /** Fresh state delivered from the worker, rather than a cached page boolean. */
  isVerifiedHealthy: () => boolean;
};

const WORKER_HEARTBEAT_TIMEOUT_MS = 8_000;
const WORKER_FAILURE_LIMIT = 3;

let verifiedConnection: () => boolean = () => false;
/** Fail closed when Messenger cannot prove its encrypted transport is ready. */
export const scheduledSendConnectionReady = () => navigator.onLine && verifiedConnection();

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

const workerConnectionState = (): WorkerConnectionState | undefined => {
  try {
    const facebookRequire = (window as unknown as { require?: (name: string) => unknown }).require;
    const module = facebookRequire?.("WACommsConnectionState") as
      | { WACommsConnectionState?: WorkerConnectionState }
      | undefined;
    const state = module?.WACommsConnectionState;
    return state && typeof state === "object" ? state : undefined;
  } catch (_) {
    return undefined;
  }
};

const workerIsConnected = (): boolean | undefined => {
  try {
    const connected = workerConnectionState()?.isConnected?.();
    return typeof connected === "boolean" ? connected : undefined;
  } catch (_) {
    return undefined;
  }
};

const workerId = (): unknown => {
  try {
    const page = window as unknown as { require?: (name: string) => unknown };
    const state = page.require?.("MAWWaitForBackendSetup") as
      | { getCurrentWorkerID?: () => unknown }
      | undefined;
    return state?.getCurrentWorkerID?.();
  } catch (_) {
    return undefined;
  }
};

const workerSetupState = (): "ready" | "failed" | "starting" | "unknown" => {
  try {
    const page = window as unknown as { require?: (name: string) => unknown };
    const state = page.require?.("MAWWaitForBackendSetup") as
      | {
          isBackendSetupSettled?: () => unknown;
          isBackendSetupSuccessful?: () => unknown;
          isBackendSetupInProgress?: () => unknown;
        }
      | undefined;
    if (state?.isBackendSetupSettled?.() !== true) {
      return state?.isBackendSetupInProgress?.() === true ? "starting" : "unknown";
    }
    const successful = state.isBackendSetupSuccessful?.();
    return successful === true ? "ready" : successful === false ? "failed" : "unknown";
  } catch (_) {
    return "unknown";
  }
};

/**
 * Observe Messenger's live MQTT transport without reading message contents.
 * Current Messenger keeps sync in a worker, so request its connection-state
 * snapshot and verify that the page receives it. A worker heartbeat alone
 * proves only responsiveness. The WebSocket proxy covers
 * page-owned and fallback transports while preserving the native constructor.
 */
export function monitorRealtimeHealth(callbacks: RealtimeHealthCallbacks): RealtimeHealthMonitor {
  const nativeSetTimeout = setTimeout.bind(globalThis);
  const nativeClearTimeout = clearTimeout.bind(globalThis);
  const watchdog = new RealtimeHealthWatchdog<WebSocket>();
  const workerFailures = new ConsecutiveFailureThreshold(WORKER_FAILURE_LIMIT);
  const accountKey = () => accountScopedStorageKey("carrier-worker-connected", document.cookie);
  const rememberedConnection = (key: string | null) => {
    try {
      return !!key && localStorage.getItem(key) === "1";
    } catch (_) {
      return false;
    }
  };
  let connectionKey = accountKey();
  let connectionWorkerId = workerId();
  let connectionState = workerConnectionState();
  let connectionRemembered = rememberedConnection(connectionKey);
  let workerConnection = new WorkerConnectionWatchdog(connectionRemembered);
  let workerProbePending = false;
  let workerDisconnected = false;
  let setupStartedAt: number | undefined;
  let verificationStartedAt: number | undefined;
  let verified: { at: number; stillCurrent: () => boolean } | undefined;
  let stateRouteUnavailableFor: (() => boolean) | undefined;
  let probeIdentity:
    | { account: string | null; id: unknown; state: WorkerConnectionState | undefined }
    | undefined;
  const now = performance.now.bind(performance);

  const checkSockets = () => {
    const health = watchdog.health(Date.now());
    if (health === "healthy") callbacks.onHealthy("socket");
    else if (health === "stale") callbacks.onStale("socket");
    // "starting" here means the page owns no realtime socket to judge — which
    // is Messenger's steady state once sync moves into its worker. Withdraw
    // any earlier verdict instead of leaving a stale one latched forever.
    else if (health === "starting") callbacks.onUnknown("socket");
    return health;
  };
  const checkWorker = () => {
    const state = workerConnectionState();
    const account = accountKey();
    const id = workerId();
    if (
      !probeIdentity ||
      probeIdentity.account !== account ||
      probeIdentity.id !== id ||
      probeIdentity.state !== state
    ) {
      const replaced = probeIdentity !== undefined;
      probeIdentity = { account, id, state };
      workerFailures.succeeded();
      verified = undefined;
      stateRouteUnavailableFor = undefined;
      // The synchronous recovery tick must not inherit the old worker's verdict,
      // even while that worker's final probe is still pending.
      callbacks.onUnknown("worker");
      if (replaced) callbacks.onWorkerChanged?.();
    }
    if (workerProbePending) return;
    const bridge = facebookBridgeModule();
    if (typeof bridge?.sendAndReceive !== "function") {
      verified = undefined;
      callbacks.onUnknown("worker");
      return;
    }
    const sendAndReceive = bridge.sendAndReceive.bind(bridge);
    const stillCurrent = () =>
      account === accountKey() && state === workerConnectionState() && id === workerId();
    const observation = stateRouteUnavailableFor?.()
      ? undefined
      : observeWorkerConnection(state, now);

    workerProbePending = true;
    let live = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = nativeSetTimeout(
        () => reject(new Error("Messenger worker probe timed out")),
        WORKER_HEARTBEAT_TIMEOUT_MS,
      );
    });
    const request = (route: string) =>
      sendAndReceive("backend", route, undefined, {
        isLoggingDisabled: true,
        timeoutMs: WORKER_HEARTBEAT_TIMEOUT_MS,
      });
    Promise.resolve()
      .then(() => {
        observation?.start();
        const probe = observation
          ? Promise.all([request("resendWorkerStateManagerValuesToMainThread"), observation.value])
              .then(([, connected]) => connected)
              .catch((error: unknown) => {
                if (!live || !stillCurrent() || !isMissingWorkerStateRoute(error)) throw error;
                stateRouteUnavailableFor = stillCurrent;
                observation.dispose();
                // An older worker can still prove responsiveness, but cannot
                // certify fresh encrypted state or replenish repair attempts.
                return request("getWorkerHeartbeat").then(() => undefined);
              })
          : request("getWorkerHeartbeat").then(() => undefined);
        return Promise.race([probe, deadline]);
      })
      .then((connected) => {
        verified = undefined;
        if (!stillCurrent()) {
          callbacks.onUnknown("worker");
          return;
        }
        workerFailures.succeeded();
        if (
          connected === true &&
          account &&
          typeof id === "string" &&
          id.length > 0 &&
          observation?.receivedAt !== undefined
        ) {
          verified = { at: observation.receivedAt, stillCurrent };
        }
        // An older worker may answer the fallback heartbeat without exposing
        // encrypted state. That proves RPC reachability, not transport health.
        if (connected === true) {
          callbacks.onHealthy("worker");
          checkConnection();
        } else callbacks.onUnknown("worker");
      })
      .catch(() => {
        verified = undefined;
        if (!stillCurrent()) callbacks.onUnknown("worker");
        else if (workerFailures.failed()) callbacks.onStale("worker");
      })
      .finally(() => {
        live = false;
        observation?.dispose();
        nativeClearTimeout(timeout);
        workerProbePending = false;
      });
  };
  const checkConnection = () => {
    const currentKey = accountKey();
    const currentWorkerId = workerId();
    const currentState = workerConnectionState();
    const stateChanged = currentState !== undefined && currentState !== connectionState;
    const workerChanged =
      typeof currentWorkerId === "string" &&
      currentWorkerId.length > 0 &&
      currentWorkerId !== connectionWorkerId;
    if (currentKey !== connectionKey || workerChanged || stateChanged) {
      connectionKey = currentKey;
      connectionWorkerId = currentWorkerId;
      connectionState = currentState;
      connectionRemembered = rememberedConnection(connectionKey);
      workerConnection = new WorkerConnectionWatchdog(connectionRemembered);
      workerDisconnected = false;
      setupStartedAt = undefined;
      verificationStartedAt = undefined;
      verified = undefined;
      callbacks.onUnknown("worker-connection");
    }
    const connected = workerIsConnected();
    // Survive reloads and native webview recreation, without letting another
    // account's connection history arm a worker that has never initialized.
    if (connected === true && connectionKey && !connectionRemembered) {
      try {
        localStorage.setItem(connectionKey, "1");
        connectionRemembered = true;
      } catch (_) {}
    }
    const setup = workerSetupState();
    // A confirmed setup attempt must settle even if page MQTT is healthy or
    // the encrypted state/bridge APIs have not become available yet.
    if (setup === "starting") setupStartedAt ??= now();
    else if (setup === "ready" || setup === "failed") setupStartedAt = undefined;
    const setupStale =
      setupStartedAt !== undefined && now() - setupStartedAt >= REALTIME_NEVER_CONNECTED_MS;
    const freshConnected =
      connected === true &&
      verified?.stillCurrent() === true &&
      now() - verified.at < REALTIME_CONNECT_GRACE_MS;
    if (freshConnected) verificationStartedAt = undefined;
    else if (setup === "ready" || connectionRemembered) verificationStartedAt ??= now();
    const verificationStale =
      verificationStartedAt !== undefined &&
      now() - verificationStartedAt >= REALTIME_NEVER_CONNECTED_MS;
    const connectionStale = workerConnection.observe(
      connected === true && !freshConnected ? undefined : connected,
      Date.now(),
      setup === "ready",
    );
    const disconnected = setup === "failed" || setupStale || connectionStale || verificationStale;
    if (disconnected !== workerDisconnected) {
      workerDisconnected = disconnected;
      if (disconnected) {
        diag(
          "sync.worker-disconnected",
          setup === "failed"
            ? "encrypted backend setup failed"
            : setupStale
              ? "encrypted backend setup did not settle"
              : verificationStale
                ? "encrypted connection could not be verified"
                : "encrypted-message connection stayed disconnected",
        );
      }
    }
    if (disconnected) callbacks.onStale("worker-connection");
    else callbacks.onUnknown("worker-connection");
  };
  const check = () => {
    checkConnection();
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
        const failed = () => nativeSetTimeout(checkSockets, 1000);
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

  verifiedConnection = () =>
    verified?.stillCurrent() === true &&
    now() - verified.at < REALTIME_CONNECT_GRACE_MS &&
    workerIsConnected() === true &&
    workerSetupState() === "ready";
  return { check, isVerifiedHealthy: verifiedConnection };
}
