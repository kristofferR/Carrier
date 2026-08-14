/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/messenger/ (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // inject/src/messenger/lib/downloads.ts
  var filenameFromUrl = (u, base) => {
    try {
      const p = new URL(u, base).pathname.split("/").pop();
      return p?.includes(".") ? decodeURIComponent(p) : "";
    } catch {
      return "";
    }
  };
  var GENERIC_DOWNLOAD_STEMS = /* @__PURE__ */ new Set(["download", "image", "video"]);
  var splitDownloadName = (name) => {
    const file = String(name || "").trim().split(/[\\/]/).pop() || "";
    const dot = file.lastIndexOf(".");
    if (dot > 0 && dot < file.length - 1) {
      return { stem: file.slice(0, dot), ext: file.slice(dot) };
    }
    return { stem: file, ext: "" };
  };
  var friendlyDownloadName = (name) => {
    const { stem, ext } = splitDownloadName(name);
    if (!stem || GENERIC_DOWNLOAD_STEMS.has(stem.toLowerCase())) {
      return `Messenger${ext}`;
    }
    return name;
  };
  var downloadRevealLabel = (userAgent) => /Mac/i.test(userAgent) ? "Show in Finder" : "Show in folder";

  // inject/src/messenger/lib/links.ts
  var INTERNAL_HOSTS = [
    "facebook.com",
    "messenger.com",
    "fbcdn.net",
    "fbsbx.com",
    "meta.com",
    "oculus.com"
  ];
  var AUTH_HOSTS = ["accounts.google.com", "login.microsoftonline.com", "appleid.apple.com"];
  var FACEBOOK_TRACKING_PARAMS = /* @__PURE__ */ new Set([
    "fbclid",
    "mibextid",
    "fb_action_ids",
    "fb_action_types",
    "fb_ref",
    "fb_source"
  ]);
  function isAuth(u) {
    const host = u.hostname.toLowerCase();
    return AUTH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  }
  function facebookRedirectTarget(url) {
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const isRedirect = (host === "l.facebook.com" || host === "lm.facebook.com" || host === "facebook.com") && url.pathname === "/l.php";
    if (!isRedirect) return null;
    const target = url.searchParams.get("u");
    if (!target) return null;
    try {
      return /^https?:$/.test(new URL(target).protocol) ? target : null;
    } catch {
      return null;
    }
  }
  function trackingKey(rawPair) {
    const rawKey = rawPair.split("=", 1)[0] ?? "";
    try {
      return decodeURIComponent(rawKey.replace(/\+/g, " ")).toLowerCase();
    } catch {
      return null;
    }
  }
  function stripRawFacebookParams(href) {
    const hashAt = href.indexOf("#");
    const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
    const hash = hashAt < 0 ? "" : href.slice(hashAt);
    const queryAt = beforeHash.indexOf("?");
    if (queryAt < 0) return { href, removed: false };
    const prefix = beforeHash.slice(0, queryAt);
    const pairs = beforeHash.slice(queryAt + 1).split("&");
    const kept = pairs.filter((pair) => {
      const key = trackingKey(pair);
      return !key || !FACEBOOK_TRACKING_PARAMS.has(key);
    });
    if (kept.length === pairs.length) return { href, removed: false };
    return {
      href: `${prefix}${kept.length ? `?${kept.join("&")}` : ""}${hash}`,
      removed: true
    };
  }
  function stripFacebookTracking(href, base) {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return href;
    }
    if (!/^https?:$/.test(url.protocol)) return href;
    const seen = /* @__PURE__ */ new Set();
    let unwrapped = false;
    for (let depth = 0; depth < 4; depth++) {
      const target = facebookRedirectTarget(url);
      if (!target || seen.has(target)) break;
      seen.add(target);
      url = new URL(target);
      unwrapped = true;
    }
    const cleaned = stripRawFacebookParams(url.href);
    return unwrapped || cleaned.removed ? cleaned.href : href;
  }
  var FACEBOOK_APP_PATH_RE = /^\/(messages|messenger_media|t|login(\.php)?|checkpoint|two_step_verification|two_factor|recover|reg|r\.php)(\/|$)/;
  function classifyHref(href, base) {
    try {
      const u = new URL(href, base);
      if (u.protocol === "mailto:" || u.protocol === "tel:") return { external: true };
      if (!/^https?:$/.test(u.protocol)) return { external: false };
      if (isAuth(u)) return { external: false };
      const host = u.hostname.replace(/^www\./, "");
      const tracking = host === "l.facebook.com" || host === "lm.facebook.com" || host === "facebook.com" && u.pathname === "/l.php";
      const internal = INTERNAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
      const isFacebook = host === "facebook.com" || host.endsWith(".facebook.com");
      const inApp = isFacebook ? FACEBOOK_APP_PATH_RE.test(u.pathname) : internal;
      return { external: tracking || !inApp };
    } catch {
      return { external: false };
    }
  }

  // inject/src/messenger/bridge.ts
  var invoke = (cmd, args) => window.__TAURI_INTERNALS__?.invoke(cmd, args);
  var toast = (msg, action) => window.__carrierToast ? window.__carrierToast(msg, action) : console.log("[carrier]", msg);
  var diag = /* @__PURE__ */ (() => {
    const RATE_MS = 6e4;
    const lastSent = /* @__PURE__ */ new Map();
    return (key, msg) => {
      try {
        const now = Date.now();
        if (now - (lastSent.get(key) || 0) < RATE_MS) return;
        lastSent.set(key, now);
        try {
          if (localStorage.__carrier_debug === "1") console.warn(`[carrier] ${key}: ${msg}`);
        } catch (_) {
        }
        invoke("plugin:event|emit", {
          event: "carrier:diag",
          payload: { key: String(key), msg: String(msg) }
        })?.catch?.(() => {
        });
      } catch (_) {
      }
    };
  })();
  var cleanSharedUrl = (url) => window.__CARRIER_SETTINGS__?.strip_link_tracking === false ? url : stripFacebookTracking(url, location.href);
  var openUrl = (url) => invoke("plugin:opener|open_url", { url: cleanSharedUrl(url), with: null })?.catch?.(
    () => diag("ipc.open-url", "opener invoke failed")
  );
  var toastDownloadSaved = (url) => toast("Saved to Downloads", {
    label: downloadRevealLabel(navigator.userAgent),
    kind: "reveal-download",
    url
  });

  // inject/src/messenger/lib/auto-refresh.ts
  var PERIODIC_REFRESH_MS = 15 * 60 * 1e3;
  var NOTIFICATION_REFRESH_GAP_MS = 5 * 60 * 1e3;
  var RESUME_GAP_MS = 2e4;
  var elapsed = (now, since) => Math.max(0, now - since);
  var AutoRefreshWatchdog = class {
    constructor(now, active) {
      __publicField(this, "inactiveSince");
      __publicField(this, "lastHeartbeatAt");
      __publicField(this, "lastFreshAt");
      this.lastFreshAt = now;
      this.lastHeartbeatAt = now;
      this.inactiveSince = active ? null : now;
    }
    setActive(active, now) {
      if (!active) {
        this.inactiveSince ?? (this.inactiveSince = now);
        return null;
      }
      const inactiveFor = this.inactiveSince === null ? 0 : elapsed(now, this.inactiveSince);
      this.inactiveSince = null;
      this.lastFreshAt = Math.max(this.lastFreshAt, now);
      return inactiveFor >= PERIODIC_REFRESH_MS ? "foreground" : null;
    }
    heartbeat(active, now) {
      const heartbeatGap = elapsed(now, this.lastHeartbeatAt);
      this.lastHeartbeatAt = Math.max(this.lastHeartbeatAt, now);
      const transition = this.setActive(active, now);
      if (heartbeatGap >= RESUME_GAP_MS) return "resume";
      if (transition) return transition;
      if (!active && this.inactiveSince !== null && elapsed(now, this.inactiveSince) >= PERIODIC_REFRESH_MS) {
        return "background";
      }
      return null;
    }
    canRefreshFromNotification(now) {
      return elapsed(now, this.lastFreshAt) >= NOTIFICATION_REFRESH_GAP_MS;
    }
  };

  // inject/src/messenger/lib/realtime-health.ts
  var REALTIME_CONNECT_GRACE_MS = 15e3;
  var REALTIME_SILENCE_MS = 9e4;
  var REALTIME_NEVER_CONNECTED_MS = 9e4;
  var REALTIME_CORROBORATION_MS = 3e4;
  var REALTIME_UNOBSERVED_MS = 6e4;
  var REALTIME_UNOBSERVED_SETTLE_MS = 15e3;
  function looksLikeFacebookErrorPage(doc) {
    return doc.hasBackLink && doc.hasIconImage && doc.elementCount < 100;
  }
  var elapsed2 = (now, since) => Math.max(0, now - since);
  var ConsecutiveFailureThreshold = class {
    constructor(limit) {
      __publicField(this, "limit", limit);
      __publicField(this, "failures", 0);
    }
    succeeded() {
      this.failures = 0;
    }
    failed() {
      this.failures += 1;
      return this.failures >= this.limit;
    }
  };
  var RealtimeRecoveryTracker = class {
    constructor(startedAt) {
      __publicField(this, "startedAt", startedAt);
      __publicField(this, "staleSources", /* @__PURE__ */ new Set());
      __publicField(this, "lastHealthyAt", /* @__PURE__ */ new Map());
      __publicField(this, "everHealthy", false);
    }
    healthy(source, at = Date.now()) {
      this.everHealthy = true;
      this.lastHealthyAt.set(source, at);
      this.staleSources.delete(source);
    }
    stale(source) {
      this.staleSources.add(source);
    }
    /**
     * Withdraw a source's verdict without claiming health — it can no longer
     * observe the transport at all (e.g. the page owns no realtime socket). An
     * unobservable source must not keep asserting the staleness it reported
     * while it could still see something.
     */
    withdraw(source) {
      this.staleSources.delete(source);
    }
    /**
     * Recovery is only warranted when no source can still vouch for the
     * transport. A recently healthy source proves messages are flowing, so a
     * different source's staleness must not force a reload on its own — a dead
     * page socket alongside a responsive worker is the normal shape of current
     * Messenger, not a fault.
     */
    needsRecovery(now = Date.now()) {
      for (const [source, at] of this.lastHealthyAt) {
        if (at > now) this.lastHealthyAt.set(source, now);
      }
      if (this.staleSources.size === 0) return this.unobserved(now);
      for (const [source, at] of this.lastHealthyAt) {
        if (this.staleSources.has(source)) continue;
        if (elapsed2(now, at) <= REALTIME_CORROBORATION_MS) return false;
      }
      return true;
    }
    /**
     * A transport that was healthy but that no source has been able to confirm
     * for [[REALTIME_UNOBSERVED_MS]]. Not knowing is not the same as being fine,
     * so this still warrants recovery. A page that never connected at all is
     * excluded — [[status]] already reports that as "never".
     *
     * Callers must rebase future-dated reports first (see [[needsRecovery]]).
     */
    unobserved(now) {
      if (!this.everHealthy) return false;
      let lastConfirmedAt = null;
      for (const at of this.lastHealthyAt.values()) {
        if (lastConfirmedAt === null || at > lastConfirmedAt) lastConfirmedAt = at;
      }
      if (lastConfirmedAt === null) return false;
      return elapsed2(now, lastConfirmedAt) >= REALTIME_UNOBSERVED_MS;
    }
    // "pending" (fresh page, transport still unproven) deliberately differs from
    // "ok": the native side pauses its bad-transport timer on both, but only a
    // proven-healthy "ok" resets its escalation counters.
    status(now) {
      if (this.needsRecovery(now)) return "stale";
      if (this.everHealthy) return "ok";
      return elapsed2(now, this.startedAt) >= REALTIME_NEVER_CONNECTED_MS ? "never" : "pending";
    }
  };
  function isMessengerRealtimeUrl(raw, base) {
    let url;
    try {
      url = new URL(raw, base);
    } catch (_) {
      return false;
    }
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return false;
    const host = url.hostname.toLowerCase();
    return host === "edge-chat.facebook.com" || host.endsWith(".edge-chat.facebook.com") || host === "gateway.facebook.com" || host.endsWith(".gateway.facebook.com") || host === "gateway.messenger.com";
  }
  var RealtimeHealthWatchdog = class {
    constructor() {
      __publicField(this, "sockets", /* @__PURE__ */ new Map());
      __publicField(this, "everOpened", false);
      __publicField(this, "recoveryStartedAt", null);
    }
    created(socket, now) {
      if (this.everOpened && !this.hasOpenSocket()) this.recoveryStartedAt ?? (this.recoveryStartedAt = now);
      this.sockets.set(socket, { state: "connecting", since: now, lastInboundAt: now });
    }
    opened(socket, now) {
      if (!this.sockets.has(socket)) return;
      this.everOpened = true;
      this.recoveryStartedAt = null;
      this.sockets.set(socket, { state: "open", since: now, lastInboundAt: now });
    }
    received(socket, now) {
      const state = this.sockets.get(socket);
      if (state?.state !== "open") return;
      state.lastInboundAt = now;
    }
    closed(socket, now) {
      this.sockets.delete(socket);
      if (this.everOpened && !this.hasOpenSocket()) this.recoveryStartedAt ?? (this.recoveryStartedAt = now);
    }
    hasOpenSocket() {
      return [...this.sockets.values()].some((state) => state.state === "open");
    }
    health(now) {
      const states = [...this.sockets.values()];
      const open = states.filter((state) => state.state === "open");
      if (open.length) {
        const freshestInbound = Math.max(...open.map((state) => state.lastInboundAt));
        return elapsed2(now, freshestInbound) >= REALTIME_SILENCE_MS ? "stale" : "healthy";
      }
      const connecting = states.filter((state) => state.state === "connecting");
      if (!this.everOpened) return "starting";
      if (this.recoveryStartedAt !== null && elapsed2(now, this.recoveryStartedAt) < REALTIME_CONNECT_GRACE_MS) {
        return "recovering";
      }
      if (connecting.length) return "stale";
      this.recoveryStartedAt = null;
      return "starting";
    }
  };

  // inject/src/messenger/lib/threads.ts
  function threadIdFromHref(href) {
    const m = (href || "").match(/\/t\/(\d+)/);
    return m ? m[1] : null;
  }
  function threadPathId(href) {
    const m = String(href || "").match(/^\/t\/(\d+)\/?$/);
    return m ? m[1] : null;
  }
  function isMessengerContentPath(pathname) {
    const path = String(pathname || "");
    return path === "/messages" || path.startsWith("/messages/") || threadPathId(path) !== null;
  }
  var SEPARATOR_RE = /^[·•.,\s]+$/;

  // inject/src/messenger/features/realtime-health.ts
  var WORKER_HEARTBEAT_TIMEOUT_MS = 8e3;
  var WORKER_FAILURE_LIMIT = 3;
  var facebookBridgeModule = () => {
    try {
      const facebookRequire = window.require;
      const module = facebookRequire?.("MAWBridgeSendAndReceive");
      return module && typeof module === "object" ? module : null;
    } catch (_) {
      return null;
    }
  };
  function monitorRealtimeHealth(callbacks) {
    const watchdog = new RealtimeHealthWatchdog();
    const workerFailures = new ConsecutiveFailureThreshold(WORKER_FAILURE_LIMIT);
    let workerProbePending = false;
    const checkSockets = () => {
      const health = watchdog.health(Date.now());
      if (health === "healthy") callbacks.onHealthy("socket");
      else if (health === "stale") callbacks.onStale("socket");
      else if (health === "starting") callbacks.onUnknown("socket");
      return health;
    };
    const checkWorker = () => {
      if (workerProbePending) return;
      const bridge = facebookBridgeModule();
      if (!bridge?.sendAndReceive) return;
      const sendAndReceive = bridge.sendAndReceive.bind(bridge);
      workerProbePending = true;
      let timeout;
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Messenger worker heartbeat timed out")),
          WORKER_HEARTBEAT_TIMEOUT_MS
        );
      });
      Promise.resolve().then(
        () => Promise.race([
          sendAndReceive("backend", "getWorkerHeartbeat", void 0, {
            isLoggingDisabled: true,
            timeoutMs: WORKER_HEARTBEAT_TIMEOUT_MS
          }),
          deadline
        ])
      ).then(() => {
        workerFailures.succeeded();
        callbacks.onHealthy("worker");
      }).catch(() => {
        if (workerFailures.failed()) callbacks.onStale("worker");
      }).finally(() => {
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
          const socket = Reflect.construct(target, args, newTarget);
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
          const failed = () => setTimeout(checkSockets, 1e3);
          socket.addEventListener("error", failed);
          socket.addEventListener("close", () => {
            watchdog.closed(socket, Date.now());
            failed();
          });
          return socket;
        }
      });
      Object.defineProperty(window, "WebSocket", {
        value: WrappedWebSocket,
        writable: true,
        configurable: true
      });
    } catch (_) {
      diag("sync.monitor", "could not observe Messenger realtime WebSockets");
    }
    return { check };
  }

  // inject/src/messenger/features/auto-refresh.ts
  function initAutoRefresh() {
    const pageIsActive = () => !document.hidden && document.hasFocus();
    const watchdog = new AutoRefreshWatchdog(Date.now(), pageIsActive());
    let pending = false;
    let reloadWhileActive = false;
    let pendingReason = "background";
    let timer;
    const RECOVERY_MIN_GAP_MS = 6e4;
    const RECOVERY_STORAGE_KEY = "carrier-sync-recovery-at";
    const clearPending = () => {
      pending = false;
      reloadWhileActive = false;
      clearTimeout(timer);
      timer = void 0;
    };
    const composerHasText = () => {
      try {
        for (const el of document.querySelectorAll('[contenteditable="true"]')) {
          if ((el.textContent || "").trim().length > 0) return true;
        }
      } catch (_) {
      }
      return false;
    };
    const heartbeatId = window.__CARRIER_HEARTBEAT_ID__;
    try {
      delete window.__CARRIER_HEARTBEAT_ID__;
    } catch (_) {
      window.__CARRIER_HEARTBEAT_ID__ = void 0;
    }
    let lastHeartbeatProtection;
    const heartbeatProtection = () => composerHasText() || !!window.__carrierInCall;
    const realtimeRecovery = new RealtimeRecoveryTracker(Date.now());
    const onFacebookErrorPage = () => {
      try {
        return looksLikeFacebookErrorPage({
          hasBackLink: !!document.getElementById("back"),
          hasIconImage: document.getElementById("icon") instanceof HTMLImageElement,
          elementCount: document.getElementsByTagName("*").length
        });
      } catch (_) {
        return false;
      }
    };
    const realtimeStatus = () => {
      if (!isMessengerContentPath(location.pathname)) return "pending";
      if (onFacebookErrorPage()) return "error";
      return realtimeRecovery.status(Date.now());
    };
    const messengerContentPresent = () => {
      if (!isMessengerContentPath(location.pathname)) return true;
      const candidates = document.querySelectorAll(
        'a[href], button, input, textarea, [contenteditable="true"], [role="navigation"], [role="main"]'
      );
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
          continue;
        }
        let current = el;
        let hidden = false;
        while (current) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || Number(style.opacity) <= 0) {
            hidden = true;
            break;
          }
          current = current.parentElement;
        }
        if (!hidden) return true;
      }
      return false;
    };
    const emitHeartbeat = () => {
      if (typeof heartbeatId !== "number") return;
      const protectedNow = heartbeatProtection();
      lastHeartbeatProtection = protectedNow;
      invoke("plugin:event|emit", {
        event: "carrier:webview-heartbeat",
        payload: {
          id: heartbeatId,
          protected: protectedNow,
          content_present: messengerContentPresent(),
          realtime: realtimeStatus()
        }
      })?.catch?.(() => {
      });
    };
    const emitProtectionChange = () => {
      if (heartbeatProtection() !== lastHeartbeatProtection) emitHeartbeat();
    };
    window.__carrierHeartbeat = (expectedId) => {
      if (expectedId === heartbeatId) emitHeartbeat();
    };
    window.addEventListener("input", emitProtectionChange, true);
    window.addEventListener("carrier:protection-change", emitProtectionChange);
    emitHeartbeat();
    const maybeReload = () => {
      timer = void 0;
      if (!pending) return;
      if (pageIsActive() && !reloadWhileActive) {
        clearPending();
        return;
      }
      if (composerHasText() || window.__carrierInCall) {
        timer = setTimeout(maybeReload, 8e3);
        return;
      }
      if (!navigator.onLine) {
        timer = setTimeout(maybeReload, 8e3);
        return;
      }
      if (pendingReason === "realtime" && !realtimeRecovery.needsRecovery(Date.now())) {
        clearPending();
        return;
      }
      if (pendingReason !== "background") {
        diag("sync.refresh", `reloading stale Messenger view after ${pendingReason}`);
      }
      if (pendingReason === "realtime") {
        try {
          sessionStorage.setItem(RECOVERY_STORAGE_KEY, String(Date.now()));
        } catch (_) {
        }
      }
      pending = false;
      location.reload();
    };
    const schedule = (delay, reason, allowWhileActive = false) => {
      if (pageIsActive() && !allowWhileActive) {
        return;
      }
      pending = true;
      reloadWhileActive || (reloadWhileActive = allowWhileActive);
      pendingReason = reason;
      clearTimeout(timer);
      timer = setTimeout(maybeReload, delay);
    };
    const realtimeRecoveryDelay = () => {
      try {
        const lastRecoveryAt = Number(sessionStorage.getItem(RECOVERY_STORAGE_KEY)) || 0;
        return Math.max(1e3, RECOVERY_MIN_GAP_MS - Math.max(0, Date.now() - lastRecoveryAt));
      } catch (_) {
        return 1e3;
      }
    };
    const clearRealtimeRecoveryIfSettled = () => {
      if (pending && pendingReason === "realtime" && !realtimeRecovery.needsRecovery(Date.now())) {
        clearPending();
      }
    };
    const realtime = monitorRealtimeHealth({
      onHealthy: (source) => {
        realtimeRecovery.healthy(source, Date.now());
        clearRealtimeRecoveryIfSettled();
      },
      onStale: (source) => {
        realtimeRecovery.stale(source);
        if (!realtimeRecovery.needsRecovery(Date.now())) return;
        schedule(realtimeRecoveryDelay(), "realtime", true);
      },
      onUnknown: (source) => {
        realtimeRecovery.withdraw(source);
        clearRealtimeRecoveryIfSettled();
      }
    });
    const noteLifecycle = () => {
      const reason = watchdog.setActive(pageIsActive(), Date.now());
      if (reason) {
        schedule(1e3, reason, true);
      } else if (pageIsActive() && !reloadWhileActive) {
        clearPending();
      }
    };
    window.addEventListener("focus", noteLifecycle);
    window.addEventListener("blur", noteLifecycle);
    document.addEventListener("visibilitychange", noteLifecycle);
    window.addEventListener("online", () => schedule(1e3, "online", true));
    window.__carrierOnNotification = () => {
      if (!pageIsActive() && watchdog.canRefreshFromNotification(Date.now())) {
        schedule(4e3, "background");
      }
    };
    setInterval(() => {
      realtime.check();
      if (realtimeRecovery.needsRecovery(Date.now()) && !pending) {
        schedule(Math.max(realtimeRecoveryDelay(), REALTIME_UNOBSERVED_SETTLE_MS), "realtime", true);
      }
      emitHeartbeat();
      const reason = watchdog.heartbeat(pageIsActive(), Date.now());
      if (reason) {
        schedule(reason === "background" ? 2e3 : 1e3, reason, reason !== "background");
      }
    }, 5e3);
  }

  // inject/src/messenger/lib/composer-keys.ts
  function shouldKeepEnterInComposer(state) {
    if (state.key !== "Enter") return false;
    if (state.isComposing || state.compositionActive || state.keyCode === 229) return true;
    return state.requireAccelerator && !state.acceleratorPressed && !state.shiftKey;
  }

  // inject/src/messenger/features/composer-keys.ts
  var isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  var composerSelector = '[contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"], textarea';
  function isComposerTarget(target) {
    if (!(target instanceof Element)) return false;
    const editor = target.closest(composerSelector);
    return !!editor?.closest('[role="main"]');
  }
  function initComposerKeys() {
    let compositionActive = false;
    document.addEventListener(
      "compositionstart",
      (event) => {
        if (isComposerTarget(event.target)) compositionActive = true;
      },
      true
    );
    document.addEventListener(
      "compositionend",
      () => {
        compositionActive = false;
      },
      true
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (!isComposerTarget(event.target)) return;
        if (!shouldKeepEnterInComposer({
          key: event.key,
          isComposing: event.isComposing,
          compositionActive,
          keyCode: event.keyCode,
          requireAccelerator: window.__CARRIER_SETTINGS__?.send_with_accelerator === true,
          acceleratorPressed: isMac ? event.metaKey : event.ctrlKey,
          shiftKey: event.shiftKey
        }))
          return;
        event.stopImmediatePropagation();
      },
      true
    );
  }

  // inject/src/messenger/lib/download-completion.ts
  var DOWNLOAD_FINISHED_EVENT = "carrier:download-finished";
  var NativePromise = Promise;
  var nativePromiseThen = Promise.prototype.then;
  var nativeReflectApply = Reflect.apply;
  var nativeAddEventListener = EventTarget.prototype.addEventListener;
  var nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
  var nativeSetTimeout = globalThis.setTimeout;
  var nativeClearTimeout = globalThis.clearTimeout;
  function detailFor(event) {
    const detail = event.detail;
    if (!detail || typeof detail !== "object") return null;
    const candidate = detail;
    if (typeof candidate.id !== "string" || typeof candidate.url !== "string" || typeof candidate.success !== "boolean" || typeof candidate.signature !== "string")
      return null;
    return {
      id: candidate.id,
      url: candidate.url,
      success: candidate.success,
      signature: candidate.signature
    };
  }
  function waitForNativeDownload(target, expectedUrl, verifyResult, timeoutMs = 12e4) {
    return new NativePromise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        nativeReflectApply(nativeClearTimeout, globalThis, [timer]);
        nativeReflectApply(nativeRemoveEventListener, target, [DOWNLOAD_FINISHED_EVENT, onFinished]);
      };
      const onFinished = (event) => {
        const detail = detailFor(event);
        if (!detail || detail.url !== expectedUrl) return;
        if (!verifyResult) {
          cleanup();
          reject(new Error("native download bridge unavailable"));
          return;
        }
        const verification = verifyResult(
          DOWNLOAD_FINISHED_EVENT,
          { id: detail.id, url: detail.url, success: detail.success },
          detail.signature
        );
        nativeReflectApply(nativePromiseThen, verification, [
          (authenticated) => {
            if (!authenticated) return;
            cleanup();
            if (detail.success) resolve({ id: detail.id, url: detail.url });
            else reject(new Error("native download failed"));
          },
          () => {
          }
        ]);
      };
      nativeReflectApply(nativeAddEventListener, target, [DOWNLOAD_FINISHED_EVENT, onFinished]);
      timer = nativeReflectApply(nativeSetTimeout, globalThis, [
        () => {
          cleanup();
          reject(new Error("native download timed out"));
        },
        timeoutMs
      ]);
    });
  }

  // inject/src/messenger/lib/menu-integrity.ts
  var RECT_TOLERANCE = 1;
  var nativeAbs = Math.abs;
  var nativeCharCodeAt = String.prototype.charCodeAt;
  var nativeFromCharCode = String.fromCharCode;
  var nativeReflectApply2 = Reflect.apply;
  function cssPropertyName(property) {
    let result = "";
    for (let index = 0; index < property.length; index += 1) {
      const code = nativeReflectApply2(nativeCharCodeAt, property, [index]);
      result += code >= 65 && code <= 90 ? `-${nativeReflectApply2(nativeFromCharCode, void 0, [code + 32])}` : property[index] ?? "";
    }
    return result;
  }
  function rectsMatch(a, b, tolerance = RECT_TOLERANCE) {
    return nativeAbs(a.x - b.x) <= tolerance && nativeAbs(a.y - b.y) <= tolerance && nativeAbs(a.width - b.width) <= tolerance && nativeAbs(a.height - b.height) <= tolerance;
  }
  function pointInRect(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }
  function pointerActivationIsSound(expected, current, x, y) {
    return rectsMatch(expected, current) && pointInRect(current, x, y);
  }

  // inject/src/messenger/features/context-menu.ts
  var MAX_BLOB = 512 * 1024 * 1024;
  var MAX_CLIPBOARD_IMAGE = 16 * 1024 * 1024;
  var MAX_NATIVE_CONTEXT_VALUE = 64 * 1024;
  var IMAGE_CONTEXT_MENU_LABELS = [
    "Copy image",
    "Download image",
    "Share…",
    "Copy image address",
    "Open image in browser"
  ];
  var VIDEO_CONTEXT_MENU_LABELS = ["Download video", "Share…", "Copy video address"];
  var LINK_CONTEXT_MENU_LABELS = ["Copy link address", "Open link in browser"];
  var nativeAddEventListener2 = EventTarget.prototype.addEventListener;
  var nativeRemoveEventListener2 = EventTarget.prototype.removeEventListener;
  var nativeObjectDefineProperty = Object.defineProperty;
  var nativeObjectEntries = Object.entries;
  var nativeReflectApply3 = Reflect.apply;
  var nativeSetStyleProperty = CSSStyleDeclaration.prototype.setProperty;
  var nativeSetTimeout2 = window.setTimeout;
  var nativeAttachShadow = Element.prototype.attachShadow;
  var nativeAppendChild = Node.prototype.appendChild;
  var nativeContains = Node.prototype.contains;
  var nativeCreateElement = Document.prototype.createElement;
  var nativeFocus = HTMLElement.prototype.focus;
  var nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  var nativeGetEventTarget = Object.getOwnPropertyDescriptor(Event.prototype, "target")?.get;
  var nativeGetMouseClientX = Object.getOwnPropertyDescriptor(MouseEvent.prototype, "clientX")?.get;
  var nativeGetMouseClientY = Object.getOwnPropertyDescriptor(MouseEvent.prototype, "clientY")?.get;
  var nativePreventDefault = Event.prototype.preventDefault;
  var nativeRemove = Element.prototype.remove;
  var nativeStopPropagation = Event.prototype.stopPropagation;
  var nativeGetRectX = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "x")?.get;
  var nativeGetRectY = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "y")?.get;
  var nativeGetRectWidth = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "width")?.get;
  var nativeGetRectHeight = Object.getOwnPropertyDescriptor(
    DOMRectReadOnly.prototype,
    "height"
  )?.get;
  var nativeGetKeyboardKey = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "key")?.get;
  var nativeGetStyle = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "style")?.get;
  var nativeSetAttribute = Element.prototype.setAttribute;
  var nativeSetTextContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")?.set;
  var nativeSetTabIndex = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "tabIndex")?.set;
  var NativePromise2 = Promise;
  var NativeFileReader = FileReader;
  var nativeReadAsDataURL = FileReader.prototype.readAsDataURL;
  var nativeGetFileReaderResult = Object.getOwnPropertyDescriptor(
    FileReader.prototype,
    "result"
  )?.get;
  var NativeUint8Array = Uint8Array;
  var nativeGetRandomValues = crypto.getRandomValues.bind(crypto);
  var nativeShowContextMenu = typeof carrierShowContextMenu === "function" ? carrierShowContextMenu : void 0;
  var appendOwn = (items, item) => {
    nativeReflectApply3(nativeObjectDefineProperty, void 0, [
      items,
      `${items.length}`,
      { value: item, writable: true, enumerable: true, configurable: true }
    ]);
  };
  var setStyleProperty = (style, property, value) => {
    nativeReflectApply3(nativeSetStyleProperty, style, [property, value]);
  };
  var applyStyles = (style, values) => {
    for (const [property, value] of nativeReflectApply3(nativeObjectEntries, void 0, [values])) {
      setStyleProperty(style, cssPropertyName(property), value);
    }
  };
  var rectOf = (el) => {
    const r = nativeReflectApply3(nativeGetBoundingClientRect, el, []);
    return {
      x: nativeReflectApply3(nativeGetRectX, r, []),
      y: nativeReflectApply3(nativeGetRectY, r, []),
      width: nativeReflectApply3(nativeGetRectWidth, r, []),
      height: nativeReflectApply3(nativeGetRectHeight, r, [])
    };
  };
  var eventTargetOf = (event) => nativeReflectApply3(nativeGetEventTarget, event, []);
  var clientPointOf = (event) => ({
    x: nativeReflectApply3(nativeGetMouseClientX, event, []),
    y: nativeReflectApply3(nativeGetMouseClientY, event, [])
  });
  var isMac2 = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  function contextActionToken() {
    const bytes = new NativeUint8Array(16);
    nativeGetRandomValues(bytes);
    const hex = "0123456789abcdef";
    let token = "";
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index] ?? 0;
      token += (hex[byte >> 4] ?? "") + (hex[byte & 15] ?? "");
    }
    return token;
  }
  var nativeActionHandlers = [];
  var clearNativeActionHandlers = () => {
    nativeActionHandlers = [];
  };
  async function runNativeAction(event) {
    const detail = event.detail;
    if (!detail || typeof detail !== "object") return;
    const { action, signature } = detail;
    if (typeof action !== "string" || !carrierVerifyResult) return;
    if (!await carrierVerifyResult("carrier:context-action", { action }, signature)) return;
    const handlers = nativeActionHandlers;
    for (let index = 0; index < handlers.length; index += 1) {
      const handler = handlers[index];
      if (!handler || handler[0] !== action) continue;
      clearNativeActionHandlers();
      handler[1]();
      return;
    }
  }
  function showNativeContextMenu(items) {
    const nativeItems = [];
    clearNativeActionHandlers();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item) continue;
      const action = contextActionToken();
      const run = () => {
        item[1](isMac2 ? action : void 0);
      };
      appendOwn(nativeActionHandlers, [action, run]);
      appendOwn(
        nativeItems,
        item[2] ? { label: item[0], action, value: item[2] } : { label: item[0], action }
      );
    }
    if (!nativeShowContextMenu)
      return NativePromise2.reject(new Error("native context menu unavailable"));
    return nativeShowContextMenu(nativeItems).catch((error) => {
      clearNativeActionHandlers();
      throw error;
    });
  }
  async function shareSrc(src, fallbackName, fx, fy, action) {
    await carrierClaimContextAction(action);
    const { id } = await downloadSrc(src, fallbackName, action);
    await carrierShareDownload(id, fx, fy, action);
  }
  var oversizeByHeader = (res) => Number(res.headers.get("content-length")) > MAX_BLOB;
  var copyAddress = (text) => navigator.clipboard?.writeText(cleanSharedUrl(text)).then(() => toast("Address copied")).catch(() => toast("Copy failed"));
  async function downloadSrc(src, fallbackName, action) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    if (oversizeByHeader(res)) throw new Error("file too large");
    const blob = await res.blob();
    if (blob.size > MAX_BLOB) throw new Error("file too large");
    const href = URL.createObjectURL(blob);
    let name = friendlyDownloadName(filenameFromUrl(src, location.href) || fallbackName);
    if (!name.includes(".")) {
      const ext = ((blob.type || "").split("/")[1] || "").split(";")[0];
      if (ext) name += `.${ext}`;
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.setAttribute("data-carrier-native-download", "");
    a.style.display = "none";
    document.body.appendChild(a);
    try {
      if (action) await carrierPrepareDownload(action, href);
      const completion = waitForNativeDownload(window, href, carrierVerifyResult);
      a.click();
      return await completion;
    } finally {
      a.remove();
      URL.revokeObjectURL(href);
    }
  }
  async function copyImageSrc(src, action) {
    if (action) await carrierClaimContextAction(action);
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    const maxSize = action ? MAX_CLIPBOARD_IMAGE : MAX_BLOB;
    if (Number(res.headers.get("content-length")) > maxSize) {
      throw new Error("image too large");
    }
    const blob = await res.blob();
    if (blob.size > maxSize) throw new Error("image too large");
    if (!action) {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return;
    }
    const dataUrl = await new NativePromise2((resolve, reject) => {
      if (!nativeGetFileReaderResult) {
        reject(new Error("native FileReader result getter unavailable"));
        return;
      }
      const reader = new NativeFileReader();
      nativeReflectApply3(nativeAddEventListener2, reader, [
        "load",
        () => {
          const result = nativeReflectApply3(nativeGetFileReaderResult, reader, []);
          if (typeof result === "string") resolve(result);
          else reject(new Error("image conversion failed"));
        },
        { once: true }
      ]);
      nativeReflectApply3(nativeAddEventListener2, reader, [
        "error",
        () => reject(new Error("image conversion failed")),
        { once: true }
      ]);
      nativeReflectApply3(nativeReadAsDataURL, reader, [blob]);
    });
    await carrierCopyImage(dataUrl, action);
  }
  var ctxMenu = null;
  var ctxMenuReturnFocus = null;
  var closeMenuFromClick = (event) => {
    if (ctxMenu && eventTargetOf(event) === ctxMenu) return;
    closeMenu();
  };
  var closeMenuFromScroll = () => closeMenu();
  var closeMenu = (restoreFocus = false) => {
    if (ctxMenu) nativeReflectApply3(nativeRemove, ctxMenu, []);
    ctxMenu = null;
    nativeReflectApply3(nativeRemoveEventListener2, document, ["click", closeMenuFromClick, true]);
    nativeReflectApply3(nativeRemoveEventListener2, document, ["scroll", closeMenuFromScroll, true]);
    if (restoreFocus && ctxMenuReturnFocus) {
      nativeReflectApply3(nativeFocus, ctxMenuReturnFocus, [{ preventScroll: true }]);
    }
    ctxMenuReturnFocus = null;
  };
  function initContextMenu() {
    if (!nativeGetRectX || !nativeGetRectY || !nativeGetRectWidth || !nativeGetRectHeight || !nativeGetEventTarget || !nativeGetMouseClientX || !nativeGetMouseClientY || !nativeGetKeyboardKey || !nativeGetStyle || !nativeSetTextContent || !nativeSetTabIndex)
      return;
    nativeReflectApply3(nativeAddEventListener2, window, [
      "carrier:context-action",
      runNativeAction,
      true
    ]);
    nativeReflectApply3(nativeAddEventListener2, document, [
      "contextmenu",
      async (e) => {
        if (!e.isTrusted) return;
        const t = eventTargetOf(e);
        const video = t.closest?.("video") || (t.closest?.("div")?.querySelector?.("video") ?? null);
        const img = t.closest?.("img[alt]");
        const anchor = t.closest?.("a[href]");
        const imgSrc = img && (img.currentSrc || img.src);
        const vidSrc = video && (video.currentSrc || video.src);
        const linkHref = anchor?.href;
        const contextPoint = clientPointOf(e);
        const fx = contextPoint.x / Math.max(1, innerWidth);
        const fy = contextPoint.y / Math.max(1, innerHeight);
        const items = [];
        const addItem = (item) => {
          appendOwn(items, item);
        };
        if (imgSrc) {
          addItem([
            IMAGE_CONTEXT_MENU_LABELS[0],
            (action) => copyImageSrc(imgSrc, action).then(() => toast("Image copied")).catch(() => toast("Copy failed"))
          ]);
          addItem([
            IMAGE_CONTEXT_MENU_LABELS[1],
            () => downloadSrc(imgSrc, "image").then(({ url }) => toastDownloadSaved(url)).catch(() => toast("Download failed"))
          ]);
          if (isMac2) {
            addItem([
              IMAGE_CONTEXT_MENU_LABELS[2],
              (action) => action ? shareSrc(imgSrc, "image", fx, fy, action).catch(() => toast("Share failed")) : void 0
            ]);
          }
          addItem([IMAGE_CONTEXT_MENU_LABELS[3], () => copyAddress(imgSrc), cleanSharedUrl(imgSrc)]);
          addItem([IMAGE_CONTEXT_MENU_LABELS[4], () => openUrl(imgSrc)]);
        } else if (vidSrc) {
          addItem([
            VIDEO_CONTEXT_MENU_LABELS[0],
            () => downloadSrc(vidSrc, "video").then(({ url }) => toastDownloadSaved(url)).catch(() => toast("Download failed"))
          ]);
          if (isMac2) {
            addItem([
              VIDEO_CONTEXT_MENU_LABELS[1],
              (action) => action ? shareSrc(vidSrc, "video", fx, fy, action).catch(() => toast("Share failed")) : void 0
            ]);
          }
          addItem([VIDEO_CONTEXT_MENU_LABELS[2], () => copyAddress(vidSrc), cleanSharedUrl(vidSrc)]);
        } else if (linkHref && !linkHref.startsWith("javascript:")) {
          addItem([
            LINK_CONTEXT_MENU_LABELS[0],
            () => copyAddress(linkHref),
            cleanSharedUrl(linkHref)
          ]);
          addItem([LINK_CONTEXT_MENU_LABELS[1], () => openUrl(linkHref)]);
        }
        if (!items.length) return;
        let nativeItemsAreValid = true;
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (item?.[2] && item[2].length > MAX_NATIVE_CONTEXT_VALUE) {
            nativeItemsAreValid = false;
            break;
          }
        }
        nativeReflectApply3(nativePreventDefault, e, []);
        const nativeImageCopyIsSafe = isMac2 || !imgSrc;
        if (nativeShowContextMenu && nativeItemsAreValid && nativeImageCopyIsSafe) {
          try {
            await showNativeContextMenu(items);
            return;
          } catch {
          }
        }
        const focusableSelector = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
        const previouslyFocused = document.activeElement;
        const priorReturnFocus = ctxMenu && nativeReflectApply3(nativeContains, ctxMenu, [previouslyFocused]) ? ctxMenuReturnFocus : previouslyFocused instanceof HTMLElement && previouslyFocused !== document.body ? previouslyFocused : null;
        closeMenu();
        ctxMenuReturnFocus = t.closest?.(focusableSelector) ?? priorReturnFocus;
        ctxMenu = nativeReflectApply3(nativeCreateElement, document, ["div"]);
        const ctxMenuStyle = nativeReflectApply3(nativeGetStyle, ctxMenu, []);
        applyStyles(ctxMenuStyle, {
          position: "fixed",
          left: `${contextPoint.x}px`,
          top: `${contextPoint.y}px`,
          zIndex: "2147483647"
        });
        const shadow = nativeReflectApply3(nativeAttachShadow, ctxMenu, [
          { mode: "closed" }
        ]);
        const menu = nativeReflectApply3(nativeCreateElement, document, ["div"]);
        nativeReflectApply3(nativeSetAttribute, menu, ["role", "menu"]);
        nativeReflectApply3(nativeSetAttribute, menu, ["aria-label", "Media actions"]);
        const menuStyle = nativeReflectApply3(nativeGetStyle, menu, []);
        applyStyles(menuStyle, {
          background: "var(--card-background, Canvas)",
          color: "var(--primary-text, CanvasText)",
          border: "1px solid var(--divider, rgba(127,127,127,.3))",
          borderRadius: "8px",
          padding: "4px",
          boxShadow: "0 6px 24px rgba(0,0,0,.4)",
          minWidth: "170px",
          font: "13px -apple-system, system-ui, sans-serif"
        });
        const menuItems = [];
        const laidOutRects = [];
        let focusedIndex = 0;
        const activate = (fn, restoreFocus = false) => {
          closeMenu(restoreFocus);
          fn();
        };
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (!item) continue;
          const label = item[0];
          if (isMac2 && (label === IMAGE_CONTEXT_MENU_LABELS[2] || label === VIDEO_CONTEXT_MENU_LABELS[1])) {
            continue;
          }
          const fn = item[1];
          const rowIndex = menuItems.length;
          const el = nativeReflectApply3(nativeCreateElement, document, ["div"]);
          nativeReflectApply3(nativeSetTextContent, el, [label]);
          nativeReflectApply3(nativeSetAttribute, el, ["role", "menuitem"]);
          nativeReflectApply3(nativeSetTabIndex, el, [-1]);
          const elStyle = nativeReflectApply3(nativeGetStyle, el, []);
          applyStyles(elStyle, {
            padding: "8px 12px",
            cursor: "pointer",
            borderRadius: "6px",
            outline: "none"
          });
          nativeReflectApply3(nativeAddEventListener2, el, [
            "mouseenter",
            () => setStyleProperty(elStyle, "background", "var(--hover-overlay, rgba(127,127,127,.18))")
          ]);
          nativeReflectApply3(nativeAddEventListener2, el, [
            "mouseleave",
            () => setStyleProperty(elStyle, "background", "")
          ]);
          nativeReflectApply3(nativeAddEventListener2, el, [
            "focus",
            () => {
              focusedIndex = rowIndex;
              setStyleProperty(elStyle, "background", "var(--hover-overlay, rgba(127,127,127,.18))");
            }
          ]);
          nativeReflectApply3(nativeAddEventListener2, el, [
            "blur",
            () => setStyleProperty(elStyle, "background", "")
          ]);
          nativeReflectApply3(nativeAddEventListener2, el, [
            "click",
            (ev) => {
              if (!ev.isTrusted) return;
              nativeReflectApply3(nativeStopPropagation, ev, []);
              const expected = laidOutRects[rowIndex];
              const point = clientPointOf(ev);
              if (!expected || !pointerActivationIsSound(expected, rectOf(el), point.x, point.y)) {
                closeMenu();
                toast("Menu action cancelled");
                return;
              }
              activate(fn);
            }
          ]);
          nativeReflectApply3(nativeAddEventListener2, el, [
            "keydown",
            (event) => {
              const key = nativeReflectApply3(nativeGetKeyboardKey, event, []);
              if (key !== "Enter" && key !== " ") return;
              if (!event.isTrusted) return;
              nativeReflectApply3(nativePreventDefault, event, []);
              nativeReflectApply3(nativeStopPropagation, event, []);
              activate(fn, true);
            }
          ]);
          appendOwn(menuItems, el);
          nativeReflectApply3(nativeAppendChild, menu, [el]);
        }
        nativeReflectApply3(nativeAppendChild, shadow, [menu]);
        nativeReflectApply3(nativeAppendChild, document.body, [ctxMenu]);
        const r = rectOf(menu);
        if (r.x + r.width > innerWidth) {
          setStyleProperty(ctxMenuStyle, "left", `${innerWidth - r.width - 8}px`);
        }
        if (r.y + r.height > innerHeight) {
          setStyleProperty(ctxMenuStyle, "top", `${innerHeight - r.height - 8}px`);
        }
        for (let i = 0; i < menuItems.length; i += 1) {
          const row = menuItems[i];
          appendOwn(laidOutRects, row ? rectOf(row) : { x: 0, y: 0, width: 0, height: 0 });
        }
        nativeReflectApply3(nativeAddEventListener2, ctxMenu, [
          "keydown",
          (event) => {
            if (!event.isTrusted) return;
            const key = nativeReflectApply3(nativeGetKeyboardKey, event, []);
            const current = focusedIndex;
            let next = null;
            if (key === "ArrowDown") next = (current + 1) % menuItems.length;
            if (key === "ArrowUp") next = (current - 1 + menuItems.length) % menuItems.length;
            if (key === "Home") next = 0;
            if (key === "End") next = menuItems.length - 1;
            if (key === "Escape") {
              nativeReflectApply3(nativePreventDefault, event, []);
              closeMenu(true);
              return;
            }
            if (key === "Tab") {
              nativeReflectApply3(nativePreventDefault, event, []);
              closeMenu(true);
              return;
            }
            if (next !== null) {
              nativeReflectApply3(nativePreventDefault, event, []);
              focusedIndex = next;
              const nextItem = menuItems[next];
              if (nextItem) nativeReflectApply3(nativeFocus, nextItem, []);
            }
          }
        ]);
        focusedIndex = 0;
        const firstItem = menuItems[0];
        if (firstItem) nativeReflectApply3(nativeFocus, firstItem, [{ preventScroll: true }]);
        nativeReflectApply3(nativeSetTimeout2, window, [
          () => {
            nativeReflectApply3(nativeAddEventListener2, document, ["click", closeMenuFromClick, true]);
            nativeReflectApply3(nativeAddEventListener2, document, [
              "scroll",
              closeMenuFromScroll,
              true
            ]);
          },
          0
        ]);
      },
      true
    ]);
  }

  // inject/src/messenger/lib/color.ts
  var rgb = (color) => {
    const m = color?.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r = NaN, g = NaN, b = NaN, a = 1] = m[1].split(",").map((v) => parseFloat(v));
    return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? { r, g, b, a } : null;
  };
  var isLightFill = (bg) => {
    const c = rgb(bg);
    return !!c && c.a > 0.9 && (c.r + c.g + c.b) / 3 > 200;
  };

  // inject/src/messenger/lib/login-page.ts
  function isLanguageFooterLink(link) {
    return link.href.trim() === "#";
  }
  function topLanguageLinkIndexes(links) {
    const indexes = links.flatMap((link, index) => isLanguageFooterLink(link) ? [index] : []);
    return indexes.length >= 2 ? indexes : [];
  }
  function isCookiePolicyHref(href) {
    try {
      const url = new URL(href, "https://www.facebook.com/");
      const host = url.hostname.toLowerCase();
      const metaOwned = host === "facebook.com" || host.endsWith(".facebook.com") || host === "meta.com" || host.endsWith(".meta.com") || host === "instagram.com" || host.endsWith(".instagram.com");
      if (!metaOwned) return false;
      return /(?:^|\/)(?:privacy|policies|cookie|cookies)(?:\/|$)/i.test(url.pathname);
    } catch {
      return false;
    }
  }
  function qualifiesCookieActionRow(scores) {
    return scores.length >= 2 && (Math.max(...scores) > 40 || scores.length === 2);
  }
  function lowestScoreIndex(scores) {
    if (!scores.length) return null;
    let lowest = 0;
    for (let index = 1; index < scores.length; index++) {
      if (scores[index] < scores[lowest]) lowest = index;
    }
    return lowest;
  }

  // inject/src/messenger/features/cookie-consent.ts
  var hasCookieConsentContext = (el) => {
    const links = [];
    if (el.matches?.("a[href]")) links.push(el);
    links.push(...el.querySelectorAll?.("a[href]") || []);
    return links.some((link) => isCookiePolicyHref(link.getAttribute("href") || ""));
  };
  var onFacebookHost = () => /(^|\.)facebook\.com$/i.test(location.hostname);
  var onFacebookLoginSurface = () => onFacebookHost() && (/\/login(?:\.php)?$/i.test(location.pathname) || location.pathname === "/" || !!document.querySelector('input[name="email"], input[name="pass"], input[type="password"]'));
  var visibleBox = (el) => {
    if (el?.nodeType !== 1) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return null;
    return r;
  };
  var primaryBlueScore = (el) => {
    let best = 0;
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const c = rgb(getComputedStyle(cur).backgroundColor);
      if (!c || c.a < 0.35) continue;
      best = Math.max(best, c.b - Math.max(c.r, c.g) + Math.max(0, c.b - 120));
      if (c.a > 0.9) break;
    }
    return best;
  };
  var actionButtonsIn = (root) => {
    const selector = 'button, [role="button"]';
    const buttons = [];
    if (root.matches?.(selector)) buttons.push(root);
    buttons.push(...root.querySelectorAll?.(selector) || []);
    return buttons.filter((button) => {
      if (button.closest('[aria-hidden="true"]')) return false;
      const r = visibleBox(button);
      if (!r || r.width < 90 || r.height < 28) return false;
      if (button.disabled || button.getAttribute("aria-disabled") === "true")
        return false;
      if (button.hasAttribute("aria-expanded")) return false;
      if (button.getAttribute("aria-haspopup")) return false;
      return true;
    });
  };
  var bottomActionRow = (root) => {
    const rootRect = visibleBox(root);
    if (!rootRect) return null;
    const buttons = actionButtonsIn(root).map((button) => ({ button, rect: button.getBoundingClientRect() })).sort((a, b) => a.rect.top - b.rect.top);
    const rows = [];
    for (const item of buttons) {
      const center = item.rect.top + item.rect.height / 2;
      let row = rows.find((candidate) => Math.abs(candidate.center - center) < 24);
      if (!row) {
        row = { center, items: [] };
        rows.push(row);
      }
      row.items.push(item);
      row.center = row.items.reduce((sum, i) => sum + i.rect.top + i.rect.height / 2, 0) / row.items.length;
    }
    return rows.filter((row) => row.items.length >= 2).map((row) => ({
      ...row,
      bottom: Math.max(...row.items.map((i) => i.rect.bottom)),
      primaryScore: Math.max(...row.items.map((i) => primaryBlueScore(i.button)))
    })).filter(
      (row) => qualifiesCookieActionRow(row.items.map((item) => primaryBlueScore(item.button)))
    ).sort((a, b) => b.bottom - a.bottom)[0]?.items;
  };
  function findOptionalCookieDeclineButton(root = document) {
    if (!onFacebookLoginSurface()) return null;
    const roots = /* @__PURE__ */ new Set();
    for (const button of actionButtonsIn(root)) {
      let node = button.parentElement;
      for (let depth = 0; node && node !== document.body && depth < 12; depth++, node = node.parentElement) {
        const row = bottomActionRow(node);
        if (row?.length === 2 && hasCookieConsentContext(node) && !node.querySelector?.('input[name="email"], input[name="pass"], input[type="password"]')) {
          roots.add(node);
        }
      }
    }
    const candidates = [...roots].sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    });
    for (const candidate of candidates) {
      const row = bottomActionRow(candidate);
      if (!row) continue;
      const target = lowestScoreIndex(row.map((item) => primaryBlueScore(item.button)));
      if (target !== null) return row[target].button;
    }
    return null;
  }
  function initCookieAutoDecline() {
    if (!onFacebookHost()) return;
    let done = false;
    let scheduled = false;
    let retryTimer = 0;
    const deadline = Date.now() + 6e4;
    let observer;
    const stop = () => {
      observer?.disconnect();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = 0;
      }
    };
    const decline = (button) => {
      done = true;
      document.documentElement.setAttribute("data-carrier-cookie-decline", "attempted");
      stop();
      button.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
      );
      button.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
      );
      button.click();
    };
    const scan = () => {
      scheduled = false;
      if (done) return;
      const button = findOptionalCookieDeclineButton();
      if (button) {
        decline(button);
      } else if (Date.now() < deadline && !retryTimer) {
        retryTimer = window.setTimeout(() => {
          retryTimer = 0;
          schedule();
        }, 250);
      } else if (Date.now() >= deadline) {
        stop();
      }
    };
    const schedule = () => {
      if (scheduled || done) return;
      scheduled = true;
      requestAnimationFrame(scan);
    };
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked", "aria-expanded", "class", "role", "style"]
    });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", schedule, { once: true });
    }
    window.addEventListener("pageshow", schedule);
    schedule();
  }

  // inject/src/messenger/features/download-anchors.ts
  var stripDlTarget = (a) => {
    const el = a;
    if (el?.matches?.("a[download][target]")) {
      el.removeAttribute("target");
      el.removeAttribute("rel");
    }
  };
  var sweepDlAnchors = (root) => {
    stripDlTarget(root);
    root.querySelectorAll?.("a[download][target]").forEach(stripDlTarget);
  };
  var addedNodeSweeps = [];
  var queuedSweepRoots = /* @__PURE__ */ new Set();
  var sweepTimer = 0;
  var runSweeps = () => {
    sweepTimer = 0;
    const roots = [...queuedSweepRoots];
    queuedSweepRoots.clear();
    for (const root of roots) {
      if (!root.isConnected) continue;
      for (const fn of addedNodeSweeps) fn(root);
    }
  };
  var sweepObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "attributes") stripDlTarget(m.target);
      else for (const n of m.addedNodes) if (n.nodeType === 1) queuedSweepRoots.add(n);
    }
    if (!sweepTimer && queuedSweepRoots.size) sweepTimer = setTimeout(runSweeps, 50);
  });
  var observeSweeps = () => sweepObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["target", "download"]
  });
  function registerAddedNodeSweep(fn) {
    addedNodeSweeps.push(fn);
  }
  function initDownloadAnchors() {
    sweepDlAnchors(document.documentElement);
    if (!document.hidden) observeSweeps();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        sweepObserver.disconnect();
        clearTimeout(sweepTimer);
        sweepTimer = 0;
        queuedSweepRoots.clear();
      } else {
        observeSweeps();
        for (const fn of addedNodeSweeps) fn(document.documentElement);
      }
    });
    registerAddedNodeSweep(sweepDlAnchors);
    document.addEventListener(
      "click",
      (e) => {
        const a = e.target?.closest?.("a[download]");
        const href = a?.href;
        if (!a || !href || !/^(blob:|data:|https?:)/i.test(href)) return;
        if (a.hasAttribute("data-carrier-native-download")) return;
        a.removeAttribute("target");
        e.preventDefault();
        e.stopImmediatePropagation();
        downloadSrc(href, a.getAttribute("download") || "download").then(({ url }) => toastDownloadSaved(url)).catch(() => toast("Download failed"));
      },
      true
    );
  }

  // inject/src/messenger/lib/emoji-images.ts
  var FACEBOOK_EMOJI_PATH = "/images/emoji.php/";
  var isFacebookEmojiImage = (value) => typeof value === "string" && value.includes(FACEBOOK_EMOJI_PATH);
  function hasImageArea(rect) {
    return rect.right > rect.left && rect.bottom > rect.top;
  }
  function intersectsImageClip(rect, clip) {
    return !(rect.bottom < clip.top || rect.top > clip.bottom || rect.right < clip.left || rect.left > clip.right);
  }
  function intersectImageClips(left, right) {
    return {
      top: Math.max(left.top, right.top),
      right: Math.min(left.right, right.right),
      bottom: Math.min(left.bottom, right.bottom),
      left: Math.max(left.left, right.left)
    };
  }
  function expandedImageClip(rect, margin) {
    return {
      top: rect.top - margin,
      right: rect.right + margin,
      bottom: rect.bottom + margin,
      left: rect.left - margin
    };
  }

  // inject/src/messenger/features/emoji-images.ts
  var PREFETCH_MARGIN = 80;
  var SCAN_DELAY_MS = 50;
  function rectOf2(element) {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
  }
  function visibleClipFor(image) {
    let clip = {
      top: -PREFETCH_MARGIN,
      right: innerWidth + PREFETCH_MARGIN,
      bottom: innerHeight + PREFETCH_MARGIN,
      left: -PREFETCH_MARGIN
    };
    const dialog = image.closest('[role="dialog"]');
    if (!dialog) return clip;
    clip = intersectImageClips(clip, expandedImageClip(rectOf2(dialog), PREFETCH_MARGIN));
    let ancestor = image.parentElement;
    while (ancestor && ancestor !== dialog) {
      if (ancestor.scrollHeight > ancestor.clientHeight + 2) {
        clip = intersectImageClips(clip, expandedImageClip(rectOf2(ancestor), PREFETCH_MARGIN));
        break;
      }
      ancestor = ancestor.parentElement;
    }
    return clip;
  }
  function initEmojiImageLoading() {
    const sourceDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    const nativeSetAttribute2 = HTMLImageElement.prototype.setAttribute;
    if (!sourceDescriptor?.set) return;
    const pending = /* @__PURE__ */ new Set();
    let scanTimer;
    const promote = (image) => {
      image.loading = "eager";
      const source = image.currentSrc || image.getAttribute("src") || image.src;
      if (source) sourceDescriptor.set?.call(image, source);
      pending.delete(image);
    };
    const scan = () => {
      scanTimer = void 0;
      for (const image of pending) {
        if (!image.isConnected) {
          pending.delete(image);
          continue;
        }
        const imageRect = rectOf2(image);
        if (hasImageArea(imageRect) && intersectsImageClip(imageRect, visibleClipFor(image))) {
          promote(image);
        }
      }
    };
    const scheduleScan = () => {
      if (scanTimer !== void 0) return;
      scanTimer = window.setTimeout(scan, SCAN_DELAY_MS);
    };
    const defer = (image) => {
      image.loading = "lazy";
      pending.add(image);
      scheduleScan();
    };
    try {
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        configurable: sourceDescriptor.configurable,
        enumerable: sourceDescriptor.enumerable,
        get: sourceDescriptor.get,
        set(value) {
          if (isFacebookEmojiImage(value)) defer(this);
          return sourceDescriptor.set?.call(this, value);
        }
      });
      HTMLImageElement.prototype.setAttribute = function(name, value) {
        const emoji = name.toLowerCase() === "src" && isFacebookEmojiImage(value);
        if (emoji) defer(this);
        const result = nativeSetAttribute2.call(this, name, value);
        if (emoji) scheduleScan();
        return result;
      };
    } catch (_) {
      return;
    }
    document.addEventListener("scroll", scheduleScan, true);
    window.addEventListener("resize", scheduleScan);
    new MutationObserver((records) => {
      if (pending.size === 0) return;
      for (const record of records) {
        for (const removed of record.removedNodes) {
          if (removed instanceof HTMLImageElement) {
            pending.delete(removed);
          } else if (removed instanceof Element) {
            for (const image of removed.querySelectorAll(
              `img[src*="${FACEBOOK_EMOJI_PATH}"]`
            )) {
              pending.delete(image);
            }
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // inject/src/messenger/lib/facebook-modules.ts
  function isConversationSearchInput({
    hasAccessibleName,
    insideForm,
    insideMain,
    role,
    type
  }) {
    if (!insideMain || insideForm) return false;
    return type === "search" || role === "searchbox" || type === "text" && role === null && hasAccessibleName;
  }
  var NULL_COMPONENT_MODULES = /* @__PURE__ */ new Set([
    // Carrier's CSS already hides this entire Facebook-wide header tree. Removing
    // the React root prevents its search, notification, account, and portal work.
    "CometBaseAppNavigation.react",
    // Messenger's server-driven promotion banner is not part of messaging.
    "MWInboxQuickPromotionWrapper.react",
    "MWInboxQuickPromotionWrapperImportUnconditionally.react",
    "MAWSecureThreadQuickPromotion.react",
    "MWThreadListQP.react",
    "MWMessageSearchEBRestoreUpsell.react",
    // Carrier owns desktop notification delivery; Facebook's browser-push root
    // is redundant inside the native WebView.
    "CometBrowserPushRoot.react",
    // Casting is Facebook-wide video chrome, not Messenger media playback.
    "CometCastingMiniplayerRoot.react"
  ]);
  var TELEMETRY_MODULES = /* @__PURE__ */ new Set([
    "Banzai",
    "FalcoLoggerInternal",
    "ODS",
    "TimeSpentImmediateActiveSecondsLogger",
    "TimeSpentImmediateActiveSecondsLoggerComet"
  ]);
  var BACKGROUND_SERVICE_MODULES = /* @__PURE__ */ new Set(["MAWFTSRestoreSync"]);
  var ODS_METHODS = ["bumpEntityKey", "bumpFraction", "flush", "setEntitySample"];
  var FALCO_METHODS = ["log", "logAsync", "logCritical", "logImmediately"];
  var wrappedTelemetryMethods = /* @__PURE__ */ new WeakSet();
  var wrappedFalcoFactories = /* @__PURE__ */ new WeakSet();
  function nullComponent() {
    return null;
  }
  Object.defineProperty(nullComponent, "displayName", {
    value: "CarrierNullFacebookComponent"
  });
  function replaceFunctionExport(value, replacement) {
    if (typeof value === "function") return replacement;
    if (!value || typeof value !== "object") return value;
    const record = value;
    if (typeof record.default === "function") {
      try {
        record.default = replacement;
      } catch (_) {
      }
    }
    return value;
  }
  function replaceComponentExports(result, factoryArgs, replacement) {
    const firstExportIndex = Math.max(0, factoryArgs.length - 2);
    for (let index = firstExportIndex; index < factoryArgs.length; index++) {
      const candidate = factoryArgs[index];
      if (!candidate || typeof candidate !== "object") continue;
      const record = candidate;
      if (Object.prototype.hasOwnProperty.call(record, "exports")) {
        try {
          record.exports = replaceFunctionExport(record.exports, replacement);
        } catch (_) {
        }
      }
      replaceFunctionExport(record, replacement);
    }
    return replaceFunctionExport(result, replacement);
  }
  function findFTSRestoreSync(value, seen) {
    if (!value || typeof value !== "object" || seen.has(value)) return void 0;
    seen.add(value);
    const record = value;
    const getter = record.getFTSRestoreSync;
    if (typeof getter === "function") {
      try {
        const restore = Reflect.apply(getter, value, []);
        if (restore && typeof restore.setKeepWhileLoop_FOR_TESTING_ONLY === "function" && typeof restore.setIsStarted === "function" && typeof restore.startSyncingLoop === "function") {
          return restore;
        }
      } catch (_) {
      }
    }
    return findFTSRestoreSync(record.default, seen);
  }
  function captureFTSRestoreSync(result, factoryArgs, onFTSRestoreSync) {
    const seen = /* @__PURE__ */ new WeakSet();
    const inspect = (value) => {
      const restore = findFTSRestoreSync(value, seen);
      if (restore) onFTSRestoreSync(restore);
    };
    inspect(result);
    for (let index = 4; index < factoryArgs.length; index++) {
      const candidate = factoryArgs[index];
      inspect(candidate);
      if (candidate && typeof candidate === "object") {
        inspect(candidate.exports);
      }
    }
  }
  var FacebookFTSIdleCoordinator = class {
    constructor() {
      __publicField(this, "active", false);
      __publicField(this, "restores", /* @__PURE__ */ new Set());
    }
    register(restore) {
      if (this.restores.has(restore)) return;
      this.restores.add(restore);
      if (this.active) this.start(restore);
      else this.stop(restore);
    }
    wake() {
      if (this.active) return;
      this.active = true;
      for (const restore of this.restores) this.start(restore);
    }
    pause() {
      this.active = false;
      for (const restore of this.restores) this.stop(restore);
    }
    start(restore) {
      try {
        restore.setKeepWhileLoop_FOR_TESTING_ONLY(true);
        restore.setIsStarted(false);
        const result = restore.startSyncingLoop();
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch(() => {
          });
        }
      } catch (_) {
      }
    }
    stop(restore) {
      try {
        restore.setKeepWhileLoop_FOR_TESTING_ONLY(false);
      } catch (_) {
      }
    }
  };
  function wrapTelemetryMethod(record, key, shouldBlockTelemetry) {
    const original = record[key];
    if (typeof original !== "function" || wrappedTelemetryMethods.has(original)) return;
    const wrapped = function(...args) {
      if (shouldBlockTelemetry()) return void 0;
      return Reflect.apply(original, this, args);
    };
    wrappedTelemetryMethods.add(wrapped);
    try {
      record[key] = wrapped;
    } catch (_) {
    }
  }
  function patchFalcoLogger(value, shouldBlockTelemetry) {
    if (!value || typeof value !== "object") return;
    const logger = value;
    for (const method of FALCO_METHODS) {
      wrapTelemetryMethod(logger, method, shouldBlockTelemetry);
    }
  }
  function wrapFalcoFactory(record, shouldBlockTelemetry) {
    const original = record.create;
    if (typeof original !== "function" || wrappedFalcoFactories.has(original)) return;
    const wrapped = function(...args) {
      const logger = Reflect.apply(original, this, args);
      patchFalcoLogger(logger, shouldBlockTelemetry);
      return logger;
    };
    wrappedFalcoFactories.add(wrapped);
    try {
      record.create = wrapped;
    } catch (_) {
    }
  }
  function patchTelemetryValue(moduleName, value, shouldBlockTelemetry) {
    if (!value || typeof value !== "object") return;
    const record = value;
    if (moduleName === "FalcoLoggerInternal") {
      wrapFalcoFactory(record, shouldBlockTelemetry);
    } else {
      const methods = moduleName === "Banzai" ? ["post"] : moduleName === "ODS" ? ODS_METHODS : ["maybeReportActiveSecond"];
      for (const method of methods) wrapTelemetryMethod(record, method, shouldBlockTelemetry);
    }
    if (record.default && record.default !== value && typeof record.default === "object") {
      patchTelemetryValue(moduleName, record.default, shouldBlockTelemetry);
    }
  }
  function patchTelemetryExports(moduleName, result, factoryArgs, shouldBlockTelemetry) {
    patchTelemetryValue(moduleName, result, shouldBlockTelemetry);
    for (let index = 4; index < factoryArgs.length; index++) {
      const candidate = factoryArgs[index];
      patchTelemetryValue(moduleName, candidate, shouldBlockTelemetry);
      if (!candidate || typeof candidate !== "object") continue;
      patchTelemetryValue(
        moduleName,
        candidate.exports,
        shouldBlockTelemetry
      );
    }
    return result;
  }
  function wrapFactory(moduleName, factory, shouldBlockTelemetry, onFTSRestoreSync) {
    const wrapped = function(...factoryArgs) {
      const result = Reflect.apply(factory, this, factoryArgs);
      if (NULL_COMPONENT_MODULES.has(moduleName)) {
        return replaceComponentExports(result, factoryArgs, nullComponent);
      }
      if (BACKGROUND_SERVICE_MODULES.has(moduleName)) {
        captureFTSRestoreSync(result, factoryArgs, onFTSRestoreSync);
        return result;
      }
      return patchTelemetryExports(moduleName, result, factoryArgs, shouldBlockTelemetry);
    };
    try {
      Object.defineProperty(wrapped, "length", { value: factory.length });
    } catch (_) {
    }
    return wrapped;
  }
  function createFacebookModuleDefineInterceptor(define, shouldBlockTelemetry, onFTSRestoreSync = () => {
  }) {
    return new Proxy(define, {
      apply(target, thisArg, args) {
        const moduleName = args[0];
        const factory = args[2];
        if (typeof moduleName === "string" && typeof factory === "function" && (NULL_COMPONENT_MODULES.has(moduleName) || TELEMETRY_MODULES.has(moduleName) || BACKGROUND_SERVICE_MODULES.has(moduleName))) {
          args[2] = wrapFactory(
            moduleName,
            factory,
            shouldBlockTelemetry,
            onFTSRestoreSync
          );
        }
        return Reflect.apply(target, thisArg, args);
      }
    });
  }

  // inject/src/messenger/features/facebook-modules.ts
  var SEARCH_INDEX_WAKE_MS = 5 * 6e4;
  function initFacebookModuleInterception() {
    const page = window;
    const shouldBlockTelemetry = () => window.__CARRIER_SETTINGS__?.block_telemetry === true;
    const wrappedDefines = /* @__PURE__ */ new WeakSet();
    const searchIndex = new FacebookFTSIdleCoordinator();
    let pauseTimer;
    const wakeSearchIndex = () => {
      searchIndex.wake();
      if (pauseTimer !== void 0) window.clearTimeout(pauseTimer);
      pauseTimer = window.setTimeout(() => {
        pauseTimer = void 0;
        searchIndex.pause();
      }, SEARCH_INDEX_WAKE_MS);
    };
    window.__carrierWakeSearchIndex = wakeSearchIndex;
    document.addEventListener(
      "focusin",
      (event) => {
        const input = event.target instanceof HTMLInputElement ? event.target : null;
        if (input && isConversationSearchInput({
          hasAccessibleName: input.hasAttribute("aria-label"),
          insideForm: input.closest("form") !== null,
          insideMain: input.closest('[role="main"]') !== null,
          role: input.getAttribute("role"),
          type: input.type
        })) {
          wakeSearchIndex();
        }
      },
      true
    );
    const wrap = (value) => {
      if (typeof value !== "function" || wrappedDefines.has(value)) return value;
      const wrapped = createFacebookModuleDefineInterceptor(
        value,
        shouldBlockTelemetry,
        (restore) => searchIndex.register(restore)
      );
      wrappedDefines.add(wrapped);
      return wrapped;
    };
    try {
      const inherited = Object.getOwnPropertyDescriptor(window, "__d");
      if (typeof inherited?.get === "function" && typeof inherited.set === "function") {
        Object.defineProperty(window, "__d", {
          configurable: inherited.configurable,
          enumerable: inherited.enumerable,
          get: () => inherited.get?.call(window),
          set: (value) => inherited.set?.call(window, wrap(value))
        });
        return;
      }
      let current = wrap(page.__d);
      Object.defineProperty(window, "__d", {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (value) => {
          current = wrap(value);
        }
      });
    } catch (_) {
    }
  }

  // inject/src/messenger/lib/facebook-workers.ts
  function isResponsivenessWorkerMessage(message) {
    if (!message || typeof message !== "object") return false;
    return message.type === "responsiveness";
  }
  function isResponsivenessProfilerHandshake(message) {
    if (!message || typeof message !== "object") return false;
    return message.type === "endpoint_started";
  }
  function optimizeFacebookWorker(worker, shouldBlockTelemetry, onStopped = () => {
  }) {
    const nativePostMessage = worker.postMessage;
    let profilerHandshakeSeen = false;
    let stopped = false;
    worker.postMessage = function(...args) {
      if (stopped) return;
      const message = args[0];
      if (isResponsivenessProfilerHandshake(message)) profilerHandshakeSeen = true;
      if (profilerHandshakeSeen && shouldBlockTelemetry() && isResponsivenessWorkerMessage(message)) {
        stopped = true;
        try {
          worker.terminate();
        } catch (_) {
        }
        onStopped();
        return;
      }
      Reflect.apply(nativePostMessage, this, args);
    };
    return worker;
  }

  // inject/src/messenger/features/facebook-workers.ts
  function initFacebookWorkerOptimization() {
    if (typeof window.Worker !== "function" || typeof Proxy !== "function") return;
    const state = { responsivenessWorkersStopped: 0 };
    window.__CARRIER_WORKER_OPTIMIZATION__ = state;
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args, NewTarget) {
        const worker = Reflect.construct(Target, args, NewTarget);
        return optimizeFacebookWorker(
          worker,
          () => window.__CARRIER_SETTINGS__?.block_telemetry === true,
          () => {
            state.responsivenessWorkersStopped++;
          }
        );
      }
    });
  }

  // inject/src/messenger/features/force-theme.ts
  function initForceTheme() {
    const html = document.documentElement;
    let forcedClass = null;
    const apply = () => {
      const forced = window.__CARRIER_SETTINGS__?.theme;
      if (forced !== "light" && forced !== "dark") {
        if (forcedClass) {
          html.classList.remove(forcedClass);
          forcedClass = null;
        }
        return;
      }
      const want = forced === "dark" ? "__fb-dark-mode" : "__fb-light-mode";
      const other = forced === "dark" ? "__fb-light-mode" : "__fb-dark-mode";
      if (!html.classList.contains(want) || html.classList.contains(other)) {
        html.classList.remove(other);
        html.classList.add(want);
      }
      forcedClass = want;
    };
    apply();
    window.addEventListener("carrier:settings", apply);
    new MutationObserver(apply).observe(html, { attributes: true, attributeFilter: ["class"] });
  }

  // inject/src/messenger/features/fullscreen.ts
  function initFullscreenPolyfill() {
    if (document.fullscreenEnabled && Element.prototype.requestFullscreen)
      return;
    let current = null;
    const enter = (el) => {
      current = el;
      el.dataset.carrierPrevStyle = el.getAttribute("style") || "";
      Object.assign(el.style, {
        position: "fixed",
        inset: "0",
        width: "100vw",
        height: "100vh",
        zIndex: "2147483647",
        background: "#000"
      });
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    };
    const leave = () => {
      if (current) {
        current.setAttribute("style", current.dataset.carrierPrevStyle || "");
        delete current.dataset.carrierPrevStyle;
        current = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      }
      return Promise.resolve();
    };
    Object.defineProperty(document, "fullscreenElement", { get: () => current, configurable: true });
    Element.prototype.requestFullscreen = function() {
      return enter(this);
    };
    Element.prototype.webkitRequestFullscreen = Element.prototype.requestFullscreen;
    document.exitFullscreen = leave;
    document.webkitExitFullscreen = leave;
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && current) leave();
      },
      true
    );
  }

  // inject/src/messenger/lib/privacy.ts
  var PREVIEW_NAME_RE = /^([^:]{1,40}):(?=\s|$)/;
  var PREVIEW_EVENT_RE = /^(.{1,40}?)(?=\s+(?:sent|replied|reacted|liked|laughed|loved|mentioned|shared|left|joined|added|removed|changed|created|named|started)\b)/i;
  function isMetaText(value) {
    return !value || /^(\d+\s*(?:s|m|h|d|w|mo|y)|now|just now)$/i.test(value) || /^(sun|mon|tue|wed|thu|fri|sat)$/i.test(value) || /^[·•.,\s\d]+$/.test(value);
  }
  function previewIdentity(value) {
    const colon = value.match(PREVIEW_NAME_RE);
    const event = colon ? null : value.match(PREVIEW_EVENT_RE);
    const match = colon || event;
    if (!match) return null;
    const prefix = match[1].trim();
    if (!prefix || prefix.length < 2 || /^(you|du|me|meg)$/i.test(prefix)) return null;
    if (/[:;!?]/.test(prefix) || /^\d+(?:[ .-]\d+)*$/.test(prefix)) return null;
    return { prefix, colon: !!colon };
  }

  // inject/src/messenger/features/hide-names.ts
  var IDENTITY_ATTR = "data-carrier-private-identity";
  var THREAD_ROW_SEL = '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]';
  var TEXT_SURFACE_SEL = "span, div, h1, h2, h3, h4";
  var VISUAL_SEL = 'img, svg, image, [style*="background-image"]';
  function initHideNames() {
    const html = document.documentElement;
    let observer = null;
    let pending = false;
    let suppressMutations = false;
    const on = () => window.__CARRIER_SETTINGS__?.hide_names_avatars === true;
    function textValue(el) {
      return (el?.textContent || "").replace(/\s+/g, " ").trim();
    }
    function normalizedRect(el) {
      const rect = el.getBoundingClientRect();
      const configuredZoom = Number(window.__CARRIER_SETTINGS__?.zoom) || 100;
      const scale = Math.min(2, Math.max(0.3, configuredZoom / 100));
      return new DOMRect(rect.x / scale, rect.y / scale, rect.width / scale, rect.height / scale);
    }
    function visible(el) {
      const r = el ? normalizedRect(el) : null;
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    }
    function mark(el) {
      if (el?.setAttribute) el.setAttribute(IDENTITY_ATTR, "");
    }
    function clearMarkers() {
      document.querySelectorAll(`[${IDENTITY_ATTR}]`).forEach((el) => {
        el.removeAttribute(IDENTITY_ATTR);
      });
    }
    function textLeaves(root) {
      const out = [];
      root.querySelectorAll?.(TEXT_SURFACE_SEL).forEach((el) => {
        if (!visible(el) || el.closest?.('[contenteditable="true"]')) return;
        if (!textValue(el)) return;
        for (const child of el.children || []) {
          if (textValue(child)) return;
        }
        out.push(el);
      });
      return out.sort((a, b) => {
        const ar = normalizedRect(a);
        const br = normalizedRect(b);
        return ar.y - br.y || ar.x - br.x;
      });
    }
    function textSurfaces(root) {
      const out = [];
      root.querySelectorAll?.(TEXT_SURFACE_SEL).forEach((el) => {
        if (!visible(el) || el.closest?.('[contenteditable="true"]')) return;
        if (!textValue(el)) return;
        out.push(el);
      });
      return out.sort((a, b) => {
        const ar = normalizedRect(a);
        const br = normalizedRect(b);
        return ar.y - br.y || ar.x - br.x || ar.height - br.height;
      });
    }
    function area(el) {
      const r = normalizedRect(el);
      return r.width * r.height;
    }
    function deepest(elements) {
      return elements.filter((el) => !elements.some((other) => other !== el && el.contains(other)));
    }
    function markDeepest(elements) {
      let count = 0;
      deepest(elements).sort((a, b) => {
        const ar = normalizedRect(a);
        const br = normalizedRect(b);
        return ar.x - br.x || area(a) - area(b);
      }).forEach((el) => {
        if (isMetaText(textValue(el))) return;
        mark(el);
        count += 1;
      });
      return count > 0;
    }
    function markPreviewSenderPrefix(el) {
      const value = textValue(el);
      const identity = previewIdentity(value);
      if (!identity) return false;
      const candidates = [el, ...textSurfaces(el)].filter((candidate, index, all) => all.indexOf(candidate) === index).filter((candidate) => {
        const candidateText = textValue(candidate);
        if (!candidateText) return false;
        if (candidateText === identity.prefix) return true;
        if (identity.colon && candidateText === `${identity.prefix}:`) return true;
        return false;
      }).sort((a, b) => area(a) - area(b));
      if (candidates.length) {
        mark(candidates[0]);
        return true;
      }
      mark(el);
      return true;
    }
    function markConversationRows() {
      const seen = /* @__PURE__ */ new Set();
      for (const row of document.querySelectorAll(THREAD_ROW_SEL)) {
        const href = row.getAttribute("href") || "";
        if (!href || seen.has(href) || !visible(row)) continue;
        seen.add(href);
        const rr = normalizedRect(row);
        row.querySelectorAll(VISUAL_SEL).forEach((el) => {
          if (!visible(el)) return;
          const r = normalizedRect(el);
          const leftAvatar = r.left < rr.left + 80 && r.width >= 20 && r.height >= 20;
          const rightReceipt = r.right > rr.right - 56 && r.width >= 12 && r.width <= 34 && r.height >= 12 && r.height <= 34;
          if (leftAvatar || rightReceipt) mark(el);
        });
        const surfaces = textSurfaces(row).filter((el) => {
          if (el.getAttribute("aria-hidden") === "true") return false;
          if (el.closest("abbr")) return false;
          const r = normalizedRect(el);
          return r.left > rr.left + 56;
        });
        if (!surfaces.length) continue;
        const firstLineY = Math.min(...surfaces.map((el) => normalizedRect(el).top));
        const firstLine = [];
        surfaces.forEach((el) => {
          const r = normalizedRect(el);
          if (Math.abs(r.top - firstLineY) < 4 && r.height <= 24) firstLine.push(el);
          else if (r.top > firstLineY + 8 && r.height <= 24) markPreviewSenderPrefix(el);
        });
        markDeepest(firstLine);
      }
    }
    function mainPane() {
      return document.querySelector('[role="main"]') || document.querySelector("main");
    }
    function markThreadHeader(main2) {
      const mr = normalizedRect(main2);
      const headerBottom = mr.top + 96;
      const actionStart = mr.right - 150;
      textLeaves(main2).forEach((el) => {
        const r = normalizedRect(el);
        if (r.top >= mr.top && r.bottom <= headerBottom && r.left < actionStart) mark(el);
      });
      main2.querySelectorAll(VISUAL_SEL).forEach((el) => {
        if (!visible(el)) return;
        const r = normalizedRect(el);
        if (r.top >= mr.top && r.bottom <= headerBottom && r.left < actionStart && r.width >= 20 && r.height >= 20) {
          mark(el);
        }
      });
    }
    function markThreadMessages(main2) {
      main2.querySelectorAll('[role="article"]').forEach((article) => {
        article.querySelectorAll("h3, h3 *").forEach((el) => {
          if (visible(el) && textValue(el)) mark(el);
        });
        article.querySelectorAll(
          'img[referrerpolicy="origin-when-cross-origin"], img[height="14"][width="14"][tabindex="-1"]'
        ).forEach((el) => {
          if (visible(el)) mark(el);
        });
        textLeaves(article).forEach((el) => {
          if (/\breplied to\b/i.test(textValue(el))) mark(el);
        });
      });
      textSurfaces(main2).forEach((el) => {
        const r = normalizedRect(el);
        if (r.height <= 32 && r.width <= 420 && /\breplied to\b/i.test(textValue(el))) {
          mark(el);
        }
      });
    }
    function scan() {
      suppressMutations = true;
      try {
        clearMarkers();
        if (!on()) return;
        markConversationRows();
        const main2 = mainPane();
        if (main2) {
          markThreadHeader(main2);
          markThreadMessages(main2);
        }
      } finally {
        queueMicrotask(() => {
          suppressMutations = false;
        });
      }
    }
    const SCAN_MIN_GAP_MS = 150;
    let lastScanAt = 0;
    function schedule() {
      if (suppressMutations || !on() || pending) return;
      pending = true;
      const wait = Math.max(0, SCAN_MIN_GAP_MS - (performance.now() - lastScanAt));
      setTimeout(() => {
        requestAnimationFrame(() => {
          pending = false;
          lastScanAt = performance.now();
          scan();
        });
      }, wait);
    }
    function start() {
      if (observer) return;
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-label", "href", "role", "src", "style"]
      });
      window.addEventListener("resize", schedule);
    }
    function stop() {
      observer?.disconnect();
      observer = null;
      pending = false;
      clearMarkers();
      window.removeEventListener("resize", schedule);
    }
    const apply = () => {
      html.toggleAttribute("data-carrier-hide-names", on());
      if (on()) {
        start();
        schedule();
      } else {
        stop();
      }
    };
    apply();
    window.addEventListener("carrier:settings", apply);
  }

  // inject/src/messenger/features/link-handling.ts
  function handleLink(e) {
    const a = e.target?.closest?.("a[href]");
    if (!a) return;
    const href = a.href;
    if (!href || href.startsWith("javascript:")) return;
    if (a.hasAttribute("download")) return;
    const modified = e.shiftKey || e.metaKey || e.ctrlKey || e.button === 1;
    const blank = a.target === "_blank";
    if (classifyHref(href, location.href).external) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openUrl(href);
    } else if (modified || blank) {
      e.preventDefault();
      e.stopImmediatePropagation();
      location.href = href;
    }
  }
  function initLinkHandling() {
    document.addEventListener("click", handleLink, true);
    document.addEventListener("auxclick", (e) => e.button === 1 && handleLink(e), true);
  }

  // inject/src/messenger/features/login-tidy.ts
  var HIDE = "data-carrier-hide";
  var COL = "data-carrier-login-col";
  var ANC = "data-carrier-login-anc";
  var FORM = "data-carrier-login-form";
  var CARD = "data-carrier-login-card";
  var REQUIRED = "data-carrier-login-required";
  var FOOTER = "data-carrier-login-footer";
  var FOOTER_KEEP = "data-carrier-login-footer-keep";
  var FOOTER_LINKS = "data-carrier-login-footer-links";
  var LANGUAGES = "data-carrier-login-languages";
  var LANGUAGE_LINK = "data-carrier-login-language-link";
  function initLoginTidy() {
    let scheduled = false;
    let tidyObserver = null;
    const prefersDark = () => !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const wantDark = () => {
      const t = window.__CARRIER_SETTINGS__?.theme;
      if (t === "dark") return true;
      if (t === "light") return false;
      return prefersDark();
    };
    const isRequiredLoginUi = (el) => {
      if (el?.nodeType !== 1) return false;
      if (el === document.documentElement || el === document.body) return false;
      const role = el.getAttribute("role");
      if (role === "dialog" || role === "alertdialog") return true;
      if (el.querySelector?.('[role="dialog"], [role="alertdialog"]')) return true;
      if (findOptionalCookieDeclineButton(el)) return true;
      return hasCookieConsentContext(el);
    };
    const restoreRequiredLoginUi = () => {
      for (const el of document.querySelectorAll(`[${HIDE}], [${REQUIRED}]`)) {
        if (isRequiredLoginUi(el)) {
          el.removeAttribute(HIDE);
          el.setAttribute(REQUIRED, "");
        } else {
          el.removeAttribute(REQUIRED);
        }
      }
    };
    const clearFooterMarks = () => {
      document.querySelectorAll(`[${FOOTER}]`).forEach((el) => el.removeAttribute(FOOTER));
      document.querySelectorAll(`[${FOOTER_KEEP}]`).forEach((el) => el.removeAttribute(FOOTER_KEEP));
      document.querySelectorAll(`[${FOOTER_LINKS}]`).forEach((el) => el.removeAttribute(FOOTER_LINKS));
      document.querySelectorAll(`[${LANGUAGES}]`).forEach((el) => el.removeAttribute(LANGUAGES));
      document.querySelectorAll(`[${LANGUAGE_LINK}]`).forEach((el) => el.removeAttribute(LANGUAGE_LINK));
    };
    const linkDescriptor = (link) => ({
      href: link.getAttribute("href") || "",
      text: link.textContent || ""
    });
    const isLanguageLink = (link) => link.hasAttribute(LANGUAGE_LINK) || isLanguageFooterLink(linkDescriptor(link));
    const topLanguageLinks = (links) => {
      return topLanguageLinkIndexes(links.map(linkDescriptor)).map((index) => links[index]);
    };
    const linksOutside = (root, inner) => [...root.querySelectorAll?.("a[href]") || []].filter((link) => !inner.contains(link));
    const isFooterContainer = (el, inner) => {
      if (!el?.querySelector) return false;
      if (el.querySelector("#pageFooter, .localeSelectorList")) return true;
      const links = linksOutside(el, inner);
      return links.length >= 6 && (topLanguageLinks(links).length >= 2 || links.filter(isLanguageLink).length >= 2);
    };
    const commonAncestor = (nodes) => {
      let root = nodes[0];
      while (root && !nodes.every((node) => root.contains(node))) root = root.parentElement;
      return root;
    };
    const keepLanguageStrip = (col, languageLinks) => {
      const languageRoot = commonAncestor(languageLinks);
      if (!languageRoot || languageRoot === document.body || languageRoot.contains(col)) return;
      let footer = languageRoot;
      while (footer.parentElement && footer.parentElement !== document.body && !footer.parentElement.contains(col)) {
        footer = footer.parentElement;
      }
      languageLinks.forEach((link) => link.setAttribute(LANGUAGE_LINK, ""));
      languageRoot.setAttribute(LANGUAGES, "");
      footer.setAttribute(FOOTER, "");
      for (let node = footer; node; node = node.parentElement) {
        node.removeAttribute(HIDE);
        node.removeAttribute(FOOTER_LINKS);
        if (node !== footer && node !== languageRoot) node.setAttribute(FOOTER_KEEP, "");
        if (node === languageRoot) break;
      }
    };
    const tidyFooter = (col) => {
      clearFooterMarks();
      const allLinks = [...document.querySelectorAll("a[href]")].filter(
        (link) => !col.contains(link)
      );
      const languageLinks = topLanguageLinks(allLinks);
      const languageSet = new Set(languageLinks);
      if (languageLinks.length >= 2) keepLanguageStrip(col, languageLinks);
      for (const link of allLinks) {
        if (languageSet.has(link) || link.hasAttribute(LANGUAGE_LINK)) continue;
        (link.closest("li") || link).setAttribute(FOOTER_LINKS, "");
      }
      for (const el of document.body.querySelectorAll("div, span")) {
        if (el.contains(col) || col.contains(el)) continue;
        if (languageLinks.some((link) => el.contains(link))) continue;
        if (/(\bMeta\s*©|\bMeta\s+\d{4}\b|©\s*\d{4})/i.test(el.textContent || "")) {
          el.setAttribute(FOOTER_LINKS, "");
        }
      }
    };
    function tidy() {
      const html = document.documentElement;
      if (onFacebookHost() && /^\/(?:auth_platform|checkpoint|two_factor|two_step|authentication|recover|confirmemail|device-based)/i.test(
        location.pathname
      )) {
        html.setAttribute("data-carrier-authtext", "");
      } else {
        html.removeAttribute("data-carrier-authtext");
      }
      const pass = document.querySelector('input[name="pass"]');
      const isLogin = onFacebookHost() && !!pass && !!document.querySelector('input[name="email"]');
      if (!isLogin) {
        if (html.hasAttribute("data-carrier-login")) {
          html.removeAttribute("data-carrier-login");
          document.querySelectorAll(`[${HIDE}]`).forEach((el) => el.removeAttribute(HIDE));
          document.querySelectorAll(`[${COL}]`).forEach((el) => el.removeAttribute(COL));
          document.querySelectorAll(`[${ANC}]`).forEach((el) => el.removeAttribute(ANC));
          document.querySelectorAll(`[${FORM}]`).forEach((el) => el.removeAttribute(FORM));
          document.querySelectorAll(`[${CARD}]`).forEach((el) => el.removeAttribute(CARD));
          document.querySelectorAll(`[${REQUIRED}]`).forEach((el) => el.removeAttribute(REQUIRED));
          clearFooterMarks();
          if (html.hasAttribute("data-carrier-darkswap")) {
            html.classList.replace("__fb-dark-mode", "__fb-light-mode");
            html.removeAttribute("data-carrier-darkswap");
          }
        }
        if (tidyObserver && /\bc_user=/.test(document.cookie) && !html.hasAttribute("data-carrier-authtext") && document.readyState === "complete") {
          tidyObserver.disconnect();
          tidyObserver = null;
          window.removeEventListener("resize", schedule);
        }
        return;
      }
      html.setAttribute("data-carrier-login", "");
      const dark = wantDark();
      if (dark && html.classList.contains("__fb-light-mode")) {
        html.classList.replace("__fb-light-mode", "__fb-dark-mode");
        html.setAttribute("data-carrier-darkswap", "");
      } else if (!dark && html.hasAttribute("data-carrier-darkswap")) {
        html.classList.replace("__fb-dark-mode", "__fb-light-mode");
        html.removeAttribute("data-carrier-darkswap");
      }
      const form = pass.closest("form");
      if (!form) return;
      document.querySelectorAll(`[${FORM}]`).forEach((el) => {
        if (el !== form) el.removeAttribute(FORM);
      });
      form.setAttribute(FORM, "");
      let card = form;
      for (let i = 0; i < 4 && card.parentElement; i++) {
        const parent = card.parentElement;
        if (parent === document.body || parent.getBoundingClientRect().width >= window.innerWidth * 0.92)
          break;
        if (isFooterContainer(parent, form)) break;
        if (linksOutside(parent, form).length > 4) break;
        card = parent;
      }
      document.querySelectorAll(`[${CARD}]`).forEach((el) => {
        if (el !== card) el.removeAttribute(CARD);
      });
      card.setAttribute(CARD, "");
      let col = card;
      while (col.parentElement && col.parentElement !== document.body && col.parentElement.getBoundingClientRect().width < window.innerWidth * 0.92 && !isFooterContainer(col.parentElement, form) && linksOutside(col.parentElement, form).length <= 4) {
        col = col.parentElement;
      }
      document.querySelectorAll(`[${COL}]`).forEach((el) => {
        if (el !== col) el.removeAttribute(COL);
      });
      document.querySelectorAll(`[${ANC}]`).forEach((el) => el.removeAttribute(ANC));
      for (let node2 = col; node2 && node2 !== document.body; node2 = node2.parentElement) {
        node2.removeAttribute(HIDE);
        node2.removeAttribute(FOOTER_LINKS);
      }
      form.querySelectorAll(`[${HIDE}], [${FOOTER_LINKS}]`).forEach((el) => {
        el.removeAttribute(HIDE);
        el.removeAttribute(FOOTER_LINKS);
      });
      if (!col.hasAttribute(COL)) col.setAttribute(COL, "");
      html.setAttribute("data-carrier-login-vw", String(Math.round(window.innerWidth)));
      html.setAttribute("data-carrier-login-vh", String(Math.round(window.innerHeight)));
      html.setAttribute(
        "data-carrier-login-col-w",
        String(Math.round(col.getBoundingClientRect().width))
      );
      html.setAttribute(
        "data-carrier-login-card-w",
        String(Math.round(card.getBoundingClientRect().width))
      );
      html.setAttribute(
        "data-carrier-login-form-w",
        String(Math.round(form.getBoundingClientRect().width))
      );
      restoreRequiredLoginUi();
      tidyFooter(col);
      let node = col;
      while (node?.parentElement && node !== document.body) {
        for (const sib of node.parentElement.children) {
          if (sib !== node && sib.hasAttribute(FOOTER)) {
            sib.removeAttribute(HIDE);
            continue;
          }
          if (sib !== node && isRequiredLoginUi(sib)) {
            sib.removeAttribute(HIDE);
            sib.setAttribute(REQUIRED, "");
            continue;
          }
          if (sib !== node && !sib.hasAttribute(HIDE) && !sib.hasAttribute(COL)) {
            sib.setAttribute(HIDE, "");
          }
        }
        if (node !== col && !node.hasAttribute(ANC)) node.setAttribute(ANC, "");
        node = node.parentElement;
      }
      for (const el of document.querySelectorAll("[data-carrier-cleared-bg]")) {
        el.style.removeProperty("background-color");
        el.removeAttribute("data-carrier-cleared-bg");
      }
      if (dark) {
        const clearLight = (el) => {
          if (!isLightFill(getComputedStyle(el).backgroundColor)) return;
          el.setAttribute("data-carrier-cleared-bg", "");
          el.style.setProperty("background-color", "transparent", "important");
        };
        for (const el of document.body.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.5)
            clearLight(el);
        }
        for (const el of col.querySelectorAll("*")) clearLight(el);
      }
    }
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        try {
          tidy();
        } catch (_) {
        }
      });
    };
    schedule();
    tidyObserver = new MutationObserver(schedule);
    tidyObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("carrier:settings", schedule);
    window.addEventListener("resize", schedule);
    for (const delay of [300, 1200]) setTimeout(schedule, delay);
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", schedule);
    }
  }

  // inject/src/messenger/lib/media-autoplay.ts
  var MEDIA_ACTIVATION_GRACE_MS = 1500;
  function shouldSuppressMediaPlay(enabled, lastActivationAt, now, graceMs = MEDIA_ACTIVATION_GRACE_MS) {
    if (!enabled) return false;
    if (!Number.isFinite(lastActivationAt) || !Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs < 0 || lastActivationAt > now) {
      return true;
    }
    return now - lastActivationAt > graceMs;
  }

  // inject/src/messenger/features/media-autoplay.ts
  var VIDEO_SELECTOR = "video";
  function initMediaAutoplay() {
    const on = () => window.__CARRIER_SETTINGS__?.stop_media_autoplay === true;
    let lastActivationAt = Number.NEGATIVE_INFINITY;
    let observer = null;
    const noteActivation = (event) => {
      if (event.isTrusted) lastActivationAt = performance.now();
    };
    window.addEventListener("pointerdown", noteActivation, true);
    window.addEventListener("keydown", noteActivation, true);
    const shouldSuppress = () => shouldSuppressMediaPlay(on(), lastActivationAt, performance.now());
    const suppress = (video, force = false) => {
      if (!on() || !force && !shouldSuppress()) return;
      video.autoplay = false;
      video.removeAttribute("autoplay");
      if (!video.paused) video.pause();
    };
    const scan = (root, force = false) => {
      if (!on()) return;
      if (root.nodeType === Node.ELEMENT_NODE) {
        const element = root;
        if (element.matches(VIDEO_SELECTOR)) suppress(element, force);
        element.querySelectorAll(VIDEO_SELECTOR).forEach((video) => suppress(video, force));
      } else if (root === document) {
        document.querySelectorAll(VIDEO_SELECTOR).forEach((video) => suppress(video, force));
      }
    };
    try {
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function() {
        if (this instanceof HTMLVideoElement && shouldSuppress()) {
          this.autoplay = false;
          this.removeAttribute("autoplay");
          this.pause();
          diag("media.autoplay", "automatic video or GIF playback suppressed");
          return Promise.resolve();
        }
        return originalPlay.call(this);
      };
    } catch (_) {
      diag("media.autoplay.patch", "could not install media playback guard");
    }
    const start = () => {
      if (observer) return;
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) scan(node);
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    };
    const stop = () => {
      observer?.disconnect();
      observer = null;
    };
    const apply = () => {
      if (on()) {
        start();
        scan(document, true);
      } else {
        stop();
      }
    };
    apply();
    window.addEventListener("carrier:settings", apply);
  }

  // inject/src/messenger/lib/media-tracks.ts
  var LiveMediaTrackCounter = class {
    constructor(onChange) {
      __publicField(this, "onChange", onChange);
      __publicField(this, "tracked", /* @__PURE__ */ new WeakSet());
      __publicField(this, "live", 0);
    }
    add(track) {
      if (this.tracked.has(track) || track.readyState === "ended") return;
      this.tracked.add(track);
      let active = true;
      const finish = () => {
        if (!active) return;
        active = false;
        this.live = Math.max(0, this.live - 1);
        this.onChange(this.live > 0);
      };
      this.live += 1;
      this.onChange(true);
      track.addEventListener("ended", finish, { once: true });
      const originalStop = track.stop.bind(track);
      track.stop = () => {
        try {
          originalStop();
        } finally {
          finish();
        }
      };
    }
    count() {
      return this.live;
    }
  };

  // inject/src/messenger/features/media-permissions.ts
  function initMediaPermissionWarning() {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const original = md.getUserMedia.bind(md);
    const liveTracks = new LiveMediaTrackCounter((inCall) => {
      window.__carrierInCall = inCall;
      window.dispatchEvent(new Event("carrier:protection-change"));
    });
    md.getUserMedia = async (constraints) => {
      try {
        const stream = await original(constraints);
        stream.getTracks().forEach((track) => liveTracks.add(track));
        return stream;
      } catch (err) {
        const name = err?.name;
        if (err && (name === "NotAllowedError" || name === "NotFoundError")) {
          const kind = constraints?.video ? "camera" : "microphone";
          toast(`Carrier needs ${kind} access — check System Settings → Privacy & Security`);
          const pane = kind === "camera" ? "Privacy_Camera" : "Privacy_Microphone";
          openUrl(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
        }
        throw err;
      }
    };
  }

  // inject/src/messenger/features/media-viewer.ts
  function initMediaViewer() {
    const MIN = 1;
    const MAX = 8;
    const STEP = 1.15;
    const PAN = 40;
    let target = null;
    let targetCssText = "";
    let targetTabIndex = null;
    let previousFocus = null;
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let active = false;
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let stx = 0;
    let sty = 0;
    function pickTarget(e) {
      const t = e.target;
      const video = t.closest("video") || t.closest("div")?.querySelector("video");
      if (video) return video;
      const img = t.closest("img[alt]");
      if (!img) return null;
      const src = img.currentSrc || img.src || "";
      if (src.startsWith("data:") || src.includes("stp=dst-png_s")) return null;
      return img;
    }
    function render(animated = true) {
      if (!target) return;
      const reset = scale === 1 && tx === 0 && ty === 0;
      target.style.transition = !animated || dragging ? "none" : "transform .15s cubic-bezier(0,0,.2,1)";
      target.style.transformOrigin = "center center";
      target.style.zIndex = reset ? "" : "1000";
      target.style.maxWidth = reset ? "" : "none";
      target.style.maxHeight = reset ? "" : "none";
      target.style.transform = reset ? "" : `translate(${tx}px,${ty}px) scale(${scale})`;
      target.style.cursor = reset ? "zoom-in" : dragging ? "grabbing" : "grab";
    }
    function exit() {
      if (!active) return;
      active = false;
      handlers.forEach(([t, f, o]) => {
        document.removeEventListener(t, f, o);
      });
      const closedTarget = target;
      if (closedTarget) {
        closedTarget.style.cssText = targetCssText;
        if (targetTabIndex === null) closedTarget.removeAttribute("tabindex");
        else closedTarget.setAttribute("tabindex", targetTabIndex);
      }
      target = null;
      targetCssText = "";
      targetTabIndex = null;
      scale = 1;
      tx = 0;
      ty = 0;
      dragging = false;
      previousFocus?.focus({ preventScroll: true });
      previousFocus = null;
    }
    const onWheel = (e) => {
      if (!target) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const r = target.getBoundingClientRect();
      const prev = scale;
      scale = e.deltaY < 0 ? Math.min(MAX, scale * STEP) : Math.max(MIN, scale / STEP);
      if (scale <= 1) {
        tx = 0;
        ty = 0;
      } else {
        const k = scale / prev;
        tx += (e.clientX - (r.left + r.width / 2)) * (1 - k);
        ty += (e.clientY - (r.top + r.height / 2)) * (1 - k);
      }
      render();
    };
    const onDown = (e) => {
      if (e.button !== 0 || scale <= 1 || !target?.contains(e.target)) return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      stx = tx;
      sty = ty;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onMove = (e) => {
      if (!dragging) return;
      tx = stx + (e.clientX - sx);
      ty = sty + (e.clientY - sy);
      render();
    };
    const onUp = () => {
      dragging = false;
      render();
    };
    const onKey = (e) => {
      if (e.key === "Escape") return exit();
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopImmediatePropagation();
        target?.focus({ preventScroll: true });
        return;
      }
      const d = {
        ArrowLeft: [PAN, 0],
        ArrowRight: [-PAN, 0],
        ArrowUp: [0, PAN],
        ArrowDown: [0, -PAN]
      }[e.key];
      if (d && scale > 1) {
        e.preventDefault();
        e.stopImmediatePropagation();
        tx += d[0];
        ty += d[1];
        render();
      }
    };
    const onClick = (e) => {
      if (active && target && !target.contains(e.target)) exit();
    };
    const handlers = [
      ["wheel", onWheel, { passive: false, capture: true }],
      ["mousedown", onDown, { capture: true }],
      ["mousemove", onMove, { capture: true }],
      ["mouseup", onUp, { capture: true }],
      ["keydown", onKey, { capture: true }],
      ["click", onClick, { capture: true }]
    ];
    document.addEventListener(
      "dblclick",
      (e) => {
        const t = pickTarget(e);
        if (!t) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (active) return exit();
        active = true;
        target = t;
        targetCssText = t.style.cssText;
        targetTabIndex = t.getAttribute("tabindex");
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        t.setAttribute("tabindex", "-1");
        const r = t.getBoundingClientRect();
        scale = 2;
        tx = (e.clientX - (r.left + r.width / 2)) * (1 - scale);
        ty = (e.clientY - (r.top + r.height / 2)) * (1 - scale);
        render(false);
        t.focus({ preventScroll: true });
        handlers.forEach(([type, f, o]) => {
          document.addEventListener(type, f, o);
        });
      },
      { capture: true }
    );
  }

  // inject/src/messenger/lib/emoji.ts
  var EMOJI_SOURCE_RE = /(?:emoji|emoji\.php|\/images\/emoji)/i;
  var SYSTEM_EMOJI_GLYPH_ATTR = "data-carrier-system-emoji-glyph";
  var EMOJI_TEXT_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}]/u;
  var LABEL_TEXT_RE = /[\p{Letter}\p{Number}]/u;
  var KEYCAP_RE = /[#*0-9]️?⃣/gu;
  function emojiGlyph(value) {
    const text = String(value || "").trim();
    if (!text || text.length > 24 || !EMOJI_TEXT_RE.test(text)) return "";
    if (LABEL_TEXT_RE.test(text.replace(KEYCAP_RE, ""))) return "";
    return text;
  }
  function isReactionMenuShape(children) {
    if (children.length < 6 || children.length > 9) return false;
    const addButton = children.at(-1);
    return addButton?.glyphs === 0 && addButton.role === "button" && children.slice(0, -1).every((child) => child.glyphs === 1);
  }

  // inject/src/messenger/lib/conversation-row.ts
  function conversationNodeText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (node.getAttribute?.(SYSTEM_EMOJI_GLYPH_ATTR) != null) return "";
    if ((node.tagName || "").toUpperCase() === "IMG") {
      const source = node.getAttribute?.("src") || "";
      return !source || EMOJI_SOURCE_RE.test(source) ? emojiGlyph(node.getAttribute?.("alt")) : "";
    }
    let text = "";
    for (const child of Array.from(node.childNodes || [])) text += conversationNodeText(child);
    return text || emojiGlyph(node.getAttribute?.("aria-label"));
  }
  function plainNodeText(node) {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    let text = "";
    for (const child of Array.from(node.childNodes || [])) text += plainNodeText(child);
    return text;
  }
  function hasCandidateTextChild(node) {
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType !== 1) continue;
      if (child.getAttribute?.(SYSTEM_EMOJI_GLYPH_ATTR) != null) continue;
      if (plainNodeText(child).trim()) return true;
    }
    return false;
  }
  function conversationTextParts(candidates) {
    const values = [];
    for (const candidate of candidates.filter(
      ({ text, width, height, ariaHidden, inAbbreviation, hasTextChild }) => !ariaHidden && !inAbbreviation && !hasTextChild && width > 1 && height > 1 && text.trim().length > 0
    ).sort((left, right) => left.y - right.y || left.x - right.x)) {
      const text = candidate.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const last = values[values.length - 1];
      if (last && Math.abs(last.y - candidate.y) < 1) {
        if (last.text.includes(text)) continue;
        if (text.includes(last.text)) {
          values[values.length - 1] = { text, y: candidate.y };
          continue;
        }
      }
      values.push({ text, y: candidate.y });
    }
    return {
      title: (values[0]?.text || "Messenger").slice(0, 80),
      body: (values[1]?.text || "").slice(0, 240)
    };
  }
  function isUnreadConversationText(fontWeight, text) {
    const weight = typeof fontWeight === "number" ? fontWeight : Number.parseInt(fontWeight, 10) || 0;
    return weight >= 600 && text.trim().length > 1;
  }

  // inject/src/messenger/lib/notification-fallback.ts
  var READ_SINCE_LIMIT = 500;
  var ConversationNotificationTracker = class {
    constructor() {
      __publicField(this, "signatures", /* @__PURE__ */ new Map());
      /**
       * Threads observed rendered-and-read, waiting for their next message. A read
       * row's signature is dropped below along with every other non-unread row, so
       * without this set the thread comes back as a first sighting and primes
       * silently — the first message after you read a conversation would never
       * notify, however different its preview text.
       */
      __publicField(this, "readSince", /* @__PURE__ */ new Set());
      __publicField(this, "primed", false);
    }
    /**
     * `confirmedRead` — threads the caller has observed hydrated-and-read across
     * scans spanning real time. Single-scan read state is not enough: mid-
     * hydration a row can render its text before its unread styling, and that
     * flap would otherwise report as a new message.
     */
    observe(current, observedKeys, confirmedRead, readTransitions) {
      const currentKeys = /* @__PURE__ */ new Set();
      const changed = [];
      for (const conversation of current) {
        currentKeys.add(conversation.key);
        const previous = this.signatures.get(conversation.key);
        const wasRead = this.readSince.delete(conversation.key);
        this.signatures.set(conversation.key, conversation.signature);
        if (!this.primed) continue;
        if (wasRead || previous !== void 0 && previous !== conversation.signature) {
          changed.push(conversation.key);
          if (wasRead) readTransitions?.add(conversation.key);
        }
      }
      for (const key of observedKeys || currentKeys) {
        if (!currentKeys.has(key)) this.signatures.delete(key);
      }
      for (const key of confirmedRead || []) {
        if (currentKeys.has(key) || this.readSince.has(key)) continue;
        this.readSince.add(key);
        if (this.readSince.size > READ_SINCE_LIMIT) {
          this.readSince.delete(this.readSince.keys().next().value);
        }
      }
      this.primed = true;
      return changed;
    }
  };
  var normalizeNotificationText = (value) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  var hashText = (value) => {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (const byte of new TextEncoder().encode(value)) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * prime);
    }
    return hash.toString(16).padStart(16, "0");
  };
  var matchesExactOrTruncated = (left, right) => {
    if (left === right) return true;
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    return shorter.length >= 40 && longer.startsWith(shorter);
  };
  var splitGroupSender = (value) => {
    const separator = value.indexOf(": ");
    if (separator <= 0 || separator > 80) return { sender: null, message: value };
    return { sender: value.slice(0, separator), message: value.slice(separator + 2) };
  };
  function notificationDedupeKey(title, body) {
    const value = `${normalizeNotificationText(title)}\0${normalizeNotificationText(body)}`;
    return hashText(value);
  }
  function notificationDeliveryDedupeKey(fingerprint, generation) {
    return generation === void 0 ? fingerprint : notificationDedupeKey(fingerprint, generation);
  }
  var NOTIFIED_STORE_LIMIT = 300;
  var NOTIFIED_STORE_VERSION = 3;
  var NOTIFIED_STORE_TEXT_VERSION = 2;
  var LEGACY_PLACEHOLDER_BODY = "New message";
  var STABLE_READ_MS = 3e4;
  var READ_DROP_CONFIRM_MS = 2e4;
  var READ_DROP_MIN_OBSERVATIONS = 3;
  var READ_TRANSITION_CONFIRM_MS = READ_DROP_CONFIRM_MS;
  var READ_TRANSITION_MIN_OBSERVATIONS = READ_DROP_MIN_OBSERVATIONS;
  var RETIRED_FINGERPRINT_TTL_MS = 3e4;
  var NotifiedSignatureStore = class {
    constructor(storage = null, storageKey = "__carrier_notified_previews__") {
      __publicField(this, "storage", storage);
      __publicField(this, "storageKey", storageKey);
      __publicField(this, "entries", /* @__PURE__ */ new Map());
      /**
       * Fingerprints retired by a confirmed read. These survive a prompt reload so
       * the next unread transition can identify an identical preview as a fresh
       * delivery while the native content-key dedupe is still active.
       */
      __publicField(this, "readFingerprints", /* @__PURE__ */ new Map());
      /**
       * In-memory only: when each continuously observed read state began, and how
       * many consecutive scans have seen it.
       */
      __publicField(this, "readStreaks", /* @__PURE__ */ new Map());
      /** Entries whose unread state has been established in this document. */
      __publicField(this, "observedUnread", /* @__PURE__ */ new Set());
      try {
        const raw = this.storage?.getItem(this.storageKey);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const legacy = Array.isArray(parsed);
        const version = !legacy && parsed && typeof parsed === "object" && "version" in parsed ? parsed.version : null;
        const persistedEntries = legacy || (version === NOTIFIED_STORE_VERSION || version === NOTIFIED_STORE_TEXT_VERSION) && parsed && typeof parsed === "object" && "entries" in parsed && Array.isArray(parsed.entries) ? legacy ? parsed : parsed.entries ?? [] : [];
        for (const entry of persistedEntries) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && (legacy || typeof entry[2] === "boolean")) {
            this.entries.set(entry[0], {
              fingerprint: entry[1],
              legacy: legacy || entry[2],
              bodyHash: typeof entry[3] === "string" ? entry[3] : void 0
            });
          }
        }
        if (version === NOTIFIED_STORE_VERSION && parsed && typeof parsed === "object" && "retired" in parsed && Array.isArray(parsed.retired)) {
          const now = Date.now();
          for (const retired of parsed.retired) {
            if (Array.isArray(retired) && typeof retired[0] === "string" && typeof retired[1] === "string" && typeof retired[2] === "number" && now - retired[2] <= RETIRED_FINGERPRINT_TTL_MS) {
              this.readFingerprints.set(retired[0], {
                fingerprint: retired[1],
                retiredAt: retired[2]
              });
            }
          }
        }
      } catch (_) {
      }
      let trimmed = false;
      while (this.entries.size > NOTIFIED_STORE_LIMIT) {
        this.entries.delete(this.entries.keys().next().value);
        trimmed = true;
      }
      while (this.readFingerprints.size > NOTIFIED_STORE_LIMIT) {
        this.readFingerprints.delete(this.readFingerprints.keys().next().value);
        trimmed = true;
      }
      if (trimmed) this.persist();
    }
    persist() {
      try {
        this.storage?.setItem(
          this.storageKey,
          JSON.stringify({
            version: NOTIFIED_STORE_VERSION,
            entries: [...this.entries].map(
              ([key, entry]) => entry.bodyHash === void 0 ? [key, entry.fingerprint, entry.legacy] : [key, entry.fingerprint, entry.legacy, entry.bodyHash]
            ),
            retired: [...this.readFingerprints].map(([key, retired]) => [
              key,
              retired.fingerprint,
              retired.retiredAt
            ])
          })
        );
      } catch (_) {
      }
    }
    alreadyNotified(conversationKey, fingerprint) {
      return this.entries.get(conversationKey)?.fingerprint === fingerprint;
    }
    /** The fingerprint last delivered for this conversation, if any. */
    notifiedFingerprint(conversationKey) {
      return this.entries.get(conversationKey)?.fingerprint;
    }
    /**
     * Compare a hydrated row with its persisted delivery. Old unversioned entries
     * may contain the synthetic "New message" body from pre-v2 hydration scans;
     * migrate only those proven-legacy placeholders, never a new-schema message
     * whose real text happens to be the same phrase.
     */
    reconcileFingerprint(conversationKey, title, fingerprint, bodyHash, confirmedReadTransition = false) {
      const entry = this.entries.get(conversationKey);
      const retired = this.readFingerprints.get(conversationKey);
      const retiredFingerprint = retired && Date.now() - retired.retiredAt <= RETIRED_FINGERPRINT_TTL_MS ? retired.fingerprint : void 0;
      if (confirmedReadTransition || retiredFingerprint !== void 0) {
        const deliveredFingerprint = entry?.fingerprint ?? retiredFingerprint;
        if (this.readFingerprints.delete(conversationKey)) this.persist();
        if (deliveredFingerprint === fingerprint || bodyHash !== void 0 && entry?.bodyHash === bodyHash) {
          return "repeated";
        }
      }
      if (!entry) return "missing";
      if (entry.fingerprint === fingerprint) {
        if (entry.legacy || bodyHash !== void 0 && entry.bodyHash === void 0) {
          entry.legacy = false;
          if (bodyHash !== void 0) entry.bodyHash = bodyHash;
          this.persist();
        }
        return "matched";
      }
      if (bodyHash !== void 0 && entry.bodyHash !== void 0 && entry.bodyHash === bodyHash) {
        entry.fingerprint = fingerprint;
        entry.legacy = false;
        this.persist();
        return "matched";
      }
      const legacyPlaceholder = entry.legacy && (entry.fingerprint === notificationDedupeKey(title, LEGACY_PLACEHOLDER_BODY) || entry.fingerprint === notificationDedupeKey("Messenger", LEGACY_PLACEHOLDER_BODY));
      if (!legacyPlaceholder) return "mismatched";
      entry.fingerprint = fingerprint;
      entry.legacy = false;
      entry.bodyHash = bodyHash;
      this.persist();
      return "migrated";
    }
    markNotified(conversationKey, fingerprint, bodyHash) {
      this.readStreaks.delete(conversationKey);
      const retired = this.readFingerprints.delete(conversationKey);
      const current = this.entries.get(conversationKey);
      if (current?.fingerprint === fingerprint && !current.legacy) {
        if (bodyHash !== void 0 && current.bodyHash !== bodyHash) {
          current.bodyHash = bodyHash;
          this.persist();
        } else if (retired) {
          this.persist();
        }
        return;
      }
      this.entries.delete(conversationKey);
      this.entries.set(conversationKey, { fingerprint, legacy: false, bodyHash });
      while (this.entries.size > NOTIFIED_STORE_LIMIT) {
        const oldest = this.entries.keys().next().value;
        this.entries.delete(oldest);
        this.readStreaks.delete(oldest);
        this.observedUnread.delete(oldest);
        this.readFingerprints.delete(oldest);
      }
      this.persist();
    }
    /**
     * Forget conversations that are rendered without an unread preview — the
     * user has read them, so an identical future preview must notify again.
     * Persisted entries must remain continuously observed read for
     * [[STABLE_READ_MS]] until this document has first established their unread
     * state. After that, [[READ_DROP_CONFIRM_MS]] and
     * [[READ_DROP_MIN_OBSERVATIONS]] together confirm a real unread-to-read
     * transition. An unread or missing observation resets the streak so
     * virtualized rows cannot accumulate read time off-screen.
     *
     * `listHydrated` — every rendered row currently carries preview text. A
     * partially hydrated list is precisely when a still-unread row renders its
     * text before its unread styling, so such a scan is treated as no evidence
     * either way: it neither advances nor is allowed to satisfy a streak.
     */
    observeRead(unreadKeys, observedKeys, observedAt = Date.now(), listHydrated = true) {
      let dropped = false;
      const observed = new Set(observedKeys);
      for (const key of this.readStreaks.keys()) {
        if (!observed.has(key)) this.readStreaks.delete(key);
      }
      for (const key of observed) {
        if (!listHydrated) {
          this.readStreaks.delete(key);
          continue;
        }
        if (unreadKeys.has(key)) {
          this.readStreaks.delete(key);
          if (this.entries.has(key)) this.observedUnread.add(key);
          continue;
        }
        if (!this.entries.has(key)) continue;
        const streak = this.readStreaks.get(key);
        if (streak === void 0 || observedAt < streak.since) {
          this.readStreaks.set(key, { since: observedAt, observations: 1 });
          continue;
        }
        streak.observations += 1;
        const confirmAfter = this.observedUnread.has(key) ? READ_DROP_CONFIRM_MS : STABLE_READ_MS;
        if (observedAt - streak.since < confirmAfter) continue;
        if (streak.observations < READ_DROP_MIN_OBSERVATIONS) continue;
        this.readStreaks.delete(key);
        this.observedUnread.delete(key);
        this.readFingerprints.delete(key);
        this.readFingerprints.set(key, {
          fingerprint: this.entries.get(key).fingerprint,
          retiredAt: Date.now()
        });
        while (this.readFingerprints.size > NOTIFIED_STORE_LIMIT) {
          this.readFingerprints.delete(this.readFingerprints.keys().next().value);
        }
        this.entries.delete(key);
        dropped = true;
      }
      if (dropped) this.persist();
    }
  };
  var HASH_RE = /^[0-9a-f]{16}$/;
  var MIN_TRUNCATED_MATCH_LENGTH = 40;
  var TITLE_PREFIX_LIMIT = 80;
  var BODY_PREFIX_LIMIT = 240;
  var PAGE_RECEIPT_LIMIT = 20;
  var PAGE_NOTIFICATION_RECEIPT_TTL_MS = 12e4;
  var receiptMatch = (receipt) => receipt.nativeDelivery === void 0 ? { nativeId: receipt.nativeId } : { nativeId: receipt.nativeId, nativeDelivery: receipt.nativeDelivery };
  var opaqueTextIdentity = (value, prefixLimit) => {
    const prefixes = [];
    const lastPrefix = Math.min(value.length - 1, prefixLimit);
    for (let length = MIN_TRUNCATED_MATCH_LENGTH; length <= lastPrefix; length++) {
      prefixes.push([length, hashText(value.slice(0, length))]);
    }
    return { length: value.length, full: hashText(value), prefixes };
  };
  var opaqueNotificationIdentity = (title, body) => {
    const normalizedTitle = normalizeNotificationText(title);
    const normalizedBody = normalizeNotificationText(body);
    const group = splitGroupSender(normalizedBody);
    return {
      title: opaqueTextIdentity(normalizedTitle, TITLE_PREFIX_LIMIT),
      body: opaqueTextIdentity(normalizedBody, BODY_PREFIX_LIMIT),
      sender: group.sender === null ? null : hashText(group.sender),
      message: opaqueTextIdentity(group.message, BODY_PREFIX_LIMIT)
    };
  };
  var opaqueTextMatches = (left, right) => {
    if (left.full === right.full) return true;
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    if (shorter.length < MIN_TRUNCATED_MATCH_LENGTH) return false;
    return longer.prefixes.some(
      ([length, fingerprint]) => length === shorter.length && fingerprint === shorter.full
    );
  };
  var opaqueNotificationMatches = (left, right) => {
    if (!opaqueTextMatches(left.title, right.title)) return false;
    if (left.body.length === 0 || right.body.length === 0) return true;
    if (opaqueTextMatches(left.body, right.body)) return true;
    const sendersCompatible = left.sender === null || right.sender === null || left.sender === right.sender;
    return sendersCompatible && opaqueTextMatches(left.message, right.message);
  };
  var validOpaqueTextIdentity = (value, prefixLimit) => {
    if (!value || typeof value !== "object") return false;
    const identity = value;
    return Number.isSafeInteger(identity.length) && identity.length >= 0 && typeof identity.full === "string" && HASH_RE.test(identity.full) && Array.isArray(identity.prefixes) && identity.prefixes.length <= prefixLimit - MIN_TRUNCATED_MATCH_LENGTH + 1 && identity.prefixes.every(
      (prefix) => Array.isArray(prefix) && Number.isSafeInteger(prefix[0]) && prefix[0] >= MIN_TRUNCATED_MATCH_LENGTH && prefix[0] <= prefixLimit && prefix[0] < identity.length && typeof prefix[1] === "string" && HASH_RE.test(prefix[1])
    );
  };
  var validOpaqueNotificationIdentity = (value) => {
    if (!value || typeof value !== "object") return false;
    const identity = value;
    return validOpaqueTextIdentity(identity.title, TITLE_PREFIX_LIMIT) && validOpaqueTextIdentity(identity.body, BODY_PREFIX_LIMIT) && validOpaqueTextIdentity(identity.message, BODY_PREFIX_LIMIT) && (identity.sender === null || typeof identity.sender === "string" && HASH_RE.test(identity.sender));
  };
  var PageNotificationReceiptStore = class {
    constructor(storage = null, storageKey = "__carrier_page_notification_receipts__", ttlMs = PAGE_NOTIFICATION_RECEIPT_TTL_MS, now = Date.now()) {
      __publicField(this, "storage", storage);
      __publicField(this, "storageKey", storageKey);
      __publicField(this, "ttlMs", ttlMs);
      __publicField(this, "receipts", []);
      try {
        const parsed = JSON.parse(this.storage?.getItem(this.storageKey) || "[]");
        if (Array.isArray(parsed)) {
          for (const receipt of parsed) {
            if (!receipt || typeof receipt !== "object") continue;
            const candidate = receipt;
            if (typeof candidate.at === "number" && Number.isFinite(candidate.at) && typeof candidate.nativeId === "number" && Number.isSafeInteger(candidate.nativeId) && candidate.nativeId > 0 && validOpaqueNotificationIdentity(candidate.identity) && (candidate.nativeDelivery === void 0 || candidate.nativeDelivery === "accepted" || candidate.nativeDelivery === "duplicate" || candidate.nativeDelivery === "suppressed") && now - candidate.at >= 0 && now - candidate.at <= this.ttlMs) {
              this.receipts.push(candidate);
            }
          }
        }
      } catch (_) {
      }
      if (this.receipts.length > PAGE_RECEIPT_LIMIT) {
        this.receipts.splice(0, this.receipts.length - PAGE_RECEIPT_LIMIT);
      }
      this.persist();
    }
    persist() {
      try {
        this.storage?.setItem(this.storageKey, JSON.stringify(this.receipts));
      } catch (_) {
      }
    }
    prune(now) {
      let changed = false;
      for (let index = this.receipts.length - 1; index >= 0; index--) {
        const age = now - this.receipts[index].at;
        if (age < 0 || age > this.ttlMs) {
          this.receipts.splice(index, 1);
          changed = true;
        }
      }
      if (changed) this.persist();
    }
    add(title, body, nativeId, at = Date.now()) {
      this.prune(at);
      this.receipts.push({ at, nativeId, identity: opaqueNotificationIdentity(title, body) });
      if (this.receipts.length > PAGE_RECEIPT_LIMIT) this.receipts.shift();
      this.persist();
    }
    recordDelivery(nativeId, delivery) {
      const receipt = this.receipts.find((candidate) => candidate.nativeId === nativeId);
      if (!receipt) return;
      receipt.nativeDelivery = delivery;
      this.persist();
    }
    consumeMatching(row, now = Date.now()) {
      this.prune(now);
      if (!this.receipts.length) return null;
      const identity = opaqueNotificationIdentity(row.title, row.body);
      for (let index = this.receipts.length - 1; index >= 0; index--) {
        const receipt = this.receipts[index];
        if (!opaqueNotificationMatches(receipt.identity, identity)) continue;
        this.receipts.splice(index, 1);
        this.persist();
        return receiptMatch(receipt);
      }
      return null;
    }
    /**
     * Consume receipts that match exactly one of the given rows, keyed by that
     * row's conversation key. A receipt is only title/body identity, so when
     * several visible threads share the same display text, guessing would route
     * the native click to the wrong conversation and mark it delivered — an
     * ambiguous receipt is DROPPED instead: Messenger virtualizes the list, so
     * waiting for a unique match could just as well settle it onto the wrong
     * twin once the other scrolls away. Duplicate anchors for one thread count
     * as a single row.
     */
    consumeUniquelyMatching(rows, now = Date.now()) {
      this.prune(now);
      const consumed = /* @__PURE__ */ new Map();
      if (!this.receipts.length) return consumed;
      const identities = /* @__PURE__ */ new Map();
      for (const row of rows) {
        if (!identities.has(row.key)) {
          identities.set(row.key, opaqueNotificationIdentity(row.title, row.body));
        }
      }
      const remove = [];
      for (let index = 0; index < this.receipts.length; index++) {
        const receipt = this.receipts[index];
        let match = null;
        let ambiguous = false;
        for (const [key, identity] of identities) {
          if (!opaqueNotificationMatches(receipt.identity, identity)) continue;
          if (match !== null && match !== key) {
            ambiguous = true;
            break;
          }
          match = key;
        }
        if (match === null) continue;
        remove.push(index);
        if (ambiguous || consumed.has(match)) continue;
        consumed.set(match, receiptMatch(receipt));
      }
      for (let i = remove.length - 1; i >= 0; i--) this.receipts.splice(remove[i], 1);
      if (remove.length) this.persist();
      return consumed;
    }
    /**
     * Drop receipts whose notification was evidently read: the receipt matches
     * a read rendered row. Left in place, it would survive up to its TTL and
     * later swallow the pairing for a NEW identical-text message, suppressing
     * that message's only notification. This drops even when an unread twin
     * shares the text — the receipt's true thread is unknowable then, and a
     * duplicate fallback (absorbed by the native dedupe) beats misrouting the
     * click or marking the wrong thread delivered.
     */
    discardReadMatches(readRows, now = Date.now()) {
      this.prune(now);
      if (!this.receipts.length) return;
      const read = [...readRows].map((row) => opaqueNotificationIdentity(row.title, row.body));
      if (!read.length) return;
      let changed = false;
      for (let index = this.receipts.length - 1; index >= 0; index--) {
        const receipt = this.receipts[index];
        if (!read.some((identity) => opaqueNotificationMatches(receipt.identity, identity))) {
          continue;
        }
        this.receipts.splice(index, 1);
        changed = true;
      }
      if (changed) this.persist();
    }
  };
  var PageNotificationQueue = class {
    constructor() {
      __publicField(this, "signals", []);
    }
    add(signal) {
      this.signals.push(signal);
      if (this.signals.length > 20) this.signals.shift();
      return signal;
    }
    /**
     * Return (and remove) the queued page signal that matches this row, or null.
     * Returning the signal — rather than a boolean — lets the caller reach its
     * `nativeId` and route the already-emitted page-first notification.
     */
    consumeMatching(row, rowChangeAt, matchWindowMs, candidateRows) {
      for (let index2 = this.signals.length - 1; index2 >= 0; index2--) {
        const signal2 = this.signals[index2];
        const age = rowChangeAt - signal2.at;
        if (age > matchWindowMs) {
          this.signals.splice(index2, 1);
        }
      }
      const matches = [];
      for (let index2 = this.signals.length - 1; index2 >= 0; index2--) {
        const signal2 = this.signals[index2];
        const age = rowChangeAt - signal2.at;
        if (age >= 0 && notificationTextMatches(signal2.title, signal2.body, row.title, row.body)) {
          matches.push(index2);
        }
      }
      if (matches.length !== 1) {
        for (const index2 of matches) this.signals.splice(index2, 1);
        return null;
      }
      const index = matches[0];
      const signal = this.signals[index];
      if (candidateRows) {
        const candidateKeys = /* @__PURE__ */ new Set();
        for (const candidate of candidateRows) {
          if (notificationTextMatches(signal.title, signal.body, candidate.title, candidate.body)) {
            candidateKeys.add(candidate.key);
          }
        }
        if (candidateKeys.size !== 1 || row.key !== void 0 && !candidateKeys.has(row.key)) {
          this.signals.splice(index, 1);
          return null;
        }
      }
      this.signals.splice(index, 1);
      signal.matched = true;
      return signal;
    }
  };
  var UnreadArrivalTracker = class {
    constructor(settleMs = 0) {
      __publicField(this, "settleMs", settleMs);
      __publicField(this, "changedAt", /* @__PURE__ */ new Map());
      __publicField(this, "unreadCount", null);
      __publicField(this, "firstObservedAt", null);
      __publicField(this, "sawDeferredZero", false);
    }
    markRowsChanged(keys, at) {
      for (const key of keys) this.changedAt.set(key, { changedAt: at, eligibleUntil: at });
    }
    /**
     * `zeroCorroborated` — the caller observed a fully hydrated conversation
     * list containing no unread rows, so a zero count is the inbox's real
     * state rather than a still-unstamped title. A corroborated zero baselines
     * immediately, letting a first arrival inside the settle window report
     * instead of being absorbed as priming.
     *
     * `readObservedKeys` — threads this document has already seen rendered
     * hydrated-and-read. A mutated row from that set turning up in an early
     * count increase is a real read→unread transition, never title hydration
     * (hydrating rows are never observed read first), so it can be reported
     * even inside the settle window after an uncorroborated zero.
     */
    observeUnreadCount(count, at, maxMutationAgeMs, zeroCorroborated = false, readObservedKeys, currentUnreadKeys) {
      for (const [key, candidate] of this.changedAt) {
        candidate.eligibleUntil = Math.max(
          candidate.eligibleUntil,
          candidate.changedAt + maxMutationAgeMs
        );
        if (at > candidate.eligibleUntil) this.changedAt.delete(key);
      }
      if (this.firstObservedAt === null) this.firstObservedAt = at;
      const settled = at - this.firstObservedAt >= this.settleMs;
      if (this.unreadCount === null && count === 0 && !settled && !zeroCorroborated) {
        this.sawDeferredZero = true;
        return [];
      }
      let previous = this.unreadCount;
      this.unreadCount = count;
      if (previous === null) {
        if (!(this.sawDeferredZero && settled && count > 0)) {
          if (this.sawDeferredZero && count > 0 && readObservedKeys) {
            const transitions = [...this.changedAt].filter(([key]) => readObservedKeys.has(key)).sort((left, right) => right[1].changedAt - left[1].changedAt).slice(0, count).map(([key]) => key);
            if (transitions.length) {
              this.changedAt.clear();
              return transitions;
            }
          }
          this.changedAt.clear();
          return [];
        }
        previous = 0;
      }
      const candidates = [...this.changedAt].filter(([key]) => currentUnreadKeys === void 0 || currentUnreadKeys.has(key)).sort((left, right) => right[1].changedAt - left[1].changedAt).slice(0, Math.max(0, count - previous)).map(([key]) => key);
      for (const key of candidates) this.changedAt.delete(key);
      return candidates;
    }
  };
  var StableMismatchTracker = class {
    constructor(stableMs) {
      __publicField(this, "stableMs", stableMs);
      __publicField(this, "streaks", /* @__PURE__ */ new Map());
    }
    observe(mismatches, at = Date.now()) {
      const seen = /* @__PURE__ */ new Set();
      const recovered = [];
      let confirmInMs = null;
      for (const [key, fingerprint] of mismatches) {
        if (seen.has(key)) continue;
        seen.add(key);
        const streak = this.streaks.get(key);
        if (streak?.fingerprint === fingerprint) {
          if (at < streak.since) {
            streak.since = at;
            streak.reported = false;
          }
          const remaining = Math.max(0, this.stableMs - (at - streak.since));
          if (!streak.reported && remaining === 0) {
            streak.reported = true;
            recovered.push(key);
          } else if (!streak.reported) {
            confirmInMs = confirmInMs === null ? remaining : Math.min(confirmInMs, remaining);
          }
          continue;
        }
        const reported = this.stableMs === 0;
        this.streaks.set(key, { fingerprint, since: at, reported });
        if (reported) {
          recovered.push(key);
        } else {
          confirmInMs = confirmInMs === null ? this.stableMs : Math.min(confirmInMs, this.stableMs);
        }
      }
      for (const key of this.streaks.keys()) {
        if (!seen.has(key)) this.streaks.delete(key);
      }
      return { recovered, confirmInMs };
    }
  };
  function groupPreviewSender(value) {
    return splitGroupSender(value.replace(/\s+/g, " ").trim()).sender || "";
  }
  function isOwnMessagePreview(value) {
    return /^(?:you|du|me|meg):|^(?:you|du|me|meg)\s+(?:sent|replied|forwarded|reacted|sendte|svarte|videresendte|reagerte)\b/i.test(
      value.trim().replace(/\s+/g, " ")
    );
  }
  function notificationTextMatches(pageTitle, pageBody, rowTitle, rowBody) {
    const normalizedPageTitle = normalizeNotificationText(pageTitle);
    const normalizedRowTitle = normalizeNotificationText(rowTitle);
    const titlesMatch = matchesExactOrTruncated(normalizedPageTitle, normalizedRowTitle);
    const normalizedPageBody = normalizeNotificationText(pageBody);
    const normalizedRowBody = normalizeNotificationText(rowBody);
    const page = splitGroupSender(normalizedPageBody);
    const row = splitGroupSender(normalizedRowBody);
    const sendersCompatible = page.sender === null || row.sender === null || page.sender === row.sender;
    return titlesMatch && (!normalizedPageBody || !normalizedRowBody || matchesExactOrTruncated(normalizedPageBody, normalizedRowBody) || sendersCompatible && matchesExactOrTruncated(page.message, row.message));
  }

  // inject/src/messenger/lib/sender-avatars.ts
  var SENDER_AVATAR_LIMIT = 500;
  var SENDER_AVATAR_VERSION = 3;
  var SENDER_AVATAR_STORAGE_KEY = "__carrier_sender_avatars__";
  var normalizeSenderName = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
  var entryKey = (threadId, name) => `${threadId}\0${normalizeSenderName(name)}`;
  function avatarPhotoId(url) {
    try {
      return new URL(url, "https://www.facebook.com/").pathname;
    } catch (_) {
      return url;
    }
  }
  var COLLISION_WINDOW_MS = 5 * 6e4;
  var GROUP_THREAD_LIMIT = 200;
  var AMBIGUOUS_LIMIT = 200;
  var SenderAvatarStore = class {
    constructor(storage = null, limit = SENDER_AVATAR_LIMIT) {
      __publicField(this, "storage", storage);
      __publicField(this, "limit", limit);
      __publicField(this, "entries", /* @__PURE__ */ new Map());
      __publicField(this, "ambiguous", /* @__PURE__ */ new Set());
      __publicField(this, "groupThreads", /* @__PURE__ */ new Set());
      try {
        const raw = this.storage?.getItem(SENDER_AVATAR_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        const persisted = parsed && typeof parsed === "object" && "version" in parsed && parsed.version === SENDER_AVATAR_VERSION && "entries" in parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
        for (const entry of persisted) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && typeof entry[2] === "string") {
            if (entry[1]) {
              this.entries.set(entry[0], {
                url: entry[1],
                owner: entry[2],
                photo: typeof entry[3] === "string" ? entry[3] : avatarPhotoId(entry[1]),
                at: typeof entry[4] === "number" ? entry[4] : 0
              });
            } else {
              this.ambiguous.add(entry[0]);
            }
          }
        }
        const ambiguous = parsed && typeof parsed === "object" && "ambiguous" in parsed && Array.isArray(parsed.ambiguous) ? parsed.ambiguous : [];
        for (const key of ambiguous) {
          if (typeof key === "string" && key) this.ambiguous.add(key);
        }
        const groups = parsed && typeof parsed === "object" && "groups" in parsed && Array.isArray(parsed.groups) ? parsed.groups : [];
        for (const id of groups) {
          if (typeof id === "string" && id) this.groupThreads.add(id);
        }
      } catch (_) {
      }
      if (this.trim()) this.persist();
    }
    trim() {
      let trimmed = false;
      while (this.entries.size > this.limit) {
        this.entries.delete(this.entries.keys().next().value);
        trimmed = true;
      }
      while (this.ambiguous.size > AMBIGUOUS_LIMIT) {
        this.ambiguous.delete(this.ambiguous.values().next().value);
        trimmed = true;
      }
      while (this.groupThreads.size > GROUP_THREAD_LIMIT) {
        this.groupThreads.delete(this.groupThreads.values().next().value);
        trimmed = true;
      }
      return trimmed;
    }
    persist() {
      try {
        this.storage?.setItem(
          SENDER_AVATAR_STORAGE_KEY,
          JSON.stringify({
            version: SENDER_AVATAR_VERSION,
            entries: [...this.entries].map(([key, entry]) => [
              key,
              entry.url,
              entry.owner,
              entry.photo,
              entry.at
            ]),
            ambiguous: [...this.ambiguous],
            groups: [...this.groupThreads]
          })
        );
      } catch (_) {
      }
    }
    /**
     * Record one name/avatar pairing; returns whether anything changed. `owner`
     * names who the URL belongs to when the key is an alias for them ("Kim" for
     * "Kim Andersen"): an alias two different people answer to identifies
     * neither, so the second claim retires it and the group photo wins instead.
     * Two contacts who share a name across different threads never meet here.
     * Re-seeing an unchanged pairing writes nothing — a rendered thread repeats
     * the same faces on every scan.
     */
    remember(threadId, name, url, owner = name, at = 0) {
      const normalized = normalizeSenderName(name);
      const ownerKey = normalizeSenderName(owner) || normalized;
      if (!threadId || !normalized || !url) return false;
      const key = entryKey(threadId, name);
      if (this.ambiguous.has(key)) return false;
      const photo = avatarPhotoId(url);
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.owner !== ownerKey) return this.markAmbiguous(threadId, name);
        if (existing.photo !== photo && at - existing.at < COLLISION_WINDOW_MS) {
          return this.markAmbiguous(threadId, name);
        }
        if (existing.url === url) {
          const stale = at - existing.at >= COLLISION_WINDOW_MS;
          existing.at = at;
          this.entries.delete(key);
          this.entries.set(key, existing);
          if (stale) this.persist();
          return false;
        }
      }
      this.entries.delete(key);
      this.entries.set(key, { url, owner: ownerKey, photo, at });
      this.trim();
      this.persist();
      return true;
    }
    /**
     * Resolve a preview's sender prefix. Group previews name the sender the same
     * way the thread does ("Kim"), but a members list may hold the full name — so
     * a unique "Kim …" match counts, while several of them do not, even when one
     * of them also cached the short name: showing the wrong person's face is
     * worse than showing the group photo.
     */
    resolve(threadId, name) {
      const normalized = normalizeSenderName(name);
      if (!threadId || !normalized) return { verdict: "no-sender", url: "" };
      const key = entryKey(threadId, name);
      if (this.ambiguous.has(key)) return { verdict: "ambiguous", url: "" };
      const prefix = `${key} `;
      const prefixed = [...this.entries].filter(([candidate]) => candidate.startsWith(prefix));
      const retired = [...this.ambiguous].filter((candidate) => candidate.startsWith(prefix)).length;
      if (prefixed.length + retired > 1 || retired > 0) return { verdict: "ambiguous", url: "" };
      const exact = this.entries.get(key);
      if (exact) {
        const rival = prefixed.some(([, entry]) => entry.owner !== exact.owner);
        return rival ? { verdict: "ambiguous", url: "" } : { verdict: "exact", url: exact.url };
      }
      const only = prefixed[0];
      return only ? { verdict: "full-name", url: only[1].url } : { verdict: "miss", url: "" };
    }
    /** The avatar for a preview's sender prefix, or "" when it is not knowable. */
    lookup(threadId, name) {
      return this.resolve(threadId, name).url;
    }
    /** Why a sender resolves the way it does — for the dev-only MCP probe. */
    describe(threadId, name) {
      return this.resolve(threadId, name).verdict;
    }
    /**
     * Remember that a thread is a group, which only its own message rows can
     * prove (they print the sender's name above each message). A direct message
     * that happens to start with "John: " must not be read as a sender prefix.
     */
    rememberGroupThread(id) {
      if (!id || this.groupThreads.has(id)) return false;
      this.groupThreads.add(id);
      this.trim();
      this.persist();
      return true;
    }
    /**
     * Give up on a name: two people in this thread answer to it. Sticky, and
     * held outside the avatar entries so evicting a face cannot resurrect it.
     */
    markAmbiguous(threadId, name) {
      const normalized = normalizeSenderName(name);
      if (!threadId || !normalized) return false;
      const key = entryKey(threadId, name);
      if (this.ambiguous.has(key)) return false;
      this.ambiguous.add(key);
      this.entries.delete(key);
      const prefix = `${threadId}\0`;
      for (const [candidate, entry] of [...this.entries]) {
        if (!candidate.startsWith(prefix) || entry.owner !== normalized) continue;
        this.entries.delete(candidate);
        this.ambiguous.add(candidate);
      }
      this.trim();
      this.persist();
      return true;
    }
    isGroupThread(id) {
      return this.groupThreads.has(id);
    }
    get size() {
      return this.entries.size;
    }
    /** Counts only, for the dev-only MCP probe. */
    get stats() {
      return {
        avatars: this.entries.size,
        groups: this.groupThreads.size,
        retired: this.ambiguous.size
      };
    }
  };

  // inject/src/messenger/lib/unread.ts
  function unreadCountFromTitle(title) {
    const m = (title || "").match(/^\s*\((\d+)\)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  function reconcileUnreadMessageCount(titleCount, unreadConversations, conversationListTrustworthy) {
    if (!conversationListTrustworthy) return titleCount;
    if (unreadConversations === 0) return 0;
    return Math.max(titleCount, unreadConversations);
  }

  // inject/src/messenger/features/conversation-actions.ts
  function isShown(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function firstShown(sel, root) {
    for (const el of (root || document).querySelectorAll(sel)) if (isShown(el)) return el;
    return null;
  }
  function buttonByLabel(needles, root) {
    for (const el of (root || document).querySelectorAll(
      '[role="button"][aria-label], button[aria-label]'
    )) {
      if (!isShown(el)) continue;
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      if (needles.some((n) => label.includes(n))) return el;
    }
    return null;
  }
  function chatRows() {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const a of document.querySelectorAll(
      '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]'
    )) {
      const href = a.getAttribute("href");
      if (!href || seen.has(href)) continue;
      const r = a.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      seen.add(href);
      out.push(a);
    }
    return out;
  }
  function stepConversation(delta) {
    const rows = chatRows();
    if (!rows.length) return;
    const m = location.pathname.match(/\/t\/([^/]+)/);
    const idx = m ? rows.findIndex((a) => (a.getAttribute("href") || "").includes(`/t/${m[1]}`)) : -1;
    const nextIdx = idx === -1 ? delta > 0 ? 0 : rows.length - 1 : (idx + delta + rows.length) % rows.length;
    rows[nextIdx]?.click();
  }
  function focusChatSearch() {
    const input = firstShown('[role="navigation"] input[type="search"]') || firstShown('input[type="search"]');
    if (input) {
      input.focus();
      input.select();
    }
    return !!input;
  }
  function focusComposer() {
    const box = firstShown('[role="main"] [contenteditable="true"][role="textbox"]') || firstShown('[contenteditable="true"][data-lexical-editor="true"]');
    box?.focus();
    return !!box;
  }
  function searchInConvoButton() {
    const root = document.querySelector('[role="main"]');
    if (!root) return null;
    for (const el of root.querySelectorAll('[role="button"][aria-label]')) {
      if (!isShown(el)) continue;
      const label = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      if (label === "search" || label === "search in conversation") return el;
    }
    return null;
  }
  function searchInConversation() {
    window.__carrierWakeSearchIndex?.();
    const btn = searchInConvoButton();
    if (btn) {
      btn.click();
      return true;
    }
    if (typeof window.__carrierToggleInfo !== "function" || !window.__carrierToggleInfo())
      return false;
    let tries = 0;
    const timer = setInterval(() => {
      const b = searchInConvoButton();
      if (b) {
        clearInterval(timer);
        b.click();
      } else if (++tries >= 40) {
        clearInterval(timer);
      }
    }, 50);
    return true;
  }
  function clickComposerButton(needles) {
    const root = document.querySelector('[role="main"]');
    const btn = root && buttonByLabel(needles, root);
    btn?.click();
    return !!btn;
  }
  var openEmojiPicker = () => clickComposerButton(["choose an emoji"]);
  var openGifPicker = () => clickComposerButton(["choose a gif"]);
  var attachFiles = () => clickComposerButton(["attach a photo or video", "attach a file"]);
  function newConversation() {
    const link = firstShown('a[href*="/messages/new"]');
    if (link) {
      link.click();
      return true;
    }
    const btn = buttonByLabel(["new message"]);
    if (btn) {
      btn.click();
      return true;
    }
    location.assign("/messages/new/");
    return true;
  }

  // inject/src/messenger/features/notifications.ts
  var FALLBACK_DELAY_MS = 2500;
  var PAGE_NOTIFICATION_MATCH_MS = 3e3;
  var FALLBACK_POLL_VISIBLE_MS = 1e4;
  var FALLBACK_POLL_HIDDEN_MS = 6e4;
  var ROW_MUTATION_MATCH_MS = 2e3;
  var MISMATCH_STABLE_MS = 1e3;
  var HYDRATION_SETTLE_MS = 1e4;
  function initNotificationBridge() {
    if (!window.__TAURI_INTERNALS__) return;
    invoke("plugin:notification|is_permission_granted")?.then?.((granted) => granted || invoke("plugin:notification|request_permission"))?.catch?.(() => diag("notify.permission", "notification permission invoke failed"));
    const AVATAR_SIZE = 64;
    const loadAvatarImage = (url) => new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), 2500);
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = url;
    });
    const facesToDataUrl = (urls) => {
      const requested = urls.slice(0, 2);
      return Promise.all(requested.map(loadAvatarImage)).then((images) => {
        const faces = images.filter((image) => image !== null);
        if (!faces.length) return "";
        if (requested.length > 1 && faces.length !== requested.length) return "";
        try {
          const canvas = document.createElement("canvas");
          canvas.width = AVATAR_SIZE;
          canvas.height = AVATAR_SIZE;
          const context = canvas.getContext("2d");
          const paired = faces.length > 1;
          const diameter = paired ? AVATAR_SIZE * 0.68 : AVATAR_SIZE;
          const offset = AVATAR_SIZE - diameter;
          faces.forEach((face, index) => {
            const left = index * offset;
            const top = index * offset;
            const centerX = left + diameter / 2;
            const centerY = top + diameter / 2;
            if (paired) {
              context.save();
              context.globalCompositeOperation = "destination-out";
              context.beginPath();
              context.arc(centerX, centerY, diameter / 2 + 2, 0, 2 * Math.PI);
              context.fill();
              context.restore();
              context.save();
              context.beginPath();
              context.arc(centerX, centerY, diameter / 2, 0, 2 * Math.PI);
              context.clip();
            }
            const scale = Math.max(diameter / face.width, diameter / face.height);
            const sourceSize = diameter / scale;
            context.drawImage(
              face,
              (face.width - sourceSize) / 2,
              (face.height - sourceSize) / 2,
              sourceSize,
              sourceSize,
              left,
              top,
              diameter,
              diameter
            );
            if (paired) context.restore();
          });
          return canvas.toDataURL("image/png");
        } catch (_) {
          return "";
        }
      });
    };
    const avatarToDataUrl = (url) => facesToDataUrl([url]);
    const notificationStorage = (() => {
      try {
        return window.localStorage;
      } catch (_) {
        return null;
      }
    })();
    const pageNotificationReceipts = new PageNotificationReceiptStore(notificationStorage);
    let notifySeq = Date.now() * 1e3 + Math.floor(Math.random() * 1e3);
    const notifyHandlers = /* @__PURE__ */ new Map();
    const deliveryHandlers = /* @__PURE__ */ new Map();
    window.__carrierNotifyClick = (id) => {
      const handler = notifyHandlers.get(id);
      notifyHandlers.delete(id);
      try {
        window.focus();
      } catch (_) {
      }
      try {
        handler?.();
      } catch (_) {
      }
      return handler !== void 0;
    };
    window.__carrierNotifyResult = (id, delivery) => {
      if (delivery !== "accepted" && delivery !== "duplicate" && delivery !== "suppressed") return;
      pageNotificationReceipts.recordDelivery(id, delivery);
      const handler = deliveryHandlers.get(id);
      deliveryHandlers.delete(id);
      handler?.(delivery);
    };
    const emitNotification = (id, title, body, icon, dedupeKey, onClick, threadPath, onDelivery) => {
      notifyHandlers.set(id, onClick);
      if (notifyHandlers.size > 50) notifyHandlers.delete(notifyHandlers.keys().next().value);
      if (onDelivery) {
        deliveryHandlers.set(id, onDelivery);
        if (deliveryHandlers.size > 50) {
          deliveryHandlers.delete(deliveryHandlers.keys().next().value);
        }
      }
      invoke("plugin:event|emit", {
        event: "carrier:notify",
        payload: { id, title, body, icon, dedupe_key: dedupeKey, thread_path: threadPath || "" }
      })?.catch?.(() => {
        deliveryHandlers.delete(id);
        diag("notify.emit", "carrier:notify emit failed");
      });
    };
    const updateNotificationRoute = (id, threadPath) => {
      invoke("plugin:event|emit", {
        event: "carrier:notify-route",
        payload: { id, thread_path: threadPath }
      })?.catch?.(() => diag("notify.route", "carrier:notify-route emit failed"));
    };
    const notifiedStore = new NotifiedSignatureStore(notificationStorage);
    const senderAvatars = new SenderAvatarStore(notificationStorage);
    window.__carrierSenderAvatarStats = (thread, sender) => thread === void 0 ? senderAvatars.stats : { resolves: senderAvatars.describe(thread, sender || "") };
    const pendingFallbacks = /* @__PURE__ */ new Map();
    const unmatchedPageNotifications = new PageNotificationQueue();
    const markPageNotification = (title, body) => {
      for (const [key, pending] of pendingFallbacks) {
        if (!notificationTextMatches(title, body, pending.title, pending.body)) continue;
        clearTimeout(pending.timer);
        pendingFallbacks.delete(key);
        return {
          threadPath: pending.threadPath,
          deliver: {
            key,
            fingerprint: pending.fingerprint,
            bodyHash: notificationDedupeKey("", pending.body),
            expect: notifiedStore.notifiedFingerprint(key)
          },
          dedupeKey: pending.dedupeKey
        };
      }
      return { signal: unmatchedPageNotifications.add({ at: Date.now(), title, body }) };
    };
    function CarrierNotification(title, options = {}) {
      const opts = options || {};
      const s = window.__CARRIER_SETTINGS__ || {};
      diag(
        "notify.fired",
        `page constructed a Notification (visibility: ${document.visibilityState})`
      );
      const pageMatch = markPageNotification(String(title || "Messenger"), String(opts.body || ""));
      if (!s.mute_notifications) {
        const hidePreview = s.hide_notification_preview;
        const originalTitle = String(title || "Messenger");
        const originalBody = String(opts.body || "");
        const id = ++notifySeq;
        if (pageMatch.signal) pageMatch.signal.nativeId = id;
        avatarToDataUrl(hidePreview ? "" : opts.icon).then((icon) => {
          if (pageMatch.signal && !pageMatch.signal.matched) {
            pageNotificationReceipts.add(originalTitle, originalBody, id);
          }
          emitNotification(
            id,
            hidePreview ? "Messenger" : originalTitle,
            hidePreview ? "New message" : originalBody,
            icon,
            pageMatch.dedupeKey ?? pageMatch.signal?.dedupeKey ?? notificationDedupeKey(originalTitle, originalBody),
            () => {
              this.onclick?.(new Event("click"));
            },
            pageMatch.threadPath ?? pageMatch.signal?.threadPath,
            pageMatch.signal ? (delivery) => {
              pageMatch.signal.nativeDelivery = delivery;
              const handler = pageMatch.signal.onNativeDelivery;
              pageMatch.signal.onNativeDelivery = void 0;
              handler?.(delivery);
            } : void 0
          );
          if (pageMatch.deliver && notifiedStore.notifiedFingerprint(pageMatch.deliver.key) === pageMatch.deliver.expect) {
            notifiedStore.markNotified(
              pageMatch.deliver.key,
              pageMatch.deliver.fingerprint,
              pageMatch.deliver.bodyHash
            );
          }
          if (pageMatch.signal) {
            pageMatch.signal.emitted = true;
            const delivery = pageMatch.signal.pendingDelivery;
            if (delivery && notifiedStore.notifiedFingerprint(delivery.key) === delivery.expect) {
              notifiedStore.markNotified(delivery.key, delivery.fingerprint, delivery.bodyHash);
            }
          }
        });
      }
      try {
        window.__carrierOnNotification?.();
      } catch (_) {
      }
      this.title = title;
      this.onclick = null;
      this.close = () => {
      };
    }
    CarrierNotification.permission = "granted";
    CarrierNotification.requestPermission = (cb) => {
      if (cb) cb("granted");
      return Promise.resolve("granted");
    };
    try {
      Object.defineProperty(window, "Notification", {
        value: CarrierNotification,
        writable: true,
        configurable: true
      });
    } catch (_) {
    }
    const conversationTracker = new ConversationNotificationTracker();
    const HARVEST_SEL = '[role="main"], [role="complementary"]';
    const HARVEST_THROTTLE_MS = 5e3;
    let lastHarvestAt = 0;
    let settlingRoute = "";
    const staleRoutes = /* @__PURE__ */ new Set();
    const SETTLE_ATTEMPT_LIMIT = 6;
    let settleAttempts = 0;
    const normalizedText = (value) => (value || "").replace(/\s+/g, " ").trim();
    const isPersonName = (value) => value.length > 0 && value.length <= 60 && value.split(" ").length <= 5 && /\p{Letter}/u.test(value) && !/profile|picture|photo|image|avatar|bilde/i.test(value);
    const rowTitles = /* @__PURE__ */ new Map();
    const ROW_TITLE_LIMIT = 300;
    const rememberRowTitle = (key, title) => {
      if (!key || !title) return;
      rowTitles.delete(key);
      rowTitles.set(key, title);
      if (rowTitles.size > ROW_TITLE_LIMIT) rowTitles.delete(rowTitles.keys().next().value);
    };
    const paneShowsThread = (title, leaving = []) => {
      const needle = title.replace(/[…\s]+$/, "").toLowerCase();
      if (needle.length < 3) return "unknown";
      const log = document.querySelector('[role="main"] [role="log"][aria-label]');
      if (!log) return "no";
      const label = normalizedText(log.getAttribute("aria-label")).toLowerCase();
      if (!label.includes(needle)) return "no";
      for (const previous of leaving) {
        const other = previous.replace(/[…\s]+$/, "").toLowerCase();
        if (other && (other === needle || label.includes(other))) return "unknown";
      }
      return "yes";
    };
    const harvestSenderAvatars = (now) => {
      if (now - lastHarvestAt < HARVEST_THROTTLE_MS) return;
      const openThread = threadIdFromHref(location.pathname);
      if (!openThread) return;
      if (openThread !== settlingRoute) {
        if (settlingRoute) staleRoutes.add(settlingRoute);
        settlingRoute = openThread;
        settleAttempts = 0;
      }
      const leaving = [];
      for (const route of staleRoutes) {
        if (route === openThread) continue;
        const title = rowTitles.get(route);
        if (title) leaving.push(title);
      }
      const shown = paneShowsThread(rowTitles.get(openThread) || "", leaving);
      if (shown !== "yes") {
        if (settleAttempts < SETTLE_ATTEMPT_LIMIT) {
          settleAttempts++;
          scheduleHarvest(500);
        }
        return;
      }
      staleRoutes.clear();
      settleAttempts = 0;
      lastHarvestAt = now;
      const pass = /* @__PURE__ */ new Map();
      const note = (name, url, owner) => {
        const seen = pass.get(name.toLowerCase());
        if (seen === void 0) {
          pass.set(name.toLowerCase(), { name, url, owner, photo: avatarPhotoId(url) });
          return;
        }
        if (seen && seen.photo !== avatarPhotoId(url)) pass.set(name.toLowerCase(), null);
      };
      for (const container of document.querySelectorAll(HARVEST_SEL)) {
        for (const image of container.querySelectorAll("img[alt]")) {
          const source = image.currentSrc || image.src || "";
          if (!source || EMOJI_SOURCE_RE.test(source)) continue;
          const name = normalizedText(image.getAttribute("alt"));
          if (!isPersonName(name)) continue;
          note(name, source, name);
          const heading = normalizedText(
            image.closest('[role="article"]')?.querySelector("h3, h4")?.textContent
          );
          if (isPersonName(heading) && (heading === name || name.startsWith(`${heading} `))) {
            senderAvatars.rememberGroupThread(openThread);
            if (heading !== name) note(heading, source, name);
          }
        }
      }
      for (const [key, face] of pass) {
        if (face) senderAvatars.remember(openThread, face.name, face.url, face.owner, now);
        else senderAvatars.markAmbiguous(openThread, key);
      }
    };
    let harvestScheduled = false;
    const scheduleHarvest = (delay = 300) => {
      if (harvestScheduled) return;
      harvestScheduled = true;
      setTimeout(() => {
        harvestScheduled = false;
        attachHarvestObserver();
        const wait = HARVEST_THROTTLE_MS - (Date.now() - lastHarvestAt);
        if (wait > 0) {
          scheduleHarvest(wait);
          return;
        }
        harvestSenderAvatars(Date.now());
      }, delay);
    };
    let harvestRoots = [];
    let harvestAttached = false;
    const harvestObserver = new MutationObserver(() => scheduleHarvest());
    const attachHarvestObserver = () => {
      const roots = [...document.querySelectorAll(HARVEST_SEL)];
      if (harvestAttached && harvestRoots.length === roots.length && roots.every((root, index) => root === harvestRoots[index] && root.isConnected)) {
        return;
      }
      harvestObserver.disconnect();
      harvestRoots = roots;
      for (const root of roots) harvestObserver.observe(root, { childList: true, subtree: true });
      if (document.body) {
        harvestObserver.observe(document.body, { childList: true });
        harvestAttached = true;
      } else {
        harvestObserver.observe(document.documentElement, { childList: true });
        harvestAttached = false;
      }
    };
    const conversationFromLink = (link) => {
      const id = threadIdFromHref(link?.getAttribute("href"));
      if (!id) return null;
      const row = link.closest('[role="row"]') || link;
      const surfaces = [...row.querySelectorAll("span")].map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: conversationNodeText(el),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          ariaHidden: el.getAttribute("aria-hidden") === "true",
          inAbbreviation: !!el.closest("abbr"),
          // An emoji sprite (and the System emoji glyph beside it) is part of
          // this span's own text, not a nested text surface of its own.
          hasTextChild: hasCandidateTextChild(el)
        };
      });
      const text = conversationTextParts(surfaces);
      const images = [...row.querySelectorAll("img[src]")].filter(
        (candidate) => !EMOJI_SOURCE_RE.test(candidate.currentSrc || candidate.src)
      );
      let unread = false;
      for (const span of row.querySelectorAll("span")) {
        if (isUnreadConversationText(getComputedStyle(span).fontWeight, conversationNodeText(span))) {
          unread = true;
          break;
        }
      }
      return {
        key: id,
        threadPath: `/t/${id}/`,
        title: text.title,
        body: text.body,
        // Every face the row draws, in render order. A photo-less group renders
        // several member images side by side, and no individual one of them is a
        // valid thread icon — taking just the first labelled every message in
        // the thread with whichever member happened to sort first. They are all
        // kept so they can be drawn together, which is a valid picture of the
        // group even though none of them is a picture of it alone.
        icons: images.map((candidate) => candidate.currentSrc || candidate.src).filter(Boolean),
        // A photo-less group draws its members side by side; one with a photo is
        // only known as a group once its thread has been read.
        isGroup: images.length > 1 || senderAvatars.isGroupThread(id),
        unread
      };
    };
    const scheduleFallback = (conversation, detectedAt, confirmedRepeat = false, routeCandidates) => {
      const fingerprint = notificationDedupeKey(conversation.title, conversation.body);
      const dedupeKey = notificationDeliveryDedupeKey(
        fingerprint,
        confirmedRepeat ? `${conversation.key}:${detectedAt}` : void 0
      );
      const bodyHash = notificationDedupeKey("", conversation.body);
      const previous = pendingFallbacks.get(conversation.key);
      if (previous) clearTimeout(previous.timer);
      const pageSignal = unmatchedPageNotifications.consumeMatching(
        conversation,
        detectedAt,
        PAGE_NOTIFICATION_MATCH_MS,
        routeCandidates
      );
      if (pageSignal) {
        if (!pageSignal.emitted) pageSignal.dedupeKey = dedupeKey;
        if (!pageSignal.emitted) pageSignal.threadPath = conversation.threadPath;
        if (pageSignal.emitted && pageSignal.nativeId !== void 0 && conversation.threadPath) {
          updateNotificationRoute(pageSignal.nativeId, conversation.threadPath);
        }
        if (pageSignal.emitted) {
          const finishDelivery = (delivery) => {
            if (confirmedRepeat && delivery === "duplicate") {
              scheduleFallback(conversation, detectedAt, true, routeCandidates);
              return;
            }
            notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
          };
          if (pageSignal.nativeDelivery) {
            finishDelivery(pageSignal.nativeDelivery);
          } else {
            pageSignal.onNativeDelivery = finishDelivery;
          }
        } else {
          pageSignal.pendingDelivery = {
            key: conversation.key,
            fingerprint,
            bodyHash,
            expect: notifiedStore.notifiedFingerprint(conversation.key)
          };
        }
        pageNotificationReceipts.consumeMatching(conversation, detectedAt);
        pendingFallbacks.delete(conversation.key);
        return;
      }
      const senderIcon = conversation.isGroup ? senderAvatars.lookup(conversation.key, groupPreviewSender(conversation.body)) : "";
      const rowIcons = conversation.icons;
      const rowAvatar = () => facesToDataUrl(rowIcons);
      const avatar = senderIcon && !(rowIcons.length === 1 && senderIcon === rowIcons[0]) ? Promise.all([avatarToDataUrl(senderIcon), rowAvatar()]).then(
        ([sender, row]) => sender || row
      ) : rowAvatar();
      const timer = setTimeout(async () => {
        const settings = window.__CARRIER_SETTINGS__ || {};
        if (settings.mute_notifications) {
          if (pendingFallbacks.get(conversation.key)?.timer === timer) {
            pendingFallbacks.delete(conversation.key);
          }
          return;
        }
        const hidePreview = settings.hide_notification_preview === true;
        const icon = hidePreview ? "" : await avatar;
        if (!hidePreview && !icon && conversation.isGroup) {
          diag("notify.avatar", "group notification resolved no sender face and no thread picture");
        }
        if (pendingFallbacks.get(conversation.key)?.timer !== timer) return;
        pendingFallbacks.delete(conversation.key);
        notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
        diag(
          "notify.fallback",
          `unread row changed without a page Notification (visibility: ${document.visibilityState})`
        );
        emitNotification(
          ++notifySeq,
          hidePreview ? "Messenger" : conversation.title,
          hidePreview ? "New message" : conversation.body,
          icon,
          dedupeKey,
          () => {
            window.__carrierOpenThread?.(conversation.threadPath);
          },
          conversation.threadPath
        );
      }, FALLBACK_DELAY_MS);
      pendingFallbacks.set(conversation.key, {
        timer,
        title: conversation.title,
        body: conversation.body,
        threadPath: conversation.threadPath,
        fingerprint,
        dedupeKey,
        confirmedRepeat
      });
    };
    let scanRunning = false;
    let scanPending = false;
    let mismatchConfirmationTimer;
    let readConfirmationTimer;
    const unreadArrivals = new UnreadArrivalTracker(HYDRATION_SETTLE_MS);
    const mismatchTracker = new StableMismatchTracker(MISMATCH_STABLE_MS);
    const pendingArrivalKeys = /* @__PURE__ */ new Set();
    const READ_OBSERVED_LIMIT = 500;
    const readObservedKeys = /* @__PURE__ */ new Set();
    const readCandidates = /* @__PURE__ */ new Map();
    let lastScanAt = 0;
    const MAX_MUTATION_GRACE_MS = 9e4;
    const scanUnreadConversations = () => {
      if (scanRunning) {
        scanPending = true;
        return;
      }
      scanRunning = true;
      try {
        harvestSenderAvatars(Date.now());
        const links = chatRows();
        if (!links.length) return;
        const observed = links.map(conversationFromLink).filter((conversation) => conversation !== null);
        for (const conversation of observed) rememberRowTitle(conversation.key, conversation.title);
        const conversations = observed.filter(
          (conversation) => conversation.unread && !isOwnMessagePreview(conversation.body)
        );
        const detectedAt = Date.now();
        const mutationGrace = lastScanAt ? Math.min(MAX_MUTATION_GRACE_MS, Math.max(0, detectedAt - lastScanAt)) : 0;
        lastScanAt = detectedAt;
        const listHydrated = observed.length > 0 && observed.every(({ body }) => body.length > 0);
        notifiedStore.observeRead(
          new Set(observed.filter(({ unread }) => unread).map(({ key }) => key)),
          observed.map(({ key }) => key),
          detectedAt,
          listHydrated
        );
        const hydrated = conversations.filter(({ body }) => body.length > 0);
        const routeCandidates = observed.filter(({ body }) => body.length > 0);
        const hydratedReadKeys = new Set(
          listHydrated ? observed.filter(({ unread }) => !unread).map(({ key }) => key) : []
        );
        clearTimeout(readConfirmationTimer);
        readConfirmationTimer = void 0;
        let nextReadConfirmationIn = null;
        for (const key of readCandidates.keys()) {
          if (!hydratedReadKeys.has(key)) readCandidates.delete(key);
        }
        for (const conversation of observed) {
          if (!hydratedReadKeys.has(conversation.key)) continue;
          if (readObservedKeys.has(conversation.key)) continue;
          const candidate = readCandidates.get(conversation.key);
          if (candidate === void 0 || detectedAt < candidate.since) {
            readCandidates.set(conversation.key, { since: detectedAt, observations: 1 });
            if (readCandidates.size > READ_OBSERVED_LIMIT) {
              readCandidates.delete(readCandidates.keys().next().value);
            }
            nextReadConfirmationIn = nextReadConfirmationIn === null ? READ_TRANSITION_CONFIRM_MS : Math.min(nextReadConfirmationIn, READ_TRANSITION_CONFIRM_MS);
            continue;
          }
          candidate.observations += 1;
          const elapsed3 = detectedAt - candidate.since;
          if (elapsed3 >= READ_TRANSITION_CONFIRM_MS && candidate.observations >= READ_TRANSITION_MIN_OBSERVATIONS) {
            readCandidates.delete(conversation.key);
            readObservedKeys.add(conversation.key);
            if (readObservedKeys.size > READ_OBSERVED_LIMIT) {
              readObservedKeys.delete(readObservedKeys.keys().next().value);
            }
          } else {
            const remaining = Math.max(1, READ_TRANSITION_CONFIRM_MS - elapsed3);
            nextReadConfirmationIn = nextReadConfirmationIn === null ? remaining : Math.min(nextReadConfirmationIn, remaining);
          }
        }
        if (nextReadConfirmationIn !== null) {
          readConfirmationTimer = setTimeout(
            scanUnreadConversations,
            Math.max(1, nextReadConfirmationIn)
          );
        }
        const readTransitions = /* @__PURE__ */ new Set();
        const changed = new Set(
          conversationTracker.observe(
            hydrated.map(({ key, body }) => ({ key, signature: body })),
            observed.filter(({ body }) => body.length > 0).map(({ key }) => key),
            readObservedKeys,
            readTransitions
          )
        );
        for (const key of unreadArrivals.observeUnreadCount(
          unreadCountFromTitle(document.title || ""),
          detectedAt,
          ROW_MUTATION_MATCH_MS + mutationGrace,
          // A fully hydrated list with no unread rows corroborates a zero
          // title: it is the inbox's real state, not a still-unstamped title,
          // so a first arrival inside the settle window can still report.
          listHydrated && !observed.some(({ unread }) => unread),
          readObservedKeys,
          new Set(conversations.map(({ key: key2 }) => key2))
        )) {
          changed.add(key);
        }
        for (const { key, unread } of observed) {
          if (unread) readObservedKeys.delete(key);
        }
        for (const conversation of hydrated) {
          if (pendingArrivalKeys.delete(conversation.key)) changed.add(conversation.key);
        }
        for (const key of pendingArrivalKeys) {
          const row = observed.find((conversation) => conversation.key === key);
          if (row && !conversations.some((conversation) => conversation.key === key)) {
            pendingArrivalKeys.delete(key);
          }
        }
        pageNotificationReceipts.discardReadMatches(
          observed.filter(({ unread, body }) => !unread && body.length > 0),
          detectedAt
        );
        const pageReceipts = pageNotificationReceipts.consumeUniquelyMatching(hydrated, detectedAt);
        const mismatches = [];
        const stale = /* @__PURE__ */ new Set();
        const unhydrated = /* @__PURE__ */ new Set();
        const confirmedRepeats = /* @__PURE__ */ new Set();
        for (const conversation of conversations) {
          if (!conversation.body) {
            if (changed.has(conversation.key)) {
              unhydrated.add(conversation.key);
              pendingArrivalKeys.add(conversation.key);
              if (pendingArrivalKeys.size > 50) {
                pendingArrivalKeys.delete(pendingArrivalKeys.keys().next().value);
              }
            }
            continue;
          }
          const fingerprint = notificationDedupeKey(conversation.title, conversation.body);
          const bodyHash = notificationDedupeKey("", conversation.body);
          const pageReceipt = pageReceipts.get(conversation.key);
          const pageSignal = pageReceipt ? unmatchedPageNotifications.consumeMatching(
            conversation,
            detectedAt,
            PAGE_NOTIFICATION_MATCH_MS,
            routeCandidates
          ) : null;
          let reconciliation = notifiedStore.reconcileFingerprint(
            conversation.key,
            conversation.title,
            fingerprint,
            bodyHash,
            readTransitions.has(conversation.key) && !pageReceipt
          );
          const repeatedDelivery = readTransitions.has(conversation.key) || reconciliation === "repeated";
          const receiptSuppressedRepeat = pageReceipt !== void 0 && repeatedDelivery && (pageSignal?.nativeDelivery ?? pageReceipt.nativeDelivery) === "duplicate";
          const receiptPendingRepeat = pageReceipt !== void 0 && repeatedDelivery && pageSignal !== null && pageSignal.nativeDelivery === void 0;
          if (receiptPendingRepeat) {
            const pending = pendingFallbacks.get(conversation.key);
            if (pending) clearTimeout(pending.timer);
            pendingFallbacks.delete(conversation.key);
            updateNotificationRoute(pageReceipt.nativeId, conversation.threadPath);
            pageSignal.onNativeDelivery = (delivery) => {
              if (delivery === "duplicate") {
                scheduleFallback(conversation, detectedAt, true, routeCandidates);
                return;
              }
              notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
            };
            changed.delete(conversation.key);
            continue;
          }
          if (receiptSuppressedRepeat) {
            scheduleFallback(conversation, detectedAt, true, routeCandidates);
            changed.delete(conversation.key);
            continue;
          }
          if (pageReceipt) {
            const pending = pendingFallbacks.get(conversation.key);
            if (pending) clearTimeout(pending.timer);
            pendingFallbacks.delete(conversation.key);
            notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
            updateNotificationRoute(pageReceipt.nativeId, conversation.threadPath);
            reconciliation = "matched";
          }
          if (reconciliation === "repeated") {
            confirmedRepeats.add(conversation.key);
            changed.add(conversation.key);
          }
          if (reconciliation === "matched" || reconciliation === "migrated") {
            if (changed.has(conversation.key)) stale.add(conversation.key);
            const pending = pendingFallbacks.get(conversation.key);
            if (pending && !pending.confirmedRepeat) {
              clearTimeout(pending.timer);
              pendingFallbacks.delete(conversation.key);
            }
          } else if (reconciliation === "mismatched") {
            changed.delete(conversation.key);
            mismatches.push([conversation.key, fingerprint]);
            const pending = pendingFallbacks.get(conversation.key);
            if (pending && pending.fingerprint !== fingerprint) {
              clearTimeout(pending.timer);
              pendingFallbacks.delete(conversation.key);
            }
          }
        }
        const mismatchObservation = mismatchTracker.observe(mismatches, detectedAt);
        clearTimeout(mismatchConfirmationTimer);
        mismatchConfirmationTimer = void 0;
        if (mismatchObservation.confirmInMs !== null) {
          mismatchConfirmationTimer = setTimeout(
            scanUnreadConversations,
            Math.max(1, mismatchObservation.confirmInMs)
          );
        }
        const recovered = mismatchObservation.recovered;
        if (recovered.length) {
          diag("notify.recovered", "unread preview diverged from its delivered fingerprint");
          for (const key of recovered) changed.add(key);
        }
        if (!changed.size) return;
        if (stale.size) {
          diag("notify.stale", "suppressed replay of an already-delivered preview");
        }
        if ([...changed].every((key) => stale.has(key) || unhydrated.has(key))) return;
        try {
          window.__carrierOnNotification?.();
        } catch (_) {
        }
        for (const conversation of conversations) {
          if (changed.has(conversation.key) && !stale.has(conversation.key) && !unhydrated.has(conversation.key)) {
            scheduleFallback(
              conversation,
              detectedAt,
              confirmedRepeats.has(conversation.key),
              routeCandidates
            );
          }
        }
      } finally {
        scanRunning = false;
        if (scanPending) {
          scanPending = false;
          queueMicrotask(scanUnreadConversations);
        }
      }
    };
    let scanScheduled = false;
    const scheduleScan = (records = []) => {
      const changedKeys = /* @__PURE__ */ new Set();
      const inspect = (node) => {
        const element = node instanceof Element ? node : node.parentElement;
        if (!element) return;
        const links = /* @__PURE__ */ new Set();
        const closest = element.closest('a[href*="/t/"]');
        if (closest) links.add(closest);
        for (const link of element.querySelectorAll('a[href*="/t/"]')) {
          links.add(link);
        }
        for (const link of links) {
          const key = threadIdFromHref(link.getAttribute("href"));
          if (key) changedKeys.add(key);
        }
      };
      for (const record of records) {
        inspect(record.target);
        for (const node of record.addedNodes) inspect(node);
      }
      unreadArrivals.markRowsChanged(changedKeys, Date.now());
      if (scanScheduled) return;
      scanScheduled = true;
      setTimeout(() => {
        scanScheduled = false;
        scanUnreadConversations();
      }, 120);
    };
    let observedGrid = null;
    const gridObserver = new MutationObserver(scheduleScan);
    const attachScanner = () => {
      const grid = document.querySelector('[role="navigation"] [role="grid"]');
      if (grid === observedGrid && grid?.isConnected) return true;
      gridObserver.disconnect();
      observedGrid = grid;
      if (!grid) return false;
      gridObserver.observe(grid, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "src", "alt", "style"]
      });
      scanUnreadConversations();
      return true;
    };
    if (!attachScanner()) {
      const waitForGrid = new MutationObserver(() => {
        if (attachScanner()) waitForGrid.disconnect();
      });
      waitForGrid.observe(document.documentElement, { childList: true, subtree: true });
    }
    let pollTimer;
    const poll = () => {
      attachScanner();
      attachHarvestObserver();
      scanUnreadConversations();
    };
    const startPoll = () => {
      clearInterval(pollTimer);
      pollTimer = setInterval(
        poll,
        document.hidden ? FALLBACK_POLL_HIDDEN_MS : FALLBACK_POLL_VISIBLE_MS
      );
    };
    document.addEventListener("visibilitychange", () => {
      startPoll();
      attachHarvestObserver();
      if (!document.hidden) poll();
    });
    attachHarvestObserver();
    startPoll();
  }

  // inject/src/messenger/lib/quick-reply.ts
  function decideQuickReply(phase, snapshot, expired) {
    if (phase === "waiting") {
      if (expired) return { action: "failure", phase };
      if (!snapshot.threadMatches || !snapshot.composerReady) {
        return { action: "wait", phase };
      }
      if (!snapshot.composerEmpty) return { action: "failure", phase };
      return { action: "insert", phase: "inserted" };
    }
    if (!snapshot.threadMatches || !snapshot.composerReady) {
      return { action: "failure", phase };
    }
    if (phase === "inserted") {
      if (!snapshot.draftMatches || !snapshot.sendAvailable) {
        return { action: "failure", phase };
      }
      return { action: "send", phase: "confirming" };
    }
    if (snapshot.composerEmpty) return { action: "success", phase };
    if (expired) return { action: "failure", phase };
    return { action: "wait", phase };
  }
  var composerContainsReply = (content, reply) => reply.length > 0 && (content || "").includes(reply);

  // inject/src/messenger/features/quick-reply.ts
  var POLL_MS = 250;
  var DELIVERY_BUDGET_MS = 12e3;
  var MAX_REPLY_CHARS = 2e3;
  var COMPOSER_SELECTOR = '[role="main"] [contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"]';
  var pause = () => new Promise((resolve) => setTimeout(resolve, POLL_MS));
  var currentThreadId = () => threadIdFromHref(location.pathname);
  var composer = () => firstShown(COMPOSER_SELECTOR);
  var sendButton = () => {
    const root = document.querySelector('[role="main"]');
    if (!root) return null;
    return buttonByLabel(["press enter to send", "send message"], root);
  };
  var emitReplyResult = (id, attempt, ok) => {
    carrierReplyResult(id, attempt, ok).catch(
      () => diag("quick-reply.ack", "reply acknowledgement emit failed")
    );
  };
  var validRequest = (path, text, id, attempt) => threadPathId(path) !== null && text.trim().length > 0 && [...text].length <= MAX_REPLY_CHARS && Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(attempt) && attempt > 0;
  async function deliver(path, text) {
    const wantedThread = threadPathId(path);
    if (!wantedThread || currentThreadId() !== wantedThread && window.__carrierOpenThread?.(path) !== true) {
      diag("quick-reply.open", "validated thread could not be opened");
      return false;
    }
    const deadline = Date.now() + DELIVERY_BUDGET_MS;
    let phase = "waiting";
    while (true) {
      const box = composer();
      const button = phase === "inserted" ? sendButton() : null;
      const snapshot = {
        threadMatches: currentThreadId() === wantedThread,
        composerReady: box !== null,
        draftMatches: composerContainsReply(box?.textContent || null, text),
        sendAvailable: button !== null,
        composerEmpty: !(box?.textContent || "").trim()
      };
      const decision = decideQuickReply(phase, snapshot, Date.now() >= deadline);
      phase = decision.phase;
      switch (decision.action) {
        case "wait":
          await pause();
          break;
        case "insert": {
          if (!box) return false;
          box.focus();
          if (!document.execCommand("insertText", false, text)) {
            diag("quick-reply.insert", "composer rejected insertText");
            return false;
          }
          break;
        }
        case "send":
          button?.click();
          await pause();
          break;
        case "success":
          return true;
        case "failure":
          diag("quick-reply.delivery", `reply flow stopped in ${phase}`);
          return false;
      }
    }
  }
  async function preserveDraft(path, text) {
    const wantedThread = threadPathId(path);
    if (!wantedThread || currentThreadId() !== wantedThread && window.__carrierOpenThread?.(path) !== true) {
      return false;
    }
    const deadline = Date.now() + DELIVERY_BUDGET_MS;
    while (Date.now() < deadline) {
      const box = composer();
      if (currentThreadId() === wantedThread && box) {
        box.focus();
        if (!text) return true;
        if (composerContainsReply(box.textContent, text)) return true;
        if ((box.textContent || "").trim()) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(box);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
          if (!document.execCommand("insertText", false, `

${text}`)) {
            diag("quick-reply.draft", "fallback append failed");
            return false;
          }
          return true;
        }
        if (!document.execCommand("insertText", false, text)) {
          diag("quick-reply.draft", "fallback insertText failed");
          return false;
        }
        return true;
      }
      await pause();
    }
    diag("quick-reply.draft", "fallback composer did not become ready");
    return false;
  }
  function initQuickReply() {
    window.__carrierQuickReply = (path, rawText, id, attempt) => {
      const text = String(rawText);
      if (!validRequest(path, text, id, attempt)) {
        emitReplyResult(id, attempt, false);
        return;
      }
      void deliver(path, text).then((ok) => emitReplyResult(id, attempt, ok)).catch(() => {
        diag("quick-reply.exception", "reply flow raised an exception");
        emitReplyResult(id, attempt, false);
      });
    };
    window.__carrierQuickReplyDraft = (path, rawText, id, attempt) => {
      const text = String(rawText);
      if (threadPathId(path) === null || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(attempt) || attempt <= 0) {
        emitReplyResult(id, attempt, false);
        return;
      }
      void preserveDraft(path, text).then((ok) => emitReplyResult(id, attempt, ok)).catch(() => {
        diag("quick-reply.draft", "fallback draft flow raised an exception");
        emitReplyResult(id, attempt, false);
      });
    };
  }

  // inject/src/messenger/features/recent-threads.ts
  function initRecentThreads() {
    if (!window.__TAURI_INTERNALS__) return;
    const MAX_THREADS = 9;
    const EMPTY_GRACE_MS = 15e3;
    const rowName = (a) => {
      const row = a.closest('[role="row"]') || a;
      for (const span of row.querySelectorAll("span")) {
        const t = (span.textContent || "").replace(/\s+/g, " ").trim();
        if (t && !SEPARATOR_RE.test(t)) return t.slice(0, 60);
      }
      return "";
    };
    const chatListScrolledFromTop = (rows) => {
      const first = rows[0];
      if (!first) return false;
      for (let el = first.parentElement; el && el !== document.body; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 16) return el.scrollTop > 8;
      }
      return false;
    };
    const scan = () => {
      const rows = chatRows();
      if (chatListScrolledFromTop(rows)) return null;
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const a of rows) {
        const id = threadIdFromHref(a.getAttribute("href"));
        if (!id || seen.has(id)) continue;
        const name = rowName(a);
        if (!name) continue;
        seen.add(id);
        out.push({ name, href: `/t/${id}/` });
        if (out.length >= MAX_THREADS) break;
      }
      return out;
    };
    let lastSent = null;
    let emptySince = 0;
    const push = () => {
      const hide = window.__CARRIER_SETTINGS__?.hide_names_avatars === true;
      const threads = hide ? [] : scan();
      if (threads === null) return;
      if (!hide && threads.length === 0) {
        const now = Date.now();
        if (!emptySince) emptySince = now;
        if (now - emptySince < EMPTY_GRACE_MS) return;
      } else {
        emptySince = 0;
      }
      const key = JSON.stringify(threads);
      if (key === lastSent) return;
      lastSent = key;
      invoke("plugin:event|emit", { event: "carrier:recent-threads", payload: threads })?.catch?.(
        () => {
        }
      );
    };
    let timer;
    const startPoll = () => {
      clearInterval(timer);
      timer = setInterval(push, document.hidden ? 6e4 : 1e4);
    };
    document.addEventListener("visibilitychange", () => {
      startPoll();
      if (!document.hidden) push();
    });
    window.addEventListener("carrier:settings", push);
    startPoll();
    setTimeout(push, 1500);
    setTimeout(push, 4e3);
  }

  // inject/src/messenger/features/selector-health.ts
  var WATCHED_SELECTORS = [
    // The notification MutationObserver is intentionally scoped to this exact
    // grid. A looser chat-link selector can stay green while the scanner is dead.
    { key: "notification-grid", sel: '[role="navigation"] [role="grid"]' },
    // Conversation list links: Cmd/Ctrl+1–9, unread-conversations badge,
    // recent threads, hide-names blur.
    { key: "chat-list", sel: '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]' },
    // The conversation pane: media viewer, hide-names header blur.
    { key: "main-region", sel: '[role="main"]' },
    // The injected Settings gear depends on Messenger's localized overflow
    // control/icon. Watch the actual output rather than testing a copied icon
    // path constant against itself.
    // Mounted from a requestAnimationFrame callback, which a hidden webview
    // never runs — so a hidden window says nothing about whether the selector
    // still works, and checking one would report a break every interval for as
    // long as Carrier sits in the background.
    { key: "settings-button", sel: "[data-carrier-settings-button]", needsVisible: true }
  ];
  function initSelectorHealth() {
    if (!window.__TAURI_INTERNALS__) return;
    let warnedUser = false;
    const misses = /* @__PURE__ */ new Map();
    const check = () => {
      if (!location.pathname.startsWith("/messages")) return;
      if (document.querySelector('input[name="pass"]')) return;
      for (const { key, sel, needsVisible } of WATCHED_SELECTORS) {
        if (needsVisible && document.hidden) {
          misses.set(key, 0);
          continue;
        }
        if (document.querySelector(sel)) {
          misses.set(key, 0);
          continue;
        }
        const n = (misses.get(key) || 0) + 1;
        misses.set(key, n);
        if (n < 2) continue;
        diag(`selector.${key}`, "core selector matched nothing on a logged-in Messenger page");
        if (!warnedUser) {
          warnedUser = true;
          toast("A Messenger update may have broken part of Carrier — check for updates (F2).");
        }
      }
    };
    setTimeout(check, 45e3);
    setInterval(check, 3e5);
  }

  // inject/src/messenger/lib/settings-button.ts
  var MESSENGER_OVERFLOW_PATH_PREFIX = "M2.25 10a1.75 1.75";
  function isMessengerHeaderOverflowControl(iconPath) {
    return iconPath.trim().startsWith(MESSENGER_OVERFLOW_PATH_PREFIX);
  }

  // inject/src/messenger/features/settings-button.ts
  var SLOT_ATTR = "data-carrier-settings-slot";
  var BUTTON_ATTR = "data-carrier-settings-button";
  function findOverflowButton() {
    const buttons = document.querySelectorAll(
      `[role="button"]:not([${BUTTON_ATTR}]), button:not([${BUTTON_ATTR}])`
    );
    let iconFallback = null;
    for (const button of buttons) {
      const iconPath = button.querySelector("svg path")?.getAttribute("d") || "";
      if (!isMessengerHeaderOverflowControl(iconPath)) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width < 28 || rect.height < 28) continue;
      if (!iconFallback || rect.top < iconFallback.getBoundingClientRect().top) {
        iconFallback = button;
      }
    }
    return iconFallback;
  }
  function placementFor(button) {
    let wrapper = button.parentElement;
    for (let depth = 0; wrapper && depth < 4; depth += 1) {
      const row = wrapper.parentElement;
      if (!row) return null;
      if (row.children.length > 1) return { row, before: wrapper };
      wrapper = row;
    }
    return null;
  }
  function createGearIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "3");
    svg.appendChild(circle);
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.5 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"
    );
    svg.appendChild(path);
    return svg;
  }
  function createSettingsSlot() {
    const slot = document.createElement("div");
    slot.setAttribute(SLOT_ATTR, "");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(BUTTON_ATTR, "");
    button.setAttribute("aria-label", "Carrier Settings");
    button.title = "Carrier Settings";
    button.appendChild(createGearIcon());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.__carrierToggleSettings?.();
    });
    slot.appendChild(button);
    return slot;
  }
  function initSettingsButton() {
    let scheduled = false;
    const ensureButton = () => {
      scheduled = false;
      if (!location.pathname.startsWith("/messages")) return;
      const overflow = findOverflowButton();
      if (!overflow) return;
      const placement = placementFor(overflow);
      if (!placement) return;
      const slots = Array.from(document.querySelectorAll(`[${SLOT_ATTR}]`));
      const slot = slots.shift() || createSettingsSlot();
      for (const duplicate of slots) duplicate.remove();
      if (slot.parentElement !== placement.row || slot.nextElementSibling !== placement.before) {
        placement.row.insertBefore(slot, placement.before);
      }
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(ensureButton);
    };
    const start = () => {
      schedule();
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  // inject/src/messenger/lib/share-intake.ts
  var MAX_SHARED_FILES = 21;
  var MAX_SHARED_NAME_BYTES = 255;
  var MAX_SHARED_DATA_LENGTH = 140 * 1024 * 1024;
  var SHARE_DELIVERY_TTL_MS = 2 * 60 * 1e3;
  var MIME_BY_EXTENSION = /* @__PURE__ */ new Map([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["heic", "image/heic"],
    ["mp4", "video/mp4"],
    ["mov", "video/quicktime"],
    ["webm", "video/webm"],
    ["pdf", "application/pdf"]
  ]);
  var utf8Length = (value) => new TextEncoder().encode(value).length;
  function dispatchTransferEvent(target, event, property, transfer) {
    let payloadRead = false;
    Object.defineProperty(event, property, {
      configurable: true,
      get: () => {
        payloadRead = true;
        return transfer;
      }
    });
    const cancelled = !target.dispatchEvent(event);
    return { acknowledged: cancelled && payloadRead, payloadRead };
  }
  function sanitizeSharedFiles(payload, maxTotalDataLength = MAX_SHARED_DATA_LENGTH) {
    if (!Array.isArray(payload)) return [];
    const files = [];
    let totalData = 0;
    for (const entry of payload) {
      if (files.length >= MAX_SHARED_FILES) break;
      if (!entry || typeof entry !== "object") continue;
      if (!Object.hasOwn(entry, "name") || !Object.hasOwn(entry, "data")) continue;
      const { name, data } = entry;
      if (typeof name !== "string" || typeof data !== "string") continue;
      if (name.length === 0 || utf8Length(name) > MAX_SHARED_NAME_BYTES) continue;
      if (name.includes("/") || name.includes("\\") || name.startsWith(".")) continue;
      totalData += data.length;
      if (totalData > maxTotalDataLength) break;
      files.push({ name, data });
    }
    return files;
  }
  function decodeToFile(entry) {
    try {
      if ("fromBase64" in Uint8Array && typeof Uint8Array.fromBase64 === "function") {
        return new File([Uint8Array.fromBase64(entry.data)], entry.name, {
          type: mimeForName(entry.name)
        });
      }
      const binary = atob(entry.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new File([bytes], entry.name, { type: mimeForName(entry.name) });
    } catch {
      return null;
    }
  }
  function decodeSharedFiles(entries) {
    const files = entries.map(decodeToFile).filter((file) => file !== null);
    return { files, failures: entries.length - files.length };
  }
  function shareIsDeliverable(parkedAtMs, nowMs) {
    const age = nowMs - parkedAtMs;
    return age >= 0 && age <= SHARE_DELIVERY_TTL_MS;
  }
  function mimeForName(name) {
    const extension = name.toLowerCase().split(".").pop() ?? "";
    return MIME_BY_EXTENSION.get(extension) ?? "application/octet-stream";
  }

  // inject/src/messenger/features/share-intake.ts
  var COMPOSER_SELECTOR2 = '[role="main"] div[role="textbox"][contenteditable="true"]';
  var COMPOSER_POLL_MS = 1e3;
  function attachToComposer(composer2, files) {
    try {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      composer2.focus();
      const paste = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true
      });
      const pasted = dispatchTransferEvent(composer2, paste, "clipboardData", transfer);
      if (pasted.acknowledged) return "attached";
      if (pasted.payloadRead) return "uncertain";
      const drop = new DragEvent("drop", {
        bubbles: true,
        cancelable: true
      });
      const dropped = dispatchTransferEvent(composer2, drop, "dataTransfer", transfer);
      if (dropped.acknowledged) return "attached";
      return dropped.payloadRead ? "uncertain" : "retry";
    } catch {
      return "retry";
    }
  }
  function initShareIntake() {
    let pending = null;
    const tryDeliver = () => {
      if (!pending) return true;
      if (!shareIsDeliverable(pending.parkedAt, Date.now())) {
        clearTimeout(pending.timer);
        pending = null;
        toast("Shared file expired");
        return true;
      }
      const composer2 = firstShown(COMPOSER_SELECTOR2);
      if (!composer2) return false;
      const { files, timer } = pending;
      const result = attachToComposer(composer2, files);
      if (result === "retry") return false;
      clearTimeout(timer);
      pending = null;
      if (result === "attached") {
        diag("share.attached", `${files.length}`);
      } else {
        diag("share.attach-failed", `${files.length}`);
        toast("Could not attach the shared file");
      }
      return true;
    };
    const poll = () => {
      if (tryDeliver()) return;
      if (pending) {
        pending.timer = window.setTimeout(poll, COMPOSER_POLL_MS);
      }
    };
    Object.defineProperty(window, "__carrierShareMedia", {
      value: (payload) => {
        const entries = sanitizeSharedFiles(payload);
        const { files, failures } = decodeSharedFiles(entries);
        if (failures) {
          diag("share.partial-decode", `${failures}`);
        }
        if (!files.length) {
          diag("share.empty-payload", "0");
          return;
        }
        const receivedAt = Date.now();
        if (pending && !shareIsDeliverable(pending.parkedAt, receivedAt)) {
          clearTimeout(pending.timer);
          pending = null;
        }
        if (pending) {
          if (pending.files.length + files.length > MAX_SHARED_FILES) {
            diag("share.busy", `${pending.files.length}`);
            toast("Attach the current shared files before sharing more");
            return;
          }
          clearTimeout(pending.timer);
          pending.files.push(...files);
          pending.parkedAt = receivedAt;
        } else {
          pending = { files, parkedAt: receivedAt };
        }
        if (!tryDeliver()) {
          diag("share.waiting-for-composer", `${pending.files.length}`);
          toast("Open a conversation to attach the shared file");
          pending.timer = window.setTimeout(poll, COMPOSER_POLL_MS);
        }
      },
      writable: false,
      configurable: false
    });
  }

  // inject/src/messenger/lib/zoom.ts
  var clampZoom = (p) => Math.min(200, Math.max(30, Math.round(p) || 100));

  // inject/src/messenger/features/zoom.ts
  var ZOOM_KEY = "carrier:zoom";
  var isWindows = /windows/i.test(navigator.userAgent);
  var zoomLevel = 100;
  function applyZoom(percent, fromSettings) {
    const clamped = clampZoom(percent);
    if (isWindows) {
      const scale = clamped / 100;
      document.body.style.transformOrigin = "top left";
      document.body.style.transform = `scale(${scale})`;
      document.body.style.width = `${100 / scale}%`;
      document.body.style.height = `${100 / scale}%`;
      window.dispatchEvent(new Event("resize"));
    } else {
      document.documentElement.style.zoom = `${clamped}%`;
      window.dispatchEvent(new Event("resize"));
    }
    const changed = clamped !== zoomLevel;
    zoomLevel = clamped;
    try {
      localStorage.setItem(ZOOM_KEY, String(clamped));
      const settings = window.__CARRIER_SETTINGS__ && typeof window.__CARRIER_SETTINGS__ === "object" && !Array.isArray(window.__CARRIER_SETTINGS__) ? window.__CARRIER_SETTINGS__ : null;
      if (settings) settings.zoom = clamped;
      const cached = JSON.parse(
        localStorage.getItem("__carrier_settings") || "null"
      );
      const nextSettings = cached && typeof cached === "object" && !Array.isArray(cached) ? cached : settings ? Object.assign({}, settings) : null;
      if (nextSettings) {
        nextSettings.zoom = clamped;
        localStorage.setItem("__carrier_settings", JSON.stringify(nextSettings));
      }
    } catch (_) {
    }
    if (changed && !fromSettings) {
      invoke("plugin:event|emit", { event: "carrier:zoom", payload: clamped })?.catch?.(() => {
      });
    }
  }
  var zoomIn = () => applyZoom(zoomLevel + 10);
  var zoomOut = () => applyZoom(zoomLevel - 10);
  var zoomReset = () => applyZoom(100);
  function syncZoomFromSettings() {
    const s = window.__CARRIER_SETTINGS__ || {};
    const z = typeof s.zoom === "number" && Number.isFinite(s.zoom) ? clampZoom(s.zoom) : 100;
    if (z !== zoomLevel) applyZoom(z, true);
  }
  function initZoomLevel() {
    const s = window.__CARRIER_SETTINGS__ || {};
    let z = typeof s.zoom === "number" && Number.isFinite(s.zoom) ? clampZoom(s.zoom) : 100;
    const stored = parseInt(localStorage.getItem(ZOOM_KEY) || "", 10);
    if (z === 100 && Number.isFinite(stored) && clampZoom(stored) !== 100) {
      z = clampZoom(stored);
      invoke("plugin:event|emit", { event: "carrier:zoom", payload: z })?.catch?.(() => {
      });
    }
    if (z !== zoomLevel) applyZoom(z, true);
    window.addEventListener("carrier:settings", syncZoomFromSettings);
  }
  function initZoom() {
    window.__carrierZoomIn = zoomIn;
    window.__carrierZoomOut = zoomOut;
    window.__carrierZoomReset = zoomReset;
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", initZoomLevel, { once: true });
    else initZoomLevel();
  }

  // inject/src/messenger/features/shortcuts.ts
  var isMac3 = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  var accel = (e) => !e.altKey && (isMac3 ? e.metaKey : e.ctrlKey);
  var shortcuts = {
    "[": () => stepConversation(-1),
    "]": () => stepConversation(1),
    "-": zoomOut,
    "=": zoomIn,
    "+": zoomIn,
    "0": zoomReset,
    r: () => location.reload(),
    k: () => focusChatSearch(),
    f: () => searchInConversation(),
    l: () => focusComposer(),
    e: () => openEmojiPicker(),
    g: () => openGifPicker(),
    t: () => attachFiles(),
    "/": () => window.__carrierToggleShortcuts?.()
  };
  function initShortcuts() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          stepConversation(e.shiftKey ? -1 : 1);
          return;
        }
        if (!accel(e)) return;
        const fn = shortcuts[e.key];
        if (fn) {
          e.preventDefault();
          fn();
        }
      },
      true
    );
  }
  function initFunctionKeys() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "F1") {
          e.preventDefault();
          window.__carrierToggleShortcuts?.();
        } else if (e.key === "F5") {
          e.preventDefault();
          location.reload();
        } else if (e.key === "F3") {
          e.preventDefault();
          window.__carrierToggleSettings?.();
        } else if (e.key === "F2") {
          e.preventDefault();
          window.__carrierCheckUpdates?.();
        } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
          const target = chatRows()[Number(e.key) - 1];
          if (target) {
            e.preventDefault();
            target.click();
          }
        }
      },
      true
    );
  }
  function initShortcutRegistry() {
    window.__carrierShortcuts = {
      nextConversation: () => stepConversation(1),
      prevConversation: () => stepConversation(-1),
      focusChatSearch,
      focusComposer,
      searchInConversation,
      openEmojiPicker,
      openGifPicker,
      attachFiles,
      newConversation
    };
  }

  // inject/src/messenger/features/spellcheck.ts
  var SPELL_SEL = '[contenteditable="true"], textarea, input[type="text"], input[type="search"]';
  function applySpellcheckNow() {
    const on = window.__CARRIER_SETTINGS__?.spellcheck === true;
    document.querySelectorAll(SPELL_SEL).forEach((el) => {
      el.setAttribute?.("spellcheck", on ? "true" : "false");
    });
  }
  function applySpellcheck() {
    applySpellcheckNow();
    registerAddedNodeSweep((root) => {
      const on = window.__CARRIER_SETTINGS__?.spellcheck === true;
      const want = on ? "true" : "false";
      const set = (el) => {
        if (el.getAttribute?.("spellcheck") !== want) el.setAttribute?.("spellcheck", want);
      };
      if (root.matches?.(SPELL_SEL)) set(root);
      root.querySelectorAll?.(SPELL_SEL).forEach(set);
    });
  }
  function initSpellcheck() {
    window.addEventListener("carrier:settings", applySpellcheckNow);
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", applySpellcheck);
    else applySpellcheck();
  }

  // inject/src/messenger/lib/sync-health.ts
  var SYNC_REQUEST_TIMEOUT_MS = 3e4;
  var SYNC_WINDOW_MS = 18e4;
  var SYNC_FAILURE_FLOOR = 5;
  var STUCK_LOADING_SAMPLES = 3;
  var SampledPersistence = class {
    constructor(limit) {
      __publicField(this, "limit", limit);
      __publicField(this, "count", 0);
    }
    observe(present) {
      this.count = present ? this.count + 1 : 0;
    }
    persistent() {
      return this.count >= this.limit;
    }
  };
  function isMessengerSyncRequest(raw, base) {
    let url;
    try {
      url = new URL(raw, base);
    } catch (_) {
      return false;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    const facebookHost = host === "facebook.com" || host.endsWith(".facebook.com") || host === "messenger.com" || host.endsWith(".messenger.com");
    return facebookHost && url.pathname.startsWith("/api/graphql");
  }
  function syncResponseSucceeded(status) {
    return status >= 200 && status < 400;
  }
  var SyncHealthTracker = class {
    constructor() {
      __publicField(this, "outstanding", /* @__PURE__ */ new Map());
      __publicField(this, "outcomes", []);
      __publicField(this, "nextId", 1);
    }
    started(now) {
      const id = this.nextId++;
      this.outstanding.set(id, now);
      return id;
    }
    // Outcomes only count while the request is still outstanding: a request
    // already swept as hung must not add a second outcome when it eventually
    // completes, however it completes.
    succeeded(id, now) {
      if (this.outstanding.delete(id)) this.outcomes.push({ at: now, ok: true });
    }
    failed(id, now) {
      if (this.outstanding.delete(id)) this.outcomes.push({ at: now, ok: false });
    }
    /** Forget a request without recording an outcome (e.g. it was aborted
     * locally or failed while offline — that says nothing about Facebook). */
    abandoned(id) {
      this.outstanding.delete(id);
    }
    /** Forget everything in flight (the machine went offline: whatever those
     * requests do next is about the local network, not Facebook). */
    abandonOutstanding() {
      this.outstanding.clear();
    }
    /** Count requests hung past the deadline as failures, each once. */
    sweep(now) {
      for (const [id, startedAt] of this.outstanding) {
        if (now - startedAt >= SYNC_REQUEST_TIMEOUT_MS) {
          this.outstanding.delete(id);
          this.outcomes.push({ at: now, ok: false });
        }
      }
      this.outcomes = this.outcomes.filter((outcome) => now - outcome.at < SYNC_WINDOW_MS);
    }
    counts(now) {
      let ok = 0;
      let bad = 0;
      for (const outcome of this.outcomes) {
        if (now - outcome.at >= SYNC_WINDOW_MS) continue;
        if (outcome.ok) ok += 1;
        else bad += 1;
      }
      return { ok, bad };
    }
    degraded(now) {
      const { ok, bad } = this.counts(now);
      return bad >= SYNC_FAILURE_FLOOR && bad > ok;
    }
    /** Content-free description of the current window for diagnostics. */
    summary(now) {
      const { ok, bad } = this.counts(now);
      return `${bad} failed / ${ok} ok in window`;
    }
  };

  // inject/src/messenger/features/sync-health.ts
  var SYNC_CHECK_INTERVAL_MS = 1e4;
  function initSyncHealth() {
    const tracker = new SyncHealthTracker();
    try {
      const nativeFetch = window.fetch;
      const wrappedFetch = new Proxy(nativeFetch, {
        apply(target, thisArg, args) {
          let tracked;
          try {
            const input = args[0];
            const url = typeof input === "string" || input instanceof URL ? String(input) : input instanceof Request ? input.url : "";
            if (url && isMessengerContentPath(location.pathname) && isMessengerSyncRequest(url, location.href)) {
              tracked = tracker.started(Date.now());
            }
          } catch (_) {
          }
          const result = Reflect.apply(target, thisArg, args);
          if (tracked !== void 0) {
            const id = tracked;
            result.then(
              (response) => {
                if (syncResponseSucceeded(response.status)) tracker.succeeded(id, Date.now());
                else if (navigator.onLine) tracker.failed(id, Date.now());
                else tracker.abandoned(id);
              },
              (error) => {
                const aborted = error?.name === "AbortError";
                if (navigator.onLine && !aborted) tracker.failed(id, Date.now());
                else tracker.abandoned(id);
              }
            );
          }
          return result;
        }
      });
      Object.defineProperty(window, "fetch", {
        value: wrappedFetch,
        writable: true,
        configurable: true
      });
    } catch (_) {
      diag("sync.requests", "could not observe Messenger sync fetches");
    }
    try {
      const xhrUrls = /* @__PURE__ */ new WeakMap();
      const nativeOpen = XMLHttpRequest.prototype.open;
      const nativeSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(...args) {
        try {
          xhrUrls.set(this, String(args[1]));
        } catch (_) {
        }
        return nativeOpen.apply(this, args);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        try {
          const url = xhrUrls.get(this);
          if (url && isMessengerContentPath(location.pathname) && isMessengerSyncRequest(url, location.href)) {
            const id = tracker.started(Date.now());
            this.addEventListener("abort", () => tracker.abandoned(id), { once: true });
            this.addEventListener(
              "loadend",
              () => {
                if (syncResponseSucceeded(this.status)) tracker.succeeded(id, Date.now());
                else if (navigator.onLine) tracker.failed(id, Date.now());
                else tracker.abandoned(id);
              },
              { once: true }
            );
          }
        } catch (_) {
        }
        return nativeSend.apply(this, args);
      };
    } catch (_) {
      diag("sync.requests", "could not observe Messenger sync XHRs");
    }
    const stuckLoading = new SampledPersistence(STUCK_LOADING_SAMPLES);
    const hasRunningAnimation = (root) => {
      const nodes = [root, ...Array.from(root.querySelectorAll("*")).slice(0, 8)];
      for (const node of nodes) {
        const style = getComputedStyle(node);
        if (style.animationName !== "none" && style.animationPlayState !== "paused") return true;
      }
      return false;
    };
    const isActuallyVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
        return false;
      }
      let current = el;
      while (current) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) <= 0) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };
    const loadingSpinnerVisible = () => {
      try {
        for (const el of document.querySelectorAll('[role="progressbar"], [role="status"]')) {
          if (isActuallyVisible(el) && hasRunningAnimation(el)) return true;
        }
      } catch (_) {
      }
      return false;
    };
    const SYNC_BANNER_ID = "carrier-sync-banner";
    const showSyncBanner = () => {
      try {
        if (document.getElementById(SYNC_BANNER_ID)) return;
        const banner = document.createElement("div");
        banner.id = SYNC_BANNER_ID;
        banner.setAttribute("role", "alert");
        banner.textContent = "⚠ Messenger sync is broken — chats may be out of date";
        Object.assign(banner.style, {
          position: "fixed",
          top: "10px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: "2147483646",
          background: "#ffba00",
          color: "#1c1e21",
          padding: "6px 14px",
          borderRadius: "999px",
          boxShadow: "0 4px 16px rgba(0,0,0,.35)",
          font: "600 12px -apple-system, system-ui, sans-serif",
          pointerEvents: "none",
          maxWidth: "90vw",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis"
        });
        (document.body || document.documentElement).appendChild(banner);
      } catch (_) {
      }
    };
    const hideSyncBanner = () => {
      try {
        document.getElementById(SYNC_BANNER_ID)?.remove();
      } catch (_) {
      }
    };
    const emitSyncAlert = (kind) => invoke("plugin:event|emit", {
      event: "carrier:sync-alert",
      payload: { kind }
    })?.catch?.(() => {
    });
    window.addEventListener("offline", () => tracker.abandonOutstanding());
    let degraded = false;
    setInterval(() => {
      if (!navigator.onLine) {
        tracker.abandonOutstanding();
        return;
      }
      const now = Date.now();
      tracker.sweep(now);
      if (!document.hidden && isMessengerContentPath(location.pathname)) {
        stuckLoading.observe(loadingSpinnerVisible());
      }
      const degradedNow = tracker.degraded(now) || stuckLoading.persistent();
      if (degradedNow && !degraded) {
        degraded = true;
        const reason = stuckLoading.persistent() ? "loading UI stuck" : `requests failing (${tracker.summary(now)})`;
        diag("sync.stalled", `messenger sync degraded: ${reason}`);
        emitSyncAlert("degraded");
      } else if (!degradedNow && degraded) {
        degraded = false;
        diag("sync.stalled", "messenger sync recovered");
        emitSyncAlert("recovered");
      }
      if (degraded) showSyncBanner();
      else hideSyncBanner();
    }, SYNC_CHECK_INTERVAL_MS);
  }

  // inject/src/messenger/features/system-emoji.ts
  var SOURCE_ATTR = "data-carrier-emoji-sprite";
  var GLYPH_ATTR = SYSTEM_EMOJI_GLYPH_ATTR;
  var REACTION_ATTR = "data-carrier-reaction-emoji";
  var CANDIDATE_SEL = "img[alt], [aria-label]";
  var INTERACTIVE_SEL = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]';
  function initSystemEmoji() {
    const html = document.documentElement;
    let observer = null;
    let pending = false;
    const queuedRoots = /* @__PURE__ */ new Set();
    const on = () => window.__CARRIER_SETTINGS__?.system_emoji === true;
    function sourceGlyph(el) {
      if (el?.nodeType !== 1 || el.hasAttribute(GLYPH_ATTR)) return "";
      if (el.matches?.("img[alt]")) {
        const img = el;
        const src = img.currentSrc || img.src || img.getAttribute("src") || "";
        if (!EMOJI_SOURCE_RE.test(src)) return "";
        return emojiGlyph(img.getAttribute("alt"));
      }
      if (el.matches?.(INTERACTIVE_SEL)) return "";
      const label = emojiGlyph(el.getAttribute("aria-label"));
      if (!label) return "";
      const bg = getComputedStyle(el).backgroundImage || "";
      return EMOJI_SOURCE_RE.test(bg) ? label : "";
    }
    function clearGlyph(el) {
      el.__carrierSystemEmojiGlyph?.remove?.();
      el.removeAttribute(SOURCE_ATTR);
      el.removeAttribute("data-carrier-emoji-glyph");
      delete el.__carrierSystemEmojiGlyph;
    }
    function ensureGlyph(el) {
      const glyph = sourceGlyph(el);
      if (!glyph || !el.parentNode) {
        if (el?.hasAttribute?.(SOURCE_ATTR)) clearGlyph(el);
        return;
      }
      el.setAttribute(SOURCE_ATTR, "");
      el.setAttribute("data-carrier-emoji-glyph", glyph);
      let span = el.__carrierSystemEmojiGlyph;
      if (!span?.isConnected) {
        span = document.createElement("span");
        span.setAttribute(GLYPH_ATTR, "");
        span.setAttribute("role", "img");
        el.__carrierSystemEmojiGlyph = span;
        el.after(span);
      }
      if (span.previousSibling !== el) el.after(span);
      if (span.textContent !== glyph) span.textContent = glyph;
      if (span.getAttribute("aria-label") !== glyph) span.setAttribute("aria-label", glyph);
    }
    function scan(root) {
      if (!on() || !root || root.nodeType !== 1) return;
      ensureGlyph(root);
      root.querySelectorAll?.(CANDIDATE_SEL).forEach(ensureGlyph);
    }
    function sweepOrphanGlyphs() {
      for (const glyph of document.querySelectorAll(`[${GLYPH_ATTR}]`)) {
        const source = glyph.previousElementSibling;
        if (!source?.hasAttribute(SOURCE_ATTR) || source.__carrierSystemEmojiGlyph !== glyph || !source.isConnected) {
          glyph.remove();
        }
      }
    }
    function markReactionGlyphs() {
      const reactions = /* @__PURE__ */ new Set();
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        const children = [...menu.children].map((child) => ({
          glyphs: child.querySelectorAll(`[${GLYPH_ATTR}]`).length,
          role: child.getAttribute("role")
        }));
        if (!isReactionMenuShape(children)) continue;
        menu.querySelectorAll(`[${GLYPH_ATTR}]`).forEach((glyph) => reactions.add(glyph));
      }
      document.querySelectorAll(`[${REACTION_ATTR}]`).forEach((glyph) => {
        if (!reactions.has(glyph)) glyph.removeAttribute(REACTION_ATTR);
      });
      reactions.forEach((glyph) => glyph.setAttribute(REACTION_ATTR, ""));
    }
    function schedule(root = document.documentElement) {
      if (!on()) return;
      queuedRoots.add(root);
      if (queuedRoots.size > 50) {
        queuedRoots.clear();
        queuedRoots.add(document.documentElement);
      }
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const roots = [...queuedRoots];
        queuedRoots.clear();
        roots.forEach(scan);
        sweepOrphanGlyphs();
        markReactionGlyphs();
      });
    }
    function start() {
      if (observer) return;
      observer = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes") {
            schedule(m.target);
          } else {
            schedule(m.target);
            for (const n of m.addedNodes) schedule(n);
          }
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["alt", "aria-label", "src", "style", "role"]
      });
    }
    function stop() {
      observer?.disconnect();
      observer = null;
      pending = false;
      queuedRoots.clear();
      document.querySelectorAll(`[${GLYPH_ATTR}]`).forEach((el) => el.remove());
      document.querySelectorAll(`[${SOURCE_ATTR}]`).forEach((el) => {
        clearGlyph(el);
      });
    }
    const apply = () => {
      html.toggleAttribute("data-carrier-system-emoji", on());
      if (on()) {
        start();
        schedule();
      } else {
        stop();
      }
    };
    apply();
    window.addEventListener("carrier:settings", apply);
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", () => on() && schedule(), { once: true });
  }

  // inject/src/messenger/lib/telemetry.ts
  var TELEMETRY_BLOCK_RE = new RegExp(
    [
      "^/ajax/bz(/|$)",
      // Banzai batch logging — the main telemetry firehose
      "^/a/bz(/|$)",
      // newer short Banzai alias
      "^/ajax/bnzai(/|$)",
      // legacy Banzai path
      "^/ajax/qm(\\.php)?(/|$)",
      // Quick Metrics performance beacons
      "^/common/scribe_endpoint(\\.php)?$",
      // legacy Scribe logging sink
      "^/security/hsts-pixel\\.gif$",
      // HSTS beacon
      "^/tr(/|$)",
      // Meta Pixel
      "^/ajax/error/"
      // browser JS-error reporting
    ].join("|")
  );
  function isBlockedTelemetryUrl(raw, base) {
    let u;
    try {
      u = new URL(raw, base);
    } catch (_) {
      return false;
    }
    if (!/(^|\.)(facebook\.com|messenger\.com)$/.test(u.hostname)) return false;
    if (u.hostname === "pixel.facebook.com") return true;
    return TELEMETRY_BLOCK_RE.test(u.pathname);
  }

  // inject/src/messenger/features/telemetry.ts
  function initTelemetryBlocking() {
    const on = () => window.__CARRIER_SETTINGS__?.block_telemetry === true;
    const shouldBlock = (raw) => on() && isBlockedTelemetryUrl(raw, location.href);
    try {
      const origFetch = window.fetch;
      window.fetch = function(...args) {
        try {
          const input = args[0];
          const raw = typeof input === "string" ? input : input && input.url || String(input);
          if (raw && shouldBlock(raw)) return Promise.resolve(new Response(null, { status: 204 }));
        } catch (_) {
        }
        return origFetch.apply(this, args);
      };
    } catch (_) {
    }
    try {
      const proto = XMLHttpRequest.prototype;
      const origOpen = proto.open;
      const origSend = proto.send;
      proto.open = function(...args) {
        try {
          this.__carrierBlocked = shouldBlock(args[1]);
        } catch (_) {
          this.__carrierBlocked = false;
        }
        return origOpen.apply(this, args);
      };
      proto.send = function(...args) {
        if (this.__carrierBlocked && on()) {
          setTimeout(() => {
            try {
              for (const [k, v] of [
                ["readyState", 4],
                ["status", 200],
                ["statusText", "OK"],
                ["responseText", ""],
                ["response", ""],
                ["responseURL", ""]
              ]) {
                Object.defineProperty(this, k, { value: v, configurable: true });
              }
              this.dispatchEvent(new Event("readystatechange"));
              this.dispatchEvent(new ProgressEvent("load"));
              this.dispatchEvent(new ProgressEvent("loadend"));
            } catch (_) {
            }
          }, 0);
          return;
        }
        return origSend.apply(this, args);
      };
    } catch (_) {
    }
    try {
      const origBeacon = Navigator.prototype.sendBeacon;
      Navigator.prototype.sendBeacon = function(...args) {
        try {
          if (shouldBlock(args[0])) return true;
        } catch (_) {
        }
        return origBeacon.apply(this, args);
      };
    } catch (_) {
    }
  }

  // inject/src/messenger/lib/thread-viewed.ts
  var initialThreadViewedState = () => ({
    visible: false,
    threadPath: null,
    lastReportedAt: null
  });
  var THREAD_VIEW_RECHECK_MS = 5e3;
  function advanceThreadViewed(previous, threadPath, visible, now) {
    const active = visible && threadPath !== null;
    const changed = !previous.visible || previous.threadPath !== threadPath;
    const recheckDue = active && previous.lastReportedAt !== null && Number.isFinite(now) && now >= previous.lastReportedAt + THREAD_VIEW_RECHECK_MS;
    const emit = active && (changed || recheckDue) ? threadPath : null;
    return {
      state: {
        visible,
        threadPath,
        lastReportedAt: emit ? now : active ? previous.lastReportedAt : null
      },
      emit
    };
  }

  // inject/src/messenger/features/thread-nav.ts
  function initThreadNav() {
    window.__carrierOpenThread = (href) => {
      const id = threadPathId(href);
      if (!id) return false;
      for (const a of document.querySelectorAll('a[href*="/t/"]')) {
        if (threadIdFromHref(a.getAttribute("href")) === id) {
          a.click();
          return true;
        }
      }
      location.href = `https://www.facebook.com/messages/t/${id}/`;
      return true;
    };
    let viewed = initialThreadViewedState();
    const reportViewedThread = () => {
      const id = threadIdFromHref(location.pathname);
      const path = id ? `/t/${id}/` : null;
      const next = advanceThreadViewed(
        viewed,
        path,
        document.hasFocus() && !document.hidden,
        performance.now()
      );
      viewed = next.state;
      if (next.emit) {
        invoke("plugin:event|emit", {
          event: "carrier:thread-viewed",
          payload: { thread_path: next.emit }
        })?.catch?.(() => diag("thread-viewed.emit", "thread view emit failed"));
      }
    };
    setInterval(reportViewedThread, 1e3);
    document.addEventListener("visibilitychange", reportViewedThread);
    window.addEventListener("focus", reportViewedThread);
    window.addEventListener("blur", reportViewedThread);
    reportViewedThread();
    window.__carrierToggleInfo = () => {
      const wanted = (el) => {
        const l = (el.getAttribute("aria-label") || "").toLowerCase();
        return l.includes("conversation information") || l.includes("conversation details");
      };
      let btn = document.querySelector(
        '[role="button"][aria-label="Conversation information"]'
      );
      if (!btn) {
        for (const el of document.querySelectorAll("[aria-label]"))
          if (wanted(el)) {
            btn = el.closest('[role="button"]') || el;
            break;
          }
      }
      if (btn) {
        btn.click();
        return true;
      }
      toast("Open a conversation first");
      return false;
    };
  }

  // inject/src/messenger/features/unread-badge.ts
  function initUnreadBadge() {
    if (!window.__TAURI_INTERNALS__) return;
    const unreadConversationState = () => {
      const links = chatRows();
      const seen = /* @__PURE__ */ new Set();
      let count = 0;
      for (const a of links) {
        const id = threadIdFromHref(a.getAttribute("href"));
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const row = a.closest('[role="row"]') || a;
        for (const span of row.querySelectorAll("span")) {
          if (isUnreadConversationText(getComputedStyle(span).fontWeight, span.textContent || "")) {
            count++;
            break;
          }
        }
      }
      let scrolledFromTop = false;
      const first = links[0];
      for (let el = first?.parentElement; el && el !== document.body; el = el.parentElement) {
        if (el.scrollHeight <= el.clientHeight + 16) continue;
        scrolledFromTop = el.scrollTop > 8;
        break;
      }
      return {
        count,
        ready: links.length > 0,
        trustworthy: links.length > 0 && !scrolledFromTop
      };
    };
    let last = null;
    const setBadge = (n, force) => {
      if (n === last && !force) return;
      last = n;
      invoke("plugin:window|set_badge_count", { value: n > 0 ? n : null })?.catch?.(
        () => diag("badge.set", "set_badge_count invoke failed")
      );
      invoke("plugin:event|emit", { event: "carrier:unread", payload: n })?.catch?.(
        () => diag("badge.emit", "carrier:unread emit failed")
      );
    };
    const apply = (force) => {
      const s = window.__CARRIER_SETTINGS__ || {};
      if (s.unread_badge === false) {
        setBadge(0, force);
        return;
      }
      const conversations = unreadConversationState();
      const conv = s.badge_mode === "conversations";
      const n = conv ? conversations.count : reconcileUnreadMessageCount(
        unreadCountFromTitle(document.title || ""),
        conversations.count,
        conversations.trustworthy
      );
      const ready = conv ? conversations.ready : document.readyState === "complete" && (document.title || "").trim().length > 0;
      if (n === 0 && !ready) return;
      setBadge(n, force);
    };
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        apply(false);
        setTimeout(() => apply(false), 800);
      }, 120);
    };
    const headObserver = new MutationObserver(schedule);
    const observeHead = () => {
      if (!document.head) return false;
      headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
      return true;
    };
    if (!observeHead()) {
      const waitForHead = new MutationObserver(() => {
        if (observeHead()) waitForHead.disconnect();
      });
      waitForHead.observe(document.documentElement, { childList: true, subtree: true });
    }
    window.addEventListener("carrier:settings", () => apply(true));
    let pollTimer;
    const startPoll = () => {
      clearInterval(pollTimer);
      pollTimer = setInterval(() => apply(false), document.hidden ? 6e4 : 5e3);
    };
    document.addEventListener("visibilitychange", () => {
      startPoll();
      if (!document.hidden) apply(false);
    });
    startPoll();
    apply(true);
    setTimeout(() => apply(true), 1500);
    setTimeout(() => apply(true), 4e3);
  }

  // inject/src/messenger/lib/viewer-controls.ts
  var SAFE_TOP = 8;
  var MAX_OFFSET = 64;
  function viewerControlOffset(controlTops, appliedOffset = 0) {
    const naturalTops = controlTops.filter(Number.isFinite).map((top) => top - (Number.isFinite(appliedOffset) ? appliedOffset : 0));
    if (!naturalTops.length) return 0;
    return Math.min(MAX_OFFSET, Math.max(0, Math.ceil(SAFE_TOP - Math.min(...naturalTops))));
  }

  // inject/src/messenger/features/viewer-controls.ts
  var DIALOG = 'div[role="dialog"][aria-label]:not([hidden] *)';
  var BANNER = 'div[role="banner"]';
  var CONTROL = 'a[href], button, [role="button"]';
  var BANNER_ATTR = "data-carrier-media-controls";
  var ACTIONS_ATTR = "data-carrier-media-actions";
  var OFFSET = "--carrier-media-controls-offset";
  var visibleControls = (root) => [...root.querySelectorAll(CONTROL)].map((control) => control.getBoundingClientRect()).filter(
    (rect) => rect.width >= 16 && rect.height >= 16 && rect.bottom > 0 && rect.top < 96 && rect.right > 0 && rect.left < window.innerWidth
  );
  var applyOffset = (element, controlTops, attr) => {
    const currentOffset = Number.parseFloat(element.style.getPropertyValue(OFFSET)) || 0;
    const offset = viewerControlOffset(controlTops, currentOffset);
    if (!offset) return false;
    if (!element.hasAttribute(attr)) element.setAttribute(attr, "");
    const value = `${offset}px`;
    if (element.style.getPropertyValue(OFFSET) !== value) {
      element.style.setProperty(OFFSET, value);
    }
    return true;
  };
  var actionGroupFor = (download, dialog) => {
    let candidate = download;
    for (let parent = download.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
      const rect = parent.getBoundingClientRect();
      const controls = visibleControls(parent);
      if (controls.length >= 2 && rect.width <= 240 && rect.height <= 96) return parent;
      if (rect.width <= 240 && rect.height <= 96) candidate = parent;
    }
    return candidate;
  };
  function initViewerControls() {
    let frame = 0;
    const refresh = () => {
      frame = 0;
      const previouslyMarked = new Set(
        document.querySelectorAll(`[${BANNER_ATTR}], [${ACTIONS_ATTR}]`)
      );
      const dialog = document.querySelector(DIALOG);
      if (dialog) {
        for (const banner of document.querySelectorAll(BANNER)) {
          if (applyOffset(
            banner,
            visibleControls(banner).map((rect) => rect.top),
            BANNER_ATTR
          )) {
            previouslyMarked.delete(banner);
          }
        }
        for (const download of dialog.querySelectorAll("a[download]")) {
          const group = actionGroupFor(download, dialog);
          if (applyOffset(
            group,
            visibleControls(group).map((rect) => rect.top),
            ACTIONS_ATTR
          )) {
            previouslyMarked.delete(group);
          }
        }
      }
      for (const element of previouslyMarked) {
        element.removeAttribute(BANNER_ATTR);
        element.removeAttribute(ACTIONS_ATTR);
        element.style.removeProperty(OFFSET);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(refresh);
    };
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    window.addEventListener("resize", schedule, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) schedule();
    });
    schedule();
  }

  // inject/src/messenger/index.ts
  function initFeature(name, init) {
    try {
      init();
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      diag(`init.${name}`, detail.slice(0, 500));
    }
  }
  function main() {
    initFeature("facebook-workers", initFacebookWorkerOptimization);
    initFeature("facebook-modules", initFacebookModuleInterception);
    initFeature("emoji-images", initEmojiImageLoading);
    initFeature("composer-keys", initComposerKeys);
    initFeature("shortcuts", initShortcuts);
    initFeature("zoom", initZoom);
    initFeature("selector-health", initSelectorHealth);
    initFeature("settings-button", initSettingsButton);
    initFeature("function-keys", initFunctionKeys);
    initFeature("shortcut-registry", initShortcutRegistry);
    initFeature("link-handling", initLinkHandling);
    initFeature("context-menu", initContextMenu);
    initFeature("download-anchors", initDownloadAnchors);
    initFeature("spellcheck", initSpellcheck);
    initFeature("telemetry", initTelemetryBlocking);
    initFeature("media-autoplay", initMediaAutoplay);
    initFeature("notifications", initNotificationBridge);
    initFeature("share-intake", initShareIntake);
    initFeature("sync-health", initSyncHealth);
    initFeature("auto-refresh", initAutoRefresh);
    initFeature("force-theme", initForceTheme);
    initFeature("unread-badge", initUnreadBadge);
    initFeature("recent-threads", initRecentThreads);
    initFeature("thread-nav", initThreadNav);
    initFeature("quick-reply", initQuickReply);
    initFeature("hide-names", initHideNames);
    initFeature("system-emoji", initSystemEmoji);
    initFeature("media-permissions", initMediaPermissionWarning);
    initFeature("cookie-consent", initCookieAutoDecline);
    initFeature("login-tidy", initLoginTidy);
    initFeature("media-viewer", initMediaViewer);
    initFeature("viewer-controls", initViewerControls);
    initFeature("fullscreen", initFullscreenPolyfill);
  }
  if (window.top === window.self) main();
})();
