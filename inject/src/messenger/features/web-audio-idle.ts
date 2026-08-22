/* ------------------------- Web Audio idle gate ------------------------ */
// Messenger creates an AudioContext at page load and leaves it running for the
// life of the page. A running context keeps a real-time CoreAudio output
// client rendering silence and, on macOS, holds a Bluetooth audio session:
// while Carrier is the foreground audio owner that idle session competes with
// other apps for the route (hijacking playback) and can trip a HAL overload
// that stalls the shared output device, silencing Bluetooth headphones (#232 —
// the foreground failure, separate from the hidden-window suspend/resume flip
// that background_throttling already handles). Keep the context suspended
// unless something can actually produce sound: a scheduled source that has
// started and not ended, a playing media element, a live MediaStream input, an
// active call, or a short grace after any of those. Everything goes through the
// original methods captured here, so the page's own suspend()/resume() stay
// distinguishable and are respected.
import { diag } from "../bridge";
import { LiveMediaTrackCounter } from "../lib/media-tracks";
import { WebAudioIdleGate } from "../lib/web-audio-idle";

interface Entry {
  gate: WebAudioIdleGate;
  timer: number | undefined;
}

type AudioContextCtor = typeof AudioContext;

export function initWebAudioIdle() {
  const NativeAudioContext = window.AudioContext;
  if (typeof NativeAudioContext !== "function") return;

  const proto = NativeAudioContext.prototype;
  const originalResume = proto.resume;
  const originalSuspend = proto.suspend;
  const originalClose = proto.close;
  const entries = new WeakMap<BaseAudioContext, Entry>();
  // Strong refs so an in-call change can reach every live context; Messenger
  // creates one. Removed on close().
  const live = new Set<AudioContext>();
  const now = () => performance.now();
  // Aggregate counters — one diag line a minute instead of per-event spam.
  let suspends = 0;
  let resumes = 0;
  window.setInterval(() => {
    if (suspends || resumes) {
      const states = [...live].map((c) => c.state).join(",");
      diag("web-audio.stats", `suspends=${suspends} pageResumes=${resumes} state=${states}`);
      suspends = 0;
      resumes = 0;
    }
  }, 60_000);

  const sync = (ctx: AudioContext) => {
    const entry = entries.get(ctx);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const { gate } = entry;
    if (!gate.active()) return;
    const at = now();
    if (gate.wantsRunning(at)) {
      // Only ever undo OUR OWN suspend. A context the page left suspended is
      // the page's business — resuming it would start audio nobody asked for.
      if (ctx.state === "suspended" && !gate.isPageSuspended() && gate.autoSuspendedByUs()) {
        originalResume.call(ctx).then(
          () => gate.autoResumed(),
          () => {
            // WebKit refused (autoplay policy or interruption); leave the page
            // in control rather than risk swallowing sound later.
            gate.giveUp();
            diag("web-audio.idle", "resume rejected; leaving the context alone");
          },
        );
      }
      const idleAt = gate.nextIdleAt(at);
      if (idleAt !== null) {
        entry.timer = window.setTimeout(() => sync(ctx), Math.max(0, idleAt - at) + 1);
      }
    } else if (ctx.state === "running") {
      suspends += 1;
      gate.autoSuspended(at);
      originalSuspend.call(ctx).catch(() => {});
    }
  };

  const track = (ctx: AudioContext) => {
    if (entries.has(ctx)) return;
    entries.set(ctx, { gate: new WebAudioIdleGate(now()), timer: undefined });
    live.add(ctx);
    // WebKit can start a context without the page calling resume() (autoplay
    // policy, or a gesture-driven internal start), and that transition is the
    // moment it registers a route-eligible audio session. Without this listener
    // the gate would never re-evaluate and the context would stay running.
    ctx.addEventListener("statechange", () => sync(ctx));
    // A context created mid-call must not be gated until the call ends.
    entries.get(ctx)?.gate.setInCall(window.__carrierInCall === true);
    sync(ctx);
  };

  const gateOf = (ctx: BaseAudioContext) => entries.get(ctx)?.gate;
  const touch = (ctx: BaseAudioContext) => {
    const gate = gateOf(ctx);
    if (!gate) return;
    gate.activity(now());
    sync(ctx as AudioContext);
  };
  const hold = (ctx: BaseAudioContext) => {
    const gate = gateOf(ctx);
    if (!gate) return () => {};
    const release = gate.hold(now());
    sync(ctx as AudioContext);
    return () => {
      release();
      sync(ctx as AudioContext);
    };
  };

  /* ---- context lifecycle ---- */
  const wrapConstructor = (Ctor: AudioContextCtor) =>
    new Proxy(Ctor, {
      construct(target, args, newTarget) {
        const ctx = Reflect.construct(target, args, newTarget) as AudioContext;
        track(ctx);
        return ctx;
      },
    });
  const Wrapped = wrapConstructor(NativeAudioContext);
  window.AudioContext = Wrapped;
  const legacy = window as unknown as { webkitAudioContext?: AudioContextCtor };
  if (legacy.webkitAudioContext) {
    legacy.webkitAudioContext =
      legacy.webkitAudioContext === NativeAudioContext
        ? Wrapped
        : wrapConstructor(legacy.webkitAudioContext);
  }

  proto.resume = function (this: AudioContext) {
    const gate = gateOf(this);
    if (gate) {
      resumes += 1;
      gate.pageResumed(now());
    }
    const result = originalResume.call(this);
    sync(this);
    return result;
  };
  proto.suspend = function (this: AudioContext) {
    const entry = entries.get(this);
    if (entry) {
      entry.gate.pageSuspendedContext();
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    return originalSuspend.call(this);
  };
  proto.close = function (this: AudioContext) {
    const entry = entries.get(this);
    if (entry) {
      entry.gate.pageClosedContext();
      clearTimeout(entry.timer);
      entry.timer = undefined;
      live.delete(this);
    }
    return originalClose.call(this);
  };

  /* ---- sound producers ---- */
  // Scheduled sources hold from start() until `ended` (which also follows
  // stop(), and never comes for a looping source that is still playing).
  const wrapStart = <T extends AudioScheduledSourceNode>(target: {
    prototype: T & { start: (...args: number[]) => void };
  }) => {
    const originalStart = target.prototype.start;
    target.prototype.start = function (this: T, ...args: number[]) {
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
  // AudioBufferSourceNode.start(when, offset, duration) shadows the base one.
  wrapStart(AudioBufferSourceNode);

  // A media element routed through the graph holds while it plays.
  const holdWhilePlaying = (ctx: BaseAudioContext, element: HTMLMediaElement) => {
    let release: (() => void) | undefined;
    const playing = () => {
      if (!release) release = hold(ctx);
    };
    const stopped = () => {
      release?.();
      release = undefined;
    };
    element.addEventListener("playing", playing);
    element.addEventListener("play", playing);
    element.addEventListener("pause", stopped);
    element.addEventListener("ended", stopped);
    element.addEventListener("emptied", stopped);
    if (!element.paused && !element.ended) playing();
    else touch(ctx);
  };

  // A MediaStream input holds while the stream carries a live audio track.
  const holdWhileLive = (ctx: BaseAudioContext, stream: MediaStream) => {
    let release: (() => void) | undefined;
    const reevaluate = () => {
      const live = stream.getAudioTracks().some((track) => track.readyState === "live");
      if (live) {
        if (!release) release = hold(ctx);
      } else {
        release?.();
        release = undefined;
      }
    };
    // stop() fires no `ended`; the counter wraps it and listens for `ended`,
    // so it is the event source for track lifetime. Membership changes
    // (addtrack/removetrack) re-evaluate directly against the stream.
    const counter = new LiveMediaTrackCounter<MediaStreamTrack>(() => reevaluate());
    for (const track of stream.getAudioTracks()) counter.add(track);
    stream.addEventListener("addtrack", (event) => {
      if (event.track.kind === "audio") counter.add(event.track);
      reevaluate();
    });
    stream.addEventListener("removetrack", () => reevaluate());
    reevaluate();
    touch(ctx);
  };

  const originalCreateMediaElementSource = proto.createMediaElementSource;
  proto.createMediaElementSource = function (this: AudioContext, element: HTMLMediaElement) {
    const node = originalCreateMediaElementSource.call(this, element);
    holdWhilePlaying(this, element);
    return node;
  };
  const originalCreateMediaStreamSource = proto.createMediaStreamSource;
  proto.createMediaStreamSource = function (this: AudioContext, stream: MediaStream) {
    const node = originalCreateMediaStreamSource.call(this, stream);
    holdWhileLive(this, stream);
    return node;
  };
  const wrapNodeConstructor = <
    C extends new (
      context: AudioContext,
      ...rest: never[]
    ) => AudioNode,
  >(
    name: string,
    onConstruct: (ctx: BaseAudioContext, node: InstanceType<C>) => void,
  ) => {
    const globals = window as unknown as Record<string, C | undefined>;
    const Ctor = globals[name];
    if (typeof Ctor !== "function") return;
    globals[name] = new Proxy(Ctor, {
      construct(target, args, newTarget) {
        const node = Reflect.construct(target, args, newTarget) as InstanceType<C>;
        onConstruct(node.context, node);
        return node;
      },
    });
  };
  wrapNodeConstructor<typeof MediaElementAudioSourceNode>("MediaElementAudioSourceNode", (ctx, n) =>
    holdWhilePlaying(ctx, n.mediaElement),
  );
  wrapNodeConstructor<typeof MediaStreamAudioSourceNode>("MediaStreamAudioSourceNode", (ctx, n) =>
    holdWhileLive(ctx, n.mediaStream),
  );
  // Capture-side and processing nodes exist for calls; the call itself (a
  // live getUserMedia track, see media-permissions) keeps the context awake.
  // Their creation still counts as activity for the grace window.
  wrapNodeConstructor<typeof MediaStreamAudioDestinationNode>(
    "MediaStreamAudioDestinationNode",
    (ctx) => touch(ctx),
  );
  wrapNodeConstructor<typeof AudioWorkletNode>("AudioWorkletNode", (ctx) => touch(ctx));
  const originalCreateMediaStreamDestination = proto.createMediaStreamDestination;
  proto.createMediaStreamDestination = function (this: AudioContext) {
    touch(this);
    return originalCreateMediaStreamDestination.call(this);
  };
  const baseProto = BaseAudioContext.prototype;
  const originalCreateScriptProcessor = baseProto.createScriptProcessor;
  baseProto.createScriptProcessor = function (
    this: BaseAudioContext,
    ...args: Parameters<typeof originalCreateScriptProcessor>
  ) {
    touch(this);
    return originalCreateScriptProcessor.apply(this, args);
  };

  /* ---- calls ---- */
  const applyCallState = () => {
    const inCall = window.__carrierInCall === true;
    for (const ctx of live) {
      gateOf(ctx)?.setInCall(inCall);
      sync(ctx);
    }
  };
  window.addEventListener("carrier:protection-change", applyCallState);
}
