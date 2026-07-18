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

  function setup() {
    var II = window.__TAURI_INTERNALS__;
    if (!II || typeof II.invoke !== "function" || typeof II.transformCallback !== "function") {
      return false;
    }

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
        // CSP-safe control probe for keyboard-shortcut selector work (#18/#30).
        if (code === "__carrier_mcp_shortcut_probe__") {
          reply(shortcutProbe());
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
