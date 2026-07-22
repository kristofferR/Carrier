/* --------------------------- Sync health ------------------------------ */
// The realtime transport can be healthy while Facebook refuses every actual
// sync query (observed 2026-07-22: a throttled session kept its MQTT socket
// but got no data — the app silently showed stale chats for hours). Nothing
// local can fix a server-side refusal, so the honest move is to say so:
// watch Messenger's own GraphQL requests and toast when they are all failing.

import { diag, toast } from "../bridge";
import {
  isMessengerSyncRequest,
  SyncHealthTracker,
  syncResponseSucceeded,
} from "../lib/sync-health";

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
    diag("sync.requests", "could not observe Messenger sync requests");
  }

  let degraded = false;
  let announcePending = false;
  let announced = false;
  setInterval(() => {
    const now = Date.now();
    tracker.sweep(now);
    const degradedNow = tracker.degraded(now);
    if (degradedNow && !degraded) {
      degraded = true;
      announcePending = true;
      announced = false;
      diag("sync.stalled", `messenger sync degraded (${tracker.summary(now)})`);
    } else if (!degradedNow && degraded) {
      degraded = false;
      announcePending = false;
      if (announced) toast("Messenger sync recovered.");
      announced = false;
      diag("sync.stalled", "messenger sync recovered");
    }
    // Announce when the user can actually see it. While offline the realtime
    // recovery machinery owns the messaging — failed fetches are expected.
    if (degraded && announcePending && !document.hidden && navigator.onLine) {
      announcePending = false;
      announced = true;
      toast(
        "Messenger is struggling to sync — chats may be out of date. This is usually a Facebook-side problem that recovers on its own.",
      );
    }
  }, SYNC_CHECK_INTERVAL_MS);
}
