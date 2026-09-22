# Messenger sync recovery

Responsive Messenger pages repair the messaging worker without navigation.
Focus, visibility, wake, notifications, and going online trigger health checks;
they are no longer reasons to periodically reload the page.

## Detection and recovery

The encrypted connection state and worker heartbeat are authoritative. A healthy
page-owned Facebook socket cannot hide a failed encrypted-message bridge. Three
failed heartbeat probes establish a worker failure. A settled, failed bootstrap
also counts, even if this account has never connected on this installation.
Successful bootstrap arms a 90-second deadline for the first encrypted
connection, so a worker that answers heartbeats but never connects cannot look
healthy forever. An uninitialized connection-state module alone does not arm it.
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
Only 60 seconds of verified health replenishes the budget: successful backend
setup, an explicitly connected encrypted transport, and a worker heartbeat less
than 15 seconds old. Page MQTT or an unavailable connection-state API cannot
refund attempts. A hung initialization
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

## What the native Messenger app teaches us

Read-only inspection of `/Applications/Messenger.app` version 520.0.0.67.107
(build 777169777) found a native Catalyst app with LightSpeedCore and
LightSpeedEngine. Exported symbols and targeted disassembly establish separate
force-reconnect, connection-fallback, and network-context dispatch paths.
Server-ping configuration explicitly distinguishes result notification,
reconnection on ping timeout, and timeout duration. Embedded strings describe
idle guards, disconnected-network checks, reconnect-on-send-error, and connection
blackout logging. Configuration schemas also contain keepalive, acknowledgement
timeouts, retry backoff, and foreground-reset controls. Schemas and strings do
**not** prove which flags are active or their production values.

The current web worker already implements much of this. Inspection of its
served static bundles on 2026-09-22 found:

| Layer | Existing Messenger behavior | Carrier's responsibility |
| --- | --- | --- |
| Encrypted network | `WAComms.sendPing` matches a response to both socket and stanza IDs. Its configured dead-socket timer is 20 seconds; idle health checks use a randomized 20–40 second interval. | Do not mistake the page's worker heartbeat for this server ping. |
| Socket retries | A Fibonacci retry loop starts at 10 seconds, caps at 60 seconds, and includes jitter. The worker has reset, abort, and close/resume methods. | Let the worker own its socket retries; avoid competing periodic reconnects. |
| Page bridge | `getWorkerHeartbeat` immediately resolves inside the worker, independently of encrypted network connectivity. | Repair a broken bridge in place, then require separate connection evidence before refunding attempts. |
| Initial catch-up | Offline-consumer progress reaches page state, but the completion flag is set on both success and failure. | Do not use that flag to certify message freshness. |

The normal page-to-worker RPC routes inspected do not expose the server-ping,
force-reconnect, or last-inbound timestamp methods. Reattaching a bridge to an
already initialized shared worker does not restart its encrypted socket. Calling
a page-local copy of `WAComms` would not control that worker. Carrier does not
turn on Meta's gated development bridge, inject replacement worker scripts, or
bind to native Messenger's private binaries to cross this boundary.

A `force-flush-data` control message exists, but its queue implementation resets
an in-flight guard and invokes the unload path. It is not a safe general-purpose
repair for a live page and is not used. Likewise, catching up an old queue is not
proof that a newer message has arrived. The improvement adopted here is layered
verification and bounded recovery, not an assertion of end-to-end freshness.

Only static application code, symbols, and sanitized state were inspected.
Native binaries and extracted web modules remain in the private investigation
archive, outside the repository; no proprietary code is incorporated into Carrier.

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
