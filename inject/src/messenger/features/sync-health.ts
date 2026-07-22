/* --------------------------- Sync health ------------------------------ */
// The realtime transport can be healthy while Facebook refuses every actual
// sync query (observed 2026-07-22: a throttled session kept its MQTT socket
// but got no data — the app silently showed stale chats for hours). Nothing
// local can fix a server-side refusal, so the honest move is to say so.
// Two complementary detectors, because Messenger's sync engine lives in a
// worker whose network traffic the page cannot see:
//  - request-level: page-context GraphQL over fetch and XHR, failure-majority
//    in a rolling window;
//  - symptom-level: a loading spinner that stays visible for minutes.

import { diag, toast } from "../bridge";
import {
  isMessengerSyncRequest,
  SampledPersistence,
  STUCK_LOADING_SAMPLES,
  SyncHealthTracker,
  syncResponseSucceeded,
} from "../lib/sync-health";
import { isMessengerContentPath } from "../lib/threads";

const SYNC_CHECK_INTERVAL_MS = 10_000;

export function initSyncHealth() {
  const tracker = new SyncHealthTracker();

  try {
    const nativeFetch = window.fetch;
    const wrappedFetch = new Proxy(nativeFetch, {
      apply(target, thisArg, args: Parameters<typeof fetch>) {
        let tracked: number | undefined;
        try {
          const input = args[0];
          const url =
            typeof input === "string" || input instanceof URL
              ? String(input)
              : input instanceof Request
                ? input.url
                : "";
          if (url && isMessengerSyncRequest(url, location.href)) {
            tracked = tracker.started(Date.now());
          }
        } catch (_) {}
        const result = Reflect.apply(target, thisArg, args);
        if (tracked !== undefined) {
          const id = tracked;
          // Observe the outcome without altering the promise Messenger gets.
          result.then(
            (response) => {
              if (syncResponseSucceeded(response.status)) tracker.succeeded(id, Date.now());
              else tracker.failed(id, Date.now());
            },
            () => tracker.failed(id, Date.now()),
          );
        }
        return result;
      },
    });
    Object.defineProperty(window, "fetch", {
      value: wrappedFetch,
      writable: true,
      configurable: true,
    });
  } catch (_) {
    diag("sync.requests", "could not observe Messenger sync fetches");
  }

  try {
    const xhrUrls = new WeakMap<XMLHttpRequest, string>();
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest["open"]>
    ) {
      try {
        xhrUrls.set(this, String(args[1]));
      } catch (_) {}
      return nativeOpen.apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest["send"]>
    ) {
      try {
        const url = xhrUrls.get(this);
        if (url && isMessengerSyncRequest(url, location.href)) {
          const id = tracker.started(Date.now());
          this.addEventListener("loadend", () => {
            if (syncResponseSucceeded(this.status)) tracker.succeeded(id, Date.now());
            else tracker.failed(id, Date.now());
          });
        }
      } catch (_) {}
      return nativeSend.apply(this, args);
    } as typeof XMLHttpRequest.prototype.send;
  } catch (_) {
    diag("sync.requests", "could not observe Messenger sync XHRs");
  }

  const stuckLoading = new SampledPersistence(STUCK_LOADING_SAMPLES);
  const loadingSpinnerVisible = () => {
    try {
      for (const el of document.querySelectorAll('[role="progressbar"]')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1) return true;
      }
    } catch (_) {}
    return false;
  };

  let degraded = false;
  let announcePending = false;
  let announced = false;
  setInterval(() => {
    const now = Date.now();
    tracker.sweep(now);
    // Only sample the spinner while the page is visible Messenger content — a
    // hidden window may legitimately pause loading work mid-spinner.
    if (!document.hidden && isMessengerContentPath(location.pathname)) {
      stuckLoading.observe(loadingSpinnerVisible());
    }
    const degradedNow = tracker.degraded(now) || stuckLoading.persistent();
    if (degradedNow && !degraded) {
      degraded = true;
      announcePending = true;
      announced = false;
      const reason = stuckLoading.persistent()
        ? "loading UI stuck"
        : `requests failing (${tracker.summary(now)})`;
      diag("sync.stalled", `messenger sync degraded: ${reason}`);
    } else if (!degradedNow && degraded) {
      degraded = false;
      announcePending = false;
      if (announced) toast("Messenger sync recovered.");
      announced = false;
      diag("sync.stalled", "messenger sync recovered");
    }
    // Announce when the user can actually see it. While offline the realtime
    // recovery machinery owns the messaging — failed requests are expected.
    if (degraded && announcePending && !document.hidden && navigator.onLine) {
      announcePending = false;
      announced = true;
      toast(
        "Messenger is struggling to sync — chats may be out of date. This is usually a Facebook-side problem that recovers on its own.",
      );
    }
  }, SYNC_CHECK_INTERVAL_MS);
}
