# Messenger sync recovery

Responsive Messenger pages repair the messaging worker without navigation.
Focus, visibility, wake, notifications, and going online trigger health checks;
they are no longer reasons to periodically reload the page.

## Detection and recovery

The encrypted connection state and worker heartbeat are authoritative. A healthy
page-owned Facebook socket cannot hide a failed encrypted-message bridge. Three
failed heartbeat probes establish a worker failure. A settled, failed bootstrap
also counts, even if this account has never connected on this installation.
Recovery waits another 15 seconds for fresh probes, including after wake.

Carrier uses Messenger's existing worker lifecycle:

- If the page has a worker ID, invoke its registered watchdog recovery callback
  with that exact ID. This closes and reattaches the page's bridge without
  terminating the shared worker, which may serve another window.
- If startup failed before assigning an ID and no shared worker exists, replay
  the original setup call. The document-start module interceptor retains its
  original arguments and callbacks in memory, scoped to the current account.
  No key material, message contents, or callback arguments are logged or stored.
- Unknown module signatures, unsupported worker kinds, and account changes fail
  open. Messenger's ongoing initialization is never reset underneath it.

There is at most one recovery invocation in flight. A recovery episode allows
three attempts with 30-second observation windows and 15/60-second backoff.
Only 60 seconds of verified health replenishes the budget. A hung initialization
keeps the single-flight guard even after its timeout; a second setup must not
race it. Successful invocation alone is not proof of a working connection.
An already busy Messenger does not spend a repair attempt. Readiness checks
continue; a prolonged busy state offers manual recovery while awaiting setup.

Calls, drafts, offline state, sleep, rate limiting, and **Hold Failures** prevent
automatic worker mutation. Exhausted or unsupported recovery leaves the page
in place and offers **Reconnect** and **Reload**. Reload preserves the existing
draft/call and rate-limit protections. Server rate-limit recovery still follows
its separately coordinated cooldown.

The native watchdog receives `managed` while a responsive page owns transport
recovery. This pauses native transport reloads without claiming health or
refunding its recovery budget. Blank pages, static errors, and unresponsive
renderers retain native supervision.

## Linux HTTP/2 pool stall

On 2026-09-22, the installed diagnostics build (revision `14933f3`) had a
responsive document but rejected worker heartbeats with **Worker lock timeout**.
The encrypted connection was false, backend setup had failed, and no worker ID
existed. Worker metadata requests and a fresh same-origin HEAD request hung.
All six Facebook connections in WebKit's network process were in `CLOSE-WAIT`
with unread data. The system used WebKitGTK 2.52.6 and libsoup 3.6.6.

Fresh launches of both the installed build and the candidate reproduced the
network stall. Launching each with `SOUP_FORCE_HTTP1=1` restored HTTP requests and
successful encrypted-worker setup. The candidate also remained healthy across
a subsequent reload. This supports an HTTP/2-path workaround; it does not
identify the exact upstream defect.

Carrier therefore defaults its Linux WebKit processes to HTTP/1.1 before startup.
TLS, cookies, proxy configuration, and WebSockets remain in WebKit's normal
network stack. The tradeoff is losing HTTP/2 multiplexing. macOS and Windows are
unaffected. Existing `SOUP_FORCE_HTTP1` values are preserved. To test an updated
system library with HTTP/2, unset that variable and launch with
`CARRIER_LINUX_HTTP2=1`. Note that libsoup treats even `SOUP_FORCE_HTTP1=0` as
enabled because it checks the variable's presence.

Do not remove the workaround solely because a version number increased. Repeat
startup, idle, and wake testing on the affected installation with HTTP/2 enabled.
Upstream [libsoup release notes](https://github.com/GNOME/libsoup/blob/master/NEWS)
describe GOAWAY and other HTTP/2 fixes after 3.6.6, but those fixes have not been
verified against this incident. The environment switch is implemented in
[libsoup's connection manager](https://github.com/GNOME/libsoup/blob/3.6.6/libsoup/soup-connection-manager.c).

Killing only the network helper restored HTTP in an early experiment but did
not reliably restore the existing document's worker/storage state. Carrier does
not automate this. WebKit has also documented [IndexedDB connection problems
after network-process crashes](https://bugs.webkit.org/show_bug.cgi?id=309386).

## Validation and remaining limits

Live tests used a diagnostics build and a separate persistent signed-in profile:

- Close only this page's worker MessagePort, confirm failed heartbeats, and let
  automatic recovery run. Verify a successful heartbeat, encrypted connectivity,
  and unchanged document, DOM root, and conversation.
- Reject `MAWWebWorkerSingleton.createWorkerIfNone` during startup and Messenger's
  own fallback, allowing only the `bridgeRecovery` retry. The actual document-start
  hook captures the failed setup. Three initial calls fail (`t2init`, `mawInit`,
  `backendSetupFailure`); Carrier's fourth call succeeds in the same document.
  Fault injection is confined to a local test binary and is not shipped.

The final tests ran with one signed-in instance at a time. Running the original
and copied profile together produced conflicting connectivity results, so it
cannot establish reliable recovery of the copied encrypted-device identity.

Unit and browser fixtures cover account boundaries, ABI changes, asynchronous
protection checks, single-flight behavior, finite retries, draft preservation,
native `managed` reporting, and healthy lifecycle events. Rust tests verify that
native renderer/error supervision remains active during page-managed recovery.

These tests prove recovery of the worker failures above, not delivery of a newly
sent message or an active call. No messages were sent during the investigation.
Messenger's private APIs can change; unsupported shapes must keep the page usable
and offer manual recovery. A browser-engine failure or server-side outage can
still require a reload or restart. Private logs and the original matching binary
are archived outside the repository under CarrierDebug's investigations directory.
