# Blank Messenger window diagnostics

## 2026-09-17 Linux incident

Carrier 1.14.0 debug remained blank on Hyprland 0.56.2, using WebKitGTK
2.52.6, GTK 3.24.52 and the Wayland backend. The app, network process and web
process were alive. There was no recent core dump, OOM kill or recorded GPU reset.

The live document answered JavaScript and contained a populated Messenger DOM:
3,266 elements, sidebar and conversation regions with visible bounds, and normal
body/root visibility and opacity. The compositor reported the window mapped on
the active workspace, tiled beside another window without overlap.

Both the page's wrapped `requestAnimationFrame` and WebKit's native
`webkitRequestAnimationFrame` delivered zero callbacks. In a five-second native
probe, 19 ordinary 250 ms timer callbacks fired. A subsequent 25-second test of
`RenderHealthProbe` reported `stalled` after 15 seconds while the document
remained visible. The probe did not change the DOM, focus, window geometry or
navigation, and cancelled its outstanding frame request when finished.

The last recovery log at 22:05:39 Europe/Oslo said a foreground refresh was
requested. The live document's time origin was still 16:50:16 that day. This
proves the request did not replace the document; it does not prove that the
request caused the blank window. `location.reload` was still native.

`WEBKIT_DISABLE_DMABUF_RENDERER=1` was already present in the web process, so
enabling that existing workaround is not a new fix for this incident. These
observations narrow the fault to frame delivery/rendering below page scheduling,
but do not distinguish WebKit's lifecycle/frame clock, GTK, the compositor or the
graphics driver. Attaching a debugger was blocked by ptrace permissions; no
security settings were changed and no process was restarted for diagnosis.

The MCP console bridge had tried to forward 18 log entries, all rejected with
`mcp.push_log not allowed`. Its empty log buffer was therefore not evidence of
an absence of console errors. The dev-only capability now allows `mcp:allow-push-log`.

The window later became visible without a new process or document, but the open
chat contained only one message and a loading placeholder. During that partial
reappearance, native and wrapped frame callbacks still did not fire over five
seconds, and a new IntersectionObserver on the message log did not deliver its
initial callback; ordinary timers fired 19 times. It then became blank again
while the same populated document remained responsive. A later user-authorized
restart of the unchanged installed build restored both frame callbacks and the
observer callback; the open message log contained 14 articles. This supports
treating a brief visual reappearance as insufficient evidence of recovery, while
still leaving the underlying cause unproven.

## What Carrier records

- Heartbeats sample one animation frame at most every heartbeat. There is no
  continuous animation loop. A 15-second wait across successive visible samples
  reports stalled delivery. Hiding, page teardown and long sampling gaps cancel
  the request and reset the observation window.
- Native logs report the first stall, a stall gaining focus, and actual frame
  delivery resuming. Hidden/pending samples do not repeatedly reopen the same
  episode. A new document has a separate episode.
- Linux stall reports include GTK mapping, visibility, drawable/realized state,
  geometry, scale, frame counter, WebKit responsiveness, load progress and
  acceleration policy. They contain no page text, URLs or screenshots.
- Linux logs load errors (domain and known error codes only), TLS error flags,
  web-process termination reasons and responsiveness changes. Debug builds also
  log load phases, map/unmap events and the renderer workaround flags.
- Debug builds log the first heartbeat from each document. Page-side recovery
  logs `sync.reload-unfinished` if the same document survives 15 seconds after
  requesting a reload, including whether `beforeunload` ran.

## Bounded frame recovery

After the probe reports a stall, a focused window needs another 30 seconds of
continuous stalled samples; an unfocused window needs 120 seconds. Both the
native window and document must report visible, the window must not be minimized,
and the page must be a Messenger inbox/thread route. These thresholds are roughly
45 and 135 seconds from the first unanswered frame request, plus polling time.
Focus changes, hiding, navigation and long sample gaps restart confirmation.

Unfocused windows reported visible are deliberately eligible. GTK/Tauri visibility
does not reliably distinguish an exposed window from one covered by another app,
so a covered window can be reloaded after the longer delay.

Recovery respects draft/call protection, DNS reachability and account rate-limit
cooldowns. It attempts one native reload, waits at least 60 seconds for frames,
then rebuilds that window once if necessary. A changed document or a responsive
JavaScript heartbeat alone is not successful recovery. The rebuild budget follows
the replacement window; another healthy window cannot reset it. Further native
watchdog recovery stops and logs exhaustion until frame samples stay healthy for
60 seconds. Existing page-side lifecycle/sync refresh rules remain separate.
An unfocused replacement is created without requesting focus. If native window
construction fails after its bounded retries, frame recovery logs the failure
and stops rather than restarting the whole app and resetting its budget.

Logs identify the initial reload, escalation, failure and exhausted budget. This
is a recovery policy for the observed failure, not a confirmed root-cause fix.

## Preserve the next occurrence

Before restarting or changing rendering settings, collect `Carrier.log`, process
lifetimes, kernel crash/OOM/GPU messages and the native/frame diagnostics above.
For debug launches with redirected output, also collect `debug-stdout.log` and
`debug-stderr.log` from the app's log directory. The Settings log-folder action
locates that directory; on Linux it is normally under
`~/.local/share/io.github.kristofferr.carrier/logs/`.

With MCP, inspect `window.__TAURI_MCP_LOG_STATS__` before interpreting an empty
`query_logs` result. Use counts and geometry to inspect Messenger; avoid dumping
the DOM, messages, conversation URLs, cookies or storage. Keep raw console logs
local because Facebook may include private data in them.

WebKit's [load lifecycle documentation](https://webkitgtk.org/reference/webkit2gtk/2.37.90/class.WebView.html)
describes how `Started`, `Committed`, failure and `Finished` relate. Its
[graphics documentation](https://docs.webkit.org/Ports/WebKitGTK%20and%20WPE%20WebKit/Graphics.html)
explains the separate rendering and presentation paths. Neither source confirms
the root cause of this particular incident.
