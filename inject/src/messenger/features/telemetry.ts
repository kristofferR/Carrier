/* ------------------------- Telemetry blocking ------------------------- */
// Short-circuit Facebook's pure analytics/logging requests before they hit
// the network (Settings → Block Facebook telemetry). Messenger batches
// Banzai/Falco/QPL events into POSTs every few seconds, forever — blocking
// them cuts constant background network + CPU chatter. This runs at
// document-start, so fetch/XHR/sendBeacon are wrapped before any Facebook
// script captures them (same trick as the Notification wrapper).
// The setting is consulted per call, so toggling applies without a reload.
import { isBlockedTelemetryUrl } from "../lib/telemetry";

export function initTelemetryBlocking() {
  const on = () => window.__CARRIER_SETTINGS__?.block_telemetry === true;
  const shouldBlock = (raw: string | URL) => on() && isBlockedTelemetryUrl(raw, location.href);

  try {
    const origFetch = window.fetch;
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      try {
        const input = args[0];
        const raw =
          typeof input === "string" ? input : (input && (input as Request).url) || String(input);
        if (raw && shouldBlock(raw)) return Promise.resolve(new Response(null, { status: 204 }));
      } catch (_) {}
      return origFetch.apply(this, args);
    };
  } catch (_) {}

  try {
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    // Rest tuple instead of Parameters<…>: open() is overloaded (2-arg and
    // 5-arg forms) and Parameters<> only captures the last overload.
    proto.open = function (
      this: XMLHttpRequest,
      ...args: [method: string, url: string | URL, ...rest: unknown[]]
    ) {
      try {
        this.__carrierBlocked = shouldBlock(args[1]);
      } catch (_) {
        this.__carrierBlocked = false;
      }
      // Always run the native open, even when blocking: a skipped open leaves
      // the XHR UNSENT and Facebook's setRequestHeader() calls would throw.
      return origOpen.apply(this, args as Parameters<XMLHttpRequest["open"]>);
    };
    proto.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>) {
      if (this.__carrierBlocked && on()) {
        // Skip the network and synthesize a clean empty 200 — Banzai persists
        // unsent batches and retries, so a silently-dropped request would
        // just make it queue and re-send. Own data properties shadow the
        // prototype accessors; async dispatch matches real XHR timing.
        setTimeout(() => {
          try {
            for (const [k, v] of [
              ["readyState", 4],
              ["status", 200],
              ["statusText", "OK"],
              ["responseText", ""],
              ["response", ""],
              ["responseURL", ""],
            ] as [string, string | number][]) {
              Object.defineProperty(this, k, { value: v, configurable: true });
            }
            this.dispatchEvent(new Event("readystatechange"));
            this.dispatchEvent(new ProgressEvent("load"));
            this.dispatchEvent(new ProgressEvent("loadend"));
          } catch (_) {}
        }, 0);
        return;
      }
      return origSend.apply(this, args);
    };
  } catch (_) {}

  try {
    // Patch the prototype so captures like sendBeacon.bind(navigator) made
    // after injection still go through us; .apply keeps the receiver (a bare
    // call would throw Illegal invocation in WebKit).
    const origBeacon = Navigator.prototype.sendBeacon;
    Navigator.prototype.sendBeacon = function (
      this: Navigator,
      ...args: Parameters<Navigator["sendBeacon"]>
    ) {
      try {
        if (shouldBlock(args[0])) return true; // "queued" — callers never see a response anyway
      } catch (_) {}
      return origBeacon.apply(this, args);
    };
  } catch (_) {}
}
