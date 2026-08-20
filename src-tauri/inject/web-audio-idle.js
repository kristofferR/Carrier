/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/web-audio-idle.ts (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

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

  // inject/src/messenger/lib/web-audio-idle.ts
  var WEB_AUDIO_IDLE_MS = 5e3;
  var WEB_AUDIO_PING_PONG_WINDOW_MS = 2e3;
  var trustedAudioFrameHost = (host) => host === "facebook.com" || host.endsWith(".facebook.com") || host === "messenger.com" || host.endsWith(".messenger.com") || host === "fbsbx.com" || host.endsWith(".fbsbx.com");
  function isTrustedWebAudioFrameOrigin(origin) {
    try {
      const url = new URL(origin);
      return url.protocol === "https:" && trustedAudioFrameHost(url.hostname.toLowerCase());
    } catch (_) {
      return false;
    }
  }
  function firstAccessibleAncestorHost(start) {
    const seen = /* @__PURE__ */ new Set();
    let ancestor = start;
    while (!seen.has(ancestor)) {
      seen.add(ancestor);
      try {
        if (ancestor.location.hostname) return ancestor.location.hostname;
        if (ancestor.parent === ancestor) return "";
        ancestor = ancestor.parent;
      } catch (_) {
        return "";
      }
    }
    return "";
  }
  var safeDiagnosticCount = (value) => Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value))) : 0;
  var AUDIO_CONTEXT_STATES = /* @__PURE__ */ new Set(["closed", "interrupted", "running", "suspended"]);
  function formatWebAudioDiagnostic(diagnostic) {
    switch (diagnostic.type) {
      case "stats": {
        const states = diagnostic.states.filter((state) => AUDIO_CONTEXT_STATES.has(state)).join(",");
        return {
          key: "web-audio.stats",
          message: `suspends=${safeDiagnosticCount(diagnostic.suspends)} pageResumes=${safeDiagnosticCount(diagnostic.pageResumes)} state=${states}`
        };
      }
      case "resume-rejected":
        return {
          key: "web-audio.idle",
          message: "resume rejected; leaving the context alone"
        };
      case "initialization-failed":
        return {
          key: "init.web-audio-idle",
          message: "initialization failed"
        };
    }
  }
  var WebAudioIdleGate = class {
    constructor(_createdAt, idleMs = WEB_AUDIO_IDLE_MS) {
      __publicField(this, "idleMs", idleMs);
      __publicField(this, "holds", 0);
      __publicField(this, "inCall", false);
      __publicField(this, "lastActivityAt");
      __publicField(this, "lastAutoSuspendAt", Number.NEGATIVE_INFINITY);
      __publicField(this, "pingPongs", 0);
      __publicField(this, "givenUp", false);
      __publicField(this, "pageSuspended", false);
      __publicField(this, "weSuspended", false);
      __publicField(this, "closed", false);
      this.lastActivityAt = Number.NEGATIVE_INFINITY;
    }
    /** Something touched the graph; keep the context awake for the grace window. */
    activity(now) {
      if (now > this.lastActivityAt) this.lastActivityAt = now;
    }
    /** Keep the context awake until the returned release runs (idempotent). */
    hold(now) {
      this.activity(now);
      this.holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.holds = Math.max(0, this.holds - 1);
      };
    }
    setInCall(inCall) {
      this.inCall = inCall;
    }
    /** The page called resume() itself. */
    pageResumed(now) {
      this.pageSuspended = false;
      this.weSuspended = false;
      if (now - this.lastAutoSuspendAt < WEB_AUDIO_PING_PONG_WINDOW_MS) {
        this.pingPongs += 1;
      } else {
        this.pingPongs = 0;
      }
      this.activity(now);
    }
    /** How many times the page re-resumed right after an automatic suspend. */
    fights() {
      return this.pingPongs;
    }
    /** The page called suspend() itself; never auto-resume over it. */
    pageSuspendedContext() {
      this.pageSuspended = true;
    }
    pageClosedContext() {
      this.closed = true;
    }
    /** Record that the caller just suspended the context on the gate's verdict. */
    autoSuspended(now) {
      this.lastAutoSuspendAt = now;
      this.weSuspended = true;
    }
    /** True when the current suspended state was produced by this gate. */
    autoSuspendedByUs() {
      return this.weSuspended;
    }
    /** The gate's own resume took effect; a later suspend is not ours to undo. */
    autoResumed() {
      this.weSuspended = false;
    }
    /** Stop intervening; the page keeps full control from now on. */
    giveUp() {
      this.givenUp = true;
    }
    /** False once the gate should no longer touch the context at all. */
    active() {
      return !this.givenUp && !this.closed;
    }
    /** Whether the page itself has suspended the context. */
    isPageSuspended() {
      return this.pageSuspended;
    }
    wantsRunning(now) {
      if (this.closed || this.pageSuspended) return false;
      return this.holds > 0 || this.inCall || now - this.lastActivityAt < this.idleMs;
    }
    /**
     * When the grace window ends, if that is what currently keeps the context
     * awake; null when it should not run, or when a hold or call keeps it awake
     * (those release through their own events).
     */
    nextIdleAt(now) {
      if (!this.wantsRunning(now) || this.holds > 0 || this.inCall) return null;
      return this.lastActivityAt + this.idleMs;
    }
  };

  // inject/src/messenger/features/web-audio-idle.ts
  var CALL_STATE_MESSAGE = "carrier:web-audio-call-state:v1";
  var CALL_STATE_REQUEST = "carrier:web-audio-call-state-request:v1";
  var CALL_STATE_RELEASE = "carrier:web-audio-call-state-release:v1";
  function initWebAudioIdle(report) {
    const NativeAudioContext = window.AudioContext;
    if (typeof NativeAudioContext !== "function") return;
    const proto = NativeAudioContext.prototype;
    const originalResume = proto.resume;
    const originalSuspend = proto.suspend;
    const originalClose = proto.close;
    const entries = /* @__PURE__ */ new WeakMap();
    const live = /* @__PURE__ */ new Set();
    const now = () => performance.now();
    let suspends = 0;
    let resumes = 0;
    window.setInterval(() => {
      if (suspends || resumes) {
        report({
          type: "stats",
          suspends,
          pageResumes: resumes,
          states: [...live].map((context) => context.state)
        });
        suspends = 0;
        resumes = 0;
      }
    }, 6e4);
    const sync = (ctx) => {
      const entry = entries.get(ctx);
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.timer = void 0;
      const { gate } = entry;
      if (!gate.active()) return;
      const at = now();
      if (gate.wantsRunning(at)) {
        if (ctx.state === "suspended" && !gate.isPageSuspended() && gate.autoSuspendedByUs()) {
          originalResume.call(ctx).then(
            () => gate.autoResumed(),
            () => {
              gate.giveUp();
              report({ type: "resume-rejected" });
            }
          );
        }
        const idleAt = gate.nextIdleAt(at);
        if (idleAt !== null) {
          entry.timer = window.setTimeout(() => sync(ctx), Math.max(0, idleAt - at) + 1);
        }
      } else if (ctx.state === "running") {
        suspends += 1;
        gate.autoSuspended(at);
        originalSuspend.call(ctx).catch(() => {
        });
      }
    };
    const track = (ctx) => {
      if (entries.has(ctx)) return;
      entries.set(ctx, { gate: new WebAudioIdleGate(now()), timer: void 0 });
      live.add(ctx);
      ctx.addEventListener("statechange", () => sync(ctx));
      entries.get(ctx)?.gate.setInCall(window.__carrierInCall === true);
      sync(ctx);
    };
    const gateOf = (ctx) => entries.get(ctx)?.gate;
    const touch = (ctx) => {
      const gate = gateOf(ctx);
      if (!gate) return;
      gate.activity(now());
      sync(ctx);
    };
    const hold = (ctx) => {
      const gate = gateOf(ctx);
      if (!gate) return () => {
      };
      const release = gate.hold(now());
      sync(ctx);
      return () => {
        release();
        sync(ctx);
      };
    };
    const wrapConstructor = (Ctor) => new Proxy(Ctor, {
      construct(target, args, newTarget) {
        const ctx = Reflect.construct(target, args, newTarget);
        track(ctx);
        return ctx;
      }
    });
    const Wrapped = wrapConstructor(NativeAudioContext);
    window.AudioContext = Wrapped;
    const legacy = window;
    if (legacy.webkitAudioContext) {
      legacy.webkitAudioContext = legacy.webkitAudioContext === NativeAudioContext ? Wrapped : wrapConstructor(legacy.webkitAudioContext);
    }
    proto.resume = function() {
      const gate = gateOf(this);
      if (gate) {
        resumes += 1;
        gate.pageResumed(now());
      }
      const result = originalResume.call(this);
      sync(this);
      return result;
    };
    proto.suspend = function() {
      const entry = entries.get(this);
      if (entry) {
        entry.gate.pageSuspendedContext();
        clearTimeout(entry.timer);
        entry.timer = void 0;
      }
      return originalSuspend.call(this);
    };
    proto.close = function() {
      const entry = entries.get(this);
      if (entry) {
        entry.gate.pageClosedContext();
        clearTimeout(entry.timer);
        entry.timer = void 0;
        live.delete(this);
      }
      return originalClose.call(this);
    };
    const wrapStart = (target) => {
      const originalStart = target.prototype.start;
      target.prototype.start = function(...args) {
        const release = hold(this.context);
        this.addEventListener("ended", release, { once: true });
        try {
          originalStart.apply(this, args);
        } catch (error) {
          release();
          throw error;
        }
      };
    };
    wrapStart(AudioScheduledSourceNode);
    wrapStart(AudioBufferSourceNode);
    const holdWhilePlaying = (ctx, element) => {
      let release;
      const playing = () => {
        if (!release) release = hold(ctx);
      };
      const stopped = () => {
        release?.();
        release = void 0;
      };
      element.addEventListener("playing", playing);
      element.addEventListener("play", playing);
      element.addEventListener("pause", stopped);
      element.addEventListener("ended", stopped);
      element.addEventListener("emptied", stopped);
      if (!element.paused && !element.ended) playing();
      else touch(ctx);
    };
    const holdWhileLive = (ctx, stream) => {
      let release;
      const reevaluate = () => {
        const live2 = stream.getAudioTracks().some((track2) => track2.readyState === "live");
        if (live2) {
          if (!release) release = hold(ctx);
        } else {
          release?.();
          release = void 0;
        }
      };
      const counter = new LiveMediaTrackCounter(() => reevaluate());
      for (const track2 of stream.getAudioTracks()) counter.add(track2);
      stream.addEventListener("addtrack", (event) => {
        if (event.track.kind === "audio") counter.add(event.track);
        reevaluate();
      });
      stream.addEventListener("removetrack", () => reevaluate());
      reevaluate();
      touch(ctx);
    };
    const originalCreateMediaElementSource = proto.createMediaElementSource;
    proto.createMediaElementSource = function(element) {
      const node = originalCreateMediaElementSource.call(this, element);
      holdWhilePlaying(this, element);
      return node;
    };
    const originalCreateMediaStreamSource = proto.createMediaStreamSource;
    proto.createMediaStreamSource = function(stream) {
      const node = originalCreateMediaStreamSource.call(this, stream);
      holdWhileLive(this, stream);
      return node;
    };
    const wrapNodeConstructor = (name, onConstruct) => {
      const globals = window;
      const Ctor = globals[name];
      if (typeof Ctor !== "function") return;
      globals[name] = new Proxy(Ctor, {
        construct(target, args, newTarget) {
          const node = Reflect.construct(target, args, newTarget);
          onConstruct(node.context, node);
          return node;
        }
      });
    };
    wrapNodeConstructor(
      "MediaElementAudioSourceNode",
      (ctx, n) => holdWhilePlaying(ctx, n.mediaElement)
    );
    wrapNodeConstructor(
      "MediaStreamAudioSourceNode",
      (ctx, n) => holdWhileLive(ctx, n.mediaStream)
    );
    wrapNodeConstructor(
      "MediaStreamAudioDestinationNode",
      (ctx) => touch(ctx)
    );
    wrapNodeConstructor("AudioWorkletNode", (ctx) => touch(ctx));
    const originalCreateMediaStreamDestination = proto.createMediaStreamDestination;
    proto.createMediaStreamDestination = function() {
      touch(this);
      return originalCreateMediaStreamDestination.call(this);
    };
    const baseProto = BaseAudioContext.prototype;
    const originalCreateScriptProcessor = baseProto.createScriptProcessor;
    baseProto.createScriptProcessor = function(...args) {
      touch(this);
      return originalCreateScriptProcessor.apply(this, args);
    };
    const applyCallState = (inCall) => {
      for (const ctx of live) {
        gateOf(ctx)?.setInCall(inCall);
        sync(ctx);
      }
    };
    const isDirectChild = (source) => {
      for (let index = 0; index < window.frames.length; index += 1) {
        if (window.frames[index] === source) return true;
      }
      return false;
    };
    const childOrigins = /* @__PURE__ */ new Map();
    const postCallState = (target, targetOrigin, inCall) => {
      try {
        target.postMessage({ type: CALL_STATE_MESSAGE, inCall }, targetOrigin);
      } catch (_) {
      }
    };
    const postCallStateToChildren = (inCall) => {
      for (const [child, origin] of childOrigins) {
        if (isDirectChild(child)) postCallState(child, origin, inCall);
        else childOrigins.delete(child);
      }
    };
    window.addEventListener("carrier:protection-change", () => {
      const inCall = window.__carrierInCall === true;
      applyCallState(inCall);
      postCallStateToChildren(inCall);
    });
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (data?.type === CALL_STATE_RELEASE && event.source !== null && childOrigins.get(event.source) === event.origin) {
        childOrigins.delete(event.source);
        return;
      }
      if (data?.type === CALL_STATE_REQUEST && isDirectChild(event.source) && isTrustedWebAudioFrameOrigin(event.origin)) {
        const child = event.source;
        childOrigins.set(child, event.origin);
        postCallState(child, event.origin, window.__carrierInCall === true);
        return;
      }
      if (window.parent === window || event.source !== window.parent || !isTrustedWebAudioFrameOrigin(event.origin) || data?.type !== CALL_STATE_MESSAGE || typeof data.inCall !== "boolean") {
        return;
      }
      window.__carrierInCall = data.inCall;
      applyCallState(data.inCall);
      postCallStateToChildren(data.inCall);
    });
    if (window.parent !== window) {
      const requestCallState = () => {
        window.parent.postMessage({ type: CALL_STATE_REQUEST }, "*");
      };
      requestCallState();
      window.addEventListener("pagehide", () => {
        window.parent.postMessage({ type: CALL_STATE_RELEASE }, "*");
      });
      window.addEventListener("pageshow", (event) => {
        if (event.persisted) requestCallState();
      });
    }
  }

  // inject/src/web-audio-idle.ts
  var normalizeHost = (host) => host.toLowerCase().replace(/^www\./, "");
  var isMessengerHost = (host) => host === "facebook.com" || host.endsWith(".facebook.com") || host === "messenger.com" || host.endsWith(".messenger.com");
  var isFbsbxHost = (host) => host === "fbsbx.com" || host.endsWith(".fbsbx.com");
  var carrierHost = normalizeHost(location.hostname);
  var carrierAncestorHost = window.parent === window ? "" : normalizeHost(firstAccessibleAncestorHost(window.parent));
  var isMessengerFrame = isMessengerHost(carrierHost) || !carrierHost && isMessengerHost(carrierAncestorHost);
  var isAudioOnlyFrame = isFbsbxHost(carrierHost) || !carrierHost && isFbsbxHost(carrierAncestorHost);
  if (isMessengerFrame || isAudioOnlyFrame) {
    const report = (() => {
      if (window.top !== window.self) return (_diagnostic) => {
      };
      const lastSent = /* @__PURE__ */ new Map();
      return (diagnostic) => {
        try {
          const { key, message } = formatWebAudioDiagnostic(diagnostic);
          const now = Date.now();
          if (now - (lastSent.get(key) ?? 0) < 3e4) return;
          lastSent.set(key, now);
          window.__TAURI_INTERNALS__?.invoke("plugin:event|emit", {
            event: "carrier:diag",
            payload: { key, msg: message }
          })?.catch?.(() => {
          });
        } catch (_) {
        }
      };
    })();
    try {
      initWebAudioIdle(report);
    } catch (_) {
      report({ type: "initialization-failed" });
    }
  }
})();
