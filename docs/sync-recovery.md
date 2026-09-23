# Messenger sync recovery

Responsive Messenger pages repair the messaging worker without navigation.
Focus, visibility, wake, notifications, and going online trigger health checks;
they are no longer reasons to periodically reload the page.

## Detection and recovery

The encrypted connection state and worker heartbeat are authoritative. A healthy
page-owned Facebook socket cannot hide a failed encrypted-message bridge. Three
failed worker probes establish a worker failure. A settled, failed bootstrap
also counts, even if this account has never connected on this installation.
Successful bootstrap arms a 90-second deadline for the first encrypted
connection, so a worker that answers heartbeats but never connects cannot look
healthy forever. An uninitialized connection-state module alone does not arm it.
An explicitly started backend setup also has a 90-second deadline to settle,
independent of page MQTT traffic or availability of the encrypted bridge/state
APIs. A setup that has not settled remains protected from competing initialization;
the guarded worker lifecycles below can rescue a stalled encrypted opening.
Recovery waits another 15 seconds for fresh probes, including after wake.

Carrier uses Messenger's existing worker lifecycle:

- If the page has a worker ID, invoke its registered watchdog recovery callback
  with that exact ID. This closes and reattaches the page's bridge. If encrypted
  health remains unverified through the first observation window, a later
  attempt can ask Messenger to restart the shared worker. This escalation
  requires BroadcastChannel, a fresh native inventory showing exactly one
  Messenger window, multi-instance mode off, an unchanged account, worker ID,
  setup promise and replay closure, and a settled backend. It is used at most
  once per unhealthy episode. Messenger's own close listener rebuilds the
  backend in the same document; Carrier does not race it with a second setup call.
- A shared-worker bootstrap still pending after 90 seconds can use that same
  shutdown route once the recovery controller has also observed 30 seconds
  of busy state. It requires a captured same-account setup, a known shared-worker
  identity, a strictly disconnected connection-state manager, and an already
  resolved page bridge with a compatible `close` method. Bridge readiness has
  its own eight-second read-only deadline. Account, worker ID, state-manager
  identity, bridge promise, setup closure, and pending/disconnected state are
  rechecked after inspection. The sole-window and other protection gates still
  apply, and this spends the episode's one shared restart. Messenger's own close
  listener owns replacement; Carrier never rejects or replays the pending setup.
  A pending page bridge, unassigned worker ID, unknown
  connection state, or multiple windows retains manual recovery.
- If startup failed before assigning an ID and no shared worker exists, replay
  the original setup call. The document-start module interceptor retains its
  original arguments and callbacks in memory, scoped to the current account.
  No key material, message contents, or callback arguments are logged or stored.
- If Messenger selected a **dedicated** worker, use its own
  `terminateDedicatedWorker` path to close the bridge and terminate that page's
  `Worker`, then replay the captured setup. This requires the same worker bridge
  promise before and after asynchronous inspection, a settled backend, the
  exact `dedicated` ID, and successful termination. A failed dedicated startup
  with no worker can also replay setup without termination. Calls, drafts, and
  account changes retain the same protections as shared-worker recovery.
- A pending dedicated bootstrap uses Messenger's registered
  `setOnCloseForWorkerInstance` callback instead. That native callback closes the
  page's Worker, resets backend/portal/creation state, and starts its own setup
  closure. The document-start hook captures only the observed three-argument
  callback ABI, scoped to the current account. As with shared startup, this
  requires a 90-second-old strictly disconnected setup, a ready page bridge,
  an unchanged lifecycle callback and setup closure, and all mutation guards.
  The callback registration starts a new startup grace period even when
  Messenger reinitializes internally. This consumes the episode's one lifecycle
  restart; it does not require sole-window ownership because the dedicated
  Worker belongs to this page.
- A setup call that replaces the captured replay closure while an asynchronous
  worker-status check or dedicated termination is pending wins the race; Carrier
  will not replay either the old or new closure on that attempt.
- Unknown module signatures, unsupported worker kinds, and account changes fail
  open. Carrier never manually resets an unsettled initialization.

There is at most one recovery invocation in flight. A recovery episode allows
three attempts with 30-second observation windows and 15/60-second backoff.
Transient worker-status or callback failures spend one attempt and retain the
remaining retries; missing or incompatible APIs stop automatic mutation.
Read-only worker-status and native-window queries each have an eight-second
deadline. Expiry abandons the observation and releases Carrier's recovery
invocation for its remaining bounded retries. Late query results cannot reach a
mutation, and elapsed time is checked again on response in case suspension
delayed the timeout task. This deadline is deliberately not applied to setup or
termination: abandoning those operations could leave two initializations racing.
Even a brief verified-health sample that ends an observation window preserves
the next-attempt backoff if connectivity drops again. Account switches start a
new budget and connection history, without racing an old in-flight setup.
Only 60 seconds of verified health replenishes the budget: successful backend
setup and a connected state delivered from the worker less than 15 seconds ago.
The current probe requests
`backend/resendWorkerStateManagerValuesToMainThread` and waits for both its reply
and a newly delivered connection-state notification. This tests worker
responsiveness and state delivery together. The page's cached `isConnected()`
value alone cannot certify recovery. Freshness is timed from state receipt,
not a potentially delayed RPC reply. Account, worker ID, and state-manager
identity must still match when the result is used.

A real browser offline-to-online transition gives Messenger's own reconnect
loop 15 seconds before Carrier considers another worker repair. If the normal
episode is exhausted and encrypted health is still unverified, that transition
grants **one** additional attempt. Further network flaps cannot add attempts
until 60 seconds of verified health resets the episode. Focus, wake, and a
synthetic online event without a preceding offline observation do not grant a
retry. Draft, call, rate-limit, sleep, and Hold Failures guards still apply.

A missing subscription API or an explicit missing-route error falls back to
the ordinary heartbeat, which proves responsiveness only. A freshly delivered
disconnected state also does not claim transport health. Probe-failure streaks
reset when the account, worker ID, or state manager changes. The previous worker's
failed-probe verdict is withdrawn synchronously at that boundary, even while its
last probe is pending, so the next recovery tick cannot act on obsolete evidence.
The boundary also restarts the controller's probe grace without refunding attempts;
an expired global health deadline cannot bypass that replacement observation window.
A successful RPC
with no state delivery instead times out after eight seconds. Listeners are
removed on success, failure, and timeout; late replies cannot launch fallback
requests or certify a replaced worker. Page MQTT or an unavailable
connection-state API cannot claim encrypted transport health or refund attempts.
Once an encrypted disconnect has been observed, a missing or malformed state API
cannot clear it or restart its grace period. It remains a fault until a fresh
connected notification and RPC reply arrive, or a real account/worker-ID boundary
starts new observation. Restoring only a cached `true` value is insufficient.
A ready backend or remembered encrypted connection also starts a 90-second
verification deadline while fresh proof is absent. Replacing a worker gives it
new observation grace, but cached `true` and heartbeat-only fallback cannot
leave it apparently healthy forever.
A hung initialization
keeps the single-flight guard even after its timeout; a second setup must not
race it. If health briefly returns at that timeout and later fails again, the
manual failure controls appear while the old setup is still pending. Successful
invocation alone is not proof of a working connection.
An already busy Messenger does not spend a repair attempt. Readiness checks
continue; a prolonged busy state enables guarded pending-startup escalation
and otherwise offers manual recovery while awaiting setup.
Content-free diagnostics distinguish inspection timeouts from pending setup or
termination. A return to verified encrypted health records elapsed time since the
observed failure and the number of recovery requests, scoped to this account.
That elapsed time includes suspension/offline time and does not assert a measured
server blackout or message-delivery delay. A recovered sample still needs the
normal sustained-health period before replenishing the retry budget.

Calls, drafts, offline state, sleep, rate limiting, and **Hold Failures** prevent
automatic worker mutation. Exhausted or unsupported recovery leaves the page
in place and offers **Reconnect** and **Reload**. Reload preserves the existing
draft/call and rate-limit protections. Server rate-limit recovery still follows
its separately coordinated cooldown. Sleep and wake reset the 15-second stale
settle timer before any new mutation.
On Linux and Windows, a health-timer gap longer than 15 seconds (or a backwards
wall-clock jump) also resets this grace period before the next recovery tick.
macOS uses its native power snapshots. Resetting the settle period discards the
previous healthy-observation streak, so time asleep cannot replenish retries.
It also restarts a pending recovery's observation deadline without refunding an
attempt. The deadline callback itself checks for a health-tick gap, protecting
the case where it runs before the first resumed interval. A suspended renderer
therefore cannot exhaust all retries merely by delivering an overdue timeout.

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

Further inspection and a private synthetic test on 2026-09-23 showed why simply
exposing the worker's `forceResetSocketLoop` would not safely fix an opening or
handshake stall. The retry-loop reset starts a replacement operation without
waiting for the old operation to settle. Its generation check prevents old loop
iterations from starting, but does not fence the socket assignment inside an
already running `WAComms.socketLoopIteration`. In both inspected retry-loop
implementations, aborting the old signal and resetting the loop let two opening
attempts coexist. Resolving the newer attempt first, then the older one, made
the older socket active again while both sockets remained open. The fake opener
ignored cancellation, matching the inspected Messenger-specific opener's lack of
signal consumption. This proves the cancellation/generation gap in those code
paths, not that this race occurred in the user's live session.

Carrier consequently bounds only its read-only inspection waits and uses the
guarded worker lifecycle above to replace a failed transport. Implementing a
socket-level opening/handshake deadline still requires a worker-owned route that
actually closes pending transports and fences late completions; none was found
among the normal page RPC routes inspected. Native force-reconnect symbols alone
do not supply that capability to the web app.

A `force-flush-data` control message exists, but its queue implementation resets
an in-flight guard and invokes the unload path. It is not a safe general-purpose
repair for a live page and is not used. Likewise, catching up an old queue is not
proof that a newer message has arrived. The improvement adopted here is layered
verification and bounded recovery, not an assertion of end-to-end freshness.

Only static application code, symbols, and sanitized state were inspected.
Native binaries and extracted web modules remain in the private investigation
archive, outside the repository; no proprietary code is incorporated into Carrier.

## Message-processing diagnostics

An encrypted connection and a responsive bridge do not prove that message batches
committed to the page's database. Carrier observes the existing
`MAWBridgeUIEventQueueQPLLogger` transaction boundaries without inspecting their
payloads. Recovery snapshots include pending, completed, failed, and omitted
counts plus the oldest pending batch's active time. A failed batch or one still
pending after two minutes of observed foreground, online, awake time produces a
diagnostic. Idle conversations, background time, and suspended timer gaps do not
establish a processing stall. An unrelated completion cannot clear an older
pending batch.

Tracking retains at most 128 numeric logger instance keys in memory and never
serializes them. Account changes reset the counters and diagnostic baselines.
The shared diagnostic logger retains its per-key one-minute rate limit across
accounts; snapshots still include every counted failure when a log is throttled.
Changed or frozen logger exports remain untouched. These are diagnostic signals,
not automatic retry triggers: a legitimate restore can run slowly, and batch
replay has not been proven safe. Coverage excludes waiting for database readiness
before the transaction logger starts and newer shim handlers that bypass it.

## Shared-worker shutdown boundary

The inspected shared-worker shutdown path releases its status lock, broadcasts
a shutdown notification to its connected ports, then calls `close()`. Its
connected-port set does not establish exclusive ownership, and the handler does
not check a caller-supplied worker generation. A private harness running the
actual extracted handler with two synthetic clients confirmed that both clients
are affected, even with a mismatched requested generation. A further synthetic
test made the notification send throw twice: the lock was released but execution
never reached `close()`.

This proves a control-flow limitation, not that closed browser ports normally
throw or that it caused the original outage. Neither the notification nor lock
release alone is a safe restart barrier. Carrier therefore never treats the
shutdown request as proof of recovery or starts a competing setup itself.
Messenger's existing close listener owns the replacement, and Carrier requires
fresh encrypted state from the resulting worker before crediting health.

The automatic escalation is restricted to a fresh native inventory with one
Messenger window, and is skipped if multi-instance mode is on or the inventory
cannot be read. It also requires the synchronous BroadcastChannel request path;
other windows continue using page-local bridge repair. A native
window query is a point-in-time guard, so a window opened at the exact moment of
shutdown remains a theoretical race. Active calls and drafts in this page block
recovery; multi-window calls are protected by the one-window requirement.

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
- Run the compiled state monitor in the live diagnostics page. Drop only the
  connection-state delivery handler for one probe: the cached state remains true,
  but the missing update invalidates verified health after the deadline. Restore
  delivery and verify the next probe succeeds in the same document. The temporary
  handler and WebSocket wrapper are restored after the test.
- Run the current recovery adapter and state monitor in the installed diagnostics
  page, close its MessagePort, and verify recovery in the same document and
  conversation. Send one explicitly authorized, labelled test message through
  the composer afterward: Messenger reports **Sent**, and the processing monitor
  records three completed batches, zero failures, and zero pending batches.
  No delivered/read receipt was observed. The separate send-report callback
  probe received no event, so it supplies no additional acknowledgement proof.
  All temporary hooks were restored and the composer was left empty.
- Run the extracted transaction handler against Carrier's actual processing
  collector with a synthetic database. Successful, rejected, and indefinitely
  pending transactions produce the corresponding counters; a database-readiness
  promise that never settles remains unobserved, as expected from the coverage
  boundary above.
- Run the extracted `WorkerMessagePort` module against a synthetic dedicated
  worker. Its bridge `close()` calls `terminate()` once, and the synced bridge
  inherits that implementation. Focused recovery tests cover replay order,
  changing worker bridges, account changes, failed termination, and a missing
  dedicated worker. A separate live test below exercises the native dedicated
  lifecycle with unfinished setup.
- With one healthy signed-in diagnostics window, call Messenger's own shared
  shutdown route once under the normal no-draft/no-call guards. Five seconds
  later the worker ID had changed, backend setup and encrypted connection were
  healthy, and the document epoch had not changed. This proves the route can
  rebuild that live session in place; it is not a forced handshake-blackhole
  test or proof of safe multi-window shutdown.
- Run the compiled recovery adapter against the live signed-in session with an
  isolated loader that makes only its first worker-status query remain pending.
  It returns `inspection-timeout` after 8,001 ms, releases the recovery guard,
  and a subsequent real bridge repair succeeds. Resolving the old query late
  causes no second repair. A fresh worker-state notification and RPC reply report
  connected, with backend setup ready and the same document and DOM root.
  No page module is replaced and no message is sent by this test.
- Start the candidate diagnostics binary through a process-local CONNECT proxy
  that forwards normal HTTPS traffic but accepts and stalls encrypted-chat TLS
  tunnels. Three real connection-opening attempts remain pending; backend setup
  is unsettled and encrypted connectivity is false. Allow new tunnels while
  leaving those three existing attempts blocked. The new guarded startup path
  invokes Messenger's close lifecycle automatically: its lifecycle record reports
  exactly one `carrier-sync-recovery` restart, all three old tunnels close, and
  one new encrypted-chat tunnel opens. By the 104-second observation the backend
  is ready, the worker ID has changed once, fresh state delivery and RPC reply
  confirm connectivity, and the document and DOM root are unchanged. The proxy
  never decrypts TLS or records payloads. It affects only the candidate process;
  the original diagnostics app is restored afterward. No message is sent.
  This verifies an actual TLS/opening stall, not every later Noise-handshake,
  database initialization, or browser-engine failure.
- Repeat the CONNECT blackhole with Messenger's dedicated-worker selection
  enabled only in the candidate page. Three real encrypted TLS attempts stay
  blocked while backend setup is pending. Permit new connections without
  releasing those attempts. By the 93-second observation Carrier has invoked
  exactly one native lifecycle restart, all three blocked tunnels have closed,
  and a new tunnel has connected. The dedicated bridge promise has changed,
  backend setup is ready, and fresh connection-state delivery plus RPC reply
  report connected. The document and DOM root remain unchanged. The temporary
  gate override disappears when the candidate exits; the original diagnostics
  app is restored and no message is sent.

The final tests ran with one signed-in instance at a time. Running the original
and copied profile together produced conflicting connectivity results, so it
cannot establish reliable recovery of the copied encrypted-device identity.

Unit and browser fixtures cover account boundaries, ABI changes, asynchronous
protection checks, single-flight behavior, finite retries, draft preservation,
one bounded repair after network restoration, native `managed` reporting, and
healthy lifecycle events. Rust tests verify that
native renderer/error supervision remains active during page-managed recovery.

These tests prove recovery of the worker failures above and a subsequent message
reaching Messenger's **Sent** state. They do not establish recipient delivery,
incoming-message catch-up after every outage, or uninterrupted active calls.
Messenger's private APIs can change; unsupported shapes must keep the page usable
and offer manual recovery. A browser-engine failure or server-side outage can
still require a reload or restart. Private logs and the original matching binary
are archived outside the repository under CarrierDebug's investigations directory.
