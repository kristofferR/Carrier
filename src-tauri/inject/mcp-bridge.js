/* ===================================================================== *
 *  tauri-mcp guest bridge  —  DEV ONLY (compiled only with `--features mcp`)
 * ===================================================================== *
 *
 * tauri-plugin-mcp drives the webview by *emitting* Tauri events to it
 * (`execute-js`, `got-dom-content`, …) and waiting for a correlated
 * `*-response-<uuid>` event back. The responder that listens for those events
 * ships in the plugin's `guest-js`, which a normal Tauri app imports into its
 * frontend bundle. Carrier's main window is a REMOTE origin (facebook.com), so
 * it never loads that guest-js — which is why every round-trip MCP command
 * (execute_js, get_dom) times out with "Timeout waiting for … response".
 *
 * This file is the missing responder, hand-rolled against the low-level
 * `__TAURI_INTERNALS__` API so it works without `withGlobalTauri` (Carrier keeps
 * that off so Facebook can't see `window.__TAURI__`). It is injected only in
 * `mcp`/debug builds, so release builds never expose a JS-eval responder.
 *
 * Wire protocol (verified against tauri 2.11.3 + tauri-plugin-mcp d5e0b80):
 *   • Rust emits to the webview via `app.emit_to("<label>", "<event>", code)`,
 *     which is `EventTarget::AnyLabel{label}` — matches a listener registered
 *     with `{kind:"WebviewWindow", label}` (NOT `{kind:"Any"}`).
 *   • The plugin wraps a non-object payload as `{_payload, _correlationId}`.
 *   • The reply is a plain global `emit("<event>-response-<id>", data)`, which
 *     reaches the Rust `app.once(...)` listener (target Any).
 */
(function () {
  if (window.__CARRIER_MCP_BRIDGE__) return;

  function safeStringify(v) {
    try {
      return JSON.stringify(v);
    } catch (_) {
      try {
        return String(v);
      } catch (__) {
        return "[unserializable]";
      }
    }
  }

  var DEBUG_PROFILE_KEY = "__carrier_mcp_network_profile__";
  var COMPONENT_NULL_KEY = "__carrier_mcp_component_null__";
  var COMPONENT_PASSTHROUGH_KEY = "__carrier_mcp_component_passthrough__";
  var REACT_PROFILE_KEY = "__carrier_mcp_react_profile__";
  function installModuleRuntimeInstrumentation() {
    if (window.__CARRIER_MCP_MODULE_RUNTIME__) return;
    var families = [
      [
        "telemetry",
        /Banzai|Falco|QPL|ODS|Telemetry|Analytics|Reliability|Logger|ErrorLogging|hyperion/i,
      ],
      ["global-shell", /Comet(?:AppShell|TopNav|AppLoggedInNavigation|LeftRail|Navigation|Settings)/i],
      ["global-notifications", /CometNotifications|Notification.*(?:Badge|Dropdown|List|ThinClient)/i],
      ["global-search", /CometSearch|SearchCometGlobal|CometGlobalTypeahead|GlobalTypeahead/i],
      [
        "messenger-search",
        /(?:MAW|Messenger|MW[A-Z]).*Search|Search.*(?:MAW|Messenger|MW[A-Z])|MAWFTSRestoreSync/i,
      ],
      ["calling", /Calling|WebRTC|Voip|Signaling|Call(?:Controls|UI|Invite|Manager|Tray|Button|Experiment|Summary|Lobby|End|Start|Join|Video|Audio|Room|Peer|Connection)/i],
      ["media", /Video|Audio|Media|Photo|Attachment|Upload|Wasm|Transcode|Thumbnail/i],
      ["stories-reels", /Stories|Story|Reels|Reel/i],
      ["commerce", /Marketplace|Commerce|Payments|Payment/i],
      ["gaming", /Gaming|Game(?:s|play)/i],
    ];
    var state = {
      profile: (function () {
        try {
          return sessionStorage.getItem(DEBUG_PROFILE_KEY) || "none";
        } catch (_) {
          return "none";
        }
      })(),
      registered: 0,
      candidateRegistered: 0,
      executed: 0,
      familyRegistered: {},
      familyExecuted: {},
      familyDurationMs: {},
      modules: {},
      targetDefinitions: {},
      stubbedExports: 0,
      replacedDefinitions: 0,
      reactRegistered: 0,
      reactExecuted: 0,
      reactModules: {},
      componentDependencies: {},
      reactProfile: (function () {
        try {
          return sessionStorage.getItem(REACT_PROFILE_KEY) === "on";
        } catch (_) {
          return false;
        }
      })(),
      componentNull: (function () {
        try {
          return sessionStorage.getItem(COMPONENT_NULL_KEY) || "";
        } catch (_) {
          return "";
        }
      })(),
      componentPassthrough: (function () {
        try {
          return sessionStorage.getItem(COMPONENT_PASSTHROUGH_KEY) || "";
        } catch (_) {
          return "";
        }
      })(),
    };
    window.__CARRIER_MCP_MODULE_RUNTIME__ = state;

    function matchedFamilies(name) {
      var matches = [];
      for (var i = 0; i < families.length; i++) {
        if (families[i][1].test(name)) matches.push(families[i][0]);
      }
      return matches;
    }

    function wrapDefine(nativeDefine) {
      if (typeof nativeDefine !== "function" || nativeDefine.__carrierWrapped) return nativeDefine;
      function wrappedDefine(name, dependencies, factory) {
        var args = Array.prototype.slice.call(arguments);
        var safeName =
          typeof name === "string" && /^[A-Za-z0-9_$.:/-]{1,160}$/.test(name) ? name : "other";
        var matches = matchedFamilies(safeName);
        var isReactModule = state.reactProfile && /\.react$/.test(safeName);
        if (isReactModule) state.reactRegistered++;
        if (
          /^(?:CometNotifications|SearchCometGlobalTypeahead|CometSearch|setupNotifications)/.test(
            safeName,
          ) &&
          Array.isArray(dependencies)
        ) {
          state.targetDefinitions[safeName] = dependencies
            .filter(function (dependency) {
              return (
                typeof dependency === "string" && /^[A-Za-z0-9_$.:/-]{1,160}$/.test(dependency)
              );
            })
            .slice(0, 80);
        }
        state.registered++;
        for (var i = 0; i < matches.length; i++) {
          state.familyRegistered[matches[i]] = (state.familyRegistered[matches[i]] || 0) + 1;
        }
        var replaceNavigationModule =
          (state.profile === "replace-top-nav" && safeName === "CometTopNav.react") ||
          ((state.profile === "replace-global-nav" ||
            state.profile === "replace-global-nav-notifications" ||
            state.profile === "replace-global-nav-stop-fts" ||
            state.profile === "replace-global-nav-disable-hyperion" ||
            state.profile === "replace-global-nav-badge" ||
            state.profile === "replace-global-chrome") &&
            safeName === "CometAppLoggedInNavigation.react") ||
          ((state.profile === "replace-notification-badge" ||
            state.profile === "replace-global-nav-notifications") &&
            safeName === "CometNotificationsBadgeCount.react") ||
          ((state.profile === "replace-global-nav-badge" ||
            state.profile === "replace-global-chrome") &&
            safeName === "CometTopNavTabBadge.react") ||
          (state.profile === "replace-global-chrome" &&
            (safeName === "SearchCometGlobalTypeahead.react" ||
              safeName === "CometSearchKeyCommandWrapper.react"));
        var componentReplacement =
          state.componentNull === safeName
            ? function () {
                return null;
              }
            : state.componentPassthrough === safeName
              ? function (props) {
                  return props && props.children != null ? props.children : null;
                }
              : null;
        if (componentReplacement && typeof factory === "function") {
          state.componentDependencies[safeName] = Array.isArray(dependencies)
            ? dependencies
                .filter(function (dependency) {
                  return (
                    typeof dependency === "string" &&
                    /^[A-Za-z0-9_$.:/-]{1,160}$/.test(dependency)
                  );
                })
                .slice(0, 160)
            : [];
          args[1] = [];
          var replacementRecorded = false;
          var replacementFactory = function () {
            var replaced = false;
            var exportsCandidate = arguments[arguments.length - 1];
            if (
              exportsCandidate &&
              (typeof exportsCandidate === "object" || typeof exportsCandidate === "function")
            ) {
              try {
                exportsCandidate.default = componentReplacement;
                replaced = exportsCandidate.default === componentReplacement;
              } catch (_) {}
            }
            var moduleCandidate = arguments[arguments.length - 2];
            if (
              moduleCandidate &&
              (typeof moduleCandidate === "object" || typeof moduleCandidate === "function") &&
              Object.prototype.hasOwnProperty.call(moduleCandidate, "exports")
            ) {
              try {
                moduleCandidate.exports = componentReplacement;
                replaced = moduleCandidate.exports === componentReplacement || replaced;
              } catch (_) {}
            }
            if (replaced && !replacementRecorded) {
              replacementRecorded = true;
              state.replacedDefinitions++;
            }
            return componentReplacement;
          };
          try {
            Object.defineProperty(replacementFactory, "length", { value: factory.length });
          } catch (_) {}
          args[2] = replacementFactory;
          return nativeDefine.apply(this, args);
        }
        if (replaceNavigationModule) {
          args[1] = [];
          args[2] = function (a, b, c, d, e, f, g) {
            var emptyTopNav = function () {
              return null;
            };
            if (g && (typeof g === "object" || typeof g === "function")) {
              g.default = emptyTopNav;
            } else if (f && typeof f === "object") {
              f.exports = emptyTopNav;
            }
          };
          state.replacedDefinitions++;
          return nativeDefine.apply(this, args);
        }
        if ((matches.length || isReactModule) && typeof factory === "function") {
          if (matches.length) state.candidateRegistered++;
          function invokeFactory(context, invocationArguments) {
            var started = performance.now();
            try {
              var result = factory.apply(context, invocationArguments);
              if (state.profile === "stub-top-nav" && safeName === "CometTopNav.react") {
                for (var exportIndex = 0; exportIndex < invocationArguments.length; exportIndex++) {
                  var candidate = invocationArguments[exportIndex];
                  if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) {
                    continue;
                  }
                  if (
                    Object.prototype.hasOwnProperty.call(candidate, "default") &&
                    typeof candidate.default === "function"
                  ) {
                    candidate.default = function () {
                      return null;
                    };
                    state.stubbedExports++;
                  }
                  if (typeof candidate.exports === "function") {
                    candidate.exports = function () {
                      return null;
                    };
                    state.stubbedExports++;
                  }
                }
              }
              if (
                state.profile === "replace-global-nav-stop-fts" &&
                safeName === "MAWFTSRestoreSync"
              ) {
                for (
                  var ftsExportIndex = 0;
                  ftsExportIndex < invocationArguments.length;
                  ftsExportIndex++
                ) {
                  var ftsExports = invocationArguments[ftsExportIndex];
                  if (ftsExports && typeof ftsExports.getFTSRestoreSync === "function") {
                    var ftsRestore = ftsExports.getFTSRestoreSync();
                    if (ftsRestore && typeof ftsRestore.setKeepWhileLoop_FOR_TESTING_ONLY === "function") {
                      ftsRestore.setKeepWhileLoop_FOR_TESTING_ONLY(false);
                      state.stubbedExports++;
                    }
                  }
                }
              }
              if (
                (state.profile === "disable-hyperion" ||
                  state.profile === "replace-global-nav-disable-hyperion") &&
                safeName === "hyperionAutoLogging"
              ) {
                for (
                  var hyperionExportIndex = 0;
                  hyperionExportIndex < invocationArguments.length;
                  hyperionExportIndex++
                ) {
                  var hyperionExports = invocationArguments[hyperionExportIndex];
                  var autoLogging = hyperionExports && hyperionExports.AutoLogging;
                  if (autoLogging && typeof autoLogging.init === "function") {
                    hyperionExports.AutoLogging = {
                      getInitOptions: autoLogging.getInitOptions,
                      init: function () {
                        return false;
                      },
                    };
                    state.stubbedExports++;
                  }
                }
              }
              return result;
            } finally {
              var duration = performance.now() - started;
              state.executed++;
              var module = state.modules[safeName] ||
                (state.modules[safeName] = { executions: 0, durationMs: 0, families: matches });
              module.executions++;
              module.durationMs += duration;
              if (isReactModule) {
                state.reactExecuted++;
                var reactModule = state.reactModules[safeName] ||
                  (state.reactModules[safeName] = { executions: 0, durationMs: 0 });
                reactModule.executions++;
                reactModule.durationMs += duration;
              }
              for (var familyIndex = 0; familyIndex < matches.length; familyIndex++) {
                var family = matches[familyIndex];
                state.familyExecuted[family] = (state.familyExecuted[family] || 0) + 1;
                state.familyDurationMs[family] =
                  (state.familyDurationMs[family] || 0) + duration;
              }
            }
          }
          // The Haste loader inspects factory.length to select its invocation
          // ABI. Preserve any arity rather than assuming a fixed known range.
          var instrumentedFactory = function () {
            return invokeFactory(this, arguments);
          };
          try {
            Object.defineProperty(instrumentedFactory, "length", { value: factory.length });
          } catch (_) {}
          args[2] = instrumentedFactory;
        }
        return nativeDefine.apply(this, args);
      }
      wrappedDefine.__carrierWrapped = true;
      return wrappedDefine;
    }

    try {
      var current = window.__d;
      if (typeof current === "function") {
        window.__d = wrapDefine(current);
        return;
      }
      var inherited = Object.getOwnPropertyDescriptor(window, "__d");
      if (
        inherited &&
        typeof inherited.get === "function" &&
        typeof inherited.set === "function"
      ) {
        Object.defineProperty(window, "__d", {
          configurable: inherited.configurable,
          enumerable: inherited.enumerable,
          get: function () {
            return inherited.get.call(window);
          },
          set: function (value) {
            inherited.set.call(window, wrapDefine(value));
          },
        });
        return;
      }
      var assigned;
      Object.defineProperty(window, "__d", {
        configurable: true,
        enumerable: true,
        get: function () {
          return assigned;
        },
        set: function (value) {
          assigned = wrapDefine(value);
        },
      });
    } catch (_) {}
  }

  function installDebugNetworkProfile() {
    var profile = "";
    try {
      profile = sessionStorage.getItem(DEBUG_PROFILE_KEY) || "";
    } catch (_) {}
    var state = { name: profile || "none", blocked: 0 };
    window.__CARRIER_MCP_NETWORK_PROFILE__ = state;
    if (profile !== "block-route-definitions") return;

    function shouldBlock(raw) {
      try {
        var url = new URL(
          typeof raw === "string" ? raw : raw && raw.url ? raw.url : String(raw),
          location.href,
        );
        return (
          url.hostname === "www.facebook.com" &&
          url.pathname.indexOf("/ajax/bulk-route-definitions") === 0
        );
      } catch (_) {
        return false;
      }
    }

    try {
      var nativeFetch = window.fetch;
      if (typeof nativeFetch === "function") {
        window.fetch = function (input) {
          if (shouldBlock(input)) {
            state.blocked++;
            return Promise.reject(new TypeError("Carrier debug blocked route definitions"));
          }
          return nativeFetch.apply(this, arguments);
        };
      }
    } catch (_) {}

    try {
      var blockedRequests = new WeakSet();
      var nativeOpen = XMLHttpRequest.prototype.open;
      var nativeSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        if (shouldBlock(url)) blockedRequests.add(this);
        return nativeOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        if (!blockedRequests.has(this)) return nativeSend.apply(this, arguments);
        state.blocked++;
        var request = this;
        setTimeout(function () {
          try {
            request.dispatchEvent(new ProgressEvent("error"));
            request.dispatchEvent(new ProgressEvent("loadend"));
          } catch (_) {}
        }, 0);
      };
    } catch (_) {}
  }

  function setup() {
    var II = window.__TAURI_INTERNALS__;
    if (!II || typeof II.invoke !== "function" || typeof II.transformCallback !== "function") {
      return false;
    }

    installModuleRuntimeInstrumentation();
    installDebugNetworkProfile();
    installPerformanceInstrumentation();

    // The window this script runs in; Rust emits round-trip events to its label.
    var meta = II.metadata || {};
    var label =
      (meta.currentWebview && meta.currentWebview.label) ||
      (meta.currentWindow && meta.currentWindow.label) ||
      "main";
    var target = { kind: "WebviewWindow", label: label };

    function listen(event, handler) {
      // Rust's plugin:event|listen populates its own JS listener registry, so we
      // only have to hand it a transformCallback id. The handler is invoked with
      // `{event, id, payload}`.
      II.invoke("plugin:event|listen", {
        event: event,
        target: target,
        handler: II.transformCallback(handler),
      });
    }

    function emit(event, payload) {
      return II.invoke("plugin:event|emit", { event: event, payload: payload });
    }

    function rect(el) {
      var r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }

    function visible(el) {
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
    }

    function maskText(s, limit) {
      var out = (s || "").replace(/\d{3,}/g, "{id}");
      return typeof limit === "number" ? out.slice(0, limit) : out;
    }

    function maskedHref(el) {
      var href = el && el.getAttribute && el.getAttribute("href");
      return href ? maskText(href) : "";
    }

    function correlationId(p) {
      return p && typeof p === "object" && typeof p._correlationId === "string"
        ? p._correlationId
        : null;
    }

    function respond(baseEvent, cid, data) {
      emit(cid ? baseEvent + "-" + cid : baseEvent, data);
    }

    function setSessionExperiment(value, storageKey, responseField) {
      try {
        if (value === "clear") sessionStorage.removeItem(storageKey);
        else sessionStorage.setItem(storageKey, value);
        var result = { applied: true, reloadRequired: true };
        result[responseField] = value;
        return result;
      } catch (error) {
        return { applied: false, reason: String(error) };
      }
    }

    // --- execute-js : the universal escape hatch -----------------------------
    listen("execute-js", function (ev) {
      var p = ev && ev.payload;
      var cid = correlationId(p);
      var reply = function (result) {
        respond("execute-js-response", cid, {
          result: typeof result === "object" ? safeStringify(result) : String(result),
          type: typeof result,
        });
      };
      try {
        // emit_and_wait wraps a non-object payload (the code string) as _payload.
        var code = p && p._payload !== undefined ? p._payload : p;
        // CSP-safe, sanitized selector probe for Hide Names & Avatars work.
        if (code === "__carrier_mcp_privacy_probe__") {
          reply(privacyProbe());
          return;
        }
        // Sanitized network-traffic aggregates for telemetry-blocking work.
        if (code === "__carrier_mcp_network_probe__") {
          reply(networkProbe());
          return;
        }
        // Content-blind runtime profiling for resource-usage investigations.
        if (code === "__carrier_mcp_performance_probe__") {
          reply(performanceProbe());
          return;
        }
        if (code === "__carrier_mcp_activity_probe__") {
          activityProbe().then(reply, function (e) {
            respond("execute-js-response", cid, {
              result: null,
              type: "error",
              error: String((e && e.stack) || e),
            });
          });
          return;
        }
        if (code === "__carrier_mcp_source_probe__") {
          sourceProbe().then(reply, function (e) {
            respond("execute-js-response", cid, {
              result: null,
              type: "error",
              error: String((e && e.stack) || e),
            });
          });
          return;
        }
        if (code === "__carrier_mcp_timer_sources_probe__") {
          timerSourcesProbe().then(reply, function (e) {
            respond("execute-js-response", cid, {
              result: null,
              type: "error",
              error: String((e && e.stack) || e),
            });
          });
          return;
        }
        if (code === "__carrier_mcp_modules_probe__") {
          reply(moduleProbe());
          return;
        }
        if (code === "__carrier_mcp_hidden_probe__") {
          reply(hiddenProbe());
          return;
        }
        if (code === "__carrier_mcp_module_runtime_probe__") {
          reply(moduleRuntimeProbe());
          return;
        }
        if (code === "__carrier_mcp_component_experiment_probe__") {
          reply(componentExperimentProbe());
          return;
        }
        if (code === "__carrier_mcp_static_bundle_test_probe__") {
          var perfState = window.__CARRIER_MCP_PERF__ || {};
          reply(
            typeof perfState.staticBundleProbe === "function"
              ? perfState.staticBundleProbe([
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle.js",
                  "http://static.xx.fbcdn.net/rsrc.php/v4/insecure.js",
                  "https://static.xx.fbcdn.net:8443/rsrc.php/v4/port.js",
                  "https://user:password@static.xx.fbcdn.net/rsrc.php/v4/credentials.js",
                  "https://example.com/rsrc.php/v4/wrong-host.js",
                  "https://static.xx.fbcdn.net/images/media.jpg",
                  "",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-02.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-03.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-04.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-05.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-06.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-07.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-08.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-09.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-10.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-11.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-12.js",
                  "https://static.xx.fbcdn.net/rsrc.php/v4/bundle-13.js",
                ])
              : [],
          );
          return;
        }
        var reactProfile = /^__carrier_mcp_react_profile__:(on|clear)$/.exec(code);
        if (reactProfile) {
          reply(setSessionExperiment(reactProfile[1], REACT_PROFILE_KEY, "reactProfile"));
          return;
        }
        var componentNull =
          /^__carrier_mcp_component_null__:([A-Za-z0-9_$.:/-]{1,160}|clear)$/.exec(code);
        if (componentNull) {
          reply(setSessionExperiment(componentNull[1], COMPONENT_NULL_KEY, "component"));
          return;
        }
        var componentPassthrough =
          /^__carrier_mcp_component_passthrough__:([A-Za-z0-9_$.:/-]{1,160}|clear)$/.exec(
            code,
          );
        if (componentPassthrough) {
          reply(
            setSessionExperiment(
              componentPassthrough[1],
              COMPONENT_PASSTHROUGH_KEY,
              "component",
            ),
          );
          return;
        }
        var debugProfile = /^__carrier_mcp_profile__:(block-route-definitions|stub-top-nav|replace-top-nav|replace-global-nav|replace-global-nav-stop-fts|disable-hyperion|replace-global-nav-disable-hyperion|replace-notification-badge|replace-global-nav-notifications|replace-global-nav-badge|replace-global-chrome|clear)$/.exec(code);
        if (debugProfile) {
          try {
            if (debugProfile[1] === "clear") sessionStorage.removeItem(DEBUG_PROFILE_KEY);
            else sessionStorage.setItem(DEBUG_PROFILE_KEY, debugProfile[1]);
            reply({ applied: true, profile: debugProfile[1], reloadRequired: true });
          } catch (error) {
            reply({ applied: false, reason: String(error) });
          }
          return;
        }
        var performanceExperiment =
          /^__carrier_mcp_performance_experiment__:(trace-scheduler|stop-fts-search-restore|stop-fts-media-restore|resume-fts-search-restore|mute-telemetry|mute-banzai|mute-ods|terminate-media-worker|terminate-responsiveness-worker|close-rpsignaling-socket|close-streamcontroller-socket|remove-maw-proxy-frame|remove-hidden-banner)$/.exec(
            code,
          );
        if (performanceExperiment) {
          reply(runPerformanceExperiment(performanceExperiment[1]));
          return;
        }
        // CSP-safe control probe for keyboard-shortcut selector work (#18/#30).
        if (code === "__carrier_mcp_shortcut_probe__") {
          reply(shortcutProbe());
          return;
        }
        var shortcutAction =
          /^__carrier_mcp_shortcut_action__:(next|previous|focus-composer|focus-search|conversation-search)$/.exec(
            code,
          );
        if (shortcutAction) {
          var shortcutRegistry = window.__carrierShortcuts || {};
          var shortcutMethods = {
            next: "nextConversation",
            previous: "prevConversation",
            "focus-composer": "focusComposer",
            "focus-search": "focusChatSearch",
            "conversation-search": "searchInConversation",
          };
          var shortcutMethod = shortcutMethods[shortcutAction[1]];
          if (typeof shortcutRegistry[shortcutMethod] === "function") {
            shortcutRegistry[shortcutMethod]();
            reply({ applied: true, action: shortcutAction[1] });
          } else {
            reply({ applied: false, reason: "shortcut unavailable" });
          }
          return;
        }
        if (code === "__carrier_mcp_media_probe__") {
          reply(mediaProbe());
          return;
        }
        var mediaAction = /^__carrier_mcp_media_action__:(scroll-first|click-first|close)$/.exec(code);
        if (mediaAction) {
          if (mediaAction[1] === "close") {
            document.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
            );
            reply({ applied: true, action: "close" });
          } else {
            var mediaTarget = firstLargeMediaTarget();
            if (!mediaTarget) {
              reply({ applied: false, reason: "no large message media" });
            } else {
              try {
                if (mediaAction[1] === "scroll-first") {
                  mediaTarget.scrollIntoView({ block: "center", inline: "nearest" });
                } else {
                  mediaTarget.click();
                }
                reply({ applied: true, action: mediaAction[1] });
              } catch (error) {
                reply({ applied: false, action: mediaAction[1], reason: String(error) });
              }
            }
          }
          return;
        }
        if (code === "__carrier_mcp_search_test__") {
          var searchInputs = document.querySelectorAll('input[aria-label], input[type="search"]');
          var searchInput = null;
          for (var searchIndex = 0; searchIndex < searchInputs.length; searchIndex++) {
            var candidateInput = searchInputs[searchIndex];
            var candidateLabel = (candidateInput.getAttribute("aria-label") || "").toLowerCase();
            if (candidateInput.closest('[role="main"]') && candidateLabel.indexOf("search") !== -1) {
              searchInput = candidateInput;
              break;
            }
          }
          if (!searchInput) {
            reply({ applied: false, reason: "conversation search input unavailable" });
            return;
          }
          try {
            var inputValue = "carrier-probe-no-match";
            var valueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              "value",
            ).set;
            valueSetter.call(searchInput, inputValue);
            searchInput.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                cancelable: false,
                data: inputValue,
                inputType: "insertText",
              }),
            );
            reply({ applied: true, valueLength: inputValue.length, focused: document.activeElement === searchInput });
          } catch (error) {
            reply({ applied: false, reason: String(error) });
          }
          return;
        }
        // Sanitized layout/palette probe for design-replica work (landing
        // page): geometry plus computed styles sampled under both themes.
        if (code === "__carrier_mcp_design_probe__") {
          reply(designProbe());
          return;
        }
        // UI icon glyphs for design-replica work: serialized <svg> markup
        // from the nav/main chrome, with identity-bearing svgs skipped.
        if (code === "__carrier_mcp_icon_probe__") {
          reply(iconProbe());
          return;
        }
        // How the composer's like/send control is rendered (inline svg vs
        // sprite/mask). Raster sources are reported as "[image]" only.
        if (code === "__carrier_mcp_like_probe__") {
          reply(likeProbe());
          return;
        }
        // Force a page theme through Carrier's own force-theme machinery so
        // screenshots can be taken in either mode; ":system" restores.
        var themeSet = /^__carrier_mcp_theme_set__:(dark|light|system)$/.exec(code);
        if (themeSet) {
          reply(setThemeForScreenshot(themeSet[1]));
          return;
        }
        // Persist a theme into the localStorage settings cache and reload, so
        // Facebook re-renders with it from document-start (a live class flip
        // does not restyle already-rendered components). ":restore" puts the
        // stashed original back. Page-local only; Rust settings are untouched.
        var themePersist = /^__carrier_mcp_theme_persist__:(dark|light|restore)$/.exec(code);
        if (themePersist) {
          reply(persistThemeAndReload(themePersist[1]));
          return;
        }
        // CSP-safe end-to-end notification test: constructs a Notification
        // through the (shimmed) constructor so the full page → Rust →
        // Notification Center pipeline runs without waiting for a real
        // message. Reports the shim/permission state alongside.
        if (code === "__carrier_mcp_notify_test__") {
          var N = window.Notification;
          if (typeof N !== "function") {
            reply({ error: "window.Notification is not a function: " + typeof N });
            return;
          }
          var settings = window.__CARRIER_SETTINGS__ || {};
          new N("Carrier test", { body: "tauri-mcp pipeline test" });
          reply({
            constructed: true,
            // The shim is plain JS; the native constructor stringifies with
            // "[native code]".
            shimmed: String(N).indexOf("[native code]") === -1,
            permission: N.permission,
            mute_notifications: !!settings.mute_notifications,
            hide_notification_preview: !!settings.hide_notification_preview,
            visibility: document.visibilityState,
          });
          return;
        }
        // CSP-safe invoker for the page's own shortcut helpers (Facebook's CSP
        // blocks new Function, so `execute_js` can't reach them otherwise).
        // Restricted to the __carrierShortcuts registry — no arbitrary globals.
        var call = /^__carrier_mcp_call__:([\w$]+)$/.exec(code);
        if (call) {
          var registry = window.__carrierShortcuts || {};
          var helper = registry[call[1]];
          reply(
            typeof helper === "function"
              ? { called: call[1], returned: helper() }
              : { error: "no such shortcut helper: " + call[1] },
          );
          return;
        }
        var result;
        try {
          // Expression form first (so the last value is returned)…
          result = new Function("return (" + code + ")")();
        } catch (_) {
          // …falling back to statement form.
          result = new Function(code)();
        }
        // Resolve thenables so `await fetch(...)`-style snippets return real data.
        if (result && typeof result.then === "function") {
          result.then(reply, function (e) {
            respond("execute-js-response", cid, {
              result: null,
              type: "error",
              error: String((e && e.stack) || e),
            });
          });
        } else {
          reply(result);
        }
      } catch (e) {
        respond("execute-js-response", cid, {
          result: null,
          type: "error",
          error: String((e && e.stack) || e),
        });
      }
    });

    // Aggregated resource-timing counts for verifying telemetry blocking.
    // Sanitized like privacyProbe: hosts plus digit-masked path prefixes and
    // counts/bytes only — no query strings, no full URLs. Note blocked-by-us
    // requests never start, so they simply don't appear; verify by comparing
    // counts with the setting on vs off.
    function networkProbe() {
      var buckets = {};
      var entries = performance.getEntriesByType("resource");
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var key;
        try {
          var u = new URL(e.name);
          // First two path segments, digits masked, query dropped.
          var path = u.pathname.split("/").slice(0, 3).join("/").replace(/\d{3,}/g, "{id}");
          key = u.hostname + path + " [" + (e.initiatorType || "?") + "]";
        } catch (_) {
          key = "(unparsable) [" + (e.initiatorType || "?") + "]";
        }
        var b = buckets[key] || (buckets[key] = { count: 0, bytes: 0 });
        b.count++;
        b.bytes += e.transferSize || 0;
      }
      var rows = Object.keys(buckets)
        .map(function (k) {
          return { key: k, count: buckets[k].count, bytes: buckets[k].bytes };
        })
        .sort(function (a, b) {
          return b.count - a.count;
        });
      return {
        blockTelemetry: !!(window.__CARRIER_SETTINGS__ && window.__CARRIER_SETTINGS__.block_telemetry),
        totalEntries: entries.length,
        buckets: rows.slice(0, 80),
      };
    }

    // Dev-only instrumentation. It is installed before Facebook's parsed
    // scripts run and records aggregate scheduling/churn, never callback args,
    // DOM content, request URLs, or socket payloads.
    function installPerformanceInstrumentation() {
      if (window.__CARRIER_MCP_PERF__) return window.__CARRIER_MCP_PERF__;
      var state = {
        installedAt: performance.now(),
        mutation: {
          observers: 0,
          callbacks: 0,
          records: 0,
          addedNodes: 0,
          removedNodes: 0,
          attributes: 0,
          characterData: 0,
        },
        timers: {
          timeoutsScheduled: 0,
          timeoutsFired: 0,
          intervalsScheduled: 0,
          intervalFires: 0,
          activeTimeouts: 0,
          activeIntervals: 0,
          byDelay: { immediate: 0, short: 0, medium: 0, long: 0 },
          byDelayMs: {},
          sources: {},
          locations: {},
        },
        animationFrames: { scheduled: 0, fired: 0, active: 0 },
        workers: { worker: 0, sharedWorker: 0, details: [] },
        sockets: {
          created: 0,
          opened: 0,
          closed: 0,
          messages: 0,
          bytes: 0,
          endpoints: {},
        },
        scheduler: { calls: {}, sources: {}, locations: {}, patched: [] },
      };
      window.__CARRIER_MCP_PERF__ = state;
      state.workerRefs = [];
      state.socketRefs = [];

      function delayBucket(delay) {
        var value = Number(delay) || 0;
        if (value <= 16) return "immediate";
        if (value <= 1000) return "short";
        if (value <= 10000) return "medium";
        return "long";
      }

      function sanitizedEndpoint(raw) {
        try {
          var url = new URL(String(raw), location.href);
          var name = url.pathname.split("/").filter(Boolean).pop() || "/";
          return (url.hostname + "/" + name).replace(/\d{3,}/g, "{id}").slice(0, 160);
        } catch (_) {
          return "unparsable";
        }
      }

      function sanitizedStaticBundle(raw) {
        try {
          var url = new URL(String(raw), location.href);
          if (
            url.protocol !== "https:" ||
            url.hostname !== "static.xx.fbcdn.net" ||
            url.port ||
            url.username ||
            url.password ||
            !/\.js$/i.test(url.pathname)
          ) {
            return "";
          }
          return sanitizedEndpoint(url.href);
        } catch (_) {
          return "";
        }
      }

      function recordStaticBundle(detail, raw) {
        var bundle = sanitizedStaticBundle(raw);
        if (!bundle || detail.bundles.indexOf(bundle) !== -1 || detail.bundles.length >= 12) {
          return;
        }
        detail.bundles.push(bundle);
      }
      state.staticBundleProbe = function (candidates) {
        var detail = { bundles: [] };
        for (var i = 0; i < candidates.length; i++) recordStaticBundle(detail, candidates[i]);
        return detail.bundles;
      };

      function schedulingSource() {
        try {
          var stack = String(new Error().stack || "");
          var lines = stack.split("\n");
          var sources = [];
          var locations = [];
          for (var i = 0; i < lines.length; i++) {
            var match = /(https?:\/\/[^\s)]+?):(\d+):(\d+)(?:\)?$|\s)/.exec(lines[i]);
            if (!match) continue;
            var source = sanitizedEndpoint(match[1]);
            if (sources.indexOf(source) === -1) sources.push(source);
            try {
              var stackUrl = new URL(match[1]);
              if (stackUrl.hostname === "static.xx.fbcdn.net") {
                var location = source + "@" + match[2] + ":" + match[3];
                if (locations.indexOf(location) === -1) locations.push(location);
              }
            } catch (_) {}
          }
          if (sources.length) {
            return { source: sources.slice(0, 4).join(" > "), locations: locations.slice(0, 6) };
          }
          if (stack.indexOf("user-script") !== -1) {
            return { source: "carrier-user-script", locations: [] };
          }
        } catch (_) {}
        return { source: "unknown", locations: [] };
      }
      state.captureSchedulingSource = schedulingSource;

      function noteTimer(delay) {
        state.timers.byDelay[delayBucket(delay)]++;
        var exact = String(Math.max(0, Math.round(Number(delay) || 0)));
        state.timers.byDelayMs[exact] = (state.timers.byDelayMs[exact] || 0) + 1;
        var origin = state.activeTimerOrigin || schedulingSource();
        state.timers.sources[origin.source] = (state.timers.sources[origin.source] || 0) + 1;
        for (var i = 0; i < origin.locations.length; i++) {
          var location = origin.locations[i];
          state.timers.locations[location] = (state.timers.locations[location] || 0) + 1;
        }
        return origin;
      }

      try {
        var NativeMutationObserver = window.MutationObserver;
        if (typeof NativeMutationObserver === "function") {
          function InstrumentedMutationObserver(callback) {
            state.mutation.observers++;
            return new NativeMutationObserver(function (records, observer) {
              state.mutation.callbacks++;
              state.mutation.records += records.length;
              for (var i = 0; i < records.length; i++) {
                var record = records[i];
                if (record.type === "childList") {
                  state.mutation.addedNodes += record.addedNodes.length;
                  state.mutation.removedNodes += record.removedNodes.length;
                } else if (record.type === "attributes") {
                  state.mutation.attributes++;
                } else if (record.type === "characterData") {
                  state.mutation.characterData++;
                }
              }
              return callback.call(this, records, observer);
            });
          }
          InstrumentedMutationObserver.prototype = NativeMutationObserver.prototype;
          Object.setPrototypeOf(InstrumentedMutationObserver, NativeMutationObserver);
          window.MutationObserver = InstrumentedMutationObserver;
        }
      } catch (_) {}

      try {
        var nativeSetTimeout = window.setTimeout;
        var nativeClearTimeout = window.clearTimeout;
        var nativeSetInterval = window.setInterval;
        var nativeClearInterval = window.clearInterval;
        var activeTimeouts = new Set();
        var activeIntervals = new Set();
        state.nativeSetTimeout = nativeSetTimeout.bind(window);
        state.nativeClearTimeout = nativeClearTimeout.bind(window);
        state.nativeSetInterval = nativeSetInterval.bind(window);
        state.nativeClearInterval = nativeClearInterval.bind(window);

        window.setTimeout = function (callback, delay) {
          state.timers.timeoutsScheduled++;
          var origin = noteTimer(delay);
          var args = Array.prototype.slice.call(arguments, 2);
          var handle;
          var wrapped =
            typeof callback === "function"
              ? function () {
                  activeTimeouts.delete(handle);
                  state.timers.activeTimeouts = activeTimeouts.size;
                  state.timers.timeoutsFired++;
                  var previousOrigin = state.activeTimerOrigin;
                  state.activeTimerOrigin = origin;
                  try {
                    return callback.apply(this, arguments);
                  } finally {
                    state.activeTimerOrigin = previousOrigin;
                  }
                }
              : callback;
          handle = nativeSetTimeout.apply(window, [wrapped, delay].concat(args));
          activeTimeouts.add(handle);
          state.timers.activeTimeouts = activeTimeouts.size;
          return handle;
        };
        window.clearTimeout = function (handle) {
          activeTimeouts.delete(handle);
          state.timers.activeTimeouts = activeTimeouts.size;
          return nativeClearTimeout.call(window, handle);
        };
        window.setInterval = function (callback, delay) {
          state.timers.intervalsScheduled++;
          var origin = noteTimer(delay);
          var args = Array.prototype.slice.call(arguments, 2);
          var wrapped =
            typeof callback === "function"
              ? function () {
                  state.timers.intervalFires++;
                  var previousOrigin = state.activeTimerOrigin;
                  state.activeTimerOrigin = origin;
                  try {
                    return callback.apply(this, arguments);
                  } finally {
                    state.activeTimerOrigin = previousOrigin;
                  }
                }
              : callback;
          var handle = nativeSetInterval.apply(window, [wrapped, delay].concat(args));
          activeIntervals.add(handle);
          state.timers.activeIntervals = activeIntervals.size;
          return handle;
        };
        window.clearInterval = function (handle) {
          activeIntervals.delete(handle);
          state.timers.activeIntervals = activeIntervals.size;
          return nativeClearInterval.call(window, handle);
        };
      } catch (_) {}

      try {
        var nativeRequestAnimationFrame = window.requestAnimationFrame;
        var nativeCancelAnimationFrame = window.cancelAnimationFrame;
        var activeFrames = new Set();
        window.requestAnimationFrame = function (callback) {
          state.animationFrames.scheduled++;
          var handle = nativeRequestAnimationFrame.call(window, function (timestamp) {
            activeFrames.delete(handle);
            state.animationFrames.active = activeFrames.size;
            state.animationFrames.fired++;
            return callback(timestamp);
          });
          activeFrames.add(handle);
          state.animationFrames.active = activeFrames.size;
          return handle;
        };
        window.cancelAnimationFrame = function (handle) {
          activeFrames.delete(handle);
          state.animationFrames.active = activeFrames.size;
          return nativeCancelAnimationFrame.call(window, handle);
        };
      } catch (_) {}

      function instrumentConstructor(name, counter) {
        try {
          var Native = window[name];
          if (typeof Native !== "function" || typeof Proxy !== "function") return;
          window[name] = new Proxy(Native, {
            construct: function (Target, args, NewTarget) {
              state.workers[counter]++;
              var worker = Reflect.construct(Target, args, NewTarget);
              var detail = {
                kind: counter,
                entry: sanitizedEndpoint(args[0]),
                messageTypes: {},
                receivedMessageTypes: {},
                bundles: [],
                terminated: false,
              };
              state.workers.details.push(detail);

              function inspectMessage(message, messageTypes) {
                try {
                  if (!message || typeof message !== "object") return;
                  if (typeof message.type === "string") {
                    var type = message.type.replace(/[^\w:-]/g, "").slice(0, 80) || "other";
                    messageTypes[type] = (messageTypes[type] || 0) + 1;
                  }
                  var candidates = [
                    message.bundleUrl,
                    message.url,
                    message.args && message.args[0] && message.args[0].url,
                  ];
                  for (var i = 0; i < candidates.length; i++) {
                    recordStaticBundle(detail, candidates[i]);
                  }
                } catch (_) {}
              }

              function wrapPostMessage(target) {
                if (!target || typeof target.postMessage !== "function") return;
                var nativePostMessage = target.postMessage;
                target.postMessage = function (message) {
                  inspectMessage(message, detail.messageTypes);
                  return nativePostMessage.apply(this, arguments);
                };
              }
              wrapPostMessage(worker);
              wrapPostMessage(worker.port);
              function inspectReceivedMessage(event) {
                inspectMessage(event && event.data, detail.receivedMessageTypes);
              }
              if (worker && typeof worker.addEventListener === "function") {
                worker.addEventListener("message", inspectReceivedMessage);
              }
              if (worker.port && typeof worker.port.addEventListener === "function") {
                worker.port.addEventListener("message", inspectReceivedMessage);
              }
              state.workerRefs.push({ worker: worker, detail: detail });
              return worker;
            },
          });
        } catch (_) {}
      }
      instrumentConstructor("Worker", "worker");
      instrumentConstructor("SharedWorker", "sharedWorker");

      try {
        var NativeWebSocket = window.WebSocket;
        if (typeof NativeWebSocket === "function" && typeof Proxy === "function") {
          window.WebSocket = new Proxy(NativeWebSocket, {
            construct: function (Target, args, NewTarget) {
              var socket = Reflect.construct(Target, args, NewTarget);
              state.sockets.created++;
              var endpoint = sanitizedEndpoint(args[0]);
              state.sockets.endpoints[endpoint] = (state.sockets.endpoints[endpoint] || 0) + 1;
              state.socketRefs.push({ socket: socket, endpoint: endpoint });
              socket.addEventListener("open", function () {
                state.sockets.opened++;
              });
              socket.addEventListener("close", function () {
                state.sockets.closed++;
              });
              socket.addEventListener("message", function (event) {
                state.sockets.messages++;
                var data = event.data;
                state.sockets.bytes +=
                  typeof data === "string"
                    ? data.length
                    : data && typeof data.byteLength === "number"
                      ? data.byteLength
                      : 0;
              });
              return socket;
            },
          });
        }
      } catch (_) {}

      return state;
    }

    function copyCounters() {
      var state = window.__CARRIER_MCP_PERF__ || {};
      return JSON.parse(
        safeStringify({
          mutation: state.mutation || {},
          timers: state.timers || {},
          animationFrames: state.animationFrames || {},
          workers: state.workers || {},
          sockets: state.sockets || {},
          scheduler: state.scheduler || {},
        }),
      );
    }

    function counterDelta(after, before) {
      var result = {};
      Object.keys(after || {}).forEach(function (key) {
        if (typeof after[key] === "number") {
          result[key] = after[key] - (Number(before && before[key]) || 0);
        } else if (after[key] && typeof after[key] === "object") {
          result[key] = counterDelta(after[key], (before && before[key]) || {});
        }
      });
      return result;
    }

    function resourceTotals() {
      var entries = performance.getEntriesByType("resource");
      var totals = { count: entries.length, transfer: 0, decoded: 0 };
      for (var i = 0; i < entries.length; i++) {
        totals.transfer += entries[i].transferSize || 0;
        totals.decoded += entries[i].decodedBodySize || 0;
      }
      return totals;
    }

    function elementState(el) {
      var style = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      if (style.display === "none") return "displayNone";
      if (style.visibility === "hidden") return "visibilityHidden";
      if (Number(style.opacity) === 0) return "transparent";
      if (r.width <= 0 || r.height <= 0) return "zeroArea";
      if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) {
        return "offscreen";
      }
      return "onscreen";
    }

    function performanceProbe() {
      var all = document.querySelectorAll("*");
      var tags = {};
      var roles = {};
      var states = {
        onscreen: 0,
        offscreen: 0,
        displayNone: 0,
        visibilityHidden: 0,
        transparent: 0,
        zeroArea: 0,
      };
      var hiddenRoots = [];
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var tag = el.tagName.toLowerCase();
        tags[tag] = (tags[tag] || 0) + 1;
        var role = el.getAttribute("role");
        if (role) roles[role] = (roles[role] || 0) + 1;
        var state = elementState(el);
        states[state]++;
        if (
          (state === "displayNone" || state === "visibilityHidden") &&
          el.parentElement &&
          elementState(el.parentElement) !== state
        ) {
          hiddenRoots.push({
            tag: tag,
            role: role || "",
            descendants: el.querySelectorAll("*").length,
          });
        }
      }
      function topEntries(source, limit) {
        return Object.keys(source)
          .map(function (key) {
            return [key, source[key]];
          })
          .sort(function (a, b) {
            return b[1] - a[1];
          })
          .slice(0, limit);
      }
      hiddenRoots.sort(function (a, b) {
        return b.descendants - a.descendants;
      });

      var animations = typeof document.getAnimations === "function" ? document.getAnimations() : [];
      var animationStates = {};
      for (var a = 0; a < animations.length; a++) {
        var playState = animations[a].playState || "unknown";
        animationStates[playState] = (animationStates[playState] || 0) + 1;
      }
      var media = document.querySelectorAll("video, audio");
      var mediaSummary = { total: media.length, playing: 0, autoplay: 0, offscreen: 0 };
      for (var m = 0; m < media.length; m++) {
        if (!media[m].paused) mediaSummary.playing++;
        if (media[m].autoplay) mediaSummary.autoplay++;
        if (elementState(media[m]) === "offscreen") mediaSummary.offscreen++;
      }
      var images = document.images;
      var imageSummary = {
        total: images.length,
        loaded: 0,
        lazy: 0,
        offscreen: 0,
        decodedMegapixels: 0,
        offscreenMegapixels: 0,
      };
      for (var im = 0; im < images.length; im++) {
        if (images[im].complete && images[im].naturalWidth > 0) imageSummary.loaded++;
        if (images[im].loading === "lazy") imageSummary.lazy++;
        var megapixels = (images[im].naturalWidth * images[im].naturalHeight) / 1000000;
        imageSummary.decodedMegapixels += megapixels;
        if (elementState(images[im]) === "offscreen") {
          imageSummary.offscreen++;
          imageSummary.offscreenMegapixels += megapixels;
        }
      }
      imageSummary.decodedMegapixels = Math.round(imageSummary.decodedMegapixels * 10) / 10;
      imageSummary.offscreenMegapixels = Math.round(imageSummary.offscreenMegapixels * 10) / 10;
      var reactFiberHosts = 0;
      for (var rf = 0; rf < all.length; rf++) {
        try {
          if (
            Object.keys(all[rf]).some(function (key) {
              return key.indexOf("__reactFiber$") === 0;
            })
          ) {
            reactFiberHosts++;
          }
        } catch (_) {}
      }
      var frameHosts = {};
      var frames = document.querySelectorAll("iframe");
      for (var f = 0; f < frames.length; f++) {
        var host = "opaque";
        try {
          host = new URL(frames[f].src, location.href).hostname || "same-document";
        } catch (_) {}
        frameHosts[host] = (frameHosts[host] || 0) + 1;
      }
      return {
        uptimeMs: Math.round(performance.now()),
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        dom: {
          nodes: all.length,
          states: states,
          tags: topEntries(tags, 20),
          roles: topEntries(roles, 30),
          hiddenRoots: hiddenRoots.slice(0, 20),
          reactFiberHosts: reactFiberHosts,
        },
        media: mediaSummary,
        images: imageSummary,
        graphics: {
          svg: document.querySelectorAll("svg").length,
          canvas: document.querySelectorAll("canvas").length,
        },
        frames: { total: frames.length, hosts: frameHosts },
        animations: { total: animations.length, states: animationStates },
        resources: resourceTotals(),
        debugProfile: window.__CARRIER_MCP_NETWORK_PROFILE__ || { name: "none", blocked: 0 },
        instrumentation: copyCounters(),
      };
    }

    function activityProbe() {
      var duration = 15000;
      var state = window.__CARRIER_MCP_PERF__ || {};
      var beforeCounters = copyCounters();
      var beforeResources = resourceTotals();
      var beforeNodes = document.querySelectorAll("*").length;
      var nativeSetTimeout = state.nativeSetTimeout || window.setTimeout.bind(window);
      var nativeSetInterval = state.nativeSetInterval || window.setInterval.bind(window);
      var nativeClearInterval = state.nativeClearInterval || window.clearInterval.bind(window);
      return new Promise(function (resolve) {
        var expected = performance.now() + 250;
        var lagTotal = 0;
        var lagMax = 0;
        var lagSamples = 0;
        var sampler = nativeSetInterval(function () {
          var now = performance.now();
          var lag = Math.max(0, now - expected);
          lagTotal += lag;
          lagMax = Math.max(lagMax, lag);
          lagSamples++;
          expected = now + 250;
        }, 250);
        nativeSetTimeout(function () {
          nativeClearInterval(sampler);
          var afterResources = resourceTotals();
          resolve({
            durationMs: duration,
            visibility: document.visibilityState,
            focused: document.hasFocus(),
            activity: counterDelta(copyCounters(), beforeCounters),
            eventLoop: {
              samples: lagSamples,
              averageLagMs: lagSamples ? Math.round((lagTotal / lagSamples) * 10) / 10 : 0,
              maxLagMs: Math.round(lagMax * 10) / 10,
            },
            resources: counterDelta(afterResources, beforeResources),
            domNodes: {
              before: beforeNodes,
              after: document.querySelectorAll("*").length,
            },
          });
        }, duration);
      });
    }

    // Fetch already-loaded static bundles (normally served from WebKit's
    // cache), extract only module names, then group them by expensive or
    // removable feature families. No source text or URLs leave the page.
    function sourceProbe() {
      var urls = [];
      var seen = {};
      var entries = performance.getEntriesByType("resource");
      for (var i = 0; i < entries.length && urls.length < 80; i++) {
        try {
          var url = new URL(entries[i].name);
          var relevantHost =
            url.hostname === "static.xx.fbcdn.net" || url.hostname === "www.facebook.com";
          var relevantPath =
            url.pathname.indexOf("/rsrc.php/") === 0 ||
            url.pathname.indexOf("/static_resources/webworker") === 0;
          if (relevantHost && relevantPath && !seen[url.href]) {
            seen[url.href] = true;
            urls.push(url.href);
          }
        } catch (_) {}
      }
      var families = [
        ["telemetry", /(?:Falco|Banzai|QuickLog|QPL|ODS|Scuba|Telemetry|Analytics|Logger|Logging)/i],
        ["calling", /(?:VideoChat|WebRTC|RTC|Calling|CallInvite|CallControls|Rooms)/i],
        ["stories_reels", /(?:Stories|Story|Reels|Reel)/i],
        ["stickers_gifs", /(?:Sticker|Stickers|GIF|Giphy|Tenor|AnimatedImage)/i],
        ["commerce_payments", /(?:Commerce|Payment|Payments|Marketplace|Shops)/i],
        ["games", /(?:InstantGames|Gaming|GameInvite|Playable)/i],
        ["contacts_presence", /(?:Contact|Contacts|Presence|ActiveStatus)/i],
        ["search", /(?:Search|Typeahead)/i],
        ["media", /(?:Video|Audio|Media|ImageViewer|PhotoViewer)/i],
        ["notifications", /(?:Notification|PushRegistration|DesktopNotif)/i],
      ];
      var familyResults = {};
      for (var f = 0; f < families.length; f++) {
        familyResults[families[f][0]] = { modules: 0, samples: [] };
      }
      var modulesSeen = {};
      var scanned = 0;
      var sourceBytes = 0;
      var failures = 0;
      return Promise.all(
        urls.map(function (url) {
          return fetch(url, { credentials: "include" })
            .then(function (response) {
              return response.text();
            })
            .then(function (source) {
              scanned++;
              sourceBytes += source.length;
              var match;
              var modulePattern = /__d\(["']([^"']{1,160})["']/g;
              while ((match = modulePattern.exec(source))) {
                var name = match[1];
                if (modulesSeen[name]) continue;
                modulesSeen[name] = true;
                for (var j = 0; j < families.length; j++) {
                  if (families[j][1].test(name)) {
                    var result = familyResults[families[j][0]];
                    result.modules++;
                    if (result.samples.length < 24) result.samples.push(name);
                  }
                }
              }
            })
            .catch(function () {
              failures++;
            });
        }),
      ).then(function () {
        return {
          candidates: urls.length,
          scanned: scanned,
          failures: failures,
          sourceBytes: sourceBytes,
          uniqueModules: Object.keys(modulesSeen).length,
          families: familyResults,
        };
      });
    }

    // Resolve the highest-volume timer stack bundle names back to Haste module
    // names. The response contains no source text, request URLs, or page data.
    function timerSourcesProbe() {
      var state = window.__CARRIER_MCP_PERF__ || {};
      var timerSourceCounts = (state.timers && state.timers.sources) || {};
      var schedulerSourceCounts = (state.scheduler && state.scheduler.sources) || {};
      var sourceCounts = {};
      [timerSourceCounts, schedulerSourceCounts].forEach(function (counts) {
        Object.keys(counts).forEach(function (chain) {
          chain.split(" > ").forEach(function (source) {
            sourceCounts[source] = (sourceCounts[source] || 0) + (counts[chain] || 0);
          });
        });
      });
      function resourceLeaf(raw) {
        try {
          var url = new URL(String(raw), location.href);
          var name = url.pathname.split("/").filter(Boolean).pop() || "/";
          return (url.hostname + "/" + name).replace(/\d{3,}/g, "{id}").slice(0, 160);
        } catch (_) {
          return "unparsable";
        }
      }
      var ranked = Object.keys(sourceCounts)
        .map(function (source) {
          return { source: source, schedules: sourceCounts[source] || 0 };
        })
        .filter(function (entry) {
          return entry.schedules > 0 && entry.source !== "unknown";
        })
        .sort(function (a, b) {
          return b.schedules - a.schedules;
        })
        .slice(0, 12);
      var resources = performance.getEntriesByType("resource");
      return Promise.all(
        ranked.map(function (entry) {
          var leaf = entry.source.split(" > ")[0];
          var resourceUrl = "";
          for (var i = 0; i < resources.length; i++) {
            if (resourceLeaf(resources[i].name) === leaf) {
              resourceUrl = resources[i].name;
              break;
            }
          }
          var safeLeaf = leaf.replace(/[^A-Za-z0-9_.{}-]/g, "").slice(0, 160) || "unknown";
          if (!resourceUrl) {
            return { source: safeLeaf, schedules: entry.schedules, found: false };
          }
          var publicUrl = "";
          try {
            var parsedResourceUrl = new URL(resourceUrl);
            if (parsedResourceUrl.hostname === "static.xx.fbcdn.net") {
              publicUrl = parsedResourceUrl.origin + parsedResourceUrl.pathname;
            }
          } catch (_) {}
          return fetch(resourceUrl, { credentials: "include" })
            .then(function (response) {
              return response.text();
            })
            .then(function (source) {
              var modules = [];
              var seen = {};
              var match;
              var modulePattern = /__d\(["']([^"']{1,160})["']/g;
              while ((match = modulePattern.exec(source))) {
                var name = match[1];
                if (!seen[name] && /^[A-Za-z0-9_$.:/-]{1,160}$/.test(name)) {
                  seen[name] = true;
                  modules.push(name);
                }
              }
              return {
                source: safeLeaf,
                schedules: entry.schedules,
                found: true,
                publicUrl: publicUrl,
                bytes: source.length,
                moduleCount: modules.length,
                modules: modules.slice(0, 240),
              };
            })
            .catch(function () {
              return {
                source: safeLeaf,
                schedules: entry.schedules,
                found: true,
                publicUrl: publicUrl,
                failed: true,
              };
            });
        }),
      );
    }

    // Describe large CSS-hidden subtrees without returning classes, IDs,
    // labels, text, URLs, or attribute values. This is enough to distinguish
    // dormant chrome from dialogs and Messenger's encrypted transport frame.
    function hiddenProbe() {
      var all = document.querySelectorAll("*");
      var roots = [];
      function rankedEntries(source, limit) {
        return Object.keys(source)
          .map(function (key) {
            return [key, source[key]];
          })
          .sort(function (a, b) {
            return b[1] - a[1];
          })
          .slice(0, limit);
      }
      for (var i = 0; i < all.length; i++) {
        var node = all[i];
        var state = elementState(node);
        if (state !== "displayNone" && state !== "visibilityHidden") continue;
        if (!node.parentElement || elementState(node.parentElement) === state) continue;
        var descendants = node.querySelectorAll("*");
        var tags = {};
        var roles = {};
        for (var j = 0; j < descendants.length; j++) {
          var descendantTag = descendants[j].tagName.toLowerCase();
          var descendantRole = descendants[j].getAttribute("role");
          tags[descendantTag] = (tags[descendantTag] || 0) + 1;
          if (descendantRole) roles[descendantRole] = (roles[descendantRole] || 0) + 1;
        }
        var ancestor = node.parentElement;
        var ancestors = [];
        while (ancestor && ancestors.length < 4) {
          ancestors.push({
            tag: ancestor.tagName.toLowerCase(),
            role: ancestor.getAttribute("role") || "",
            state: elementState(ancestor),
          });
          ancestor = ancestor.parentElement;
        }
        roots.push({
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute("role") || "",
          state: state,
          descendants: descendants.length,
          attributeNames: Array.prototype.map.call(node.attributes || [], function (attribute) {
            return attribute.name.replace(/^data-.+$/, "data-*");
          }).filter(function (name, index, names) {
            return names.indexOf(name) === index;
          }).sort(),
          tags: rankedEntries(tags, 12),
          roles: rankedEntries(roles, 12),
          hasMedia: !!node.querySelector("video, audio"),
          hasFrame: !!node.querySelector("iframe"),
          hasFormControl: !!node.querySelector("input, textarea, select, button, [contenteditable]"),
          ancestors: ancestors,
        });
      }
      roots.sort(function (a, b) {
        return b.descendants - a.descendants;
      });
      return roots.slice(0, 20);
    }

    function moduleRuntimeProbe() {
      var state = window.__CARRIER_MCP_MODULE_RUNTIME__ || {};
      var modules = Object.keys(state.modules || {})
        .map(function (name) {
          var module = state.modules[name];
          return {
            name: name,
            executions: module.executions,
            durationMs: Math.round(module.durationMs * 100) / 100,
            families: module.families,
          };
        })
        .sort(function (a, b) {
          return b.durationMs - a.durationMs;
        });
      function rounded(source) {
        var result = {};
        Object.keys(source || {}).forEach(function (key) {
          result[key] = Math.round(source[key] * 100) / 100;
        });
        return result;
      }
      var samplesByFamily = {};
      modules.forEach(function (module) {
        (module.families || []).forEach(function (family) {
          var samples = samplesByFamily[family] || (samplesByFamily[family] = []);
          if (samples.length < 50) samples.push(module.name);
        });
      });
      var reactModules = Object.keys(state.reactModules || {})
        .map(function (name) {
          var module = state.reactModules[name];
          return {
            name: name,
            executions: module.executions,
            durationMs: Math.round(module.durationMs * 100) / 100,
          };
        })
        .sort(function (a, b) {
          return b.durationMs - a.durationMs || a.name.localeCompare(b.name);
        });
      return {
        profile: state.profile || "none",
        registered: state.registered || 0,
        candidateRegistered: state.candidateRegistered || 0,
        executed: state.executed || 0,
        familyRegistered: state.familyRegistered || {},
        familyExecuted: state.familyExecuted || {},
        familyDurationMs: rounded(state.familyDurationMs),
        targetDefinitions: state.targetDefinitions || {},
        stubbedExports: state.stubbedExports || 0,
        replacedDefinitions: state.replacedDefinitions || 0,
        reactRegistered: state.reactRegistered || 0,
        reactExecuted: state.reactExecuted || 0,
        reactProfile: !!state.reactProfile,
        componentNull: state.componentNull || "",
        componentPassthrough: state.componentPassthrough || "",
        reactModules: reactModules.slice(0, 2000),
        samplesByFamily: samplesByFamily,
        topModules: modules.slice(0, 80),
      };
    }

    function componentExperimentProbe() {
      var state = window.__CARRIER_MCP_MODULE_RUNTIME__ || {};
      var performanceSummary = performanceProbe();
      var counters = performanceSummary.instrumentation || {};
      return {
        uptimeMs: performanceSummary.uptimeMs,
        replacement: {
          null: state.componentNull || "",
          passthrough: state.componentPassthrough || "",
          definitions: state.replacedDefinitions || 0,
          dependencies: state.componentDependencies || {},
        },
        modules: {
          registered: state.registered || 0,
          executed: state.executed || 0,
          reactRegistered: state.reactRegistered || 0,
          reactExecuted: state.reactExecuted || 0,
        },
        dom: {
          nodes: performanceSummary.dom.nodes,
          images: performanceSummary.images.total,
          svg: performanceSummary.graphics.svg,
          frames: performanceSummary.frames.total,
        },
        resources: performanceSummary.resources,
        instrumentation: {
          observers: (counters.mutation && counters.mutation.observers) || 0,
          mutationCallbacks: (counters.mutation && counters.mutation.callbacks) || 0,
          timeoutsScheduled: (counters.timers && counters.timers.timeoutsScheduled) || 0,
          timeoutsFired: (counters.timers && counters.timers.timeoutsFired) || 0,
          animationFrames: (counters.animationFrames && counters.animationFrames.fired) || 0,
          workers:
            counters.workers && Array.isArray(counters.workers.details)
              ? counters.workers.details.length
              : 0,
          socketsCreated: (counters.sockets && counters.sockets.created) || 0,
          responsivenessWorkersStopped:
            (window.__CARRIER_WORKER_OPTIMIZATION__ &&
              window.__CARRIER_WORKER_OPTIMIZATION__.responsivenessWorkersStopped) ||
            0,
        },
      };
    }

    // Technical API shapes only. This shows which expensive subsystems are
    // actually require-able on the current route without returning module
    // values, logged data, or any page content.
    function moduleProbe() {
      var names = [
        "Banzai",
        "BanzaiLogger",
        "FalcoLoggerInternal",
        "ODS",
        "QPLH",
        "QuickPerformanceLogger",
        "JSErrorLogging",
        "CometTimeSpentNavigation",
        "CometTopNav.react",
        "CometAppLoggedInNavigation.react",
        "CometNotificationsThinClientConnectionHandler",
        "CometNotificationsBadgeCount.react",
        "CometNotificationsReceiveLiveQuery",
        "CometNotificationsStateChangeSubscription",
        "setupNotificationsLiveQuery",
        "MAWMainWebWorker",
        "MAWCommonMainWebWorker",
        "MAWFTSWorker",
      ];
      var loader = typeof window.require === "function" ? window.require : null;
      var results = {};
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        if (!loader) {
          results[name] = { available: false, reason: "no module loader" };
          continue;
        }
        try {
          var value = loader(name);
          results[name] = {
            available: true,
            type: typeof value,
            keys:
              value && (typeof value === "object" || typeof value === "function")
                ? Object.keys(value).sort().slice(0, 80)
                : [],
            functions:
              value && (typeof value === "object" || typeof value === "function")
                ? Object.keys(value)
                    .sort()
                    .slice(0, 80)
                    .filter(function (key) {
                      var descriptor = Object.getOwnPropertyDescriptor(value, key);
                      return !!descriptor && typeof descriptor.value === "function";
                    })
                    .map(function (key) {
                      var descriptor = Object.getOwnPropertyDescriptor(value, key);
                      return { key: key, arity: descriptor.value.length };
                    })
                : [],
          };
        } catch (_) {
          results[name] = { available: false };
        }
      }
      return results;
    }

    function runPerformanceExperiment(name) {
      var state = window.__CARRIER_MCP_PERF__ || {};
      if (name === "trace-scheduler") {
        var schedulerLoader = typeof window.require === "function" ? window.require : null;
        if (!schedulerLoader) return { applied: false, reason: "no module loader" };
        try {
          var scheduler = schedulerLoader("JSScheduler");
          var capture = state.captureSchedulingSource;
          var schedulerState = state.scheduler ||
            (state.scheduler = { calls: {}, sources: {}, locations: {}, patched: [] });
          var methods = [
            "scheduleDelayedCallback_DO_NOT_USE",
            "scheduleImmediatePriCallback",
            "scheduleLoggingPriCallback",
            "scheduleNormalPriCallback",
            "scheduleSpeculativeCallback",
            "scheduleUserBlockingPriCallback",
          ];
          methods.forEach(function (method) {
            var nativeMethod = scheduler && scheduler[method];
            if (typeof nativeMethod !== "function" || nativeMethod.__carrierTraced) return;
            var traced = function () {
              schedulerState.calls[method] = (schedulerState.calls[method] || 0) + 1;
              var origin = typeof capture === "function" ? capture() : { source: "unknown" };
              schedulerState.sources[origin.source] =
                (schedulerState.sources[origin.source] || 0) + 1;
              var locations = origin.locations || [];
              for (var locationIndex = 0; locationIndex < locations.length; locationIndex++) {
                var location = locations[locationIndex];
                schedulerState.locations[location] =
                  (schedulerState.locations[location] || 0) + 1;
              }
              return nativeMethod.apply(this, arguments);
            };
            traced.__carrierTraced = true;
            scheduler[method] = traced;
            schedulerState.patched.push(method);
          });
          return { applied: schedulerState.patched.length > 0, patched: schedulerState.patched };
        } catch (error) {
          return { applied: false, reason: String(error) };
        }
      }
      if (
        name === "stop-fts-search-restore" ||
        name === "stop-fts-media-restore" ||
        name === "resume-fts-search-restore"
      ) {
        var ftsLoader = typeof window.require === "function" ? window.require : null;
        if (!ftsLoader) return { applied: false, reason: "no module loader" };
        try {
          var restoreModule = ftsLoader("MAWFTSRestoreSync");
          var media = name === "stop-fts-media-restore";
          var restore = media
            ? restoreModule.getMediaRestoreSync()
            : restoreModule.getFTSRestoreSync();
          var resume = name === "resume-fts-search-restore";
          restore.setKeepWhileLoop_FOR_TESTING_ONLY(resume);
          if (resume) {
            restore.setIsStarted(false);
            Promise.resolve(restore.startSyncingLoop()).catch(function () {});
          }
          return {
            applied: true,
            target: media ? "media" : "search",
            running: resume,
          };
        } catch (error) {
          return { applied: false, reason: String(error) };
        }
      }
      if (name === "mute-telemetry" || name === "mute-banzai" || name === "mute-ods") {
        var loader = typeof window.require === "function" ? window.require : null;
        if (!loader) return { applied: false, reason: "no module loader" };
        try {
          var patched = [];
          if (name === "mute-telemetry" || name === "mute-banzai") {
            var banzai = loader("Banzai");
            if (banzai && typeof banzai.post === "function") {
              banzai.post = function () {};
              patched.push("Banzai.post");
            }
          }
          if (name === "mute-telemetry" || name === "mute-ods") {
            var ods = loader("ODS");
            if (ods) {
              ["bumpEntityKey", "bumpFraction", "flush", "setEntitySample"].forEach(
                function (method) {
                  if (typeof ods[method] === "function") ods[method] = function () {};
                },
              );
              patched.push("ODS");
            }
          }
          return { applied: patched.length > 0, patched: patched };
        } catch (error) {
          return { applied: false, reason: String(error) };
        }
      }
      if (name === "terminate-media-worker") {
        var terminated = 0;
        var refs = state.workerRefs || [];
        for (var i = 0; i < refs.length; i++) {
          var bundles = refs[i].detail && refs[i].detail.bundles;
          if (!bundles || !bundles.some(function (bundle) { return /Jzyaq68gi-U\.js$/.test(bundle); })) {
            continue;
          }
          try {
            refs[i].worker.terminate();
            refs[i].detail.terminated = true;
            terminated++;
          } catch (_) {}
        }
        return { applied: terminated > 0, terminated: terminated };
      }
      if (name === "terminate-responsiveness-worker") {
        var responsivenessTerminated = 0;
        var workerRefs = state.workerRefs || [];
        for (var workerIndex = 0; workerIndex < workerRefs.length; workerIndex++) {
          var messageTypes = workerRefs[workerIndex].detail && workerRefs[workerIndex].detail.messageTypes;
          if (!messageTypes || !messageTypes.responsiveness) continue;
          try {
            workerRefs[workerIndex].worker.terminate();
            workerRefs[workerIndex].detail.terminated = true;
            responsivenessTerminated++;
          } catch (_) {}
        }
        return {
          applied: responsivenessTerminated > 0,
          terminated: responsivenessTerminated,
        };
      }
      if (name === "close-rpsignaling-socket" || name === "close-streamcontroller-socket") {
        var endpointPattern =
          name === "close-rpsignaling-socket" ? /\/rpsignaling$/ : /\/streamcontroller$/;
        var closed = 0;
        var socketRefs = state.socketRefs || [];
        for (var socketIndex = 0; socketIndex < socketRefs.length; socketIndex++) {
          if (!endpointPattern.test(socketRefs[socketIndex].endpoint)) continue;
          try {
            socketRefs[socketIndex].socket.close(1000, "Carrier debug experiment");
            closed++;
          } catch (_) {}
        }
        return { applied: closed > 0, closed: closed };
      }
      if (name === "remove-maw-proxy-frame") {
        var removedFrames = 0;
        var frames = document.querySelectorAll("iframe");
        for (var frameIndex = 0; frameIndex < frames.length; frameIndex++) {
          try {
            var frameUrl = new URL(frames[frameIndex].src, location.href);
            if (
              frameUrl.hostname === "www.fbsbx.com" &&
              frameUrl.pathname.indexOf("/maw_proxy_page/") === 0
            ) {
              frames[frameIndex].remove();
              removedFrames++;
            }
          } catch (_) {}
        }
        return { applied: removedFrames > 0, removed: removedFrames };
      }
      if (name === "remove-hidden-banner") {
        var banner = document.querySelector('body div[role="banner"]');
        if (!banner || elementState(banner) !== "displayNone") {
          return { applied: false, reason: "no hidden banner" };
        }
        var descendants = banner.querySelectorAll("*").length;
        banner.remove();
        return { applied: true, removedNodes: descendants + 1 };
      }
      return { applied: false, reason: "unknown experiment" };
    }

    // Keep privacy diagnostics sanitized: no message text, raw thread/profile
    // IDs, image URLs, or alt/aria-label contents.
    function privacyProbe() {
      var THREAD_ROW_SEL = '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]';
      var TEXT_SURFACE_SEL = "span, div, h1, h2, h3, h4";
      var VISUAL_SEL = 'img, svg, image, [style*="background-image"]';
      var IDENTITY_SEL = "[data-carrier-private-identity]";
      var WRAPPER_SEL = "[data-carrier-private-wrapper]";
      var PREVIEW_NAME_RE = /^([^:]{1,40}):(?=\s|$)/;
      var PREVIEW_EVENT_RE =
        /^(.{1,40}?)(?=\s+(?:sent|replied|reacted|liked|laughed|loved|mentioned|shared|left|joined|added|removed|changed|created|named|started)\b)/i;

      function textLength(el) {
        return (el.textContent || "").replace(/\s+/g, " ").trim().length;
      }

      function attrs(el) {
        var out = {};
        Array.prototype.forEach.call(el.attributes || [], function (attr) {
          if (attr.name === "src" || attr.name === "alt" || attr.name === "aria-label") {
            out[attr.name] = attr.value ? "[present]" : "";
          } else if (attr.name === "href") {
            out.href = maskedHref(el);
          } else if (attr.value.length < 80) {
            out[attr.name] = attr.value;
          } else {
            out[attr.name] = "[long]";
          }
        });
        return out;
      }

      function ancestors(el) {
        var out = [];
        for (var n = el.parentElement; n && out.length < 5; n = n.parentElement) {
          out.push({
            tag: n.tagName.toLowerCase(),
            role: n.getAttribute("role") || "",
            href: maskedHref(n),
            aria: n.getAttribute("aria-label") ? "[present]" : "",
            style: n.getAttribute("style") ? "[present]" : "",
            className: n.getAttribute("class") ? "[present]" : "",
            carrierIdentity: n.hasAttribute("data-carrier-private-identity"),
            carrierWrapper: n.hasAttribute("data-carrier-private-wrapper"),
            rect: rect(n),
          });
        }
        return out;
      }

      function item(el) {
        var cs = getComputedStyle(el);
        var closestHref = el.closest("a[href]");
        var text = (el.textContent || "").replace(/\s+/g, " ").trim();
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          href: maskedHref(el),
          aria: el.getAttribute("aria-label") ? "[present]" : "",
          textLength: text.length,
          rect: rect(el),
          filter: cs.filter || "",
          backgroundImage: cs.backgroundImage && cs.backgroundImage !== "none" ? "[present]" : "",
          closestHref: maskedHref(closestHref),
          attrs: attrs(el),
          ancestors: ancestors(el),
          flags: {
            inArticle: !!el.closest('[role="article"]'),
            inHeading: !!el.closest("h1,h2,h3,h4"),
            hasReplyPhrase: /\breplied to\b/i.test(text),
            previewNamePattern: PREVIEW_NAME_RE.test(text),
            previewEventPattern: PREVIEW_EVENT_RE.test(text),
            carrierIdentity: el.hasAttribute("data-carrier-private-identity"),
            carrierIdentityAncestor: !!el.closest(IDENTITY_SEL),
            carrierWrapper: el.hasAttribute("data-carrier-private-wrapper"),
            carrierWrapperAncestor: !!el.closest(WRAPPER_SEL),
          },
        };
      }

      function list(selector, limit, root) {
        var out = [];
        (root || document).querySelectorAll(selector).forEach(function (el) {
          if (out.length >= limit || !visible(el)) return;
          out.push(item(el));
        });
        return out;
      }

      function textLeaves(root, limit) {
        var out = [];
        root.querySelectorAll(TEXT_SURFACE_SEL).forEach(function (el) {
          if (out.length >= limit || !visible(el)) return;
          if (!textLength(el)) return;
          var hasTextChild = false;
          Array.prototype.forEach.call(el.children || [], function (child) {
            if (textLength(child)) hasTextChild = true;
          });
          if (hasTextChild) return;
          out.push(item(el));
        });
        return out.sort(function (a, b) {
          return a.rect.y - b.rect.y || a.rect.x - b.rect.x;
        });
      }

      function visuals(root, limit) {
        return list(VISUAL_SEL, limit, root).sort(function (a, b) {
          return a.rect.y - b.rect.y || a.rect.x - b.rect.x;
        });
      }

      function rows(limit) {
        var seen = {};
        var out = [];
        document.querySelectorAll(THREAD_ROW_SEL).forEach(function (row) {
          var href = row.getAttribute("href") || "";
          if (out.length >= limit || seen[href] || !visible(row)) return;
          seen[href] = true;
          out.push({
            row: item(row),
            textLeaves: textLeaves(row, 6),
            visuals: visuals(row, 4),
            identityMarkers: list(IDENTITY_SEL, 10, row),
            wrapperMarkers: list(WRAPPER_SEL, 8, row),
          });
        });
        return out;
      }

      var mainRoot = document.querySelector('[role="main"]') || document.querySelector("main");

      return {
        url: location.href.replace(/\d{3,}/g, "{id}"),
        hasHideAttr: document.documentElement.hasAttribute("data-carrier-hide-names"),
        selectors: {
          conversationRows: rows(5),
          identityMarkers: list(IDENTITY_SEL, 40),
          wrapperMarkers: list(WRAPPER_SEL, 30),
          mainProfileLinks: list(':is(main, [role="main"]) a[href^="/"][href$="/"]:not([href*="/messages/"])', 12),
          circularAvatars: list(':is(main, [role="main"]) img[referrerpolicy="origin-when-cross-origin"][style*="border-radius: 50%"]', 20),
          readReceipts: list(':is(main, [role="main"]) [role="article"] img[height="14"][width="14"][tabindex="-1"]', 20),
          mainImages: list(':is(main, [role="main"]) img', 30),
          senderHeadings: list(':is(main, [role="main"]) [role="article"] h3, :is(main, [role="main"]) [role="article"] h3 *', 40),
          replyAttribution: (mainRoot ? textLeaves(mainRoot, 200) : [])
            .filter(function (el) {
              return el.flags.hasReplyPhrase;
            })
            .slice(0, 20),
        },
      };
    }

    // Sanitized inventory of the controls the keyboard shortcuts target:
    // textboxes, search inputs, and labelled buttons. Chat-list rows, message
    // articles, and thread links are excluded so contact names and message
    // text never appear; labels are classified instead of serialized raw.
    function shortcutProbe() {
      function labelKind(value) {
        var s = (value || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!s) return "";
        if (/\bsearch(?: in conversation| messenger)?\b/.test(s)) return "search";
        if (/\bnew (?:message|chat)\b/.test(s)) return "new-message";
        if (/\b(?:choose an? )?emoji\b/.test(s)) return "emoji";
        if (/\b(?:choose a )?gif\b/.test(s)) return "gif";
        if (/\battach\b/.test(s)) return "attach";
        if (/\bprofile\b/.test(s)) return "profile";
        if (/\bmute\b/.test(s)) return "mute";
        if (/\b(?:photo|video|media)\b/.test(s)) return "media";
        return "[present]";
      }
      function ctl(el) {
        var box = rect(el);
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          type: el.getAttribute("type") || "",
          aria: labelKind(el.getAttribute("aria-label")),
          placeholder: labelKind(el.getAttribute("placeholder")),
          contenteditable: el.getAttribute("contenteditable") || "",
          lexical: el.hasAttribute("data-lexical-editor"),
          href: maskedHref(el),
          inMain: !!el.closest('[role="main"]'),
          inNav: !!el.closest('[role="navigation"]'),
          inPanel: !!el.closest('[role="dialog"], [role="complementary"]'),
          focused: document.activeElement === el,
          rect: box,
        };
      }
      function grab(sel, limit) {
        var out = [];
        document.querySelectorAll(sel).forEach(function (el) {
          if (out.length >= limit || !visible(el)) return;
          // Skip identity-bearing surfaces: chat rows and message bubbles.
          if (el.closest('a[href*="/t/"], [role="article"], [role="gridcell"]')) return;
          out.push(ctl(el));
        });
        return out;
      }
      // Buttons labelled by inner text instead of aria-label (e.g. the info
      // sidebar's Profile/Mute/Search circles). Short texts only — real labels
      // are one or two words; anything longer risks message/name content.
      function textButtons(limit) {
        var out = [];
        document.querySelectorAll('[role="button"]:not([aria-label])').forEach(function (el) {
          if (out.length >= limit || !visible(el)) return;
          if (el.closest('a[href*="/t/"], [role="article"], [role="gridcell"]')) return;
          var text = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!text || text.length > 20) return;
          var roles = [];
          for (var n = el.parentElement; n && roles.length < 8; n = n.parentElement) {
            var role = n.getAttribute("role");
            if (role) roles.push(role);
          }
          var c = ctl(el);
          c.text = labelKind(text);
          c.textLength = text.length;
          c.ancestorRoles = roles;
          out.push(c);
        });
        return out;
      }
      function landmark(sel) {
        var el = document.querySelector(sel);
        if (!el) return null;
        return rect(el);
      }
      return {
        url: maskText(location.href),
        textboxes: grab('[contenteditable="true"], [role="textbox"], textarea', 10),
        inputs: grab("input", 10),
        buttons: grab('[role="button"][aria-label], button[aria-label]', 80),
        textButtons: textButtons(40),
        composeLinks: grab('a[href*="/new"]', 5),
        landmarks: {
          complementary: landmark('[role="complementary"]'),
          main: landmark('[role="main"]'),
        },
        helpers: Object.keys(window.__carrierShortcuts || {}),
      };
    }

    // Geometry-only inventory of large images that can exercise Messenger's
    // media viewer. Avatars and thread-list imagery are excluded, and no URLs,
    // labels, text, or image pixels are returned.
    function largeMessageMedia() {
      var candidates = [];
      document.querySelectorAll('[role="main"] img').forEach(function (image) {
        if (!visible(image)) return;
        if (image.closest('[role="navigation"], a[href*="/t/"], [role="grid"], [role="gridcell"]')) {
          return;
        }
        var imageRect = rect(image);
        if (imageRect.w < 120 || imageRect.h < 80) return;
        var target = image.closest('[role="button"], a') || image;
        candidates.push({
          target: target,
          image: image,
          rect: imageRect,
        });
      });
      return candidates;
    }

    function firstLargeMediaTarget() {
      var candidates = largeMessageMedia();
      return candidates.length ? candidates[0].target : null;
    }

    function mediaProbe() {
      var candidates = largeMessageMedia().map(function (candidate) {
        var image = candidate.image;
        var imageRect = candidate.rect;
        var target = candidate.target;
        return {
          rect: imageRect,
          targetRect: rect(target),
          targetTag: target.tagName.toLowerCase(),
          targetRole: target.getAttribute("role") || "",
          inViewport:
            imageRect.x + imageRect.w > 0 &&
            imageRect.y + imageRect.h > 0 &&
            imageRect.x < innerWidth &&
            imageRect.y < innerHeight,
          naturalBucket:
            image.naturalWidth >= 1000 || image.naturalHeight >= 1000
              ? "large"
              : image.naturalWidth >= 400 || image.naturalHeight >= 400
                ? "medium"
                : "small",
        };
      });
      return {
        candidates: candidates.slice(0, 20),
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        banners: document.querySelectorAll('[role="banner"]').length,
      };
    }

    // Force the page theme through force-theme's own settings path (in-memory
    // only; nothing is persisted). ":system" restores the original setting.
    function setThemeForScreenshot(mode) {
      var settings = window.__CARRIER_SETTINGS__ || (window.__CARRIER_SETTINGS__ = {});
      if (!window.__CARRIER_MCP_ORIG_THEME__) {
        window.__CARRIER_MCP_ORIG_THEME__ = { theme: settings.theme };
      }
      if (mode === "system") {
        settings.theme = window.__CARRIER_MCP_ORIG_THEME__.theme;
        delete window.__CARRIER_MCP_ORIG_THEME__;
      } else {
        settings.theme = mode;
      }
      window.dispatchEvent(new Event("carrier:settings"));
      return {
        theme: settings.theme || "(system)",
        htmlClasses: document.documentElement.className.match(/__fb-\w+-mode/g) || [],
      };
    }

    // Rewrite the theme in the localStorage settings cache (the same cache
    // apply_settings maintains; init_script prefers it over the baked
    // snapshot) and reload. The pre-change cache value is stashed so
    // ":restore" can put back exactly what was there — including removing the
    // key if it did not exist.
    function persistThemeAndReload(mode) {
      var CACHE = "__carrier_settings";
      var STASH = "__carrier_mcp_theme_stash";
      var raw = localStorage.getItem(CACHE);
      if (mode === "restore") {
        var stash = localStorage.getItem(STASH);
        if (stash === null) return { error: "nothing stashed to restore" };
        if (stash === "\u0000missing") {
          localStorage.removeItem(CACHE);
        } else {
          localStorage.setItem(CACHE, stash);
        }
        localStorage.removeItem(STASH);
      } else {
        if (localStorage.getItem(STASH) === null) {
          localStorage.setItem(STASH, raw === null ? "\u0000missing" : raw);
        }
        var settings;
        try {
          settings = JSON.parse(raw || "null");
        } catch (_) {
          settings = null;
        }
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          settings = Object.assign({}, window.__CARRIER_SETTINGS__ || {});
        }
        settings.theme = mode;
        localStorage.setItem(CACHE, JSON.stringify(settings));
      }
      setTimeout(function () {
        location.reload();
      }, 300);
      return { persisted: mode, reloading: true };
    }

    // Shared DOM-based SVG sanitizer for the design/icon probes: removes
    // text-bearing nodes (title/desc/text/tspan) and raster/reference
    // content outright, then strips identity/tracking-bearing attributes.
    function sanitizeSvgMarkup(svg) {
      var clone = svg.cloneNode(true);
      Array.prototype.forEach.call(
        clone.querySelectorAll("title, desc, text, tspan, image, use, foreignObject, script, style, metadata"),
        function (n) {
          if (n.parentNode) n.parentNode.removeChild(n);
        },
      );
      // Scrub raw text and comment nodes everywhere (glyph markup is
      // element-only; whitespace text is layout-irrelevant).
      (function scrub(node) {
        Array.prototype.slice.call(node.childNodes).forEach(function (child) {
          if (child.nodeType === 1) scrub(child);
          else node.removeChild(child);
        });
      })(clone);
      var KEEP = {
        viewbox: 1, width: 1, height: 1, d: 1, fill: 1, stroke: 1,
        "stroke-width": 1, "stroke-linecap": 1, "stroke-linejoin": 1,
        "fill-rule": 1, "clip-rule": 1, transform: 1, opacity: 1,
        "fill-opacity": 1, "stroke-opacity": 1,
        cx: 1, cy: 1, r: 1, rx: 1, ry: 1,
        x: 1, y: 1, x1: 1, x2: 1, y1: 1, y2: 1, points: 1,
      };
      var nodes = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
      nodes.forEach(function (el) {
        Array.prototype.slice.call(el.attributes || []).forEach(function (attr) {
          // allowlist of geometry/paint attributes; anything URL-bearing goes
          if (!KEEP[attr.name.toLowerCase()] || attr.value.indexOf("url(") !== -1) {
            el.removeAttribute(attr.name);
          }
        });
      });
      return clone.outerHTML;
    }

    // Functional UI glyphs (search, call, video, plus, GIF, …) for the
    // landing-page replica. Path data only: svgs containing <image>, <use>,
    // or <foreignObject> (avatars, photos) are skipped, and the shared
    // sanitizer drops text nodes and identity-bearing attributes, so no
    // identity or tracking state leaks. Brand logos are not collected here —
    // the chrome areas scanned hold plain UI controls.
    function iconProbe() {
      // Classify by the host control's aria-label without leaking raw text.
      function kindOf(el) {
        var host = el.closest('[aria-label], [role="button"], a[href]');
        var s = ((host && host.getAttribute("aria-label")) || "").toLowerCase();
        if (!s) return "";
        if (/search/.test(s)) return "search";
        if (/new message|new chat|compose/.test(s)) return "compose";
        if (/settings|preference/.test(s)) return "settings";
        if (/video/.test(s)) return "video";
        if (/audio|call/.test(s)) return "call";
        if (/information|info/.test(s)) return "info";
        if (/more|menu|options|actions/.test(s)) return "more-or-plus";
        if (/emoji/.test(s)) return "emoji";
        if (/gif/.test(s)) return "gif";
        if (/sticker/.test(s)) return "sticker";
        if (/attach|file/.test(s)) return "attach";
        if (/photo|image|media/.test(s)) return "photo";
        if (/voice|record/.test(s)) return "voice";
        if (/like|thumb/.test(s)) return "like";
        if (/send/.test(s)) return "send";
        return "[other]";
      }
      var out = [];
      var seen = {};
      document
        .querySelectorAll('[role="navigation"] svg, [role="main"] svg')
        .forEach(function (svg) {
          if (out.length >= 40 || !visible(svg)) return;
          if (svg.querySelector("image, use, foreignObject")) return;
          var markup = sanitizeSvgMarkup(svg);
          if (markup.length > 4000 || seen[markup]) return;
          seen[markup] = true;
          var cs = getComputedStyle(svg);
          out.push({
            kind: kindOf(svg),
            rect: rect(svg),
            inNav: !!svg.closest('[role="navigation"]'),
            fill: cs.fill,
            color: cs.color,
            markup: markup,
          });
        });
      return { page: /\/messages\//.test(location.pathname) ? "messages" : "other", icons: out };
    }

    // Structure of the composer's like/send control (bottom-right of main),
    // to identify how the thumb glyph is rendered. Svg markup is sanitized
    // like iconProbe; raster sources are reported as "[image]"/"[sprite]".
    function likeProbe() {
      var main = document.querySelector('[role="main"]');
      if (!main) return { error: "no main" };
      var mainRect = main.getBoundingClientRect();
      var buttons = [];
      main.querySelectorAll('[role="button"], button').forEach(function (btn) {
        if (buttons.length >= 4 || !visible(btn)) return;
        var r = btn.getBoundingClientRect();
        // Composer row: bottom 60px of main, right third.
        if (r.top < mainRect.bottom - 60) return;
        if (r.left < mainRect.left + mainRect.width * 0.7) return;
        var nodes = [];
        var budget = 40;
        (function walk(el, depth) {
          if (!el || depth > 7 || budget-- <= 0) return;
          var tag = el.tagName.toLowerCase();
          var cs = getComputedStyle(el);
          var entry = { tag: tag, depth: depth, rect: rect(el) };
          if (tag === "svg") entry.markup = sanitizeSvgMarkup(el).slice(0, 3000);
          if (tag === "img") entry.src = el.getAttribute("src") ? "[image]" : "";
          if (cs.backgroundImage && cs.backgroundImage !== "none") {
            entry.backgroundImage =
              cs.backgroundImage.indexOf("url(") !== -1
                ? "[sprite]"
                : cs.backgroundImage.slice(0, 120);
          }
          var mask = cs.webkitMaskImage || cs.maskImage;
          if (mask && mask !== "none") {
            entry.maskImage = mask.indexOf("url(") !== -1 ? "[mask-sprite]" : mask.slice(0, 120);
            entry.backgroundColor = cs.backgroundColor;
          }
          nodes.push(entry);
          if (tag !== "svg") {
            Array.prototype.forEach.call(el.children, function (child) {
              walk(child, depth + 1);
            });
          }
        })(btn, 0);
        buttons.push({ rect: rect(btn), nodes: nodes });
      });
      return { buttons: buttons };
    }

    // Sanitized design probe: geometry, computed colors/typography, and a
    // depth-limited structure outline of the live chat UI. Palettes are
    // sampled under both themes by toggling the __fb-*-mode class
    // synchronously (restored before returning, so nothing repaints).
    // Reports rects, computed styles, tag/role outlines, and counts only —
    // never text, hrefs, IDs, or image sources.
    function designProbe() {
      var html = document.documentElement;
      var PROPS = [
        "background-color",
        "background-image",
        "background-attachment",
        "color",
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-left-radius",
        "border-bottom-right-radius",
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
        "padding",
        "border",
        "box-shadow",
      ];

      function styleOf(el) {
        if (!el) return null;
        var cs = getComputedStyle(el);
        var out = { rect: rect(el) };
        PROPS.forEach(function (p) {
          var v = cs.getPropertyValue(p);
          // computed backgrounds can embed identity-bearing url(...) sources
          out[p] = v && v.indexOf("url(") !== -1 ? "[image]" : v;
        });
        return out;
      }

      function withThemeClass(mode, fn) {
        var had = {
          dark: html.classList.contains("__fb-dark-mode"),
          light: html.classList.contains("__fb-light-mode"),
        };
        html.classList.remove("__fb-dark-mode", "__fb-light-mode");
        html.classList.add(mode === "dark" ? "__fb-dark-mode" : "__fb-light-mode");
        try {
          return fn();
        } finally {
          html.classList.remove("__fb-dark-mode", "__fb-light-mode");
          if (had.dark) html.classList.add("__fb-dark-mode");
          if (had.light) html.classList.add("__fb-light-mode");
        }
      }

      function roundedBg(el, minRadius) {
        var cs = getComputedStyle(el);
        var bg = cs.backgroundColor;
        // Outgoing bubbles paint a background-image gradient over a
        // transparent background-color, so accept either form of paint.
        var hasPaint =
          (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") ||
          (cs.backgroundImage || "").indexOf("gradient") !== -1;
        if (!hasPaint) return false;
        return (
          (parseFloat(cs.borderTopLeftRadius) || 0) >= minRadius ||
          (parseFloat(cs.borderBottomRightRadius) || 0) >= minRadius
        );
      }

      // Discover elements once; styles are then sampled per theme.
      var nav = document.querySelector('[role="navigation"]');
      var main = document.querySelector('[role="main"]');
      var mainRect = main ? main.getBoundingClientRect() : { x: 0, width: innerWidth };
      var mainCenter = mainRect.x + mainRect.width / 2;

      var rows = [];
      document
        .querySelectorAll('[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]')
        .forEach(function (row) {
          if (rows.length >= 3 || !visible(row)) return;
          rows.push(row);
        });

      function rowParts(row) {
        var avatar = null;
        row.querySelectorAll("img").forEach(function (img) {
          if (avatar || !visible(img)) return;
          if (getComputedStyle(img).borderRadius.indexOf("50%") !== -1) avatar = img;
        });
        if (!avatar) avatar = row.querySelector("img");
        var texts = [];
        var seen = {};
        row.querySelectorAll("span").forEach(function (el) {
          if (texts.length >= 3 || !visible(el)) return;
          if (!(el.textContent || "").trim()) return;
          var cs = getComputedStyle(el);
          var key = cs.fontSize + "/" + cs.fontWeight + "/" + cs.color;
          if (seen[key]) return;
          seen[key] = true;
          texts.push(el);
        });
        return { avatar: avatar, texts: texts };
      }

      var bubbles = [];
      document.querySelectorAll('[role="main"] [role="article"]').forEach(function (article) {
        if (bubbles.length >= 6 || !visible(article)) return;
        var candidate = null;
        var candidateArea = Infinity;
        article.querySelectorAll("div, span").forEach(function (el) {
          if (!visible(el) || !roundedBg(el, 8)) return;
          var r = el.getBoundingClientRect();
          if (r.width < 28 || r.height < 20 || r.width > mainRect.width) return;
          var area = r.width * r.height;
          if (area < candidateArea) {
            candidate = el;
            candidateArea = area;
          }
        });
        if (candidate) {
          var r = candidate.getBoundingClientRect();
          bubbles.push({ el: candidate, side: r.x + r.width / 2 > mainCenter ? "out" : "in" });
        }
      });

      var composerInput = document.querySelector(
        '[role="main"] [contenteditable="true"], [role="main"] [role="textbox"]',
      );
      var composerBox = null;
      for (var n = composerInput && composerInput.parentElement, i = 0; n && i < 6; n = n.parentElement, i++) {
        if (roundedBg(n, 12)) {
          composerBox = n;
          break;
        }
      }

      var icons = [];
      document
        .querySelectorAll('[role="main"] [role="button"] svg, [role="main"] button svg')
        .forEach(function (svg) {
          if (icons.length >= 3 || !visible(svg)) return;
          icons.push(svg);
        });

      var threadName = document.querySelector('[role="main"] h2');
      var navHeader = document.querySelector('[role="navigation"] h1');
      var searchInput = document.querySelector('[role="navigation"] input');
      var searchBox = null;
      for (var s = searchInput && searchInput.parentElement, j = 0; s && j < 5; s = s.parentElement, j++) {
        if (roundedBg(s, 10)) {
          searchBox = s;
          break;
        }
      }

      // Depth- and budget-limited tag/role outline (structure without content).
      var outlineBudget = 400;
      function outline(el, depth) {
        if (!el || depth < 0 || outlineBudget <= 0 || !visible(el)) return null;
        outlineBudget--;
        var out = {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          textLength: 0,
          rect: rect(el),
          children: [],
        };
        var exactLen = 0;
        Array.prototype.forEach.call(el.childNodes, function (child) {
          if (child.nodeType === 3) {
            exactLen += (child.textContent || "").trim().length;
          } else if (child.nodeType === 1 && out.children.length < 8) {
            var sub = outline(child, depth - 1);
            if (sub) out.children.push(sub);
          }
        });
        // coarse bucket only — exact lengths could fingerprint short texts
        out.textLength = exactLen === 0 ? 0 : Math.min(50, Math.ceil(exactLen / 10) * 10);
        return out;
      }

      function samplePalette() {
        return {
          body: styleOf(document.body),
          nav: styleOf(nav),
          navHeader: styleOf(navHeader),
          searchBox: styleOf(searchBox),
          rows: rows.map(function (row) {
            var parts = rowParts(row);
            return {
              row: styleOf(row),
              avatar: styleOf(parts.avatar),
              texts: parts.texts.map(function (el) {
                return styleOf(el);
              }),
            };
          }),
          main: styleOf(main),
          threadName: styleOf(threadName),
          bubbles: bubbles.map(function (b) {
            return { side: b.side, style: styleOf(b.el) };
          }),
          composerInput: styleOf(composerInput),
          composerBox: styleOf(composerBox),
          icons: icons.map(function (svg) {
            var cs = getComputedStyle(svg);
            return { rect: rect(svg), color: cs.color, fill: cs.fill };
          }),
        };
      }

      var articleRects = [];
      document.querySelectorAll('[role="main"] [role="article"]').forEach(function (a) {
        if (articleRects.length >= 8 || !visible(a)) return;
        articleRects.push(rect(a));
      });

      return {
        page: /\/messages\//.test(location.pathname) ? "messages" : "other",
        viewport: { w: innerWidth, h: innerHeight },
        htmlClasses: html.className.match(/__fb-\w+-mode/g) || [],
        geometry: {
          nav: nav ? rect(nav) : null,
          main: main ? rect(main) : null,
          articles: articleRects,
        },
        structure: {
          row: rows[0] ? outline(rows[0], 6) : null,
          article: bubbles[0] ? outline(bubbles[0].el.closest('[role="article"]'), 6) : null,
          composer: composerBox ? outline(composerBox, 4) : null,
        },
        light: withThemeClass("light", samplePalette),
        dark: withThemeClass("dark", samplePalette),
      };
    }

    // --- get-page-state : lightweight document metadata -----------------------
    listen("get-page-state", function (ev) {
      var cid = correlationId(ev && ev.payload);
      try {
        respond(
          "get-page-state-response",
          cid,
          safeStringify({
            success: true,
            data: {
              url: location.href,
              title: document.title,
              readyState: document.readyState,
              scrollPosition: { x: scrollX, y: scrollY },
              viewport: { width: innerWidth, height: innerHeight },
            },
          }),
        );
      } catch (e) {
        respond(
          "get-page-state-response",
          cid,
          safeStringify({ success: false, error: String(e) }),
        );
      }
    });

    // --- get-page-map : compact semantic DOM map (no eval; CSP-safe) ----------
    // The upstream guest bundle normally supplies this serializer. Carrier's
    // remote page cannot import that bundle, so keep a deliberately compact
    // equivalent here: semantic and interactive nodes, bounded text, no form
    // values, and digit-masked hrefs.
    listen("get-page-map", function (ev) {
        var p = (ev && ev.payload) || {};
        var cid = correlationId(p);
      try {
        var includeContent = p.includeContent !== false;
        var interactiveOnly = p.interactiveOnly === true;
        var requestedMaxDepth =
          typeof p.maxDepth === "number" && Number.isFinite(p.maxDepth) ? p.maxDepth : 12;
        var maxDepth = Math.floor(Math.max(0, Math.min(30, requestedMaxDepth)));
        var scopes = Array.isArray(p.scopeSelector)
          ? p.scopeSelector
          : p.scopeSelector
            ? [p.scopeSelector]
            : [];
        var roots = [];
        if (scopes.length) {
          scopes.forEach(function (selector) {
            try {
              document.querySelectorAll(selector).forEach(function (node) {
                if (roots.indexOf(node) === -1) roots.push(node);
              });
            } catch (_) {}
          });
        }
        if (!scopes.length && document.documentElement) roots.push(document.documentElement);

        var interactiveTags = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|DETAILS|SUMMARY)$/;
        var semanticTags =
          /^(H[1-6]|IMG|NAV|MAIN|HEADER|FOOTER|ASIDE|SECTION|ARTICLE|FORM|LABEL|P|LI|UL|OL|DL|DT|DD)$/;
        var interactiveRoles =
          /^(button|link|textbox|checkbox|radio|switch|slider|spinbutton|combobox|listbox|option|menuitem|tab|searchbox)$/;
        // This bridge inspects third-party markup. Treat its size and shape as
        // untrusted so a pathological Messenger page cannot monopolize the
        // webview or generate a huge IPC response.
        var MAX_VISITED_NODES = 10000;
        var MAX_ELEMENTS = 2000;
        var MAX_OUTPUT_CHARS = 200000;
        var elements = [];
        var nextRef = 1;
        var visitedNodes = 0;
        var outputChars = 0;
        var exhausted = false;

        function mapVisible(node) {
          if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
          var style = getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden";
        }

        function mapInteractiveText(node) {
          if (!includeContent) return "";
          return maskText((node.innerText || node.textContent || "").replace(/\s+/g, " ").trim(), 300);
        }

        function walk(node, depth, parentRef, ancestorsVisible) {
          if (
            exhausted ||
            !node ||
            depth > maxDepth ||
            /^(SCRIPT|STYLE|NOSCRIPT|HEAD|META|LINK|TEMPLATE)$/.test(node.tagName)
          )
            return;
          visitedNodes += 1;
          if (visitedNodes > MAX_VISITED_NODES) {
            exhausted = true;
            return;
          }
          var visibleNow = ancestorsVisible && mapVisible(node);
          // A hidden ancestor makes its complete subtree irrelevant to the
          // semantic map. Prune it before reading text or walking children.
          if (!visibleNow) return;
          var role = (node.getAttribute("role") || "").toLowerCase();
          var interactive =
            interactiveTags.test(node.tagName) ||
            interactiveRoles.test(role) ||
            node.hasAttribute("contenteditable") ||
            node.tabIndex >= 0;
          var semantic = semanticTags.test(node.tagName) || !!role;
          var directText = "";
          // Preserve useful direct text on leaf semantic/plain nodes without
          // serializing the complete subtree text for every ancestor.
          if (includeContent && node.children.length === 0) {
            for (var i = 0; i < node.childNodes.length; i++) {
              if (node.childNodes[i].nodeType === 3) directText += node.childNodes[i].textContent || "";
            }
            directText = maskText(directText.replace(/\s+/g, " ").trim(), 300);
          }
          var shouldInclude =
            interactive || semantic || (!!directText && node.children.length === 0);
          var ownRef = parentRef;
          if (shouldInclude && (!interactiveOnly || interactive)) {
            ownRef = nextRef++;
            var interactiveText =
              interactive && !directText ? mapInteractiveText(node) : "";
            var item = {
              ref: ownRef,
              tag: node.tagName.toLowerCase(),
              interactive: interactive || undefined,
              role: role || undefined,
              text: (directText || interactiveText) || undefined,
              ariaLabel: maskText(node.getAttribute("aria-label") || "", 200) || undefined,
              href: maskedHref(node) || undefined,
              id: maskText(node.id || "", 120) || undefined,
              type: node.getAttribute("type") || undefined,
              checked:
                typeof node.checked === "boolean" ? node.checked : undefined,
              disabled:
                node.disabled === true || node.getAttribute("aria-disabled") === "true" || undefined,
              parentRef: parentRef || undefined,
              depth: depth,
              visible: visibleNow,
            };
            Object.keys(item).forEach(function (key) {
              if (item[key] === undefined) delete item[key];
            });
            var itemChars = safeStringify(item).length;
            if (
              elements.length >= MAX_ELEMENTS ||
              outputChars + itemChars > MAX_OUTPUT_CHARS
            ) {
              exhausted = true;
              return;
            }
            outputChars += itemChars;
            elements.push(item);
          }
          for (var c = 0; c < node.children.length; c++) {
            walk(node.children[c], depth + 1, ownRef, visibleNow);
          }
        }

        roots.forEach(function (root) {
          walk(root, 0, null, true);
        });
        var contentSource = roots
          .filter(function (root) {
            return mapVisible(root);
          })
          .map(function (root) {
            return root.innerText || "";
          })
          .join(" ");
        var content = includeContent
          ? maskText(
              contentSource.replace(/\s+/g, " ").trim(),
              Math.min(20000, Math.max(0, MAX_OUTPUT_CHARS - outputChars)),
            )
          : "";
        respond(
          "get-page-map-response",
          cid,
          safeStringify({
            url: location.href,
            title: document.title,
            viewport: { width: innerWidth, height: innerHeight },
            elements: elements,
            content: content,
            scope: p.scopeSelector || undefined,
            maxDepth: maxDepth,
            truncated: exhausted || undefined,
          }),
        );
      } catch (e) {
        respond(
          "get-page-map-response",
          cid,
          safeStringify({
            url: location.href,
            title: document.title,
            viewport: { width: innerWidth, height: innerHeight },
            elements: [],
            content: "",
            error: String(e),
          }),
        );
      }
    });

    // --- got-dom-content : full serialized DOM (no eval; CSP-safe) ------------
    listen("got-dom-content", function (ev) {
      var cid = correlationId(ev && ev.payload);
      var dom = "";
      try {
        if (document.readyState === "complete" || document.readyState === "interactive") {
          dom = document.documentElement.outerHTML;
        }
      } catch (_) {}
      respond("got-dom-content-response", cid, dom);
    });

    window.__CARRIER_MCP_BRIDGE__ = true;
    try {
      console.log("[carrier] tauri-mcp guest bridge ready on window '" + label + "'");
    } catch (_) {}
    return true;
  }

  // __TAURI_INTERNALS__ is normally present at document-start, but retry briefly
  // in case this init script runs a touch early.
  if (!setup()) {
    var tries = 0;
    var timer = setInterval(function () {
      if (setup() || ++tries > 100) clearInterval(timer);
    }, 50);
  }
})();
