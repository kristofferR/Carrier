/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/messenger/ (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // inject/src/messenger/lib/downloads.ts
  var filenameFromUrl = (u, base) => {
    try {
      const p = new URL(u, base).pathname.split("/").pop();
      return p?.includes(".") ? decodeURIComponent(p) : "";
    } catch {
      return "";
    }
  };
  var GENERIC_DOWNLOAD_STEMS = /* @__PURE__ */ new Set(["download", "image", "video"]);
  var splitDownloadName = (name) => {
    const file = String(name || "").trim().split(/[\\/]/).pop() || "";
    const dot = file.lastIndexOf(".");
    if (dot > 0 && dot < file.length - 1) {
      return { stem: file.slice(0, dot), ext: file.slice(dot) };
    }
    return { stem: file, ext: "" };
  };
  var friendlyDownloadName = (name) => {
    const { stem, ext } = splitDownloadName(name);
    if (!stem || GENERIC_DOWNLOAD_STEMS.has(stem.toLowerCase())) {
      return `Messenger${ext}`;
    }
    return name;
  };
  var downloadRevealLabel = (userAgent) => /Mac/i.test(userAgent) ? "Show in Finder" : "Show in folder";
  var isDownloadCancellation = (error) => error instanceof Error && error.message === "download cancelled";
  var DOWNLOAD_ACCESS_DENIED = "download folder access denied";
  var isDownloadAccessDenied = (error) => error instanceof Error && error.message === DOWNLOAD_ACCESS_DENIED;
  var downloadAccessDeniedToast = (platform) => platform === "macos" ? {
    message: "Carrier isn't allowed to save to your Downloads folder",
    action: { label: "Open Settings", kind: "open-download-privacy" }
  } : {
    message: "Carrier isn't allowed to save to your Downloads folder. Check the folder's permissions."
  };

  // inject/src/messenger/lib/links.ts
  var INTERNAL_HOSTS = [
    "facebook.com",
    "messenger.com",
    "fbcdn.net",
    "fbsbx.com",
    "meta.com",
    "oculus.com"
  ];
  var AUTH_HOSTS = ["accounts.google.com", "login.microsoftonline.com", "appleid.apple.com"];
  var FACEBOOK_TRACKING_PARAMS = /* @__PURE__ */ new Set([
    "fbclid",
    "mibextid",
    "fb_action_ids",
    "fb_action_types",
    "fb_ref",
    "fb_source"
  ]);
  function isAuth(u) {
    const host = u.hostname.toLowerCase();
    return AUTH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  }
  function facebookRedirectTarget(url) {
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const isRedirect = (host === "l.facebook.com" || host === "lm.facebook.com" || host === "facebook.com") && url.pathname === "/l.php";
    if (!isRedirect) return null;
    const target = url.searchParams.get("u");
    if (!target) return null;
    try {
      return /^https?:$/.test(new URL(target).protocol) ? target : null;
    } catch {
      return null;
    }
  }
  function trackingKey(rawPair) {
    const rawKey = rawPair.split("=", 1)[0] ?? "";
    try {
      return decodeURIComponent(rawKey.replace(/\+/g, " ")).toLowerCase();
    } catch {
      return null;
    }
  }
  function stripRawFacebookParams(href) {
    const hashAt = href.indexOf("#");
    const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
    const hash = hashAt < 0 ? "" : href.slice(hashAt);
    const queryAt = beforeHash.indexOf("?");
    if (queryAt < 0) return { href, removed: false };
    const prefix = beforeHash.slice(0, queryAt);
    const pairs = beforeHash.slice(queryAt + 1).split("&");
    const kept = pairs.filter((pair) => {
      const key = trackingKey(pair);
      return !key || !FACEBOOK_TRACKING_PARAMS.has(key);
    });
    if (kept.length === pairs.length) return { href, removed: false };
    return {
      href: `${prefix}${kept.length ? `?${kept.join("&")}` : ""}${hash}`,
      removed: true
    };
  }
  function stripFacebookTracking(href, base) {
    let url;
    try {
      url = new URL(href, base);
    } catch {
      return href;
    }
    if (!/^https?:$/.test(url.protocol)) return href;
    const seen = /* @__PURE__ */ new Set();
    let unwrapped = false;
    for (let depth = 0; depth < 4; depth++) {
      const target = facebookRedirectTarget(url);
      if (!target || seen.has(target)) break;
      seen.add(target);
      url = new URL(target);
      unwrapped = true;
    }
    const cleaned = stripRawFacebookParams(url.href);
    return unwrapped || cleaned.removed ? cleaned.href : href;
  }
  var FACEBOOK_APP_PATH_RE = /^\/(messages|messenger_media|t|login(\.php)?|checkpoint|two_step_verification|two_factor|recover|reg|r\.php)(\/|$)/;
  function classifyHref(href, base) {
    try {
      const u = new URL(href, base);
      if (u.protocol === "mailto:" || u.protocol === "tel:") return { external: true };
      if (!/^https?:$/.test(u.protocol)) return { external: false };
      if (isAuth(u)) return { external: false };
      const host = u.hostname.replace(/^www\./, "");
      const tracking = host === "l.facebook.com" || host === "lm.facebook.com" || host === "facebook.com" && u.pathname === "/l.php";
      const internal = INTERNAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
      const isFacebook = host === "facebook.com" || host.endsWith(".facebook.com");
      const inApp = isFacebook ? FACEBOOK_APP_PATH_RE.test(u.pathname) : internal;
      return { external: tracking || !inApp };
    } catch {
      return { external: false };
    }
  }

  // inject/src/messenger/bridge.ts
  var invoke = (cmd, args) => window.__TAURI_INTERNALS__?.invoke(cmd, args);
  var toast = (msg, action2, options) => window.__carrierToast ? window.__carrierToast(msg, action2, options) : console.log("[carrier]", msg);
  var diag = /* @__PURE__ */ (() => {
    const RATE_MS = 6e4;
    const lastSent = /* @__PURE__ */ new Map();
    return (key, msg) => {
      try {
        const now = Date.now();
        if (now - (lastSent.get(key) || 0) < RATE_MS) return;
        lastSent.set(key, now);
        try {
          if (localStorage.__carrier_debug === "1") console.warn(`[carrier] ${key}: ${msg}`);
        } catch (_) {
        }
        invoke("plugin:event|emit", {
          event: "carrier:diag",
          payload: { key: String(key), msg: String(msg) }
        })?.catch?.(() => {
        });
      } catch (_) {
      }
    };
  })();
  var cleanSharedUrl = (url) => window.__CARRIER_SETTINGS__?.strip_link_tracking === false ? url : stripFacebookTracking(url, location.href);
  var openUrl = (url) => invoke("plugin:opener|open_url", { url: cleanSharedUrl(url), with: null })?.catch?.(
    () => diag("ipc.open-url", "opener invoke failed")
  );
  var toastDownloadSaved = (url) => toast(
    window.__CARRIER_SETTINGS__?.download_behavior === "ask" ? "Download saved" : "Saved to Downloads",
    {
      label: downloadRevealLabel(navigator.userAgent),
      kind: "reveal-download",
      url
    }
  );
  var toastDownloadFailure = (error, message = "Download failed") => {
    if (isDownloadCancellation(error) || isDownloadAccessDenied(error)) return;
    toast(message);
  };
  var toastDownloadAccessDenied = () => {
    const { message, action: action2 } = downloadAccessDeniedToast(carrierMediaPlatform);
    toast(message, action2, { warning: true });
  };

  // inject/src/messenger/lib/facebook-loader.ts
  function pageRequire() {
    const load = window.require;
    return typeof load === "function" ? load : null;
  }
  function defaultExport(module) {
    if (module && typeof module === "object" && "default" in module) {
      return module.default;
    }
    return module;
  }
  function loadFacebookModules(load, names2, timeoutMs = 1e4) {
    return new Promise((resolve, reject) => {
      let bootloader;
      try {
        bootloader = load?.("Bootloader");
      } catch (_) {
      }
      if (!load || typeof bootloader?.loadModules !== "function") {
        reject(new Error("Messenger's module loader is unavailable"));
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`Messenger did not load ${names2.join(", ")}`)),
        timeoutMs
      );
      try {
        bootloader.loadModules(
          names2,
          () => {
            clearTimeout(timer);
            try {
              resolve(names2.map((name) => load(name)));
            } catch (error) {
              reject(error);
            }
          },
          "carrier"
        );
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  // inject/src/messenger/lib/threads.ts
  function threadIdFromHref(href) {
    const m = (href || "").match(/\/t\/(\d+)/);
    return m ? m[1] : null;
  }
  function threadPathId(href) {
    const m = String(href || "").match(/^\/t\/(\d+)\/?$/);
    return m ? m[1] : null;
  }
  function accountId(cookie) {
    return (cookie || "").match(/(?:^|;\s*)c_user=(\d{1,32})(?:;|$)/)?.[1] ?? null;
  }
  function accountScopedStorageKey(baseKey, cookie) {
    const account2 = accountId(cookie);
    return account2 ? `${baseKey}:${account2}` : null;
  }
  function isMessengerContentPath(pathname) {
    const path = String(pathname || "");
    return path === "/messages" || path.startsWith("/messages/") || threadPathId(path) !== null;
  }
  var SEPARATOR_RE = /^[·•.,\s]+$/;

  // inject/src/messenger/lib/log-out.ts
  async function logOutOfFacebook({ load, cookie, post }) {
    if (!accountId(cookie())) return;
    const [environment, relay, query, dtsg, route] = await loadFacebookModules(load, [
      "CometRelayEnvironment",
      "relay-runtime",
      "CometLogoutHandlerQuery.graphql",
      "DTSG",
      "XLogoutControllerRouteBuilder"
    ]);
    const data = await relay.fetchQuery(defaultExport(environment), query, {}, { fetchPolicy: "network-only" }).toPromise();
    const hash = data?.viewer?.logout_hash;
    if (typeof hash !== "string" || !hash) throw new Error("Facebook sent no logout token.");
    const body = new URLSearchParams({ h: hash, ref: "mb" });
    const token = dtsg.getToken?.();
    if (typeof token === "string" && token) body.set("fb_dtsg", token);
    const built = defaultExport(route).buildURL?.({
      button_location: "settings",
      button_name: "logout"
    });
    const url = typeof built === "string" && built.startsWith("/logout.php") ? built : "/logout.php";
    await post(url, body).catch(() => {
    });
    if (accountId(cookie())) throw new Error("Facebook didn't end the session.");
    try {
      const [monster, serviceWorker] = await loadFacebookModules(
        load,
        ["WebStorageMonster", "ServiceWorkerLoginAndLogout"],
        3e3
      );
      const whitelist = Array.isArray(data?.logout_whitelist) ? data.logout_whitelist : [];
      defaultExport(monster).cleanOnLogout?.(
        whitelist
      );
      defaultExport(serviceWorker).logout?.();
    } catch (_) {
    }
  }

  // inject/src/messenger/lib/messenger-dnd.ts
  var muteUntilSeconds = null;
  function setMessengerDndUntil(seconds) {
    muteUntilSeconds = seconds;
  }
  function messengerDndActive(nowMs = Date.now()) {
    const until = muteUntilSeconds;
    if (until === null) return false;
    return until < 0 || until * 1e3 > nowMs;
  }
  function muteUntilFromDatabase(raw, i64ToString) {
    let text = raw;
    if (typeof raw === "number") return Number.isFinite(raw) ? Math.trunc(raw) : null;
    if (typeof raw === "bigint") text = raw.toString();
    else if (typeof raw !== "string" && raw != null && i64ToString) text = i64ToString(raw);
    if (typeof text !== "string" || !/^-?\d+$/.test(text)) return null;
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  async function readMessengerDndUntil(account2, load, timeoutMs = 750) {
    if (!/^\d+$/.test(account2) || typeof load !== "function") return null;
    let timer;
    const read = async () => {
      const singleton = load("LSDatabaseSingleton");
      const db = await singleton.LSDatabaseSingleton;
      const i64 = load("I64");
      const table = db?.tables?.notification_settings;
      if (typeof table?.get !== "function" || typeof i64?.of_string !== "function") return null;
      const row = await table.get(i64.of_string(account2));
      if (!row || typeof row !== "object") return 0;
      return muteUntilFromDatabase(
        row.globalMuteUntil,
        i64.to_string?.bind(i64)
      );
    };
    try {
      return await Promise.race([
        read().catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // inject/src/messenger/lib/messenger-account.ts
  var flag = (value) => typeof value === "boolean" ? value : null;
  function stateFromViewer(viewer, resolveActiveStatus, dndUntil) {
    if (!viewer) return { activeStatus: null, sounds: null, dndUntil };
    const active = resolveActiveStatus(
      flag(viewer.chat_visibility),
      flag(viewer.chat_visibility_on_messenger),
      flag(viewer.chat_visibility_on_facebook)
    );
    return { activeStatus: flag(active), sounds: flag(viewer.chat_sounds_on), dndUntil };
  }
  function dndUntilFor(minutes, nowMs) {
    if (minutes === 0 || minutes === -1) return minutes;
    return Math.floor(nowMs / 1e3) + minutes * 60;
  }
  async function loadPreferencesCode(load) {
    const loadRoot = async (entrypoint) => {
      const root = defaultExport(entrypoint).root;
      if (typeof root?.load !== "function") throw new Error("Messenger's Preferences changed.");
      await root.load();
    };
    const [dialog] = await loadFacebookModules(load, ["MWInboxSettingsDialog.entrypoint"]);
    await loadRoot(dialog);
    const [presence] = await loadFacebookModules(load, ["MWInboxSettingsPresenceDialog.entrypoint"]);
    await loadRoot(presence);
  }
  async function readMessengerAccount(load, account2) {
    await loadPreferencesCode(load);
    const [environment, relay, query, resolve] = await loadFacebookModules(load, [
      "CometRelayEnvironment",
      "relay-runtime",
      "useCometHomeChatSettingsQuery.graphql",
      "resolveActiveStatus"
    ]);
    const data = await relay.fetchQuery(defaultExport(environment), query, {}, { fetchPolicy: "network-only" }).toPromise();
    if (!data?.viewer) throw new Error("Messenger didn't report its settings.");
    const dndUntil = await readMessengerDndUntil(account2, load, 3e3);
    return stateFromViewer(
      data.viewer,
      defaultExport(resolve),
      dndUntil
    );
  }
  async function changeMessengerAccount(load, account2, change) {
    await loadPreferencesCode(load);
    if (change.setting === "sounds") {
      const [environment, mutation] = await loadFacebookModules(load, [
        "CometRelayEnvironment",
        "MWChatChangeSoundsSettingMutation"
      ]);
      await mutation.commit(
        defaultExport(environment),
        { sounds_on: change.value }
      );
    } else if (change.setting === "activeStatus") {
      await setActiveStatus(load, change.value);
    } else {
      await setDoNotDisturb(load, account2, change.value);
    }
    for (let attempt = 0; ; attempt++) {
      const state3 = await readMessengerAccount(load, account2);
      if (applied(state3, change)) return state3;
      if (attempt === 3) throw new Error("Messenger didn't apply the change.");
      await new Promise((resolve) => setTimeout(resolve, 1e3));
    }
  }
  function applied(state3, change) {
    switch (change.setting) {
      case "activeStatus":
        return state3.activeStatus === change.value;
      case "sounds":
        return state3.sounds === change.value;
      case "doNotDisturb": {
        if (change.value <= 0) return state3.dndUntil === change.value;
        const expected = dndUntilFor(change.value, Date.now());
        return state3.dndUntil !== null && Math.abs(state3.dndUntil - expected) <= 120;
      }
    }
  }
  async function setDoNotDisturb(load, account2, minutes) {
    const [i64, serverTime, database2, factory, writer, update] = await loadFacebookModules(load, [
      "I64",
      "ServerTime",
      "LSDatabaseSingleton",
      "LSFactory",
      "MessengerNotificationsWriter",
      "LSOptimisticallyUpdateGlobalMuteUntilStoredProcedure"
    ]);
    const seconds = dndUntilFor(minutes, serverTime.getMillis());
    const until = seconds === 0 ? i64.zero : seconds < 0 ? i64.neg_one : i64.of_float(seconds);
    const db = await database2.LSDatabaseSingleton;
    const makeFactory = defaultExport(factory);
    const run = defaultExport(update);
    await db.runInTransaction((tx) => run(makeFactory(tx), { globalMuteUntil: until }), "readwrite");
    writer.updateMute(account2, seconds === 0 ? 0 : i64.to_float(until));
  }
  async function setActiveStatus(load, on2) {
    const [environment, relay, mutation, report, database2, gkx, qex] = await loadFacebookModules(
      load,
      [
        "CometRelayEnvironment",
        "CometRelay",
        "UpdatePresenceSettingsMutation.graphql",
        "MWPReportActiveSetting",
        "LSDatabaseSingleton",
        "gkx",
        "qex"
      ]
    );
    const messenger = defaultExport(gkx)("23433");
    const experiments = defaultExport(qex);
    const withPlatform = experiments._(messenger ? "998" : "5461") !== false;
    const input = on2 ? { online_policy: "BLOCKLIST", web_allowlist: null, web_blocklist: null, web_visibility: true } : { online_policy: "ALLOWLIST", web_allowlist: [], web_visibility: false };
    if (withPlatform) input.platform = messenger ? "MESSENGER" : "FACEBOOK";
    const saved = new Promise(
      (resolve, reject) => (
        // CometRelay's commit adds the actor and mutation ids Facebook requires.
        relay.commitMutation(
          defaultExport(environment),
          {
            mutation,
            variables: { input },
            onCompleted: (_response, errors) => errors?.length ? reject(new Error(errors[0]?.message || "Facebook refused the change.")) : resolve(),
            onError: reject
          }
        )
      )
    );
    const reported = withPlatform ? Promise.resolve() : new Promise(
      (resolve, reject) => report.reportActiveSetting(
        database2.LSDatabaseSingleton,
        on2,
        resolve,
        reject
      )
    );
    await Promise.all([saved, reported]);
  }

  // inject/src/messenger/features/account-requests.ts
  function initAccountRequests() {
    if (!window.__TAURI_INTERNALS__) return;
    const signedIn = () => {
      const account2 = accountId(document.cookie);
      if (!account2) throw new Error("Log in to Messenger first.");
      return account2;
    };
    const actions = {
      // Log Out (Ref #356): Facebook's own logout, so the session ends there too.
      "log-out": () => logOutOfFacebook({
        load: pageRequire(),
        cookie: () => document.cookie,
        post: (url, body) => fetch(url, { method: "POST", body, credentials: "include" })
      }).then(() => null),
      read: () => readMessengerAccount(pageRequire(), signedIn()),
      "set-active-status": (value) => changeMessengerAccount(pageRequire(), signedIn(), {
        setting: "activeStatus",
        value: value === true
      }),
      "set-sounds": (value) => changeMessengerAccount(pageRequire(), signedIn(), {
        setting: "sounds",
        value: value === true
      }),
      "set-dnd": async (value) => {
        const state3 = await changeMessengerAccount(pageRequire(), signedIn(), {
          setting: "doNotDisturb",
          value: Number(value)
        });
        setMessengerDndUntil(state3.dndUntil);
        return state3;
      }
    };
    const reply = (request, payload) => invoke("plugin:event|emit", {
      event: "carrier:account-result",
      payload: { request, ...payload }
    });
    window.__carrierAccount = (request, action2, value) => {
      const run = actions[action2];
      (run ? Promise.resolve().then(() => run(value)) : Promise.reject(new Error("Unknown request"))).then((state3) => reply(request, { ok: true, state: state3 })).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        diag(`account.${action2}`, message.slice(0, 200));
        return reply(request, { ok: false, error: message });
      });
    };
  }

  // inject/src/messenger/lib/auto-refresh.ts
  function nativeRealtimeStatus(status, transportConfirmed, silentRecoveryFailed, workerMutationPending) {
    if (status === "ok" && !transportConfirmed) return "pending";
    if ((status === "stale" || status === "never") && (!silentRecoveryFailed || workerMutationPending))
      return "managed";
    return status;
  }
  var PowerStateTracker = class {
    constructor(documentCreatedAt) {
      __publicField(this, "documentCreatedAt", documentCreatedAt);
      __publicField(this, "previous");
    }
    update(snapshot) {
      const previous = this.previous;
      this.previous = snapshot;
      return !snapshot.sleeping && (previous ? previous.sleeping || previous.resume_generation !== snapshot.resume_generation : (snapshot.last_resume_at_ms ?? 0) > this.documentCreatedAt);
    }
  };
  var canReplacePendingRefresh = (pending, next) => {
    if (pending === "rate-limit-manual") return false;
    return next === "rate-limit-manual" || pending !== "manual" || next === "manual";
  };

  // inject/src/messenger/lib/facebook-error-dialog.ts
  var RELOAD_ERROR_CODE = 1357004;
  function isReloadException(dialog) {
    try {
      const facebookRequire = window.require;
      const component = facebookRequire?.("FDSCometExceptionDialogImpl.react");
      if (typeof component !== "function") return false;
      const reactDOM = facebookRequire?.("ReactDOM");
      const events = reactDOM?.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.Events;
      if (!Array.isArray(events) || typeof events[0] !== "function") return false;
      let fiber = events[0](dialog);
      if (!fiber || typeof fiber !== "object" || !("stateNode" in fiber) || fiber.stateNode !== dialog) {
        return false;
      }
      for (let depth = 0; fiber && typeof fiber === "object" && depth < 80; depth++) {
        const node = fiber;
        if (node.type === component) {
          const props = node.memoizedProps;
          return !!props && typeof props === "object" && "errorCode" in props && props.errorCode === RELOAD_ERROR_CODE;
        }
        fiber = node.return;
      }
    } catch (_) {
    }
    return false;
  }
  function hasFacebookReloadDialog() {
    for (const dialog of document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"]'
    )) {
      const rect = dialog.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
        continue;
      }
      let hidden = false;
      let left = Math.max(rect.left, 0);
      let right = Math.min(rect.right, innerWidth);
      let top = Math.max(rect.top, 0);
      let bottom = Math.min(rect.bottom, innerHeight);
      const position = getComputedStyle(dialog).position;
      let containingBlock;
      if (position === "absolute") {
        containingBlock = dialog.offsetParent;
      } else if (position === "fixed") {
        containingBlock = null;
        for (let ancestor = dialog.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.transform !== "none" || style.perspective !== "none" || style.filter !== "none" || !!style.backdropFilter && style.backdropFilter !== "none" || /\b(transform|perspective|filter|backdrop-filter)\b/.test(style.willChange) || /\b(layout|paint|strict|content)\b/.test(style.contain)) {
            containingBlock = ancestor;
            break;
          }
        }
      }
      let clipsPositionedDialog = containingBlock === void 0;
      for (let el = dialog; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (el.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || Number(style.opacity) === 0) {
          hidden = true;
          break;
        }
        if (el === containingBlock) clipsPositionedDialog = true;
        if (el !== dialog && clipsPositionedDialog) {
          const bounds = el.getBoundingClientRect();
          if (style.overflowX !== "visible") {
            left = Math.max(left, bounds.left);
            right = Math.min(right, bounds.right);
          }
          if (style.overflowY !== "visible") {
            top = Math.max(top, bounds.top);
            bottom = Math.min(bottom, bounds.bottom);
          }
          if (left >= right || top >= bottom) {
            hidden = true;
            break;
          }
        }
      }
      if (!hidden && isReloadException(dialog)) return true;
    }
    return false;
  }

  // inject/src/messenger/lib/realtime-health.ts
  var REALTIME_CONNECT_GRACE_MS = 15e3;
  var REALTIME_SILENCE_MS = 9e4;
  var REALTIME_NEVER_CONNECTED_MS = 9e4;
  var REALTIME_CORROBORATION_MS = 3e4;
  var REALTIME_UNOBSERVED_MS = 6e4;
  var REALTIME_UNOBSERVED_SETTLE_MS = 15e3;
  function looksLikeFacebookErrorPage(doc) {
    return doc.hasBackLink && doc.hasIconImage && doc.elementCount < 100;
  }
  var elapsed = (now, since) => Math.max(0, now - since);
  var ConsecutiveFailureThreshold = class {
    constructor(limit) {
      __publicField(this, "limit", limit);
      __publicField(this, "failures", 0);
    }
    succeeded() {
      this.failures = 0;
    }
    failed() {
      this.failures += 1;
      return this.failures >= this.limit;
    }
  };
  var WorkerConnectionWatchdog = class {
    constructor(previouslyConnected = false) {
      __publicField(this, "previouslyConnected", previouslyConnected);
      __publicField(this, "everConnected", false);
      __publicField(this, "disconnectedAt", null);
    }
    observe(connected, now, backendReady = false) {
      if (connected === true) {
        this.everConnected = true;
        this.disconnectedAt = null;
        return false;
      }
      const grace = this.everConnected ? REALTIME_CONNECT_GRACE_MS : REALTIME_NEVER_CONNECTED_MS;
      if (connected === void 0) {
        if (this.disconnectedAt === null) return false;
        this.disconnectedAt = Math.min(this.disconnectedAt, now);
        return elapsed(now, this.disconnectedAt) >= grace;
      }
      if (!this.everConnected && !this.previouslyConnected && !backendReady) {
        this.disconnectedAt = null;
        return false;
      }
      this.disconnectedAt = Math.min(this.disconnectedAt ?? now, now);
      return elapsed(now, this.disconnectedAt) >= grace;
    }
  };
  var RealtimeRecoveryTracker = class {
    constructor(startedAt) {
      __publicField(this, "startedAt", startedAt);
      __publicField(this, "staleSources", /* @__PURE__ */ new Set());
      __publicField(this, "lastHealthyAt", /* @__PURE__ */ new Map());
      __publicField(this, "everHealthy", false);
    }
    healthy(source, at = Date.now()) {
      this.everHealthy = true;
      this.lastHealthyAt.set(source, at);
      this.staleSources.delete(source);
    }
    stale(source) {
      this.staleSources.add(source);
    }
    /**
     * Withdraw a source's verdict without claiming health — it can no longer
     * observe the transport at all (e.g. the page owns no realtime socket). An
     * unobservable source must not keep asserting the staleness it reported
     * while it could still see something.
     */
    withdraw(source) {
      this.staleSources.delete(source);
    }
    /**
     * A healthy encrypted worker can replace page-owned sockets. Page MQTT
     * cannot replace the encrypted worker or vouch for its failed bridge.
     */
    needsRecovery(now = Date.now()) {
      if (this.staleSources.has("worker-connection") || this.staleSources.has("worker")) return true;
      for (const [source, at] of this.lastHealthyAt) {
        if (at > now) this.lastHealthyAt.set(source, now);
      }
      if (this.staleSources.size === 0) return this.unobserved(now);
      for (const [source, at] of this.lastHealthyAt) {
        if (this.staleSources.has(source)) continue;
        if (elapsed(now, at) <= REALTIME_CORROBORATION_MS) return false;
      }
      return true;
    }
    /**
     * A transport that was healthy but that no source has been able to confirm
     * for [[REALTIME_UNOBSERVED_MS]]. Not knowing is not the same as being fine,
     * so this still warrants recovery. A page that never connected at all is
     * excluded — [[status]] already reports that as "never".
     *
     * Callers must rebase future-dated reports first (see [[needsRecovery]]).
     */
    unobserved(now) {
      if (!this.everHealthy) return false;
      let lastConfirmedAt = null;
      for (const at of this.lastHealthyAt.values()) {
        if (lastConfirmedAt === null || at > lastConfirmedAt) lastConfirmedAt = at;
      }
      if (lastConfirmedAt === null) return false;
      return elapsed(now, lastConfirmedAt) >= REALTIME_UNOBSERVED_MS;
    }
    // "pending" (fresh page, transport still unproven) deliberately differs from
    // "ok": the native side pauses its bad-transport timer on both, but only a
    // proven-healthy "ok" resets its escalation counters.
    status(now) {
      if (this.needsRecovery(now)) return "stale";
      if (this.everHealthy) return "ok";
      return elapsed(now, this.startedAt) >= REALTIME_NEVER_CONNECTED_MS ? "never" : "pending";
    }
  };
  function isMessengerRealtimeUrl(raw, base) {
    let url;
    try {
      url = new URL(raw, base);
    } catch (_) {
      return false;
    }
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return false;
    const host = url.hostname.toLowerCase();
    return host === "edge-chat.facebook.com" || host.endsWith(".edge-chat.facebook.com") || host === "gateway.facebook.com" || host.endsWith(".gateway.facebook.com") || host === "gateway.messenger.com";
  }
  var RealtimeHealthWatchdog = class {
    constructor() {
      __publicField(this, "sockets", /* @__PURE__ */ new Map());
      __publicField(this, "everOpened", false);
      __publicField(this, "recoveryStartedAt", null);
    }
    created(socket, now) {
      if (this.everOpened && !this.hasOpenSocket()) this.recoveryStartedAt ?? (this.recoveryStartedAt = now);
      this.sockets.set(socket, { state: "connecting", since: now, lastInboundAt: now });
    }
    opened(socket, now) {
      if (!this.sockets.has(socket)) return;
      this.everOpened = true;
      this.recoveryStartedAt = null;
      this.sockets.set(socket, { state: "open", since: now, lastInboundAt: now });
    }
    received(socket, now) {
      const state3 = this.sockets.get(socket);
      if (state3?.state !== "open") return;
      state3.lastInboundAt = now;
    }
    closed(socket, now) {
      this.sockets.delete(socket);
      if (this.everOpened && !this.hasOpenSocket()) this.recoveryStartedAt ?? (this.recoveryStartedAt = now);
    }
    hasOpenSocket() {
      return [...this.sockets.values()].some((state3) => state3.state === "open");
    }
    health(now) {
      const states = [...this.sockets.values()];
      const open = states.filter((state3) => state3.state === "open");
      if (open.length) {
        const freshestInbound = Math.max(...open.map((state3) => state3.lastInboundAt));
        return elapsed(now, freshestInbound) >= REALTIME_SILENCE_MS ? "stale" : "healthy";
      }
      const connecting = states.filter((state3) => state3.state === "connecting");
      if (!this.everOpened) return "starting";
      if (this.recoveryStartedAt !== null && elapsed(now, this.recoveryStartedAt) < REALTIME_CONNECT_GRACE_MS) {
        return "recovering";
      }
      if (connecting.length) return "stale";
      this.recoveryStartedAt = null;
      return "starting";
    }
  };

  // inject/src/messenger/lib/render-health.ts
  var FRAME_TIMEOUT_MS = 15e3;
  var RenderHealthProbe = class {
    constructor(requestFrame, cancelFrame, now) {
      __publicField(this, "requestFrame", requestFrame);
      __publicField(this, "cancelFrame", cancelFrame);
      __publicField(this, "now", now);
      __publicField(this, "request");
      __publicField(this, "lastSample");
      __publicField(this, "hasFrame", false);
    }
    reset() {
      if (this.request) this.cancelFrame(this.request.handle);
      this.request = void 0;
      this.lastSample = void 0;
      this.hasFrame = false;
    }
    sample(visible) {
      const now = this.now();
      if (!visible || this.lastSample !== void 0 && now - this.lastSample > FRAME_TIMEOUT_MS) {
        this.reset();
      }
      if (!visible) return { state: "pending", wait_ms: 0 };
      this.lastSample = now;
      if (!this.request) {
        const request = {
          since: now,
          handle: this.requestFrame(() => {
            if (this.request !== request) return;
            this.request = void 0;
            this.hasFrame = true;
          })
        };
        this.request = request;
      }
      const wait_ms = Math.max(0, Math.round(now - this.request.since));
      return {
        state: wait_ms >= FRAME_TIMEOUT_MS ? "stalled" : this.hasFrame ? "ok" : "pending",
        wait_ms
      };
    }
  };

  // inject/src/messenger/features/conversation-actions.ts
  function isShown(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function firstShown(sel, root) {
    for (const el of (root || document).querySelectorAll(sel)) if (isShown(el)) return el;
    return null;
  }
  function buttonByLabel(needles, root) {
    for (const el of (root || document).querySelectorAll(
      '[role="button"][aria-label], button[aria-label]'
    )) {
      if (!isShown(el)) continue;
      const label2 = (el.getAttribute("aria-label") || "").toLowerCase();
      if (needles.some((n) => label2.includes(n))) return el;
    }
    return null;
  }
  function chatRows() {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const a of document.querySelectorAll(
      '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]'
    )) {
      const href = a.getAttribute("href");
      if (!href || seen.has(href)) continue;
      const r = a.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      seen.add(href);
      out.push(a);
    }
    return out;
  }
  function stepConversation(delta) {
    const rows = chatRows();
    if (!rows.length) return;
    const m = location.pathname.match(/\/t\/([^/]+)/);
    const idx = m ? rows.findIndex((a) => (a.getAttribute("href") || "").includes(`/t/${m[1]}`)) : -1;
    const nextIdx = idx === -1 ? delta > 0 ? 0 : rows.length - 1 : (idx + delta + rows.length) % rows.length;
    rows[nextIdx]?.click();
  }
  function focusChatSearch() {
    const input = firstShown('[role="navigation"] input[type="search"]') || firstShown('input[type="search"]');
    if (input) {
      input.focus();
      input.select();
    }
    return !!input;
  }
  function focusComposer() {
    const box = firstShown('[role="main"] [contenteditable="true"][role="textbox"]') || firstShown('[contenteditable="true"][data-lexical-editor="true"]');
    box?.focus();
    return !!box;
  }
  function searchInConvoButton() {
    const root = document.querySelector('[role="main"]');
    if (!root) return null;
    for (const el of root.querySelectorAll('[role="button"][aria-label]')) {
      if (!isShown(el)) continue;
      const label2 = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      if (label2 === "search" || label2 === "search in conversation") return el;
    }
    return null;
  }
  function searchInConversation() {
    window.__carrierWakeSearchIndex?.();
    const btn = searchInConvoButton();
    if (btn) {
      btn.click();
      return true;
    }
    if (typeof window.__carrierToggleInfo !== "function" || !window.__carrierToggleInfo())
      return false;
    let tries = 0;
    const timer = setInterval(() => {
      const b = searchInConvoButton();
      if (b) {
        clearInterval(timer);
        b.click();
      } else if (++tries >= 40) {
        clearInterval(timer);
      }
    }, 50);
    return true;
  }
  function clickComposerButton(needles) {
    const root = document.querySelector('[role="main"]');
    const btn = root && buttonByLabel(needles, root);
    btn?.click();
    return !!btn;
  }
  var openEmojiPicker = () => clickComposerButton(["choose an emoji"]);
  var openGifPicker = () => clickComposerButton(["choose a gif"]);
  var attachFiles = () => clickComposerButton(["attach a photo or video", "attach a file"]);
  function newConversation() {
    const link = firstShown('a[href*="/messages/new"]');
    if (link) {
      link.click();
      return true;
    }
    const btn = buttonByLabel(["new message"]);
    if (btn) {
      btn.click();
      return true;
    }
    location.assign("/messages/new/");
    return true;
  }

  // inject/src/messenger/lib/scheduled-composer.ts
  var COMPOSER_SELECTOR = '[role="main"] [contenteditable="true"][role="textbox"]';
  var findComposer = () => firstShown(COMPOSER_SELECTOR);
  var composerText = (box) => box.innerText.replace(/\r\n/g, "\n");
  function composerRegion(box) {
    return box.closest('[role="region"], form');
  }
  function hasComposerMedia(box) {
    const region = composerRegion(box);
    if (!region) return true;
    if (box.querySelector('img, video, [contenteditable="false"]')) return true;
    for (const input of region.querySelectorAll('input[type="file"]')) {
      if (input.files?.length) return true;
    }
    for (const media of region.querySelectorAll('img, video, [role="progressbar"]')) {
      if (!isShown(media)) continue;
      const control2 = media.closest('button, [role="button"]');
      const bounds = control2?.getBoundingClientRect();
      if (media.tagName === "IMG" && control2 && bounds && bounds.width <= 48 && bounds.height <= 48 && !control2.closest('[contenteditable="true"]'))
        continue;
      return true;
    }
    return !!buttonByLabel(
      ["remove attachment", "remove photo", "remove video", "remove file"],
      region
    );
  }
  function hasComposerDraft() {
    for (const box of document.querySelectorAll('[contenteditable="true"]')) {
      if ((box.textContent || "").trim()) return true;
      if (box.matches(COMPOSER_SELECTOR) && hasComposerMedia(box)) return true;
    }
    return false;
  }
  function composerControls(box) {
    const region = composerRegion(box);
    const controls = /* @__PURE__ */ new Map();
    if (!region) return controls;
    for (const button of region.querySelectorAll('button, [role="button"]')) {
      if (button.hasAttribute("data-carrier-schedule")) continue;
      controls.set(button, `${button.getAttribute("aria-label") ?? ""}
${button.innerHTML}`);
    }
    return controls;
  }
  function findSendButton(box, before) {
    const region = composerRegion(box);
    if (!region) return null;
    const changed = [];
    for (const button of region.querySelectorAll('button, [role="button"]')) {
      if (button.hasAttribute("data-carrier-schedule") || !(box.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) || !isShown(button) || button.getAttribute("aria-disabled") === "true" || button.matches(":disabled"))
        continue;
      if (before.get(button) !== `${button.getAttribute("aria-label") ?? ""}
${button.innerHTML}`)
        changed.push(button);
    }
    return changed.length === 1 ? changed[0] ?? null : null;
  }
  function replaceComposerText(box, text) {
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return document.execCommand(text ? "insertText" : "delete", false, text);
  }

  // inject/src/messenger/lib/scheduled-send.ts
  var SEND_GRACE_MS = 12e4;
  var MAX_SCHEDULED_CHARS = 2e3;
  function sendWindow(due, now) {
    if (now < due) return "early";
    return now <= due + SEND_GRACE_MS ? "due" : "missed";
  }
  function nextDueMessage(items, now) {
    return items.filter((item) => item.status === "scheduled" && sendWindow(item.due, now) === "due").sort((a, b) => a.due - b.due)[0];
  }
  function schedulePresets(now) {
    const evening = new Date(now);
    evening.setHours(18, 0, 0, 0);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return [
      { label: "In 15 minutes", due: now + 15 * 6e4 },
      { label: "In 1 hour", due: now + 60 * 6e4 },
      ...evening.getTime() > now ? [{ label: "This evening", due: evening.getTime() }] : [],
      { label: "Tomorrow morning", due: tomorrow.getTime() }
    ];
  }
  function localScheduleTime(date, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
    const value = /* @__PURE__ */ new Date(`${date}T${time}:00`);
    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    if (value.getFullYear() !== year || value.getMonth() + 1 !== month || value.getDate() !== day || value.getHours() !== hour || value.getMinutes() !== minute)
      return null;
    return value.getTime();
  }
  function localDateValue(time) {
    const date = new Date(time);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  var formatScheduleTime = (time, includeDate = false) => new Intl.DateTimeFormat(void 0, {
    ...includeDate ? { month: "short", day: "numeric" } : {},
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(time);
  var composerBusy = false;
  var composerWaiters = [];
  var isComposerDeliveryActive = () => composerBusy;
  var setComposerBusy = (busy) => {
    composerBusy = busy;
    if (typeof window !== "undefined") window.dispatchEvent(new Event("carrier:protection-change"));
  };
  async function runComposerDelivery(run) {
    try {
      return await run();
    } finally {
      const next = composerWaiters.shift();
      if (next) next();
      else setComposerBusy(false);
    }
  }
  function withComposerDelivery(run) {
    if (composerBusy) return Promise.resolve(void 0);
    setComposerBusy(true);
    return runComposerDelivery(run);
  }
  async function withComposerDeliveryWhenAvailable(run) {
    if (composerBusy) await new Promise((resolve) => composerWaiters.push(resolve));
    else setComposerBusy(true);
    return runComposerDelivery(run);
  }

  // inject/src/messenger/lib/worker-recovery.ts
  function record(value) {
    return value !== null && typeof value === "object" ? value : void 0;
  }
  function method(value, key) {
    const candidate = record(value)?.[key];
    return typeof candidate === "function" ? candidate : void 0;
  }
  var INSPECTION_TIMEOUT_MS = 8e3;
  var nativeSetTimeout = setTimeout.bind(globalThis);
  var nativeClearTimeout = clearTimeout.bind(globalThis);
  var nativeNow = performance.now.bind(performance);
  var InspectionTimeout = class extends Error {
  };
  async function inspect(read) {
    const startedAt = nativeNow();
    let timer;
    try {
      const result = await Promise.race([
        read(),
        new Promise((_, reject) => {
          timer = nativeSetTimeout(() => reject(new InspectionTimeout()), INSPECTION_TIMEOUT_MS);
        })
      ]);
      if (nativeNow() - startedAt >= INSPECTION_TIMEOUT_MS) throw new InspectionTimeout();
      return result;
    } finally {
      nativeClearTimeout(timer);
    }
  }
  function hasSoleMessengerWindow(value) {
    if (!Array.isArray(value) || value.some((label2) => typeof label2 !== "string")) return false;
    const messenger = value.filter((label2) => label2 === "main" || /^win-\d+$/.test(label2));
    return messenger.length === 1 && value.every((label2) => label2 === "settings" || messenger.includes(label2));
  }
  var FacebookWorkerRecovery = class {
    constructor(load, accountScope, canRestartSharedWorker = async () => false) {
      __publicField(this, "load", load);
      __publicField(this, "accountScope", accountScope);
      __publicField(this, "canRestartSharedWorker", canRestartSharedWorker);
      __publicField(this, "replay");
      __publicField(this, "scope");
      __publicField(this, "setupStartedAt");
      __publicField(this, "recovering", false);
      __publicField(this, "wrapped", /* @__PURE__ */ new WeakSet());
      __publicField(this, "sharedBridgeRepair");
      __publicField(this, "lifecycleRestartUsedScope");
      __publicField(this, "lifecycle");
      __publicField(this, "pausedDedicatedSetup");
      __publicField(this, "currentPhase", "idle");
      __publicField(this, "lastPhase", "idle");
      /** Carrier's own replayed setup, which can stay pending indefinitely. */
      __publicField(this, "ownSetup");
    }
    get phase() {
      return this.currentPhase;
    }
    /** The last phase the previous recovery attempt reached. */
    get previousPhase() {
      return this.lastPhase;
    }
    /**
     * Replay setup without holding the recovery guard across it: a hung setup
     * must still be rescuable by the guarded stalled-setup restarts. While it is
     * pending, `ownSetup` keeps every other path from starting a competing one.
     */
    startSetup(replay, reject) {
      const token = {};
      this.ownSetup = token;
      this.setupStartedAt = nativeNow();
      this.currentPhase = "setup";
      void (async () => replay())().catch((error) => {
        if (this.ownSetup === token) reject(error);
      }).finally(() => {
        if (this.ownSetup === token) this.ownSetup = void 0;
      });
      return "started";
    }
    observeLifecycleExports(value) {
      const exports = record(value);
      const register = method(exports, "setOnCloseForWorkerInstance");
      if (!exports || !register || this.wrapped.has(register)) return;
      const owner = this;
      const wrapped3 = new Proxy(register, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          try {
            const callback = args[0];
            owner.pausedDedicatedSetup = void 0;
            owner.lifecycle = result === void 0 && args.length === 1 && typeof callback === "function" && callback.length === 3 ? { callback, scope: owner.accountScope() } : void 0;
            owner.setupStartedAt = nativeNow();
          } catch (_) {
            owner.lifecycle = void 0;
          }
          return result;
        }
      });
      try {
        exports.setOnCloseForWorkerInstance = wrapped3;
        this.wrapped.add(wrapped3);
      } catch (_) {
      }
    }
    observeSetupExports(value) {
      const exports = record(value);
      const setup = method(exports, "getOrSetupWorker");
      if (!exports || !setup || this.wrapped.has(setup)) return;
      const owner = this;
      const wrapped3 = new Proxy(setup, {
        apply(target, receiver, args) {
          owner.replay = void 0;
          owner.scope = void 0;
          owner.setupStartedAt = void 0;
          owner.pausedDedicatedSetup = void 0;
          owner.ownSetup = void 0;
          if (record(args[0]) && [1, 2, 3, 5].every((index) => typeof args[index] === "function") && typeof args[4] === "string") {
            try {
              const retryArgs = [...args];
              retryArgs[4] = "bridgeRecovery";
              owner.scope = owner.accountScope();
              owner.setupStartedAt = nativeNow();
              owner.replay = () => Reflect.apply(target, receiver, retryArgs);
            } catch (_) {
              owner.scope = void 0;
              owner.setupStartedAt = void 0;
              owner.replay = void 0;
            }
          }
          return Reflect.apply(target, receiver, args);
        }
      });
      try {
        exports.getOrSetupWorker = wrapped3;
        this.wrapped.add(wrapped3);
      } catch (_) {
      }
    }
    /** A sustained verified connection starts a fresh escalation episode. */
    clearEscalation() {
      this.sharedBridgeRepair = void 0;
      this.lifecycleRestartUsedScope = void 0;
    }
    async recover(allowed = () => true, escalate = false) {
      if (this.recovering) return "busy";
      this.recovering = true;
      try {
        if (!allowed()) return "busy";
        let startingScope;
        try {
          startingScope = this.accountScope();
        } catch (_) {
          return "unsupported";
        }
        if (!startingScope) return "unsupported";
        if (this.sharedBridgeRepair?.scope !== startingScope) this.sharedBridgeRepair = void 0;
        if (this.lifecycleRestartUsedScope !== startingScope)
          this.lifecycleRestartUsedScope = void 0;
        const state3 = this.load("MAWWaitForBackendSetup");
        const settled = method(state3, "isBackendSetupSettled");
        const inProgress = method(state3, "isBackendSetupInProgress");
        const currentId = method(state3, "getCurrentWorkerID");
        const reset = method(state3, "resetBackendSetup");
        const reject = method(state3, "rejectBackendSetup");
        const successful = method(state3, "isBackendSetupSuccessful");
        const singleton = this.load("MAWWebWorkerSingleton");
        const health = method(singleton, "getWorkerHealthStatus");
        if (!settled || !inProgress || !currentId || !reset || !reject || !health) {
          return "unsupported";
        }
        const pendingSetup = inProgress.call(state3) === true || settled.call(state3) !== true;
        const paused = this.pausedDedicatedSetup;
        const canResumeDedicated = () => {
          if (!paused || this.pausedDedicatedSetup !== paused) return false;
          const setup2 = this.load("MAWSetupWorker");
          return paused.scope === startingScope && this.scope === startingScope && paused.replay === this.replay && paused.state === state3 && paused.setup === setup2 && currentId.call(state3) === "dedicated" && inProgress.call(state3) === false && settled.call(state3) === false && method(setup2, "waitForWorkerSetup")?.call(setup2) === null;
        };
        const resumingDedicated = canResumeDedicated();
        if (pendingSetup && !resumingDedicated && !escalate) return "busy";
        const currentConnectionState = () => record(this.load("WACommsConnectionState"))?.WACommsConnectionState;
        const connectionState = pendingSetup && !resumingDedicated ? currentConnectionState() : void 0;
        const connected = method(connectionState, "isConnected");
        const stillPendingAndDisconnected = () => inProgress.call(state3) === true && settled.call(state3) === false && currentConnectionState() === connectionState && connected?.call(connectionState) === false;
        const stalledSetup = pendingSetup && !resumingDedicated && escalate && !!this.replay && this.scope === startingScope && this.setupStartedAt !== void 0 && nativeNow() - this.setupStartedAt >= REALTIME_NEVER_CONNECTED_MS && stillPendingAndDisconnected();
        if (pendingSetup && !resumingDedicated && !stalledSetup) return "busy";
        if (this.ownSetup && !stalledSetup) return "busy";
        const initialId = currentId.call(state3);
        if (stalledSetup && (typeof initialId !== "string" || initialId.length === 0)) {
          return "busy";
        }
        const setup = initialId ? this.load("MAWSetupWorker") : void 0;
        const bridge = method(setup, "waitForWorkerSetup");
        const initialBridge = bridge?.call(setup);
        const replay = this.replay;
        const replayScope = this.scope;
        this.currentPhase = "worker-status";
        const status = record(await inspect(() => health.call(singleton)));
        if (!allowed() || startingScope !== this.accountScope() || this.replay !== replay || this.scope !== replayScope) {
          return "busy";
        }
        if (!status || ![
          "dedicated_not_exists",
          "dedicated_exists",
          "shared_not_exists",
          "shared_exists_not_connected",
          "shared_exists_and_connected"
        ].includes(String(status.tag))) {
          return "unsupported";
        }
        if (resumingDedicated && paused) {
          if (status.tag !== "dedicated_not_exists" || !canResumeDedicated()) return "busy";
          this.pausedDedicatedSetup = void 0;
          return this.startSetup(paused.replay, (error) => reject.call(state3, error));
        }
        if (stalledSetup) {
          if (!["shared_exists_and_connected", "dedicated_exists"].includes(String(status.tag)) || !stillPendingAndDisconnected()) {
            return "busy";
          }
        } else if (inProgress.call(state3) === true || settled.call(state3) !== true) return "busy";
        const id = currentId.call(state3);
        if (status.tag === "dedicated_exists") {
          const setupSuccessful = successful?.call(state3);
          if (typeof setupSuccessful !== "boolean") return "unsupported";
          if (!stalledSetup && id === "dedicated" && setupSuccessful) {
            return "reload";
          }
          if (id !== "dedicated" || initialId !== id || !initialBridge || typeof record(initialBridge)?.then !== "function" || bridge?.call(setup) !== initialBridge || !replay || replayScope !== startingScope) {
            return "unsupported";
          }
          if (stalledSetup) {
            const lifecycle = this.lifecycle;
            if (!lifecycle || lifecycle.scope !== startingScope || this.lifecycleRestartUsedScope === startingScope)
              return "busy";
            this.currentPhase = "bridge-readiness";
            const readyBridge = await inspect(() => initialBridge);
            if (!method(readyBridge, "close")) return "unsupported";
            if (!allowed() || startingScope !== this.accountScope() || this.lifecycle !== lifecycle || this.replay !== replay || this.scope !== replayScope || currentId.call(state3) !== id || bridge?.call(setup) !== initialBridge || !stillPendingAndDisconnected())
              return "busy";
            this.lifecycleRestartUsedScope = startingScope;
            this.ownSetup = void 0;
            this.currentPhase = "dedicated-termination";
            Reflect.apply(lifecycle.callback, void 0, [
              "carrier-sync-recovery",
              id,
              "carrier_recovery"
            ]);
            return "started";
          }
          const terminate = method(setup, "terminateDedicatedWorker");
          if (!terminate) return "unsupported";
          this.currentPhase = "dedicated-termination";
          const stopped = await terminate.call(setup, "bridgeRecovery");
          if (stopped !== true) return "unsupported";
          if (startingScope !== this.accountScope() || this.replay !== replay || this.scope !== replayScope) {
            return "busy";
          }
          if (bridge?.call(setup) != null || inProgress.call(state3) === true || settled.call(state3) === true) {
            return "busy";
          }
          if (!allowed()) {
            this.pausedDedicatedSetup = { scope: startingScope, replay, state: state3, setup };
            return "busy";
          }
          return this.startSetup(replay, (error) => reject.call(state3, error));
        }
        if (typeof id === "string" && id.length > 0) {
          if (status.tag === "dedicated_not_exists") return "unsupported";
          if (escalate && status.tag === "shared_exists_and_connected" && initialId === id && (stalledSetup || this.sharedBridgeRepair?.scope === startingScope && this.sharedBridgeRepair.id === id) && this.lifecycleRestartUsedScope !== startingScope && replay && replayScope === startingScope && initialBridge && typeof record(initialBridge)?.then === "function" && bridge?.call(setup) === initialBridge) {
            if (stalledSetup) {
              this.currentPhase = "bridge-readiness";
              const readyBridge = await inspect(() => initialBridge);
              if (!method(readyBridge, "close")) return "unsupported";
            }
            let soleWindow = false;
            try {
              this.currentPhase = "window-inventory";
              soleWindow = await inspect(() => this.canRestartSharedWorker()) === true;
            } catch (error) {
              if (error instanceof InspectionTimeout) throw error;
            }
            if (!allowed() || startingScope !== this.accountScope() || currentId.call(state3) !== id || this.replay !== replay || this.scope !== replayScope || bridge?.call(setup) !== initialBridge || (stalledSetup ? !stillPendingAndDisconnected() : inProgress.call(state3) === true || settled.call(state3) !== true)) {
              return "busy";
            }
            if (soleWindow) {
              const shutdown = method(setup, "killSharedWorker");
              if (!shutdown) return "unsupported";
              this.lifecycleRestartUsedScope = startingScope;
              this.ownSetup = void 0;
              this.currentPhase = "shared-shutdown";
              await shutdown.call(setup, false, "carrier-sync-recovery");
              return "started";
            }
          }
          if (stalledSetup) return "busy";
          const recovery = this.load("MAWWorkerWatchdogRecovery");
          const callback = method(recovery, "getWorkerRecoveryForWatchdog")?.call(recovery);
          if (typeof callback !== "function") return "unsupported";
          this.currentPhase = "bridge-repair";
          Reflect.apply(callback, void 0, ["locks_based_recovery", id, "locks_based_recovery"]);
          this.sharedBridgeRepair = { scope: startingScope, id };
          return "started";
        }
        if (id != null || !["shared_not_exists", "dedicated_not_exists"].includes(String(status.tag)) || !replay || !replayScope || replayScope !== this.accountScope()) {
          return "unsupported";
        }
        try {
          reset.call(state3);
          if (this.replay !== replay || this.scope !== replayScope || inProgress.call(state3) === true || currentId.call(state3) != null) {
            return "busy";
          }
        } catch (error) {
          reject.call(state3, error);
          return "failed";
        }
        return this.startSetup(replay, (error) => reject.call(state3, error));
      } catch (error) {
        if (error instanceof InspectionTimeout) return "inspection-timeout";
        return "failed";
      } finally {
        this.lastPhase = this.currentPhase;
        this.currentPhase = "idle";
        this.recovering = false;
      }
    }
  };
  var SILENT_RECOVERY_EVENT = "carrier:sync-recovery";
  var SILENT_RECOVERY_RETRY_EVENT = "carrier:sync-recovery-retry";
  var SILENT_RECOVERY_RELOAD_EVENT = "carrier:sync-recovery-reload";
  var SILENT_RECOVERY_TIMEOUT_MS = 3e4;
  var RETRY_DELAYS_MS = [0, 15e3, 6e4];
  var HEALTHY_RESET_MS = 6e4;
  var SilentRecoveryBudget = class {
    constructor() {
      __publicField(this, "attempts", 0);
      __publicField(this, "nextAt", 0);
      __publicField(this, "healthySince");
      __publicField(this, "activeUntil");
      __publicField(this, "networkRestorationUsed", false);
    }
    get exhausted() {
      return this.attempts >= RETRY_DELAYS_MS.length && this.activeUntil === void 0;
    }
    get attemptCount() {
      return this.attempts;
    }
    /** Resume with fresh observations, without refunding any attempted repair. */
    restartObservation(now) {
      this.healthySince = void 0;
      if (this.activeUntil !== void 0) this.activeUntil = now + SILENT_RECOVERY_TIMEOUT_MS;
    }
    observe(healthy, now) {
      if (healthy) {
        if (this.activeUntil !== void 0) this.finish(now);
        this.healthySince ?? (this.healthySince = now);
        if (now - this.healthySince >= HEALTHY_RESET_MS) this.reset();
      } else {
        this.healthySince = void 0;
        if (this.activeUntil !== void 0 && now >= this.activeUntil) this.finish(now);
      }
    }
    start(now) {
      if (this.activeUntil !== void 0 || this.exhausted || now < this.nextAt) return false;
      this.attempts++;
      this.activeUntil = now + SILENT_RECOVERY_TIMEOUT_MS;
      return true;
    }
    finish(now) {
      if (this.activeUntil === void 0) return;
      this.activeUntil = void 0;
      this.nextAt = now + (RETRY_DELAYS_MS[this.attempts] ?? 0);
    }
    cancel() {
      if (this.activeUntil === void 0) return;
      this.activeUntil = void 0;
      this.attempts--;
    }
    giveUp() {
      this.attempts = RETRY_DELAYS_MS.length;
      this.activeUntil = void 0;
    }
    /** A real offline-to-online transition earns one more try per unhealthy episode. */
    grantNetworkRestoration(now) {
      if (!this.exhausted || this.networkRestorationUsed) return false;
      this.networkRestorationUsed = true;
      this.attempts = RETRY_DELAYS_MS.length - 1;
      this.nextAt = now;
      return true;
    }
    reset() {
      this.attempts = 0;
      this.nextAt = 0;
      this.activeUntil = void 0;
      this.healthySince = void 0;
      this.networkRestorationUsed = false;
    }
  };

  // inject/src/messenger/lib/sync-health.ts
  var SYNC_REQUEST_TIMEOUT_MS = 3e4;
  var SYNC_WINDOW_MS = 18e4;
  var SYNC_FAILURE_FLOOR = 5;
  var STUCK_LOADING_SAMPLES = 3;
  var SampledPersistence = class {
    constructor(limit) {
      __publicField(this, "limit", limit);
      __publicField(this, "count", 0);
    }
    observe(present) {
      this.count = present ? this.count + 1 : 0;
    }
    persistent() {
      return this.count >= this.limit;
    }
  };
  function isMessengerSyncRequest(raw, base) {
    let url;
    try {
      url = new URL(raw, base);
    } catch (_) {
      return false;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    const facebookHost = host === "facebook.com" || host.endsWith(".facebook.com") || host === "messenger.com" || host.endsWith(".messenger.com");
    return facebookHost && url.pathname.startsWith("/api/graphql");
  }
  function syncResponseSucceeded(status) {
    return status >= 200 && status < 400;
  }
  var SyncHealthTracker = class {
    constructor() {
      __publicField(this, "outstanding", /* @__PURE__ */ new Map());
      __publicField(this, "outcomes", []);
      __publicField(this, "nextId", 1);
    }
    started(now) {
      const id = this.nextId++;
      this.outstanding.set(id, now);
      return id;
    }
    // Outcomes only count while the request is still outstanding: a request
    // already swept as hung must not add a second outcome when it eventually
    // completes, however it completes.
    succeeded(id, now) {
      if (this.outstanding.delete(id)) this.outcomes.push({ at: now, ok: true });
    }
    failed(id, now) {
      if (this.outstanding.delete(id)) this.outcomes.push({ at: now, ok: false });
    }
    /** Generic GraphQL includes search and other unrelated operations. Only
     * promote HTTP 429 to session-wide backoff once failures corroborate it. */
    response(id, status, now, online) {
      if (!this.outstanding.has(id)) return false;
      if (syncResponseSucceeded(status)) this.succeeded(id, now);
      else if (online) this.failed(id, now);
      else this.abandoned(id);
      return online && status === 429 && this.degraded(now);
    }
    /** Forget a request without recording an outcome (e.g. it was aborted
     * locally or failed while offline — that says nothing about Facebook). */
    abandoned(id) {
      this.outstanding.delete(id);
    }
    /** Forget everything in flight (the machine went offline: whatever those
     * requests do next is about the local network, not Facebook). */
    abandonOutstanding() {
      this.outstanding.clear();
    }
    /** Count requests hung past the deadline as failures, each once. */
    sweep(now) {
      for (const [id, startedAt] of this.outstanding) {
        if (now - startedAt >= SYNC_REQUEST_TIMEOUT_MS) {
          this.outstanding.delete(id);
          this.outcomes.push({ at: now, ok: false });
        }
      }
      this.outcomes = this.outcomes.filter((outcome) => now - outcome.at < SYNC_WINDOW_MS);
    }
    counts(now) {
      let ok = 0;
      let bad = 0;
      for (const outcome of this.outcomes) {
        if (now - outcome.at >= SYNC_WINDOW_MS) continue;
        if (outcome.ok) ok += 1;
        else bad += 1;
      }
      return { ok, bad };
    }
    degraded(now) {
      const { ok, bad } = this.counts(now);
      return bad >= SYNC_FAILURE_FLOOR && bad > ok;
    }
    /** Content-free description of the current window for diagnostics. */
    summary(now) {
      const { ok, bad } = this.counts(now);
      return `${bad} failed / ${ok} ok in window`;
    }
  };
  function isMessengerSyncOperation(body, friendlyName) {
    const expected = "LSPlatformGraphQLLightspeedRequestQuery";
    if (friendlyName === expected) return true;
    try {
      if (body instanceof URLSearchParams || body instanceof FormData) {
        return body.get("fb_api_req_friendly_name") === expected;
      }
      if (typeof body === "string") {
        const name = body.match(/(?:^|&)fb_api_req_friendly_name=([^&]*)/)?.[1];
        return name !== void 0 && decodeURIComponent(name.replace(/\+/g, " ")) === expected;
      }
    } catch (_) {
    }
    return false;
  }

  // inject/src/messenger/lib/rate-limit.ts
  var RATE_LIMIT_CODE = 1675004;
  var RATE_LIMIT_BASE_MS = 15 * 6e4;
  var RATE_LIMIT_MAX_MS = 24 * 60 * 6e4;
  var EPISODE_RESET_MS = 24 * 60 * 6e4;
  function readRateLimitState(value, now) {
    if (!value || typeof value !== "object") return;
    const { until, detectedAt, attempts } = value;
    if (typeof until !== "number" || !Number.isFinite(until) || typeof detectedAt !== "number" || !Number.isFinite(detectedAt) || typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 1 || attempts > 3 || detectedAt > now || now - detectedAt > EPISODE_RESET_MS || until < detectedAt || until - detectedAt > RATE_LIMIT_MAX_MS)
      return;
    return { until, detectedAt, attempts };
  }
  function isFacebookRateLimitError(value) {
    if (!value || typeof value !== "object") return false;
    const error = value;
    return typeof error.messageFormat === "string" && error.messageFormat.startsWith("GraphQL operation responded with error %s:") && Array.isArray(error.messageParams) && (error.messageParams[0] === RATE_LIMIT_CODE || error.messageParams[0] === String(RATE_LIMIT_CODE));
  }
  function retryAfterMs(header, now) {
    if (!header?.trim()) return;
    const value = header.trim();
    const ms = /^\d+$/.test(value) ? Number(value) * 1e3 : Date.parse(value) - now;
    if (!Number.isFinite(ms) || ms <= 0) return;
    return Math.min(ms, RATE_LIMIT_MAX_MS);
  }
  function nextRateLimit(previous, now, retryMs) {
    const current = readRateLimitState(previous, now);
    if (current && current.until > now) {
      if (retryMs && now + retryMs > current.until) {
        return { ...current, detectedAt: now, until: now + Math.min(retryMs, RATE_LIMIT_MAX_MS) };
      }
      return current;
    }
    const attempts = Math.min(3, (current?.attempts ?? 0) + 1);
    const delay = retryMs ?? RATE_LIMIT_BASE_MS * 2 ** (attempts - 1);
    return {
      detectedAt: now,
      until: now + Math.min(RATE_LIMIT_MAX_MS, Math.max(1e3, delay)),
      attempts
    };
  }
  var RetryAfterWindow = class {
    constructor() {
      __publicField(this, "samples", []);
    }
    observe(header, now) {
      this.samples = this.samples.filter(
        (sample) => now - sample.at < SYNC_WINDOW_MS && sample.until > now
      );
      const delay = retryAfterMs(header, now);
      if (delay !== void 0) this.samples.push({ at: now, until: now + delay });
      const until = this.samples.reduce((latest, sample) => Math.max(latest, sample.until), now);
      return until > now ? until - now : void 0;
    }
    clear() {
      this.samples = [];
    }
  };

  // inject/src/messenger/features/rate-limit.ts
  var RATE_LIMIT_RETRY_STATE_EVENT = "carrier:rate-limit-retry-state";
  var RATE_LIMIT_RETRY_EVENT = "carrier:rate-limit-retry";
  var RATE_LIMIT_EVENT = "carrier:rate-limit-change";
  var RATE_LIMIT_STORAGE_KEY = "carrier-rate-limit";
  var state;
  var storageKey = null;
  var rateLimitAccountScope = () => storageKey ?? "";
  function restore() {
    if (!storageKey) return;
    try {
      const stored = readRateLimitState(
        JSON.parse(localStorage.getItem(storageKey) || "null"),
        Date.now()
      );
      if (stored && (!state || stored.until > state.until)) state = stored;
      else if (!stored && rateLimitRemainingMs() <= 0) state = void 0;
    } catch (_) {
    }
  }
  function rateLimitRemainingMs(now = Date.now()) {
    return Math.max(0, (state?.until ?? 0) - now);
  }
  function reportRateLimit(source, retryMs) {
    restore();
    const next = nextRateLimit(state, Date.now(), retryMs);
    if (next.until === state?.until) return;
    state = next;
    try {
      if (storageKey) localStorage.setItem(storageKey, JSON.stringify(state));
    } catch (_) {
    }
    diag(
      "sync.rate-limit",
      `${source}: automatic recovery backing off until ${new Date(state.until).toISOString()} (attempt ${state.attempts})`
    );
    window.dispatchEvent(new Event(RATE_LIMIT_EVENT));
  }
  function hasRateLimitEpisode() {
    return state !== void 0;
  }
  function clearRateLimitOnRecovery() {
    restore();
    if (!state || rateLimitRemainingMs() > 0) return false;
    state = void 0;
    try {
      if (storageKey) localStorage.removeItem(storageKey);
    } catch (_) {
    }
    diag("sync.rate-limit-recovered", "requests recovered after cooldown; reset backoff episode");
    window.dispatchEvent(new CustomEvent(RATE_LIMIT_EVENT, { detail: "recovered-here" }));
    return true;
  }
  function retryRateLimitNow() {
    diag(
      "sync.rate-limit-manual",
      "user requested an extra recovery attempt; automatic cooldown unchanged"
    );
    window.dispatchEvent(new Event(RATE_LIMIT_RETRY_EVENT));
  }
  function initRateLimit() {
    const key = accountScopedStorageKey(RATE_LIMIT_STORAGE_KEY, document.cookie);
    if (key !== storageKey) state = void 0;
    storageKey = key;
    restore();
    window.addEventListener("storage", (event) => {
      if (!storageKey || event.key !== storageKey) return;
      restore();
      window.dispatchEvent(new Event(RATE_LIMIT_EVENT));
    });
    if (rateLimitRemainingMs() > 0) {
      diag("sync.rate-limit", `restored cooldown until ${new Date(state.until).toISOString()}`);
    }
  }

  // inject/src/messenger/lib/worker-state.ts
  var unsupportedSubscriptions = /* @__PURE__ */ new WeakSet();
  function observeWorkerConnection(state3, now = () => performance.now()) {
    if (!state3 || unsupportedSubscriptions.has(state3)) return;
    let listening = false;
    let disposed = false;
    let receivedAt;
    let resolve;
    const value = new Promise((complete) => {
      resolve = complete;
    });
    let unsubscribe;
    try {
      const subscribe = state3.onSet;
      if (typeof subscribe !== "function") return;
      unsubscribe = subscribe.call(state3, (next) => {
        if (listening && receivedAt === void 0) {
          receivedAt = now();
          resolve?.(typeof next === "boolean" ? next : void 0);
        }
      });
    } catch (_) {
      unsupportedSubscriptions.add(state3);
      return;
    }
    if (typeof unsubscribe !== "function") {
      unsupportedSubscriptions.add(state3);
      return;
    }
    const stop = unsubscribe;
    return {
      value,
      get receivedAt() {
        return receivedAt;
      },
      start: () => {
        if (!disposed) listening = true;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        listening = false;
        resolve?.(void 0);
        try {
          stop();
        } catch (_) {
          unsupportedSubscriptions.add(state3);
        }
      }
    };
  }
  function isMissingWorkerStateRoute(error) {
    const message = error && typeof error === "object" && "message" in error ? error.message : error;
    return typeof message === "string" && message.includes("resendWorkerStateManagerValuesToMainThread is not defined for backend");
  }

  // inject/src/messenger/features/realtime-health.ts
  var WORKER_HEARTBEAT_TIMEOUT_MS = 8e3;
  var WORKER_FAILURE_LIMIT = 3;
  var verifiedConnection = () => false;
  var scheduledSendConnectionReady = () => navigator.onLine && verifiedConnection();
  var facebookBridgeModule = () => {
    try {
      const facebookRequire = window.require;
      const module = facebookRequire?.("MAWBridgeSendAndReceive");
      return module && typeof module === "object" ? module : null;
    } catch (_) {
      return null;
    }
  };
  var workerConnectionState = () => {
    try {
      const facebookRequire = window.require;
      const module = facebookRequire?.("WACommsConnectionState");
      const state3 = module?.WACommsConnectionState;
      return state3 && typeof state3 === "object" ? state3 : void 0;
    } catch (_) {
      return void 0;
    }
  };
  var workerIsConnected = () => {
    try {
      const connected = workerConnectionState()?.isConnected?.();
      return typeof connected === "boolean" ? connected : void 0;
    } catch (_) {
      return void 0;
    }
  };
  var workerId = () => {
    try {
      const page = window;
      const state3 = page.require?.("MAWWaitForBackendSetup");
      return state3?.getCurrentWorkerID?.();
    } catch (_) {
      return void 0;
    }
  };
  var workerSetupState = () => {
    try {
      const page = window;
      const state3 = page.require?.("MAWWaitForBackendSetup");
      if (state3?.isBackendSetupSettled?.() !== true) {
        return state3?.isBackendSetupInProgress?.() === true ? "starting" : "unknown";
      }
      const successful = state3.isBackendSetupSuccessful?.();
      return successful === true ? "ready" : successful === false ? "failed" : "unknown";
    } catch (_) {
      return "unknown";
    }
  };
  function monitorRealtimeHealth(callbacks) {
    const nativeSetTimeout5 = setTimeout.bind(globalThis);
    const nativeClearTimeout4 = clearTimeout.bind(globalThis);
    const watchdog = new RealtimeHealthWatchdog();
    const workerFailures = new ConsecutiveFailureThreshold(WORKER_FAILURE_LIMIT);
    const accountKey = () => accountScopedStorageKey("carrier-worker-connected", document.cookie);
    const rememberedConnection = (key) => {
      try {
        return !!key && localStorage.getItem(key) === "1";
      } catch (_) {
        return false;
      }
    };
    let connectionKey = accountKey();
    let connectionWorkerId = workerId();
    let connectionState = workerConnectionState();
    let connectionRemembered = rememberedConnection(connectionKey);
    let workerConnection = new WorkerConnectionWatchdog(connectionRemembered);
    let workerProbePending = false;
    let workerDisconnected = false;
    let setupStartedAt;
    let verificationStartedAt;
    let verified;
    let stateRouteUnavailableFor;
    let probeIdentity;
    const now = performance.now.bind(performance);
    let workerExpected = connectionRemembered;
    let workerScope = {
      key: connectionKey,
      id: connectionWorkerId,
      state: connectionState,
      current: true
    };
    const hasCurrentAccountWorker = () => {
      const key = accountKey();
      if (key !== workerScope.key) {
        workerScope = { ...workerScope, key, current: false };
        workerExpected = rememberedConnection(key);
      }
      const id = workerId();
      const state3 = workerConnectionState();
      if (!workerScope.current) {
        workerScope.current = typeof id === "string" && id.length > 0 && id !== workerScope.id || state3 !== void 0 && state3 !== workerScope.state;
      }
      if (workerScope.current) {
        if (typeof id === "string" && id.length > 0) workerScope.id = id;
        if (state3 !== void 0) workerScope.state = state3;
      }
      return workerScope.current;
    };
    const expectsEncryptedWorker = () => {
      if (!hasCurrentAccountWorker()) return workerExpected;
      const id = workerId();
      workerExpected || (workerExpected = typeof id === "string" && id.length > 0 || workerConnectionState() !== void 0 || typeof facebookBridgeModule()?.sendAndReceive === "function" || workerSetupState() !== "unknown");
      return workerExpected;
    };
    const checkSockets = () => {
      const health = watchdog.health(Date.now());
      if (health === "healthy") callbacks.onHealthy("socket");
      else if (health === "stale") callbacks.onStale("socket");
      else if (health === "starting") callbacks.onUnknown("socket");
      return health;
    };
    const checkWorker = () => {
      const state3 = workerConnectionState();
      const account2 = accountKey();
      const id = workerId();
      if (!probeIdentity || probeIdentity.account !== account2 || probeIdentity.id !== id || probeIdentity.state !== state3) {
        const replaced = probeIdentity !== void 0;
        probeIdentity = { account: account2, id, state: state3 };
        workerFailures.succeeded();
        verified = void 0;
        stateRouteUnavailableFor = void 0;
        callbacks.onUnknown("worker");
        if (replaced) callbacks.onWorkerChanged?.();
      }
      if (!hasCurrentAccountWorker()) {
        verified = void 0;
        callbacks.onUnknown("worker");
        return;
      }
      if (workerProbePending) return;
      const bridge = facebookBridgeModule();
      if (typeof bridge?.sendAndReceive !== "function") {
        verified = void 0;
        callbacks.onUnknown("worker");
        return;
      }
      const sendAndReceive = bridge.sendAndReceive.bind(bridge);
      const stillCurrent = () => account2 === accountKey() && state3 === workerConnectionState() && id === workerId();
      const observation = stateRouteUnavailableFor?.() ? void 0 : observeWorkerConnection(state3, now);
      workerProbePending = true;
      let live = true;
      let timeout;
      const deadline = new Promise((_, reject) => {
        timeout = nativeSetTimeout5(
          () => reject(new Error("Messenger worker probe timed out")),
          WORKER_HEARTBEAT_TIMEOUT_MS
        );
      });
      const request = (route) => sendAndReceive("backend", route, void 0, {
        isLoggingDisabled: true,
        timeoutMs: WORKER_HEARTBEAT_TIMEOUT_MS
      });
      Promise.resolve().then(() => {
        observation?.start();
        const probe = observation ? Promise.all([request("resendWorkerStateManagerValuesToMainThread"), observation.value]).then(([, connected]) => connected).catch((error) => {
          if (!live || !stillCurrent() || !isMissingWorkerStateRoute(error)) throw error;
          stateRouteUnavailableFor = stillCurrent;
          observation.dispose();
          return request("getWorkerHeartbeat").then(() => void 0);
        }) : request("getWorkerHeartbeat").then(() => void 0);
        return Promise.race([probe, deadline]);
      }).then((connected) => {
        verified = void 0;
        if (!stillCurrent()) {
          callbacks.onUnknown("worker");
          return;
        }
        workerFailures.succeeded();
        if (connected === true && account2 && typeof id === "string" && id.length > 0 && observation?.receivedAt !== void 0) {
          verified = { at: observation.receivedAt, stillCurrent };
        }
        if (connected === true) {
          callbacks.onHealthy("worker");
          checkConnection();
        } else callbacks.onUnknown("worker");
      }).catch(() => {
        verified = void 0;
        if (!stillCurrent()) callbacks.onUnknown("worker");
        else if (workerFailures.failed()) callbacks.onStale("worker");
      }).finally(() => {
        live = false;
        observation?.dispose();
        nativeClearTimeout4(timeout);
        workerProbePending = false;
      });
    };
    const checkConnection = () => {
      expectsEncryptedWorker();
      const currentAccountWorker = hasCurrentAccountWorker();
      const currentKey = accountKey();
      const currentWorkerId = workerId();
      const currentState = workerConnectionState();
      const stateChanged = currentState !== void 0 && currentState !== connectionState;
      const workerChanged = typeof currentWorkerId === "string" && currentWorkerId.length > 0 && currentWorkerId !== connectionWorkerId;
      if (currentKey !== connectionKey || workerChanged || stateChanged) {
        connectionKey = currentKey;
        connectionWorkerId = currentWorkerId;
        connectionState = currentState;
        connectionRemembered = rememberedConnection(connectionKey);
        workerConnection = new WorkerConnectionWatchdog(connectionRemembered);
        workerDisconnected = false;
        setupStartedAt = void 0;
        verificationStartedAt = void 0;
        verified = void 0;
        callbacks.onUnknown("worker-connection");
      }
      const connected = currentAccountWorker ? workerIsConnected() : void 0;
      const setup = currentAccountWorker ? workerSetupState() : "unknown";
      if (setup === "starting") setupStartedAt ?? (setupStartedAt = now());
      else if (setup === "ready" || setup === "failed") setupStartedAt = void 0;
      const setupStale = setupStartedAt !== void 0 && now() - setupStartedAt >= REALTIME_NEVER_CONNECTED_MS;
      const freshConnected = connected === true && verified?.stillCurrent() === true && now() - verified.at < REALTIME_CONNECT_GRACE_MS;
      if (freshConnected && connectionKey && !connectionRemembered) {
        try {
          localStorage.setItem(connectionKey, "1");
          connectionRemembered = true;
        } catch (_) {
        }
      }
      if (freshConnected) verificationStartedAt = void 0;
      else if (setup === "ready" || connectionRemembered) verificationStartedAt ?? (verificationStartedAt = now());
      const verificationStale = verificationStartedAt !== void 0 && now() - verificationStartedAt >= REALTIME_NEVER_CONNECTED_MS;
      const connectionStale = workerConnection.observe(
        connected === true && !freshConnected ? void 0 : connected,
        Date.now(),
        setup === "ready"
      );
      const disconnected = setup === "failed" || setupStale || connectionStale || verificationStale;
      if (disconnected !== workerDisconnected) {
        workerDisconnected = disconnected;
        if (disconnected) {
          diag(
            "sync.worker-disconnected",
            setup === "failed" ? "encrypted backend setup failed" : setupStale ? "encrypted backend setup did not settle" : verificationStale ? "encrypted connection could not be verified" : "encrypted-message connection stayed disconnected"
          );
        }
      }
      if (disconnected) callbacks.onStale("worker-connection");
      else callbacks.onUnknown("worker-connection");
    };
    const check = () => {
      checkConnection();
      checkSockets();
      checkWorker();
    };
    try {
      const NativeWebSocket = window.WebSocket;
      const WrappedWebSocket = new Proxy(NativeWebSocket, {
        construct(target, args, newTarget) {
          const socket = Reflect.construct(target, args, newTarget);
          const rawUrl = args[0];
          if (!isMessengerRealtimeUrl(String(rawUrl || ""), location.href)) return socket;
          watchdog.created(socket, Date.now());
          socket.addEventListener("open", () => {
            watchdog.opened(socket, Date.now());
            callbacks.onHealthy("socket");
          });
          socket.addEventListener("message", () => {
            watchdog.received(socket, Date.now());
            callbacks.onHealthy("socket");
          });
          const failed = () => nativeSetTimeout5(checkSockets, 1e3);
          socket.addEventListener("error", failed);
          socket.addEventListener("close", () => {
            watchdog.closed(socket, Date.now());
            failed();
          });
          return socket;
        }
      });
      Object.defineProperty(window, "WebSocket", {
        value: WrappedWebSocket,
        writable: true,
        configurable: true
      });
    } catch (_) {
      diag("sync.monitor", "could not observe Messenger realtime WebSockets");
    }
    verifiedConnection = () => verified?.stillCurrent() === true && now() - verified.at < REALTIME_CONNECT_GRACE_MS && workerIsConnected() === true && workerSetupState() === "ready";
    return {
      check,
      isVerifiedHealthy: verifiedConnection,
      isRecoveryHealthy: () => verifiedConnection() || !expectsEncryptedWorker() && watchdog.health(Date.now()) === "healthy"
    };
  }

  // inject/src/messenger/lib/stuck-worker.ts
  var STUCK_WORKER_RELOAD_MS = 12e4;
  var STUCK_WORKER_MAX_MS = 6e5;
  var PROBE_INTERVAL_MS = 3e4;
  var PROBE_TIMEOUT_MS = 1e4;
  var SECOND_PROBE_URL = "https://m.facebook.com/favicon.ico";
  var nativeSetTimeout2 = setTimeout.bind(globalThis);
  var nativeClearTimeout2 = clearTimeout.bind(globalThis);
  async function probeFacebook(fetch2) {
    const controller = new AbortController();
    const timer = nativeSetTimeout2(() => controller.abort(), PROBE_TIMEOUT_MS);
    const request = (url, init) => fetch2(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      ...init,
      signal: controller.signal
    });
    try {
      return await new Promise((resolve) => {
        let failures2 = 0;
        const probes = [
          request("/favicon.ico", { method: "HEAD" }),
          // Cross-origin, so no-cors: an opaque response still proves
          // reachability. Fetch rejects no-cors requests that don't follow
          // redirects, so this one does.
          request(SECOND_PROBE_URL, { mode: "no-cors", redirect: "follow" })
        ];
        for (const probe of probes) {
          probe.then(
            () => resolve(true),
            () => {
              if (++failures2 === probes.length) resolve(false);
            }
          );
        }
      });
    } catch (_) {
      return false;
    } finally {
      nativeClearTimeout2(timer);
      controller.abort();
    }
  }
  var StuckWorkerReload = class {
    constructor(probe, now) {
      __publicField(this, "probe", probe);
      __publicField(this, "now", now);
      __publicField(this, "stuckSince");
      __publicField(this, "reachableSince");
      __publicField(this, "lastProbeAt");
      __publicField(this, "probing", false);
      __publicField(this, "episode", 0);
    }
    reset() {
      this.episode++;
      this.stuckSince = void 0;
      this.reachableSince = void 0;
      this.lastProbeAt = void 0;
    }
    /** Call while the worker stays stuck; returns why a reload is now due. */
    due() {
      const now = this.now();
      this.stuckSince ?? (this.stuckSince = now);
      if (!this.probing && (this.lastProbeAt === void 0 || now - this.lastProbeAt >= PROBE_INTERVAL_MS)) {
        this.probing = true;
        this.lastProbeAt = now;
        const episode = this.episode;
        void this.probe().catch(() => false).then((reachable) => {
          if (episode !== this.episode) return;
          if (reachable) this.reachableSince ?? (this.reachableSince = this.now());
          else this.reachableSince = void 0;
        }).finally(() => {
          this.probing = false;
        });
      }
      if (!this.probing && this.reachableSince !== void 0 && now - this.reachableSince >= STUCK_WORKER_RELOAD_MS) {
        return "reachable";
      }
      return now - this.stuckSince >= STUCK_WORKER_MAX_MS ? "timeout" : void 0;
    }
  };

  // inject/src/messenger/lib/worker-replacement.ts
  function record2(value) {
    return value !== null && typeof value === "object" ? value : void 0;
  }
  var DedicatedWorkerReplacement = class {
    constructor(load) {
      __publicField(this, "load", load);
      __publicField(this, "wrapped", /* @__PURE__ */ new WeakSet());
      __publicField(this, "current");
      /** Some worker in this document completed backend setup. */
      __publicField(this, "served", false);
      __publicField(this, "replacedWorker", false);
    }
    setupSucceeded() {
      try {
        const state3 = record2(this.load("MAWWaitForBackendSetup"));
        const successful = state3?.isBackendSetupSuccessful;
        return typeof successful === "function" && successful.call(state3) === true;
      } catch (_) {
        return false;
      }
    }
    observeLifecycleExports(value) {
      const exports = record2(value);
      const create = exports?.createWorkerIfNone;
      if (!exports || typeof create !== "function" || this.wrapped.has(create)) return;
      const owner = this;
      const wrapped3 = new Proxy(create, {
        apply(target, receiver, args) {
          const result = Reflect.apply(target, receiver, args);
          try {
            owner.created(result);
          } catch (_) {
          }
          return result;
        }
      });
      try {
        exports.createWorkerIfNone = wrapped3;
        this.wrapped.add(wrapped3);
      } catch (_) {
      }
    }
    created(result) {
      const creation = record2(result);
      if (!creation || typeof creation.then !== "function" || creation === this.current) return;
      if (this.current && !this.served && this.setupSucceeded()) this.served = true;
      this.current = creation;
      if (!this.served) return;
      creation.then(
        (value) => {
          if (record2(value)?.workerID === "dedicated") this.replacedWorker = true;
        },
        () => {
        }
      );
    }
    /**
     * Sample periodically. A worker serves the page once its backend setup
     * succeeds, so failed startup retries never count as a replacement.
     */
    replaced() {
      if (this.current && !this.served && this.setupSucceeded()) this.served = true;
      return this.replacedWorker;
    }
  };

  // inject/src/messenger/features/worker-recovery.ts
  var loadFacebookModule = (name) => {
    const page = window;
    return page.require?.(name);
  };
  var workerReplacement = new DedicatedWorkerReplacement(loadFacebookModule);
  var workerRecovery = new FacebookWorkerRecovery(
    loadFacebookModule,
    () => accountScopedStorageKey("carrier-worker-recovery", document.cookie) ?? void 0,
    async () => {
      if (window.__CARRIER_SETTINGS__?.multi_instance !== false || typeof window.BroadcastChannel !== "function") {
        return false;
      }
      try {
        const windows = await invoke("plugin:window|get_all_windows");
        return window.__CARRIER_SETTINGS__?.multi_instance === false && typeof window.BroadcastChannel === "function" && hasSoleMessengerWindow(windows);
      } catch (_) {
        return false;
      }
    }
  );

  // inject/src/messenger/features/silent-recovery.ts
  var NETWORK_RESTORATION_GRACE_MS = 15e3;
  function createSilentRecovery(options) {
    const budget = new SilentRecoveryBudget();
    const nativeSetTimeout5 = window.setTimeout.bind(window);
    const nativeClearTimeout4 = window.clearTimeout.bind(window);
    const now = performance.now.bind(performance);
    const nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : void 0;
    const stuckWorker = new StuckWorkerReload(
      async () => !!nativeFetch && await probeFacebook(nativeFetch),
      now
    );
    let stuckReloadRequested = false;
    const resetStuckWorker = () => {
      stuckWorker.reset();
      stuckReloadRequested = false;
      options.cancelReload();
    };
    const wallNow = Date.now.bind(Date);
    let lastTickAt = wallNow();
    let restartRunningDeadline;
    let running = false;
    let runningTimedOut = false;
    let failed = false;
    let manualRequested = false;
    let unhealthySince;
    let busySince;
    let unverifiedSince;
    let outageRequests = 0;
    const accountScope = () => accountScopedStorageKey("carrier-worker-recovery", document.cookie);
    let scope = accountScope();
    let scopeEpoch = 0;
    let offlineObserved = !navigator.onLine;
    let networkRestoredAt;
    window.addEventListener("offline", () => {
      if (!navigator.onLine) {
        offlineObserved = true;
        networkRestoredAt = void 0;
      }
    });
    window.addEventListener("online", () => {
      if (!navigator.onLine || !offlineObserved) return;
      offlineObserved = false;
      networkRestoredAt = now();
    });
    const showFailure = (value) => {
      if (failed === value) return;
      failed = value;
      window.dispatchEvent(new CustomEvent(SILENT_RECOVERY_EVENT, { detail: value }));
    };
    const resetSettle = () => {
      unhealthySince = void 0;
      busySince = void 0;
      resetStuckWorker();
      budget.restartObservation(now());
      if (running && !runningTimedOut) restartRunningDeadline?.();
    };
    const tick = () => {
      lastTickAt = wallNow();
      const currentScope = accountScope();
      if (currentScope !== scope) {
        scope = currentScope;
        scopeEpoch++;
        budget.reset();
        resetStuckWorker();
        workerRecovery.clearEscalation();
        manualRequested = false;
        unhealthySince = void 0;
        busySince = void 0;
        unverifiedSince = void 0;
        outageRequests = 0;
        networkRestoredAt = void 0;
        showFailure(false);
      }
      const needed = options.needsRecovery();
      const healthy = options.isHealthy();
      if (needed) unverifiedSince ?? (unverifiedSince = now());
      if (healthy && !needed && unverifiedSince !== void 0) {
        diag(
          "sync.worker-recovered",
          `verified transport restored elapsed_ms=${Math.round(now() - unverifiedSince)} recovery_requests=${outageRequests}`
        );
        unverifiedSince = void 0;
        outageRequests = 0;
      }
      budget.observe(healthy, now());
      if (healthy && budget.attemptCount === 0) workerRecovery.clearEscalation();
      if (networkRestoredAt !== void 0) {
        if (healthy) networkRestoredAt = void 0;
        else if (now() - networkRestoredAt >= NETWORK_RESTORATION_GRACE_MS) {
          networkRestoredAt = void 0;
          if (budget.grantNetworkRestoration(now())) {
            diag("sync.network-restored", "network restored; allowing one more worker repair");
          }
        }
      }
      if (!needed) {
        manualRequested = false;
        unhealthySince = void 0;
        busySince = void 0;
        resetStuckWorker();
        showFailure(false);
        return;
      }
      if (networkRestoredAt !== void 0) {
        return;
      }
      unhealthySince ?? (unhealthySince = now());
      if (now() - unhealthySince < REALTIME_UNOBSERVED_SETTLE_MS) return;
      if (running && runningTimedOut) showFailure(true);
      if (budget.exhausted) showFailure(true);
      if (running || options.blocked(manualRequested) || !budget.start(now())) return;
      const manual = manualRequested;
      const launchEpoch = scopeEpoch;
      manualRequested = false;
      running = true;
      outageRequests++;
      runningTimedOut = false;
      let timeout;
      const expire = () => {
        const gap = wallNow() - lastTickAt;
        if (gap > REALTIME_UNOBSERVED_SETTLE_MS || gap < 0) {
          resetSettle();
          return;
        }
        runningTimedOut = true;
        if (launchEpoch !== scopeEpoch) {
          if (options.needsRecovery()) showFailure(true);
          return;
        }
        if (options.isHealthy()) return;
        budget.giveUp();
        showFailure(true);
        diag(
          "sync.worker-recovery-timeout",
          `worker recovery did not settle phase=${workerRecovery.phase}; preserving the page`
        );
      };
      restartRunningDeadline = () => {
        nativeClearTimeout4(timeout);
        timeout = nativeSetTimeout5(expire, SILENT_RECOVERY_TIMEOUT_MS);
      };
      restartRunningDeadline();
      void workerRecovery.recover(
        () => !runningTimedOut && !options.blocked(manual) && options.needsRecovery(),
        budget.attemptCount >= 2 || busySince !== void 0 && now() - busySince >= SILENT_RECOVERY_TIMEOUT_MS
      ).then((result) => {
        nativeClearTimeout4(timeout);
        restartRunningDeadline = void 0;
        running = false;
        runningTimedOut = false;
        if (launchEpoch !== scopeEpoch) {
          options.check();
          return;
        }
        if (result === "reload") {
          budget.cancel();
          outageRequests--;
          busySince = void 0;
          showFailure(false);
          const due = stuckWorker.due();
          if (due) {
            if (!stuckReloadRequested) {
              stuckReloadRequested = true;
              diag(
                "sync.worker-stuck",
                due === "reachable" ? "encrypted worker stayed disconnected while Facebook answered; reloading" : "encrypted worker stayed disconnected for 10 minutes; reloading"
              );
            }
            options.reload();
          }
        } else if (result === "busy") {
          budget.cancel();
          busySince ?? (busySince = now());
          if (now() - busySince >= SILENT_RECOVERY_TIMEOUT_MS) showFailure(true);
        } else {
          busySince = void 0;
          if (result === "started") {
            showFailure(false);
            diag(
              "sync.worker-recovery",
              `started Messenger worker recovery without navigation via=${workerRecovery.previousPhase}`
            );
          }
        }
        if (result === "unsupported" && !options.isHealthy()) {
          budget.giveUp();
          showFailure(true);
          diag(
            "sync.worker-recovery-unavailable",
            "no compatible worker recovery; preserving the page"
          );
        }
        if (result === "failed") {
          diag(
            "sync.worker-recovery-failed",
            "worker recovery attempt failed; retrying with backoff"
          );
        }
        if (result === "inspection-timeout") {
          diag(
            "sync.worker-inspection-timeout",
            "worker inspection timed out before mutation; retrying with backoff"
          );
        }
        options.check();
      }).catch(() => {
        nativeClearTimeout4(timeout);
        restartRunningDeadline = void 0;
        running = false;
        runningTimedOut = false;
        if (launchEpoch !== scopeEpoch) return;
        budget.giveUp();
        showFailure(true);
        diag("sync.worker-recovery-failed", "worker recovery failed; preserving the page");
      });
    };
    window.addEventListener(SILENT_RECOVERY_RETRY_EVENT, () => {
      if (running || options.blocked(true)) return;
      budget.reset();
      manualRequested = true;
      showFailure(false);
      tick();
    });
    return {
      tick,
      resetSettle
    };
  }

  // inject/src/messenger/lib/sync-processing.ts
  var STALL_MS = 12e4;
  var MAX_SAMPLE_GAP_MS = 15e3;
  var MAX_PENDING = 128;
  var SyncProcessingProgress = class {
    constructor(accountScope) {
      __publicField(this, "accountScope", accountScope);
      __publicField(this, "pending", /* @__PURE__ */ new Map());
      __publicField(this, "wrapped", /* @__PURE__ */ new WeakSet());
      __publicField(this, "activeMs", 0);
      __publicField(this, "lastSample");
      __publicField(this, "scope");
      __publicField(this, "epoch", 0);
      __publicField(this, "observed", false);
      __publicField(this, "completed", 0);
      __publicField(this, "failed", 0);
      __publicField(this, "omitted", 0);
    }
    syncScope() {
      const scope = this.accountScope();
      if (scope !== this.scope) {
        this.scope = scope;
        this.epoch++;
        this.pending.clear();
        this.completed = this.failed = this.omitted = 0;
        this.observed = false;
        this.lastSample = void 0;
        this.activeMs = 0;
      }
      return scope !== void 0;
    }
    observeLogger(value) {
      if (!value || typeof value !== "object") return;
      const exports = value;
      const keys = ["start", "endSuccess", "endFailure"];
      if (!keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(exports, key);
        return descriptor?.writable === true && typeof descriptor.value === "function";
      })) {
        return;
      }
      for (const key of keys) {
        const original = exports[key];
        if (typeof original !== "function" || this.wrapped.has(original)) continue;
        const wrapper = new Proxy(original, {
          apply: (target, receiver, args) => {
            const result = Reflect.apply(target, receiver, args);
            try {
              if (this.syncScope()) this.record(key, args[0]);
            } catch (_) {
            }
            return result;
          }
        });
        try {
          exports[key] = wrapper;
          this.wrapped.add(wrapper);
        } catch (_) {
        }
      }
    }
    record(kind, instance) {
      if (typeof instance !== "number" || !Number.isSafeInteger(instance)) return;
      this.observed = true;
      if (kind === "start") {
        if (this.pending.has(instance)) return;
        if (this.pending.size >= MAX_PENDING) {
          this.omitted++;
          return;
        }
        this.pending.set(instance, this.activeMs);
      } else if (this.pending.delete(instance)) {
        if (kind === "endSuccess") this.completed++;
        else this.failed++;
      }
    }
    sample(at, active) {
      this.syncScope();
      const previous = this.lastSample;
      const delta = previous ? at - previous.at : 0;
      if (active && previous?.active && delta > 0 && delta <= MAX_SAMPLE_GAP_MS) {
        this.activeMs += delta;
      }
      this.lastSample = { at, active };
      let oldestActiveMs = 0;
      for (const startedAt of this.pending.values()) {
        oldestActiveMs = Math.max(oldestActiveMs, this.activeMs - startedAt);
      }
      return {
        epoch: this.epoch,
        observed: this.observed,
        pending: this.pending.size,
        completed: this.completed,
        failed: this.failed,
        omitted: this.omitted,
        oldestActiveMs: Math.round(oldestActiveMs),
        stalled: oldestActiveMs >= STALL_MS
      };
    }
  };

  // inject/src/messenger/features/sync-processing.ts
  var syncProcessing = new SyncProcessingProgress(
    () => accountScopedStorageKey("carrier-sync-processing", document.cookie) ?? void 0
  );
  var syncProcessingStalled = false;
  var failures = 0;
  var epoch = 0;
  function sampleSyncProcessing(active) {
    const snapshot = syncProcessing.sample(performance.now(), active);
    if (snapshot.epoch !== epoch) {
      epoch = snapshot.epoch;
      failures = 0;
      syncProcessingStalled = false;
    }
    if (snapshot.failed > failures) {
      diag("sync.processing-failed", `failed=${snapshot.failed} pending=${snapshot.pending}`);
    }
    failures = snapshot.failed;
    if (snapshot.stalled !== syncProcessingStalled) {
      syncProcessingStalled = snapshot.stalled;
      diag(
        syncProcessingStalled ? "sync.processing-stalled" : "sync.processing-cleared",
        `pending=${snapshot.pending} active_ms=${snapshot.oldestActiveMs} omitted=${snapshot.omitted}`
      );
    }
    return snapshot;
  }

  // inject/src/messenger/features/auto-refresh.ts
  function initAutoRefresh() {
    const renderProbe = new RenderHealthProbe(
      window.requestAnimationFrame.bind(window),
      window.cancelAnimationFrame.bind(window),
      performance.now.bind(performance)
    );
    const documentEpochMs = Math.floor(performance.timeOrigin);
    const nativeSetTimeout5 = window.setTimeout.bind(window);
    const nativeNow2 = performance.now.bind(performance);
    let reloadRequestedAt;
    let unloadObserved = false;
    window.addEventListener("beforeunload", () => {
      unloadObserved = true;
    });
    window.addEventListener("visibilitychange", () => renderProbe.reset());
    window.addEventListener("pagehide", () => renderProbe.reset());
    const isMac4 = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
    let systemSleeping = isMac4;
    let pending = false;
    let pendingReason = "rate-limit";
    let timer;
    const clearPending = () => {
      if (pending && pendingReason === "rate-limit-manual") {
        window.dispatchEvent(new CustomEvent(RATE_LIMIT_RETRY_STATE_EVENT, { detail: false }));
      }
      pending = false;
      clearTimeout(timer);
      timer = void 0;
    };
    const heartbeatId = window.__CARRIER_HEARTBEAT_ID__;
    try {
      delete window.__CARRIER_HEARTBEAT_ID__;
    } catch (_) {
      window.__CARRIER_HEARTBEAT_ID__ = void 0;
    }
    let lastHeartbeatProtection;
    const heartbeatProtection = () => isComposerDeliveryActive() || hasComposerDraft() || !!window.__carrierInCall;
    const realtimeRecovery = new RealtimeRecoveryTracker(Date.now());
    const onFacebookErrorPage = () => {
      try {
        return hasFacebookReloadDialog() || looksLikeFacebookErrorPage({
          hasBackLink: !!document.getElementById("back"),
          hasIconImage: document.getElementById("icon") instanceof HTMLImageElement,
          elementCount: document.getElementsByTagName("*").length
        });
      } catch (_) {
        return false;
      }
    };
    const realtimeStatus = () => {
      if (systemSleeping || !navigator.onLine || rateLimitRemainingMs() > 0) return "pending";
      if (!isMessengerContentPath(location.pathname)) return "pending";
      if (onFacebookErrorPage()) return "error";
      return realtimeRecovery.status(Date.now());
    };
    const messengerContentPresent = () => {
      if (!isMessengerContentPath(location.pathname)) return true;
      const candidates = document.querySelectorAll(
        'a[href], button, input, textarea, [contenteditable="true"], [role="navigation"], [role="main"]'
      );
      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
          continue;
        }
        let current = el;
        let hidden = false;
        while (current) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || Number(style.opacity) <= 0) {
            hidden = true;
            break;
          }
          current = current.parentElement;
        }
        if (!hidden) return true;
      }
      return false;
    };
    let rateLimitRetryGrantUntil = 0;
    let silentRecoveryFailed = false;
    let recoveryHealthy = () => false;
    const realtimeReport = () => {
      const status = realtimeStatus();
      const workerMutationPending = workerRecovery.phase === "dedicated-termination" || workerRecovery.phase === "shared-shutdown";
      return nativeRealtimeStatus(
        status,
        recoveryHealthy(),
        silentRecoveryFailed,
        workerMutationPending
      );
    };
    const emitHeartbeat = (requestRateLimitRetry = false) => {
      if (typeof heartbeatId !== "number") return;
      const protectedNow = heartbeatProtection();
      const contentPresent = messengerContentPresent();
      const visible = !document.hidden && !systemSleeping;
      lastHeartbeatProtection = protectedNow;
      invoke("plugin:event|emit", {
        event: "carrier:webview-heartbeat",
        payload: {
          id: heartbeatId,
          protected: protectedNow,
          content_present: contentPresent,
          render: {
            ...renderProbe.sample(
              visible && document.readyState === "complete" && contentPresent && isMessengerContentPath(location.pathname)
            ),
            document_epoch_ms: documentEpochMs,
            document_age_ms: Math.round(nativeNow2()),
            visible,
            focused: document.hasFocus(),
            content_page: isMessengerContentPath(location.pathname)
          },
          // Native supervision still owns unresponsive/blank/error pages. It
          // must not race a responsive page's non-navigating worker recovery,
          // but takes the transport back as a last resort once that fails.
          realtime: realtimeReport(),
          rate_limit_ms: rateLimitRemainingMs(),
          rate_limit_account: rateLimitAccountScope(),
          rate_limit_retry: requestRateLimitRetry
        }
      })?.catch?.(() => {
      });
    };
    const emitProtectionChange = () => {
      if (heartbeatProtection() !== lastHeartbeatProtection) emitHeartbeat();
    };
    window.addEventListener("input", emitProtectionChange, true);
    window.addEventListener("carrier:protection-change", emitProtectionChange);
    emitHeartbeat();
    const processingActive = () => !systemSleeping && !document.hidden && navigator.onLine && rateLimitRemainingMs() <= 0 && isMessengerContentPath(location.pathname);
    const captureRecovery = async () => {
      const processing = sampleSyncProcessing(processingActive());
      const snapshot = `age=${Math.round(nativeNow2())} ready=${document.readyState} visible=${!document.hidden} focused=${document.hasFocus()} nodes=${document.getElementsByTagName("*").length} articles=${document.querySelectorAll('[role="article"]').length} protected=${heartbeatProtection()} realtime=${realtimeStatus()} processing=${JSON.stringify(processing)}`;
      await Promise.race([
        invoke("plugin:event|emit", {
          event: "carrier:diag",
          payload: { key: "recovery.snapshot", msg: snapshot }
        })?.catch?.(() => {
        }),
        new Promise((resolve) => nativeSetTimeout5(resolve, 500))
      ]);
    };
    window.__carrierCaptureRecovery = captureRecovery;
    let capturingRecovery = false;
    const recoveryHeld = () => window.__CARRIER_SETTINGS__?.hold_failures && pendingReason !== "rate-limit-manual" && pendingReason !== "manual";
    const cancelRecoveredStuckReload = () => {
      if (pendingReason === "worker-stuck" && realtimeStatus() === "ok" && recoveryHealthy()) {
        clearPending();
      }
    };
    const maybeReload = async () => {
      timer = void 0;
      cancelRecoveredStuckReload();
      if (!pending || capturingRecovery) return;
      if (recoveryHeld()) {
        diag("recovery.held", `automatic ${pendingReason} recovery paused for investigation`);
        return;
      }
      if (systemSleeping || rateLimitRemainingMs() > 0 && pendingReason !== "rate-limit-manual") {
        clearPending();
        return;
      }
      if (heartbeatProtection()) {
        timer = setTimeout(maybeReload, 8e3);
        return;
      }
      if (!navigator.onLine) {
        timer = setTimeout(maybeReload, 8e3);
        return;
      }
      if (pendingReason === "rate-limit" && Date.now() >= rateLimitRetryGrantUntil) {
        timer = setTimeout(maybeReload, 8e3);
        emitHeartbeat(true);
        return;
      }
      diag("sync.refresh", `reloading Messenger view after ${pendingReason}`);
      const capturedReason = pendingReason;
      capturingRecovery = true;
      try {
        await captureRecovery();
      } catch (_) {
        diag("recovery.snapshot-failed", "could not capture page state before recovery");
      } finally {
        capturingRecovery = false;
      }
      cancelRecoveredStuckReload();
      if (!pending || capturedReason !== pendingReason) return;
      if (recoveryHeld()) {
        diag("recovery.held", `automatic ${pendingReason} recovery paused for investigation`);
        return;
      }
      if (heartbeatProtection() || systemSleeping || !navigator.onLine || rateLimitRemainingMs() > 0 && pendingReason !== "rate-limit-manual") {
        clearPending();
        return;
      }
      pending = false;
      if (reloadRequestedAt === void 0) {
        reloadRequestedAt = nativeNow2();
        unloadObserved = false;
        nativeSetTimeout5(() => {
          diag(
            "sync.reload-unfinished",
            `same document alive ${Math.round(nativeNow2() - (reloadRequestedAt ?? 0))}ms after reload; beforeunload=${unloadObserved} ready=${document.readyState} visible=${!document.hidden}`
          );
          reloadRequestedAt = void 0;
        }, 15e3);
      }
      location.reload();
    };
    window.addEventListener("carrier:settings", () => {
      if (pending && timer === void 0 && !recoveryHeld()) {
        timer = setTimeout(maybeReload, 0);
      }
    });
    window.__carrierRateLimitRetry = (expectedId, expires) => {
      if (expectedId !== heartbeatId || !Number.isFinite(expires) || expires <= Date.now()) return;
      if (!pending || pendingReason !== "rate-limit") return;
      rateLimitRetryGrantUntil = expires;
      clearTimeout(timer);
      maybeReload();
    };
    const schedule = (delay, reason) => {
      if (systemSleeping || rateLimitRemainingMs() > 0 && reason !== "rate-limit-manual") return;
      if (!canReplacePendingRefresh(pending ? pendingReason : null, reason)) return;
      pending = true;
      pendingReason = reason;
      clearTimeout(timer);
      timer = setTimeout(maybeReload, delay);
      if (reason === "rate-limit-manual") {
        window.dispatchEvent(new CustomEvent(RATE_LIMIT_RETRY_STATE_EVENT, { detail: true }));
      }
    };
    const realtime = monitorRealtimeHealth({
      onHealthy: (source) => {
        realtimeRecovery.healthy(source, Date.now());
      },
      onStale: (source) => {
        realtimeRecovery.stale(source);
      },
      onUnknown: (source) => {
        realtimeRecovery.withdraw(source);
      },
      onWorkerChanged: () => silentRecovery.resetSettle()
    });
    recoveryHealthy = realtime.isRecoveryHealthy;
    const silentRecovery = createSilentRecovery({
      blocked: (manual) => !manual && !!window.__CARRIER_SETTINGS__?.hold_failures || systemSleeping || !navigator.onLine || heartbeatProtection() || rateLimitRemainingMs() > 0 || !isMessengerContentPath(location.pathname) || onFacebookErrorPage(),
      needsRecovery: () => ["stale", "never"].includes(realtimeStatus()),
      isHealthy: () => realtimeStatus() === "ok" && realtime.isRecoveryHealthy(),
      check: () => realtime.check(),
      reload: () => {
        if (!pending) schedule(0, "worker-stuck");
      },
      cancelReload: () => {
        if (pending && pendingReason === "worker-stuck") clearPending();
      }
    });
    const noteLifecycle = () => {
      sampleSyncProcessing(processingActive());
      if (!systemSleeping && navigator.onLine && rateLimitRemainingMs() <= 0) realtime.check();
    };
    window.__carrierHeartbeat = (expectedId) => {
      if (expectedId !== heartbeatId) return;
      noteLifecycle();
      emitHeartbeat();
    };
    window.addEventListener("focus", noteLifecycle);
    window.addEventListener("blur", noteLifecycle);
    document.addEventListener("visibilitychange", noteLifecycle);
    window.addEventListener("online", noteLifecycle);
    window.addEventListener("offline", noteLifecycle);
    const powerState = new PowerStateTracker(performance.timeOrigin);
    window.addEventListener("carrier:power-state", (event) => {
      const snapshot = event.detail;
      if (!snapshot || typeof snapshot.sleeping !== "boolean" || !Number.isSafeInteger(snapshot.resume_generation)) {
        return;
      }
      const resumed = powerState.update(snapshot);
      systemSleeping = snapshot.sleeping;
      sampleSyncProcessing(processingActive());
      if (systemSleeping) {
        silentRecovery.resetSettle();
        clearPending();
      } else if (resumed) {
        silentRecovery.resetSettle();
        noteLifecycle();
      }
    });
    window.__carrierOnNotification = noteLifecycle;
    window.addEventListener(RATE_LIMIT_RETRY_EVENT, () => schedule(1e3, "rate-limit-manual"));
    window.addEventListener(SILENT_RECOVERY_RELOAD_EVENT, () => schedule(0, "manual"));
    window.addEventListener(SILENT_RECOVERY_EVENT, (event) => {
      silentRecoveryFailed = event.detail === true;
      emitHeartbeat();
    });
    let waitingForRateLimit = rateLimitRemainingMs() > 0;
    window.addEventListener(RATE_LIMIT_EVENT, (event) => {
      if (!hasRateLimitEpisode()) {
        if (event.detail === "recovered-here") {
          waitingForRateLimit = false;
          if (pending && pendingReason === "rate-limit") clearPending();
        }
        emitHeartbeat();
        return;
      }
      if (rateLimitRemainingMs() <= 0) return;
      rateLimitRetryGrantUntil = 0;
      waitingForRateLimit = true;
      clearPending();
      emitHeartbeat();
    });
    let lastHealthTickAt = Date.now();
    let replacementReported = false;
    setInterval(() => {
      const tickAt = Date.now();
      if (!isMac4 && (tickAt - lastHealthTickAt > REALTIME_UNOBSERVED_SETTLE_MS || tickAt < lastHealthTickAt)) {
        silentRecovery.resetSettle();
      }
      lastHealthTickAt = tickAt;
      sampleSyncProcessing(processingActive());
      if (systemSleeping || rateLimitRemainingMs() > 0) {
        emitHeartbeat();
        return;
      }
      if (waitingForRateLimit && !window.__CARRIER_SETTINGS__?.hold_failures) {
        waitingForRateLimit = false;
        window.dispatchEvent(new Event(RATE_LIMIT_EVENT));
        diag(
          "sync.rate-limit",
          "cooldown ended; scheduling one recovery attempt (access not yet confirmed)"
        );
        schedule(1e3, "rate-limit");
      }
      realtime.check();
      silentRecovery.tick();
      if (workerReplacement.replaced() && !pending) {
        if (!replacementReported) {
          replacementReported = true;
          diag("sync.worker-replaced", "encrypted worker was replaced in this page; reloading");
        }
        schedule(0, "worker-replaced");
      }
      emitHeartbeat();
    }, 5e3);
  }

  // inject/src/messenger/lib/chat-gradient.ts
  var GRADIENT_VAR = "--chat-outgoing-message-background-gradient";
  var BUBBLE_COLOUR = /^var\(--chat-outgoing-message-bubble-background-color[,)]/;
  var SINGLE_CLASS = /^\.[\w-]+$/;
  function collectBubbleClasses(rules, into) {
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      if (!rule) continue;
      if (rule.cssRules && !rule.selectorText) {
        collectBubbleClasses(rule.cssRules, into);
        continue;
      }
      const selector = rule.selectorText ?? "";
      if (!SINGLE_CLASS.test(selector)) continue;
      const colour = rule.style?.getPropertyValue("background-color").replace(/\s/g, "") ?? "";
      if (BUBBLE_COLOUR.test(colour)) into.add(selector);
    }
  }
  function chatGradientCss(bubbleClasses) {
    if (!bubbleClasses.length) return "";
    const chat = `html[data-carrier-chats] [role="main"] [style*="${GRADIENT_VAR}"]`;
    return `${chat} :is(${bubbleClasses.join(", ")}) {
  background-image: var(${GRADIENT_VAR}) !important;
  background-attachment: fixed !important;
}
:where(${chat}:is([style*="background-image: linear-gradient"], [style*="background-image:linear-gradient"])) {
  background-image: none !important;
}
`;
  }

  // inject/src/messenger/features/chat-gradient.ts
  var CHECK_MS = 1e3;
  function initChatGradient() {
    const style = document.createElement("style");
    style.id = "carrier-chat-gradient";
    const classes = /* @__PURE__ */ new Set();
    const rulesRead = /* @__PURE__ */ new WeakMap();
    const readSheets = () => {
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch (_) {
          continue;
        }
        if (rulesRead.get(sheet) === rules.length) continue;
        rulesRead.set(sheet, rules.length);
        collectBubbleClasses(rules, classes);
      }
    };
    let applied2 = 0;
    window.setInterval(() => {
      if (document.hidden) return;
      if (!document.querySelector(`[role="main"] [style*="${GRADIENT_VAR}"]`)) return;
      readSheets();
      if (!classes.size || classes.size === applied2) return;
      applied2 = classes.size;
      style.textContent = chatGradientCss([...classes]);
      if (!style.isConnected) document.documentElement.append(style);
    }, CHECK_MS);
  }

  // inject/src/messenger/lib/composer-focus.ts
  var EXPLICIT_ACTION_HOLD_MS = 2e3;
  var explicitActionAt = Number.NEGATIVE_INFINITY;
  function noteExplicitAction(now = performance.now()) {
    explicitActionAt = now;
  }
  function explicitActionRecent(now = performance.now()) {
    return now - explicitActionAt < EXPLICIT_ACTION_HOLD_MS;
  }
  function shouldFocusComposerOnReturn(state3) {
    return state3.enabled && state3.threadOpen && !state3.dialogOpen && state3.focus !== "elsewhere";
  }

  // inject/src/messenger/features/composer-focus.ts
  var SETTLE_MS = 250;
  var OPEN_WAIT_MS = 3e3;
  var SETTLE_AFTER_OPEN_MS = 2500;
  var AFTER_LOAD_MS = 1e3;
  function currentFocus() {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      return "nothing";
    }
    const link = active.closest("a");
    return link && chatRows().includes(link) ? "chat-list" : "elsewhere";
  }
  function returnState() {
    return {
      enabled: window.__CARRIER_SETTINGS__?.focus_composer_on_return !== false,
      threadOpen: !!threadIdFromHref(location.pathname),
      dialogOpen: [...document.querySelectorAll('[role="dialog"]')].some(isShown),
      focus: currentFocus()
    };
  }
  function initComposerFocus() {
    let loadedAt = document.readyState === "complete" ? 0 : null;
    window.addEventListener(
      "load",
      () => {
        loadedAt = performance.now();
      },
      { once: true }
    );
    const settled = () => loadedAt !== null && performance.now() - loadedAt >= AFTER_LOAD_MS;
    window.addEventListener("focus", (event) => {
      if (event.target !== window) return;
      const path = location.pathname;
      setTimeout(() => {
        if (!settled() || explicitActionRecent() || location.pathname !== path) return;
        if (shouldFocusComposerOnReturn(returnState())) focusComposer();
      }, SETTLE_MS);
    });
    document.addEventListener(
      "click",
      (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        const link = event.target?.closest?.("a[href]");
        if (!link || link.closest('[role="main"]')) return;
        const target = threadIdFromHref(link.getAttribute("href"));
        if (!target) return;
        const startedAt = performance.now();
        let readyAt = null;
        const log = () => document.querySelector('[role="main"] [role="log"]');
        const staleLog = threadIdFromHref(location.pathname) === target ? null : log();
        let cancelled = false;
        const cancel = (e) => {
          if (e instanceof KeyboardEvent && !/^(Tab|Arrow|Escape|Page|Home|End)/.test(e.key)) return;
          cancelled = true;
        };
        const stop = () => {
          cancelled = true;
          removeEventListener("pointerdown", cancel, true);
          removeEventListener("keydown", cancel, true);
        };
        addEventListener("pointerdown", cancel, true);
        addEventListener("keydown", cancel, true);
        const check = () => {
          const now = performance.now();
          if (cancelled || now - startedAt > OPEN_WAIT_MS || explicitActionRecent()) return stop();
          const current = log();
          if (threadIdFromHref(location.pathname) !== target || !current || current === staleLog || !focusComposerReady()) {
            requestAnimationFrame(check);
            return;
          }
          readyAt ?? (readyAt = now);
          const state3 = returnState();
          const active = document.activeElement;
          const incidental = link.contains(active) || !!active?.matches(":is(h1, h2)");
          const focus = incidental ? "nothing" : state3.focus;
          if (composerFocused()) {
          } else if (shouldFocusComposerOnReturn({ ...state3, focus })) {
            focusComposer();
          } else if (focus === "elsewhere") {
            return stop();
          }
          if (now - readyAt < SETTLE_AFTER_OPEN_MS) requestAnimationFrame(check);
          else stop();
        };
        requestAnimationFrame(check);
      },
      true
    );
  }
  function composerFocused() {
    return !!document.activeElement?.matches(
      '[role="main"] [contenteditable="true"][role="textbox"]'
    );
  }
  function focusComposerReady() {
    return [
      ...document.querySelectorAll('[role="main"] [contenteditable="true"][role="textbox"]')
    ].some(isShown);
  }

  // inject/src/messenger/lib/composer-keys.ts
  function shouldKeepEnterInComposer(state3) {
    if (state3.key !== "Enter") return false;
    if (state3.isComposing || state3.compositionActive || state3.keyCode === 229) return true;
    return state3.requireAccelerator && !state3.acceleratorPressed && !state3.shiftKey;
  }
  var VOICE_CLIP_CANCEL_ICON = "M8 .5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z";
  var isVoiceClipCancelIcon = (path) => !!path?.startsWith(VOICE_CLIP_CANCEL_ICON);
  function shouldEscapeCancelVoiceClip(state2) {
    return state2.key === "Escape" && !state2.isComposing && !state2.defaultPrevented && !state2.escapeOwnedElsewhere && state2.inChat;
  }

  // inject/src/messenger/lib/media-zoom.ts
  var MIN_SCALE = 1;
  var MAX_SCALE = 8;
  function wheelZoomFactor({ deltaY, deltaMode, ctrlKey, ctrlKeyHeld }) {
    const pixels = deltaY * (deltaMode === 1 ? 40 : deltaMode === 2 ? 800 : 1);
    if (ctrlKey && !ctrlKeyHeld && Math.abs(pixels) < 50) return Math.exp(-pixels / 100);
    return 2 ** (-Math.min(Math.max(pixels, -120), 120) * 2e-3);
  }
  function zoomAround(state2, scale, x, y, rect) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    if (next <= MIN_SCALE) return { scale: MIN_SCALE, tx: 0, ty: 0 };
    const k = next / state2.scale;
    return {
      scale: next,
      tx: state2.tx + (x - (rect.left + rect.width / 2)) * (1 - k),
      ty: state2.ty + (y - (rect.top + rect.height / 2)) * (1 - k)
    };
  }

  // inject/src/messenger/features/media-viewer.ts
  var zoomActive = false;
  var isMediaZoomActive = () => zoomActive;
  function initMediaViewer() {
    const PAN = 40;
    let target = null;
    let targetCssText = "";
    let targetTabIndex = null;
    let previousFocus = null;
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let active = false;
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let stx = 0;
    let sty = 0;
    let ctrlKeyHeld = false;
    let pinching = false;
    let pinchFrom = 1;
    function pickTarget(target2) {
      if (!(target2 instanceof Element)) return null;
      const t = target2;
      const video = t.closest("video") || t.closest("div")?.querySelector("video");
      if (video) return video;
      const img = t.closest("img[alt]");
      if (!img) return null;
      const src = img.currentSrc || img.src || "";
      if (src.startsWith("data:") || src.includes("stp=dst-png_s")) return null;
      return img;
    }
    function render(animated = true) {
      if (!target) return;
      const reset = scale === 1 && tx === 0 && ty === 0;
      target.style.transition = !animated || dragging ? "none" : "transform .15s cubic-bezier(0,0,.2,1)";
      target.style.transformOrigin = "center center";
      target.style.zIndex = reset ? "" : "1000";
      target.style.maxWidth = reset ? "" : "none";
      target.style.maxHeight = reset ? "" : "none";
      target.style.transform = reset ? "" : `translate(${tx}px,${ty}px) scale(${scale})`;
      target.style.cursor = reset ? "zoom-in" : dragging ? "grabbing" : "grab";
    }
    function zoomTo(next, x, y, animated = true) {
      if (!target) return;
      ({ scale, tx, ty } = zoomAround({ scale, tx, ty }, next, x, y, target.getBoundingClientRect()));
      render(animated);
    }
    function exit() {
      if (!active) return;
      active = false;
      zoomActive = false;
      pinching = false;
      handlers.forEach(([t, f, o]) => {
        document.removeEventListener(t, f, o);
      });
      const closedTarget = target;
      if (closedTarget) {
        closedTarget.style.cssText = targetCssText;
        if (targetTabIndex === null) closedTarget.removeAttribute("tabindex");
        else closedTarget.setAttribute("tabindex", targetTabIndex);
      }
      target = null;
      targetCssText = "";
      targetTabIndex = null;
      scale = 1;
      tx = 0;
      ty = 0;
      dragging = false;
      previousFocus?.focus({ preventScroll: true });
      previousFocus = null;
    }
    const onWheel = (e) => {
      if (!target) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (pinching) return;
      const factor = wheelZoomFactor({
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        ctrlKeyHeld
      });
      zoomTo(scale * factor, e.clientX, e.clientY, !e.ctrlKey && Math.abs(e.deltaY) >= 50);
    };
    const onDown = (e) => {
      if (e.button !== 0 || scale <= 1 || !target?.contains(e.target)) return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      stx = tx;
      sty = ty;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onMove = (e) => {
      ctrlKeyHeld = e.ctrlKey;
      if (!dragging) return;
      tx = stx + (e.clientX - sx);
      ty = sty + (e.clientY - sy);
      render();
    };
    const onUp = () => {
      dragging = false;
      render();
    };
    const onKeyUp = (e) => {
      ctrlKeyHeld = e.ctrlKey;
    };
    const onKey = (e) => {
      ctrlKeyHeld = e.ctrlKey;
      if (e.key === "Escape") return exit();
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopImmediatePropagation();
        target?.focus({ preventScroll: true });
        return;
      }
      const d = {
        ArrowLeft: [PAN, 0],
        ArrowRight: [-PAN, 0],
        ArrowUp: [0, PAN],
        ArrowDown: [0, -PAN]
      }[e.key];
      if (d && scale > 1) {
        e.preventDefault();
        e.stopImmediatePropagation();
        tx += d[0];
        ty += d[1];
        render();
      }
    };
    const onClick = (e) => {
      if (active && target && !target.contains(e.target)) exit();
    };
    const handlers = [
      ["wheel", onWheel, { passive: false, capture: true }],
      ["mousedown", onDown, { capture: true }],
      ["mousemove", onMove, { capture: true }],
      ["mouseup", onUp, { capture: true }],
      ["keydown", onKey, { capture: true }],
      ["keyup", onKeyUp, { capture: true, passive: true }],
      ["click", onClick, { capture: true }]
    ];
    function enter(t) {
      active = true;
      zoomActive = true;
      target = t;
      targetCssText = t.style.cssText;
      targetTabIndex = t.getAttribute("tabindex");
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      t.setAttribute("tabindex", "-1");
      scale = 1;
      tx = 0;
      ty = 0;
      t.focus({ preventScroll: true });
      handlers.forEach(([type, f, o]) => {
        document.addEventListener(type, f, o);
      });
    }
    document.addEventListener(
      "dblclick",
      (e) => {
        const t = pickTarget(e.target);
        if (!t) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (active) return exit();
        enter(t);
        zoomTo(2, e.clientX, e.clientY, false);
      },
      { capture: true }
    );
    document.addEventListener(
      "gesturestart",
      (event) => {
        const e = event;
        if (!active) {
          const t = pickTarget(e.target);
          if (!t) return;
          enter(t);
        }
        e.preventDefault();
        pinching = true;
        pinchFrom = scale;
      },
      { capture: true }
    );
    document.addEventListener(
      "gesturechange",
      (event) => {
        if (!pinching) return;
        const e = event;
        e.preventDefault();
        zoomTo(pinchFrom * e.scale, e.clientX, e.clientY, false);
      },
      { capture: true }
    );
    document.addEventListener(
      "gestureend",
      (event) => {
        if (!pinching) return;
        event.preventDefault();
        pinching = false;
        if (scale <= MIN_SCALE) exit();
      },
      { capture: true }
    );
  }

  // inject/src/messenger/features/composer-keys.ts
  var isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  var composerSelector = '[contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"], textarea';
  function isComposerTarget(target) {
    if (!(target instanceof Element)) return false;
    const editor = target.closest(composerSelector);
    return !!editor?.closest('[role="main"]');
  }
  var isShown2 = (element2) => {
    const rect = element2.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  function voiceClipCancelButton() {
    return [...document.querySelectorAll('[role="main"] [role="button"]')].find(
      (button) => isVoiceClipCancelIcon(button.querySelector("svg path")?.getAttribute("d")) && isShown2(button)
    );
  }
  function onVoiceClipEscape(event) {
    if (event.key !== "Escape") return;
    const target = event.target;
    const inChat = target === document.body || target === document.documentElement || target instanceof Element && !!target.closest('[role="main"]');
    const escapeOwnedElsewhere = isMediaZoomActive() || !!document.fullscreenElement || [...document.querySelectorAll('[role="dialog"], [role="menu"]')].some(isShown2);
    if (!shouldEscapeCancelVoiceClip({
      key: event.key,
      isComposing: event.isComposing,
      defaultPrevented: event.defaultPrevented,
      escapeOwnedElsewhere,
      inChat
    }))
      return;
    const cancel = voiceClipCancelButton();
    if (!cancel) return;
    event.preventDefault();
    event.stopPropagation();
    cancel.click();
  }
  function initComposerKeys() {
    let compositionActive = false;
    document.addEventListener(
      "compositionstart",
      (event) => {
        if (isComposerTarget(event.target)) compositionActive = true;
      },
      true
    );
    document.addEventListener(
      "compositionend",
      () => {
        compositionActive = false;
      },
      true
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (!isComposerTarget(event.target)) return;
        if (!shouldKeepEnterInComposer({
          key: event.key,
          isComposing: event.isComposing,
          compositionActive,
          keyCode: event.keyCode,
          requireAccelerator: window.__CARRIER_SETTINGS__?.send_with_accelerator === true,
          acceleratorPressed: isMac ? event.metaKey : event.ctrlKey,
          shiftKey: event.shiftKey
        }))
          return;
        event.stopImmediatePropagation();
      },
      true
    );
    document.addEventListener("keydown", onVoiceClipEscape, true);
  }

  // inject/src/messenger/lib/chat-row-menu.ts
  var CHAT_ROW_CONTEXT_MENU_LABELS = [
    "Mark as read",
    "Mark as unread",
    "Mute notifications",
    "Unmute notifications",
    "View profile",
    "Start end-to-end encrypted chat",
    "Block",
    "Unblock",
    "Archive chat",
    "Unarchive chat",
    "Delete chat",
    "Report",
    "Leave group"
  ];
  function chatRowAction(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    return CHAT_ROW_CONTEXT_MENU_LABELS.find((action2) => action2 === normalized) ?? null;
  }
  function chatRowActions(texts) {
    const offered = new Set(texts.map(chatRowAction));
    return CHAT_ROW_CONTEXT_MENU_LABELS.filter((action2) => offered.has(action2));
  }

  // inject/src/messenger/lib/download-completion.ts
  var DOWNLOAD_FINISHED_EVENT = "carrier:download-finished";
  var NativePromise = Promise;
  var nativePromiseThen = Promise.prototype.then;
  var nativeReflectApply = Reflect.apply;
  var nativeAddEventListener = EventTarget.prototype.addEventListener;
  var nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
  var nativeSetTimeout3 = globalThis.setTimeout;
  var nativeClearTimeout3 = globalThis.clearTimeout;
  function detailFor(event) {
    const detail = event.detail;
    if (!detail || typeof detail !== "object") return null;
    const candidate = detail;
    if (typeof candidate.id !== "string" || typeof candidate.url !== "string" || typeof candidate.success !== "boolean" || typeof candidate.denied !== "boolean" || typeof candidate.signature !== "string")
      return null;
    return {
      id: candidate.id,
      url: candidate.url,
      success: candidate.success,
      denied: candidate.denied,
      signature: candidate.signature
    };
  }
  var verifyDetail = (verifyResult, detail) => verifyResult(
    DOWNLOAD_FINISHED_EVENT,
    { id: detail.id, url: detail.url, success: detail.success, denied: detail.denied },
    detail.signature
  );
  function waitForNativeDownload(target, expectedUrl, verifyResult, timeoutMs = 12e4) {
    return new NativePromise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        nativeReflectApply(nativeClearTimeout3, globalThis, [timer]);
        nativeReflectApply(nativeRemoveEventListener, target, [DOWNLOAD_FINISHED_EVENT, onFinished]);
      };
      const onFinished = (event) => {
        const detail = detailFor(event);
        if (!detail || detail.url !== expectedUrl) return;
        if (!verifyResult) {
          cleanup();
          reject(new Error("native download bridge unavailable"));
          return;
        }
        nativeReflectApply(nativePromiseThen, verifyDetail(verifyResult, detail), [
          (authenticated) => {
            if (!authenticated) return;
            cleanup();
            if (detail.success) resolve({ id: detail.id, url: detail.url });
            else reject(new Error(detail.denied ? DOWNLOAD_ACCESS_DENIED : "native download failed"));
          },
          () => {
          }
        ]);
      };
      nativeReflectApply(nativeAddEventListener, target, [DOWNLOAD_FINISHED_EVENT, onFinished]);
      timer = nativeReflectApply(nativeSetTimeout3, globalThis, [
        () => {
          cleanup();
          reject(new Error("native download timed out"));
        },
        timeoutMs
      ]);
    });
  }
  function watchDeniedDownloads(target, verifyResult, onDenied) {
    const onFinished = (event) => {
      const detail = detailFor(event);
      if (!detail || detail.success || !detail.denied || !verifyResult) return;
      nativeReflectApply(nativePromiseThen, verifyDetail(verifyResult, detail), [
        (authenticated) => {
          if (authenticated) onDenied();
        },
        () => {
        }
      ]);
    };
    nativeReflectApply(nativeAddEventListener, target, [DOWNLOAD_FINISHED_EVENT, onFinished]);
  }

  // inject/src/messenger/lib/menu-integrity.ts
  var RECT_TOLERANCE = 1;
  var nativeAbs = Math.abs;
  var nativeCharCodeAt = String.prototype.charCodeAt;
  var nativeFromCharCode = String.fromCharCode;
  var nativeReflectApply2 = Reflect.apply;
  function cssPropertyName(property) {
    let result = "";
    for (let index = 0; index < property.length; index += 1) {
      const code = nativeReflectApply2(nativeCharCodeAt, property, [index]);
      result += code >= 65 && code <= 90 ? `-${nativeReflectApply2(nativeFromCharCode, void 0, [code + 32])}` : property[index] ?? "";
    }
    return result;
  }
  function rectsMatch(a, b, tolerance = RECT_TOLERANCE) {
    return nativeAbs(a.x - b.x) <= tolerance && nativeAbs(a.y - b.y) <= tolerance && nativeAbs(a.width - b.width) <= tolerance && nativeAbs(a.height - b.height) <= tolerance;
  }
  function pointInRect(rect, x, y) {
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }
  function pointerActivationIsSound(expected, current, x, y) {
    return rectsMatch(expected, current) && pointInRect(current, x, y);
  }

  // inject/src/messenger/lib/emoji.ts
  var EMOJI_SOURCE_RE = /(?:emoji|emoji\.php|\/images\/emoji)/i;
  var SYSTEM_EMOJI_GLYPH_ATTR = "data-carrier-system-emoji-glyph";
  var EMOJI_TEXT_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}]/u;
  var LABEL_TEXT_RE = /[\p{Letter}\p{Number}]/u;
  var KEYCAP_RE = /[#*0-9]️?⃣/gu;
  function emojiGlyph(value) {
    const text = String(value || "").trim();
    if (/^\(y\)$/i.test(text)) return "👍";
    if (!text || text.length > 24 || !EMOJI_TEXT_RE.test(text)) return "";
    if (LABEL_TEXT_RE.test(text.replace(KEYCAP_RE, ""))) return "";
    return text;
  }
  function isReactionMenuShape(children) {
    if (children.length < 6 || children.length > 9) return false;
    const addButton = children.at(-1);
    return addButton?.glyphs === 0 && addButton.role === "button" && children.slice(0, -1).every((child) => child.glyphs === 1);
  }

  // inject/src/messenger/lib/message-menu.ts
  var MESSAGE_CONTEXT_MENU_LABELS = [
    "Reply",
    "Copy text",
    "Edit",
    "Forward",
    "Pin",
    "Unpin",
    "Unsend",
    "Remove"
  ];
  var DRIVEN_ACTIONS = MESSAGE_CONTEXT_MENU_LABELS.filter(
    (action2) => action2 !== "Copy text"
  );
  function menuRowAction(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    return DRIVEN_ACTIONS.find((action2) => action2 === normalized) ?? null;
  }
  function toolbarAction(label2) {
    if (/^Reply\b/.test(label2)) return "Reply";
    if (/^Forward\b/.test(label2)) return "Forward";
    return null;
  }
  function messageActions(offer) {
    return MESSAGE_CONTEXT_MENU_LABELS.filter(
      (action2) => action2 === "Copy text" ? offer.text.length > 0 : offer.actions.includes(action2)
    );
  }
  function reactionLabel(emoji) {
    const codePoints = [...emoji];
    const first = codePoints[0]?.codePointAt(0) ?? 0;
    return codePoints.length === 1 && first >= 8192 && first < 13056 ? `${emoji}️` : emoji;
  }
  function uniqueReactions(reactions) {
    const seen = /* @__PURE__ */ new Set();
    return reactions.filter(({ emoji }) => {
      if (!emoji || seen.has(emoji)) return false;
      seen.add(emoji);
      return true;
    });
  }
  function keyboardMenuPoint(point, target, anchor) {
    const inside2 = point.x >= target.x && point.x <= target.x + target.width && point.y >= target.y && point.y <= target.y + target.height;
    if (inside2 && (point.x !== 0 || point.y !== 0)) return null;
    return [Math.max(0, Math.round(anchor.x)), Math.max(0, Math.round(anchor.y + anchor.height))];
  }
  function messageNodeText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (node.getAttribute?.(SYSTEM_EMOJI_GLYPH_ATTR) != null) return "";
    const tag = (node.tagName || "").toUpperCase();
    if (tag === "IMG") return node.getAttribute?.("alt") || "";
    if (tag === "BR") return "\n";
    let text = "";
    for (const child of Array.from(node.childNodes || [])) {
      const part = messageNodeText(child);
      const block = (child.tagName || "").toUpperCase() === "DIV";
      if (part && text && block && !text.endsWith("\n")) text += "\n";
      text += part;
    }
    return text;
  }

  // inject/src/messenger/features/hidden-menu.ts
  var PROBE_ATTRIBUTE = "data-carrier-message-menu-probe";
  var POLL_MS = 16;
  var MENU_WAIT_MS = 800;
  async function waitFor(read, ms) {
    const deadline = Date.now() + ms;
    while (true) {
      const value = read();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  var expanded = (button) => button.getAttribute("aria-expanded") === "true";
  function openMenu() {
    const menus = document.querySelectorAll('[role="menu"]');
    for (let index = menus.length - 1; index >= 0; index -= 1) {
      const menu = menus[index];
      if (menu?.querySelector('[role^="menuitem"]')) return menu;
    }
    return null;
  }
  async function withHiddenMenu(button, use, picks = false) {
    const root = document.documentElement;
    const focused = document.activeElement;
    root.setAttribute(PROBE_ATTRIBUTE, "");
    try {
      if (!expanded(button)) button.click();
      const menu = await waitFor(() => expanded(button) ? openMenu() : null, MENU_WAIT_MS);
      if (!menu) return null;
      const result = use(menu);
      if (picks && result) await waitFor(() => !expanded(button), MENU_WAIT_MS);
      return result;
    } finally {
      if (expanded(button)) {
        button.click();
        await waitFor(() => !expanded(button), MENU_WAIT_MS);
      }
      root.removeAttribute(PROBE_ATTRIBUTE);
      if (!picks && focused instanceof HTMLElement && focused.isConnected)
        focused.focus({ preventScroll: true });
    }
  }

  // inject/src/messenger/features/chat-row-menu.ts
  var ROW_MENU_BUTTON = '[aria-haspopup="menu"][aria-label^="More options for "]';
  var rowMenuButton = (link) => link.closest('[role="row"]')?.querySelector(ROW_MENU_BUTTON) ?? null;
  function chatRowFor(anchor) {
    return anchor.getAttribute("href")?.includes("/t/") && rowMenuButton(anchor) ? anchor : null;
  }
  var menuRows = (menu) => [...menu.querySelectorAll('[role="menuitem"]')];
  async function readChatRowActions(link) {
    const button = rowMenuButton(link);
    if (!button) return [];
    return await withHiddenMenu(
      button,
      (menu) => chatRowActions(menuRows(menu).map((row) => row.textContent ?? ""))
    ) ?? [];
  }
  function currentMenuButton(href) {
    for (const link of document.querySelectorAll('[role="row"] a[href]'))
      if (link.getAttribute("href") === href) return rowMenuButton(link);
    return null;
  }
  async function runChatRowAction(href, action2) {
    const button = currentMenuButton(href);
    if (!button) {
      toast("That conversation is no longer in the list");
      return;
    }
    const picked = await withHiddenMenu(
      button,
      (menu) => {
        const row = menuRows(menu).find((item) => chatRowAction(item.textContent ?? "") === action2);
        row?.click();
        return row !== void 0;
      },
      true
    );
    if (picked) return;
    diag("chat-row-menu.action", `${action2} was not offered when chosen`);
    toast("Messenger no longer offers that action");
  }

  // inject/src/messenger/features/message-menu.ts
  var MESSAGE = '[aria-roledescription="message"]';
  var TOOLBAR_WAIT_MS = 600;
  var MAX_REACTIONS = 12;
  var messageFor = (target) => target.closest(MESSAGE);
  var toolbarButton = (message, label2) => message.querySelector(`[role="toolbar"] [role="button"][aria-label^="${label2}"]`);
  async function ensureToolbar(message) {
    const mounted = () => message.querySelector('[role="toolbar"] [role="button"][aria-label]');
    if (mounted()) return true;
    const rect = message.getBoundingClientRect();
    const point = { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + 4 };
    message.dispatchEvent(new MouseEvent("mouseover", point));
    message.dispatchEvent(new MouseEvent("mousemove", point));
    return await waitFor(mounted, TOOLBAR_WAIT_MS) !== null;
  }
  var reactionRows = (menu) => menu.querySelectorAll('[role="menuitemradio"]');
  var reactionEmoji = (row) => (row.querySelector("img[alt]")?.getAttribute("alt") || row.textContent || "").trim();
  var moreRows = (menu) => menu.querySelectorAll('[role="menuitem"]');
  function messageTextBlock(message) {
    const blocks = [
      ...message.querySelectorAll('span[dir="auto"] > div[dir="auto"]')
    ].filter((block) => !block.closest('[role="toolbar"]'));
    return blocks[blocks.length - 1] ?? null;
  }
  function messageText(message) {
    const block = messageTextBlock(message);
    return block ? messageNodeText(block).trim() : "";
  }
  function toolbarActions(message) {
    const found = [];
    for (const button of message.querySelectorAll(
      '[role="toolbar"] [role="button"][aria-label]'
    )) {
      const action2 = toolbarAction(button.getAttribute("aria-label") ?? "");
      if (action2) found.push([action2, button]);
    }
    return found;
  }
  async function readMessageOffer(message) {
    const text = messageText(message);
    if (!await ensureToolbar(message)) return { reactions: [], text, actions: [] };
    const react = toolbarButton(message, "React");
    const reactions = react ? await withHiddenMenu(
      react,
      (menu) => [...reactionRows(menu)].map((row) => ({
        emoji: reactionEmoji(row),
        checked: row.getAttribute("aria-checked") === "true"
      }))
    ) ?? [] : [];
    const actions = toolbarActions(message).map(([action2]) => action2);
    const more = toolbarButton(message, "More");
    if (more)
      actions.push(
        ...await withHiddenMenu(
          more,
          (menu) => [...moreRows(menu)].map((row) => menuRowAction(row.textContent ?? "")).filter((action2) => action2 !== null)
        ) ?? []
      );
    return { reactions: uniqueReactions(reactions).slice(0, MAX_REACTIONS), text, actions };
  }
  async function drive(message, run, what) {
    if (!message.isConnected) {
      toast("That message is no longer on screen");
      return;
    }
    if (await run()) return;
    diag("message-menu.action", `${what} was not offered when chosen`);
    toast("Messenger no longer offers that action");
  }
  var reactTo = (message, emoji) => drive(
    message,
    async () => {
      const react = await ensureToolbar(message) ? toolbarButton(message, "React") : null;
      if (!react) return false;
      const picked = await withHiddenMenu(
        react,
        (menu) => {
          const row = [...reactionRows(menu)].find((item) => reactionEmoji(item) === emoji);
          row?.click();
          return row !== void 0;
        },
        true
      );
      return picked === true;
    },
    "reaction"
  );
  var runMessageAction = (message, action2) => drive(
    message,
    async () => {
      if (!await ensureToolbar(message)) return false;
      const button = toolbarActions(message).find(([offered]) => offered === action2)?.[1];
      if (button) {
        button.click();
        return true;
      }
      const more = toolbarButton(message, "More");
      if (!more) return false;
      const picked = await withHiddenMenu(
        more,
        (menu) => {
          const row = [...moreRows(menu)].find(
            (item) => menuRowAction(item.textContent ?? "") === action2
          );
          row?.click();
          return row !== void 0;
        },
        true
      );
      return picked === true;
    },
    action2
  );

  // inject/src/messenger/features/context-menu.ts
  var MAX_BLOB = 512 * 1024 * 1024;
  var MAX_CLIPBOARD_IMAGE = 16 * 1024 * 1024;
  var MAX_NATIVE_CONTEXT_VALUE = 64 * 1024;
  var IMAGE_CONTEXT_MENU_LABELS = [
    "Copy image",
    "Download image",
    "Share…",
    "Copy image address",
    "Open image in browser"
  ];
  var VIDEO_CONTEXT_MENU_LABELS = ["Download video", "Share…", "Copy video address"];
  var LINK_CONTEXT_MENU_LABELS = ["Copy link address", "Open link in browser"];
  var nativeAddEventListener2 = EventTarget.prototype.addEventListener;
  var nativeRemoveEventListener2 = EventTarget.prototype.removeEventListener;
  var nativeObjectDefineProperty = Object.defineProperty;
  var nativeObjectEntries = Object.entries;
  var nativeReflectApply3 = Reflect.apply;
  var nativeSetStyleProperty = CSSStyleDeclaration.prototype.setProperty;
  var nativeSetTimeout4 = window.setTimeout;
  var nativeAttachShadow = Element.prototype.attachShadow;
  var nativeAppendChild = Node.prototype.appendChild;
  var nativeContains = Node.prototype.contains;
  var nativeCreateElement = Document.prototype.createElement;
  var nativeFocus = HTMLElement.prototype.focus;
  var nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  var nativeGetEventTarget = Object.getOwnPropertyDescriptor(Event.prototype, "target")?.get;
  var nativeGetMouseClientX = Object.getOwnPropertyDescriptor(MouseEvent.prototype, "clientX")?.get;
  var nativeGetMouseClientY = Object.getOwnPropertyDescriptor(MouseEvent.prototype, "clientY")?.get;
  var nativePreventDefault = Event.prototype.preventDefault;
  var nativeRemove = Element.prototype.remove;
  var nativeStopPropagation = Event.prototype.stopPropagation;
  var nativeGetRectX = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "x")?.get;
  var nativeGetRectY = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "y")?.get;
  var nativeGetRectWidth = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "width")?.get;
  var nativeGetRectHeight = Object.getOwnPropertyDescriptor(
    DOMRectReadOnly.prototype,
    "height"
  )?.get;
  var nativeGetKeyboardKey = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "key")?.get;
  var nativeGetStyle = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "style")?.get;
  var nativeSetAttribute = Element.prototype.setAttribute;
  var nativeSetTextContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")?.set;
  var nativeSetTabIndex = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "tabIndex")?.set;
  var NativePromise2 = Promise;
  var NativeFileReader = FileReader;
  var nativeReadAsDataURL = FileReader.prototype.readAsDataURL;
  var nativeGetFileReaderResult = Object.getOwnPropertyDescriptor(
    FileReader.prototype,
    "result"
  )?.get;
  var NativeUint8Array = Uint8Array;
  var nativeGetRandomValues = crypto.getRandomValues.bind(crypto);
  var nativeShowContextMenu = typeof carrierShowContextMenu === "function" ? carrierShowContextMenu : void 0;
  var appendOwn = (items, item) => {
    nativeReflectApply3(nativeObjectDefineProperty, void 0, [
      items,
      `${items.length}`,
      { value: item, writable: true, enumerable: true, configurable: true }
    ]);
  };
  var setStyleProperty = (style, property, value) => {
    nativeReflectApply3(nativeSetStyleProperty, style, [property, value]);
  };
  var applyStyles = (style, values) => {
    for (const [property, value] of nativeReflectApply3(nativeObjectEntries, void 0, [values])) {
      setStyleProperty(style, cssPropertyName(property), value);
    }
  };
  var rectOf = (el) => {
    const r = nativeReflectApply3(nativeGetBoundingClientRect, el, []);
    return {
      x: nativeReflectApply3(nativeGetRectX, r, []),
      y: nativeReflectApply3(nativeGetRectY, r, []),
      width: nativeReflectApply3(nativeGetRectWidth, r, []),
      height: nativeReflectApply3(nativeGetRectHeight, r, [])
    };
  };
  var eventTargetOf = (event) => nativeReflectApply3(nativeGetEventTarget, event, []);
  var clientPointOf = (event) => ({
    x: nativeReflectApply3(nativeGetMouseClientX, event, []),
    y: nativeReflectApply3(nativeGetMouseClientY, event, [])
  });
  var isMac2 = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  var isLinux = !isMac2 && /linux/i.test(navigator.platform);
  function contextActionToken() {
    const bytes = new NativeUint8Array(16);
    nativeGetRandomValues(bytes);
    const hex = "0123456789abcdef";
    let token = "";
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index] ?? 0;
      token += (hex[byte >> 4] ?? "") + (hex[byte & 15] ?? "");
    }
    return token;
  }
  var nativeActionHandlers = [];
  var clearNativeActionHandlers = () => {
    nativeActionHandlers = [];
  };
  async function runNativeAction(event) {
    const detail = event.detail;
    if (!detail || typeof detail !== "object") return;
    const { action: action2, signature } = detail;
    if (typeof action2 !== "string" || !carrierVerifyResult) return;
    if (!await carrierVerifyResult("carrier:context-action", { action: action2 }, signature)) return;
    const handlers = nativeActionHandlers;
    for (let index = 0; index < handlers.length; index += 1) {
      const handler = handlers[index];
      if (!handler || handler[0] !== action2) continue;
      clearNativeActionHandlers();
      handler[1]();
      return;
    }
  }
  function showNativeContextMenu(items, position) {
    const nativeItems = [];
    clearNativeActionHandlers();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item) continue;
      const action2 = contextActionToken();
      const run = () => {
        item[1](isMac2 ? action2 : void 0);
      };
      appendOwn(nativeActionHandlers, [action2, run]);
      const nativeItem = { label: item[0], action: action2 };
      if (item[2]) nativeItem.value = item[2];
      if (item[3]) nativeItem.reaction = true;
      if (item[3]?.checked) nativeItem.checked = true;
      appendOwn(nativeItems, nativeItem);
    }
    if (!nativeShowContextMenu)
      return NativePromise2.reject(new Error("native context menu unavailable"));
    return nativeShowContextMenu(nativeItems, position ?? void 0).catch((error) => {
      clearNativeActionHandlers();
      throw error;
    });
  }
  async function shareSrc(src, fallbackName, fx, fy, action2) {
    await carrierClaimContextAction(action2);
    const { id } = await downloadSrc(src, fallbackName, action2);
    await carrierShareDownload(id, fx, fy, action2);
  }
  var oversizeByHeader = (res) => Number(res.headers.get("content-length")) > MAX_BLOB;
  var copyAddress = (text) => navigator.clipboard?.writeText(cleanSharedUrl(text)).then(() => toast("Address copied")).catch(() => toast("Copy failed"));
  var copyText = (text) => navigator.clipboard?.writeText(text).then(() => toast("Text copied")).catch(() => toast("Copy failed"));
  async function downloadSrc(src, fallbackName, action2) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    if (oversizeByHeader(res)) throw new Error("file too large");
    const blob = await res.blob();
    if (blob.size > MAX_BLOB) throw new Error("file too large");
    const href = URL.createObjectURL(blob);
    let name = friendlyDownloadName(filenameFromUrl(src, location.href) || fallbackName);
    if (!name.includes(".")) {
      const ext = ((blob.type || "").split("/")[1] || "").split(";")[0];
      if (ext) name += `.${ext}`;
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.setAttribute("data-carrier-native-download", "");
    a.style.display = "none";
    document.body.appendChild(a);
    try {
      if (action2) await carrierPrepareDownload(action2, href);
      if (window.__CARRIER_SETTINGS__?.download_behavior === "ask") {
        await carrierChooseDownload(href, name);
      }
      const completion = waitForNativeDownload(window, href, carrierVerifyResult);
      a.click();
      return await completion;
    } finally {
      a.remove();
      URL.revokeObjectURL(href);
    }
  }
  async function copyImageSrc(src, action2) {
    if (action2) await carrierClaimContextAction(action2);
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    const maxSize = action2 ? MAX_CLIPBOARD_IMAGE : MAX_BLOB;
    if (Number(res.headers.get("content-length")) > maxSize) {
      throw new Error("image too large");
    }
    const blob = await res.blob();
    if (blob.size > maxSize) throw new Error("image too large");
    if (!action2) {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return;
    }
    const dataUrl = await new NativePromise2((resolve, reject) => {
      if (!nativeGetFileReaderResult) {
        reject(new Error("native FileReader result getter unavailable"));
        return;
      }
      const reader = new NativeFileReader();
      nativeReflectApply3(nativeAddEventListener2, reader, [
        "load",
        () => {
          const result = nativeReflectApply3(nativeGetFileReaderResult, reader, []);
          if (typeof result === "string") resolve(result);
          else reject(new Error("image conversion failed"));
        },
        { once: true }
      ]);
      nativeReflectApply3(nativeAddEventListener2, reader, [
        "error",
        () => reject(new Error("image conversion failed")),
        { once: true }
      ]);
      nativeReflectApply3(nativeReadAsDataURL, reader, [blob]);
    });
    await carrierCopyImage(dataUrl, action2);
  }
  var ctxMenu = null;
  var ctxMenuReturnFocus = null;
  var closeMenuFromClick = (event) => {
    if (ctxMenu && eventTargetOf(event) === ctxMenu) return;
    closeMenu();
  };
  var closeMenuFromScroll = () => closeMenu();
  var closeMenu = (restoreFocus = false) => {
    if (ctxMenu) nativeReflectApply3(nativeRemove, ctxMenu, []);
    ctxMenu = null;
    nativeReflectApply3(nativeRemoveEventListener2, document, ["click", closeMenuFromClick, true]);
    nativeReflectApply3(nativeRemoveEventListener2, document, ["scroll", closeMenuFromScroll, true]);
    if (restoreFocus && ctxMenuReturnFocus) {
      nativeReflectApply3(nativeFocus, ctxMenuReturnFocus, [{ preventScroll: true }]);
    }
    ctxMenuReturnFocus = null;
  };
  function initContextMenu() {
    if (!nativeGetRectX || !nativeGetRectY || !nativeGetRectWidth || !nativeGetRectHeight || !nativeGetEventTarget || !nativeGetMouseClientX || !nativeGetMouseClientY || !nativeGetKeyboardKey || !nativeGetStyle || !nativeSetTextContent || !nativeSetTabIndex)
      return;
    nativeReflectApply3(nativeAddEventListener2, window, [
      "carrier:context-action",
      runNativeAction,
      true
    ]);
    let menuRequest = 0;
    const abandonMenu = (event) => {
      if (!event.isTrusted) return;
      if (event.type === "keydown") {
        const key = nativeReflectApply3(nativeGetKeyboardKey, event, []);
        if (key !== "Escape") return;
      }
      menuRequest += 1;
    };
    const openContextMenu = async (t, contextPoint, keyboard, prevent, selectedByClick = false) => {
      const anchor = t.closest?.("a[href]");
      const chatRow = anchor && chatRowFor(anchor);
      const video = chatRow ? null : t.closest?.("video") || (t.closest?.("div")?.querySelector?.("video") ?? null);
      const img = chatRow ? null : t.closest?.("img[alt]");
      const imgSrc = img && (img.currentSrc || img.src);
      const vidSrc = video && (video.currentSrc || video.src);
      const linkHref = chatRow ? void 0 : anchor?.href;
      const fx = contextPoint.x / Math.max(1, innerWidth);
      const fy = contextPoint.y / Math.max(1, innerHeight);
      const items = [];
      const addItem = (item) => {
        appendOwn(items, item);
      };
      if (imgSrc) {
        addItem([
          IMAGE_CONTEXT_MENU_LABELS[0],
          (action2) => copyImageSrc(imgSrc, action2).then(() => toast("Image copied")).catch(() => toast("Copy failed"))
        ]);
        addItem([
          IMAGE_CONTEXT_MENU_LABELS[1],
          () => downloadSrc(imgSrc, "image").then(({ url }) => toastDownloadSaved(url)).catch((error) => toastDownloadFailure(error))
        ]);
        if (isMac2) {
          addItem([
            IMAGE_CONTEXT_MENU_LABELS[2],
            (action2) => action2 ? shareSrc(imgSrc, "image", fx, fy, action2).catch(
              (error) => toastDownloadFailure(error, "Share failed")
            ) : void 0
          ]);
        }
        addItem([IMAGE_CONTEXT_MENU_LABELS[3], () => copyAddress(imgSrc), cleanSharedUrl(imgSrc)]);
        addItem([IMAGE_CONTEXT_MENU_LABELS[4], () => openUrl(imgSrc)]);
      } else if (vidSrc) {
        addItem([
          VIDEO_CONTEXT_MENU_LABELS[0],
          () => downloadSrc(vidSrc, "video").then(({ url }) => toastDownloadSaved(url)).catch((error) => toastDownloadFailure(error))
        ]);
        if (isMac2) {
          addItem([
            VIDEO_CONTEXT_MENU_LABELS[1],
            (action2) => action2 ? shareSrc(vidSrc, "video", fx, fy, action2).catch(
              (error) => toastDownloadFailure(error, "Share failed")
            ) : void 0
          ]);
        }
        addItem([VIDEO_CONTEXT_MENU_LABELS[2], () => copyAddress(vidSrc), cleanSharedUrl(vidSrc)]);
      } else if (linkHref && !linkHref.startsWith("javascript:")) {
        addItem([LINK_CONTEXT_MENU_LABELS[0], () => copyAddress(linkHref), cleanSharedUrl(linkHref)]);
        addItem([LINK_CONTEXT_MENU_LABELS[1], () => openUrl(linkHref)]);
      }
      const selection = getSelection();
      const selected = !selectedByClick && selection !== null && !selection.isCollapsed && selection.containsNode(t, true);
      const message = (imgSrc || vidSrc || !items.length) && !(selected && !items.length) ? messageFor(t) ?? null : null;
      const conversation = selected ? null : chatRow;
      if (!items.length && !message && !conversation) return;
      prevent();
      if (selectedByClick && selection && !selection.isCollapsed) selection.collapseToEnd();
      const keyboardPoint = message || keyboard ? keyboardMenuPoint(
        contextPoint,
        rectOf(t),
        rectOf(message ? messageTextBlock(message) ?? message : t)
      ) : null;
      menuRequest += 1;
      const request = menuRequest;
      const readAbandonably = async (read) => {
        nativeReflectApply3(nativeAddEventListener2, document, ["pointerdown", abandonMenu, true]);
        nativeReflectApply3(nativeAddEventListener2, document, ["keydown", abandonMenu, true]);
        try {
          return await read();
        } finally {
          nativeReflectApply3(nativeRemoveEventListener2, document, ["pointerdown", abandonMenu, true]);
          nativeReflectApply3(nativeRemoveEventListener2, document, ["keydown", abandonMenu, true]);
        }
      };
      if (conversation) {
        const href = conversation.getAttribute("href") ?? "";
        const actions = await readAbandonably(() => readChatRowActions(conversation));
        if (request !== menuRequest) return;
        for (let index = 0; index < actions.length; index += 1) {
          const action2 = actions[index];
          if (action2) addItem([action2, () => runChatRowAction(href, action2)]);
        }
        if (!items.length) {
          toast("Messenger offers no actions for this conversation");
          return;
        }
      }
      if (message) {
        const offer = await readAbandonably(() => readMessageOffer(message));
        if (request !== menuRequest) return;
        for (let index = 0; index < offer.reactions.length; index += 1) {
          const reaction = offer.reactions[index];
          if (reaction)
            addItem([
              reactionLabel(reaction.emoji),
              () => reactTo(message, reaction.emoji),
              void 0,
              reaction
            ]);
        }
        const actions = messageActions(offer);
        for (let index = 0; index < actions.length; index += 1) {
          const action2 = actions[index];
          if (action2 === MESSAGE_CONTEXT_MENU_LABELS[1])
            addItem([action2, () => copyText(offer.text), offer.text]);
          else if (action2) addItem([action2, () => runMessageAction(message, action2)]);
        }
        if (!items.length) {
          toast("Messenger offers no actions for this message");
          return;
        }
      }
      let nativeItemsAreValid = true;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item?.[2] && item[2].length > MAX_NATIVE_CONTEXT_VALUE) {
          nativeItemsAreValid = false;
          break;
        }
      }
      const nativeImageCopyIsSafe = isMac2 || !imgSrc;
      const nativeTakesKeyboard = !keyboard || !isLinux;
      if (nativeShowContextMenu && nativeItemsAreValid && nativeImageCopyIsSafe && nativeTakesKeyboard) {
        try {
          const zoom = (Number(window.__CARRIER_SETTINGS__?.zoom) || 100) / 100;
          const point = keyboardPoint ?? (isLinux ? [contextPoint.x, contextPoint.y] : null);
          await showNativeContextMenu(
            items,
            point ? [Math.round(point[0] * zoom), Math.round(point[1] * zoom)] : null
          );
          return;
        } catch {
        }
      }
      const focusableSelector = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
      const previouslyFocused = document.activeElement;
      const priorReturnFocus = ctxMenu && nativeReflectApply3(nativeContains, ctxMenu, [previouslyFocused]) ? ctxMenuReturnFocus : previouslyFocused instanceof HTMLElement && previouslyFocused !== document.body ? previouslyFocused : null;
      closeMenu();
      ctxMenuReturnFocus = t.closest?.(focusableSelector) ?? priorReturnFocus;
      ctxMenu = nativeReflectApply3(nativeCreateElement, document, ["div"]);
      const ctxMenuStyle = nativeReflectApply3(nativeGetStyle, ctxMenu, []);
      applyStyles(ctxMenuStyle, {
        position: "fixed",
        left: `${keyboardPoint?.[0] ?? contextPoint.x}px`,
        top: `${keyboardPoint?.[1] ?? contextPoint.y}px`,
        zIndex: "2147483647"
      });
      const shadow = nativeReflectApply3(nativeAttachShadow, ctxMenu, [
        { mode: "closed" }
      ]);
      const menu = nativeReflectApply3(nativeCreateElement, document, ["div"]);
      nativeReflectApply3(nativeSetAttribute, menu, ["role", "menu"]);
      nativeReflectApply3(nativeSetAttribute, menu, [
        "aria-label",
        message ? "Message actions" : conversation ? "Conversation actions" : "Media actions"
      ]);
      const menuStyle = nativeReflectApply3(nativeGetStyle, menu, []);
      applyStyles(menuStyle, {
        background: "var(--card-background, Canvas)",
        color: "var(--primary-text, CanvasText)",
        border: "1px solid var(--divider, rgba(127,127,127,.3))",
        borderRadius: "8px",
        padding: "4px",
        boxShadow: "0 6px 24px rgba(0,0,0,.4)",
        minWidth: "170px",
        font: "13px -apple-system, system-ui, sans-serif"
      });
      const menuItems = [];
      let reactionRow = null;
      let previousGroup = null;
      const laidOutRects = [];
      let focusedIndex = 0;
      const activate = (fn, restoreFocus = false) => {
        closeMenu(restoreFocus);
        fn();
      };
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item) continue;
        const label2 = item[0];
        if (isMac2 && (label2 === IMAGE_CONTEXT_MENU_LABELS[2] || label2 === VIDEO_CONTEXT_MENU_LABELS[1])) {
          continue;
        }
        const fn = item[1];
        const rowIndex = menuItems.length;
        const reaction = item[3];
        const group = reaction ? 1 : MESSAGE_CONTEXT_MENU_LABELS.includes(label2) ? 2 : conversation && CHAT_ROW_CONTEXT_MENU_LABELS.includes(label2) ? 3 : 0;
        if (previousGroup !== null && previousGroup !== group) {
          const divider = nativeReflectApply3(nativeCreateElement, document, [
            "div"
          ]);
          nativeReflectApply3(nativeSetAttribute, divider, ["role", "separator"]);
          applyStyles(nativeReflectApply3(nativeGetStyle, divider, []), {
            height: "1px",
            margin: "4px 8px",
            background: "var(--divider, rgba(127,127,127,.3))"
          });
          nativeReflectApply3(nativeAppendChild, menu, [divider]);
        }
        previousGroup = group;
        const el = nativeReflectApply3(nativeCreateElement, document, ["div"]);
        nativeReflectApply3(nativeSetTextContent, el, [label2]);
        nativeReflectApply3(nativeSetAttribute, el, [
          "role",
          reaction ? "menuitemcheckbox" : "menuitem"
        ]);
        if (reaction) {
          nativeReflectApply3(nativeSetAttribute, el, ["aria-label", `React ${label2}`]);
          nativeReflectApply3(nativeSetAttribute, el, ["aria-checked", `${reaction.checked}`]);
        }
        nativeReflectApply3(nativeSetTabIndex, el, [-1]);
        const elStyle = nativeReflectApply3(nativeGetStyle, el, []);
        applyStyles(elStyle, {
          padding: reaction ? "6px 8px" : "8px 12px",
          cursor: "pointer",
          borderRadius: "6px",
          outline: "none"
        });
        if (reaction) {
          applyStyles(elStyle, { fontSize: "18px", lineHeight: "1" });
          if (reaction.checked) setStyleProperty(elStyle, "box-shadow", "inset 0 0 0 2px Highlight");
        }
        nativeReflectApply3(nativeAddEventListener2, el, [
          "mouseenter",
          () => setStyleProperty(elStyle, "background", "var(--hover-overlay, rgba(127,127,127,.18))")
        ]);
        nativeReflectApply3(nativeAddEventListener2, el, [
          "mouseleave",
          () => setStyleProperty(elStyle, "background", "")
        ]);
        nativeReflectApply3(nativeAddEventListener2, el, [
          "focus",
          () => {
            focusedIndex = rowIndex;
            setStyleProperty(elStyle, "background", "var(--hover-overlay, rgba(127,127,127,.18))");
          }
        ]);
        nativeReflectApply3(nativeAddEventListener2, el, [
          "blur",
          () => setStyleProperty(elStyle, "background", "")
        ]);
        nativeReflectApply3(nativeAddEventListener2, el, [
          "click",
          (ev) => {
            if (!ev.isTrusted) return;
            nativeReflectApply3(nativeStopPropagation, ev, []);
            const expected = laidOutRects[rowIndex];
            const point = clientPointOf(ev);
            if (!expected || !pointerActivationIsSound(expected, rectOf(el), point.x, point.y)) {
              closeMenu();
              toast("Menu action cancelled");
              return;
            }
            activate(fn);
          }
        ]);
        nativeReflectApply3(nativeAddEventListener2, el, [
          "keydown",
          (event) => {
            const key = nativeReflectApply3(nativeGetKeyboardKey, event, []);
            if (key !== "Enter" && key !== " ") return;
            if (!event.isTrusted) return;
            nativeReflectApply3(nativePreventDefault, event, []);
            nativeReflectApply3(nativeStopPropagation, event, []);
            activate(fn, true);
          }
        ]);
        appendOwn(menuItems, el);
        if (reaction) {
          if (!reactionRow) {
            reactionRow = nativeReflectApply3(nativeCreateElement, document, [
              "div"
            ]);
            nativeReflectApply3(nativeSetAttribute, reactionRow, ["role", "group"]);
            nativeReflectApply3(nativeSetAttribute, reactionRow, ["aria-label", "React"]);
            applyStyles(nativeReflectApply3(nativeGetStyle, reactionRow, []), {
              display: "flex",
              gap: "2px"
            });
            nativeReflectApply3(nativeAppendChild, menu, [reactionRow]);
          }
          nativeReflectApply3(nativeAppendChild, reactionRow, [el]);
        } else {
          nativeReflectApply3(nativeAppendChild, menu, [el]);
        }
      }
      nativeReflectApply3(nativeAppendChild, shadow, [menu]);
      nativeReflectApply3(nativeAppendChild, document.body, [ctxMenu]);
      const r = rectOf(menu);
      if (r.x + r.width > innerWidth) {
        setStyleProperty(ctxMenuStyle, "left", `${innerWidth - r.width - 8}px`);
      }
      if (r.y + r.height > innerHeight) {
        setStyleProperty(ctxMenuStyle, "top", `${innerHeight - r.height - 8}px`);
      }
      for (let i = 0; i < menuItems.length; i += 1) {
        const row = menuItems[i];
        appendOwn(laidOutRects, row ? rectOf(row) : { x: 0, y: 0, width: 0, height: 0 });
      }
      nativeReflectApply3(nativeAddEventListener2, ctxMenu, [
        "keydown",
        (event) => {
          if (!event.isTrusted) return;
          const key = nativeReflectApply3(nativeGetKeyboardKey, event, []);
          const current = focusedIndex;
          let next = null;
          if (key === "ArrowDown") next = (current + 1) % menuItems.length;
          if (key === "ArrowUp") next = (current - 1 + menuItems.length) % menuItems.length;
          if (key === "Home") next = 0;
          if (key === "End") next = menuItems.length - 1;
          if (key === "Escape") {
            nativeReflectApply3(nativePreventDefault, event, []);
            closeMenu(true);
            return;
          }
          if (key === "Tab") {
            nativeReflectApply3(nativePreventDefault, event, []);
            closeMenu(true);
            return;
          }
          if (next !== null) {
            nativeReflectApply3(nativePreventDefault, event, []);
            focusedIndex = next;
            const nextItem = menuItems[next];
            if (nextItem) nativeReflectApply3(nativeFocus, nextItem, []);
          }
        }
      ]);
      focusedIndex = 0;
      const firstItem = menuItems[0];
      if (firstItem) nativeReflectApply3(nativeFocus, firstItem, [{ preventScroll: true }]);
      nativeReflectApply3(nativeSetTimeout4, window, [
        () => {
          nativeReflectApply3(nativeAddEventListener2, document, ["click", closeMenuFromClick, true]);
          nativeReflectApply3(nativeAddEventListener2, document, ["scroll", closeMenuFromScroll, true]);
        },
        0
      ]);
    };
    let keyboardMenu = null;
    nativeReflectApply3(nativeAddEventListener2, window, [
      "keydown",
      (event) => {
        if (!event.isTrusted) return;
        const key = nativeReflectApply3(nativeGetKeyboardKey, event, []);
        if (key !== "ContextMenu" && !(key === "F10" && event.shiftKey)) return;
        const focused = document.activeElement;
        const message = focused && messageFor(focused);
        if (!focused || !message) return;
        const selection = getSelection();
        if (selection && !selection.isCollapsed && selection.containsNode(message, true)) return;
        nativeReflectApply3(nativePreventDefault, event, []);
        nativeReflectApply3(nativeStopPropagation, event, []);
        keyboardMenu = { target: focused, at: Date.now() };
        void openContextMenu(focused, { x: -1, y: -1 }, true, () => {
        });
      },
      true
    ]);
    let secondaryPress = null;
    nativeReflectApply3(nativeAddEventListener2, window, [
      "mousedown",
      (e) => {
        if (!e.isTrusted || !(e.button === 2 || isMac2 && e.button === 0 && e.ctrlKey)) return;
        secondaryPress = { collapsed: getSelection()?.isCollapsed ?? true, at: Date.now() };
      },
      true
    ]);
    nativeReflectApply3(nativeAddEventListener2, document, [
      "contextmenu",
      (e) => {
        if (!e.isTrusted) return;
        const target = eventTargetOf(e);
        const duplicate = keyboardMenu?.target === target && Date.now() - keyboardMenu.at < 1e3;
        keyboardMenu = null;
        if (duplicate) {
          nativeReflectApply3(nativePreventDefault, e, []);
          return;
        }
        const selectedByClick = !!secondaryPress?.collapsed && Date.now() - secondaryPress.at < 1e3;
        secondaryPress = null;
        void openContextMenu(
          target,
          clientPointOf(e),
          false,
          () => nativeReflectApply3(nativePreventDefault, e, []),
          selectedByClick
        );
      },
      true
    ]);
  }

  // inject/src/messenger/lib/conversation-export.ts
  var EXPORT_MESSAGE_LIMIT = 5e4;
  var PARTICIPANT_LIMIT = 1e3;
  var ROW_LIMIT = 2e5;
  var UNKNOWN_SENDER_LIMIT = 200;
  function i64Text(value, i64ToText) {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
    if (typeof value === "string") return /^-?\d+$/.test(value) ? value : null;
    if (value == null || !i64ToText) return null;
    try {
      const text = i64ToText(value);
      return typeof text === "string" && /^-?\d+$/.test(text) ? text : null;
    } catch {
      return null;
    }
  }
  var VAULT_MARKER = /\d{10}##\d{10}/;
  function isVaulted(value) {
    return VAULT_MARKER.test(value);
  }
  function revealText(value, unvault) {
    if (typeof value !== "string" || value.trim() === "") return { text: null, unreadable: false };
    if (!isVaulted(value)) return { text: value, unreadable: false };
    let plain;
    try {
      plain = unvault?.(value);
    } catch {
      plain = void 0;
    }
    if (typeof plain !== "string" || isVaulted(plain)) return { text: null, unreadable: true };
    return { text: plain.trim() === "" ? null : plain, unreadable: false };
  }
  var isRow = (value) => !!value && typeof value === "object";
  function attachmentKind(row, mimeType, filename) {
    if (mimeType?.startsWith("image/")) return "image";
    if (mimeType?.startsWith("video/")) return "video";
    if (mimeType?.startsWith("audio/")) return "audio";
    if (row.hasXma === true) return "link";
    if (filename) return "file";
    return "other";
  }
  function callFromAttachment(row, unvault) {
    const dataclass = revealText(row.xmaDataclass, unvault).text;
    if (dataclass) {
      try {
        const parsed = JSON.parse(dataclass);
        const content = isRow(parsed) ? parsed.content : null;
        const items = !isRow(content) ? [] : content.__typename === "XMSGXmaSingleContent" ? [content] : Array.isArray(content.list) ? content.list : [];
        for (const item of items) {
          const data = isRow(item) ? item.custom_template_data : null;
          if (!isRow(data) || data.__typename !== "XMSGXmaCallingTemplateData") continue;
          const state3 = data.call_state;
          const duration = Number(data.call_duration_sec);
          return {
            type: data.call_type === "VIDEO" ? "video" : "audio",
            outcome: state3 === "MISSED" ? "missed" : state3 === "ENDED" ? "ended" : state3 === "STARTED" ? "started" : null,
            durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null
          };
        }
      } catch (_) {
      }
    }
    for (const cta of [row.defaultCtaType, row.cta1Type]) {
      if (typeof cta !== "string" || !cta.startsWith("xma_rtc_")) continue;
      return {
        type: cta.includes("video") ? "video" : "audio",
        outcome: cta.includes("missed") ? "missed" : cta.includes("ended") ? "ended" : null,
        durationSec: null
      };
    }
    return null;
  }
  function exportHistory(ranges, truncated) {
    if (truncated) return "partial";
    const rows = ranges.filter(isRow);
    if (rows.length > 1) return "partial";
    const oldest = rows[0];
    if (!oldest || typeof oldest.hasMoreBefore !== "boolean") return "unknown";
    return oldest.hasMoreBefore ? "partial" : "complete";
  }
  function buildConversationExport(rows, i64ToText, unvault) {
    const id = (value) => i64Text(value, i64ToText);
    const plain = (value) => revealText(value, unvault).text;
    const people = /* @__PURE__ */ new Map();
    const participants = [];
    for (const pair of rows.participants) {
      if (!Array.isArray(pair)) continue;
      const [participant, contact] = pair;
      if (!isRow(participant)) continue;
      const personId = id(participant.contactId) ?? (isRow(contact) ? id(contact.id) : null);
      if (!personId || people.has(personId)) continue;
      const person = {
        id: personId,
        name: isRow(contact) && plain(contact.name) || "",
        nickname: plain(participant.nickname)
      };
      people.set(personId, person);
      participants.push(person);
    }
    for (const contact of rows.contacts) {
      if (!isRow(contact)) continue;
      const personId = id(contact.id);
      const name = plain(contact.name);
      if (personId && name && !people.has(personId)) {
        people.set(personId, { id: personId, name, nickname: null });
      }
    }
    const nameOf = (personId) => personId && people.get(personId)?.name || null;
    const reactionsByMessage = /* @__PURE__ */ new Map();
    for (const row of rows.reactions) {
      if (!isRow(row) || typeof row.messageId !== "string") continue;
      const reaction = plain(row.reaction);
      if (!reaction) continue;
      const actorId = id(row.actorId);
      const timestamp = id(row.timestampMs);
      const list = reactionsByMessage.get(row.messageId) ?? [];
      list.push({
        actorId,
        actorName: nameOf(actorId),
        reaction,
        timestampMs: timestamp === null ? null : Number(timestamp)
      });
      reactionsByMessage.set(row.messageId, list);
    }
    for (const list of reactionsByMessage.values()) {
      list.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
    }
    const attachmentsByMessage = /* @__PURE__ */ new Map();
    const callsByMessage = /* @__PURE__ */ new Map();
    for (const row of rows.attachments) {
      if (!isRow(row) || typeof row.messageId !== "string") continue;
      const call = callFromAttachment(row, unvault);
      if (call) {
        callsByMessage.set(row.messageId, call);
        continue;
      }
      const mimeType = plain(row.playableUrlMimeType) ?? plain(row.previewUrlMimeType);
      const filename = plain(row.filename);
      const list = attachmentsByMessage.get(row.messageId) ?? [];
      list.push({
        index: Number(id(row.attachmentIndex) ?? list.length),
        value: {
          kind: attachmentKind(row, mimeType, filename),
          filename,
          title: plain(row.titleText),
          mimeType
        }
      });
      attachmentsByMessage.set(row.messageId, list);
    }
    const messages = [];
    const seen = /* @__PURE__ */ new Set();
    for (const row of rows.messages) {
      if (!isRow(row) || typeof row.messageId !== "string" || !row.messageId) continue;
      if (seen.has(row.messageId)) continue;
      const timestamp = id(row.timestampMs);
      const timestampMs = timestamp === null ? Number.NaN : Number(timestamp);
      if (!Number.isFinite(timestampMs)) continue;
      seen.add(row.messageId);
      const senderId = id(row.senderId);
      const unsent = row.isUnsent === true;
      const body = unsent ? { text: null, unreadable: false } : revealText(row.text, unvault);
      const replySource = typeof row.replySourceId === "string" ? row.replySourceId : "";
      const replySenderId = id(row.replyToUserId);
      const sticker = id(row.stickerId);
      messages.push({
        id: row.messageId,
        senderId,
        senderName: nameOf(senderId),
        timestampMs,
        utcOffsetMinutes: rows.utcOffsetMinutes(timestampMs),
        text: body.text,
        system: row.isAdminMessage === true,
        unsent,
        unreadable: body.unreadable,
        forwarded: row.isForwarded === true,
        edited: Number(id(row.editCount) ?? 0) > 0,
        sticker: sticker !== null && sticker !== "0",
        call: callsByMessage.get(row.messageId) ?? null,
        replyTo: replySource ? {
          messageId: replySource,
          senderId: replySenderId,
          senderName: nameOf(replySenderId),
          text: plain(row.replyMessageText) ?? plain(row.replySnippet)
        } : null,
        reactions: reactionsByMessage.get(row.messageId) ?? [],
        attachments: (attachmentsByMessage.get(row.messageId) ?? []).sort((a, b) => a.index - b.index).map(({ value }) => value)
      });
    }
    messages.sort(
      (a, b) => a.timestampMs - b.timestampMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    return {
      conversation: {
        id: rows.threadId,
        title: conversationTitle(rows, plain(rows.threadName), participants),
        isGroup: rows.isGroup,
        participants
      },
      history: exportHistory(rows.ranges, rows.truncated),
      truncated: rows.truncated,
      missing: rows.missing,
      messages
    };
  }
  function conversationTitle(rows, threadName, participants) {
    if (threadName?.trim()) return threadName.trim();
    const others = participants.filter((person) => person.id !== rows.viewerId && person.name);
    if (!rows.isGroup && others[0]) return others[0].name;
    if (others.length) return listedNames(others.map((person) => person.name));
    return "Conversation";
  }
  var TITLE_BYTES = 900;
  function listedNames(names2) {
    const bytes = (text) => new TextEncoder().encode(text).length;
    let title = "";
    for (const [index, name] of names2.entries()) {
      const next = title ? `${title}, ${name}` : name;
      const more = names2.length - index - 1;
      const suffix = more ? ` and ${more} more` : "";
      if (bytes(next + suffix) > TITLE_BYTES) {
        return title ? `${title} and ${names2.length - index} more` : `${names2.length} people`;
      }
      title = next;
    }
    return title;
  }
  async function readConversationExport(threadId, importModule, options) {
    if (!/^\d+$/.test(threadId) || typeof importModule !== "function") return null;
    const load = importModule;
    let timer;
    const read = async () => {
      const singleton = load("LSDatabaseSingleton");
      const db = await singleton.LSDatabaseSingleton;
      const i64 = load("I64");
      const q = load("ReQL");
      const i64ToText = i64.to_string?.bind(i64);
      let unvault;
      try {
        const vault = load("MAWVault");
        if (typeof vault?.unvault === "function") {
          const fn = vault.unvault;
          unvault = (value) => fn(value);
        }
      } catch (_) {
      }
      const key = i64.of_string(threadId);
      const thread2 = await db.tables.threads.get(key);
      if (!isRow(thread2)) return null;
      let isGroup = false;
      try {
        const types = load("LSMessagingThreadTypeUtil");
        isGroup = types.isGroup(thread2.threadType) === true;
      } catch (_) {
      }
      const rows = async (query) => {
        const result = await q.toArrayAsync(query);
        if (!Array.isArray(result)) throw new Error("unexpected query result");
        return result;
      };
      const missing = [];
      const optional = async (part, query) => {
        try {
          return await rows(query());
        } catch (_) {
          missing.push(part);
          return [];
        }
      };
      const messages = await rows(
        q.fromTableDescending(db.tables.messages).getKeyRange(key).take(EXPORT_MESSAGE_LIMIT + 1)
      );
      const truncated = messages.length > EXPORT_MESSAGE_LIMIT;
      if (truncated) messages.length = EXPORT_MESSAGE_LIMIT;
      const participants = await optional(
        "participants",
        () => q.leftJoin(
          q.fromTableAscending(db.tables.participants).getKeyRange(key),
          q.fromTableAscending(db.tables.contacts)
        ).take(PARTICIPANT_LIMIT)
      );
      const capped = async (part, table) => {
        const found = await optional(
          part,
          () => q.fromTableDescending(table).getKeyRange(key).take(ROW_LIMIT + 1)
        );
        if (found.length > ROW_LIMIT) {
          found.length = ROW_LIMIT;
          if (!missing.includes(part)) missing.push(part);
        }
        return found;
      };
      const reactions = await capped("reactions", db.tables.reactions);
      const attachments = await capped("attachments", db.tables.attachments);
      let ranges = [];
      try {
        ranges = await rows(
          q.fromTableAscending(db.tables.messages_ranges_v2__generated).getKeyRange(key)
        );
      } catch (_) {
      }
      const known = /* @__PURE__ */ new Set();
      for (const pair of participants) {
        if (Array.isArray(pair) && isRow(pair[0])) {
          const personId = i64Text(pair[0].contactId, i64ToText);
          if (personId) known.add(personId);
        }
      }
      const unknown = /* @__PURE__ */ new Set();
      for (const row of [...messages, ...reactions]) {
        if (!isRow(row)) continue;
        for (const value of [row.senderId, row.actorId, row.replyToUserId]) {
          const personId = i64Text(value, i64ToText);
          if (personId && !known.has(personId)) unknown.add(personId);
        }
      }
      const contacts = [];
      for (const personId of [...unknown].slice(0, UNKNOWN_SENDER_LIMIT)) {
        try {
          contacts.push(
            ...await rows(
              q.fromTableAscending(db.tables.contacts).getKeyRange(i64.of_string(personId)).take(1)
            )
          );
        } catch (_) {
        }
      }
      return buildConversationExport(
        {
          threadId,
          threadName: typeof thread2.threadName === "string" ? thread2.threadName : "",
          isGroup,
          viewerId: options.viewerId,
          participants,
          contacts,
          messages,
          reactions,
          attachments,
          ranges,
          truncated,
          missing,
          utcOffsetMinutes: options.utcOffsetMinutes
        },
        i64ToText,
        unvault
      );
    };
    try {
      return await Promise.race([
        read().catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), options.timeoutMs ?? 3e4);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // inject/src/messenger/features/conversation-export.ts
  var EXPORT_MAX_BYTES = 32 * 1024 * 1024;
  function randomHex() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async function exportConversation(format) {
    const threadId = threadIdFromHref(location.pathname);
    if (!threadId) {
      toast("Open a conversation to export it");
      return;
    }
    toast("Preparing export…");
    const conversation = await readConversationExport(
      threadId,
      window.require,
      {
        viewerId: accountId(document.cookie),
        utcOffsetMinutes: (timestampMs) => -new Date(timestampMs).getTimezoneOffset()
      }
    );
    if (!conversation) {
      diag("export.read", "conversation database unavailable");
      toast("Couldn't read this conversation", void 0, { warning: true });
      return;
    }
    if (new TextEncoder().encode(JSON.stringify(conversation)).length > EXPORT_MAX_BYTES) {
      toast("This conversation is too large to export", void 0, { warning: true });
      return;
    }
    const reveal = `carrier-export:${randomHex()}`;
    try {
      await carrierExportConversation({ format, conversation, reveal });
    } catch (error) {
      if (error instanceof Error && error.message === "export cancelled") {
        toast("Export cancelled");
        return;
      }
      diag("export.save", error instanceof Error ? error.message : "save failed");
      toast("Couldn't save the export", void 0, { warning: true });
      return;
    }
    const count = conversation.messages.length;
    toast(`Exported ${count.toLocaleString()} ${count === 1 ? "message" : "messages"}`, {
      label: downloadRevealLabel(navigator.userAgent),
      kind: "reveal-download",
      url: reveal
    });
  }
  function initConversationExport() {
    let busy = false;
    window.__carrierExportConversation = (format) => {
      if (format !== "html" && format !== "json") return;
      if (busy) {
        toast("An export is already in progress");
        return;
      }
      busy = true;
      exportConversation(format).catch(() => {
        diag("export.run", "export failed");
        toast("Couldn't export this conversation", void 0, { warning: true });
      }).finally(() => {
        busy = false;
      });
    };
  }

  // inject/src/messenger/lib/color.ts
  var rgb = (color) => {
    const m = color?.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r = NaN, g = NaN, b = NaN, a = 1] = m[1].split(",").map((v) => parseFloat(v));
    return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? { r, g, b, a } : null;
  };
  var isLightFill = (bg) => {
    const c = rgb(bg);
    return !!c && c.a > 0.9 && (c.r + c.g + c.b) / 3 > 200;
  };

  // inject/src/messenger/lib/login-page.ts
  function isLanguageFooterLink(link) {
    return link.href.trim() === "#";
  }
  function topLanguageLinkIndexes(links) {
    const indexes = links.flatMap((link, index) => isLanguageFooterLink(link) ? [index] : []);
    return indexes.length >= 2 ? indexes : [];
  }
  function isCookiePolicyHref(href) {
    try {
      const url = new URL(href, "https://www.facebook.com/");
      const host = url.hostname.toLowerCase();
      const metaOwned = host === "facebook.com" || host.endsWith(".facebook.com") || host === "meta.com" || host.endsWith(".meta.com") || host === "instagram.com" || host.endsWith(".instagram.com");
      if (!metaOwned) return false;
      return /(?:^|\/)(?:privacy|policies|cookie|cookies)(?:\/|$)/i.test(url.pathname);
    } catch {
      return false;
    }
  }
  function qualifiesCookieActionRow(scores) {
    return scores.length >= 2 && Math.max(...scores) > 40;
  }
  function lowestScoreIndex(scores) {
    if (!scores.length) return null;
    let lowest = 0;
    for (let index = 1; index < scores.length; index++) {
      if (scores[index] < scores[lowest]) lowest = index;
    }
    return lowest;
  }

  // inject/src/messenger/features/cookie-consent.ts
  var hasCookieConsentContext = (el) => {
    const links = [];
    if (el.matches?.("a[href]")) links.push(el);
    links.push(...el.querySelectorAll?.("a[href]") || []);
    return links.some((link) => isCookiePolicyHref(link.getAttribute("href") || ""));
  };
  var onFacebookHost = () => /(^|\.)facebook\.com$/i.test(location.hostname);
  var onFacebookLoginSurface = () => onFacebookHost() && (/\/login(?:\.php)?$/i.test(location.pathname) || location.pathname === "/" || !!document.querySelector('input[name="email"], input[name="pass"], input[type="password"]'));
  var visibleBox = (el) => {
    if (el?.nodeType !== 1) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return null;
    return r;
  };
  var blueScore = (el) => {
    const c = rgb(getComputedStyle(el).backgroundColor);
    if (!c || c.a < 0.35) return null;
    const chroma = c.b - Math.max(c.r, c.g);
    return { score: chroma < 60 ? 0 : chroma + Math.max(0, c.b - 120), opaque: c.a > 0.9 };
  };
  var coversButton = (inner, button) => {
    const r = inner.getBoundingClientRect();
    return r.width * r.height >= 0.7 * button.width * button.height;
  };
  var primaryBlueScore = (el) => {
    let best = 0;
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const fill = blueScore(cur);
      if (!fill) continue;
      best = Math.max(best, fill.score);
      if (fill.opaque) break;
    }
    const box = el.getBoundingClientRect();
    for (const inner of el.querySelectorAll("*")) {
      const fill = blueScore(inner);
      if (fill && coversButton(inner, box)) best = Math.max(best, fill.score);
    }
    return best;
  };
  var actionButtonsIn = (root) => {
    const selector = 'button, [role="button"]';
    const buttons = [];
    if (root.matches?.(selector)) buttons.push(root);
    buttons.push(...root.querySelectorAll?.(selector) || []);
    const visible = buttons.filter((button) => {
      if (button.closest('[aria-hidden="true"]')) return false;
      const r = visibleBox(button);
      if (!r || r.width < 90 || r.height < 28) return false;
      if (button.disabled || button.getAttribute("aria-disabled") === "true")
        return false;
      if (button.hasAttribute("aria-expanded")) return false;
      if (button.getAttribute("aria-haspopup")) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !button.contains(hit)) return false;
      return true;
    });
    return visible.filter(
      (button) => !visible.some((other) => other !== button && button.contains(other))
    );
  };
  var bottomActionRow = (root) => {
    const rootRect = visibleBox(root);
    if (!rootRect) return null;
    const buttons = actionButtonsIn(root).map((button) => ({ button, rect: button.getBoundingClientRect() })).sort((a, b) => a.rect.top - b.rect.top);
    const rows = [];
    for (const item of buttons) {
      const center = item.rect.top + item.rect.height / 2;
      let row = rows.find((candidate) => Math.abs(candidate.center - center) < 24);
      if (!row) {
        row = { center, items: [] };
        rows.push(row);
      }
      row.items.push(item);
      row.center = row.items.reduce((sum, i) => sum + i.rect.top + i.rect.height / 2, 0) / row.items.length;
    }
    return rows.filter((row) => row.items.length >= 2).map((row) => ({
      ...row,
      bottom: Math.max(...row.items.map((i) => i.rect.bottom)),
      primaryScore: Math.max(...row.items.map((i) => primaryBlueScore(i.button)))
    })).filter(
      (row) => qualifiesCookieActionRow(row.items.map((item) => primaryBlueScore(item.button)))
    ).sort((a, b) => b.bottom - a.bottom)[0]?.items;
  };
  function findOptionalCookieDeclineButton(root = document) {
    if (!onFacebookLoginSurface()) return null;
    const roots = /* @__PURE__ */ new Set();
    for (const button of actionButtonsIn(root)) {
      let node = button.parentElement;
      for (let depth = 0; node && node !== document.body && depth < 12; depth++, node = node.parentElement) {
        const row = bottomActionRow(node);
        if (row?.length === 2 && hasCookieConsentContext(node) && !node.querySelector?.('input[name="email"], input[name="pass"], input[type="password"]')) {
          roots.add(node);
        }
      }
    }
    const candidates = [...roots].sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    });
    for (const candidate of candidates) {
      const row = bottomActionRow(candidate);
      if (!row) continue;
      const target = lowestScoreIndex(row.map((item) => primaryBlueScore(item.button)));
      if (target !== null) return row[target].button;
    }
    return null;
  }
  function initCookieAutoDecline() {
    if (!onFacebookHost()) return;
    let done = false;
    let scheduled = false;
    let retryTimer = 0;
    const deadline = Date.now() + 6e4;
    let observer;
    const stop = () => {
      observer?.disconnect();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = 0;
      }
    };
    const decline = (button) => {
      done = true;
      document.documentElement.setAttribute("data-carrier-cookie-decline", "attempted");
      stop();
      button.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window })
      );
      button.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window })
      );
      button.click();
    };
    const scan = () => {
      scheduled = false;
      if (done) return;
      const button = findOptionalCookieDeclineButton();
      if (button) {
        decline(button);
      } else if (Date.now() < deadline && !retryTimer) {
        retryTimer = window.setTimeout(() => {
          retryTimer = 0;
          schedule();
        }, 250);
      } else if (Date.now() >= deadline) {
        stop();
      }
    };
    const schedule = () => {
      if (scheduled || done) return;
      scheduled = true;
      requestAnimationFrame(scan);
    };
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked", "aria-expanded", "class", "role", "style"]
    });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", schedule, { once: true });
    }
    window.addEventListener("pageshow", schedule);
    schedule();
  }

  // inject/src/messenger/lib/dom-roots.ts
  function connectedRoots(roots) {
    return [...roots].filter((root) => {
      if (!root.isConnected) return false;
      for (let parent = root.parentElement; parent; parent = parent.parentElement) {
        if (roots.has(parent)) return false;
      }
      return true;
    });
  }

  // inject/src/messenger/features/download-anchors.ts
  var stripDlTarget = (a) => {
    const el = a;
    if (el?.matches?.("a[download][target]")) {
      el.removeAttribute("target");
      el.removeAttribute("rel");
    }
  };
  var sweepDlAnchors = (root) => {
    stripDlTarget(root);
    root.querySelectorAll?.("a[download][target]").forEach(stripDlTarget);
  };
  var addedNodeSweeps = [];
  var queuedSweepRoots = /* @__PURE__ */ new Set();
  var sweepTimer = 0;
  var runSweeps = () => {
    sweepTimer = 0;
    const roots = connectedRoots(queuedSweepRoots);
    queuedSweepRoots.clear();
    for (const root of roots) {
      if (!root.isConnected) continue;
      for (const fn of addedNodeSweeps) fn(root);
    }
  };
  var sweepObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "attributes") stripDlTarget(m.target);
      else for (const n of m.addedNodes) if (n.nodeType === 1) queuedSweepRoots.add(n);
    }
    if (!sweepTimer && queuedSweepRoots.size) sweepTimer = setTimeout(runSweeps, 50);
  });
  var observeSweeps = () => sweepObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["target", "download"]
  });
  function registerAddedNodeSweep(fn) {
    addedNodeSweeps.push(fn);
  }
  function initDownloadAnchors() {
    sweepDlAnchors(document.documentElement);
    watchDeniedDownloads(window, carrierVerifyResult, toastDownloadAccessDenied);
    if (!document.hidden) observeSweeps();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        sweepObserver.disconnect();
        clearTimeout(sweepTimer);
        sweepTimer = 0;
        queuedSweepRoots.clear();
      } else {
        observeSweeps();
        for (const fn of addedNodeSweeps) fn(document.documentElement);
      }
    });
    registerAddedNodeSweep(sweepDlAnchors);
    document.addEventListener(
      "click",
      (e) => {
        const a = e.target?.closest?.("a[download]");
        const href = a?.href;
        if (!a || !href || !/^(blob:|data:|https?:)/i.test(href)) return;
        if (a.hasAttribute("data-carrier-native-download")) return;
        if (!e.isTrusted) return;
        a.removeAttribute("target");
        e.preventDefault();
        e.stopImmediatePropagation();
        downloadSrc(href, a.getAttribute("download") || "download").then(({ url }) => toastDownloadSaved(url)).catch((error) => toastDownloadFailure(error));
      },
      true
    );
  }

  // inject/src/messenger/lib/emoji-images.ts
  var FACEBOOK_EMOJI_PATH = "/images/emoji.php/";
  var isFacebookEmojiImage = (value) => typeof value === "string" && value.includes(FACEBOOK_EMOJI_PATH);
  function hasImageArea(rect) {
    return rect.right > rect.left && rect.bottom > rect.top;
  }
  function intersectsImageClip(rect, clip) {
    return !(rect.bottom < clip.top || rect.top > clip.bottom || rect.right < clip.left || rect.left > clip.right);
  }
  function intersectImageClips(left, right) {
    return {
      top: Math.max(left.top, right.top),
      right: Math.min(left.right, right.right),
      bottom: Math.min(left.bottom, right.bottom),
      left: Math.max(left.left, right.left)
    };
  }
  function expandedImageClip(rect, margin) {
    return {
      top: rect.top - margin,
      right: rect.right + margin,
      bottom: rect.bottom + margin,
      left: rect.left - margin
    };
  }

  // inject/src/messenger/features/emoji-images.ts
  var PREFETCH_MARGIN = 80;
  var SCAN_DELAY_MS = 50;
  function rectOf2(element2) {
    const rect = element2.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
  }
  function visibleClipFor(image) {
    let clip = {
      top: -PREFETCH_MARGIN,
      right: innerWidth + PREFETCH_MARGIN,
      bottom: innerHeight + PREFETCH_MARGIN,
      left: -PREFETCH_MARGIN
    };
    const dialog = image.closest('[role="dialog"]');
    if (!dialog) return clip;
    clip = intersectImageClips(clip, expandedImageClip(rectOf2(dialog), PREFETCH_MARGIN));
    let ancestor = image.parentElement;
    while (ancestor && ancestor !== dialog) {
      if (ancestor.scrollHeight > ancestor.clientHeight + 2) {
        clip = intersectImageClips(clip, expandedImageClip(rectOf2(ancestor), PREFETCH_MARGIN));
        break;
      }
      ancestor = ancestor.parentElement;
    }
    return clip;
  }
  function initEmojiImageLoading() {
    const sourceDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    const nativeSetAttribute2 = HTMLImageElement.prototype.setAttribute;
    if (!sourceDescriptor?.set) return;
    const pending = /* @__PURE__ */ new Set();
    let scanTimer;
    const promote = (image) => {
      image.loading = "eager";
      const source = image.currentSrc || image.getAttribute("src") || image.src;
      if (source) sourceDescriptor.set?.call(image, source);
      pending.delete(image);
    };
    const scan = () => {
      scanTimer = void 0;
      for (const image of pending) {
        if (!image.isConnected) {
          pending.delete(image);
          continue;
        }
        const imageRect = rectOf2(image);
        if (hasImageArea(imageRect) && intersectsImageClip(imageRect, visibleClipFor(image))) {
          promote(image);
        }
      }
    };
    const scheduleScan = () => {
      if (scanTimer !== void 0) return;
      scanTimer = window.setTimeout(scan, SCAN_DELAY_MS);
    };
    const defer = (image) => {
      image.loading = "lazy";
      pending.add(image);
      scheduleScan();
    };
    try {
      Object.defineProperty(HTMLImageElement.prototype, "src", {
        configurable: sourceDescriptor.configurable,
        enumerable: sourceDescriptor.enumerable,
        get: sourceDescriptor.get,
        set(value) {
          if (isFacebookEmojiImage(value)) defer(this);
          return sourceDescriptor.set?.call(this, value);
        }
      });
      HTMLImageElement.prototype.setAttribute = function(name, value) {
        const emoji = name.toLowerCase() === "src" && isFacebookEmojiImage(value);
        if (emoji) defer(this);
        const result = nativeSetAttribute2.call(this, name, value);
        if (emoji) scheduleScan();
        return result;
      };
    } catch (_) {
      return;
    }
    document.addEventListener("scroll", scheduleScan, true);
    window.addEventListener("resize", scheduleScan);
    new MutationObserver((records) => {
      if (pending.size === 0) return;
      for (const record4 of records) {
        for (const removed of record4.removedNodes) {
          if (removed instanceof HTMLImageElement) {
            pending.delete(removed);
          } else if (removed instanceof Element) {
            for (const image of removed.querySelectorAll(
              `img[src*="${FACEBOOK_EMOJI_PATH}"]`
            )) {
              pending.delete(image);
            }
          }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // inject/src/messenger/lib/nicknames.ts
  function nicknameMode(settings) {
    if (settings?.nickname_scope) return settings.nickname_scope;
    return settings?.show_nicknames === false ? "off" : settings?.nicknames_group_only ? "groups" : "all";
  }
  function showNicknames(mode, isGroup) {
    return mode === "all" || mode === "groups" && isGroup !== false || mode === "direct" && isGroup !== true;
  }
  var threadContexts = /* @__PURE__ */ new WeakMap();
  function threadContext(react, runtime) {
    let context2 = threadContexts.get(react);
    if (!context2 && runtime.createContext) {
      context2 = runtime.createContext(void 0);
      threadContexts.set(react, context2);
    }
    return context2;
  }
  function patchNicknameThreadContext(value, react, isGroup) {
    if (!value || typeof value !== "object" || !react || typeof react !== "object" || typeof isGroup !== "function")
      return;
    const exports = value;
    const runtime = react;
    const original = exports.Provider;
    if (typeof original !== "function" || wrappedProviders.has(original) || !runtime.createElement)
      return;
    const context2 = threadContext(react, runtime);
    if (!context2) return;
    const { createElement } = runtime;
    const provider = (props) => {
      let group;
      try {
        if (props && typeof props === "object" && "thread" in props && props.thread && typeof props.thread === "object" && "threadType" in props.thread) {
          const result = isGroup(props.thread.threadType);
          if (typeof result === "boolean") group = result;
        }
      } catch (_) {
      }
      return createElement(context2.Provider, {
        value: group,
        children: createElement(original, props)
      });
    };
    try {
      exports.Provider = provider;
      wrappedProviders.add(provider);
    } catch (_) {
    }
  }
  var wrappedProviders = /* @__PURE__ */ new WeakSet();
  function patchNicknameContext(value, react, preference) {
    if (!value || typeof value !== "object" || !react || typeof react !== "object") return;
    const exports = value;
    const runtime = react;
    const original = exports.MWPContactContextProvider;
    if (typeof original !== "function" || wrappedProviders.has(original) || typeof runtime.createElement !== "function" || typeof runtime.useSyncExternalStore !== "function")
      return;
    const { createElement, useSyncExternalStore, useContext } = runtime;
    const context2 = threadContext(react, runtime);
    const provider = function CarrierNicknameProvider(props) {
      const mode = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
      const group = context2 && useContext ? useContext(context2) : void 0;
      const enabled = showNicknames(mode, group);
      if (!enabled && props && typeof props === "object") {
        const record4 = props;
        const contact = record4.contact;
        if (typeof record4.nickname === "string" && contact && typeof contact === "object" && typeof contact.name === "string") {
          return createElement(original, { ...record4, nickname: void 0 });
        }
      }
      return createElement(original, props);
    };
    try {
      exports.MWPContactContextProvider = provider;
      wrappedProviders.add(provider);
    } catch (_) {
    }
  }

  // inject/src/messenger/lib/sender-avatars.ts
  var SENDER_AVATAR_LIMIT = 500;
  var SENDER_AVATAR_VERSION = 3;
  var SENDER_AVATAR_STORAGE_KEY = "__carrier_sender_avatars__";
  var normalizeSenderName = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
  var entryKey = (threadId, name) => `${threadId}\0${normalizeSenderName(name)}`;
  function avatarPhotoId(url) {
    try {
      return new URL(url, "https://www.facebook.com/").pathname;
    } catch (_) {
      return url;
    }
  }
  var COLLISION_WINDOW_MS = 5 * 6e4;
  var GROUP_THREAD_LIMIT = 200;
  var AMBIGUOUS_LIMIT = 200;
  var SenderAvatarStore = class {
    constructor(storage = null, limit = SENDER_AVATAR_LIMIT) {
      __publicField(this, "storage", storage);
      __publicField(this, "limit", limit);
      __publicField(this, "entries", /* @__PURE__ */ new Map());
      __publicField(this, "ambiguous", /* @__PURE__ */ new Set());
      __publicField(this, "groupThreads", /* @__PURE__ */ new Set());
      try {
        const raw = this.storage?.getItem(SENDER_AVATAR_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        const persisted = parsed && typeof parsed === "object" && "version" in parsed && parsed.version === SENDER_AVATAR_VERSION && "entries" in parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
        for (const entry of persisted) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && typeof entry[2] === "string") {
            if (entry[1]) {
              this.entries.set(entry[0], {
                url: entry[1],
                owner: entry[2],
                photo: typeof entry[3] === "string" ? entry[3] : avatarPhotoId(entry[1]),
                at: typeof entry[4] === "number" ? entry[4] : 0
              });
            } else {
              this.ambiguous.add(entry[0]);
            }
          }
        }
        const ambiguous = parsed && typeof parsed === "object" && "ambiguous" in parsed && Array.isArray(parsed.ambiguous) ? parsed.ambiguous : [];
        for (const key of ambiguous) {
          if (typeof key === "string" && key) this.ambiguous.add(key);
        }
        const groups = parsed && typeof parsed === "object" && "groups" in parsed && Array.isArray(parsed.groups) ? parsed.groups : [];
        for (const id of groups) {
          if (typeof id === "string" && id) this.groupThreads.add(id);
        }
      } catch (_) {
      }
      if (this.trim()) this.persist();
    }
    trim() {
      let trimmed = false;
      while (this.entries.size > this.limit) {
        this.entries.delete(this.entries.keys().next().value);
        trimmed = true;
      }
      while (this.ambiguous.size > AMBIGUOUS_LIMIT) {
        this.ambiguous.delete(this.ambiguous.values().next().value);
        trimmed = true;
      }
      while (this.groupThreads.size > GROUP_THREAD_LIMIT) {
        this.groupThreads.delete(this.groupThreads.values().next().value);
        trimmed = true;
      }
      return trimmed;
    }
    persist() {
      try {
        this.storage?.setItem(
          SENDER_AVATAR_STORAGE_KEY,
          JSON.stringify({
            version: SENDER_AVATAR_VERSION,
            entries: [...this.entries].map(([key, entry]) => [
              key,
              entry.url,
              entry.owner,
              entry.photo,
              entry.at
            ]),
            ambiguous: [...this.ambiguous],
            groups: [...this.groupThreads]
          })
        );
      } catch (_) {
      }
    }
    /**
     * Record one name/avatar pairing; returns whether anything changed. `owner`
     * names who the URL belongs to when the key is an alias for them ("Kim" for
     * "Kim Andersen"): an alias two different people answer to identifies
     * neither, so the second claim retires it and the group photo wins instead.
     * Two contacts who share a name across different threads never meet here.
     * Re-seeing an unchanged pairing writes nothing — a rendered thread repeats
     * the same faces on every scan.
     */
    remember(threadId, name, url, owner = name, at = 0) {
      const normalized = normalizeSenderName(name);
      const ownerKey = normalizeSenderName(owner) || normalized;
      if (!threadId || !normalized || !url) return false;
      const key = entryKey(threadId, name);
      if (this.ambiguous.has(key)) return false;
      const photo = avatarPhotoId(url);
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.owner !== ownerKey) return this.markAmbiguous(threadId, name);
        if (existing.photo !== photo && at - existing.at < COLLISION_WINDOW_MS) {
          return this.markAmbiguous(threadId, name);
        }
        if (existing.url === url) {
          const stale = at - existing.at >= COLLISION_WINDOW_MS;
          existing.at = at;
          this.entries.delete(key);
          this.entries.set(key, existing);
          if (stale) this.persist();
          return false;
        }
      }
      this.entries.delete(key);
      this.entries.set(key, { url, owner: ownerKey, photo, at });
      this.trim();
      this.persist();
      return true;
    }
    /**
     * Resolve a preview's sender prefix. Group previews name the sender the same
     * way the thread does ("Kim"), but a members list may hold the full name — so
     * a unique "Kim …" match counts, while several of them do not, even when one
     * of them also cached the short name: showing the wrong person's face is
     * worse than showing the group photo.
     */
    resolve(threadId, name) {
      const normalized = normalizeSenderName(name);
      if (!threadId || !normalized) return { verdict: "no-sender", url: "" };
      const key = entryKey(threadId, name);
      if (this.ambiguous.has(key)) return { verdict: "ambiguous", url: "" };
      const prefix = `${key} `;
      const prefixed = [...this.entries].filter(([candidate]) => candidate.startsWith(prefix));
      const retired = [...this.ambiguous].filter((candidate) => candidate.startsWith(prefix)).length;
      if (prefixed.length + retired > 1 || retired > 0) return { verdict: "ambiguous", url: "" };
      const exact = this.entries.get(key);
      if (exact) {
        const rival = prefixed.some(([, entry]) => entry.owner !== exact.owner);
        return rival ? { verdict: "ambiguous", url: "" } : { verdict: "exact", url: exact.url };
      }
      const only = prefixed[0];
      return only ? { verdict: "full-name", url: only[1].url } : { verdict: "miss", url: "" };
    }
    /** The avatar for a preview's sender prefix, or "" when it is not knowable. */
    lookup(threadId, name) {
      return this.resolve(threadId, name).url;
    }
    /** Why a sender resolves the way it does — for the dev-only MCP probe. */
    describe(threadId, name) {
      return this.resolve(threadId, name).verdict;
    }
    /**
     * Remember that a thread is a group, which only its own message rows can
     * prove (they print the sender's name above each message). A direct message
     * that happens to start with "John: " must not be read as a sender prefix.
     */
    rememberGroupThread(id) {
      if (!id || this.groupThreads.has(id)) return false;
      this.groupThreads.add(id);
      this.trim();
      this.persist();
      return true;
    }
    /**
     * Give up on a name: two people in this thread answer to it. Sticky, and
     * held outside the avatar entries so evicting a face cannot resurrect it.
     */
    markAmbiguous(threadId, name) {
      const normalized = normalizeSenderName(name);
      if (!threadId || !normalized) return false;
      const key = entryKey(threadId, name);
      if (this.ambiguous.has(key)) return false;
      this.ambiguous.add(key);
      this.entries.delete(key);
      const prefix = `${threadId}\0`;
      for (const [candidate, entry] of [...this.entries]) {
        if (!candidate.startsWith(prefix) || entry.owner !== normalized) continue;
        this.entries.delete(candidate);
        this.ambiguous.add(candidate);
      }
      this.trim();
      this.persist();
      return true;
    }
    isGroupThread(id) {
      return this.groupThreads.has(id);
    }
    get size() {
      return this.entries.size;
    }
    /** Counts only, for the dev-only MCP probe. */
    get stats() {
      return {
        avatars: this.entries.size,
        groups: this.groupThreads.size,
        retired: this.ambiguous.size
      };
    }
  };

  // inject/src/messenger/lib/notification-names.ts
  function participantFirstName(person) {
    return person.firstName.trim() || person.name.trim().split(/\s+/u)[0] || person.name;
  }
  function aliases(person) {
    return [person.name, person.firstName, person.nickname].filter(Boolean).map(normalizeSenderName);
  }
  function namedParticipant(name, group) {
    const matches = group.participants.filter(
      (person) => aliases(person).includes(normalizeSenderName(name))
    );
    return matches.length === 1 ? matches[0] : void 0;
  }
  function notificationSenderPrefix(body, group) {
    const matches = /* @__PURE__ */ new Map();
    for (let end2 = body.indexOf(": "); end2 > 0 && end2 <= 200; end2 = body.indexOf(": ", end2 + 2)) {
      const prefix = normalizeSenderName(body.slice(0, end2));
      for (const person2 of group.participants) {
        if (aliases(person2).includes(prefix)) matches.set(person2, end2 + 2);
      }
    }
    if (matches.size !== 1) return void 0;
    const [person, end] = matches.entries().next().value;
    return { person, end };
  }
  function notificationSender(body, group) {
    if (!group?.isGroup) return void 0;
    return notificationSenderPrefix(body, group)?.person;
  }
  function notificationNames(title, body, group, showNicknames2, titleKind = "unknown") {
    if (!group) return { title, body };
    const displayName = (person2) => showNicknames2 && person2.nickname || group.isGroup && person2.firstName || person2.name;
    if (!group.isGroup) {
      const person2 = namedParticipant(title, group);
      return { title: person2 ? displayName(person2) : title, body };
    }
    const kind = titleKind === "unknown" && group.title ? normalizeSenderName(title) === normalizeSenderName(group.title) ? "group" : "sender" : titleKind;
    const person = kind === "sender" ? namedParticipant(title, group) : void 0;
    const prefix = kind === "group" ? notificationSenderPrefix(body, group) : void 0;
    return {
      title: person ? displayName(person) : title,
      body: prefix ? `${displayName(prefix.person)}: ${body.slice(prefix.end)}` : body
    };
  }
  var PARTICIPANT_LIMIT2 = 500;
  async function readConversationNotificationNames(threadId, importModule, timeoutMs = 750) {
    if (!/^\d+$/.test(threadId) || typeof importModule !== "function") return null;
    let timer;
    const read = async () => {
      const singleton = importModule("LSDatabaseSingleton");
      const db = await singleton.LSDatabaseSingleton;
      const i64 = importModule("I64");
      const q = importModule("ReQL");
      const types = importModule("LSMessagingThreadTypeUtil");
      const key = i64.of_string(threadId);
      const thread2 = await db.tables.threads.get(key);
      if (!thread2 || typeof thread2 !== "object" || !("threadType" in thread2)) return null;
      const isGroup = types.isGroup(thread2.threadType) === true;
      if (!isGroup && types.isOneToOne(thread2.threadType) !== true) return null;
      const rows = await q.toArrayAsync(
        q.leftJoin(
          q.fromTableAscending(db.tables.participants).getKeyRange(key),
          q.fromTableAscending(db.tables.contacts)
        ).take(PARTICIPANT_LIMIT2 + 1)
      );
      if (!Array.isArray(rows) || !rows.length || rows.length > PARTICIPANT_LIMIT2) return null;
      let photo;
      let pictureOf;
      try {
        photo = importModule("getLSMediaContactProfilePictureUrl");
      } catch (_) {
      }
      try {
        pictureOf = importModule("getLSMediaThreadPictureUrl");
      } catch (_) {
      }
      const participants = [];
      for (const row of rows) {
        if (!Array.isArray(row)) return null;
        const [participant, contact] = row;
        if (!participant || typeof participant !== "object" || !contact || typeof contact !== "object")
          return null;
        const p = participant;
        const c = contact;
        if (typeof c.name !== "string" || !c.name.trim()) return null;
        let avatar;
        let id;
        try {
          if (c.id != null) id = i64.to_string?.(c.id);
        } catch (_) {
        }
        try {
          if (typeof photo === "function") avatar = photo(contact);
        } catch (_) {
        }
        participants.push({
          ...typeof id === "string" && /^\d+$/.test(id) ? { id } : {},
          name: c.name,
          firstName: typeof c.firstName === "string" ? c.firstName : "",
          nickname: typeof p.nickname === "string" ? p.nickname : "",
          avatar: typeof avatar === "string" ? avatar : ""
        });
      }
      return {
        isGroup,
        title: "threadName" in thread2 && typeof thread2.threadName === "string" ? thread2.threadName : "",
        participants,
        picture: isGroup ? groupPicture(thread2, pictureOf) : ""
      };
    };
    try {
      return await Promise.race([
        read().catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function groupPicture(thread2, pictureOf) {
    try {
      const url = typeof pictureOf === "function" ? pictureOf(thread2) : null;
      return typeof url === "string" && url.startsWith("https://") ? url : "";
    } catch (_) {
      return "";
    }
  }
  function communicationSender(title, body, group, account2, showNicknames2, titleKind, groupTitle = "", photo = false) {
    if (!group || !account2) return void 0;
    const display = (person2) => showNicknames2 && person2.nickname || person2.name;
    if (!group.isGroup) {
      const others = group.participants.filter((person3) => person3.id && person3.id !== account2);
      const person2 = others.length === 1 ? others[0] : void 0;
      return person2?.id ? { id: person2.id, name: display(person2), group: "", photo: true } : void 0;
    }
    const kind = titleKind === "unknown" && group.title ? normalizeSenderName(title) === normalizeSenderName(group.title) ? "group" : "sender" : titleKind;
    const person = kind === "sender" ? namedParticipant(title, group) : notificationSenderPrefix(body, group)?.person;
    const name = group.title || groupTitle;
    if (!person?.id || person.id === account2 || !name) return void 0;
    return { id: person.id, name: display(person), group: name, photo };
  }

  // inject/src/messenger/lib/nickname-replies.ts
  function replyAttribution(text, sender, recipient, info, mode) {
    if (showNicknames(mode, info.isGroup)) return text;
    const person = (id) => info.participants.find((p) => p.id === id);
    const name = (p) => info.isGroup ? participantFirstName(p) : p.name;
    const from = person(sender), to = person(recipient);
    let result = text;
    if (from) {
      const alias = [from.nickname, from.name].find(
        (value) => value && result.startsWith(`${value} `)
      );
      if (alias) result = name(from) + result.slice(alias.length);
    }
    if (to) {
      const alias = [to.nickname, to.name].find((value) => value && result.endsWith(` ${value}`));
      if (alias) result = result.slice(0, -alias.length) + name(to);
    }
    return result;
  }
  var wrapped = /* @__PURE__ */ new WeakSet();
  function patchNicknameReplies(value, importModule, preference, loadNames = (key) => readConversationNotificationNames(
    key,
    globalThis.require
  )) {
    if (!value || typeof value !== "object") return;
    const exports = value, original = exports.default;
    if (typeof original !== "function" || wrapped.has(original)) return;
    const react = importModule("react");
    const i64 = importModule("I64");
    if (typeof react?.useSyncExternalStore !== "function" || typeof react.useState !== "function" || typeof react.useEffect !== "function" || typeof i64?.to_string !== "function")
      return;
    const { useSyncExternalStore, useState, useEffect } = react, { to_string: stringify } = i64;
    const pending = /* @__PURE__ */ new Map();
    const readNames = (key) => {
      const existing = pending.get(key);
      if (existing) return existing;
      const request = loadNames(key);
      pending.set(key, request);
      void request.then(
        () => pending.delete(key),
        () => pending.delete(key)
      );
      return request;
    };
    const hook = function useCarrierReplyAttribution(...args) {
      const text = Reflect.apply(original, this, args);
      const mode = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
      const [names2, setNames] = useState(null);
      const message = args[0];
      const id = (field) => {
        try {
          if (message && typeof message === "object" && field in message) {
            const value2 = stringify(message[field]);
            if (typeof value2 === "string" && /^\d+$/.test(value2)) return value2;
          }
        } catch (_) {
        }
        return "";
      };
      const key = id("threadKey"), sender = id("senderId"), recipient = id("replyToUserId");
      useEffect(() => {
        if (!key || typeof text !== "string" || !text) return;
        let cancelled = false;
        readNames(key).then((info) => {
          if (!cancelled) setNames({ key, info });
        }).catch(() => {
        });
        return () => {
          cancelled = true;
        };
      }, [key, text, mode]);
      return typeof text === "string" && names2?.key === key && names2.info ? replyAttribution(text, sender, recipient, names2.info, mode) : text;
    };
    try {
      exports.default = hook;
      wrapped.add(hook);
    } catch (_) {
    }
  }

  // inject/src/messenger/lib/nickname-snippets.ts
  var NativeSnippetPrefixes = class {
    constructor() {
      __publicField(this, "entries", /* @__PURE__ */ new Map());
      __publicField(this, "drafts", /* @__PURE__ */ new Map());
    }
    rememberDraft(thread2, owner, snippet, draft) {
      if (!/^\d+$/.test(thread2)) return;
      if (!draft) return this.forgetDraft(thread2, owner);
      const entries = this.drafts.get(thread2) ?? /* @__PURE__ */ new Map();
      entries.set(owner, snippet.replace(/\s+/g, " ").trim());
      this.drafts.set(thread2, entries);
    }
    forgetDraft(thread2, owner) {
      const entries = this.drafts.get(thread2);
      entries?.delete(owner);
      if (entries?.size === 0) this.drafts.delete(thread2);
    }
    isDraft(thread2, body) {
      const preview = body.replace(/\s+/g, " ").trim();
      const drafts = this.drafts.get(thread2);
      if (!drafts?.size) return false;
      const label2 = /^(?:Draft|Utkast):\s*/iu.exec(preview)?.[0];
      if (!label2) return false;
      if (preview === label2.trim()) return true;
      return [...drafts.values()].some((snippet) => {
        if (snippet.slice(0, 240) === preview) return true;
        return `${label2}${snippet}`.slice(0, 240) === preview;
      });
    }
    remember(thread2, original, displayed) {
      this.entries.delete(thread2);
      if (!/^\d+$/.test(thread2) || original === displayed) return;
      const normalize = (text) => text.replace(/\s+/g, " ");
      this.entries.set(thread2, { original: normalize(original), displayed: normalize(displayed) });
      if (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value);
    }
    original(thread2, text) {
      const entry = this.entries.get(thread2);
      return entry && text.startsWith(entry.displayed) ? entry.original + text.slice(entry.displayed.length) : text;
    }
  };
  var nativeSnippetPrefixes = new NativeSnippetPrefixes();
  var wrapped2 = /* @__PURE__ */ new WeakSet();
  function patchNicknameSnippets(value, importModule, preference, loadNames = (key) => readConversationNotificationNames(
    key,
    globalThis.require
  ), prefixes = nativeSnippetPrefixes) {
    if (!value || typeof value !== "object") return;
    const exports = value;
    const original = exports.default;
    if (typeof original !== "function" || wrapped2.has(original)) return;
    const react = importModule("react");
    const i64 = importModule("I64");
    const vault = importModule("ReStoreVaulting");
    if (typeof react?.createElement !== "function" || typeof react.useSyncExternalStore !== "function" || typeof react.useState !== "function" || typeof react.useRef !== "function" || typeof react.useEffect !== "function" || typeof react.useLayoutEffect !== "function" || typeof i64?.to_string !== "function" || typeof vault?.maybeUnvault !== "function")
      return;
    const { createElement, useSyncExternalStore, useState, useRef, useEffect, useLayoutEffect } = react;
    const { to_string: threadKey } = i64;
    const { maybeUnvault } = vault;
    const component = function CarrierNicknameSnippet(props) {
      const mode = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
      const [names2, setNames] = useState(null);
      const owner = useRef({}).current;
      const record4 = props && typeof props === "object" ? props : {};
      const thread2 = record4.thread;
      let key = "", snippet = "";
      try {
        if (thread2 && typeof thread2 === "object" && "threadKey" in thread2) {
          const id = threadKey(thread2.threadKey);
          if (typeof id === "string") key = id;
        }
        const raw = typeof record4.snippetRaw === "string" ? maybeUnvault(record4.snippetRaw) ?? record4.snippetRaw : null;
        if (typeof raw === "string") snippet = raw;
      } catch (_) {
      }
      const draft = record4.isDraftMessage === true;
      useEffect(() => {
        if (!key || !snippet.includes(": ") || draft || showNicknames(mode, true)) return;
        let cancelled = false;
        loadNames(key).then((info2) => {
          if (!cancelled) setNames({ key, snippet, info: info2 });
        }).catch(() => {
        });
        return () => {
          cancelled = true;
        };
      }, [key, snippet, draft, mode]);
      const info = !draft && names2?.key === key && names2.snippet === snippet ? names2.info : null;
      const sender = info ? notificationSenderPrefix(snippet, info) : void 0;
      let displayed = snippet;
      if (sender && info?.isGroup) {
        const name = showNicknames(mode, info.isGroup) && sender.person.nickname || participantFirstName(sender.person);
        displayed = `${name}: ${snippet.slice(sender.end)}`;
      }
      const tail = sender ? snippet.slice(sender.end) : snippet;
      const originalPrefix = sender ? snippet.slice(0, sender.end) : "";
      const displayedPrefix = displayed.slice(0, displayed.length - tail.length);
      useLayoutEffect(() => {
        prefixes.remember(key, originalPrefix, displayedPrefix);
      }, [key, originalPrefix, displayedPrefix]);
      useLayoutEffect(() => {
        prefixes.rememberDraft(key, owner, snippet, draft);
        return () => prefixes.forgetDraft(key, owner);
      }, [key, owner, snippet, draft]);
      return createElement(
        original,
        displayed !== snippet ? { ...record4, snippetRaw: displayed } : props
      );
    };
    try {
      exports.default = component;
      wrapped2.add(component);
    } catch (_) {
    }
  }

  // inject/src/messenger/lib/nickname-thread-titles.ts
  var NativeThreadTitles = class {
    constructor() {
      __publicField(this, "titles", /* @__PURE__ */ new Map());
    }
    remember(thread2, original, displayed) {
      if (!/^\d+$/.test(thread2)) return;
      const normalize = (value) => value.replace(/\s+/g, " ").trim().slice(0, 80);
      this.titles.delete(thread2);
      this.titles.set(thread2, { original: normalize(original), displayed: normalize(displayed) });
      if (this.titles.size > 500) this.titles.delete(this.titles.keys().next().value);
    }
    displayed(thread2, original, fallback = original) {
      const entry = this.titles.get(thread2);
      return entry?.original === original ? entry.displayed : fallback;
    }
    original(thread2, displayed) {
      const entry = this.titles.get(thread2);
      return entry?.displayed === displayed ? entry.original : displayed;
    }
  };
  var nativeThreadTitles = new NativeThreadTitles();
  var wrappedHooks = /* @__PURE__ */ new WeakSet();
  function patchNicknameThreadTitles(value, importModule, preference, titles = nativeThreadTitles) {
    if (!value || typeof value !== "object") return;
    const exports = value;
    const original = exports.default;
    if (typeof original !== "function" || wrappedHooks.has(original)) return;
    const react = importModule("react");
    const compute = importModule("MWPGetThreadTitle");
    const i64 = importModule("I64");
    const listModule = importModule("intlList");
    const intlList = listModule?.default ?? listModule;
    const types = importModule("LSMessagingThreadTypeUtil");
    const computeTitle = compute?.computeThreadTitle;
    const threadKey = i64?.to_string;
    if (typeof react?.useSyncExternalStore !== "function" || typeof react.useMemo !== "function" || typeof computeTitle !== "function" || typeof threadKey !== "function")
      return;
    const { useSyncExternalStore, useMemo } = react;
    const wrapped3 = new Proxy(original, {
      apply(target, receiver, args) {
        const mode = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
        const result = Reflect.apply(target, receiver, args);
        return useMemo(() => {
          if (!result || typeof result !== "object") return result;
          const record4 = result;
          const thread2 = args[0];
          if (!thread2 || typeof thread2 !== "object" || !("threadKey" in thread2) || !("threadType" in thread2) || typeof record4.threadTitle !== "string" || !Array.isArray(record4.participantsAndContacts))
            return result;
          try {
            let displayed = record4.threadTitle;
            const group = typeof types?.isGroup === "function" ? types.isGroup(thread2.threadType) === true : void 0;
            if (!showNicknames(mode, group)) {
              const pairs = record4.participantsAndContacts.map((pair) => {
                if (!Array.isArray(pair)) return pair;
                const [participant, contact] = pair;
                if (!participant || typeof participant !== "object" || !contact || typeof contact !== "object" || !("name" in contact) || typeof contact.name !== "string")
                  return pair;
                return [{ ...participant, nickname: void 0 }, contact];
              });
              const computed = computeTitle(
                intlList.CONJUNCTIONS?.NONE,
                thread2.threadType,
                pairs,
                record4.actorId
              );
              if (typeof computed === "string") displayed = computed;
            }
            const key = threadKey(thread2.threadKey);
            if (typeof key === "string") titles.remember(key, record4.threadTitle, displayed);
            return displayed === record4.threadTitle ? result : { ...record4, threadTitle: displayed };
          } catch (_) {
            return result;
          }
        }, [result, args[0], mode]);
      }
    });
    try {
      exports.default = wrapped3;
      wrappedHooks.add(wrapped3);
    } catch (_) {
    }
  }

  // inject/src/messenger/lib/facebook-modules.ts
  function isConversationSearchInput({
    hasAccessibleName,
    insideForm,
    insideMain,
    role,
    type
  }) {
    if (!insideMain || insideForm) return false;
    return type === "search" || role === "searchbox" || type === "text" && role === null && hasAccessibleName;
  }
  var NULL_COMPONENT_MODULES = /* @__PURE__ */ new Set([
    // Carrier's CSS already hides this entire Facebook-wide header tree. Removing
    // the React root prevents its search, notification, account, and portal work.
    "CometBaseAppNavigation.react",
    // Messenger's server-driven promotion banner is not part of messaging.
    "MWInboxQuickPromotionWrapper.react",
    "MWInboxQuickPromotionWrapperImportUnconditionally.react",
    "MAWSecureThreadQuickPromotion.react",
    "MWThreadListQP.react",
    "MWMessageSearchEBRestoreUpsell.react",
    // Carrier owns desktop notification delivery; Facebook's browser-push root
    // is redundant inside the native WebView.
    "CometBrowserPushRoot.react",
    // Casting is Facebook-wide video chrome, not Messenger media playback.
    "CometCastingMiniplayerRoot.react"
  ]);
  var TELEMETRY_MODULES = /* @__PURE__ */ new Set([
    "Banzai",
    "FalcoLoggerInternal",
    "ODS",
    "TimeSpentImmediateActiveSecondsLogger",
    "TimeSpentImmediateActiveSecondsLoggerComet"
  ]);
  var BACKGROUND_SERVICE_MODULES = /* @__PURE__ */ new Set(["MAWFTSRestoreSync"]);
  var ODS_METHODS = ["bumpEntityKey", "bumpFraction", "flush", "setEntitySample"];
  var FALCO_METHODS = ["log", "logAsync", "logCritical", "logImmediately"];
  var wrappedTelemetryMethods = /* @__PURE__ */ new WeakSet();
  var wrappedFalcoFactories = /* @__PURE__ */ new WeakSet();
  function nullComponent() {
    return null;
  }
  Object.defineProperty(nullComponent, "displayName", {
    value: "CarrierNullFacebookComponent"
  });
  function replaceFunctionExport(value, replacement) {
    if (typeof value === "function") return replacement;
    if (!value || typeof value !== "object") return value;
    const record4 = value;
    if (typeof record4.default === "function") {
      try {
        record4.default = replacement;
      } catch (_) {
      }
    }
    return value;
  }
  function replaceComponentExports(result, factoryArgs, replacement) {
    const firstExportIndex = Math.max(0, factoryArgs.length - 2);
    for (let index = firstExportIndex; index < factoryArgs.length; index++) {
      const candidate = factoryArgs[index];
      if (!candidate || typeof candidate !== "object") continue;
      const record4 = candidate;
      if (Object.prototype.hasOwnProperty.call(record4, "exports")) {
        try {
          record4.exports = replaceFunctionExport(record4.exports, replacement);
        } catch (_) {
        }
      }
      replaceFunctionExport(record4, replacement);
    }
    return replaceFunctionExport(result, replacement);
  }
  function findFTSRestoreSync(value, seen) {
    if (!value || typeof value !== "object" || seen.has(value)) return void 0;
    seen.add(value);
    const record4 = value;
    const getter = record4.getFTSRestoreSync;
    if (typeof getter === "function") {
      try {
        const restore2 = Reflect.apply(getter, value, []);
        if (restore2 && typeof restore2.setKeepWhileLoop_FOR_TESTING_ONLY === "function" && typeof restore2.setIsStarted === "function" && typeof restore2.startSyncingLoop === "function") {
          return restore2;
        }
      } catch (_) {
      }
    }
    return findFTSRestoreSync(record4.default, seen);
  }
  function captureFTSRestoreSync(result, factoryArgs, onFTSRestoreSync) {
    const seen = /* @__PURE__ */ new WeakSet();
    const inspect2 = (value) => {
      const restore2 = findFTSRestoreSync(value, seen);
      if (restore2) onFTSRestoreSync(restore2);
    };
    inspect2(result);
    for (let index = 4; index < factoryArgs.length; index++) {
      const candidate = factoryArgs[index];
      inspect2(candidate);
      if (candidate && typeof candidate === "object") {
        inspect2(candidate.exports);
      }
    }
  }
  var FacebookFTSIdleCoordinator = class {
    constructor() {
      __publicField(this, "active", false);
      __publicField(this, "restores", /* @__PURE__ */ new Set());
    }
    register(restore2) {
      if (this.restores.has(restore2)) return;
      this.restores.add(restore2);
      if (this.active) this.start(restore2);
      else this.stop(restore2);
    }
    wake() {
      if (this.active) return;
      this.active = true;
      for (const restore2 of this.restores) this.start(restore2);
    }
    pause() {
      this.active = false;
      for (const restore2 of this.restores) this.stop(restore2);
    }
    start(restore2) {
      try {
        restore2.setKeepWhileLoop_FOR_TESTING_ONLY(true);
        restore2.setIsStarted(false);
        const result = restore2.startSyncingLoop();
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch(() => {
          });
        }
      } catch (_) {
      }
    }
    stop(restore2) {
      try {
        restore2.setKeepWhileLoop_FOR_TESTING_ONLY(false);
      } catch (_) {
      }
    }
  };
  function wrapTelemetryMethod(record4, key, shouldBlockTelemetry) {
    const original = record4[key];
    if (typeof original !== "function" || wrappedTelemetryMethods.has(original)) return;
    const wrapped3 = function(...args) {
      if (shouldBlockTelemetry()) return void 0;
      return Reflect.apply(original, this, args);
    };
    wrappedTelemetryMethods.add(wrapped3);
    try {
      record4[key] = wrapped3;
    } catch (_) {
    }
  }
  function patchFalcoLogger(value, shouldBlockTelemetry) {
    if (!value || typeof value !== "object") return;
    const logger = value;
    for (const method2 of FALCO_METHODS) {
      wrapTelemetryMethod(logger, method2, shouldBlockTelemetry);
    }
  }
  function wrapFalcoFactory(record4, shouldBlockTelemetry) {
    const original = record4.create;
    if (typeof original !== "function" || wrappedFalcoFactories.has(original)) return;
    const wrapped3 = function(...args) {
      const logger = Reflect.apply(original, this, args);
      patchFalcoLogger(logger, shouldBlockTelemetry);
      return logger;
    };
    wrappedFalcoFactories.add(wrapped3);
    try {
      record4.create = wrapped3;
    } catch (_) {
    }
  }
  function patchTelemetryValue(moduleName, value, shouldBlockTelemetry) {
    if (!value || typeof value !== "object") return;
    const record4 = value;
    if (moduleName === "FalcoLoggerInternal") {
      wrapFalcoFactory(record4, shouldBlockTelemetry);
    } else {
      const methods = moduleName === "Banzai" ? ["post"] : moduleName === "ODS" ? ODS_METHODS : ["maybeReportActiveSecond"];
      for (const method2 of methods) wrapTelemetryMethod(record4, method2, shouldBlockTelemetry);
    }
    if (record4.default && record4.default !== value && typeof record4.default === "object") {
      patchTelemetryValue(moduleName, record4.default, shouldBlockTelemetry);
    }
  }
  function patchTelemetryExports(moduleName, result, factoryArgs, shouldBlockTelemetry) {
    patchTelemetryValue(moduleName, result, shouldBlockTelemetry);
    for (let index = 4; index < factoryArgs.length; index++) {
      const candidate = factoryArgs[index];
      patchTelemetryValue(moduleName, candidate, shouldBlockTelemetry);
      if (!candidate || typeof candidate !== "object") continue;
      patchTelemetryValue(
        moduleName,
        candidate.exports,
        shouldBlockTelemetry
      );
    }
    return result;
  }
  function wrapFactory(moduleName, factory, shouldBlockTelemetry, onFTSRestoreSync, onFacebookError, onWorkerSetup, onProcessingLogger, onWorkerLifecycle, nicknamePreference) {
    const wrapped3 = function(...factoryArgs) {
      const result = Reflect.apply(factory, this, factoryArgs);
      if ((moduleName === "MWPContactContext.react" || moduleName === "useLSGetThreadTitle.react" || moduleName === "MWPThreadCapabilitiesContext" || moduleName === "MWThreadSnippetForDisplay.react" || moduleName === "useMWReplySnippetContent") && nicknamePreference) {
        try {
          const importModule = factoryArgs[3];
          if (typeof importModule === "function") {
            const react = importModule("react");
            const patch = (value) => {
              if (moduleName === "useMWReplySnippetContent") {
                patchNicknameReplies(value, (name) => importModule(name), nicknamePreference);
              } else if (moduleName === "MWThreadSnippetForDisplay.react") {
                patchNicknameSnippets(value, (name) => importModule(name), nicknamePreference);
              } else if (moduleName === "useLSGetThreadTitle.react") {
                patchNicknameThreadTitles(value, (name) => importModule(name), nicknamePreference);
              } else if (moduleName === "MWPThreadCapabilitiesContext") {
                const types = importModule("LSMessagingThreadTypeUtil");
                patchNicknameThreadContext(value, react, types?.isGroup);
              } else patchNicknameContext(value, react, nicknamePreference);
            };
            for (const candidate of [result, ...factoryArgs.slice(-2)]) {
              patch(candidate);
              if (candidate && typeof candidate === "object") {
                patch(candidate.exports);
              }
            }
          }
        } catch (_) {
        }
        return result;
      }
      if (moduleName === "MAWSetupWorker" || moduleName === "MAWWebWorkerSingleton" || moduleName === "shouldUseMAWSharedWorker" || moduleName === "MAWBridgeUIEventQueueQPLLogger") {
        const observe = moduleName === "MAWSetupWorker" ? onWorkerSetup : moduleName === "MAWWebWorkerSingleton" ? onWorkerLifecycle : moduleName === "shouldUseMAWSharedWorker" ? preferDedicatedWorkerExports : onProcessingLogger;
        for (const candidate of [result, ...factoryArgs.slice(-2)]) {
          try {
            observe(candidate);
            if (candidate && typeof candidate === "object") {
              observe(candidate.exports);
            }
          } catch (_) {
          }
        }
        return result;
      }
      if (moduleName === "ErrorPubSub") {
        observeFacebookErrors(result, factoryArgs, onFacebookError);
        return result;
      }
      if (NULL_COMPONENT_MODULES.has(moduleName)) {
        return replaceComponentExports(result, factoryArgs, nullComponent);
      }
      if (BACKGROUND_SERVICE_MODULES.has(moduleName)) {
        captureFTSRestoreSync(result, factoryArgs, onFTSRestoreSync);
        return result;
      }
      return patchTelemetryExports(moduleName, result, factoryArgs, shouldBlockTelemetry);
    };
    try {
      Object.defineProperty(wrapped3, "length", { value: factory.length });
    } catch (_) {
    }
    return wrapped3;
  }
  function createFacebookModuleDefineInterceptor(define, shouldBlockTelemetry, onFTSRestoreSync = () => {
  }, onFacebookError = () => {
  }, onWorkerSetup = () => {
  }, onProcessingLogger = () => {
  }, onWorkerLifecycle = () => {
  }, preferDedicatedWorker = false, nicknamePreference) {
    return new Proxy(define, {
      apply(target, thisArg, args) {
        const moduleName = args[0];
        const factory = args[2];
        if (typeof moduleName === "string" && typeof factory === "function" && (moduleName === "MAWSetupWorker" || nicknamePreference !== void 0 && (moduleName === "MWPContactContext.react" || moduleName === "useLSGetThreadTitle.react" || moduleName === "MWPThreadCapabilitiesContext" || moduleName === "MWThreadSnippetForDisplay.react" || moduleName === "useMWReplySnippetContent") || preferDedicatedWorker && moduleName === "shouldUseMAWSharedWorker" || moduleName === "MAWWebWorkerSingleton" || moduleName === "MAWBridgeUIEventQueueQPLLogger" || moduleName === "ErrorPubSub" || NULL_COMPONENT_MODULES.has(moduleName) || TELEMETRY_MODULES.has(moduleName) || BACKGROUND_SERVICE_MODULES.has(moduleName))) {
          if ((moduleName === "useLSGetThreadTitle.react" || moduleName === "MWPThreadCapabilitiesContext" || moduleName === "MWThreadSnippetForDisplay.react" || moduleName === "useMWReplySnippetContent") && Array.isArray(args[1])) {
            args[1] = [.../* @__PURE__ */ new Set([...args[1], "react", "I64", "LSMessagingThreadTypeUtil"])];
          }
          if (moduleName === "MWThreadSnippetForDisplay.react" && Array.isArray(args[1])) {
            args[1] = [.../* @__PURE__ */ new Set([...args[1], "ReStoreVaulting"])];
          }
          args[2] = wrapFactory(
            moduleName,
            factory,
            shouldBlockTelemetry,
            onFTSRestoreSync,
            onFacebookError,
            onWorkerSetup,
            onProcessingLogger,
            onWorkerLifecycle,
            nicknamePreference
          );
        }
        return Reflect.apply(target, thisArg, args);
      }
    });
  }
  var dedicatedWorkerGates = /* @__PURE__ */ new WeakSet();
  function preferDedicatedWorkerExports(value) {
    if (!value || typeof value !== "object") return;
    const exports = value;
    const gate = exports.shouldUseMAWSharedWorker;
    if (typeof gate !== "function" || gate.length !== 0 || dedicatedWorkerGates.has(gate)) return;
    const wrapped3 = new Proxy(gate, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        return typeof result === "boolean" ? false : result;
      }
    });
    exports.shouldUseMAWSharedWorker = wrapped3;
    dedicatedWorkerGates.add(wrapped3);
  }
  var observedErrorStreams = /* @__PURE__ */ new WeakSet();
  function observeFacebookErrors(result, args, listener) {
    const inspect2 = (value) => {
      if (!value || typeof value !== "object" || observedErrorStreams.has(value)) return;
      try {
        const stream = value;
        if (typeof stream.addListener !== "function") return;
        observedErrorStreams.add(value);
        Reflect.apply(stream.addListener, value, [
          (error) => {
            try {
              listener(error);
            } catch (_) {
            }
          }
        ]);
      } catch (_) {
      }
    };
    for (const value of [result, ...args.slice(-2)]) {
      try {
        inspect2(value);
        if (value && typeof value === "object") {
          const record4 = value;
          inspect2(record4.default);
          inspect2(record4.exports);
          if (record4.exports && typeof record4.exports === "object") {
            inspect2(record4.exports.default);
          }
        }
      } catch (_) {
      }
    }
  }

  // inject/src/messenger/lib/messenger-sounds.ts
  function playsMessageSound(state2) {
    if (state2.globallyMuted || state2.oldNews) return false;
    return state2.focused || !state2.nativeSoundOn;
  }

  // inject/src/messenger/lib/mute.ts
  var MUTE_LABEL_LIMIT = 60;
  var MUTED_STATUS_RE = /^(?:(?:notifications?\s+)?muted(?:\s+notifications?)?|this chat is muted|notifications are (?:muted|off)|stummgeschaltet|en sourdine|silenciado|silenziata|dempet|gedempt|tystad)$/i;
  var UNMUTE_ACTION_RE = /^(?:un(?:-)?mute(?: notifications?)?|turn on notifications|stummschaltung aufheben)$/i;
  var MUTE_ACTION_RE = /^(?:mute(?: notifications?)?|turn off notifications)$/i;
  var LABEL_ATTRS = ["aria-label", "title", "aria-description"];
  var MUTE_ACTION_ROLES = /* @__PURE__ */ new Set(["button", "menuitem", "menuitemcheckbox", "switch"]);
  var STATEFUL_MUTE_ROLES = /* @__PURE__ */ new Set(["menuitemcheckbox", "switch"]);
  var MUTED_ROW_ICON_SHAPE = 2001357332;
  var MUTED_ROW_ICON_PATH_PREFIX = "M2.5 6c0-.322";
  var MUTED_ROW_ICON_MAX_RIGHT_GAP = 64;
  var MUTED_THREAD_LIMIT = 500;
  var MUTE_ABSENCE_CONFIRM_MS = 1e3;
  var MUTE_ABSENCE_MIN_OBSERVATIONS = 2;
  function mutedConversationPolicy(settings) {
    const policy = settings?.muted_conversations;
    if (policy === "ignore" || policy === "badge" || policy === "include") return policy;
    return settings?.ignore_muted_conversations === false ? "include" : "ignore";
  }
  function ignoresMutedConversations(settings) {
    return mutedConversationPolicy(settings) !== "include";
  }
  function badgeIgnoresMutedConversations(settings) {
    return mutedConversationPolicy(settings) === "ignore";
  }
  function suppressMutedDelivery(muted, settings) {
    return muted && ignoresMutedConversations(settings);
  }
  function notificationsGloballyMuted(settings, now = Date.now()) {
    const pausedUntil = settings?.notifications_paused_until;
    return settings?.mute_notifications === true || typeof pausedUntil === "number" && pausedUntil > now || messengerDndActive(now);
  }
  function suppressNotificationDelivery(muted, settings) {
    return notificationsGloballyMuted(settings) || suppressMutedDelivery(muted, settings);
  }
  function conversationMuteFromLabel(value) {
    const text = (value || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > MUTE_LABEL_LIMIT) return null;
    if (UNMUTE_ACTION_RE.test(text) || MUTED_STATUS_RE.test(text)) return true;
    if (MUTE_ACTION_RE.test(text) && !/\bmuted\b/i.test(text)) return false;
    return null;
  }
  function isExplicitUnmuteAction(value) {
    return muteStateAfterExplicitAction(value) === false;
  }
  function muteStateAfterExplicitAction(value) {
    const text = (value || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > MUTE_LABEL_LIMIT) return void 0;
    if (UNMUTE_ACTION_RE.test(text)) return false;
    if (MUTE_ACTION_RE.test(text) && !/\bmuted\b/i.test(text)) return true;
    return void 0;
  }
  function muteStateAfterControlAction(value, role, ariaChecked) {
    const text = (value || "").replace(/\s+/g, " ").trim();
    const normalizedRole = (role || "").toLowerCase();
    if (MUTE_ACTION_RE.test(text) && STATEFUL_MUTE_ROLES.has(normalizedRole)) {
      if (ariaChecked === "true") return false;
      if (ariaChecked === "false") return true;
      return void 0;
    }
    return muteStateAfterExplicitAction(text);
  }
  function muteSignalFromSource(source) {
    if (source.attribute === "alt") return null;
    const text = (source.value || "").replace(/\s+/g, " ").trim();
    const signal = conversationMuteFromLabel(text);
    if (signal === null) return null;
    const tag = source.tagName.toLowerCase();
    const role = (source.role || "").toLowerCase();
    if (MUTE_ACTION_RE.test(text) && STATEFUL_MUTE_ROLES.has(role)) {
      if (source.ariaChecked === "true") return true;
      if (source.ariaChecked === "false") return false;
      return null;
    }
    if (UNMUTE_ACTION_RE.test(text) || MUTE_ACTION_RE.test(text)) {
      return tag === "button" || MUTE_ACTION_ROLES.has(role) ? signal : null;
    }
    if (tag === "a" || tag === "img" || role === "link" || role === "row" || role === "gridcell") {
      return null;
    }
    return tag === "svg" || role === "img" || source.containsSvg === true ? signal : null;
  }
  function muteSignalFromLabels(labels) {
    let muted = false;
    let unmuted = false;
    for (const label2 of labels) {
      const signal = conversationMuteFromLabel(label2);
      if (signal === true) muted = true;
      else if (signal === false) unmuted = true;
    }
    if (muted) return true;
    if (unmuted) return false;
    return null;
  }
  function isMutedRowIconShape(shape) {
    return shape.width >= 14 && shape.width <= 18 && shape.height >= 14 && shape.height <= 18 && shape.rightGap >= 8 && shape.rightGap <= MUTED_ROW_ICON_MAX_RIGHT_GAP && !shape.interactive && shape.ariaHidden && shape.viewBox.replace(/\s+/g, " ").trim() === "0 0 16 16" && shape.pathCount === 1 && (shape.shapeHash === MUTED_ROW_ICON_SHAPE || shape.pathPrefixMatched);
  }
  var svgShapeHash = (svg) => {
    let shapeText = "";
    for (const shape of svg.querySelectorAll("path, line, polyline, circle")) {
      shapeText += `${shape.tagName}:${shape.getAttribute("d") || ""}:${shape.getAttribute("points") || ""}:${shape.getAttribute("cx") || ""}:${shape.getAttribute("cy") || ""};`;
    }
    let hash = 2166136261;
    for (let index = 0; index < shapeText.length; index++) {
      hash ^= shapeText.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };
  function hasMutedRowIcon(root) {
    if (!(root instanceof Element)) return false;
    const rootRect = root.getBoundingClientRect();
    for (const svg of root.querySelectorAll("svg")) {
      const rect = svg.getBoundingClientRect();
      if (isMutedRowIconShape({
        width: rect.width,
        height: rect.height,
        rightGap: rootRect.right - rect.right,
        interactive: !!svg.closest(
          'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="switch"]'
        ),
        ariaHidden: svg.getAttribute("aria-hidden") === "true",
        viewBox: svg.getAttribute("viewBox") || "",
        pathCount: svg.querySelectorAll("path").length,
        shapeHash: svgShapeHash(svg),
        pathPrefixMatched: svg.querySelector("path[d]")?.getAttribute("d")?.replace(/\s+/g, " ").trim().startsWith(MUTED_ROW_ICON_PATH_PREFIX) === true
      })) {
        return true;
      }
    }
    return false;
  }
  function resolveMuteObservation(labels) {
    const signal = muteSignalFromLabels(labels);
    if (signal !== null) return signal;
    return void 0;
  }
  function collectMuteLabels(root, includeActions = true) {
    const labels = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (value) => {
      const text = (value || "").replace(/\s+/g, " ").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      labels.push(text);
    };
    const inspect2 = (el) => {
      for (const attr of LABEL_ATTRS) {
        const value = el.getAttribute(attr);
        if (!includeActions && value && (isExplicitUnmuteAction(value) || MUTE_ACTION_RE.test(value.replace(/\s+/g, " ").trim()))) {
          continue;
        }
        if (value) {
          const signal = muteSignalFromSource({
            value,
            tagName: el.tagName,
            role: el.getAttribute("role"),
            attribute: attr,
            containsSvg: [...el.children].some((child) => child.tagName.toLowerCase() === "svg"),
            ariaChecked: el.getAttribute("aria-checked")
          });
          if (signal !== null) push(signal ? "Muted" : "Mute");
        }
      }
    };
    if (root instanceof Element) inspect2(root);
    for (const el of root.querySelectorAll("[aria-label], [title], [aria-description]")) {
      inspect2(el);
    }
    for (const el of root.querySelectorAll("svg title, svg desc")) push(el.textContent);
    return labels;
  }
  var MutedThreadStore = class {
    constructor() {
      __publicField(this, "states", /* @__PURE__ */ new Map());
      __publicField(this, "rowAbsences", /* @__PURE__ */ new Map());
    }
    observe(id, muted) {
      if (!id || muted === void 0) return;
      this.rowAbsences.delete(id);
      if (this.states.has(id)) this.states.delete(id);
      this.states.set(id, muted);
      if (this.states.size > MUTED_THREAD_LIMIT) {
        const oldest = this.states.keys().next().value;
        this.states.delete(oldest);
        this.rowAbsences.delete(oldest);
      }
    }
    observeMountedRow(id, muted, observedAt = Date.now()) {
      if (!id) return;
      if (muted !== void 0) {
        this.observe(id, muted);
        return;
      }
      if (!this.isMuted(id)) {
        this.rowAbsences.delete(id);
        return;
      }
      const absence = this.rowAbsences.get(id);
      if (absence === void 0 || observedAt < absence.since) {
        this.rowAbsences.set(id, { since: observedAt, observations: 1 });
        return;
      }
      absence.observations += 1;
      if (observedAt - absence.since >= MUTE_ABSENCE_CONFIRM_MS && absence.observations >= MUTE_ABSENCE_MIN_OBSERVATIONS) {
        this.observe(id, false);
      }
    }
    isMuted(id) {
      return this.states.get(id) === true;
    }
    invalidateMute(id) {
      if (id) this.observe(id, false);
    }
    knownMutedUnread(unreadIds) {
      for (const id of unreadIds) {
        if (this.states.get(id) === true) return true;
      }
      return false;
    }
  };
  var mutedThreads = new MutedThreadStore();
  var actionInvalidationStarted = false;
  var threadIdFromActionTarget = (target) => {
    const row = target.closest('[role="row"]');
    const href = row?.querySelector('a[href*="/t/"]')?.getAttribute("href") || "";
    return threadIdFromHref(href) || "";
  };
  function resolveMuteActionThreadId(rowId, openId, recentRowId, actionIsInOpenSurface) {
    if (rowId) return rowId;
    if (actionIsInOpenSurface && openId) return openId;
    return recentRowId || openId;
  }
  function initMuteActionTracking() {
    if (actionInvalidationStarted) return;
    actionInvalidationStarted = true;
    let recentRow = null;
    const rememberRow = (target) => {
      if (!(target instanceof Element)) return;
      if (target.closest('[role="menu"], [role="menuitem"], [role="menuitemcheckbox"]')) return;
      const id = threadIdFromActionTarget(target);
      recentRow = id ? { id, at: Date.now() } : null;
    };
    document.addEventListener("pointerdown", (event) => rememberRow(event.target), true);
    document.addEventListener("contextmenu", (event) => rememberRow(event.target), true);
    document.addEventListener("focusin", (event) => rememberRow(event.target), true);
    document.addEventListener(
      "click",
      (event) => {
        if (!event.isTrusted) return;
        if (!(event.target instanceof Element)) return;
        rememberRow(event.target);
        const action2 = event.target.closest(
          'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="switch"]'
        );
        if (!action2) return;
        const label2 = action2.getAttribute("aria-label") || action2.getAttribute("title") || action2.textContent || "";
        const nextMuted = muteStateAfterControlAction(
          label2,
          action2.getAttribute("role"),
          action2.getAttribute("aria-checked")
        );
        if (nextMuted === void 0) return;
        const rowId = threadIdFromActionTarget(action2);
        const openId = threadIdFromHref(location.pathname) || "";
        const recentId = recentRow && Date.now() - recentRow.at <= 15e3 ? recentRow.id : "";
        const id = resolveMuteActionThreadId(
          rowId,
          openId,
          recentId,
          !!action2.closest('[role="main"], [role="complementary"], [role="dialog"]')
        );
        if (id) {
          mutedThreads.observe(id, nextMuted);
          window.dispatchEvent(
            new CustomEvent("carrier:thread-mute", { detail: { id, muted: nextMuted } })
          );
        }
      },
      true
    );
  }
  function observeConversationMute(id, root) {
    mutedThreads.observeMountedRow(
      id,
      hasMutedRowIcon(root) ? true : resolveMuteObservation(collectMuteLabels(root, false))
    );
    return mutedThreads.isMuted(id);
  }
  function observeDatabaseMute(id, muted) {
    mutedThreads.observe(id, muted);
    return muted;
  }
  function observeOpenThreadMute(id, roots) {
    const labels = [];
    for (const root of roots) {
      for (const label2 of collectMuteLabels(root)) {
        if (conversationMuteFromLabel(label2) !== null) labels.push(label2);
      }
    }
    mutedThreads.observe(id, muteSignalFromLabels(labels) ?? void 0);
    return mutedThreads.isMuted(id);
  }

  // inject/src/messenger/lib/page-notifications.ts
  var CHAT_POPPER_MODULE = "useMWLSChatPopperUpper";
  var DESKTOP_NOTIFICATIONS_MODULE = "MWDesktopNotifications";
  var CHAT_POPPER_REWRITES = [
    // Notify while the window is merely unfocused, not only when hidden.
    [
      /(\w+)\("VisibilityAPI"\)\.isVisibilityHidden\(\)===!0/,
      '($1("VisibilityAPI").isVisibilityHidden()===!0||!document.hasFocus())'
    ],
    // The installed-app gate.
    [/\w+\("isMessengerPWA"\)\(\)&&\w+\("justknobx"\)\._\("1465"\)/, "!0"]
  ];
  function rewriteChatPopperSource(source) {
    let rewritten = source;
    for (const [pattern, replacement] of CHAT_POPPER_REWRITES) {
      if (rewritten.match(new RegExp(pattern.source, "g"))?.length !== 1) return null;
      rewritten = rewritten.replace(pattern, replacement);
    }
    return rewritten;
  }
  function messengerId(value, i64ToString) {
    let text = value;
    if (typeof value === "number" || typeof value === "bigint") text = String(value);
    else if (typeof value !== "string" && value != null && i64ToString) {
      try {
        text = i64ToString(value);
      } catch {
        return null;
      }
    }
    return typeof text === "string" && /^\d+$/.test(text) ? text : null;
  }
  var MESSAGE_LIMIT = 100;
  var PageMessageIndex = class {
    constructor() {
      __publicField(this, "threads", /* @__PURE__ */ new Map());
      __publicField(this, "stale", /* @__PURE__ */ new Set());
    }
    record(messageId, threadId) {
      this.threads.delete(messageId);
      this.threads.set(messageId, threadId);
      if (this.threads.size > MESSAGE_LIMIT) this.threads.delete(this.threads.keys().next().value);
    }
    /** The conversation of the notification tagged with this message id. */
    threadFor(tag) {
      return typeof tag === "string" ? this.threads.get(tag) : void 0;
    }
    /** The message is old news (see {@link isOldNews}): its notification is suppressed. */
    markStale(messageId) {
      this.stale.add(messageId);
      if (this.stale.size > MESSAGE_LIMIT) this.stale.delete(this.stale.values().next().value);
    }
    isStale(tag) {
      return typeof tag === "string" && this.stale.has(tag);
    }
  };
  var pageMessages = new PageMessageIndex();
  function recordNotifiedMessage(message, load) {
    if (!message || typeof message !== "object") return;
    const row = message;
    if (typeof row.messageId !== "string" || !row.messageId) return;
    const threadId = messageThreadId(message, load);
    if (threadId) pageMessages.record(row.messageId, threadId);
  }
  function messageThreadId(message, load) {
    if (!message || typeof message !== "object") return null;
    let i64ToString;
    try {
      const i64 = typeof load === "function" ? load("I64") : null;
      if (typeof i64?.to_string === "function") {
        i64ToString = i64.to_string.bind(i64);
      }
    } catch {
    }
    return messengerId(message.threadKey, i64ToString);
  }
  var LATE_NOTIFICATION_MS = 2 * 6e4;
  function isOldNews(sentMs, nowMs, readUpToMs) {
    if (sentMs === null) return false;
    if (nowMs !== null && nowMs - sentMs > LATE_NOTIFICATION_MS) return true;
    return readUpToMs !== null && readUpToMs >= sentMs;
  }
  function messengerMillis(value, load) {
    let i64ToString;
    try {
      const i64 = typeof load === "function" ? load("I64") : null;
      if (typeof i64?.to_string === "function") i64ToString = i64.to_string.bind(i64);
    } catch {
    }
    const digits = messengerId(value, i64ToString);
    const millis = digits === null ? Number.NaN : Number(digits);
    return Number.isSafeInteger(millis) ? millis : null;
  }
  function serverNowMs(load) {
    try {
      const time = typeof load === "function" ? load("ServerTime") : null;
      const millis = time?.getMillis?.();
      return typeof millis === "number" && Number.isFinite(millis) ? millis : null;
    } catch {
      return null;
    }
  }
  async function readOldNews(db, message, load, timeoutMs = 750) {
    if (!message || typeof message !== "object") return false;
    const row = message;
    const sentMs = messengerMillis(row.timestampMs, load);
    if (sentMs === null) return false;
    const nowMs = serverNowMs(load);
    if (isOldNews(sentMs, nowMs, null)) return true;
    const threads = db?.tables?.threads;
    if (typeof threads?.get !== "function") return false;
    let timer;
    const read = async () => {
      const thread2 = await threads.get(row.threadKey);
      if (!thread2 || typeof thread2 !== "object") return false;
      return isOldNews(sentMs, nowMs, messengerMillis(thread2.lastReadWatermarkTimestampMs, load));
    };
    try {
      return await Promise.race([
        read().catch(() => false),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function sameArity(wrapped3, original) {
    try {
      Object.defineProperty(wrapped3, "length", { value: original.length });
    } catch {
    }
    return wrapped3;
  }
  function wrapFactoryExports(factory, patch) {
    const tryPatch = (exports) => Boolean(exports) && typeof exports === "object" && patch(exports);
    return sameArity(function(...args) {
      const result = Reflect.apply(factory, this, args);
      for (const candidate of [result, ...args.slice(-2)]) {
        try {
          if (tryPatch(candidate)) break;
          if (candidate && typeof candidate === "object" && tryPatch(candidate.exports)) {
            break;
          }
        } catch {
        }
      }
      return result;
    }, factory);
  }
  function wrapDesktopNotificationsFactory(factory, load) {
    return wrapFactoryExports(factory, (exports) => {
      const trigger = exports.triggerLocalNotification;
      if (typeof trigger !== "function") return false;
      exports.triggerLocalNotification = function(...args) {
        const notify = () => Reflect.apply(trigger, this, args);
        let check;
        try {
          const page = load();
          recordNotifiedMessage(args[1], page);
          check = readOldNews(args[0], args[1], page);
        } catch {
          return notify();
        }
        return check.then((old) => {
          const messageId = args[1]?.messageId;
          if (old && typeof messageId === "string") pageMessages.markStale(messageId);
          return notify();
        }, notify);
      };
      return true;
    });
  }
  function wrapChatPopperFactory(factory, loadRewritten2, onUnmatched) {
    let rewritten = null;
    const source = rewriteChatPopperSource(Function.prototype.toString.call(factory));
    if (source === null) onUnmatched();
    else {
      loadRewritten2(source, (ready2) => {
        rewritten = ready2;
      });
    }
    return sameArity(function(...args) {
      return Reflect.apply(rewritten ?? factory, this, args);
    }, factory);
  }
  var rewriteSeq = 0;
  function loadRewrittenScript(source, ready2, doc, global, report) {
    const key = `__carrierRewritten${++rewriteSeq}`;
    const url = URL.createObjectURL(
      new Blob([`window[${JSON.stringify(key)}] = (${source});`], { type: "text/javascript" })
    );
    const script = doc.createElement("script");
    script.src = url;
    const done = () => {
      URL.revokeObjectURL(url);
      script.remove();
    };
    script.onload = () => {
      const rewritten = global[key];
      delete global[key];
      done();
      if (typeof rewritten === "function") {
        ready2(rewritten);
        report("loaded");
      } else report("invalid");
    };
    script.onerror = () => {
      done();
      report("refused");
    };
    (doc.head ?? doc.documentElement).append(script);
  }

  // inject/src/messenger/features/messenger-sounds.ts
  /*! Includes code adapted from fMess (https://github.com/toanbku/fmess).
   *
   * MIT License
   *
   * Copyright (c) 2026 fMess contributors
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */
  var SOUND_PLAYER_MODULE = "SoundPlayer";
  var CHAT_POPPER_COMMON_MODULE = "MWLSChatPopperCommon";
  var RESUME_WAIT_MS = 1e3;
  var pageLoad = () => window.require;
  var soundPlayerCalls = 0;
  var MESSAGE_SOUND_PENDING_MS = 3e3;
  var MESSAGE_SOUND_RING_MS = 5e3;
  var pendingMessageSound = null;
  var messageSound = null;
  function messengerMessageSoundJustPlayed(thread2, messageId = "") {
    const sound = messageSound;
    if (!sound || Date.now() - sound.at >= MESSAGE_SOUND_RING_MS) return false;
    if (messageId) return sound.messageId === messageId;
    if (thread2 === null || sound.thread !== thread2) return false;
    messageSound = null;
    return true;
  }
  var context = null;
  var sounding = 0;
  var buffers = /* @__PURE__ */ new Map();
  var sources = /* @__PURE__ */ new WeakMap();
  var pauses = /* @__PURE__ */ new WeakMap();
  var pausesOf = (element2) => pauses.get(element2) ?? 0;
  var quieted = /* @__PURE__ */ new WeakSet();
  var quiet = (element2) => {
    if (element2.muted) return;
    element2.muted = true;
    quieted.add(element2);
  };
  var unquiet = (element2) => {
    if (quieted.delete(element2)) element2.muted = false;
  };
  function decoded(audio, src) {
    let buffer = buffers.get(src);
    if (!buffer) {
      buffer = fetch(src).then(
        (response) => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`HTTP ${response.status}`))
      ).then((data) => audio.decodeAudioData(data));
      buffers.set(src, buffer);
      buffer.catch(() => buffers.delete(src));
    }
    return buffer;
  }
  async function playThroughWebAudio(element2) {
    const pausesAtStart = pausesOf(element2);
    const src = element2.currentSrc || element2.src;
    const Context = window.AudioContext;
    if (!src || typeof Context !== "function") throw new Error("no Web Audio");
    context ?? (context = new Context());
    const audio = context;
    let timer;
    const awake = Promise.race([
      audio.resume(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, RESUME_WAIT_MS);
      })
    ]).finally(() => clearTimeout(timer));
    const [data] = await Promise.all([decoded(audio, src), awake]);
    if (pausesOf(element2) !== pausesAtStart) return;
    if (audio.state !== "running") throw new Error(`audio ${audio.state}`);
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = data;
    gain.gain.value = element2.muted && !quieted.has(element2) ? 0 : element2.volume;
    source.connect(gain).connect(audio.destination);
    let playing = sources.get(element2);
    if (!playing) sources.set(element2, playing = /* @__PURE__ */ new Set());
    playing.add(source);
    sounding += 1;
    source.onended = () => {
      playing.delete(source);
      sounding -= 1;
      if (sounding === 0) audio.suspend().catch(() => {
      });
    };
    source.start();
  }
  var playbackInstalled = false;
  function installMessengerSoundPlayback() {
    if (playbackInstalled) return;
    playbackInstalled = true;
    const proto = HTMLMediaElement.prototype;
    const nativePlay = proto.play;
    const nativePause = proto.pause;
    proto.play = function() {
      const isSound = soundPlayerCalls > 0 && this instanceof HTMLAudioElement && Boolean(this.src) && !this.loop && !this.srcObject;
      if (!isSound) {
        unquiet(this);
        return nativePlay.call(this);
      }
      quiet(this);
      if (notificationsGloballyMuted(window.__CARRIER_SETTINGS__)) return Promise.resolve();
      if (pendingMessageSound && Date.now() < pendingMessageSound.until) {
        const { thread: thread2, messageId } = pendingMessageSound;
        messageSound = { thread: thread2, messageId, at: Date.now() };
        pendingMessageSound = null;
      }
      const pausesAtStart = pausesOf(this);
      return playThroughWebAudio(this).catch(() => {
        diag("sound.web-audio", "Web Audio could not play a Messenger sound; using the element");
        if (pausesOf(this) !== pausesAtStart) return void 0;
        unquiet(this);
        return nativePlay.call(this);
      });
    };
    proto.pause = function() {
      if (this instanceof HTMLAudioElement) {
        pauses.set(this, pausesOf(this) + 1);
        for (const source of sources.get(this) ?? []) {
          try {
            source.stop();
          } catch (_) {
          }
        }
      }
      return nativePause.call(this);
    };
  }
  function quietPreloaded(urls) {
    const paths = /* @__PURE__ */ new Set();
    for (const url of Array.isArray(urls) ? urls : [urls]) {
      try {
        paths.add(new URL(String(url), location.href).pathname);
      } catch (_) {
      }
    }
    for (const element2 of document.querySelectorAll("audio")) {
      try {
        if (!element2.loop && paths.has(new URL(element2.src).pathname)) quiet(element2);
      } catch (_) {
      }
    }
  }
  function patchSoundPlayer(exports) {
    const play = exports.play;
    if (typeof play !== "function") return false;
    const preload = exports.preload;
    if (typeof preload === "function") {
      exports.preload = function(...args) {
        const result = Reflect.apply(preload, this, args);
        quietPreloaded(args[0]);
        return result;
      };
    }
    exports.play = function(...args) {
      const loop = args[1]?.loop === true;
      if (loop) return Reflect.apply(play, this, args);
      soundPlayerCalls += 1;
      try {
        return Reflect.apply(play, this, args);
      } finally {
        soundPlayerCalls -= 1;
      }
    };
    return true;
  }
  function patchChatPopperCommon(exports) {
    const playChatTabSound = exports.playChatTabSound;
    if (typeof playChatTabSound !== "function") return false;
    exports.playChatTabSound = function(...args) {
      const settings = window.__CARRIER_SETTINGS__;
      const load = pageLoad();
      const message = args[0];
      const plays = playsMessageSound({
        globallyMuted: notificationsGloballyMuted(settings),
        oldNews: isOldNews(messengerMillis(message?.timestampMs, load), serverNowMs(load), null),
        focused: document.hasFocus(),
        nativeSoundOn: settings?.notification_sound !== false
      });
      if (!plays) return void 0;
      const thread2 = messageThreadId(message, load);
      const messageId = typeof message?.messageId === "string" ? message.messageId : "";
      pendingMessageSound = thread2 ? { thread: thread2, messageId, until: Date.now() + MESSAGE_SOUND_PENDING_MS } : null;
      return Reflect.apply(playChatTabSound, this, args);
    };
    return true;
  }
  function interceptSoundModules(define) {
    return new Proxy(define, {
      apply(target, thisArg, args) {
        const factory = args[2];
        if (typeof factory === "function") {
          if (args[0] === SOUND_PLAYER_MODULE) {
            args[2] = wrapFactoryExports(factory, patchSoundPlayer);
          } else if (args[0] === CHAT_POPPER_COMMON_MODULE) {
            args[2] = wrapFactoryExports(factory, patchChatPopperCommon);
          }
        }
        return Reflect.apply(target, thisArg, args);
      }
    });
  }

  // inject/src/messenger/features/page-notifications.ts
  function loadRewritten(source, ready2) {
    loadRewrittenScript(source, ready2, document, globalThis, (outcome) => {
      if (outcome === "loaded")
        diag("notify.page-enabled", "Messenger's own notifications are enabled");
      else if (outcome === "refused") {
        diag("notify.page-rewrite", "the page refused the rewritten notification module");
      } else diag("notify.page-rewrite", "rewritten notification module did not load");
    });
  }
  function interceptNotificationModules(define) {
    const load = () => window.require;
    return new Proxy(define, {
      apply(target, thisArg, args) {
        const name = args[0];
        const factory = args[2];
        if (typeof factory === "function") {
          if (name === CHAT_POPPER_MODULE) {
            args[2] = wrapChatPopperFactory(
              factory,
              loadRewritten,
              () => diag(
                "notify.page-rewrite",
                "Messenger's notification gate changed; using the fallback"
              )
            );
          } else if (name === DESKTOP_NOTIFICATIONS_MODULE) {
            args[2] = wrapDesktopNotificationsFactory(factory, load);
          }
        }
        return Reflect.apply(target, thisArg, args);
      }
    });
  }

  // inject/src/messenger/features/facebook-modules.ts
  var SEARCH_INDEX_WAKE_MS = 5 * 6e4;
  function initFacebookModuleInterception() {
    const page = window;
    const shouldBlockTelemetry = () => window.__CARRIER_SETTINGS__?.block_telemetry === true;
    const wrappedDefines = /* @__PURE__ */ new WeakSet();
    const searchIndex = new FacebookFTSIdleCoordinator();
    const nicknamePreference = {
      getSnapshot: () => nicknameMode(window.__CARRIER_SETTINGS__),
      subscribe: (listener) => {
        window.addEventListener("carrier:settings", listener);
        return () => window.removeEventListener("carrier:settings", listener);
      }
    };
    let pauseTimer;
    installMessengerSoundPlayback();
    const wakeSearchIndex = () => {
      searchIndex.wake();
      if (pauseTimer !== void 0) window.clearTimeout(pauseTimer);
      pauseTimer = window.setTimeout(() => {
        pauseTimer = void 0;
        searchIndex.pause();
      }, SEARCH_INDEX_WAKE_MS);
    };
    window.__carrierWakeSearchIndex = wakeSearchIndex;
    document.addEventListener(
      "focusin",
      (event) => {
        const input = event.target instanceof HTMLInputElement ? event.target : null;
        if (input && isConversationSearchInput({
          hasAccessibleName: input.hasAttribute("aria-label"),
          insideForm: input.closest("form") !== null,
          insideMain: input.closest('[role="main"]') !== null,
          role: input.getAttribute("role"),
          type: input.type
        })) {
          wakeSearchIndex();
        }
      },
      true
    );
    const wrap = (value) => {
      if (typeof value !== "function" || wrappedDefines.has(value)) return value;
      const wrapped3 = createFacebookModuleDefineInterceptor(
        interceptNotificationModules(
          interceptSoundModules(value)
        ),
        shouldBlockTelemetry,
        (restore2) => searchIndex.register(restore2),
        (error) => {
          if (isFacebookRateLimitError(error)) reportRateLimit("graphql-1675004");
        },
        (exports) => workerRecovery.observeSetupExports(exports),
        (exports) => syncProcessing.observeLogger(exports),
        (exports) => {
          workerRecovery.observeLifecycleExports(exports);
          workerReplacement.observeLifecycleExports(exports);
        },
        // macOS keeps Messenger's encrypted engine per window (#295), unless a
        // second window moved the session onto Facebook's shared engine.
        /mac/i.test(navigator.platform) && window.__CARRIER_SHARED_ENGINE__ !== true,
        nicknamePreference
      );
      wrappedDefines.add(wrapped3);
      return wrapped3;
    };
    try {
      const inherited = Object.getOwnPropertyDescriptor(window, "__d");
      if (typeof inherited?.get === "function" && typeof inherited.set === "function") {
        Object.defineProperty(window, "__d", {
          configurable: inherited.configurable,
          enumerable: inherited.enumerable,
          get: () => inherited.get?.call(window),
          set: (value) => inherited.set?.call(window, wrap(value))
        });
        return;
      }
      let current = wrap(page.__d);
      Object.defineProperty(window, "__d", {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (value) => {
          current = wrap(value);
        }
      });
    } catch (_) {
    }
  }

  // inject/src/messenger/lib/facebook-workers.ts
  function isResponsivenessWorkerMessage(message) {
    if (!message || typeof message !== "object") return false;
    return message.type === "responsiveness";
  }
  function isResponsivenessProfilerHandshake(message) {
    if (!message || typeof message !== "object") return false;
    return message.type === "endpoint_started";
  }
  function optimizeFacebookWorker(worker, shouldBlockTelemetry, onStopped = () => {
  }) {
    const nativePostMessage = worker.postMessage;
    let profilerHandshakeSeen = false;
    let stopped = false;
    worker.postMessage = function(...args) {
      if (stopped) return;
      const message = args[0];
      if (isResponsivenessProfilerHandshake(message)) profilerHandshakeSeen = true;
      if (profilerHandshakeSeen && shouldBlockTelemetry() && isResponsivenessWorkerMessage(message)) {
        stopped = true;
        try {
          worker.terminate();
        } catch (_) {
        }
        onStopped();
        return;
      }
      Reflect.apply(nativePostMessage, this, args);
    };
    return worker;
  }

  // inject/src/messenger/features/facebook-workers.ts
  function initFacebookWorkerOptimization() {
    if (typeof window.Worker !== "function" || typeof Proxy !== "function") return;
    const state3 = { responsivenessWorkersStopped: 0 };
    window.__CARRIER_WORKER_OPTIMIZATION__ = state3;
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args, NewTarget) {
        const worker = Reflect.construct(Target, args, NewTarget);
        return optimizeFacebookWorker(
          worker,
          () => window.__CARRIER_SETTINGS__?.block_telemetry === true,
          () => {
            state3.responsivenessWorkersStopped++;
          }
        );
      }
    });
  }

  // inject/src/messenger/features/force-theme.ts
  function initForceTheme() {
    const html = document.documentElement;
    let forcedClass = null;
    const apply2 = () => {
      const forced = window.__CARRIER_SETTINGS__?.theme;
      if (forced !== "light" && forced !== "dark") {
        if (forcedClass) {
          html.classList.remove(forcedClass);
          forcedClass = null;
        }
        return;
      }
      const want = forced === "dark" ? "__fb-dark-mode" : "__fb-light-mode";
      const other = forced === "dark" ? "__fb-light-mode" : "__fb-dark-mode";
      if (!html.classList.contains(want) || html.classList.contains(other)) {
        html.classList.remove(other);
        html.classList.add(want);
      }
      forcedClass = want;
    };
    apply2();
    window.addEventListener("carrier:settings", apply2);
    new MutationObserver(apply2).observe(html, { attributes: true, attributeFilter: ["class"] });
  }
  var DARK_MARKERS = ["data-carrier-dark", "data-fmess-dark"];
  function initThemeMarkers() {
    const html = document.documentElement;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply2 = () => {
      for (const marker of DARK_MARKERS) {
        if (query.matches) html.setAttribute(marker, "");
        else html.removeAttribute(marker);
      }
    };
    apply2();
    query.addEventListener("change", apply2);
  }

  // inject/src/messenger/features/fullscreen.ts
  function initFullscreenPolyfill() {
    if (document.fullscreenEnabled && Element.prototype.requestFullscreen)
      return;
    let current = null;
    const enter = (el) => {
      current = el;
      el.dataset.carrierPrevStyle = el.getAttribute("style") || "";
      Object.assign(el.style, {
        position: "fixed",
        inset: "0",
        width: "100vw",
        height: "100vh",
        zIndex: "2147483647",
        background: "#000"
      });
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    };
    const leave = () => {
      if (current) {
        current.setAttribute("style", current.dataset.carrierPrevStyle || "");
        delete current.dataset.carrierPrevStyle;
        current = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      }
      return Promise.resolve();
    };
    Object.defineProperty(document, "fullscreenElement", { get: () => current, configurable: true });
    Element.prototype.requestFullscreen = function() {
      return enter(this);
    };
    Element.prototype.webkitRequestFullscreen = Element.prototype.requestFullscreen;
    document.exitFullscreen = leave;
    document.webkitExitFullscreen = leave;
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && current) leave();
      },
      true
    );
  }

  // inject/src/messenger/lib/privacy.ts
  var PREVIEW_NAME_RE = /^([^:]{1,40}):(?=\s|$)/;
  var PREVIEW_EVENT_RE = /^(.{1,40}?)(?=\s+(?:sent|replied|reacted|liked|laughed|loved|mentioned|shared|left|joined|added|removed|changed|created|named|started)\b)/i;
  function isMetaText(value) {
    return !value || /^(\d+\s*(?:s|m|h|d|w|mo|y)|now|just now)$/i.test(value) || /^(sun|mon|tue|wed|thu|fri|sat)$/i.test(value) || /^[·•.,\s\d]+$/.test(value);
  }
  function previewIdentity(value) {
    const colon = value.match(PREVIEW_NAME_RE);
    const event = colon ? null : value.match(PREVIEW_EVENT_RE);
    const match = colon || event;
    if (!match) return null;
    const prefix = match[1].trim();
    if (!prefix || prefix.length < 2 || /^(you|du|me|meg)$/i.test(prefix)) return null;
    if (/[:;!?]/.test(prefix) || /^\d+(?:[ .-]\d+)*$/.test(prefix)) return null;
    return { prefix, colon: !!colon };
  }
  function locateSpan(texts, from, to) {
    const locate = (index, atEnd) => {
      let offset = index;
      for (let node = 0; node < texts.length; node += 1) {
        const length = texts[node].length;
        if (atEnd ? offset <= length : offset < length) return [node, offset];
        offset -= length;
      }
      return [texts.length - 1, texts[texts.length - 1].length];
    };
    return { start: locate(from, false), end: locate(to, true) };
  }
  function prefixRange(text, prefix) {
    const lead = text.length - text.trimStart().length;
    if (!prefix || !text.startsWith(prefix, lead)) return null;
    return [lead, lead + prefix.length];
  }
  var NAME_CHAR = "[\\p{L}\\p{M}\\p{N}_.'-]";
  var PARTICLE = "(?:van|von|der|den|de|del|della|di|da|du|dos|das|la|le|ten|ter|bin|ibn|al)";
  var MENTION_RE = new RegExp(
    `(^|[^\\p{L}\\p{M}\\p{N}_])(@${NAME_CHAR}+(?:[ \\u00a0](?:${PARTICLE}[ \\u00a0])*\\p{Lu}${NAME_CHAR}*){0,3})`,
    "gu"
  );
  function mentionRanges(text) {
    return [...text.matchAll(MENTION_RE)].map((m) => {
      const start = m.index + m[1].length;
      return [start, start + m[2].length];
    });
  }
  function hidesNames(settings) {
    return (settings?.hide_names ?? settings?.hide_names_avatars) === true;
  }
  function hidesAvatars(settings) {
    return (settings?.hide_avatars ?? settings?.hide_names_avatars) === true;
  }

  // inject/src/messenger/features/hide-names.ts
  var IDENTITY_ATTR = "data-carrier-private-identity";
  var AVATAR_ATTR = "data-carrier-private-avatar";
  var THREAD_ROW_SEL = '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]';
  var TEXT_SURFACE_SEL = "span, div, h1, h2, h3, h4";
  var VISUAL_SEL = 'img, svg, image, [style*="background-image"]';
  var PREFIX_HIGHLIGHT = "carrier-private-identity";
  var PREFIX_HOST_ATTR = "data-carrier-private-prefix";
  function initHideNames() {
    const html = document.documentElement;
    let observer = null;
    let pending = false;
    let suppressMutations = false;
    const namesHidden = () => hidesNames(window.__CARRIER_SETTINGS__);
    const avatarsHidden = () => hidesAvatars(window.__CARRIER_SETTINGS__);
    const on2 = () => namesHidden() || avatarsHidden();
    function textValue(el) {
      return (el?.textContent || "").replace(/\s+/g, " ").trim();
    }
    function visible(el) {
      const r = el?.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    }
    function isPicture(el) {
      if (el.matches("img, svg, image")) return true;
      return /url\(/.test(getComputedStyle(el).backgroundImage || "");
    }
    function mark(el) {
      if (!el?.setAttribute) return;
      want(el, IDENTITY_ATTR);
      for (const node of [el, ...el.querySelectorAll("*")]) {
        if (isPicture(node) && node.getBoundingClientRect().width >= 20) markAvatar(node);
      }
    }
    function markAvatar(el) {
      if (el?.setAttribute) want(el, AVATAR_ATTR);
    }
    const MARKER_ATTRS = [IDENTITY_ATTR, AVATAR_ATTR, PREFIX_HOST_ATTR];
    let wanted = /* @__PURE__ */ new Map();
    let wantedRanges = [];
    let appliedRanges = [];
    function want(el, attr) {
      let attrs = wanted.get(el);
      if (!attrs) {
        attrs = /* @__PURE__ */ new Set();
        wanted.set(el, attrs);
      }
      attrs.add(attr);
    }
    const sameRange = (a, b) => a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
    function applyMarkers() {
      document.querySelectorAll(MARKER_ATTRS.map((attr) => `[${attr}]`).join(", ")).forEach((el) => {
        const attrs = wanted.get(el);
        for (const attr of MARKER_ATTRS) {
          if (!attrs?.has(attr)) el.removeAttribute(attr);
        }
      });
      wanted.forEach((attrs, el) => {
        attrs.forEach((attr) => {
          if (!el.hasAttribute(attr)) el.setAttribute(attr, "");
        });
      });
      const highlights = globalThis.CSS?.highlights;
      const unchanged = wantedRanges.length === appliedRanges.length && wantedRanges.every((range, i) => sameRange(range, appliedRanges[i]));
      if (highlights && !unchanged) {
        if (wantedRanges.length) highlights.set(PREFIX_HIGHLIGHT, new Highlight(...wantedRanges));
        else highlights.delete(PREFIX_HIGHLIGHT);
      }
      appliedRanges = wantedRanges;
    }
    function clearMarkers() {
      wanted = /* @__PURE__ */ new Map();
      wantedRanges = [];
      applyMarkers();
    }
    function textSurfaces(root) {
      const out = [];
      root.querySelectorAll?.(TEXT_SURFACE_SEL).forEach((el) => {
        if (!visible(el) || el.closest?.('[contenteditable="true"]')) return;
        if (!textValue(el)) return;
        out.push(el);
      });
      return out.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.y - br.y || ar.x - br.x || ar.height - br.height;
      });
    }
    function area(el) {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    }
    function deepest(elements) {
      return elements.filter((el) => !elements.some((other) => other !== el && el.contains(other)));
    }
    function markDeepest(elements) {
      let count = 0;
      deepest(elements).sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.x - br.x || area(a) - area(b);
      }).forEach((el) => {
        if (isMetaText(textValue(el))) return;
        mark(el);
        count += 1;
      });
      return count > 0;
    }
    function markPreviewNames(el) {
      const identity = previewIdentity(textValue(el));
      let prefixDone = !identity;
      if (identity) {
        const candidate = [el, ...textSurfaces(el)].filter((candidate2) => {
          if (candidate2.querySelector(VISUAL_SEL)) return false;
          const candidateText = textValue(candidate2);
          return candidateText === identity.prefix || identity.colon && candidateText === `${identity.prefix}:`;
        }).sort((a, b) => area(a) - area(b))[0];
        if (candidate) {
          mark(candidate);
          prefixDone = true;
        }
      }
      const nodes = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const texts = nodes.map((node) => node.data);
      const joined = texts.join("");
      const ranges = mentionRanges(joined);
      if (identity && !prefixDone) {
        const prefix = prefixRange(joined, identity.prefix);
        if (prefix) ranges.push(prefix);
        else ranges.length = 0;
      }
      if (!ranges.length) {
        if (identity && !prefixDone) mark(el);
        return;
      }
      if (!highlightRanges(nodes, texts, ranges)) mark(el);
    }
    function highlightRanges(nodes, texts, ranges) {
      if (!globalThis.CSS?.highlights || typeof Highlight === "undefined") return false;
      for (const [from, to] of ranges) {
        const span = locateSpan(texts, from, to);
        for (const node of nodes.slice(span.start[0], span.end[0] + 1)) {
          if (node.parentElement) want(node.parentElement, PREFIX_HOST_ATTR);
        }
        const range = document.createRange();
        range.setStart(nodes[span.start[0]], span.start[1]);
        range.setEnd(nodes[span.end[0]], span.end[1]);
        wantedRanges.push(range);
      }
      return true;
    }
    function markConversationRows() {
      const seen = /* @__PURE__ */ new Set();
      for (const row of document.querySelectorAll(THREAD_ROW_SEL)) {
        const href = row.getAttribute("href") || "";
        if (!href || seen.has(href) || !visible(row)) continue;
        seen.add(href);
        const rr = row.getBoundingClientRect();
        row.querySelectorAll(VISUAL_SEL).forEach((el) => {
          if (!visible(el)) return;
          const r = el.getBoundingClientRect();
          const leftAvatar = r.left < rr.left + 80 && r.width >= 20 && r.height >= 20;
          const rightReceipt = r.right > rr.right - 56 && r.width >= 12 && r.width <= 34 && r.height >= 12 && r.height <= 34;
          if (leftAvatar || rightReceipt) markAvatar(el);
        });
        const surfaces = textSurfaces(row).filter((el) => {
          if (el.getAttribute("aria-hidden") === "true") return false;
          if (el.closest("abbr")) return false;
          const r = el.getBoundingClientRect();
          return r.left > rr.left + 56;
        });
        if (!surfaces.length) continue;
        const firstLineY = Math.min(...surfaces.map((el) => el.getBoundingClientRect().top));
        const firstLine = [];
        surfaces.forEach((el) => {
          const r = el.getBoundingClientRect();
          if (Math.abs(r.top - firstLineY) < 4 && r.height <= 24) firstLine.push(el);
          else if (r.top > firstLineY + 8 && r.height <= 24) markPreviewNames(el);
        });
        markDeepest(firstLine);
      }
    }
    function mainPane() {
      return document.querySelector('[role="main"]') || document.querySelector("main");
    }
    function markThreadHeader(main2) {
      const mr = main2.getBoundingClientRect();
      const headerBottom = mr.top + 96;
      const actionStart = mr.right - 150;
      const inHeader = (el) => {
        const r = el.getBoundingClientRect();
        return r.top >= mr.top && r.bottom <= headerBottom && r.left < actionStart;
      };
      let list = null;
      for (let a = main2.querySelector('[role="article"]')?.parentElement; a && a !== main2; ) {
        const overflow = getComputedStyle(a).overflowY;
        if (overflow === "auto" || overflow === "scroll") {
          list = a;
          break;
        }
        a = a.parentElement;
      }
      const scrolledContent = (el) => Boolean(el.closest('[role="article"]')) || Boolean(list?.contains(el));
      main2.querySelectorAll(TEXT_SURFACE_SEL).forEach((el) => {
        if (!inHeader(el) || !visible(el) || el.closest('[contenteditable="true"]')) return;
        if (!textValue(el) || [...el.children].some((child) => textValue(child))) return;
        if (scrolledContent(el)) return;
        mark(el);
      });
      main2.querySelectorAll(VISUAL_SEL).forEach((el) => {
        if (!inHeader(el) || !visible(el) || scrolledContent(el)) return;
        const r = el.getBoundingClientRect();
        if (r.width >= 20 && r.height >= 20) markAvatar(el);
      });
    }
    function hasBareText(el) {
      return [...el.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim()
      );
    }
    function markMixedProfileLinks(main2) {
      main2.querySelectorAll(
        'a[href^="/"][href$="/"]:not([href*="/messages/"]), a[href*="/profile.php"]'
      ).forEach((link) => {
        if (!visible(link)) return;
        const nodes = [link, ...link.querySelectorAll("*")];
        const pictures = nodes.filter(isPicture);
        pictures.forEach(markAvatar);
        if (!textValue(link) || !pictures.length) return;
        const textBesidePicture = pictures[0] === link || hasBareText(link) || nodes.some((el) => hasBareText(el) && pictures.some((pic) => el.contains(pic)));
        if (textBesidePicture) mark(link);
      });
    }
    function markThreadMessages(main2) {
      main2.querySelectorAll('[role="article"]').forEach((article) => {
        article.querySelectorAll("h4").forEach((el) => {
          if (visible(el) && textValue(el)) mark(el);
        });
        article.querySelectorAll(
          'img[referrerpolicy="origin-when-cross-origin"], img[height="14"][width="14"][tabindex="-1"], a[href^="/"][href$="/"]:not([href*="/messages/"]) [style*="background-image"], a[href*="/profile.php"] [style*="background-image"]'
        ).forEach((el) => {
          if (!visible(el)) return;
          if (el.matches('img[referrerpolicy="origin-when-cross-origin"]')) {
            const r = el.getBoundingClientRect();
            const square = Math.abs(r.width - r.height) <= 2;
            if (!square || r.width < 20 || r.width > 64) return;
          }
          markAvatar(el);
        });
      });
      const walker = document.createTreeWalker(main2, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!/\breplied to\b/i.test(node.data)) continue;
        let target = null;
        for (let el = node.parentElement; el && el !== main2; el = el.parentElement) {
          if (el.closest('[contenteditable="true"]')) break;
          const r = el.getBoundingClientRect();
          if (r.height > 32 || r.width > 420) break;
          target = el;
        }
        if (target && visible(target)) mark(target);
      }
    }
    function scan() {
      suppressMutations = true;
      try {
        wanted = /* @__PURE__ */ new Map();
        wantedRanges = [];
        if (on2()) {
          markConversationRows();
          const main2 = mainPane();
          if (main2) {
            markThreadHeader(main2);
            markThreadMessages(main2);
            markMixedProfileLinks(main2);
          }
        }
        applyMarkers();
      } finally {
        queueMicrotask(() => {
          suppressMutations = false;
        });
      }
    }
    const SCAN_MIN_GAP_MS = 150;
    let lastScanAt = 0;
    function schedule() {
      if (suppressMutations || !on2() || pending) return;
      pending = true;
      const wait = Math.max(0, SCAN_MIN_GAP_MS - (performance.now() - lastScanAt));
      setTimeout(() => {
        requestAnimationFrame(() => {
          pending = false;
          lastScanAt = performance.now();
          scan();
        });
      }, wait);
    }
    function start() {
      if (observer) return;
      observer = new MutationObserver((records) => {
        if (records.some(
          (record4) => record4.type !== "characterData" || record4.target.parentElement?.closest(THREAD_ROW_SEL)
        )) {
          schedule();
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-label", "href", "role", "src", "style"]
      });
      window.addEventListener("resize", schedule);
    }
    function stop() {
      observer?.disconnect();
      observer = null;
      pending = false;
      clearMarkers();
      window.removeEventListener("resize", schedule);
    }
    const apply2 = () => {
      html.toggleAttribute("data-carrier-hide-names", namesHidden());
      html.toggleAttribute("data-carrier-hide-avatars", avatarsHidden());
      if (on2()) {
        start();
        schedule();
      } else {
        stop();
      }
    };
    apply2();
    window.addEventListener("carrier:settings", apply2);
  }

  // inject/src/messenger/lib/image-paste.ts
  var ADDRESS = /^(https?|blob|data):\S+$/;
  function isImageWithOnlyItsAddress(paste) {
    if (!paste.fileTypes.length || !paste.fileTypes.every((type) => type.startsWith("image/"))) {
      return false;
    }
    const text = paste.text.trim();
    if (!text && paste.htmlText === null) return false;
    if (text && !ADDRESS.test(text)) return false;
    if (paste.htmlText === null) return true;
    return !paste.htmlText.trim() && paste.htmlHasImage;
  }

  // inject/src/messenger/lib/share-intake.ts
  var MAX_SHARED_FILES = 21;
  var MAX_SHARED_NAME_BYTES = 255;
  var MAX_SHARED_DATA_LENGTH = 140 * 1024 * 1024;
  var SHARE_DELIVERY_TTL_MS = 2 * 60 * 1e3;
  var MIME_BY_EXTENSION = /* @__PURE__ */ new Map([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
    ["heic", "image/heic"],
    ["mp4", "video/mp4"],
    ["mov", "video/quicktime"],
    ["webm", "video/webm"],
    ["pdf", "application/pdf"]
  ]);
  var utf8Length = (value) => new TextEncoder().encode(value).length;
  function dispatchTransferEvent(target, event, property, transfer) {
    let payloadRead = false;
    Object.defineProperty(event, property, {
      configurable: true,
      get: () => {
        payloadRead = true;
        return transfer;
      }
    });
    const cancelled = !target.dispatchEvent(event);
    return { acknowledged: cancelled && payloadRead, payloadRead };
  }
  function sanitizeSharedFiles(payload, maxTotalDataLength = MAX_SHARED_DATA_LENGTH) {
    if (!Array.isArray(payload)) return [];
    const files = [];
    let totalData = 0;
    for (const entry of payload) {
      if (files.length >= MAX_SHARED_FILES) break;
      if (!entry || typeof entry !== "object") continue;
      if (!Object.hasOwn(entry, "name") || !Object.hasOwn(entry, "data")) continue;
      const { name, data } = entry;
      if (typeof name !== "string" || typeof data !== "string") continue;
      if (name.length === 0 || utf8Length(name) > MAX_SHARED_NAME_BYTES) continue;
      if (name.includes("/") || name.includes("\\") || name.startsWith(".")) continue;
      totalData += data.length;
      if (totalData > maxTotalDataLength) break;
      files.push({ name, data });
    }
    return files;
  }
  function decodeToFile(entry) {
    try {
      if ("fromBase64" in Uint8Array && typeof Uint8Array.fromBase64 === "function") {
        return new File([Uint8Array.fromBase64(entry.data)], entry.name, {
          type: mimeForName(entry.name)
        });
      }
      const binary = atob(entry.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new File([bytes], entry.name, { type: mimeForName(entry.name) });
    } catch {
      return null;
    }
  }
  function decodeSharedFiles(entries) {
    const files = entries.map(decodeToFile).filter((file) => file !== null);
    return { files, failures: entries.length - files.length };
  }
  function shareIsDeliverable(parkedAtMs, nowMs) {
    const age = nowMs - parkedAtMs;
    return age >= 0 && age <= SHARE_DELIVERY_TTL_MS;
  }
  function mimeForName(name) {
    const extension = name.toLowerCase().split(".").pop() ?? "";
    return MIME_BY_EXTENSION.get(extension) ?? "application/octet-stream";
  }

  // inject/src/messenger/features/image-paste.ts
  function htmlContents(html) {
    if (!html) return { htmlText: null, htmlHasImage: false };
    const body = new DOMParser().parseFromString(html, "text/html").body;
    return { htmlText: body.textContent ?? "", htmlHasImage: body.querySelector("img") !== null };
  }
  function initImagePaste() {
    document.addEventListener(
      "paste",
      (event) => {
        if (!event.isTrusted || !isComposerTarget(event.target)) return;
        const data = event.clipboardData;
        if (!data?.files.length) return;
        const files = [...data.files];
        const contents = {
          fileTypes: files.map((file) => file.type),
          text: data.getData("text/plain"),
          ...htmlContents(data.getData("text/html"))
        };
        if (!isImageWithOnlyItsAddress(contents)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const pictures = new DataTransfer();
        for (const file of files) pictures.items.add(file);
        const again = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
        dispatchTransferEvent(event.target, again, "clipboardData", pictures);
      },
      true
    );
  }

  // inject/src/messenger/features/link-handling.ts
  function handleLink(e) {
    const a = e.target?.closest?.("a[href]");
    if (!a) return;
    const href = a.href;
    if (!href || href.startsWith("javascript:")) return;
    if (a.hasAttribute("download")) return;
    const modified = e.shiftKey || e.metaKey || e.ctrlKey || e.button === 1;
    const blank = a.target === "_blank";
    if (classifyHref(href, location.href).external) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openUrl(href);
    } else if (modified || blank) {
      e.preventDefault();
      e.stopImmediatePropagation();
      location.href = href;
    }
  }
  function initLinkHandling() {
    document.addEventListener("click", handleLink, true);
    document.addEventListener("auxclick", (e) => e.button === 1 && handleLink(e), true);
  }

  // inject/src/messenger/lib/calls.ts
  function engineSupportsCalls(engine) {
    const sender = engine.RTCRtpSender?.prototype;
    if (typeof engine.RTCPeerConnection !== "function" || !sender) return false;
    const scriptTransform = "transform" in sender && typeof engine.RTCRtpScriptTransform === "function";
    const encodedStreams = typeof sender.createEncodedStreams === "function";
    return scriptTransform || encodedStreams;
  }

  // inject/src/messenger/features/linux-call-notice.ts
  var CALL_BUTTON_LABELS = [
    "Start a voice call",
    "Start a video call",
    "Voice calling is not supported on this browser",
    "Video calling is not supported on this browser"
  ];
  var CALL_BUTTONS = CALL_BUTTON_LABELS.map(
    (label2) => `[role="button"][aria-label="${label2}"]`
  ).join(", ");
  var ISSUE_URL = "https://github.com/kristofferR/Carrier/issues/345";
  var WIDTH = 280;
  var GAP = 8;
  var inside = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  function initLinuxCallNotice() {
    if (carrierMediaPlatform !== "linux" || engineSupportsCalls(window)) return;
    const host = document.createElement("div");
    host.id = "carrier-linux-call-notice";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
    :host { all: initial; color-scheme: light dark;
      --surface: #fff; --text: #1c1e21; --muted: #65676b; --border: #d8dbe1; --link: #0866ff; }
    @media (prefers-color-scheme: dark) { :host { --surface: #303133; --text: #e4e6eb;
      --muted: #b0b3b8; --border: #4b4d53; --link: #83b2ff; } }
    :host([data-theme="dark"]) { --surface: #303133; --text: #e4e6eb; --muted: #b0b3b8;
      --border: #4b4d53; --link: #83b2ff; }
    :host([data-theme="light"]) { --surface: #fff; --text: #1c1e21; --muted: #65676b;
      --border: #d8dbe1; --link: #0866ff; }
    section { box-sizing: border-box; width: ${WIDTH}px; padding: 12px 14px;
      border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
      color: var(--text); box-shadow: 0 8px 24px #0004; font: 12px/1.5 system-ui, sans-serif; }
    strong { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 600; }
    p { margin: 0 0 8px; color: var(--muted); }
    button { all: unset; color: var(--link); font-weight: 600; cursor: pointer; }
    button:hover { text-decoration: underline; }
    button:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; border-radius: 3px; }
  </style><section role="note">
    <strong>Calls don't work on Linux yet</strong>
    <p>The browser engine Carrier uses on Linux is missing the calling support Messenger
      needs, so voice and video calls can't start here.</p>
    <button type="button">Read more about it</button>
  </section>`;
    root.querySelector("button").addEventListener("click", () => openUrl(ISSUE_URL));
    const hideFacebookTooltips = document.createElement("style");
    hideFacebookTooltips.textContent = '[role="tooltip"] { visibility: hidden !important; }';
    let anchor = null;
    const hide = () => {
      if (!anchor) return;
      anchor = null;
      host.remove();
      hideFacebookTooltips.remove();
      document.removeEventListener("pointermove", track, true);
    };
    function track(event) {
      if (!anchor?.isConnected) return hide();
      const button = anchor.getBoundingClientRect();
      const notice = host.getBoundingClientRect();
      const zone = new DOMRect(
        Math.min(button.left, notice.left),
        button.top,
        Math.max(button.right, notice.right) - Math.min(button.left, notice.left),
        notice.bottom - button.top
      );
      if (!inside(zone, event.clientX, event.clientY)) hide();
    }
    const show = (button) => {
      if (anchor === button) return;
      anchor = button;
      const rect = button.getBoundingClientRect();
      const left = Math.max(GAP, Math.min(rect.right - WIDTH, innerWidth - WIDTH - GAP));
      host.style.cssText = `position: fixed; top: ${rect.bottom + GAP}px; left: ${left}px; z-index: 2147483646;`;
      host.dataset.theme = window.__CARRIER_SETTINGS__?.theme ?? "system";
      (document.body ?? document.documentElement).append(host);
      (document.head ?? document.documentElement).append(hideFacebookTooltips);
      document.addEventListener("pointermove", track, true);
    };
    document.addEventListener(
      "pointerover",
      (event) => {
        if (!(event.target instanceof Element) || event.target === host) return;
        const button = event.target.closest(CALL_BUTTONS) ?? event.target.querySelector(CALL_BUTTONS);
        if (button && inside(button.getBoundingClientRect(), event.clientX, event.clientY))
          show(button);
      },
      true
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (event.target !== host) hide();
      },
      true
    );
    document.documentElement.addEventListener("pointerleave", hide);
    window.addEventListener("blur", hide);
  }

  // inject/src/messenger/features/login-tidy.ts
  var HIDE = "data-carrier-hide";
  var COL = "data-carrier-login-col";
  var ANC = "data-carrier-login-anc";
  var FORM = "data-carrier-login-form";
  var CARD = "data-carrier-login-card";
  var LIGHT_BG = "data-carrier-login-light-bg";
  var REQUIRED = "data-carrier-login-required";
  var FOOTER = "data-carrier-login-footer";
  var FOOTER_KEEP = "data-carrier-login-footer-keep";
  var FOOTER_LINKS = "data-carrier-login-footer-links";
  var LANGUAGES = "data-carrier-login-languages";
  var LANGUAGE_LINK = "data-carrier-login-language-link";
  var LOGO = "data-carrier-login-logo";
  var LOGIN_REDIRECT = "carrier:login-redirect";
  var LOADING = "data-carrier-login-loading";
  var LOADER_LIMIT_MS = 15e3;
  function returnToMessengerAfterLogin() {
    if (!onFacebookHost()) return "idle";
    const signedIn = /(?:^|;\s*)c_user=[^;]+/.test(document.cookie);
    const hasLoginFields = !!document.querySelector('input[name="email"], input[type="password"]');
    try {
      const messengerReady = /^\/messages(?:\/|$)/.test(location.pathname) && document.readyState === "complete" && document.querySelector('[role="navigation"] [role="grid"]');
      if (!signedIn || hasLoginFields || messengerReady) {
        sessionStorage.removeItem(LOGIN_REDIRECT);
        return messengerReady ? "settled" : "idle";
      }
      if (["/", "/home.php"].includes(location.pathname) && document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], form')) {
        sessionStorage.removeItem(LOGIN_REDIRECT);
        return "idle";
      }
      if (sessionStorage.getItem(LOGIN_REDIRECT)) {
        return ["/", "/home.php"].includes(location.pathname) ? "settled" : "pending";
      }
      if (document.readyState !== "complete" || !["/", "/home.php"].includes(location.pathname) || !document.querySelector('[role="feed"], [data-pagelet^="FeedUnit_"]') || document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], form'))
        return "idle";
      sessionStorage.setItem(LOGIN_REDIRECT, "1");
    } catch {
      return "settled";
    }
    location.replace("https://www.facebook.com/messages");
    return "settled";
  }
  function showLoaderUntilLoginRenders() {
    if (!onFacebookHost() || /(?:^|;\s*)c_user=/.test(document.cookie)) return;
    if (!/^\/(?:login(?:\.php)?\/?)?$/i.test(location.pathname)) return;
    const html = document.documentElement;
    html.setAttribute(LOADING, "");
    const started = performance.now();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (performance.now() - started < 700) {
        html.removeAttribute(LOADING);
        return;
      }
      html.setAttribute(LOADING, "done");
      setTimeout(() => html.removeAttribute(LOADING), 300);
    };
    setTimeout(finish, LOADER_LIMIT_MS);
    const whenRendered = () => {
      if (done) return;
      if (!document.querySelector('input[name="pass"]')) {
        requestAnimationFrame(whenRendered);
        return;
      }
      document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(finish)));
    };
    requestAnimationFrame(whenRendered);
  }
  function initLoginTidy() {
    showLoaderUntilLoginRenders();
    let scheduled = false;
    let tidyObserver = null;
    const prefersDark = () => !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const wantDark = () => {
      const t = window.__CARRIER_SETTINGS__?.theme;
      if (t === "dark") return true;
      if (t === "light") return false;
      return prefersDark();
    };
    const isRequiredLoginUi = (el) => {
      if (el?.nodeType !== 1) return false;
      if (el === document.documentElement || el === document.body) return false;
      const role = el.getAttribute("role");
      if (role === "dialog" || role === "alertdialog") return true;
      if (el.querySelector?.('[role="dialog"], [role="alertdialog"]')) return true;
      if (findOptionalCookieDeclineButton(el)) return true;
      return hasCookieConsentContext(el);
    };
    const copyLogo = (html) => {
      const logo = document.querySelector('[role="banner"] svg');
      if (!logo) return;
      const color = getComputedStyle(logo).color || "#0866ff";
      if (html.getAttribute(LOGO) === color) return;
      const copy = logo.cloneNode(true);
      copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      copy.setAttribute("fill", color);
      copy.removeAttribute("class");
      const data = encodeURIComponent(new XMLSerializer().serializeToString(copy));
      html.style.setProperty("--carrier-login-logo", `url("data:image/svg+xml,${data}")`);
      html.setAttribute(LOGO, color);
    };
    const restoreRequiredLoginUi = () => {
      for (const el of document.querySelectorAll(`[${HIDE}], [${REQUIRED}]`)) {
        if (isRequiredLoginUi(el)) {
          el.removeAttribute(HIDE);
          el.setAttribute(REQUIRED, "");
        } else {
          el.removeAttribute(REQUIRED);
        }
      }
    };
    const clearFooterMarks = () => {
      document.querySelectorAll(`[${FOOTER}]`).forEach((el) => el.removeAttribute(FOOTER));
      document.querySelectorAll(`[${FOOTER_KEEP}]`).forEach((el) => el.removeAttribute(FOOTER_KEEP));
      document.querySelectorAll(`[${FOOTER_LINKS}]`).forEach((el) => el.removeAttribute(FOOTER_LINKS));
      document.querySelectorAll(`[${LANGUAGES}]`).forEach((el) => el.removeAttribute(LANGUAGES));
      document.querySelectorAll(`[${LANGUAGE_LINK}]`).forEach((el) => el.removeAttribute(LANGUAGE_LINK));
    };
    const linkDescriptor = (link) => ({
      href: link.getAttribute("href") || "",
      text: link.textContent || ""
    });
    const isLanguageLink = (link) => link.hasAttribute(LANGUAGE_LINK) || isLanguageFooterLink(linkDescriptor(link));
    const topLanguageLinks = (links) => {
      return topLanguageLinkIndexes(links.map(linkDescriptor)).map((index) => links[index]);
    };
    const linksOutside = (root, inner) => [...root.querySelectorAll?.("a[href]") || []].filter((link) => !inner.contains(link));
    const isFooterContainer = (el, inner) => {
      if (!el?.querySelector) return false;
      if (el.querySelector("#pageFooter, .localeSelectorList")) return true;
      const links = linksOutside(el, inner);
      return links.length >= 6 && (topLanguageLinks(links).length >= 2 || links.filter(isLanguageLink).length >= 2);
    };
    const commonAncestor = (nodes) => {
      let root = nodes[0];
      while (root && !nodes.every((node) => root.contains(node))) root = root.parentElement;
      return root;
    };
    const keepLanguageStrip = (col, languageLinks) => {
      const languageRoot = commonAncestor(languageLinks);
      if (!languageRoot || languageRoot === document.body || languageRoot.contains(col)) return;
      let footer = languageRoot;
      while (footer.parentElement && footer.parentElement !== document.body && !footer.parentElement.contains(col)) {
        footer = footer.parentElement;
      }
      languageLinks.forEach((link) => link.setAttribute(LANGUAGE_LINK, ""));
      languageRoot.setAttribute(LANGUAGES, "");
      footer.setAttribute(FOOTER, "");
      for (let node = languageRoot; node; node = node.parentElement) {
        node.removeAttribute(HIDE);
        node.removeAttribute(FOOTER_LINKS);
        if (node !== footer && node !== languageRoot) node.setAttribute(FOOTER_KEEP, "");
        if (node === footer) break;
        for (const sibling of node.parentElement?.children || []) {
          if (sibling !== node && !isRequiredLoginUi(sibling)) sibling.setAttribute(FOOTER_LINKS, "");
        }
      }
    };
    const tidyFooter = (col) => {
      clearFooterMarks();
      const allLinks = [...document.querySelectorAll("a[href]")].filter(
        (link) => !col.contains(link)
      );
      const languageLinks = topLanguageLinks(allLinks);
      const languageSet = new Set(languageLinks);
      if (languageLinks.length >= 2) keepLanguageStrip(col, languageLinks);
      const inDialog = (el) => !!el.closest('[role="dialog"], [role="alertdialog"]');
      for (const link of allLinks) {
        if (languageSet.has(link) || link.hasAttribute(LANGUAGE_LINK) || inDialog(link)) continue;
        (link.closest("li") || link).setAttribute(FOOTER_LINKS, "");
      }
      for (const el of document.body.querySelectorAll("div, span")) {
        if (el.contains(col) || col.contains(el) || inDialog(el)) continue;
        if (languageLinks.some((link) => el.contains(link))) continue;
        if (/(\bMeta\s*©|\bMeta\s+\d{4}\b|©\s*\d{4})/i.test(el.textContent || "")) {
          el.setAttribute(FOOTER_LINKS, "");
        }
      }
    };
    function tidy() {
      const loginRecovery = returnToMessengerAfterLogin();
      const html = document.documentElement;
      document.querySelectorAll(`[${LIGHT_BG}]`).forEach((el) => el.removeAttribute(LIGHT_BG));
      if (onFacebookHost() && /^\/(?:auth_platform|checkpoint|two_factor|two_step|authentication|recover|confirmemail|device-based)/i.test(
        location.pathname
      )) {
        html.setAttribute("data-carrier-authtext", "");
      } else {
        html.removeAttribute("data-carrier-authtext");
      }
      const pass = document.querySelector('input[name="pass"]');
      const isLogin = onFacebookHost() && !!pass && !!document.querySelector('input[name="email"]');
      if (!isLogin) {
        if (html.hasAttribute("data-carrier-login")) {
          html.removeAttribute("data-carrier-login");
          document.querySelectorAll(`[${HIDE}]`).forEach((el) => el.removeAttribute(HIDE));
          document.querySelectorAll(`[${COL}]`).forEach((el) => el.removeAttribute(COL));
          document.querySelectorAll(`[${ANC}]`).forEach((el) => el.removeAttribute(ANC));
          document.querySelectorAll(`[${FORM}]`).forEach((el) => el.removeAttribute(FORM));
          document.querySelectorAll(`[${CARD}]`).forEach((el) => el.removeAttribute(CARD));
          document.querySelectorAll(`[${REQUIRED}]`).forEach((el) => el.removeAttribute(REQUIRED));
          html.removeAttribute(LOGO);
          html.style.removeProperty("--carrier-login-logo");
          clearFooterMarks();
          html.removeAttribute("data-carrier-login-dark");
        }
        if (tidyObserver && /\bc_user=/.test(document.cookie) && (loginRecovery === "settled" || loginRecovery === "idle" && !["/", "/home.php"].includes(location.pathname)) && !html.hasAttribute("data-carrier-authtext") && document.readyState === "complete") {
          tidyObserver.disconnect();
          tidyObserver = null;
          window.removeEventListener("resize", schedule);
        }
        return;
      }
      html.setAttribute("data-carrier-login", "");
      html.toggleAttribute("data-carrier-login-dark", wantDark());
      const form = pass.closest("form");
      if (!form) return;
      document.querySelectorAll(`[${FORM}]`).forEach((el) => {
        if (el !== form) el.removeAttribute(FORM);
      });
      form.setAttribute(FORM, "");
      let card = form;
      for (let i = 0; i < 4 && card.parentElement; i++) {
        const parent = card.parentElement;
        if (parent === document.body || parent.getBoundingClientRect().width >= window.innerWidth * 0.92)
          break;
        if (isFooterContainer(parent, form)) break;
        if (linksOutside(parent, form).length > 4) break;
        card = parent;
      }
      document.querySelectorAll(`[${CARD}]`).forEach((el) => {
        if (el !== card) el.removeAttribute(CARD);
      });
      card.setAttribute(CARD, "");
      let col = card;
      while (col.parentElement && col.parentElement !== document.body && col.parentElement.getBoundingClientRect().width < window.innerWidth * 0.92 && !isFooterContainer(col.parentElement, form) && linksOutside(col.parentElement, form).length <= 4) {
        col = col.parentElement;
      }
      document.querySelectorAll(`[${COL}]`).forEach((el) => {
        if (el !== col) el.removeAttribute(COL);
      });
      document.querySelectorAll(`[${ANC}]`).forEach((el) => el.removeAttribute(ANC));
      for (let node2 = col; node2 && node2 !== document.body; node2 = node2.parentElement) {
        node2.removeAttribute(HIDE);
        node2.removeAttribute(FOOTER_LINKS);
      }
      form.querySelectorAll(`[${HIDE}], [${FOOTER_LINKS}]`).forEach((el) => {
        el.removeAttribute(HIDE);
        el.removeAttribute(FOOTER_LINKS);
      });
      if (!col.hasAttribute(COL)) col.setAttribute(COL, "");
      html.setAttribute("data-carrier-login-vw", String(Math.round(window.innerWidth)));
      html.setAttribute("data-carrier-login-vh", String(Math.round(window.innerHeight)));
      html.setAttribute(
        "data-carrier-login-col-w",
        String(Math.round(col.getBoundingClientRect().width))
      );
      html.setAttribute(
        "data-carrier-login-card-w",
        String(Math.round(card.getBoundingClientRect().width))
      );
      html.setAttribute(
        "data-carrier-login-form-w",
        String(Math.round(form.getBoundingClientRect().width))
      );
      restoreRequiredLoginUi();
      tidyFooter(col);
      copyLogo(html);
      let node = col;
      while (node?.parentElement && node !== document.body) {
        for (const sib of node.parentElement.children) {
          if (sib !== node && sib.hasAttribute(FOOTER)) {
            sib.removeAttribute(HIDE);
            continue;
          }
          if (sib !== node && isRequiredLoginUi(sib)) {
            sib.removeAttribute(HIDE);
            sib.setAttribute(REQUIRED, "");
            continue;
          }
          if (sib !== node && !sib.hasAttribute(HIDE) && !sib.hasAttribute(COL)) {
            sib.setAttribute(HIDE, "");
          }
        }
        if (node !== col && !node.hasAttribute(ANC)) node.setAttribute(ANC, "");
        node = node.parentElement;
      }
      if (wantDark()) {
        for (const el of col.querySelectorAll("*")) {
          if (isLightFill(getComputedStyle(el).backgroundColor)) el.setAttribute(LIGHT_BG, "");
        }
      }
    }
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        try {
          tidy();
        } catch (_) {
        }
      });
    };
    schedule();
    tidyObserver = new MutationObserver(schedule);
    tidyObserver.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("carrier:settings", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("load", schedule, { once: true });
    for (const delay of [300, 1200]) setTimeout(schedule, delay);
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", schedule);
    }
  }

  // inject/src/messenger/lib/media-autoplay.ts
  var MEDIA_ACTIVATION_GRACE_MS = 1500;
  function shouldSuppressMediaPlay(enabled, lastActivationAt, now, graceMs = MEDIA_ACTIVATION_GRACE_MS) {
    if (!enabled) return false;
    if (!Number.isFinite(lastActivationAt) || !Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs < 0 || lastActivationAt > now) {
      return true;
    }
    return now - lastActivationAt > graceMs;
  }

  // inject/src/messenger/features/media-autoplay.ts
  var VIDEO_SELECTOR = "video";
  function initMediaAutoplay() {
    const on2 = () => window.__CARRIER_SETTINGS__?.stop_media_autoplay === true;
    let lastActivationAt = Number.NEGATIVE_INFINITY;
    let observer = null;
    const noteActivation = (event) => {
      if (event.isTrusted) lastActivationAt = performance.now();
    };
    window.addEventListener("pointerdown", noteActivation, true);
    window.addEventListener("keydown", noteActivation, true);
    const shouldSuppress = () => shouldSuppressMediaPlay(on2(), lastActivationAt, performance.now());
    const suppress = (video, force = false) => {
      if (!on2() || !force && !shouldSuppress()) return;
      video.autoplay = false;
      video.removeAttribute("autoplay");
      if (!video.paused) video.pause();
    };
    const scan = (root, force = false) => {
      if (!on2()) return;
      if (root.nodeType === Node.ELEMENT_NODE) {
        const element2 = root;
        if (element2.matches(VIDEO_SELECTOR)) suppress(element2, force);
        element2.querySelectorAll(VIDEO_SELECTOR).forEach((video) => suppress(video, force));
      } else if (root === document) {
        document.querySelectorAll(VIDEO_SELECTOR).forEach((video) => suppress(video, force));
      }
    };
    try {
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function() {
        if (this instanceof HTMLVideoElement && shouldSuppress()) {
          this.autoplay = false;
          this.removeAttribute("autoplay");
          this.pause();
          diag("media.autoplay", "automatic video or GIF playback suppressed");
          return Promise.resolve();
        }
        return originalPlay.call(this);
      };
    } catch (_) {
      diag("media.autoplay.patch", "could not install media playback guard");
    }
    const start = () => {
      if (observer) return;
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) scan(node);
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    };
    const stop = () => {
      observer?.disconnect();
      observer = null;
    };
    const apply2 = () => {
      if (on2()) {
        start();
        scan(document, true);
      } else {
        stop();
      }
    };
    apply2();
    window.addEventListener("carrier:settings", apply2);
  }

  // inject/src/messenger/lib/media-permissions.ts
  function requestedMediaDevices(constraints) {
    const devices = [];
    if (constraints?.video) devices.push("camera");
    if (constraints?.audio) devices.push("microphone");
    return devices;
  }
  function mediaDeviceLabel(devices) {
    return devices.join(" and ") || "media device";
  }
  function captureFailure(error) {
    const name = error && typeof error === "object" && "name" in error ? error.name : void 0;
    switch (name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return "denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "missing";
      case "NotReadableError":
      case "TrackStartError":
        return "unavailable";
      case "OverconstrainedError":
        return "constraints";
      default:
        return "other";
    }
  }
  function mediaPrivacyGuidance(platform) {
    switch (platform) {
      case "macos":
        return "Check System Settings → Privacy & Security and allow Carrier access. Then try the call again.";
      case "windows":
        return "Check Settings → Privacy & security and allow desktop apps access. Then try the call again.";
      case "linux":
        return "Check your desktop’s privacy and sound input settings, hardware privacy switches, and any sandbox permissions for Carrier. Then try the call again.";
    }
  }
  function captureFailureMessage(failure, devices) {
    const label2 = mediaDeviceLabel(devices);
    switch (failure) {
      case "denied":
        return `Access was denied for the requested ${label2}.`;
      case "missing":
        return `No matching device was found for the requested ${label2}. Check that the devices are connected and enabled, then try again.`;
      case "unavailable":
        return `The requested ${label2} could not start. Close other apps using these devices, check the connection, and try again.`;
      case "constraints":
        return `The requested ${label2} settings are not supported. Choose another device or call setting in Messenger and try again.`;
      case "other":
        return `Capture failed for the requested ${label2}. Check Messenger’s call settings and try again.`;
    }
  }
  function canActivateMediaPrivacy(isTrusted, isActive) {
    return isTrusted && (isActive ?? true);
  }

  // inject/src/messenger/lib/media-tracks.ts
  var LiveMediaTrackCounter = class {
    constructor(onChange) {
      __publicField(this, "onChange", onChange);
      __publicField(this, "tracked", /* @__PURE__ */ new WeakSet());
      __publicField(this, "live", 0);
    }
    add(track) {
      if (this.tracked.has(track) || track.readyState === "ended") return;
      this.tracked.add(track);
      let active = true;
      const finish = () => {
        if (!active) return;
        active = false;
        this.live = Math.max(0, this.live - 1);
        this.onChange(this.live > 0);
      };
      this.live += 1;
      this.onChange(true);
      track.addEventListener("ended", finish, { once: true });
      const originalStop = track.stop.bind(track);
      track.stop = () => {
        try {
          originalStop();
        } finally {
          finish();
        }
      };
    }
    count() {
      return this.live;
    }
  };

  // inject/src/messenger/features/media-permission-card.ts
  var names = { camera: "Camera", microphone: "Microphone" };
  var icons = {
    camera: '<rect x="3" y="6" width="12" height="12" rx="3"/><path d="m15 10 6-3v10l-6-3"/>',
    microphone: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3m-3 0h6"/>'
  };
  function showMediaPermissionCard(failures2, dismiss, recovered) {
    const devices = [...failures2.keys()];
    const permissionOnly = [...failures2.values()].every((failure2) => failure2 === "denied");
    const hasDenial = [...failures2.values()].includes("denied");
    const failure = hasDenial ? "denied" : failures2.values().next().value ?? "other";
    const failureGroups = /* @__PURE__ */ new Map();
    for (const [device, reason] of failures2)
      failureGroups.set(reason, [...failureGroups.get(reason) ?? [], device]);
    const failureDescription = [...failureGroups].map(([reason, group]) => captureFailureMessage(reason, group)).join(" ");
    const platform = carrierMediaPlatform;
    const host = document.createElement("div");
    host.id = "carrier-media-permission-banner";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
    :host { all: initial; position: fixed; bottom: 68px; right: 20px; z-index: 2147483646;
      width: 380px; max-width: calc(100vw - 32px); color-scheme: light dark;
      --surface: #fff; --text: #1c1e21; --muted: #65676b; --border: #d8dbe1;
      --icon: #eef0f3; --amber: #845709; --green: #237644; --focus: #0866ff; }
    @media (prefers-color-scheme: dark) { :host { --surface: #303133; --text: #e4e6eb;
      --muted: #b0b3b8; --border: #4b4d53; --icon: #414347; --amber: #ecc47c; --green: #86d6a4; --focus: #83b2ff; } }
    :host([data-theme="dark"]) { --surface: #303133; --text: #e4e6eb; --muted: #b0b3b8;
      --border: #4b4d53; --icon: #414347; --amber: #ecc47c; --green: #86d6a4; --focus: #83b2ff; }
    :host([data-theme="light"]) { --surface: #fff; --text: #1c1e21; --muted: #65676b;
      --border: #d8dbe1; --icon: #eef0f3; --amber: #845709; --green: #237644; --focus: #0866ff; }
    * { box-sizing: border-box; } section { padding: 16px; border: 1px solid var(--border);
      border-radius: 12px; background: var(--surface); color: var(--text);
      box-shadow: 0 12px 30px #0004; font: 12px/1.5 system-ui, sans-serif;
      max-height: calc(100vh - 100px); overflow-y: auto; }
    h2 { margin: 0 0 5px; font-size: 15px; line-height: 1.4; } p { margin: 0; color: var(--muted); }
    header { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
    .header-icon { color: var(--amber); }
    .device { display: flex; align-items: center; gap: 10px;
      padding: 12px 0; border-top: 1px solid var(--border); }
    .icon { width: 30px; height: 30px; flex-shrink: 0; background: var(--icon); border-radius: 8px;
      display: grid; place-items: center; } svg { width: 17px; height: 17px; fill: none;
      stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .info { flex: 1; min-width: 0; } strong { display: block; font-weight: 600; }
    .status { font-size: 11px; color: var(--muted); } .status[data-tone="warning"] { color: var(--amber); }
    .status[data-tone="good"], .check { color: var(--green); } .check { font-size: 18px; padding: 0 8px; }
    button { border: 0; border-radius: 6px; padding: 7px 10px; background: #0866ff; color: white;
      font: 600 11px/1.5 system-ui, sans-serif; cursor: pointer; flex-shrink: 0; }
    button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    button:disabled { opacity: .6; cursor: wait; } [hidden] { display: none !important; }
    footer { display: flex; justify-content: space-between; gap: 10px; align-items: center;
      border-top: 1px solid var(--border); padding-top: 10px; font-size: 10px; color: var(--muted); }
    footer button { color: var(--focus); background: transparent; padding: 5px 0 5px 8px; font-weight: 500; }
    .guidance { margin: 0 0 12px; font-size: 11px; }
  </style><section aria-label="Call device recovery">
    <header><span class="icon header-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[devices.includes("camera") ? "camera" : "microphone"]}</svg></span>
      <div><h2 role="alert"></h2><p class="description"></p></div></header>
    <div class="devices"></div><p class="guidance"></p>
    <footer><span></span><button type="button">Dismiss</button></footer>
  </section>`;
    const title = root.querySelector("h2");
    const description = root.querySelector(".description");
    const guidance = root.querySelector(".guidance");
    const footer = root.querySelector("footer span");
    let disposed = false;
    let pending = false;
    let snapshot = { camera: "unknown", microphone: "unknown" };
    let confirmation;
    let actionError = "";
    const rows = ["camera", "microphone"].map((device) => {
      const row = document.createElement("div");
      row.className = "device";
      row.innerHTML = `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[device]}</svg></span>
      <div class="info"><strong>${names[device]}</strong><span class="status"></span></div>
      <span class="check" aria-hidden="true" hidden>✓</span><button type="button" hidden></button>`;
      root.querySelector(".devices").append(row);
      const button = row.querySelector("button");
      button.addEventListener("click", async (event) => {
        if (!canActivateMediaPrivacy(event.isTrusted, navigator.userActivation?.isActive) || pending)
          return;
        const state3 = snapshot[device];
        pending = true;
        actionError = "";
        render();
        try {
          if (state3 === "not-determined" && platform === "macos") {
            accept(await carrierMediaPermissionStatus(device));
          } else {
            await carrierOpenMediaPrivacy(device);
          }
        } catch {
          actionError = `The action could not finish. ${mediaPrivacyGuidance(platform)}`;
        } finally {
          pending = false;
          if (!disposed) {
            render();
            void refresh();
          }
        }
      });
      return {
        device,
        button,
        status: row.querySelector(".status"),
        check: row.querySelector(".check")
      };
    });
    const render = () => {
      const blocked = devices.filter((device) => snapshot[device] === "denied");
      const restricted = devices.some((device) => snapshot[device] === "restricted");
      title.textContent = confirmation ? "Access updated" : failure === "denied" ? blocked.length === 1 ? `${names[blocked[0]]} access is blocked` : "Call access needs attention" : "Your call could not start";
      description.textContent = confirmation ? "Try your call again in Messenger." : permissionOnly && blocked.length ? `Allow Carrier to use your ${mediaDeviceLabel(blocked)} for calls.` : failureDescription;
      guidance.textContent = actionError || (failure === "denied" && !confirmation ? restricted ? "Access is restricted by system policy. Check with the person who manages this Mac." : devices.every((device) => snapshot[device] === "allowed") ? "macOS allows access. Check Messenger’s call settings and try again." : mediaPrivacyGuidance(platform) : "");
      guidance.hidden = !guidance.textContent;
      for (const { device, button, status, check } of rows) {
        const state3 = snapshot[device];
        status.textContent = state3 === "allowed" ? "Allowed by macOS" : state3 === "denied" ? "Blocked in macOS Settings" : state3 === "restricted" ? "Restricted by system policy" : state3 === "not-determined" ? "Not requested yet" : "Status unavailable";
        status.dataset.tone = state3 === "allowed" ? "good" : state3 === "denied" || state3 === "restricted" ? "warning" : "neutral";
        check.hidden = state3 !== "allowed";
        const allow = state3 === "not-determined" && platform === "macos" && failures2.get(device) === "denied" && devices.includes(device);
        const settings = state3 === "denied" && failures2.get(device) === "denied" || state3 === "unknown" && failures2.get(device) === "denied" && devices.includes(device) && platform !== "linux";
        button.hidden = !allow && !settings;
        button.textContent = allow ? "Allow access" : "Open Settings";
        button.setAttribute(
          "aria-label",
          `${allow ? "Allow access to" : "Open settings for"} ${device}`
        );
        button.disabled = pending;
      }
      footer.textContent = pending ? "Checking access…" : platform === "macos" ? "Rechecks when you return" : "OS permission status unavailable";
    };
    const accept = (next) => {
      if (disposed) return;
      const changed = devices.some(
        (device) => snapshot[device] === "denied" || snapshot[device] === "not-determined"
      );
      snapshot = next;
      if (!devices.every((device) => next[device] === "allowed")) {
        clearTimeout(confirmation);
        confirmation = void 0;
      }
      if (changed && devices.every((device) => next[device] === "allowed") && permissionOnly) {
        clearTimeout(confirmation);
        confirmation = setTimeout(recovered, 5e3);
      }
    };
    const refresh = async () => {
      if (disposed || pending || platform !== "macos" || document.visibilityState === "hidden")
        return;
      pending = true;
      render();
      try {
        accept(await carrierMediaPermissionStatus());
      } catch {
        accept({ camera: "unknown", microphone: "unknown" });
      } finally {
        pending = false;
        if (!disposed) render();
      }
    };
    const theme = () => {
      host.dataset.theme = window.__CARRIER_SETTINGS__?.theme ?? "system";
    };
    const onFocus = () => {
      void refresh();
    };
    root.querySelector("footer button").addEventListener("click", dismiss);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("carrier:settings", theme);
    theme();
    render();
    (document.body ?? document.documentElement).append(host);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(confirmation);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("carrier:settings", theme);
      host.remove();
    };
  }

  // inject/src/messenger/features/media-permissions.ts
  function initMediaPermissionWarning() {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const original = md.getUserMedia.bind(md);
    let removeCard;
    const failures2 = /* @__PURE__ */ new Map();
    let requestSerial = 0;
    let clearedThrough = 0;
    const remove = () => {
      removeCard?.();
      removeCard = void 0;
    };
    const hide = () => {
      remove();
      failures2.clear();
    };
    const dismissWarning = () => {
      clearedThrough = requestSerial;
      hide();
    };
    const render = () => {
      remove();
      if (failures2.size)
        removeCard = showMediaPermissionCard(new Map(failures2), dismissWarning, hide);
    };
    const liveTracks = new LiveMediaTrackCounter((inCall) => {
      window.__carrierInCall = inCall;
      window.dispatchEvent(new Event("carrier:protection-change"));
    });
    md.getUserMedia = async (constraints) => {
      const serial = ++requestSerial;
      const devices = requestedMediaDevices(constraints);
      let stream;
      try {
        stream = await original(constraints);
      } catch (error) {
        if (devices.length && serial > clearedThrough) {
          try {
            for (const device of devices) failures2.set(device, captureFailure(error));
            render();
          } catch {
            diag("media-recovery", "could not display call recovery guidance");
          }
        }
        throw error;
      }
      stream.getTracks().forEach((track) => liveTracks.add(track));
      for (const device of devices) failures2.delete(device);
      try {
        render();
      } catch {
        diag("media-recovery", "could not update call recovery guidance");
      }
      return stream;
    };
  }

  // inject/src/messenger/features/messenger-dnd.ts
  var REFRESH_MS = 3e4;
  function initMessengerDnd() {
    let reading = false;
    let lastActive = null;
    let unavailableReported = false;
    const refresh = () => {
      const account2 = accountId(document.cookie);
      if (reading || !account2) return;
      reading = true;
      readMessengerDndUntil(account2, window.require).then((until) => {
        if (until === null) {
          if (!unavailableReported) {
            diag("notify.messenger-dnd-unreadable", "Do Not Disturb unreadable");
          }
          unavailableReported = true;
          lastActive = null;
          return;
        }
        unavailableReported = false;
        setMessengerDndUntil(until);
        const active = messengerDndActive();
        if (active !== lastActive) diag("notify.messenger-dnd", active ? "on" : "off");
        lastActive = active;
      }).finally(() => {
        reading = false;
      });
    };
    setInterval(refresh, REFRESH_MS);
    window.addEventListener("focus", refresh);
    if (document.readyState === "complete") refresh();
    else window.addEventListener("load", refresh, { once: true });
  }

  // inject/src/messenger/lib/action-target.ts
  function actionTargetFor(value, cookie) {
    if (typeof value !== "object" || value === null) return null;
    const { account: account2, message = "", reaction = "" } = value;
    if (typeof account2 !== "string" || typeof message !== "string" || typeof reaction !== "string")
      return null;
    return account2 !== "" && account2 === accountId(cookie) ? { account: account2, message, reaction } : null;
  }

  // inject/src/messenger/lib/notification-actions.ts
  var TRACE = "CarrierNotificationActions";
  var ENTRYPOINT = "notificationInThreadReply";
  function exported(load, name, member) {
    const mod = load(name);
    const value = member ? mod?.[member] : typeof mod === "function" ? mod : mod?.default;
    if (typeof value !== "function") throw new Error(`${name} changed`);
    return value;
  }
  async function database(load) {
    const singleton = load("LSDatabaseSingleton");
    const db = await singleton?.LSDatabaseSingleton;
    const i64 = load("I64");
    if (typeof db?.runInTransaction !== "function" || typeof db.tables?.threads?.get !== "function" || typeof i64?.of_string !== "function")
      throw new Error("Messenger database APIs changed");
    return { db, i64 };
  }
  var record3 = (value) => value && typeof value === "object" ? value : null;
  async function markThreadRead(load, threadId, deadline, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    const { db, i64 } = await database(load);
    const key = i64.of_string(threadId);
    const markRead = exported(
      load,
      "MWLSMarkThreadAsRead"
    );
    if (Date.now() >= deadline) return "expired";
    await markRead(db, key);
    while (true) {
      const thread2 = record3(await db.tables.threads.get(key));
      if (!thread2) return "thread-missing";
      if (!i64.gt(thread2.lastActivityTimestampMs, thread2.lastReadWatermarkTimestampMs)) return "ok";
      if (Date.now() >= deadline) return "not-confirmed";
      await wait(200);
    }
  }
  async function reactToMessage(load, request) {
    const { db, i64 } = await database(load);
    const message = record3(
      await db.runInTransaction(
        (tx) => tx.messages.index("messageId").get(request.messageId),
        "readonly",
        void 0,
        void 0,
        TRACE
      )
    );
    if (!message) return "message-missing";
    const threadKey = message.threadKey;
    if (String(i64.to_string(threadKey)) !== request.threadId) return "thread-mismatch";
    const sender = String(i64.to_string(message.senderId));
    if (sender === request.account) return "own-message";
    const thread2 = record3(await db.tables.threads.get(threadKey));
    if (!thread2) return "thread-missing";
    const types = load("LSMessagingThreadTypeUtil");
    const attribution = exported(
      load,
      "LSThreadAttributionTypeUtil",
      "getSourceWithoutReset"
    );
    const source = attribution(threadKey, ENTRYPOINT);
    if (types.isArmadilloSecure(thread2.threadType)) {
      const msgId = exported(
        load,
        "MAWDbMsg",
        "toMsgId"
      )(request.messageId);
      if (!msgId) return "message-id";
      const ready2 = await exported(load, "MAWMiActOnActThreadReady", "waitForACTThreadReady")(db.tables, threadKey, TRACE);
      const protocolId = await exported(
        load,
        "MAWGetProtocolMsgIdByMsgIdInUI",
        "getProtocolMsgIdByMsgIdUI"
      )(msgId);
      if (!ready2?.chatJid || !protocolId) return "protocol-id";
      if (Date.now() >= request.deadline) return "expired";
      let qplEventType;
      try {
        qplEventType = exported(
          load,
          "qpl",
          "_"
        )(25313175, "1551");
      } catch (_) {
      }
      const result = await exported(load, "MAWBridgeSendAndReceive", "sendAndReceive")("backend", "sendReactionMsg", {
        args: {
          groupIndex: void 0,
          groupingKey: "",
          reaction: request.reaction,
          reactToAuthor: sender,
          reactToProtocolMsgId: protocolId,
          source
        },
        chatJid: ready2.chatJid,
        externalId: exported(load, "MAWExternalId", "generateExternalId")(),
        qplEventType,
        qplInstanceKey: void 0
      });
      return record3(result)?.success === false ? "bridge-refused" : "ok";
    }
    const v2 = exported(
      load,
      "useIsReactionsV2Enabled",
      "isReactionsV2Enabled"
    );
    if (v2(thread2)) return "reactions-v2";
    const actorId = i64.of_string(request.account);
    const mine = record3(
      await db.runInTransaction(
        (tx) => tx.reactions.get(threadKey, message.messageId, actorId),
        "readonly",
        void 0,
        void 0,
        TRACE
      )
    );
    if (mine?.reaction === request.reaction) return "ok";
    const factory = exported(load, "LSFactory");
    const upsert = exported(
      load,
      "LSOptimisticUpsertReactionStoredProcedure"
    );
    return db.runInTransaction(
      async (tx) => {
        if (Date.now() >= request.deadline) return "expired";
        await upsert(factory(tx), {
          actorId,
          messageId: message.messageId,
          reaction: request.reaction,
          sendAttribution: source,
          threadKey,
          timestampMs: i64.of_float(Date.now())
        });
        return "ok";
      },
      "readwrite",
      void 0,
      void 0,
      TRACE
    );
  }

  // inject/src/messenger/features/notification-actions.ts
  var BUDGET_MS = 12e3;
  function pageAction(name, run) {
    return (path, target, id, attempt, budgetMs) => {
      const report = (ok) => carrierReplyResult(id, attempt, ok).catch(
        () => diag(`${name}.ack`, `${name} acknowledgement emit failed`)
      );
      const thread2 = threadPathId(path);
      const notified = actionTargetFor(target, document.cookie);
      const load = window.require;
      if (!thread2 || !Number.isSafeInteger(id) || id <= 0 || !notified || typeof load !== "function") {
        void report(false);
        return;
      }
      const budget = Math.min(Number(budgetMs) || 0, BUDGET_MS);
      if (budget <= 0) {
        void report(false);
        return;
      }
      const deadline = Date.now() + budget;
      let timer;
      void Promise.race([
        run(load, thread2, notified, deadline),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("timed-out"), budget);
        })
      ]).catch(() => "exception").then((outcome) => {
        clearTimeout(timer);
        if (outcome !== "ok") diag(`${name}.failed`, `${name} stopped: ${outcome}`);
        void report(outcome === "ok");
      });
    };
  }
  function initNotificationActions() {
    window.__carrierMarkRead = pageAction(
      "mark-read",
      (load, thread2, _target, deadline) => markThreadRead(load, thread2, deadline)
    );
    window.__carrierQuickReact = pageAction(
      "react",
      async (load, thread2, target, deadline) => target.message && target.reaction ? reactToMessage(load, {
        threadId: thread2,
        messageId: target.message,
        account: target.account,
        reaction: target.reaction,
        deadline
      }) : "no-message"
    );
  }

  // inject/src/messenger/lib/conversation-row.ts
  function conversationNodeText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (node.getAttribute?.(SYSTEM_EMOJI_GLYPH_ATTR) != null) return "";
    if ((node.tagName || "").toUpperCase() === "IMG") {
      const source = node.getAttribute?.("src") || "";
      return !source || EMOJI_SOURCE_RE.test(source) ? emojiGlyph(node.getAttribute?.("alt")) : "";
    }
    let text = "";
    for (const child of Array.from(node.childNodes || [])) text += conversationNodeText(child);
    return text || emojiGlyph(node.getAttribute?.("aria-label"));
  }
  function plainNodeText(node) {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    let text = "";
    for (const child of Array.from(node.childNodes || [])) text += plainNodeText(child);
    return text;
  }
  function hasCandidateTextChild(node) {
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType !== 1) continue;
      if (child.getAttribute?.(SYSTEM_EMOJI_GLYPH_ATTR) != null) continue;
      if (plainNodeText(child).trim()) return true;
    }
    return false;
  }
  var ROW_BODY_LIMIT = 240;
  function conversationTextParts(candidates, canonicalBody) {
    const values = [];
    const eligible = candidates.filter(
      ({ text, width: width2, height, ariaHidden, inAbbreviation, hasTextChild }) => !ariaHidden && !inAbbreviation && !hasTextChild && width2 > 1 && height > 1 && text.trim().length > 0
    );
    const textNodes = new Set(eligible.map(({ node }) => node).filter(Boolean));
    for (const candidate of eligible.filter(({ node }) => {
      for (let parent = node?.parentNode; parent; parent = parent.parentNode) {
        if (textNodes.has(parent)) return false;
      }
      return true;
    }).sort((left, right) => left.y - right.y || left.x - right.x)) {
      const text = candidate.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const last = values[values.length - 1];
      if (last && Math.abs(last.y - candidate.y) < 1) {
        if (last.text.includes(text)) continue;
        if (text.includes(last.text)) {
          values[values.length - 1] = { text, y: candidate.y };
          continue;
        }
      }
      values.push({ text, y: candidate.y });
    }
    const body = values[1]?.text || "";
    return {
      title: (values[0]?.text || "Messenger").slice(0, 80),
      body: (canonicalBody ? canonicalBody(body) : body).slice(0, ROW_BODY_LIMIT)
    };
  }
  function isUnreadConversationText(fontWeight, text) {
    const weight = typeof fontWeight === "number" ? fontWeight : Number.parseInt(fontWeight, 10) || 0;
    return weight >= 600 && text.trim().length > 1;
  }

  // inject/src/messenger/lib/notification-fallback.ts
  var READ_SINCE_LIMIT = 500;
  var ConversationNotificationTracker = class {
    constructor() {
      __publicField(this, "signatures", /* @__PURE__ */ new Map());
      /**
       * Threads observed rendered-and-read, waiting for their next message. A read
       * row's signature is dropped below along with every other non-unread row, so
       * without this set the thread comes back as a first sighting and primes
       * silently — the first message after you read a conversation would never
       * notify, however different its preview text.
       */
      __publicField(this, "readSince", /* @__PURE__ */ new Set());
      __publicField(this, "primed", false);
    }
    /**
     * `confirmedRead` — threads the caller has observed hydrated-and-read across
     * scans spanning real time. Single-scan read state is not enough: mid-
     * hydration a row can render its text before its unread styling, and that
     * flap would otherwise report as a new message.
     */
    observe(current, observedKeys, confirmedRead, readTransitions) {
      const currentKeys = /* @__PURE__ */ new Set();
      const changed = [];
      for (const conversation of current) {
        currentKeys.add(conversation.key);
        const previous = this.signatures.get(conversation.key);
        const wasRead = this.readSince.delete(conversation.key);
        this.signatures.set(conversation.key, conversation.signature);
        if (!this.primed) continue;
        if (wasRead || previous !== void 0 && previous !== conversation.signature) {
          changed.push(conversation.key);
          if (wasRead) readTransitions?.add(conversation.key);
        }
      }
      for (const key of observedKeys || currentKeys) {
        if (!currentKeys.has(key)) this.signatures.delete(key);
      }
      for (const key of confirmedRead || []) {
        if (currentKeys.has(key) || this.readSince.has(key)) continue;
        this.readSince.add(key);
        if (this.readSince.size > READ_SINCE_LIMIT) {
          this.readSince.delete(this.readSince.keys().next().value);
        }
      }
      this.primed = true;
      return changed;
    }
  };
  var normalizeNotificationText = (value) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  var hashText = (value) => {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (const byte of new TextEncoder().encode(value)) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * prime);
    }
    return hash.toString(16).padStart(16, "0");
  };
  var matchesExactOrTruncated = (left, right) => {
    if (left === right) return true;
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    return shorter.length >= 40 && longer.startsWith(shorter);
  };
  var splitGroupSender = (value) => {
    const separator = value.indexOf(": ");
    if (separator <= 0 || separator > 80) return { sender: null, message: value };
    return { sender: value.slice(0, separator), message: value.slice(separator + 2) };
  };
  function notificationDedupeKey(title, body) {
    const value = `${normalizeNotificationText(title)}\0${normalizeNotificationText(body)}`;
    return hashText(value);
  }
  function notificationDeliveryDedupeKey(fingerprint, generation) {
    return generation === void 0 ? fingerprint : notificationDedupeKey(fingerprint, generation);
  }
  var NOTIFIED_STORE_LIMIT = 300;
  var NOTIFIED_STORE_VERSION = 4;
  var NOTIFIED_STORE_RETIRED_VERSION = 3;
  var NOTIFIED_STORE_TEXT_VERSION = 2;
  var LEGACY_PLACEHOLDER_BODY = "New message";
  var STABLE_READ_MS = 3e4;
  var READ_DROP_CONFIRM_MS = 2e4;
  var READ_DROP_MIN_OBSERVATIONS = 3;
  var READ_TRANSITION_CONFIRM_MS = READ_DROP_CONFIRM_MS;
  var READ_TRANSITION_MIN_OBSERVATIONS = READ_DROP_MIN_OBSERVATIONS;
  var RETIRED_FINGERPRINT_TTL_MS = 3e4;
  var NotifiedSignatureStore = class {
    constructor(storage = null, storageKey2 = "__carrier_notified_previews__") {
      __publicField(this, "storage", storage);
      __publicField(this, "storageKey", storageKey2);
      __publicField(this, "entries", /* @__PURE__ */ new Map());
      /**
       * Fingerprints retired by a confirmed read. These survive a prompt reload so
       * the next unread transition can identify an identical preview as a fresh
       * delivery while the native content-key dedupe is still active.
       */
      __publicField(this, "readFingerprints", /* @__PURE__ */ new Map());
      /**
       * In-memory only: when each continuously observed read state began, and how
       * many consecutive scans have seen it.
       */
      __publicField(this, "readStreaks", /* @__PURE__ */ new Map());
      /** Entries whose unread state has been established in this document. */
      __publicField(this, "observedUnread", /* @__PURE__ */ new Set());
      try {
        const raw = this.storage?.getItem(this.storageKey);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const legacy = Array.isArray(parsed);
        const version = !legacy && parsed && typeof parsed === "object" && "version" in parsed ? parsed.version : null;
        const persistedEntries = legacy || (version === NOTIFIED_STORE_VERSION || version === NOTIFIED_STORE_RETIRED_VERSION || version === NOTIFIED_STORE_TEXT_VERSION) && parsed && typeof parsed === "object" && "entries" in parsed && Array.isArray(parsed.entries) ? legacy ? parsed : parsed.entries ?? [] : [];
        for (const entry of persistedEntries) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && (legacy || typeof entry[2] === "boolean")) {
            this.entries.set(entry[0], {
              fingerprint: entry[1],
              legacy: legacy || entry[2],
              bodyHash: typeof entry[3] === "string" ? entry[3] : void 0,
              suppressed: version === NOTIFIED_STORE_VERSION && typeof entry[4] === "boolean" ? entry[4] : false
            });
          }
        }
        if ((version === NOTIFIED_STORE_VERSION || version === NOTIFIED_STORE_RETIRED_VERSION) && parsed && typeof parsed === "object" && "retired" in parsed && Array.isArray(parsed.retired)) {
          const now = Date.now();
          for (const retired of parsed.retired) {
            if (Array.isArray(retired) && typeof retired[0] === "string" && typeof retired[1] === "string" && typeof retired[2] === "number" && now - retired[2] <= RETIRED_FINGERPRINT_TTL_MS) {
              this.readFingerprints.set(retired[0], {
                fingerprint: retired[1],
                retiredAt: retired[2]
              });
            }
          }
        }
      } catch (_) {
      }
      let trimmed = false;
      while (this.entries.size > NOTIFIED_STORE_LIMIT) {
        this.entries.delete(this.entries.keys().next().value);
        trimmed = true;
      }
      while (this.readFingerprints.size > NOTIFIED_STORE_LIMIT) {
        this.readFingerprints.delete(this.readFingerprints.keys().next().value);
        trimmed = true;
      }
      if (trimmed) this.persist();
    }
    persist() {
      try {
        this.storage?.setItem(
          this.storageKey,
          JSON.stringify({
            version: NOTIFIED_STORE_VERSION,
            entries: [...this.entries].map(([key, entry]) => [
              key,
              entry.fingerprint,
              entry.legacy,
              entry.bodyHash ?? null,
              entry.suppressed
            ]),
            retired: [...this.readFingerprints].map(([key, retired]) => [
              key,
              retired.fingerprint,
              retired.retiredAt
            ])
          })
        );
      } catch (_) {
      }
    }
    alreadyNotified(conversationKey, fingerprint) {
      return this.entries.get(conversationKey)?.fingerprint === fingerprint;
    }
    /** When a confirmed read retired this conversation's preview, while remembered. */
    readAt(conversationKey) {
      const retired = this.readFingerprints.get(conversationKey);
      return retired && Date.now() - retired.retiredAt <= RETIRED_FINGERPRINT_TTL_MS ? retired.retiredAt : void 0;
    }
    /** The fingerprint last delivered or deliberately suppressed, if any. */
    notifiedFingerprint(conversationKey) {
      return this.entries.get(conversationKey)?.fingerprint;
    }
    /**
     * Compare a hydrated row with its persisted delivery. Old unversioned entries
     * may contain the synthetic "New message" body from pre-v2 hydration scans;
     * migrate only those proven-legacy placeholders, never a new-schema message
     * whose real text happens to be the same phrase.
     */
    reconcileFingerprint(conversationKey, title, fingerprint, bodyHash, confirmedReadTransition = false) {
      const entry = this.entries.get(conversationKey);
      const retired = this.readFingerprints.get(conversationKey);
      const retiredFingerprint = retired && Date.now() - retired.retiredAt <= RETIRED_FINGERPRINT_TTL_MS ? retired.fingerprint : void 0;
      if (confirmedReadTransition || retiredFingerprint !== void 0) {
        const deliveredFingerprint = entry?.fingerprint ?? retiredFingerprint;
        if (this.readFingerprints.delete(conversationKey)) this.persist();
        if (deliveredFingerprint === fingerprint || bodyHash !== void 0 && entry?.bodyHash === bodyHash) {
          return "repeated";
        }
      }
      if (!entry) return "missing";
      if (entry.fingerprint === fingerprint) {
        if (entry.legacy || bodyHash !== void 0 && entry.bodyHash === void 0) {
          entry.legacy = false;
          if (bodyHash !== void 0) entry.bodyHash = bodyHash;
          this.persist();
        }
        return entry.suppressed ? "suppressed" : "matched";
      }
      if (bodyHash !== void 0 && entry.bodyHash !== void 0 && entry.bodyHash === bodyHash) {
        entry.fingerprint = fingerprint;
        entry.legacy = false;
        this.persist();
        return entry.suppressed ? "suppressed" : "matched";
      }
      const legacyPlaceholder = entry.legacy && (entry.fingerprint === notificationDedupeKey(title, LEGACY_PLACEHOLDER_BODY) || entry.fingerprint === notificationDedupeKey("Messenger", LEGACY_PLACEHOLDER_BODY));
      if (!legacyPlaceholder) return "mismatched";
      entry.fingerprint = fingerprint;
      entry.legacy = false;
      entry.bodyHash = bodyHash;
      this.persist();
      return "migrated";
    }
    markNotified(conversationKey, fingerprint, bodyHash) {
      this.markHandled(conversationKey, fingerprint, bodyHash, false);
    }
    markSuppressed(conversationKey, fingerprint, bodyHash) {
      this.markHandled(conversationKey, fingerprint, bodyHash, true);
    }
    markHandled(conversationKey, fingerprint, bodyHash, suppressed) {
      this.readStreaks.delete(conversationKey);
      const retired = this.readFingerprints.delete(conversationKey);
      const current = this.entries.get(conversationKey);
      if (current?.fingerprint === fingerprint && !current.legacy) {
        let changed = false;
        if (bodyHash !== void 0 && current.bodyHash !== bodyHash) {
          current.bodyHash = bodyHash;
          changed = true;
        }
        if (current.suppressed !== suppressed) {
          current.suppressed = suppressed;
          changed = true;
        }
        if (changed || retired) this.persist();
        return;
      }
      this.entries.delete(conversationKey);
      this.entries.set(conversationKey, { fingerprint, legacy: false, bodyHash, suppressed });
      while (this.entries.size > NOTIFIED_STORE_LIMIT) {
        const oldest = this.entries.keys().next().value;
        this.entries.delete(oldest);
        this.readStreaks.delete(oldest);
        this.observedUnread.delete(oldest);
        this.readFingerprints.delete(oldest);
      }
      this.persist();
    }
    /**
     * Forget conversations that are rendered without an unread preview — the
     * user has read them, so an identical future preview must notify again.
     * Persisted entries must remain continuously observed read for
     * [[STABLE_READ_MS]] until this document has first established their unread
     * state. After that, [[READ_DROP_CONFIRM_MS]] and
     * [[READ_DROP_MIN_OBSERVATIONS]] together confirm a real unread-to-read
     * transition. An unread or missing observation resets the streak so
     * virtualized rows cannot accumulate read time off-screen.
     *
     * `listHydrated` — every rendered row currently carries preview text. A
     * partially hydrated list is precisely when a still-unread row renders its
     * text before its unread styling, so such a scan is treated as no evidence
     * either way: it neither advances nor is allowed to satisfy a streak.
     */
    observeRead(unreadKeys, observedKeys, observedAt = Date.now(), listHydrated = true) {
      let dropped = false;
      const observed = new Set(observedKeys);
      for (const key of this.readStreaks.keys()) {
        if (!observed.has(key)) this.readStreaks.delete(key);
      }
      for (const key of observed) {
        if (!listHydrated) {
          this.readStreaks.delete(key);
          continue;
        }
        if (unreadKeys.has(key)) {
          this.readStreaks.delete(key);
          if (this.entries.has(key)) this.observedUnread.add(key);
          continue;
        }
        if (!this.entries.has(key)) continue;
        const streak = this.readStreaks.get(key);
        if (streak === void 0 || observedAt < streak.since) {
          this.readStreaks.set(key, { since: observedAt, observations: 1 });
          continue;
        }
        streak.observations += 1;
        const confirmAfter = this.observedUnread.has(key) ? READ_DROP_CONFIRM_MS : STABLE_READ_MS;
        if (observedAt - streak.since < confirmAfter) continue;
        if (streak.observations < READ_DROP_MIN_OBSERVATIONS) continue;
        this.readStreaks.delete(key);
        this.observedUnread.delete(key);
        this.readFingerprints.delete(key);
        this.readFingerprints.set(key, {
          fingerprint: this.entries.get(key).fingerprint,
          retiredAt: Date.now()
        });
        while (this.readFingerprints.size > NOTIFIED_STORE_LIMIT) {
          this.readFingerprints.delete(this.readFingerprints.keys().next().value);
        }
        this.entries.delete(key);
        dropped = true;
      }
      if (dropped) this.persist();
    }
  };
  var HASH_RE = /^[0-9a-f]{16}$/;
  var MIN_TRUNCATED_MATCH_LENGTH = 40;
  var TITLE_PREFIX_LIMIT = 80;
  var BODY_PREFIX_LIMIT = 240;
  var PAGE_RECEIPT_LIMIT = 20;
  var PAGE_NOTIFICATION_RECEIPT_TTL_MS = 12e4;
  var DRAFT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1e3;
  var receiptMatch = (receipt) => ({
    nativeId: receipt.nativeId,
    ...receipt.nativeDelivery === void 0 ? {} : { nativeDelivery: receipt.nativeDelivery },
    ...receipt.suppressedDraft ? { suppressedDraft: true } : {}
  });
  var opaqueTextIdentity = (value, prefixLimit) => {
    const prefixes = [];
    const lastPrefix = Math.min(value.length - 1, prefixLimit);
    for (let length = MIN_TRUNCATED_MATCH_LENGTH; length <= lastPrefix; length++) {
      prefixes.push([length, hashText(value.slice(0, length))]);
    }
    return { length: value.length, full: hashText(value), prefixes };
  };
  var opaqueNotificationIdentity = (title, body) => {
    const normalizedTitle = normalizeNotificationText(title);
    const normalizedBody = normalizeNotificationText(body);
    const group = splitGroupSender(normalizedBody);
    return {
      title: opaqueTextIdentity(normalizedTitle, TITLE_PREFIX_LIMIT),
      body: opaqueTextIdentity(normalizedBody, BODY_PREFIX_LIMIT),
      sender: group.sender === null ? null : hashText(group.sender),
      message: opaqueTextIdentity(group.message, BODY_PREFIX_LIMIT)
    };
  };
  var opaqueTextMatches = (left, right) => {
    if (left.full === right.full) return true;
    const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
    if (shorter.length < MIN_TRUNCATED_MATCH_LENGTH) return false;
    return longer.prefixes.some(
      ([length, fingerprint]) => length === shorter.length && fingerprint === shorter.full
    );
  };
  var opaqueNotificationMatches = (left, right) => {
    if (!opaqueTextMatches(left.title, right.title)) return false;
    return opaqueNotificationBodyMatches(left, right);
  };
  var opaqueNotificationBodyMatches = (left, right) => {
    if (left.body.length === 0 || right.body.length === 0) return true;
    if (opaqueTextMatches(left.body, right.body)) return true;
    const sendersCompatible = left.sender === null || right.sender === null || left.sender === right.sender;
    return sendersCompatible && opaqueTextMatches(left.message, right.message);
  };
  var validOpaqueTextIdentity = (value, prefixLimit) => {
    if (!value || typeof value !== "object") return false;
    const identity = value;
    return Number.isSafeInteger(identity.length) && identity.length >= 0 && typeof identity.full === "string" && HASH_RE.test(identity.full) && Array.isArray(identity.prefixes) && identity.prefixes.length <= prefixLimit - MIN_TRUNCATED_MATCH_LENGTH + 1 && identity.prefixes.every(
      (prefix) => Array.isArray(prefix) && Number.isSafeInteger(prefix[0]) && prefix[0] >= MIN_TRUNCATED_MATCH_LENGTH && prefix[0] <= prefixLimit && prefix[0] < identity.length && typeof prefix[1] === "string" && HASH_RE.test(prefix[1])
    );
  };
  var validOpaqueNotificationIdentity = (value) => {
    if (!value || typeof value !== "object") return false;
    const identity = value;
    return validOpaqueTextIdentity(identity.title, TITLE_PREFIX_LIMIT) && validOpaqueTextIdentity(identity.body, BODY_PREFIX_LIMIT) && validOpaqueTextIdentity(identity.message, BODY_PREFIX_LIMIT) && (identity.sender === null || typeof identity.sender === "string" && HASH_RE.test(identity.sender));
  };
  var PendingPageNotificationStore = class {
    constructor(storage = null, storageKey2 = "__carrier_pending_page_notifications__", ttlMs = PAGE_NOTIFICATION_RECEIPT_TTL_MS, now = Date.now()) {
      __publicField(this, "storage", storage);
      __publicField(this, "storageKey", storageKey2);
      __publicField(this, "ttlMs", ttlMs);
      __publicField(this, "receipts", []);
      try {
        const parsed = JSON.parse(this.storage?.getItem(this.storageKey) || "[]");
        if (Array.isArray(parsed)) {
          for (const receipt of parsed) {
            if (!receipt || typeof receipt !== "object") continue;
            const candidate = receipt;
            if (typeof candidate.at === "number" && Number.isFinite(candidate.at) && typeof candidate.id === "number" && Number.isSafeInteger(candidate.id) && candidate.id > 0 && validOpaqueNotificationIdentity(candidate.identity) && (candidate.thread === void 0 || typeof candidate.thread === "string" && HASH_RE.test(candidate.thread)) && now - candidate.at >= 0 && now - candidate.at <= this.ttlMs) {
              this.receipts.push(candidate);
            }
          }
        }
      } catch (_) {
      }
      if (this.receipts.length > PAGE_RECEIPT_LIMIT) {
        this.receipts.splice(0, this.receipts.length - PAGE_RECEIPT_LIMIT);
      }
      this.persist();
    }
    persist() {
      try {
        this.storage?.setItem(this.storageKey, JSON.stringify(this.receipts));
      } catch (_) {
      }
    }
    prune(now) {
      let changed = false;
      for (let index = this.receipts.length - 1; index >= 0; index--) {
        const age = now - this.receipts[index].at;
        if (age < 0 || age > this.ttlMs) {
          this.receipts.splice(index, 1);
          changed = true;
        }
      }
      if (changed) this.persist();
    }
    add(title, body, id, at = Date.now(), thread2) {
      this.prune(at);
      this.receipts.push({
        at,
        id,
        identity: opaqueNotificationIdentity(title, body),
        ...thread2 && { thread: hashText(thread2) }
      });
      if (this.receipts.length > PAGE_RECEIPT_LIMIT) this.receipts.shift();
      this.persist();
    }
    remove(id) {
      const index = this.receipts.findIndex((receipt) => receipt.id === id);
      if (index === -1) return;
      this.receipts.splice(index, 1);
      this.persist();
    }
    consumeUniquelyMatching(rows, now = Date.now()) {
      this.prune(now);
      const recovered = /* @__PURE__ */ new Set();
      if (!this.receipts.length) return recovered;
      const identities = /* @__PURE__ */ new Map();
      for (const row of rows) {
        if (!identities.has(row.key)) {
          identities.set(row.key, opaqueNotificationIdentity(row.title, row.body));
        }
      }
      const remove = [];
      for (let index = 0; index < this.receipts.length; index++) {
        const receipt = this.receipts[index];
        let match = null;
        let ambiguous = false;
        for (const [key, identity] of identities) {
          if (receipt.thread && receipt.thread !== hashText(key)) continue;
          if (!opaqueNotificationMatches(receipt.identity, identity)) continue;
          if (match !== null && match !== key) {
            ambiguous = true;
            break;
          }
          match = key;
        }
        if (match === null) continue;
        remove.push(index);
        if (!ambiguous) recovered.add(match);
      }
      for (let index = remove.length - 1; index >= 0; index--) {
        this.receipts.splice(remove[index], 1);
      }
      if (remove.length) this.persist();
      return recovered;
    }
    discardReadMatches(readRows, now = Date.now()) {
      this.prune(now);
      if (!this.receipts.length) return;
      const read = [...readRows].map((row) => ({
        key: row.key ? hashText(row.key) : null,
        identity: opaqueNotificationIdentity(row.title, row.body)
      }));
      if (!read.length) return;
      let changed = false;
      for (let index = this.receipts.length - 1; index >= 0; index--) {
        const receipt = this.receipts[index];
        if (!read.some(
          ({ key, identity }) => (!receipt.thread || receipt.thread === key) && opaqueNotificationMatches(receipt.identity, identity)
        )) {
          continue;
        }
        this.receipts.splice(index, 1);
        changed = true;
      }
      if (changed) this.persist();
    }
  };
  var PageNotificationReceiptStore = class {
    constructor(storage = null, storageKey2 = "__carrier_page_notification_receipts__", ttlMs = PAGE_NOTIFICATION_RECEIPT_TTL_MS, now = Date.now()) {
      __publicField(this, "storage", storage);
      __publicField(this, "storageKey", storageKey2);
      __publicField(this, "ttlMs", ttlMs);
      __publicField(this, "receipts", []);
      __publicField(this, "draftMismatches", new StableMismatchTracker(1e3));
      try {
        const parsed = JSON.parse(this.storage?.getItem(this.storageKey) || "[]");
        if (Array.isArray(parsed)) {
          for (const receipt of parsed) {
            if (!receipt || typeof receipt !== "object") continue;
            const candidate = receipt;
            if (typeof candidate.at === "number" && Number.isFinite(candidate.at) && typeof candidate.nativeId === "number" && Number.isSafeInteger(candidate.nativeId) && candidate.nativeId > 0 && validOpaqueNotificationIdentity(candidate.identity) && (candidate.nativeDelivery === void 0 || candidate.nativeDelivery === "accepted" || candidate.nativeDelivery === "duplicate" || candidate.nativeDelivery === "suppressed") && (candidate.draftThread === void 0 || typeof candidate.draftThread === "string" && HASH_RE.test(candidate.draftThread)) && (candidate.thread === void 0 || typeof candidate.thread === "string" && HASH_RE.test(candidate.thread)) && (candidate.suppressedDraft === void 0 || candidate.suppressedDraft === true && candidate.draftThread !== void 0) && now - candidate.at >= 0 && now - candidate.at <= (candidate.draftThread === void 0 ? this.ttlMs : DRAFT_RECEIPT_TTL_MS)) {
              this.receipts.push(candidate);
            }
          }
        }
      } catch (_) {
      }
      this.trimReceipts();
      this.persist();
    }
    trimReceipts() {
      let ordinary = this.receipts.filter((receipt) => !receipt.draftThread).length;
      let drafts = this.receipts.length - ordinary;
      for (let index = 0; ordinary > PAGE_RECEIPT_LIMIT || drafts > PAGE_RECEIPT_LIMIT; ) {
        const draft = Boolean(this.receipts[index].draftThread);
        if ((draft ? drafts : ordinary) > PAGE_RECEIPT_LIMIT) {
          this.receipts.splice(index, 1);
          if (draft) drafts--;
          else ordinary--;
        } else {
          index++;
        }
      }
    }
    persist() {
      try {
        this.storage?.setItem(this.storageKey, JSON.stringify(this.receipts));
      } catch (_) {
      }
    }
    prune(now) {
      let changed = false;
      for (let index = this.receipts.length - 1; index >= 0; index--) {
        const age = now - this.receipts[index].at;
        const ttl = this.receipts[index].draftThread ? DRAFT_RECEIPT_TTL_MS : this.ttlMs;
        if (age < 0 || age > ttl) {
          this.receipts.splice(index, 1);
          changed = true;
        }
      }
      if (changed) this.persist();
    }
    add(title, body, nativeId, at = Date.now(), draft, thread2) {
      this.prune(at);
      this.receipts.push({
        at,
        nativeId,
        identity: opaqueNotificationIdentity(title, body),
        ...draft && { draftThread: hashText(draft.threadKey), suppressedDraft: draft.suppressed },
        ...thread2 && { thread: hashText(thread2) }
      });
      this.trimReceipts();
      this.persist();
    }
    recordDelivery(nativeId, delivery) {
      const receipt = this.receipts.find((candidate) => candidate.nativeId === nativeId);
      if (!receipt) return;
      receipt.nativeDelivery = delivery;
      this.persist();
    }
    retainForDraft(nativeId, threadKey) {
      const receipt = this.receipts.find((candidate) => candidate.nativeId === nativeId);
      if (!receipt) return;
      receipt.draftThread = hashText(threadKey);
      this.trimReceipts();
      this.persist();
    }
    retainSuppressedDraft(nativeId, threadKey) {
      const receipt = this.receipts.find((candidate) => candidate.nativeId === nativeId);
      if (!receipt) return;
      receipt.draftThread = hashText(threadKey);
      receipt.suppressedDraft = true;
      this.trimReceipts();
      this.persist();
    }
    retireDraftsWithDifferentPreview(rows, now = Date.now()) {
      this.prune(now);
      const previews = /* @__PURE__ */ new Map();
      for (const row of rows) {
        const key = hashText(row.key);
        const identities = previews.get(key) ?? [];
        identities.push(opaqueNotificationIdentity(row.title, row.body));
        previews.set(key, identities);
      }
      const mismatches = [];
      for (const receipt of this.receipts) {
        if (!receipt.draftThread) continue;
        const identities = previews.get(receipt.draftThread);
        if (!identities?.length || identities.some((identity) => opaqueNotificationBodyMatches(receipt.identity, identity)) || identities.some((identity) => identity.body.full !== identities[0].body.full))
          continue;
        mismatches.push([`${receipt.at}:${receipt.nativeId}`, identities[0].body.full]);
      }
      const observation = this.draftMismatches.observe(mismatches, now);
      if (!observation.recovered.length) return observation.confirmInMs;
      const retired = new Set(observation.recovered);
      const remaining = this.receipts.filter(
        (receipt) => !retired.has(`${receipt.at}:${receipt.nativeId}`)
      );
      this.receipts.splice(0, this.receipts.length, ...remaining);
      this.persist();
      return observation.confirmInMs;
    }
    consumeMatching(row, now = Date.now()) {
      this.prune(now);
      if (!this.receipts.length) return null;
      const identity = opaqueNotificationIdentity(row.title, row.body);
      for (let index = this.receipts.length - 1; index >= 0; index--) {
        const receipt = this.receipts[index];
        if (receipt.draftThread && receipt.draftThread !== hashText(row.key || "")) continue;
        if (receipt.thread && receipt.thread !== hashText(row.key || "")) continue;
        if (!(receipt.draftThread ? opaqueNotificationBodyMatches(receipt.identity, identity) : opaqueNotificationMatches(receipt.identity, identity)))
          continue;
        this.receipts.splice(index, 1);
        this.persist();
        return receiptMatch(receipt);
      }
      return null;
    }
    /**
     * Consume receipts that match exactly one of the given rows, keyed by that
     * row's conversation key. A receipt is only title/body identity, so when
     * several visible threads share the same display text, guessing would route
     * the native click to the wrong conversation and mark it delivered — an
     * ambiguous receipt is DROPPED instead: Messenger virtualizes the list, so
     * waiting for a unique match could just as well settle it onto the wrong
     * twin once the other scrolls away. Duplicate anchors for one thread count
     * as a single row. A draft receipt also requires its known thread key.
     */
    consumeUniquelyMatching(rows, now = Date.now()) {
      this.prune(now);
      const consumed = /* @__PURE__ */ new Map();
      if (!this.receipts.length) return consumed;
      const identities = /* @__PURE__ */ new Map();
      for (const row of rows) {
        const matches = identities.get(row.key) ?? [];
        matches.push(opaqueNotificationIdentity(row.title, row.body));
        identities.set(row.key, matches);
      }
      const remove = [];
      for (let index = 0; index < this.receipts.length; index++) {
        const receipt = this.receipts[index];
        let match = null;
        let ambiguous = false;
        let defer = false;
        for (const [key, candidates] of identities) {
          if (receipt.draftThread && receipt.draftThread !== hashText(key)) continue;
          if (receipt.thread && receipt.thread !== hashText(key)) continue;
          if (!candidates.some(
            (identity) => receipt.draftThread ? opaqueNotificationBodyMatches(receipt.identity, identity) : opaqueNotificationMatches(receipt.identity, identity)
          ))
            continue;
          if (candidates.some((identity) => identity.body.full !== candidates[0].body.full)) {
            if (receipt.draftThread) defer = true;
            else ambiguous = true;
          }
          if (match !== null && match !== key) {
            ambiguous = true;
            break;
          }
          match = key;
        }
        if (match === null || defer) continue;
        remove.push(index);
        if (ambiguous || consumed.has(match)) continue;
        consumed.set(match, receiptMatch(receipt));
      }
      for (let i = remove.length - 1; i >= 0; i--) this.receipts.splice(remove[i], 1);
      if (remove.length) this.persist();
      return consumed;
    }
    /**
     * Drop receipts whose notification was evidently read: the receipt matches
     * a read rendered row. Left in place, it would survive up to its TTL and
     * later swallow the pairing for a NEW identical-text message, suppressing
     * that message's only notification. This drops even when an unread twin
     * shares the text — the receipt's true thread is unknowable then, and a
     * duplicate fallback (absorbed by the native dedupe) beats misrouting the
     * click or marking the wrong thread delivered. Draft receipts have a known
     * thread, so only that row can retire them.
     */
    discardReadMatches(readRows, now = Date.now()) {
      this.prune(now);
      if (!this.receipts.length) return;
      const read = [...readRows].map((row) => ({
        key: row.key ? hashText(row.key) : null,
        identity: opaqueNotificationIdentity(row.title, row.body)
      }));
      if (!read.length) return;
      let changed = false;
      for (let index = this.receipts.length - 1; index >= 0; index--) {
        const receipt = this.receipts[index];
        if (!read.some(
          ({ key, identity }) => (!receipt.draftThread || receipt.draftThread === key) && (!receipt.thread || receipt.thread === key) && (receipt.draftThread ? opaqueNotificationBodyMatches(receipt.identity, identity) : opaqueNotificationMatches(receipt.identity, identity))
        )) {
          continue;
        }
        this.receipts.splice(index, 1);
        changed = true;
      }
      if (changed) this.persist();
    }
  };
  var PageNotificationQueue = class {
    constructor() {
      __publicField(this, "signals", []);
    }
    add(signal) {
      if (!signal.matchPromise) {
        signal.matchPromise = new Promise((resolve) => {
          signal.settleMatch = resolve;
        });
      }
      this.signals.push(signal);
      if (this.signals.length > 20) this.signals.shift();
      return signal;
    }
    /**
     * Return (and remove) the queued page signal that matches this row, or null.
     * Returning the signal — rather than a boolean — lets the caller reach its
     * `nativeId` and route the already-emitted page-first notification.
     */
    consumeMatching(row, rowChangeAt, matchWindowMs, candidateRows) {
      for (let index2 = this.signals.length - 1; index2 >= 0; index2--) {
        const signal2 = this.signals[index2];
        const age = rowChangeAt - signal2.at;
        if (age > matchWindowMs) {
          this.signals.splice(index2, 1);
        }
      }
      const matches = [];
      for (let index2 = this.signals.length - 1; index2 >= 0; index2--) {
        const signal2 = this.signals[index2];
        const age = rowChangeAt - signal2.at;
        if (signal2.thread !== void 0 && row.key !== void 0 && row.key !== signal2.thread)
          continue;
        if (age >= 0 && notificationTextMatches(signal2.title, signal2.body, row.title, row.body)) {
          matches.push(index2);
        }
      }
      if (matches.length !== 1) {
        for (const index2 of matches) this.signals.splice(index2, 1);
        return null;
      }
      const index = matches[0];
      const signal = this.signals[index];
      if (candidateRows) {
        const candidateKeys = /* @__PURE__ */ new Set();
        for (const candidate of candidateRows) {
          if (signal.thread !== void 0 && candidate.key !== signal.thread) continue;
          if (notificationTextMatches(signal.title, signal.body, candidate.title, candidate.body)) {
            candidateKeys.add(candidate.key);
          }
        }
        if (candidateKeys.size !== 1 || row.key !== void 0 && !candidateKeys.has(row.key)) {
          this.signals.splice(index, 1);
          return null;
        }
      }
      this.signals.splice(index, 1);
      signal.matched = true;
      signal.settleMatch?.();
      return signal;
    }
    /** A unique draft title can route every concurrent signal for that thread. */
    consumeMatchingDraft(row, rowChangeAt, matchWindowMs, candidateRows) {
      const candidates = [...candidateRows];
      const matched = [];
      for (let index = this.signals.length - 1; index >= 0; index--) {
        const signal = this.signals[index];
        const age = rowChangeAt - signal.at;
        if (age > matchWindowMs) {
          this.signals.splice(index, 1);
          continue;
        }
        if (age < 0 || signal.draftTitleAmbiguous || signal.thread !== void 0 && signal.thread !== row.key || !notificationTextMatches(signal.title, "", row.title, ""))
          continue;
        const unique = uniqueNotificationTitleMatch(
          signal.title,
          signal.thread === void 0 ? candidates : candidates.filter((candidate) => candidate.key === signal.thread)
        );
        if (unique?.key !== row.key) {
          if (!unique) {
            if (signal.suppressedBeforeMatch) signal.draftTitleAmbiguous = true;
            else this.signals.splice(index, 1);
          }
          continue;
        }
        this.signals.splice(index, 1);
        signal.matched = true;
        signal.settleMatch?.();
        matched.push(signal);
      }
      return matched.reverse();
    }
    discard(signal) {
      const index = this.signals.indexOf(signal);
      if (index !== -1) this.signals.splice(index, 1);
    }
  };
  function waitForPageNotificationMatch(signal, timeoutMs, cancel) {
    if (signal.matched) return Promise.resolve("matched");
    if (!signal.matchPromise) return Promise.resolve("timeout");
    if (cancel?.aborted) return Promise.resolve("cancelled");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancel?.removeEventListener("abort", onCancel);
        resolve(result);
      };
      const onCancel = () => finish("cancelled");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      cancel?.addEventListener("abort", onCancel, { once: true });
      signal.matchPromise.then(() => finish("matched"));
    });
  }
  var NotificationCorrelationQueue = class {
    constructor(rowLimit = 50) {
      __publicField(this, "rowLimit", rowLimit);
      __publicField(this, "pages", new PageNotificationQueue());
      __publicField(this, "rows", /* @__PURE__ */ new Map());
    }
    addPage(signal) {
      return this.pages.add(signal);
    }
    consumePageForRow(row, rowChangeAt, matchWindowMs, candidateRows) {
      return this.pages.consumeMatching(row, rowChangeAt, matchWindowMs, candidateRows);
    }
    consumePagesForDraft(row, rowChangeAt, matchWindowMs, candidateRows) {
      return this.pages.consumeMatchingDraft(row, rowChangeAt, matchWindowMs, candidateRows);
    }
    discardPage(signal) {
      this.pages.discard(signal);
    }
    addRow(row) {
      const previous = this.rows.get(row.key);
      this.rows.delete(row.key);
      this.rows.set(row.key, row);
      if (this.rows.size > this.rowLimit) {
        const evicted = this.removeRow(this.rows.keys().next().value);
        if (evicted) return { row: evicted, reason: "capacity" };
      }
      return previous ? { row: previous, reason: "replaced" } : void 0;
    }
    getRow(key) {
      return this.rows.get(key);
    }
    removeRow(key) {
      const row = this.rows.get(key);
      this.rows.delete(key);
      return row;
    }
    consumeRowForPage(title, body, at, matchWindowMs, candidateRows, thread2) {
      const matches = [...this.rows.values()].filter((row) => {
        const age = at - row.at;
        return (thread2 === void 0 || row.key === thread2) && age >= 0 && age <= matchWindowMs && notificationTextMatches(title, body, row.title, row.body);
      });
      if (matches.length !== 1) return null;
      if (candidateRows) {
        const candidateKeys = /* @__PURE__ */ new Set();
        for (const candidate of candidateRows) {
          if (thread2 !== void 0 && candidate.key !== thread2) continue;
          if (notificationTextMatches(title, body, candidate.title, candidate.body)) {
            candidateKeys.add(candidate.key);
          }
        }
        if (candidateKeys.size !== 1 || !candidateKeys.has(matches[0].key)) return null;
      }
      return this.removeRow(matches[0].key) ?? null;
    }
  };
  var UnreadArrivalTracker = class {
    constructor() {
      __publicField(this, "changedAt", /* @__PURE__ */ new Map());
      __publicField(this, "unreadCount", null);
      __publicField(this, "sawUncorroboratedZero", false);
    }
    markRowsChanged(keys, at) {
      for (const key of keys) {
        this.changedAt.set(key, { changedAt: at, eligibleUntil: at, deferred: false });
      }
    }
    /**
     * `zeroCorroborated` — the caller observed a fully hydrated conversation
     * list containing no unread rows, so a zero count is the inbox's real
     * state rather than a still-unstamped title. Only a corroborated zero can
     * establish an all-read baseline; elapsed time cannot prove hydration.
     *
     * `readObservedKeys` — threads this document has already seen rendered
     * hydrated-and-read. A mutated row from that set turning up in a first
     * count increase is a real read→unread transition, never title hydration
     * (hydrating rows are never observed read first), so it can be reported
     * after an uncorroborated zero.
     */
    observeUnreadCount(count, at, maxMutationAgeMs, zeroCorroborated = false, readObservedKeys, currentUnreadKeys, blockedUnreadKeys) {
      for (const [key, candidate] of this.changedAt) {
        candidate.eligibleUntil = Math.max(
          candidate.eligibleUntil,
          candidate.changedAt + maxMutationAgeMs
        );
        if (at > candidate.eligibleUntil) this.changedAt.delete(key);
      }
      if (this.unreadCount === null && count === 0 && !zeroCorroborated) {
        this.sawUncorroboratedZero = true;
        return [];
      }
      const previous = this.unreadCount;
      this.unreadCount = count;
      if (previous === null) {
        if (this.sawUncorroboratedZero && count > 0 && readObservedKeys) {
          const eligibleTransitions = [...this.changedAt].filter(([key]) => readObservedKeys.has(key)).sort((left, right) => right[1].changedAt - left[1].changedAt);
          const blockedTransitions = eligibleTransitions.filter(([key]) => blockedUnreadKeys?.has(key)).slice(0, count).length;
          const transitions = eligibleTransitions.filter(
            ([key]) => !blockedUnreadKeys?.has(key) && (currentUnreadKeys === void 0 || currentUnreadKeys.has(key))
          ).slice(0, Math.max(0, count - blockedTransitions)).map(([key]) => key);
          if (transitions.length) {
            this.changedAt.clear();
            return transitions;
          }
        }
        this.changedAt.clear();
        return [];
      }
      const delta = Math.max(0, count - previous);
      const eligible = [...this.changedAt].sort(
        (left, right) => right[1].changedAt - left[1].changedAt
      );
      if (delta === 0) {
        for (const [, candidate] of eligible) candidate.deferred = true;
        return [];
      }
      const attributable = eligible.filter(
        ([key]) => blockedUnreadKeys?.has(key) || currentUnreadKeys === void 0 || currentUnreadKeys.has(key)
      );
      const fresh = attributable.filter(([, candidate]) => !candidate.deferred);
      const attributionPool = fresh.length > 0 ? fresh : attributable;
      if (fresh.length > 0) {
        for (const [key, candidate] of attributable) {
          if (candidate.deferred) this.changedAt.delete(key);
        }
      }
      const blocked = attributionPool.filter(([key]) => blockedUnreadKeys?.has(key));
      if (blocked.length > 0) {
        for (const [key] of attributionPool) this.changedAt.delete(key);
        return [];
      }
      const candidates = attributionPool.filter(
        ([key]) => !blockedUnreadKeys?.has(key) && (currentUnreadKeys === void 0 || currentUnreadKeys.has(key))
      ).slice(0, delta).map(([key]) => key);
      for (const key of candidates) this.changedAt.delete(key);
      for (const [, candidate] of attributionPool) candidate.deferred = true;
      return candidates;
    }
  };
  var StableMismatchTracker = class {
    constructor(stableMs) {
      __publicField(this, "stableMs", stableMs);
      __publicField(this, "streaks", /* @__PURE__ */ new Map());
    }
    observe(mismatches, at = Date.now()) {
      const seen = /* @__PURE__ */ new Set();
      const recovered = [];
      let confirmInMs = null;
      for (const [key, fingerprint] of mismatches) {
        if (seen.has(key)) continue;
        seen.add(key);
        const streak = this.streaks.get(key);
        if (streak?.fingerprint === fingerprint) {
          if (at < streak.since) {
            streak.since = at;
            streak.reported = false;
          }
          const remaining = Math.max(0, this.stableMs - (at - streak.since));
          if (!streak.reported && remaining === 0) {
            streak.reported = true;
            recovered.push(key);
          } else if (!streak.reported) {
            confirmInMs = confirmInMs === null ? remaining : Math.min(confirmInMs, remaining);
          }
          continue;
        }
        const reported = this.stableMs === 0;
        this.streaks.set(key, { fingerprint, since: at, reported });
        if (reported) {
          recovered.push(key);
        } else {
          confirmInMs = confirmInMs === null ? this.stableMs : Math.min(confirmInMs, this.stableMs);
        }
      }
      for (const key of this.streaks.keys()) {
        if (!seen.has(key)) this.streaks.delete(key);
      }
      return { recovered, confirmInMs };
    }
  };
  function groupPreviewSender(value) {
    return splitGroupSender(value.replace(/\s+/g, " ").trim()).sender || "";
  }
  function notificationPresentation(title, body, isGroup, photos) {
    const { sender, message } = splitGroupSender(body);
    if (isGroup && sender && message.trim() && (photos.sender || !photos.thread)) {
      return { title: sender, subtitle: title, body: message, icon: photos.sender };
    }
    return { title, subtitle: "", body, icon: photos.thread };
  }
  function isOwnMessagePreview(value) {
    return /^(?:you|du|me|meg):|^(?:you|du|me|meg)\s+(?:sent|replied|forwarded|reacted|sendte|svarte|videresendte|reagerte)\b/i.test(
      value.trim().replace(/\s+/g, " ")
    );
  }
  function notificationTextMatches(pageTitle, pageBody, rowTitle, rowBody) {
    const normalizedPageTitle = normalizeNotificationText(pageTitle);
    const normalizedRowTitle = normalizeNotificationText(rowTitle);
    const titlesMatch = matchesExactOrTruncated(normalizedPageTitle, normalizedRowTitle);
    const normalizedPageBody = normalizeNotificationText(pageBody);
    const normalizedRowBody = normalizeNotificationText(rowBody);
    const page = splitGroupSender(normalizedPageBody);
    const row = splitGroupSender(normalizedRowBody);
    const sendersCompatible = page.sender === null || row.sender === null || page.sender === row.sender;
    return titlesMatch && (!normalizedPageBody || !normalizedRowBody || matchesExactOrTruncated(normalizedPageBody, normalizedRowBody) || sendersCompatible && matchesExactOrTruncated(page.message, row.message));
  }
  function uniqueNotificationTitleMatch(title, rows) {
    let match = null;
    for (const row of rows) {
      if (!notificationTextMatches(title, "", row.title, "")) continue;
      if (match && match.key !== row.key) return null;
      match = row;
    }
    return match;
  }

  // inject/src/messenger/lib/notification-images.ts
  var photoSummary = /^(?:(?:(?:sent|shared)(?: you)? (?:an? )?)?(?:image|photo|picture)|(?:(?:har )?(?:sendt|sendte|delte)(?: deg)? (?:et )?)?(?:bilde|foto))[.!:]?$/i;
  function isPhotoSummary(body) {
    return !body.trim() || photoSummary.test(body.trim());
  }
  function notificationPhotoText(title, body, hasThumbnail) {
    if (hasThumbnail && isPhotoSummary(body)) {
      return { title: `${title} sent an image:`, body: "" };
    }
    return { title, body };
  }
  function notificationThumbnailSize(width2, height) {
    if (!Number.isFinite(width2) || !Number.isFinite(height) || width2 <= 0 || height <= 0) return null;
    const scale = Math.min(1, 256 / Math.max(width2, height));
    return {
      width: Math.max(1, Math.round(width2 * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }
  function notificationThumbnail(source, timeoutMs = 2500) {
    if (!source || timeoutMs <= 0) return Promise.resolve("");
    return new Promise((resolve) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
        resolve(result);
      };
      const timer = setTimeout(() => finish(""), Math.min(timeoutMs, 2500));
      image.onerror = () => finish("");
      image.onload = () => {
        try {
          const size = notificationThumbnailSize(image.naturalWidth, image.naturalHeight);
          if (!size) return finish("");
          const canvas = document.createElement("canvas");
          canvas.width = size.width;
          canvas.height = size.height;
          const context2 = canvas.getContext("2d");
          if (!context2) return finish("");
          context2.drawImage(image, 0, 0, size.width, size.height);
          finish(canvas.toDataURL("image/png"));
        } catch {
          finish("");
        }
      };
      image.src = source;
    });
  }

  // inject/src/messenger/lib/notification-links.ts
  function linkTarget(value) {
    if (!/^https?:\/\/\S+$/i.test(value)) return null;
    try {
      const url = new URL(stripFacebookTracking(value, value));
      if (!/^https?:$/.test(url.protocol)) return null;
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const youtube = ["youtube.com", "m.youtube.com", "youtu.be"].includes(host);
      const spotify = ["spotify.com", "open.spotify.com", "spotify.link"].includes(host);
      const video = youtube ? host === "youtu.be" ? url.pathname.slice(1) : url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:shorts|live)\/([^/]+)$/.exec(url.pathname)?.[1] : null;
      const spotifyItem = host === "open.spotify.com" ? /^\/(?:intl-[a-z]{2}\/)?(track|album|artist|playlist|episode|show)\/([A-Za-z0-9]{22})\/?$/.exec(
        url.pathname
      ) : null;
      let key = url.href;
      if (video && /^[\w-]{11}$/.test(video)) key = `youtube:${video}`;
      else if (spotifyItem) key = `spotify:${spotifyItem[1]}:${spotifyItem[2]}`;
      return {
        key,
        host,
        provider: youtube ? "YouTube" : spotify ? "Spotify" : host
      };
    } catch {
      return null;
    }
  }
  function notificationLinkCards(root) {
    const cards = [];
    for (const link of root.querySelectorAll('[role="article"] a[href]')) {
      const target = linkTarget(link.href);
      if (!target || link.closest('[aria-hidden="true"]')) continue;
      const leaves = [...link.querySelectorAll("span")].filter(
        (span) => !span.closest('[aria-hidden="true"]') && !hasCandidateTextChild(span)
      );
      const labels = (leaves.length ? leaves.map(conversationNodeText) : [conversationNodeText(link)]).map((text) => text.replace(/\s+/g, " ").trim()).filter((text) => {
        const label2 = text.toLowerCase().replace(/^www\./, "");
        return text && !linkTarget(text) && label2 !== target.host && label2 !== target.provider.toLowerCase();
      });
      const title = labels[0] || "";
      const image = [...link.querySelectorAll("img")].find((image2) => {
        const rect = image2.getBoundingClientRect();
        return !image2.closest('[aria-hidden="true"]') && !EMOJI_SOURCE_RE.test(image2.currentSrc || image2.src) && rect.width >= 96 && rect.height >= 96;
      });
      if (title || image) cards.push({ href: link.href, title, image });
    }
    return cards;
  }
  function notificationLinkImage(body, cards) {
    const target = linkTarget(body.trim());
    if (!target) return "";
    const sources2 = new Set(
      cards.filter((card) => linkTarget(card.href)?.key === target.key).map((card) => card.image?.currentSrc || card.image?.src || "").filter(Boolean)
    );
    return sources2.size === 1 ? [...sources2][0] : "";
  }
  function notificationLinkBody(body, cards = []) {
    const target = linkTarget(body.trim());
    if (!target) return body;
    const titles = new Set(
      cards.filter((card) => linkTarget(card.href)?.key === target.key).map((card) => card.title.replace(/\s+/g, " ").trim()).filter(Boolean)
    );
    const title = titles.size === 1 ? [...titles][0] : "";
    if (target.provider === "YouTube" || target.provider === "Spotify") {
      const summary = `Sent a ${target.provider} link`;
      return title ? `${summary}: ${title}`.slice(0, 240) : summary;
    }
    return title ? `Sent a link: ${title} (${target.host})`.slice(0, 240) : body;
  }

  // inject/src/messenger/lib/reload-safe-storage.ts
  function reloadSafeStorage(local, session) {
    if (!local && !session) return null;
    const read = (storage, key) => {
      try {
        return storage?.getItem(key) ?? null;
      } catch (_) {
        return null;
      }
    };
    const remove = (storage, key) => {
      try {
        storage?.removeItem(key);
      } catch (_) {
      }
    };
    return {
      getItem: (key) => read(local, key) ?? read(session, key),
      setItem: (key, value) => {
        try {
          local?.setItem(key, value);
        } catch (_) {
          remove(local, key);
        }
        try {
          session?.setItem(key, value);
        } catch (_) {
        }
      },
      removeItem: (key) => {
        remove(local, key);
        remove(session, key);
      }
    };
  }
  function pageReloadSafeStorage() {
    const storage = (name) => {
      try {
        return window[name];
      } catch (_) {
        return null;
      }
    };
    return reloadSafeStorage(storage("localStorage"), storage("sessionStorage"));
  }

  // inject/src/messenger/lib/thread-kind.ts
  async function readThreadIsGroup(threadId, load, timeoutMs = 750) {
    if (!/^\d+$/.test(threadId) || typeof load !== "function") return null;
    let timer;
    const read = async () => {
      const singleton = load("LSDatabaseSingleton");
      const db = await singleton.LSDatabaseSingleton;
      const i64 = load("I64");
      const types = load("LSMessagingThreadTypeUtil");
      const threads = db?.tables?.threads;
      if (typeof threads?.get !== "function" || typeof i64?.of_string !== "function" || typeof types?.isGroup !== "function" || typeof types.isOneToOne !== "function") {
        return null;
      }
      const thread2 = await threads.get(i64.of_string(threadId));
      if (!thread2 || typeof thread2 !== "object" || !("threadType" in thread2)) return null;
      if (types.isGroup(thread2.threadType) === true) return true;
      if (types.isOneToOne(thread2.threadType) === true) return false;
      return null;
    };
    try {
      return await Promise.race([
        read().catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  var KIND_LIMIT = 500;
  var ThreadKindCache = class {
    constructor(read) {
      __publicField(this, "read", read);
      __publicField(this, "kinds", /* @__PURE__ */ new Map());
      __publicField(this, "pending", /* @__PURE__ */ new Map());
    }
    /** true for a known group chat, false for a known one-to-one, undefined if unknown. */
    isGroup(threadId) {
      return this.kinds.get(threadId);
    }
    /** Read the kind once; concurrent callers share the read. */
    ensure(threadId) {
      const known = this.kinds.get(threadId);
      if (known !== void 0) return Promise.resolve(known);
      let read = this.pending.get(threadId);
      if (!read) {
        read = this.read(threadId).catch(() => null).then((isGroup) => {
          this.pending.delete(threadId);
          if (isGroup !== null) {
            this.kinds.set(threadId, isGroup);
            if (this.kinds.size > KIND_LIMIT) this.kinds.delete(this.kinds.keys().next().value);
          }
          return isGroup;
        });
        this.pending.set(threadId, read);
      }
      return read;
    }
  };
  function suppressGroupChat(settings, isGroup) {
    return settings?.notify_group_chats === false && isGroup === true;
  }

  // inject/src/messenger/lib/unread.ts
  function unreadCountFromTitle(title) {
    const m = (title || "").match(/^\s*\((\d+)\)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  function didMutedFilterPolicyChange(previous, current) {
    return previous !== null && previous !== current;
  }
  var UnreadListReadiness = class {
    constructor() {
      __publicField(this, "signature", "");
      __publicField(this, "since", 0);
      __publicField(this, "observations", 0);
    }
    observe(rows, now = Date.now()) {
      const signature = JSON.stringify(rows);
      if (signature !== this.signature || now < this.since) {
        this.signature = signature;
        this.since = now;
        this.observations = 0;
      }
      this.observations++;
      if (rows.length === 0 || rows.some((row) => !row.hasTitle)) return false;
      if (rows.every((row) => row.hydrated)) return true;
      return now - this.since >= 2e4 && this.observations >= 3;
    }
  };
  var MUTED_UNREAD_STORE_VERSION = 1;
  var MUTED_UNREAD_STORE_LIMIT = 500;
  var VALID_THREAD_ID_RE = /^\d{1,32}$/;
  var MUTED_UNREAD_CLEAR_CONFIRM_MS = 2e4;
  var MUTED_UNREAD_CLEAR_MIN_OBSERVATIONS = 3;
  function mutedUnreadStorageKey(cookie) {
    return accountScopedStorageKey("__carrier_muted_unreads__", cookie);
  }
  var MutedUnreadStore = class {
    constructor(storage = null, storageKey2 = "__carrier_muted_unreads__") {
      __publicField(this, "storage", storage);
      __publicField(this, "storageKey", storageKey2);
      __publicField(this, "ids", /* @__PURE__ */ new Set());
      __publicField(this, "clearCandidates", /* @__PURE__ */ new Map());
      try {
        const parsed = JSON.parse(this.storage?.getItem(this.storageKey) || "null");
        if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === MUTED_UNREAD_STORE_VERSION && "ids" in parsed && Array.isArray(parsed.ids)) {
          for (const id of parsed.ids.slice(-MUTED_UNREAD_STORE_LIMIT)) {
            if (typeof id === "string" && VALID_THREAD_ID_RE.test(id)) this.ids.add(id);
          }
        }
      } catch (_) {
      }
      this.persist();
    }
    get size() {
      return this.ids.size;
    }
    reconcile(observed, observedAt = Date.now()) {
      const rows = [...observed].filter(({ id }) => VALID_THREAD_ID_RE.test(id));
      const observedIds = new Set(rows.map(({ id }) => id));
      for (const id of this.clearCandidates.keys()) {
        if (!observedIds.has(id)) this.clearCandidates.delete(id);
      }
      let changed = false;
      for (const thread2 of rows) {
        if (thread2.unread && thread2.muted) {
          this.clearCandidates.delete(thread2.id);
          if (!this.ids.has(thread2.id)) {
            this.ids.add(thread2.id);
            changed = true;
          }
          continue;
        }
        if (thread2.hydrated === false) {
          this.clearCandidates.delete(thread2.id);
          continue;
        }
        if (!this.ids.has(thread2.id)) {
          this.clearCandidates.delete(thread2.id);
          continue;
        }
        const candidate = this.clearCandidates.get(thread2.id);
        if (candidate === void 0 || observedAt < candidate.since) {
          this.clearCandidates.set(thread2.id, { since: observedAt, observations: 1 });
          continue;
        }
        candidate.observations += 1;
        if (observedAt - candidate.since >= MUTED_UNREAD_CLEAR_CONFIRM_MS && candidate.observations >= MUTED_UNREAD_CLEAR_MIN_OBSERVATIONS) {
          this.clearCandidates.delete(thread2.id);
          this.ids.delete(thread2.id);
          changed = true;
        }
      }
      while (this.ids.size > MUTED_UNREAD_STORE_LIMIT) {
        const oldest = this.ids.values().next().value;
        this.ids.delete(oldest);
        this.clearCandidates.delete(oldest);
        changed = true;
      }
      if (changed) this.persist();
    }
    invalidate(id) {
      this.clearCandidates.delete(id);
      if (!this.ids.delete(id)) return;
      this.persist();
    }
    persist() {
      try {
        this.storage?.setItem(
          this.storageKey,
          JSON.stringify({ version: MUTED_UNREAD_STORE_VERSION, ids: [...this.ids] })
        );
      } catch (_) {
      }
    }
  };
  function reconcileUnreadMessageCount(titleCount, unreadConversations, conversationListTrustworthy, mutedUnreadKnown = false, previousFilteredCount = null) {
    if (mutedUnreadKnown) {
      return conversationListTrustworthy ? unreadConversations : previousFilteredCount;
    }
    if (!conversationListTrustworthy) return titleCount;
    if (unreadConversations === 0) return 0;
    return Math.max(titleCount, unreadConversations);
  }
  function reconcileUnreadConversationCount(unreadConversations, conversationListTrustworthy, ignoresMuted, previousFilteredCount) {
    return ignoresMuted && !conversationListTrustworthy ? previousFilteredCount : unreadConversations;
  }

  // inject/src/messenger/features/notifications.ts
  var FALLBACK_DELAY_MS = 2500;
  var PAGE_NOTIFICATION_MATCH_MS = 3e3;
  var FALLBACK_POLL_VISIBLE_MS = 1e4;
  var FALLBACK_POLL_HIDDEN_MS = 6e4;
  var PAGE_NOTIFICATION_RECOVERY_MS = FALLBACK_POLL_HIDDEN_MS + PAGE_NOTIFICATION_MATCH_MS;
  var ROW_MUTATION_MATCH_MS = 2e3;
  var MISMATCH_STABLE_MS = 1e3;
  function initNotificationBridge() {
    if (!window.__TAURI_INTERNALS__) return;
    invoke("plugin:notification|is_permission_granted")?.then?.((granted) => granted || invoke("plugin:notification|request_permission"))?.catch?.(() => diag("notify.permission", "notification permission invoke failed"));
    const AVATAR_SIZE = 64;
    const loadAvatarImage = (url) => new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), 2500);
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = url;
    });
    const facesToDataUrl = (urls) => {
      const requested = urls.slice(0, 2);
      return Promise.all(requested.map(loadAvatarImage)).then((images) => {
        const faces = images.filter((image) => image !== null);
        if (!faces.length) return "";
        if (requested.length > 1 && faces.length !== requested.length) return "";
        try {
          const canvas = document.createElement("canvas");
          canvas.width = AVATAR_SIZE;
          canvas.height = AVATAR_SIZE;
          const context2 = canvas.getContext("2d");
          const paired = faces.length > 1;
          const diameter = paired ? AVATAR_SIZE * 0.68 : AVATAR_SIZE;
          const offset = AVATAR_SIZE - diameter;
          faces.forEach((face, index) => {
            const left = index * offset;
            const top = index * offset;
            const centerX = left + diameter / 2;
            const centerY = top + diameter / 2;
            if (paired) {
              context2.save();
              context2.globalCompositeOperation = "destination-out";
              context2.beginPath();
              context2.arc(centerX, centerY, diameter / 2 + 2, 0, 2 * Math.PI);
              context2.fill();
              context2.restore();
              context2.save();
              context2.beginPath();
              context2.arc(centerX, centerY, diameter / 2, 0, 2 * Math.PI);
              context2.clip();
            }
            const scale = Math.max(diameter / face.width, diameter / face.height);
            const sourceSize = diameter / scale;
            context2.drawImage(
              face,
              (face.width - sourceSize) / 2,
              (face.height - sourceSize) / 2,
              sourceSize,
              sourceSize,
              left,
              top,
              diameter,
              diameter
            );
            if (paired) context2.restore();
          });
          return canvas.toDataURL("image/png");
        } catch (_) {
          return "";
        }
      });
    };
    const avatarToDataUrl = (url) => facesToDataUrl([url]);
    const isMac4 = /mac/i.test(navigator.platform);
    const groupPicture2 = (names2) => isMac4 ? names2.then(
      (group) => group?.isGroup && group.picture ? avatarToDataUrl(group.picture) : ""
    ) : Promise.resolve("");
    const withGroupPicture = (sender, picture) => sender?.group && picture ? { ...sender, group_picture: picture } : sender;
    const notificationStorage = pageReloadSafeStorage();
    const pageReceiptKey = accountScopedStorageKey(
      "__carrier_page_notification_receipts__",
      document.cookie
    );
    const pendingPageKey = accountScopedStorageKey(
      "__carrier_pending_page_notifications__",
      document.cookie
    );
    const pageNotificationReceipts = new PageNotificationReceiptStore(
      pageReceiptKey ? notificationStorage : null,
      pageReceiptKey || "__carrier_page_notification_receipts_anonymous__"
    );
    const pendingPageNotifications = new PendingPageNotificationStore(
      pendingPageKey ? notificationStorage : null,
      pendingPageKey || "__carrier_pending_page_notifications_anonymous__"
    );
    let notifySeq = Date.now() * 1e3 + Math.floor(Math.random() * 1e3);
    const notifyHandlers = /* @__PURE__ */ new Map();
    const deliveryHandlers = /* @__PURE__ */ new Map();
    window.__carrierNotifyClick = (id) => {
      noteExplicitAction();
      const handler = notifyHandlers.get(id);
      notifyHandlers.delete(id);
      try {
        window.focus();
      } catch (_) {
      }
      try {
        handler?.();
      } catch (_) {
      }
      return handler !== void 0;
    };
    window.__carrierNotifyResult = (id, delivery) => {
      if (delivery !== "accepted" && delivery !== "duplicate" && delivery !== "suppressed") return;
      pageNotificationReceipts.recordDelivery(id, delivery);
      const handler = deliveryHandlers.get(id);
      deliveryHandlers.delete(id);
      handler?.(delivery);
    };
    const emitNotification = (id, title, body, icon2, dedupeKey, onClick, threadPath, onDelivery, subtitle = "", image = "", messageId = "", row, sender) => {
      notifyHandlers.set(id, onClick);
      if (notifyHandlers.size > 50) notifyHandlers.delete(notifyHandlers.keys().next().value);
      if (onDelivery) {
        deliveryHandlers.set(id, onDelivery);
        if (deliveryHandlers.size > 50) {
          deliveryHandlers.delete(deliveryHandlers.keys().next().value);
        }
      }
      invoke("plugin:event|emit", {
        event: "carrier:notify",
        payload: {
          id,
          title,
          subtitle,
          body,
          icon: icon2,
          image,
          dedupe_key: dedupeKey,
          thread_path: threadPath || "",
          // Like/Mute match English control labels; native offers them only then.
          english_ui: /^en\b/i.test(document.documentElement.lang),
          message_id: messageId,
          account: accountId(document.cookie) || "",
          row,
          sender,
          // Messenger's own sound just rang for this message (see messenger-sounds).
          silent: messengerMessageSoundJustPlayed(threadIdFromHref(threadPath), messageId)
        }
      })?.catch?.(() => {
        deliveryHandlers.delete(id);
        diag("notify.emit", "carrier:notify emit failed");
      });
    };
    const updateNotificationRoute = (id, threadPath) => {
      invoke("plugin:event|emit", {
        event: "carrier:notify-route",
        payload: { id, thread_path: threadPath }
      })?.catch?.(() => diag("notify.route", "carrier:notify-route emit failed"));
    };
    const notifiedStore = new NotifiedSignatureStore(notificationStorage);
    const markNotified = (key, fingerprint, bodyHash) => {
      notifiedStore.markNotified(key, fingerprint, bodyHash);
      invoke("plugin:event|emit", {
        event: "carrier:notify-handled",
        payload: {
          account: accountId(document.cookie) || "",
          thread: key,
          fingerprint,
          body_hash: bodyHash ?? ""
        }
      })?.catch?.(() => {
      });
    };
    const senderAvatars = new SenderAvatarStore(notificationStorage);
    const threadKinds = new ThreadKindCache(
      (thread2) => readThreadIsGroup(thread2, window.require)
    );
    const groupFiltering = () => window.__CARRIER_SETTINGS__?.notify_group_chats === false;
    const groupSuppressed = (thread2) => !!thread2 && suppressGroupChat(window.__CARRIER_SETTINGS__, threadKinds.isGroup(thread2));
    const learnThreadKind = (thread2) => groupFiltering() && thread2 ? threadKinds.ensure(thread2).then(() => {
    }) : Promise.resolve();
    const conversationNames = (threadId) => readConversationNotificationNames(
      threadId,
      window.require
    );
    const rowTitles = /* @__PURE__ */ new Map();
    const ROW_TITLE_LIMIT = 300;
    const rememberRowTitle = (key, title) => {
      if (!key || !title) return;
      rowTitles.delete(key);
      rowTitles.set(key, title);
      if (rowTitles.size > ROW_TITLE_LIMIT) rowTitles.delete(rowTitles.keys().next().value);
    };
    window.__carrierSenderAvatarStats = (thread2, sender) => thread2 === void 0 ? senderAvatars.stats : { resolves: senderAvatars.describe(thread2, sender || "") };
    const notificationCorrelations = new NotificationCorrelationQueue();
    const cancelFallbackForDraftReceipt = (threadId, body) => {
      if (!body) return;
      const pending = notificationCorrelations.getRow(threadId);
      if (!pending || pending.confirmedRepeat || !notificationTextMatches("", body, "", pending.body))
        return;
      clearTimeout(pending.timer);
      notificationCorrelations.removeRow(threadId);
    };
    let currentPageRouteCandidates = () => [];
    const waitForPageMatchWhileFiltering = (signal) => {
      const cancel = new AbortController();
      const cancelWhenFilteringIsDisabled = () => {
        if (!ignoresMutedConversations(window.__CARRIER_SETTINGS__) && !groupFiltering()) {
          cancel.abort();
        }
      };
      window.addEventListener("carrier:settings", cancelWhenFilteringIsDisabled);
      cancelWhenFilteringIsDisabled();
      return waitForPageNotificationMatch(
        signal,
        PAGE_NOTIFICATION_RECOVERY_MS,
        cancel.signal
      ).finally(() => {
        window.removeEventListener("carrier:settings", cancelWhenFilteringIsDisabled);
      });
    };
    const markPageNotification = (title, body, thread2) => {
      const match = notificationCorrelations.consumeRowForPage(
        title,
        body,
        Date.now(),
        PAGE_NOTIFICATION_MATCH_MS,
        currentPageRouteCandidates(),
        thread2
      );
      if (match) {
        clearTimeout(match.timer);
        if (!match.deliverable) {
          return {
            threadPath: match.threadPath,
            suppressed: {
              key: match.key,
              fingerprint: match.fingerprint,
              bodyHash: notificationDedupeKey("", match.body)
            },
            dedupeKey: match.dedupeKey
          };
        }
        return {
          threadPath: match.threadPath,
          threadMuted: mutedThreads.isMuted(match.key),
          deliver: {
            key: match.key,
            fingerprint: match.fingerprint,
            bodyHash: notificationDedupeKey("", match.body),
            expect: notifiedStore.notifiedFingerprint(match.key)
          },
          dedupeKey: match.dedupeKey
        };
      }
      return {
        signal: notificationCorrelations.addPage({
          at: Date.now(),
          title,
          body,
          ...thread2 ? { thread: thread2, threadPath: `/t/${thread2}/` } : {}
        })
      };
    };
    function CarrierNotification(title, options = {}) {
      const opts = options || {};
      const s = window.__CARRIER_SETTINGS__ || {};
      diag(
        "notify.fired",
        `page constructed a Notification (visibility: ${document.visibilityState})`
      );
      const taggedThread = pageMessages.threadFor(opts.tag);
      if (taggedThread) diag("notify.identity", "page notification carried its exact conversation");
      const stale = pageMessages.isStale(opts.tag);
      if (stale) diag("notify.stale", "suppressed a notification for an old or already-read message");
      const pageMatch = markPageNotification(
        String(title || "Messenger"),
        String(opts.body || ""),
        taggedThread
      );
      const retainSuppressedDraft = (id) => {
        const threadId = threadPathId(pageMatch.threadPath ?? pageMatch.signal?.threadPath ?? "");
        if (!pageMatch.signal?.matchedDraft || !threadId) return;
        pageNotificationReceipts.add(
          String(title || "Messenger"),
          String(opts.body || ""),
          id,
          Date.now(),
          {
            threadKey: threadId,
            suppressed: true
          }
        );
        cancelFallbackForDraftReceipt(threadId, String(opts.body || ""));
      };
      if (!notificationsGloballyMuted(s)) {
        const hidePreviewAtConstruction = s.hide_notification_preview === true;
        const originalTitle = String(title || "Messenger");
        const originalBody = String(opts.body || "");
        const id = ++notifySeq;
        if (pageMatch.signal) {
          pageMatch.signal.nativeId = id;
          pendingPageNotifications.add(
            originalTitle,
            originalBody,
            id,
            Date.now(),
            pageMatch.signal.thread
          );
        }
        const matchWait = pageMatch.signal?.matchPromise && !taggedThread && (ignoresMutedConversations(s) || groupFiltering()) ? waitForPageMatchWhileFiltering(pageMatch.signal) : Promise.resolve();
        const identityMatchWait = pageMatch.signal && !taggedThread && !hidePreviewAtConstruction ? waitForPageNotificationMatch(pageMatch.signal, 1e3) : Promise.resolve();
        const names2 = Promise.all([matchWait, identityMatchWait]).then(
          () => hidePreviewAtConstruction || window.__CARRIER_SETTINGS__?.hide_notification_preview ? null : conversationNames(
            threadPathId(pageMatch.threadPath ?? pageMatch.signal?.threadPath ?? "") || ""
          )
        );
        const imageDeadline = Date.now() + 3500;
        const thumbnail = opts.image ? notificationThumbnail(hidePreviewAtConstruction ? "" : opts.image) : Promise.all([matchWait, identityMatchWait]).then(() => {
          if (hidePreviewAtConstruction || window.__CARRIER_SETTINGS__?.hide_notification_preview) {
            return "";
          }
          const route = pageMatch.threadPath ?? pageMatch.signal?.threadPath;
          const source = notificationLinkImage(
            originalBody,
            messageLinkCards(originalBody, route)
          );
          return notificationThumbnail(source, imageDeadline - Date.now());
        });
        const kindWait = matchWait.then(
          () => learnThreadKind(
            threadPathId(pageMatch.threadPath ?? pageMatch.signal?.threadPath ?? "") || null
          )
        );
        Promise.all([
          avatarToDataUrl(hidePreviewAtConstruction ? "" : opts.icon),
          kindWait,
          thumbnail,
          names2,
          groupPicture2(names2)
        ]).then(([icon2, , image, group, picture]) => {
          const signal = pageMatch.signal;
          const unresolvedIdentity = signal !== void 0 && !signal.matched && !signal.threadPath;
          const deliverySettings = window.__CARRIER_SETTINGS__ || {};
          if (notificationsGloballyMuted(deliverySettings)) {
            pendingPageNotifications.remove(id);
          }
          if (unresolvedIdentity && ignoresMutedConversations(deliverySettings)) {
            diag("notify.unresolved", "page notification had no correlated thread identity");
            if (signal) notificationCorrelations.discardPage(signal);
            return;
          }
          pendingPageNotifications.remove(id);
          if (pageMatch.suppressed) {
            notifiedStore.markSuppressed(
              pageMatch.suppressed.key,
              pageMatch.suppressed.fingerprint,
              pageMatch.suppressed.bodyHash
            );
            return;
          }
          const threadPath = pageMatch.threadPath ?? pageMatch.signal?.threadPath;
          const threadId = threadPathId(threadPath || "");
          const threadMuted = threadId ? mutedThreads.isMuted(threadId) : pageMatch.threadMuted ?? pageMatch.signal?.threadMuted ?? false;
          if (stale || suppressNotificationDelivery(threadMuted, deliverySettings) || groupSuppressed(threadId)) {
            if (signal && !signal.matched) signal.suppressedBeforeMatch = true;
            retainSuppressedDraft(id);
            const suppressed = pageMatch.deliver ?? pageMatch.signal?.pendingDelivery;
            if (suppressed && notifiedStore.notifiedFingerprint(suppressed.key) === suppressed.expect) {
              notifiedStore.markSuppressed(
                suppressed.key,
                suppressed.fingerprint,
                suppressed.bodyHash
              );
            } else if (threadId && !suppressed) {
              notifiedStore.markSuppressed(
                threadId,
                notificationDedupeKey(originalTitle, originalBody),
                notificationDedupeKey("", originalBody)
              );
            }
            if (pageMatch.signal) pageMatch.signal.pendingDelivery = void 0;
            return;
          }
          const hidePreview = deliverySettings.hide_notification_preview === true;
          if (pageMatch.signal && (!pageMatch.signal.matched || pageMatch.signal.matchedDraft)) {
            const draftThread = pageMatch.signal?.matchedDraft && threadId ? threadId : void 0;
            pageNotificationReceipts.add(
              originalTitle,
              originalBody,
              id,
              Date.now(),
              draftThread ? { threadKey: draftThread } : void 0,
              pageMatch.signal.thread
            );
            if (draftThread) {
              cancelFallbackForDraftReceipt(draftThread, originalBody);
            }
          }
          const displayTitle = nativeThreadTitles.displayed(threadId || "", originalTitle, "");
          const named = notificationNames(
            originalTitle,
            originalBody,
            group,
            showNicknames(nicknameMode(deliverySettings), group?.isGroup),
            group?.isGroup && displayTitle ? "group" : "unknown"
          );
          const text = notificationPhotoText(
            displayTitle || named.title,
            richMessageBody(named.body, threadPath),
            Boolean(image)
          );
          const sender = hidePreview ? void 0 : withGroupPicture(
            communicationSender(
              originalTitle,
              originalBody,
              group,
              accountId(document.cookie),
              showNicknames(nicknameMode(deliverySettings), group?.isGroup),
              group?.isGroup && displayTitle ? "group" : "unknown",
              displayTitle
            ),
            picture
          );
          emitNotification(
            id,
            hidePreview ? "Messenger" : text.title,
            hidePreview ? "New message" : text.body,
            hidePreview ? "" : icon2,
            pageMatch.dedupeKey ?? pageMatch.signal?.dedupeKey ?? notificationDedupeKey(originalTitle, originalBody),
            () => {
              this.onclick?.(new Event("click"));
            },
            threadPath,
            pageMatch.signal ? (delivery) => {
              pageMatch.signal.nativeDelivery = delivery;
              const handler = pageMatch.signal.onNativeDelivery;
              pageMatch.signal.onNativeDelivery = void 0;
              handler?.(delivery);
            } : void 0,
            "",
            hidePreview ? "" : image,
            // Messenger tags its notification with the message's id.
            taggedThread && typeof opts.tag === "string" ? opts.tag : "",
            void 0,
            sender
          );
          if (pageMatch.deliver && notifiedStore.notifiedFingerprint(pageMatch.deliver.key) === pageMatch.deliver.expect) {
            markNotified(
              pageMatch.deliver.key,
              pageMatch.deliver.fingerprint,
              pageMatch.deliver.bodyHash
            );
          }
          if (pageMatch.signal) {
            pageMatch.signal.emitted = true;
            const delivery = pageMatch.signal.pendingDelivery;
            if (delivery && notifiedStore.notifiedFingerprint(delivery.key) === delivery.expect) {
              markNotified(delivery.key, delivery.fingerprint, delivery.bodyHash);
            }
          }
        });
      } else {
        if (pageMatch.deliver && notifiedStore.notifiedFingerprint(pageMatch.deliver.key) === pageMatch.deliver.expect) {
          notifiedStore.markSuppressed(
            pageMatch.deliver.key,
            pageMatch.deliver.fingerprint,
            pageMatch.deliver.bodyHash
          );
        }
        if (pageMatch.signal) pageMatch.signal.suppressedBeforeMatch = true;
      }
      try {
        window.__carrierOnNotification?.();
      } catch (_) {
      }
      queueMicrotask(scanUnreadConversations);
      this.title = title;
      this.onclick = null;
      this.close = () => {
      };
    }
    CarrierNotification.permission = "granted";
    CarrierNotification.requestPermission = (cb) => {
      if (cb) cb("granted");
      return Promise.resolve("granted");
    };
    try {
      Object.defineProperty(window, "Notification", {
        value: CarrierNotification,
        writable: true,
        configurable: true
      });
    } catch (_) {
    }
    const conversationTracker = new ConversationNotificationTracker();
    const HARVEST_SEL = '[role="main"], [role="complementary"]';
    const HARVEST_THROTTLE_MS = 5e3;
    let lastHarvestAt = 0;
    let settlingRoute = "";
    const staleRoutes = /* @__PURE__ */ new Set();
    const SETTLE_ATTEMPT_LIMIT = 6;
    let settleAttempts = 0;
    const normalizedText = (value) => (value || "").replace(/\s+/g, " ").trim();
    const isPersonName = (value) => value.length > 0 && value.length <= 60 && value.split(" ").length <= 5 && /\p{Letter}/u.test(value) && !/profile|picture|photo|image|avatar|bilde/i.test(value);
    const paneShowsThread = (title, leaving = []) => {
      const needle = title.replace(/[…\s]+$/, "").toLowerCase();
      if (needle.length < 3) return "unknown";
      const log = document.querySelector('[role="main"] [role="log"][aria-label]');
      if (!log) return "no";
      const label2 = normalizedText(log.getAttribute("aria-label")).toLowerCase();
      if (!label2.includes(needle)) return "no";
      for (const previous of leaving) {
        const other = previous.replace(/[…\s]+$/, "").toLowerCase();
        if (other && (other === needle || label2.includes(other))) return "unknown";
      }
      return "yes";
    };
    const messageLinkCards = (body, threadPath) => {
      if (!/^https?:\/\/\S+$/i.test(body.trim())) return [];
      const thread2 = threadPathId(threadPath || "");
      const title = thread2 ? rowTitles.get(thread2) : void 0;
      const otherTitles = [...rowTitles].filter(([key]) => key !== thread2).map(([, value]) => value);
      const paneMatches = title && thread2 === threadIdFromHref(location.pathname) && paneShowsThread(title, otherTitles) === "yes";
      const log = paneMatches ? document.querySelector('[role="main"] [role="log"]') : null;
      return log ? notificationLinkCards(log) : [];
    };
    const richMessageBody = (body, threadPath) => notificationLinkBody(body, messageLinkCards(body, threadPath));
    const harvestSenderAvatars = (now) => {
      if (now - lastHarvestAt < HARVEST_THROTTLE_MS) return;
      const openThread = threadIdFromHref(location.pathname);
      if (!openThread) return;
      if (openThread !== settlingRoute) {
        if (settlingRoute) staleRoutes.add(settlingRoute);
        settlingRoute = openThread;
        settleAttempts = 0;
      }
      const leaving = [];
      for (const route of staleRoutes) {
        if (route === openThread) continue;
        const title = rowTitles.get(route);
        if (title) leaving.push(title);
      }
      const shown = paneShowsThread(rowTitles.get(openThread) || "", leaving);
      if (shown !== "yes") {
        if (settleAttempts < SETTLE_ATTEMPT_LIMIT) {
          settleAttempts++;
          scheduleHarvest(500);
        }
        return;
      }
      staleRoutes.clear();
      settleAttempts = 0;
      lastHarvestAt = now;
      const pass = /* @__PURE__ */ new Map();
      const note = (name, url, owner) => {
        const seen = pass.get(name.toLowerCase());
        if (seen === void 0) {
          pass.set(name.toLowerCase(), { name, url, owner, photo: avatarPhotoId(url) });
          return;
        }
        if (seen && seen.photo !== avatarPhotoId(url)) pass.set(name.toLowerCase(), null);
      };
      for (const container of document.querySelectorAll(HARVEST_SEL)) {
        for (const image of container.querySelectorAll("img[alt]")) {
          const source = image.currentSrc || image.src || "";
          if (!source || EMOJI_SOURCE_RE.test(source)) continue;
          const name = normalizedText(image.getAttribute("alt"));
          if (!isPersonName(name)) continue;
          note(name, source, name);
          const heading = normalizedText(
            image.closest('[role="article"]')?.querySelector("h3, h4")?.textContent
          );
          if (isPersonName(heading) && (heading === name || name.startsWith(`${heading} `))) {
            senderAvatars.rememberGroupThread(openThread);
            if (heading !== name) note(heading, source, name);
          }
        }
      }
      for (const [key, face] of pass) {
        if (face) senderAvatars.remember(openThread, face.name, face.url, face.owner, now);
        else senderAvatars.markAmbiguous(openThread, key);
      }
    };
    let harvestScheduled = false;
    const scheduleHarvest = (delay = 300) => {
      if (harvestScheduled) return;
      harvestScheduled = true;
      setTimeout(() => {
        harvestScheduled = false;
        attachHarvestObserver();
        const wait = HARVEST_THROTTLE_MS - (Date.now() - lastHarvestAt);
        if (wait > 0) {
          scheduleHarvest(wait);
          return;
        }
        harvestSenderAvatars(Date.now());
      }, delay);
    };
    let harvestRoots = [];
    let harvestAttached = false;
    const harvestObserver = new MutationObserver(() => scheduleHarvest());
    const attachHarvestObserver = () => {
      const roots = [...document.querySelectorAll(HARVEST_SEL)];
      if (harvestAttached && harvestRoots.length === roots.length && roots.every((root, index) => root === harvestRoots[index] && root.isConnected)) {
        return;
      }
      harvestObserver.disconnect();
      harvestRoots = roots;
      for (const root of roots) harvestObserver.observe(root, { childList: true, subtree: true });
      if (document.body) {
        harvestObserver.observe(document.body, { childList: true });
        harvestAttached = true;
      } else {
        harvestObserver.observe(document.documentElement, { childList: true });
        harvestAttached = false;
      }
    };
    const conversationFromLink = (link) => {
      const id = threadIdFromHref(link?.getAttribute("href"));
      if (!id) return null;
      const row = link.closest('[role="row"]') || link;
      const surfaces = [...row.querySelectorAll("span")].map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          node: el,
          text: conversationNodeText(el),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          ariaHidden: el.getAttribute("aria-hidden") === "true",
          inAbbreviation: !!el.closest("abbr"),
          // An emoji sprite (and the System emoji glyph beside it) is part of
          // this span's own text, not a nested text surface of its own.
          hasTextChild: hasCandidateTextChild(el)
        };
      });
      let displayBody = "";
      const text = conversationTextParts(surfaces, (body) => {
        displayBody = body.slice(0, 240);
        return nativeSnippetPrefixes.original(id, body);
      });
      const images = [...row.querySelectorAll("img[src]")].filter(
        (candidate) => !EMOJI_SOURCE_RE.test(candidate.currentSrc || candidate.src)
      );
      let unread = false;
      for (const span of row.querySelectorAll("span")) {
        if (isUnreadConversationText(getComputedStyle(span).fontWeight, conversationNodeText(span))) {
          unread = true;
          break;
        }
      }
      const muted = observeConversationMute(id, row);
      return {
        key: id,
        threadPath: `/t/${id}/`,
        title: nativeThreadTitles.original(id, text.title),
        displayTitle: text.title,
        body: text.body,
        displayBody,
        draft: nativeSnippetPrefixes.isDraft(id, displayBody),
        // Every face the row draws, in render order. A photo-less group renders
        // several member images side by side, and no individual one of them is a
        // valid thread icon — taking just the first labelled every message in
        // the thread with whichever member happened to sort first. They are all
        // kept so they can be drawn together, which is a valid picture of the
        // group even though none of them is a picture of it alone.
        icons: images.map((candidate) => candidate.currentSrc || candidate.src).filter(Boolean),
        // A photo-less group draws its members side by side; one with a photo is
        // only known as a group once its thread has been read.
        isGroup: images.length > 1 || senderAvatars.isGroupThread(id),
        unread,
        muted
      };
    };
    currentPageRouteCandidates = () => chatRows().map(conversationFromLink).filter((conversation) => conversation !== null).map((conversation) => ({
      ...conversation,
      body: conversation.draft ? "" : conversation.body
    }));
    function pairPendingPageNotification(conversation, detectedAt, confirmedRepeat, routeCandidates) {
      const pageSignal = notificationCorrelations.consumePageForRow(
        conversation,
        detectedAt,
        PAGE_NOTIFICATION_RECOVERY_MS,
        routeCandidates
      );
      if (!pageSignal) return false;
      const fingerprint = notificationDedupeKey(conversation.title, conversation.body);
      const dedupeKey = notificationDeliveryDedupeKey(
        fingerprint,
        confirmedRepeat ? `${conversation.key}:${detectedAt}` : void 0
      );
      const bodyHash = notificationDedupeKey("", conversation.body);
      const previous = notificationCorrelations.removeRow(conversation.key);
      if (previous) clearTimeout(previous.timer);
      if (pageSignal.suppressedBeforeMatch) {
        notifiedStore.markSuppressed(conversation.key, fingerprint, bodyHash);
        return true;
      }
      pageSignal.threadMuted = mutedThreads.isMuted(conversation.key);
      if (!pageSignal.emitted) pageSignal.dedupeKey = dedupeKey;
      if (!pageSignal.emitted && !pageSignal.thread) pageSignal.threadPath = conversation.threadPath;
      if (pageSignal.emitted && pageSignal.nativeId !== void 0 && conversation.threadPath) {
        updateNotificationRoute(pageSignal.nativeId, conversation.threadPath);
      }
      if (suppressMutedDelivery(pageSignal.threadMuted, window.__CARRIER_SETTINGS__) || groupSuppressed(conversation.key)) {
        notifiedStore.markSuppressed(conversation.key, fingerprint, bodyHash);
        pageSignal.pendingDelivery = void 0;
      } else if (pageSignal.emitted) {
        const finishDelivery = (delivery) => {
          if (confirmedRepeat && delivery === "duplicate") {
            scheduleFallback(conversation, detectedAt, true, routeCandidates);
            return;
          }
          markNotified(conversation.key, fingerprint, bodyHash);
        };
        if (pageSignal.nativeDelivery) {
          finishDelivery(pageSignal.nativeDelivery);
        } else {
          pageSignal.onNativeDelivery = finishDelivery;
        }
      } else {
        pageSignal.pendingDelivery = {
          key: conversation.key,
          fingerprint,
          bodyHash,
          expect: notifiedStore.notifiedFingerprint(conversation.key)
        };
      }
      pageNotificationReceipts.consumeMatching(conversation, detectedAt);
      return true;
    }
    const completeCapacityEviction = async (fallback) => {
      if (!fallback.deliverable) return;
      if (groupFiltering()) await learnThreadKind(fallback.key);
      const settings = window.__CARRIER_SETTINGS__ || {};
      if (suppressNotificationDelivery(mutedThreads.isMuted(fallback.key), settings) || groupSuppressed(fallback.key)) {
        notifiedStore.markSuppressed(
          fallback.key,
          fallback.fingerprint,
          notificationDedupeKey("", fallback.body)
        );
        return;
      }
      const hidePreview = settings.hide_notification_preview === true;
      notifiedStore.markNotified(
        fallback.key,
        fallback.fingerprint,
        notificationDedupeKey("", fallback.body)
      );
      diag("notify.capacity", "completed a row fallback displaced by the correlation bound");
      emitNotification(
        ++notifySeq,
        hidePreview ? "Messenger" : nativeThreadTitles.displayed(fallback.key, fallback.title, fallback.displayTitle),
        hidePreview ? "New message" : fallback.displayBody,
        "",
        fallback.dedupeKey,
        () => window.__carrierOpenThread?.(fallback.threadPath),
        fallback.threadPath,
        void 0,
        "",
        "",
        "",
        {
          thread: fallback.key,
          fingerprint: fallback.fingerprint,
          body_hash: notificationDedupeKey("", fallback.body),
          read_at: fallback.readAt
        }
      );
    };
    const retainPendingFallback = (fallback) => {
      const displaced = notificationCorrelations.addRow(fallback);
      if (!displaced) return;
      clearTimeout(displaced.row.timer);
      if (displaced.reason === "capacity") void completeCapacityEviction(displaced.row);
    };
    const scheduleFallback = (conversation, detectedAt, confirmedRepeat = false, routeCandidates, readAt = confirmedRepeat ? detectedAt : 0) => {
      const fingerprint = notificationDedupeKey(conversation.title, conversation.body);
      const dedupeKey = notificationDeliveryDedupeKey(
        fingerprint,
        confirmedRepeat ? `${conversation.key}:${detectedAt}` : void 0
      );
      const bodyHash = notificationDedupeKey("", conversation.body);
      const previous = notificationCorrelations.removeRow(conversation.key);
      if (previous) clearTimeout(previous.timer);
      if (pairPendingPageNotification(conversation, detectedAt, confirmedRepeat, routeCandidates))
        return;
      if (suppressMutedDelivery(conversation.muted, window.__CARRIER_SETTINGS__) || groupSuppressed(conversation.key)) {
        notifiedStore.markSuppressed(conversation.key, fingerprint, bodyHash);
        const timer2 = setTimeout(() => {
          if (notificationCorrelations.getRow(conversation.key)?.timer === timer2) {
            notificationCorrelations.removeRow(conversation.key);
          }
        }, PAGE_NOTIFICATION_MATCH_MS);
        retainPendingFallback({
          key: conversation.key,
          at: detectedAt,
          timer: timer2,
          title: conversation.title,
          displayTitle: conversation.displayTitle,
          body: conversation.body,
          displayBody: conversation.displayBody,
          threadPath: conversation.threadPath,
          fingerprint,
          dedupeKey,
          confirmedRepeat,
          readAt,
          deliverable: false
        });
        return;
      }
      const content = notificationPresentation(
        conversation.title,
        conversation.body,
        conversation.isGroup,
        { sender: "", thread: "" }
      );
      const senderIcon = conversation.isGroup ? senderAvatars.lookup(conversation.key, groupPreviewSender(conversation.body)) : "";
      const hiddenAtConstruction = window.__CARRIER_SETTINGS__?.hide_notification_preview === true;
      const names2 = hiddenAtConstruction ? Promise.resolve(null) : conversationNames(conversation.key);
      const senderAvatar = hiddenAtConstruction ? Promise.resolve("") : names2.then((group) => {
        const person = notificationSender(conversation.body, group);
        return avatarToDataUrl(person ? person.avatar || senderIcon : group ? "" : senderIcon);
      });
      const threadAvatar = hiddenAtConstruction ? Promise.resolve("") : facesToDataUrl(conversation.icons);
      const thumbnail = notificationThumbnail(
        hiddenAtConstruction ? "" : notificationLinkImage(
          content.body,
          messageLinkCards(content.body, conversation.threadPath)
        )
      );
      const timer = setTimeout(async () => {
        await learnThreadKind(conversation.key);
        if (notificationCorrelations.getRow(conversation.key)?.timer !== timer) return;
        const settings = window.__CARRIER_SETTINGS__ || {};
        if (suppressNotificationDelivery(mutedThreads.isMuted(conversation.key), settings) || groupSuppressed(conversation.key)) {
          notifiedStore.markSuppressed(conversation.key, fingerprint, bodyHash);
          if (notificationCorrelations.getRow(conversation.key)?.timer === timer) {
            notificationCorrelations.removeRow(conversation.key);
          }
          return;
        }
        const hiddenBeforeImages = settings.hide_notification_preview === true;
        const [sender, thread2, image, group, picture] = hiddenBeforeImages ? ["", "", "", null, ""] : await Promise.all([senderAvatar, threadAvatar, thumbnail, names2, groupPicture2(names2)]);
        const presentation = notificationPresentation(
          nativeThreadTitles.displayed(
            conversation.key,
            conversation.title,
            conversation.displayTitle
          ),
          conversation.body,
          conversation.isGroup,
          { sender, thread: thread2 }
        );
        const { icon: icon2 } = presentation;
        if (!hiddenBeforeImages && !icon2 && !image && conversation.isGroup) {
          diag("notify.avatar", "group notification has no photo for its displayed identity");
        }
        if (notificationCorrelations.getRow(conversation.key)?.timer !== timer) return;
        const deliverySettings = window.__CARRIER_SETTINGS__ || {};
        const hidePreview = deliverySettings.hide_notification_preview === true;
        if (suppressNotificationDelivery(mutedThreads.isMuted(conversation.key), deliverySettings) || groupSuppressed(conversation.key)) {
          notifiedStore.markSuppressed(conversation.key, fingerprint, bodyHash);
          notificationCorrelations.removeRow(conversation.key);
          return;
        }
        notificationCorrelations.removeRow(conversation.key);
        notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
        diag(
          "notify.fallback",
          `unread row changed without a page Notification (visibility: ${document.visibilityState})`
        );
        const visibleContent = group ? content : notificationPresentation(
          conversation.displayTitle,
          conversation.displayBody,
          conversation.isGroup,
          {
            sender: "",
            thread: ""
          }
        );
        const visiblePresentation = group ? presentation : notificationPresentation(
          nativeThreadTitles.displayed(
            conversation.key,
            conversation.title,
            conversation.displayTitle
          ),
          conversation.displayBody,
          conversation.isGroup,
          { sender, thread: thread2 }
        );
        const richBody = richMessageBody(visibleContent.body, conversation.threadPath);
        const named = notificationNames(
          visiblePresentation.title,
          visibleContent.subtitle && !visiblePresentation.subtitle ? `${visibleContent.title}: ${richBody}` : richBody,
          group,
          showNicknames(nicknameMode(deliverySettings), group?.isGroup),
          visiblePresentation.subtitle ? "sender" : "group"
        );
        const text = notificationPhotoText(named.title, named.body, Boolean(image));
        emitNotification(
          ++notifySeq,
          hidePreview ? "Messenger" : text.title,
          hidePreview ? "New message" : text.body,
          hidePreview ? "" : icon2,
          dedupeKey,
          () => {
            window.__carrierOpenThread?.(conversation.threadPath);
          },
          conversation.threadPath,
          void 0,
          hidePreview ? "" : visiblePresentation.subtitle,
          hidePreview ? "" : image,
          "",
          { thread: conversation.key, fingerprint, body_hash: bodyHash, read_at: readAt },
          hidePreview ? void 0 : withGroupPicture(
            communicationSender(
              // Identity comes from the row's original "Name: message"
              // preview through the full-prefix matcher, which refuses
              // ambiguous prefixes; shortened display text must not decide.
              conversation.title,
              conversation.body,
              group,
              accountId(document.cookie),
              showNicknames(nicknameMode(deliverySettings), group?.isGroup),
              "group",
              visiblePresentation.subtitle || visiblePresentation.title,
              // In a group the icon is the sender's only when their photo won.
              Boolean(sender) && icon2 === sender
            ),
            picture
          )
        );
      }, FALLBACK_DELAY_MS);
      retainPendingFallback({
        key: conversation.key,
        at: detectedAt,
        timer,
        title: conversation.title,
        displayTitle: conversation.displayTitle,
        body: conversation.body,
        displayBody: conversation.displayBody,
        threadPath: conversation.threadPath,
        fingerprint,
        dedupeKey,
        confirmedRepeat,
        readAt,
        deliverable: true
      });
    };
    let scanRunning = false;
    let scanPending = false;
    let mismatchConfirmationTimer;
    let readConfirmationTimer;
    const unreadArrivals = new UnreadArrivalTracker();
    const mismatchTracker = new StableMismatchTracker(MISMATCH_STABLE_MS);
    const pendingArrivalKeys = /* @__PURE__ */ new Set();
    const READ_OBSERVED_LIMIT = 500;
    const readObservedKeys = /* @__PURE__ */ new Set();
    const readConfirmedAt = /* @__PURE__ */ new Map();
    const readCandidates = /* @__PURE__ */ new Map();
    let lastScanAt = 0;
    const MAX_MUTATION_GRACE_MS = 9e4;
    const rowMutationAt = /* @__PURE__ */ new Map();
    const scanUnreadConversations = () => {
      if (scanRunning) {
        scanPending = true;
        return;
      }
      scanRunning = true;
      try {
        harvestSenderAvatars(Date.now());
        const openId = threadIdFromHref(location.pathname);
        if (openId) {
          observeOpenThreadMute(openId, [
            ...document.querySelectorAll('[role="main"]'),
            ...document.querySelectorAll('[role="complementary"], [role="dialog"]')
          ]);
        }
        const links = chatRows();
        if (!links.length) return;
        const observed = links.map(conversationFromLink).filter((conversation) => conversation !== null);
        for (const conversation of observed) rememberRowTitle(conversation.key, conversation.title);
        const conversations = observed.filter(
          (conversation) => conversation.unread && !isOwnMessagePreview(conversation.body) && !conversation.draft
        );
        for (const conversation of conversations) void learnThreadKind(conversation.key);
        const ignoreMuted = ignoresMutedConversations(window.__CARRIER_SETTINGS__);
        const silenced = (conversation) => ignoreMuted && conversation.muted || groupSuppressed(conversation.key);
        const notifyKeys = new Set(
          conversations.filter((conversation) => !silenced(conversation)).map(({ key }) => key)
        );
        const mutedUnreadKeys = new Set(
          conversations.filter((conversation) => silenced(conversation)).map(({ key }) => key)
        );
        const detectedAt = Date.now();
        const mutationGrace = lastScanAt ? Math.min(MAX_MUTATION_GRACE_MS, Math.max(0, detectedAt - lastScanAt)) : 0;
        lastScanAt = detectedAt;
        const listHydrated = observed.length > 0 && observed.every(({ body }) => body.length > 0);
        notifiedStore.observeRead(
          new Set(observed.filter(({ unread }) => unread).map(({ key }) => key)),
          observed.map(({ key }) => key),
          detectedAt,
          listHydrated
        );
        const hydrated = conversations.filter(({ body }) => body.length > 0);
        const routeCandidates = observed.filter(({ body, draft }) => body.length > 0 && !draft);
        const pageRouteCandidates = observed.map((conversation) => ({
          ...conversation,
          body: conversation.draft ? "" : conversation.body
        }));
        const hydratedReadKeys = new Set(
          listHydrated ? observed.filter(({ unread }) => !unread).map(({ key }) => key) : []
        );
        clearTimeout(readConfirmationTimer);
        readConfirmationTimer = void 0;
        let nextReadConfirmationIn = null;
        const confirmedReads = [];
        for (const key of readCandidates.keys()) {
          if (!hydratedReadKeys.has(key)) readCandidates.delete(key);
        }
        for (const conversation of observed) {
          if (!hydratedReadKeys.has(conversation.key)) continue;
          if (readObservedKeys.has(conversation.key)) continue;
          const candidate = readCandidates.get(conversation.key);
          if (candidate === void 0 || detectedAt < candidate.since) {
            readCandidates.set(conversation.key, { since: detectedAt, observations: 1 });
            if (readCandidates.size > READ_OBSERVED_LIMIT) {
              readCandidates.delete(readCandidates.keys().next().value);
            }
            nextReadConfirmationIn = nextReadConfirmationIn === null ? READ_TRANSITION_CONFIRM_MS : Math.min(nextReadConfirmationIn, READ_TRANSITION_CONFIRM_MS);
            continue;
          }
          candidate.observations += 1;
          const elapsed2 = detectedAt - candidate.since;
          if (elapsed2 >= READ_TRANSITION_CONFIRM_MS && candidate.observations >= READ_TRANSITION_MIN_OBSERVATIONS) {
            readCandidates.delete(conversation.key);
            readObservedKeys.add(conversation.key);
            if (readObservedKeys.size > READ_OBSERVED_LIMIT) {
              readObservedKeys.delete(readObservedKeys.keys().next().value);
            }
            readConfirmedAt.delete(conversation.key);
            readConfirmedAt.set(conversation.key, detectedAt);
            if (readConfirmedAt.size > READ_OBSERVED_LIMIT) {
              readConfirmedAt.delete(readConfirmedAt.keys().next().value);
            }
            confirmedReads.push({ thread: conversation.key, since: candidate.since });
          } else {
            const remaining = Math.max(1, READ_TRANSITION_CONFIRM_MS - elapsed2);
            nextReadConfirmationIn = nextReadConfirmationIn === null ? remaining : Math.min(nextReadConfirmationIn, remaining);
          }
        }
        if (confirmedReads.length > 0) {
          invoke("plugin:event|emit", {
            event: "carrier:notify-read",
            payload: { account: accountId(document.cookie) || "", reads: confirmedReads }
          })?.catch?.(() => {
          });
        }
        if (nextReadConfirmationIn !== null) {
          readConfirmationTimer = setTimeout(
            scanUnreadConversations,
            Math.max(1, nextReadConfirmationIn)
          );
        }
        const readTransitions = /* @__PURE__ */ new Set();
        const recoveredReadAt = /* @__PURE__ */ new Map();
        const readAtFor = (key, repeat) => readTransitions.has(key) ? readConfirmedAt.get(key) ?? detectedAt : repeat ? recoveredReadAt.get(key) ?? detectedAt : 0;
        const changed = new Set(
          conversationTracker.observe(
            hydrated.map(({ key, body }) => ({ key, signature: body })),
            routeCandidates.map(({ key }) => key),
            readObservedKeys,
            readTransitions
          )
        );
        for (const key of unreadArrivals.observeUnreadCount(
          unreadCountFromTitle(document.title || ""),
          detectedAt,
          ROW_MUTATION_MATCH_MS + mutationGrace,
          // A fully hydrated list with no unread rows corroborates a zero
          // title: it is the inbox's real state, not a still-unstamped title,
          // so a first arrival can report as soon as the list is ready.
          listHydrated && !observed.some(({ unread }) => unread),
          readObservedKeys,
          notifyKeys,
          mutedUnreadKeys
        )) {
          changed.add(key);
        }
        for (const { key, unread } of observed) {
          if (unread) readObservedKeys.delete(key);
        }
        for (const conversation of hydrated) {
          if (pendingArrivalKeys.delete(conversation.key)) changed.add(conversation.key);
        }
        for (const key of pendingArrivalKeys) {
          const row = observed.find((conversation) => conversation.key === key);
          if (row && (!row.unread || isOwnMessagePreview(row.body))) {
            pendingArrivalKeys.delete(key);
          }
        }
        pageNotificationReceipts.discardReadMatches(
          observed.filter(({ unread, body, draft }) => !unread && body.length > 0 && !draft),
          detectedAt
        );
        pendingPageNotifications.discardReadMatches(
          observed.filter(({ unread, body, draft }) => !unread && body.length > 0 && !draft),
          detectedAt
        );
        for (const conversation of pageRouteCandidates) {
          if (!conversation.draft) continue;
          const mutationAt = rowMutationAt.get(conversation.key);
          if (mutationAt === void 0 || detectedAt - mutationAt > PAGE_NOTIFICATION_RECOVERY_MS)
            continue;
          rowMutationAt.delete(conversation.key);
          const signals = notificationCorrelations.consumePagesForDraft(
            conversation,
            mutationAt,
            PAGE_NOTIFICATION_RECOVERY_MS,
            pageRouteCandidates.map((row) => ({ ...row, body: "" }))
          );
          for (const signal of signals) {
            if (signal.suppressedBeforeMatch) {
              pageNotificationReceipts.add(signal.title, signal.body, ++notifySeq, detectedAt, {
                threadKey: conversation.key,
                suppressed: true
              });
              cancelFallbackForDraftReceipt(conversation.key, signal.body);
              continue;
            }
            signal.matchedDraft = true;
            if (!signal.thread) signal.threadPath = conversation.threadPath;
            signal.threadMuted = conversation.muted;
            if (signal.nativeId !== void 0) {
              pageNotificationReceipts.retainForDraft(signal.nativeId, conversation.key);
            }
            if (signal.emitted && signal.nativeId !== void 0) {
              updateNotificationRoute(signal.nativeId, conversation.threadPath);
            }
          }
        }
        const draftConfirmInMs = pageNotificationReceipts.retireDraftsWithDifferentPreview(
          observed.filter(({ body, draft }) => body.length > 0 && !draft),
          detectedAt
        );
        const pageReceipts = pageNotificationReceipts.consumeUniquelyMatching(hydrated, detectedAt);
        const pendingPageArrivals = pendingPageNotifications.consumeUniquelyMatching(
          hydrated,
          detectedAt
        );
        for (const key of pendingPageArrivals) changed.add(key);
        const mismatches = [];
        const stale = /* @__PURE__ */ new Set();
        const unhydrated = /* @__PURE__ */ new Set();
        const confirmedRepeats = /* @__PURE__ */ new Set();
        for (const conversation of conversations) {
          if (!conversation.body) {
            if (changed.has(conversation.key)) {
              unhydrated.add(conversation.key);
              pendingArrivalKeys.add(conversation.key);
              if (pendingArrivalKeys.size > 50) {
                pendingArrivalKeys.delete(pendingArrivalKeys.keys().next().value);
              }
            }
            continue;
          }
          const fingerprint = notificationDedupeKey(conversation.title, conversation.body);
          const bodyHash = notificationDedupeKey("", conversation.body);
          const pageReceipt = pageReceipts.get(conversation.key);
          const pageSignal = pageReceipt ? notificationCorrelations.consumePageForRow(
            conversation,
            detectedAt,
            PAGE_NOTIFICATION_RECOVERY_MS,
            routeCandidates
          ) : null;
          const retiredReadAt = notifiedStore.readAt(conversation.key);
          if (retiredReadAt !== void 0) recoveredReadAt.set(conversation.key, retiredReadAt);
          let reconciliation = notifiedStore.reconcileFingerprint(
            conversation.key,
            conversation.title,
            fingerprint,
            bodyHash,
            readTransitions.has(conversation.key) && !pageReceipt
          );
          const repeatedDelivery = readTransitions.has(conversation.key) || reconciliation === "repeated";
          if (!pageReceipt && pairPendingPageNotification(conversation, detectedAt, repeatedDelivery, routeCandidates)) {
            changed.delete(conversation.key);
            continue;
          }
          const receiptSuppressedRepeat = pageReceipt !== void 0 && repeatedDelivery && (pageSignal?.nativeDelivery ?? pageReceipt.nativeDelivery) === "duplicate";
          const receiptPendingRepeat = pageReceipt !== void 0 && repeatedDelivery && pageSignal !== null && pageSignal.nativeDelivery === void 0;
          if (receiptPendingRepeat) {
            const pending = notificationCorrelations.getRow(conversation.key);
            if (pending) clearTimeout(pending.timer);
            notificationCorrelations.removeRow(conversation.key);
            updateNotificationRoute(pageReceipt.nativeId, conversation.threadPath);
            pageSignal.onNativeDelivery = (delivery) => {
              if (delivery === "duplicate") {
                scheduleFallback(
                  conversation,
                  detectedAt,
                  true,
                  routeCandidates,
                  readAtFor(conversation.key, true)
                );
                return;
              }
              markNotified(conversation.key, fingerprint, bodyHash);
            };
            changed.delete(conversation.key);
            continue;
          }
          if (receiptSuppressedRepeat) {
            scheduleFallback(
              conversation,
              detectedAt,
              true,
              routeCandidates,
              readAtFor(conversation.key, true)
            );
            changed.delete(conversation.key);
            continue;
          }
          if (pageReceipt) {
            const pending = notificationCorrelations.getRow(conversation.key);
            if (pending) clearTimeout(pending.timer);
            notificationCorrelations.removeRow(conversation.key);
            if (pageReceipt.suppressedDraft) {
              notifiedStore.markSuppressed(conversation.key, fingerprint, bodyHash);
              changed.delete(conversation.key);
            } else {
              markNotified(conversation.key, fingerprint, bodyHash);
              updateNotificationRoute(pageReceipt.nativeId, conversation.threadPath);
            }
            reconciliation = pageReceipt.suppressedDraft ? "suppressed" : "matched";
          }
          if (reconciliation === "repeated") {
            confirmedRepeats.add(conversation.key);
            changed.add(conversation.key);
          }
          if (reconciliation === "matched" || reconciliation === "migrated") {
            if (changed.has(conversation.key)) stale.add(conversation.key);
            const pending = notificationCorrelations.getRow(conversation.key);
            if (pending && !pending.confirmedRepeat) {
              clearTimeout(pending.timer);
              notificationCorrelations.removeRow(conversation.key);
            }
          } else if (reconciliation === "mismatched") {
            changed.delete(conversation.key);
            mismatches.push([conversation.key, fingerprint]);
            const pending = notificationCorrelations.getRow(conversation.key);
            if (pending && pending.fingerprint !== fingerprint) {
              clearTimeout(pending.timer);
              notificationCorrelations.removeRow(conversation.key);
            }
          }
        }
        const mismatchObservation = mismatchTracker.observe(mismatches, detectedAt);
        clearTimeout(mismatchConfirmationTimer);
        mismatchConfirmationTimer = void 0;
        const confirmInMs = draftConfirmInMs === null ? mismatchObservation.confirmInMs : mismatchObservation.confirmInMs === null ? draftConfirmInMs : Math.min(draftConfirmInMs, mismatchObservation.confirmInMs);
        if (confirmInMs !== null) {
          mismatchConfirmationTimer = setTimeout(scanUnreadConversations, Math.max(1, confirmInMs));
        }
        const recovered = mismatchObservation.recovered;
        if (recovered.length) {
          diag("notify.recovered", "unread preview diverged from its delivered fingerprint");
          for (const key of recovered) changed.add(key);
        }
        if (!changed.size) return;
        if (stale.size) {
          diag("notify.stale", "suppressed replay of an already-delivered preview");
        }
        if ([...changed].every((key) => stale.has(key) || unhydrated.has(key))) return;
        try {
          window.__carrierOnNotification?.();
        } catch (_) {
        }
        for (const conversation of conversations) {
          if (changed.has(conversation.key) && !stale.has(conversation.key) && !unhydrated.has(conversation.key)) {
            scheduleFallback(
              conversation,
              detectedAt,
              confirmedRepeats.has(conversation.key),
              routeCandidates,
              readAtFor(conversation.key, confirmedRepeats.has(conversation.key))
            );
          }
        }
      } finally {
        scanRunning = false;
        if (scanPending) {
          scanPending = false;
          queueMicrotask(scanUnreadConversations);
        }
      }
    };
    let scanScheduled = false;
    const scheduleScan = (records = []) => {
      const changedKeys = /* @__PURE__ */ new Set();
      const mutatedRows = /* @__PURE__ */ new Set();
      const inspect2 = (node) => {
        const element2 = node instanceof Element ? node : node.parentElement;
        if (!element2) return;
        const links = /* @__PURE__ */ new Set();
        const closest = element2.closest('a[href*="/t/"]');
        if (closest) links.add(closest);
        for (const link of element2.querySelectorAll('a[href*="/t/"]')) {
          links.add(link);
        }
        for (const link of links) {
          const key = threadIdFromHref(link.getAttribute("href"));
          if (key) changedKeys.add(key);
        }
      };
      const inspectMutatedRow = (node) => {
        const element2 = node instanceof Element ? node : node.parentElement;
        if (!element2) return;
        const link = element2.closest('a[href*="/t/"]');
        if (link) {
          const key2 = threadIdFromHref(link.getAttribute("href"));
          if (key2) mutatedRows.add(key2);
          return;
        }
        const row = element2.closest('[role="row"]');
        if (!row) return;
        const links = row.querySelectorAll('a[href*="/t/"]');
        if (links.length !== 1) return;
        const key = threadIdFromHref(links[0].getAttribute("href"));
        if (key) mutatedRows.add(key);
      };
      for (const record4 of records) {
        inspect2(record4.target);
        inspectMutatedRow(record4.target);
        for (const node of record4.addedNodes) {
          inspect2(node);
          inspectMutatedRow(node);
        }
      }
      const changedAt = Date.now();
      unreadArrivals.markRowsChanged(changedKeys, changedAt);
      for (const key of mutatedRows) {
        rowMutationAt.delete(key);
        rowMutationAt.set(key, changedAt);
      }
      while (rowMutationAt.size > 300) rowMutationAt.delete(rowMutationAt.keys().next().value);
      if (scanScheduled) return;
      scanScheduled = true;
      setTimeout(() => {
        scanScheduled = false;
        scanUnreadConversations();
      }, 120);
    };
    let observedGrid = null;
    const gridObserver = new MutationObserver(scheduleScan);
    const attachScanner = () => {
      const grid = document.querySelector('[role="navigation"] [role="grid"]');
      if (grid === observedGrid && grid?.isConnected) return true;
      gridObserver.disconnect();
      observedGrid = grid;
      if (!grid) return false;
      gridObserver.observe(grid, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "src", "alt", "style", "aria-label"]
      });
      scanUnreadConversations();
      return true;
    };
    if (!attachScanner()) {
      const waitForGrid = new MutationObserver(() => {
        if (attachScanner()) waitForGrid.disconnect();
      });
      waitForGrid.observe(document.documentElement, { childList: true, subtree: true });
    }
    let pollTimer;
    const poll = () => {
      attachScanner();
      attachHarvestObserver();
      scanUnreadConversations();
    };
    const startPoll = () => {
      clearInterval(pollTimer);
      pollTimer = setInterval(
        poll,
        document.hidden ? FALLBACK_POLL_HIDDEN_MS : FALLBACK_POLL_VISIBLE_MS
      );
    };
    document.addEventListener("visibilitychange", () => {
      startPoll();
      attachHarvestObserver();
      if (!document.hidden) poll();
    });
    attachHarvestObserver();
    startPoll();
  }

  // inject/src/messenger/lib/pane-resize.ts
  var PANE_WIDTH_MIN = 160;
  var PANE_WIDTH_MAX = 1600;
  var MIN_CHAT_WIDTH = 360;
  var MIN_DETAILS_WIDTH = 300;
  var MIN_LIST_WIDTH = 200;
  var width = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.min(PANE_WIDTH_MAX, Math.max(PANE_WIDTH_MIN, Math.round(value)));
  };
  function sanitizePaneWidths(value) {
    const record4 = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return { list: width(record4.list), details: width(record4.details) };
  }
  function edgeSide(pane, other) {
    return pane.left + pane.right <= other.left + other.right ? "right" : "left";
  }
  function dragWidth({ startWidth, startX, x, side, min, max }) {
    const delta = side === "right" ? x - startX : startX - x;
    return Math.round(Math.min(Math.max(min, max), Math.max(min, startWidth + delta)));
  }
  function dragBounds(pane, startWidth, chatWidth, facebookMin) {
    const floor = pane === "list" ? MIN_LIST_WIDTH : MIN_DETAILS_WIDTH;
    const min = Math.max(floor, Number.isFinite(facebookMin) ? facebookMin : 0);
    const max = Math.max(min, startWidth + Math.max(0, chatWidth - MIN_CHAT_WIDTH));
    return { min, max: Math.min(max, PANE_WIDTH_MAX) };
  }
  function paneCap(pane) {
    return pane === "list" ? `calc(100% - ${MIN_CHAT_WIDTH + MIN_DETAILS_WIDTH}px)` : `calc(100% - ${MIN_CHAT_WIDTH}px)`;
  }
  function paneWidthCss(widths, selectors) {
    return ["list", "details"].filter((pane) => widths[pane] !== null).map(
      (pane) => `${selectors[pane]} { flex: 0 0 ${widths[pane]}px !important; width: ${widths[pane]}px !important; max-width: ${paneCap(pane)} !important; }`
    ).join("\n");
  }

  // inject/src/messenger/features/pane-resize.ts
  var PANE_ATTR = "data-carrier-pane";
  var CHAT_ROW_ATTR = "data-carrier-chat-row";
  var RESIZING_ATTR = "data-carrier-resizing";
  var EDGE_CLASS = "carrier-pane-edge";
  var SELECTORS = {
    list: `[role="navigation"][${PANE_ATTR}="list"]`,
    details: `[${CHAT_ROW_ATTR}] > :nth-child(2)`
  };
  var EDGE_CSS = `
  [${PANE_ATTR}="list"], [${CHAT_ROW_ATTR}] > :nth-child(2) { position: relative; }
  .${EDGE_CLASS} { position: absolute; top: 0; bottom: 0; width: 9px; z-index: 5; cursor: col-resize; touch-action: none; }
  /* The list's edge sits half over the chat (the list's scroll bar is at its
     own edge); the details' edge sits inside them (the chat's scroll bar is
     at theirs). */
  .${EDGE_CLASS}[data-pane="list"][data-side="right"] { right: -6px; }
  .${EDGE_CLASS}[data-pane="list"][data-side="left"] { left: -6px; }
  .${EDGE_CLASS}[data-pane="details"][data-side="left"] { left: 0; }
  .${EDGE_CLASS}[data-pane="details"][data-side="right"] { right: 0; }
  .${EDGE_CLASS}::after {
    content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px;
    background: var(--primary-button-background, #0866ff);
    opacity: 0; transition: opacity 0.15s;
  }
  .${EDGE_CLASS}[data-pane="details"][data-side="left"]::after { left: 0; }
  .${EDGE_CLASS}[data-pane="details"][data-side="right"]::after { left: auto; right: 0; }
  .${EDGE_CLASS}:hover::after { opacity: 0.6; transition-delay: 0.15s; }
  .${EDGE_CLASS}.dragging::after { opacity: 0.6; transition-delay: 0s; }
  html[${RESIZING_ATTR}], html[${RESIZING_ATTR}] * { cursor: col-resize !important; -webkit-user-select: none !important; user-select: none !important; }
`;
  function storedWidths() {
    return sanitizePaneWidths(window.__CARRIER_SETTINGS__?.pane_widths);
  }
  function rememberLocally(widths) {
    try {
      const settings = window.__CARRIER_SETTINGS__;
      if (settings && typeof settings === "object") settings.pane_widths = { ...widths };
      const cached = JSON.parse(
        localStorage.getItem("__carrier_settings") || "null"
      );
      if (cached && typeof cached === "object" && !Array.isArray(cached)) {
        cached.pane_widths = { ...widths };
        localStorage.setItem("__carrier_settings", JSON.stringify(cached));
      }
    } catch (_) {
    }
  }
  function findChatRow(log, main2) {
    for (let el = log; el && el !== main2; el = el.parentElement) {
      const row = el.parentElement;
      if (!row || row.children.length < 2 || row.firstElementChild !== el) continue;
      const details = el.nextElementSibling;
      if (!details) continue;
      const style = getComputedStyle(row);
      if (style.display === "flex" && style.flexDirection.startsWith("row") && Number.parseFloat(getComputedStyle(details).minWidth) >= 200) {
        return row;
      }
    }
    return null;
  }
  var SIZE_PROPS = ["flex", "width", "max-width"];
  function initPaneResize() {
    let widths = storedWidths();
    const widthStyle = document.createElement("style");
    widthStyle.setAttribute("data-carrier-pane-widths", "");
    const edgeStyle = document.createElement("style");
    edgeStyle.textContent = EDGE_CSS;
    const showWidths = () => {
      widthStyle.textContent = paneWidthCss(widths, SELECTORS);
    };
    showWidths();
    const attachStyles = () => {
      const root = document.documentElement;
      if (!root) return false;
      if (!edgeStyle.isConnected) root.append(edgeStyle);
      if (!widthStyle.isConnected) root.append(widthStyle);
      return true;
    };
    const save = () => {
      showWidths();
      rememberLocally(widths);
      invoke("plugin:event|emit", {
        event: "carrier:pane-widths",
        payload: { list: widths.list, details: widths.details }
      })?.catch?.(() => {
      });
    };
    const followSettings = () => {
      const next = storedWidths();
      if (next.list === widths.list && next.details === widths.details) return;
      widths = next;
      showWidths();
    };
    window.addEventListener("carrier:settings", followSettings);
    window.addEventListener("carrier:pane-widths", followSettings);
    const chatRow = () => document.querySelector(`[${CHAT_ROW_ATTR}]`);
    const chatBox = () => chatRow()?.firstElementChild ?? document.querySelector('[role="main"]') ?? null;
    const startDrag = (event, edge) => {
      if (event.button !== 0) return;
      const pane = edge.dataset.pane;
      const el = edge.parentElement;
      const chat = chatBox();
      if (!el || !chat) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        edge.setPointerCapture(event.pointerId);
      } catch (_) {
      }
      const startX = event.clientX;
      const startWidth = el.getBoundingClientRect().width;
      const side = edgeSide(el.getBoundingClientRect(), chat.getBoundingClientRect());
      const { min, max } = dragBounds(
        pane,
        startWidth,
        chat.getBoundingClientRect().width,
        Number.parseFloat(getComputedStyle(el).minWidth)
      );
      let width2 = Math.round(startWidth);
      let frame = 0;
      const inline = SIZE_PROPS.map(
        (prop) => [prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]
      );
      document.documentElement.setAttribute(RESIZING_ATTR, "");
      edge.classList.add("dragging");
      const move = (moveEvent) => {
        width2 = dragWidth({ startWidth, startX, x: moveEvent.clientX, side, min, max });
        frame || (frame = requestAnimationFrame(() => {
          frame = 0;
          el.style.setProperty("flex", `0 0 ${width2}px`, "important");
          el.style.setProperty("width", `${width2}px`, "important");
          el.style.setProperty("max-width", paneCap(pane), "important");
        }));
      };
      const end = (endEvent) => {
        if (endEvent.pointerId !== event.pointerId) return;
        document.removeEventListener("pointerup", end, true);
        document.removeEventListener("pointercancel", end, true);
        edge.removeEventListener("pointermove", move);
        edge.removeEventListener("lostpointercapture", end);
        cancelAnimationFrame(frame);
        document.documentElement.removeAttribute(RESIZING_ATTR);
        edge.classList.remove("dragging");
        if (width2 !== Math.round(startWidth)) {
          widths = { ...widths, [pane]: width2 };
          save();
        }
        for (const [prop, value, priority] of inline) {
          if (value) el.style.setProperty(prop, value, priority);
          else el.style.removeProperty(prop);
        }
      };
      edge.addEventListener("pointermove", move);
      edge.addEventListener("lostpointercapture", end);
      document.addEventListener("pointerup", end, true);
      document.addEventListener("pointercancel", end, true);
    };
    const makeEdge = (pane) => {
      const edge = document.createElement("div");
      edge.className = EDGE_CLASS;
      edge.dataset.pane = pane;
      edge.setAttribute("aria-hidden", "true");
      edge.addEventListener("pointerdown", (event) => startDrag(event, edge));
      edge.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (widths[pane] === null) return;
        widths = { ...widths, [pane]: null };
        save();
      });
      return edge;
    };
    const edges = { list: makeEdge("list"), details: makeEdge("details") };
    const placeEdge = (pane, host, chat) => {
      const edge = edges[pane];
      if (!host || !chat) {
        edge.remove();
        return;
      }
      if (edge.parentElement !== host) host.append(edge);
      const side = edgeSide(host.getBoundingClientRect(), chat.getBoundingClientRect());
      if (edge.dataset.side !== side) edge.dataset.side = side;
    };
    let searchedLog = null;
    let sidesStale = true;
    const sync = () => {
      if (document.hidden || !attachStyles()) return;
      if (!isMessengerContentPath(location.pathname)) {
        edges.list.remove();
        edges.details.remove();
        return;
      }
      const main2 = document.querySelector('[role="main"]');
      const list = main2?.parentElement?.querySelector(':scope > [role="navigation"]') ?? null;
      if (list && list.getAttribute(PANE_ATTR) !== "list") {
        for (const old of document.querySelectorAll(`[${PANE_ATTR}="list"]`)) {
          old.removeAttribute(PANE_ATTR);
        }
        list.setAttribute(PANE_ATTR, "list");
        sidesStale = true;
      }
      const log = main2?.querySelector('[role="log"]') ?? null;
      let row = chatRow();
      if (main2 && log && !row?.contains(log) && log !== searchedLog) {
        searchedLog = log;
        const found = findChatRow(log, main2);
        if (found && found !== row) {
          row?.removeAttribute(CHAT_ROW_ATTR);
          found.setAttribute(CHAT_ROW_ATTR, "");
          row = found;
          sidesStale = true;
        }
      }
      const details = row && log && row.contains(log) && row.children.length > 1 ? row.children[1] : null;
      const listMoved = list !== null && edges.list.parentElement !== list;
      const detailsMoved = details !== null && edges.details.parentElement !== details;
      if (!sidesStale && !listMoved && !detailsMoved && details !== null === edges.details.isConnected) {
        return;
      }
      sidesStale = false;
      placeEdge("list", list, main2);
      placeEdge("details", details, row?.firstElementChild ?? null);
    };
    setInterval(sync, 1e3);
    document.addEventListener(
      "click",
      () => {
        searchedLog = null;
        setTimeout(sync, 50);
        setTimeout(sync, 400);
      },
      { capture: true, passive: true }
    );
    window.addEventListener(
      "resize",
      () => {
        searchedLog = null;
        sidesStale = true;
      },
      { passive: true }
    );
    document.addEventListener("visibilitychange", sync);
  }

  // inject/src/messenger/lib/quick-mute.ts
  var QUICK_MUTE_DURATION_MS = "28800000";
  function decideQuickMute(phase, snapshot, expired) {
    if (snapshot.threadMatches && (snapshot.muted === true || phase === "chooser" && snapshot.chooser === "unmute" || phase === "confirming" && snapshot.confirmed)) {
      return { action: "success", phase };
    }
    if (expired) return { action: "failure", phase };
    if (!snapshot.threadMatches) {
      return phase === "waiting" ? { action: "wait", phase } : { action: "failure", phase };
    }
    if (phase === "waiting") {
      if (snapshot.muted === false) return { action: "open-dialog", phase: "dialog" };
      if (snapshot.chatNotifications) return { action: "open-chooser", phase: "chooser" };
      if (!snapshot.infoRequested) return { action: "open-info", phase };
      return { action: "wait", phase };
    }
    if (phase === "chooser") {
      if (snapshot.chooser === "mute") return { action: "choose-mute", phase: "dialog" };
      return { action: "wait", phase };
    }
    if (phase === "dialog") {
      if (snapshot.dialog === "unselected") return { action: "select", phase };
      if (snapshot.dialog === "ready") return { action: "confirm", phase: "confirming" };
    }
    return { action: "wait", phase };
  }

  // inject/src/messenger/lib/thread-restore.ts
  var THREAD_RESTORE_WAIT_MS = 3e4;
  function threadRestoreStep(input) {
    if (input.done || input.onThread) return "done";
    if (input.waitedMs >= THREAD_RESTORE_WAIT_MS) return "load";
    return input.rowFound ? "click" : "wait";
  }

  // inject/src/messenger/lib/thread-viewed.ts
  var initialThreadViewedState = () => ({
    visible: false,
    threadPath: null,
    lastReportedAt: null
  });
  var THREAD_VIEW_RECHECK_MS = 5e3;
  function advanceThreadViewed(previous, threadPath, visible, now) {
    const active = visible && threadPath !== null;
    const changed = !previous.visible || previous.threadPath !== threadPath;
    const recheckDue = active && previous.lastReportedAt !== null && Number.isFinite(now) && now >= previous.lastReportedAt + THREAD_VIEW_RECHECK_MS;
    const emit = active && (changed || recheckDue) ? threadPath : null;
    return {
      state: {
        visible,
        threadPath,
        lastReportedAt: emit ? now : active ? previous.lastReportedAt : null
      },
      emit
    };
  }

  // inject/src/messenger/features/thread-nav.ts
  var RESTORED_THREAD_KEY = "carrier-restored-thread";
  var cancelThreadRestore = () => {
  };
  function conversationInfoButton() {
    const exact = document.querySelector(
      '[role="button"][aria-label="Conversation information"]'
    );
    if (exact) return exact;
    for (const el of document.querySelectorAll("[aria-label]")) {
      const label2 = (el.getAttribute("aria-label") || "").toLowerCase();
      if (label2.includes("conversation information") || label2.includes("conversation details"))
        return el.closest('[role="button"]') || el;
    }
    return null;
  }
  function openThreadForAction(path) {
    const wanted = threadPathId(path);
    if (!wanted) return null;
    const log = () => document.querySelector('[role="main"] [role="log"]');
    const onRoute = () => threadIdFromHref(location.pathname) === wanted;
    if (onRoute()) return onRoute;
    const staleLog = log();
    if (window.__carrierOpenThread?.(path) !== true) return null;
    return () => {
      const current = log();
      return onRoute() && current !== null && current !== staleLog;
    };
  }
  function stopThreadRestore() {
    cancelThreadRestore();
  }
  function restoreRecycledThread(id) {
    const startedAt = Date.now();
    let cancelled = false;
    let lastThread = threadIdFromHref(location.pathname);
    const markDone = () => {
      try {
        sessionStorage.setItem(RESTORED_THREAD_KEY, id);
      } catch (_) {
      }
    };
    cancelThreadRestore = () => {
      cancelled = true;
      markDone();
    };
    const onUserInput = (event) => {
      if (event.isTrusted) cancelThreadRestore();
    };
    for (const type of ["pointerdown", "keydown"]) {
      window.addEventListener(type, onUserInput, true);
    }
    const attempt = () => {
      if (cancelled) return;
      const current = threadIdFromHref(location.pathname);
      if (lastThread && current !== lastThread && current !== id) {
        cancelThreadRestore();
        return;
      }
      lastThread = current ?? lastThread;
      let done = false;
      try {
        done = sessionStorage.getItem(RESTORED_THREAD_KEY) === id;
      } catch (_) {
      }
      const row = [
        ...document.querySelectorAll('[role="navigation"] a[href*="/t/"]')
      ].find((a) => threadIdFromHref(a.getAttribute("href")) === id);
      const step = threadRestoreStep({
        done,
        onThread: current === id,
        rowFound: !!row,
        waitedMs: Date.now() - startedAt
      });
      if (step === "done") {
        if (!done) markDone();
        return;
      }
      if (step === "load") {
        markDone();
        location.href = `https://www.facebook.com/messages/t/${id}/`;
        return;
      }
      if (step === "click") row?.click();
      setTimeout(attempt, 500);
    };
    attempt();
  }
  function initThreadNav() {
    setTimeout(() => {
      const restoreId = window.__CARRIER_RESTORE_THREAD__;
      if (typeof restoreId === "string" && /^\d{1,32}$/.test(restoreId)) {
        restoreRecycledThread(restoreId);
      }
    }, 0);
    window.__carrierOpenThread = (href) => {
      noteExplicitAction();
      const id = threadPathId(href);
      if (!id) return false;
      cancelThreadRestore();
      for (const a of document.querySelectorAll('a[href*="/t/"]')) {
        if (threadIdFromHref(a.getAttribute("href")) === id) {
          a.click();
          return true;
        }
      }
      location.href = `https://www.facebook.com/messages/t/${id}/`;
      return true;
    };
    let viewed = initialThreadViewedState();
    const reportViewedThread = () => {
      const id = threadIdFromHref(location.pathname);
      const path = id ? `/t/${id}/` : null;
      const next = advanceThreadViewed(
        viewed,
        path,
        document.hasFocus() && !document.hidden,
        performance.now()
      );
      viewed = next.state;
      if (next.emit) {
        invoke("plugin:event|emit", {
          event: "carrier:thread-viewed",
          payload: { thread_path: next.emit }
        })?.catch?.(() => diag("thread-viewed.emit", "thread view emit failed"));
      }
    };
    setInterval(reportViewedThread, 1e3);
    document.addEventListener("visibilitychange", reportViewedThread);
    window.addEventListener("focus", reportViewedThread);
    window.addEventListener("blur", reportViewedThread);
    reportViewedThread();
    window.__carrierToggleInfo = () => {
      const btn = conversationInfoButton();
      if (btn) {
        btn.click();
        return true;
      }
      toast("Open a conversation first");
      return false;
    };
  }

  // inject/src/messenger/features/quick-mute.ts
  var POLL_MS2 = 250;
  var MUTE_BUDGET_MS = 12e3;
  var muteExpiries = /* @__PURE__ */ new Map();
  var pause = () => new Promise((resolve) => setTimeout(resolve, POLL_MS2));
  var label = (el) => el.getAttribute("aria-label") || el.textContent || "";
  var PANE_MUTE_CONTROL = /^(?:(un)?mute notifications?|turn (on|off) notifications)$/i;
  function threadMuteControl(stale) {
    let trigger = null;
    for (const el of document.querySelectorAll(
      '[role="main"] [role="button"][aria-label], [role="main"] [role="switch"][aria-label], [role="main"] button[aria-label]'
    )) {
      if (stale.has(el) || !isShown(el)) continue;
      const control2 = PANE_MUTE_CONTROL.exec((el.getAttribute("aria-label") || "").trim());
      if (!control2) continue;
      const checked = el.getAttribute("aria-checked");
      if (control2[1] || control2[2]?.toLowerCase() === "on" || checked === "true")
        return { muted: true, trigger: null };
      trigger ?? (trigger = el);
    }
    return { muted: trigger ? false : null, trigger };
  }
  function chatNotificationsControl(stale) {
    for (const el of document.querySelectorAll(
      '[role="main"] [role="button"][aria-label="Chat notifications"]'
    ))
      if (!stale.has(el) && isShown(el)) return el;
    return null;
  }
  var visibleButtons = (root) => [...root.querySelectorAll('[role="button"], button')].filter(
    (button) => isShown(button) && getComputedStyle(button).visibility !== "hidden" && button.getAttribute("aria-disabled") !== "true"
  );
  function durationRadio(dialog) {
    const input = dialog.querySelector(
      `input[type="radio"][value="${QUICK_MUTE_DURATION_MS}"]`
    );
    if (input) return input;
    for (const radio of dialog.querySelectorAll('[role="radio"]'))
      if (isShown(radio) && /^for 8 hours$/i.test((radio.textContent || "").trim())) return radio;
    return null;
  }
  function chooserDialog(stale) {
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (stale.has(dialog) || durationRadio(dialog) || !dialog.querySelector('[role="radio"]'))
        continue;
      for (const button of visibleButtons(dialog)) {
        const muted = conversationMuteFromLabel(label(button));
        if (muted !== null) return { dialog, button, muted };
      }
    }
    return null;
  }
  function muteDialog(stale) {
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (stale.has(dialog)) continue;
      const radio = durationRadio(dialog);
      if (!radio) continue;
      const confirm = visibleButtons(dialog).find(
        (button) => muteStateAfterExplicitAction(label(button)) === true || /^confirm$/i.test(label(button).trim())
      );
      if (confirm) return { radio, confirm };
    }
    return null;
  }
  var radioSelected = (radio) => radio instanceof HTMLInputElement && radio.checked || radio.getAttribute("aria-checked") === "true";
  async function mute(path, deadline) {
    if (Date.now() >= deadline) return false;
    const wantedThread = threadPathId(path);
    const stale = new Set(
      threadIdFromHref(location.pathname) === wantedThread ? [] : document.querySelectorAll('[role="main"] [role="button"], [role="main"] button')
    );
    const paneReady = openThreadForAction(path);
    if (!wantedThread || !paneReady) {
      diag("quick-mute.open", "validated thread could not be opened");
      return false;
    }
    const staleDialogs = new Set(document.querySelectorAll('[role="dialog"]'));
    let phase = "waiting";
    let infoRequested = false;
    let openedInfo = null;
    let openedChooser = null;
    let confirmed = null;
    try {
      while (true) {
        const control2 = threadMuteControl(stale);
        const chooser = phase === "chooser" ? chooserDialog(staleDialogs) : null;
        if (chooser) openedChooser = chooser.dialog;
        const dialog = phase === "dialog" ? muteDialog(staleDialogs) : null;
        const snapshot = {
          threadMatches: paneReady(),
          muted: control2.muted,
          chatNotifications: chatNotificationsControl(stale) !== null,
          chooser: !chooser ? "none" : chooser.muted ? "unmute" : "mute",
          infoRequested,
          dialog: !dialog ? "none" : radioSelected(dialog.radio) ? "ready" : "unselected",
          confirmed: confirmed !== null && (!confirmed.isConnected || !isShown(confirmed) || getComputedStyle(confirmed).visibility === "hidden" || mutedThreads.isMuted(wantedThread))
        };
        const decision = decideQuickMute(phase, snapshot, Date.now() >= deadline);
        phase = decision.phase;
        switch (decision.action) {
          case "open-info": {
            const info = conversationInfoButton();
            if (!info || stale.has(info)) break;
            infoRequested = true;
            if (info.getAttribute("aria-expanded") !== "true") {
              info.click();
              openedInfo = info;
            }
            break;
          }
          case "open-dialog":
            control2.trigger?.click();
            break;
          case "open-chooser":
            chatNotificationsControl(stale)?.click();
            break;
          case "choose-mute":
            chooser?.button.click();
            break;
          case "select":
            dialog?.radio.click();
            break;
          case "confirm":
            confirmed = dialog?.confirm ?? null;
            dialog?.confirm.click();
            break;
          case "success": {
            mutedThreads.observe(wantedThread, true);
            const kept = confirmed ? void 0 : muteExpiries.get(wantedThread);
            if (kept !== void 0) muteExpiries.delete(wantedThread);
            window.dispatchEvent(
              new CustomEvent("carrier:thread-mute", { detail: { id: wantedThread, muted: true } })
            );
            if (kept !== void 0) muteExpiries.set(wantedThread, kept);
            if (confirmed)
              muteExpiries.set(
                wantedThread,
                setTimeout(() => {
                  muteExpiries.delete(wantedThread);
                  mutedThreads.invalidateMute(wantedThread);
                  window.dispatchEvent(
                    new CustomEvent("carrier:thread-mute", {
                      detail: { id: wantedThread, muted: false }
                    })
                  );
                }, Number(QUICK_MUTE_DURATION_MS))
              );
            return true;
          }
          case "failure":
            diag(
              "quick-mute.delivery",
              `mute flow stopped in ${phase} (${document.visibilityState}; pane ${snapshot.threadMatches}, muted ${snapshot.muted}, chat notifications ${snapshot.chatNotifications}, chooser ${snapshot.chooser}, dialog ${snapshot.dialog})`
            );
            return false;
          case "wait":
            break;
        }
        await pause();
      }
    } finally {
      const chooser = openedChooser?.isConnected ? openedChooser : null;
      const close = chooser ? visibleButtons(chooser).find((button) => /^(close|done)$/i.test(label(button).trim())) : null;
      close?.click();
      if (openedInfo?.isConnected && openedInfo.getAttribute("aria-expanded") === "true" && paneReady())
        openedInfo.click();
    }
  }
  function initQuickMute() {
    window.addEventListener("carrier:thread-mute", (event) => {
      const id = event.detail?.id;
      if (typeof id !== "string") return;
      clearTimeout(muteExpiries.get(id));
      muteExpiries.delete(id);
    });
    window.__carrierQuickMute = (path, target, id, attempt, budgetMs) => {
      noteExplicitAction();
      const report = (ok) => carrierReplyResult(id, attempt, ok).catch(
        () => diag("quick-mute.ack", "mute acknowledgement emit failed")
      );
      if (threadPathId(path) === null || !Number.isSafeInteger(id) || id <= 0 || !actionTargetFor(target, document.cookie)) {
        void report(false);
        return;
      }
      const deadline = Date.now() + Math.min(Number(budgetMs) || 0, MUTE_BUDGET_MS);
      void withComposerDeliveryWhenAvailable(() => mute(path, deadline)).then((ok) => report(ok)).catch(() => {
        diag("quick-mute.exception", "mute flow raised an exception");
        void report(false);
      });
    };
  }

  // inject/src/messenger/lib/quick-reply.ts
  function decideQuickReply(phase, snapshot, expired) {
    if (phase === "waiting") {
      if (expired) return { action: "failure", phase };
      if (!snapshot.threadMatches || !snapshot.composerReady) {
        return { action: "wait", phase };
      }
      if (!snapshot.composerEmpty) return { action: "failure", phase };
      return { action: "insert", phase: "inserted" };
    }
    if (!snapshot.threadMatches || !snapshot.composerReady) {
      return { action: "failure", phase };
    }
    if (phase === "inserted") {
      if (snapshot.manualSubmitted) {
        if (snapshot.composerEmpty) return { action: "success", phase: "confirming" };
        return expired ? { action: "failure", phase } : { action: "wait", phase };
      }
      if (expired || !snapshot.draftMatches) {
        return { action: "failure", phase };
      }
      if (!snapshot.sendAvailable) return { action: "wait", phase };
      return { action: "send", phase: "confirming" };
    }
    if (snapshot.composerEmpty) return { action: "success", phase };
    if (expired) return { action: "failure", phase };
    return { action: "wait", phase };
  }
  var composerContainsReply = (content, reply) => reply.length > 0 && (content || "").replace(/\r\n/g, "\n") === reply.replace(/\r\n/g, "\n");
  var composerIncludesReply = (content, reply) => reply.length > 0 && (content || "").replace(/\r\n/g, "\n").includes(reply.replace(/\r\n/g, "\n"));

  // inject/src/messenger/features/quick-reply.ts
  var POLL_MS3 = 250;
  var DELIVERY_BUDGET_MS = 12e3;
  var MAX_REPLY_CHARS = 2e3;
  var COMPOSER_SELECTOR2 = '[role="main"] [contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"]';
  var insertedReplies = /* @__PURE__ */ new Map();
  var replyAttempts = /* @__PURE__ */ new Map();
  var pause2 = () => new Promise((resolve) => setTimeout(resolve, POLL_MS3));
  var currentThreadId = () => threadIdFromHref(location.pathname);
  var composer = () => firstShown(COMPOSER_SELECTOR2);
  var emitReplyResult = (id, attempt, ok) => {
    carrierReplyResult(id, attempt, ok).catch(
      () => diag("quick-reply.ack", "reply acknowledgement emit failed")
    );
  };
  var validRequest = (path, text, id, attempt) => threadPathId(path) !== null && text.trim().length > 0 && [...text].length <= MAX_REPLY_CHARS && Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(attempt) && attempt > 0;
  async function deliver(path, text, id, state3) {
    const wantedThread = threadPathId(path);
    if (!wantedThread || currentThreadId() !== wantedThread && window.__carrierOpenThread?.(path) !== true) {
      diag("quick-reply.open", "validated thread could not be opened");
      return false;
    }
    const deadline = Date.now() + DELIVERY_BUDGET_MS;
    let phase = "waiting";
    let controls = /* @__PURE__ */ new Map();
    let manualSubmitted = false;
    const onKeydown = (event) => {
      if (event.isTrusted && event.key === "Enter" && !event.shiftKey && !event.isComposing && phase === "inserted" && composer()?.contains(event.target))
        manualSubmitted = true;
    };
    const onClick = (event) => {
      const box = composer();
      if (event.isTrusted && phase === "inserted" && box && event.target instanceof Node && findSendButton(box, controls)?.contains(event.target))
        manualSubmitted = true;
    };
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("click", onClick, true);
    try {
      while (true) {
        if (state3.cancelled) return false;
        const box = composer();
        if (box && hasComposerMedia(box)) return false;
        const button = phase === "inserted" && box ? findSendButton(box, controls) : null;
        const snapshot = {
          threadMatches: currentThreadId() === wantedThread,
          composerReady: box !== null,
          draftMatches: composerContainsReply(box ? composerText(box) : null, text),
          sendAvailable: button !== null,
          composerEmpty: !box || !composerText(box).trim(),
          manualSubmitted
        };
        const decision = decideQuickReply(phase, snapshot, Date.now() >= deadline);
        phase = decision.phase;
        switch (decision.action) {
          case "wait":
            await pause2();
            break;
          case "insert": {
            if (!box) return false;
            controls = composerControls(box);
            box.focus();
            if (!document.execCommand("insertText", false, text)) {
              diag("quick-reply.insert", "composer rejected insertText");
              return false;
            }
            insertedReplies.set(id, { path, text });
            break;
          }
          case "send":
            if (state3.cancelled) return false;
            state3.clicked = true;
            button?.click();
            await pause2();
            break;
          case "success":
            insertedReplies.delete(id);
            return true;
          case "failure":
            diag("quick-reply.delivery", `reply flow stopped in ${phase}`);
            return false;
        }
      }
    } finally {
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("click", onClick, true);
    }
  }
  async function preserveDraft(path, text, id) {
    const wantedThread = threadPathId(path);
    if (!wantedThread || currentThreadId() !== wantedThread && window.__carrierOpenThread?.(path) !== true) {
      return false;
    }
    const deadline = Date.now() + DELIVERY_BUDGET_MS;
    while (Date.now() < deadline) {
      const box = composer();
      if (currentThreadId() === wantedThread && box) {
        box.focus();
        if (!text) return true;
        const inserted = insertedReplies.get(id);
        const current = composerText(box);
        if (composerContainsReply(current, text) || inserted?.path === path && inserted.text === text && composerIncludesReply(current, text)) {
          insertedReplies.delete(id);
          return true;
        }
        if (current.trim()) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(box);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
          if (!document.execCommand("insertText", false, `

${text}`)) {
            diag("quick-reply.draft", "fallback append failed");
            return false;
          }
          insertedReplies.delete(id);
          return true;
        }
        if (!document.execCommand("insertText", false, text)) {
          diag("quick-reply.draft", "fallback insertText failed");
          return false;
        }
        insertedReplies.delete(id);
        return true;
      }
      await pause2();
    }
    diag("quick-reply.draft", "fallback composer did not become ready");
    return false;
  }
  function initQuickReply() {
    window.__carrierQuickReply = (path, rawText, id, attempt) => {
      noteExplicitAction();
      const text = String(rawText);
      if (!validRequest(path, text, id, attempt)) {
        emitReplyResult(id, attempt, false);
        return;
      }
      const previous = replyAttempts.get(id);
      if (previous && previous.attempt >= attempt) return;
      const state3 = { attempt, cancelled: false, clicked: false, sent: false };
      replyAttempts.set(id, state3);
      if (replyAttempts.size > 128) replyAttempts.delete(replyAttempts.keys().next().value);
      void withComposerDelivery(async () => {
        const ok = await deliver(path, text, id, state3);
        state3.sent = ok;
        return ok;
      }).then((ok) => emitReplyResult(id, attempt, ok === true)).catch(() => {
        diag("quick-reply.exception", "reply flow raised an exception");
        emitReplyResult(id, attempt, false);
      });
    };
    window.__carrierQuickReplyDraft = (path, rawText, id, attempt) => {
      noteExplicitAction();
      const text = String(rawText);
      if (threadPathId(path) === null || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(attempt) || attempt <= 0) {
        emitReplyResult(id, attempt, false);
        return;
      }
      let state3 = replyAttempts.get(id);
      if (state3 && state3.attempt > attempt) return;
      if (!state3 || state3.attempt < attempt) {
        if (state3) {
          state3.cancelled = true;
          state3.attempt = attempt;
        } else {
          state3 = { attempt, cancelled: true, clicked: false, sent: false };
          replyAttempts.set(id, state3);
          if (replyAttempts.size > 128) replyAttempts.delete(replyAttempts.keys().next().value);
        }
      }
      void withComposerDeliveryWhenAvailable(
        () => state3?.clicked || state3?.sent ? Promise.resolve(true) : preserveDraft(path, text, id)
      ).then((ok) => emitReplyResult(id, attempt, ok === true)).catch(() => {
        diag("quick-reply.draft", "fallback draft flow raised an exception");
        emitReplyResult(id, attempt, false);
      });
    };
  }

  // inject/src/messenger/lib/read-ahead.ts
  /*! Includes code adapted from fMess (https://github.com/toanbku/fmess).
   *
   * MIT License
   *
   * Copyright (c) 2026 fMess contributors
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */
  var READ_AHEAD = {
    /** Chats read ahead per round. */
    chats: 12,
    /** Rows read from the thread index to find them (some are plain or archived). */
    rowsRead: 36,
    /** Messages per chat: a window's worth, and some to scroll up through. */
    messages: 40,
    /** Rounds start at most this often, however often they are asked for. */
    minGapMs: 2e4,
    /** Between chats; the worker reads its own store. */
    chatGapMs: 200,
    /** One chat's preload may take this long before the round moves on. */
    chatTimeoutMs: 15e3
  };
  var AUTHORITATIVE = "80";
  function selectReadAheadThreads(rows, types, toId, openThreadId, limit = READ_AHEAD.chats) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const row of rows) {
      if (out.length >= limit) break;
      if (!row || typeof row !== "object") continue;
      const thread2 = row;
      if (types.isMessengerOrE2EEInbox(thread2.folderName) !== true) continue;
      if (types.isArmadilloSecure(thread2.threadType) !== true) continue;
      if (types.isOpenOrArmadilloFnFThread(thread2) !== true) continue;
      if (thread2.isDisappearingMode === true) continue;
      if (toId(thread2.authorityLevel) !== AUTHORITATIVE) continue;
      const id = toId(thread2.threadKey);
      if (!id || !/^\d+$/.test(id) || id === openThreadId || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, threadKey: thread2.threadKey, authorityLevel: thread2.authorityLevel });
    }
    return out;
  }
  function readAheadWait(lastRunAt, now) {
    return lastRunAt === null ? 0 : Math.max(0, lastRunAt + READ_AHEAD.minGapMs - now);
  }

  // inject/src/messenger/features/read-ahead.ts
  var MODULES = [
    "ReQL",
    "LSDatabaseSingleton",
    "LSMessagingThreadTypeUtil",
    "I64",
    "MAWPreloadSecureMessages"
  ];
  var pause3 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function initReadAhead() {
    if (window.opener) return;
    let unloading = false;
    let recoveryFailed = false;
    window.addEventListener("beforeunload", () => {
      unloading = true;
    });
    window.addEventListener(SILENT_RECOVERY_RELOAD_EVENT, () => {
      unloading = true;
    });
    window.addEventListener(SILENT_RECOVERY_EVENT, (event) => {
      recoveryFailed = event.detail === true;
    });
    const allowed = () => !unloading && !recoveryFailed && navigator.onLine && !hasRateLimitEpisode() && accountId(document.cookie) !== null && isMessengerContentPath(location.pathname);
    let reported = false;
    const report = (detail) => {
      if (reported) return;
      reported = true;
      diag("read-ahead", detail);
    };
    const openThreadId = () => threadIdFromHref(location.pathname);
    let running = false;
    const round = async () => {
      if (running || !allowed()) return;
      running = true;
      try {
        const [q, singleton, types, i64, secure] = await loadFacebookModules(
          pageRequire(),
          MODULES
        );
        const preload = secure?.preloadSecureMessages ?? defaultExport(secure)?.preloadSecureMessages;
        const db = await singleton?.LSDatabaseSingleton;
        if (typeof preload !== "function" || typeof q?.toArrayAsync !== "function" || typeof q.firstAsync !== "function" || typeof i64?.to_string !== "function" || typeof types?.isOpenOrArmadilloFnFThread !== "function" || typeof db?.tables?.threads?.index !== "function" || !db.tables.mi_act_mapping_table) {
          report("Messenger's preload APIs changed");
          return;
        }
        const toId = (value) => {
          const id = i64.to_string(value);
          return typeof id === "string" ? id : null;
        };
        const rows = await q.toArrayAsync(
          q.fromTableDescending(db.tables.threads.index("lastActivityTimestampMs")).take(READ_AHEAD.rowsRead)
        );
        if (!Array.isArray(rows)) return report("Messenger's thread APIs changed");
        const threads = selectReadAheadThreads(rows, types, toId, openThreadId());
        let mappedCount = 0;
        let loaded = 0;
        for (const thread2 of threads) {
          if (!allowed() || thread2.id === openThreadId()) break;
          const mapped = await q.firstAsync(
            q.fromTableAscending(db.tables.mi_act_mapping_table).getKeyRange(thread2.threadKey)
          );
          if (!mapped) continue;
          mappedCount += 1;
          const done = await Promise.race([
            Promise.resolve(
              preload(db, thread2.threadKey, READ_AHEAD.messages, thread2.authorityLevel)
            ).then(
              () => true,
              () => false
            ),
            pause3(READ_AHEAD.chatTimeoutMs).then(() => false)
          ]);
          if (done) loaded += 1;
          await pause3(READ_AHEAD.chatGapMs);
        }
        diag("read-ahead.round", `chats=${threads.length} mapped=${mappedCount} loaded=${loaded}`);
      } catch (error) {
        report(error instanceof Error ? error.message.slice(0, 200) : "round failed");
      } finally {
        running = false;
      }
    };
    let timer = 0;
    let lastRunAt = null;
    const schedule = (delay) => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        const wait = readAheadWait(lastRunAt, Date.now());
        if (wait > 0) return schedule(wait);
        lastRunAt = Date.now();
        void round();
      }, delay);
    };
    const start = window.setInterval(() => {
      if (!chatRows().length) return;
      window.clearInterval(start);
      schedule(8e3);
      window.addEventListener("blur", () => schedule(2e3));
      window.setInterval(() => schedule(0), 4 * 6e4);
      loadFacebookModules(pageRequire(), ["ReQL", "LSDatabaseSingleton"]).then(async ([q, singleton]) => {
        const db = await singleton?.LSDatabaseSingleton;
        const threads = db && q.fromTableAscending(db.tables.threads);
        if (typeof threads?.subscribe !== "function") return;
        threads.subscribe(() => schedule(5e3));
      }).catch(() => {
      });
    }, 1e3);
  }

  // inject/src/messenger/lib/messenger-db.ts
  async function readMessengerDatabase(load, read, timeoutMs = 750) {
    if (typeof load !== "function") return null;
    const run = async () => {
      const singleton = load("LSDatabaseSingleton");
      const db = await singleton.LSDatabaseSingleton;
      const i64 = load("I64");
      if (typeof db?.tables?.threads?.get !== "function" || typeof i64?.of_string !== "function") {
        throw new Error("Messenger database APIs changed");
      }
      return read({ db, i64, load });
    };
    let timer;
    try {
      return await Promise.race([
        run().catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // inject/src/messenger/lib/recent-threads.ts
  var MAX_NAME_CHARS = 60;
  function conversationTitle2(names2, viewer, mode) {
    const nicknames = showNicknames(mode, names2.isGroup);
    const others = names2.participants.filter((person) => person.id !== viewer);
    if (!names2.isGroup) {
      const [person, extra] = others;
      return person && !extra ? nicknames && person.nickname || person.name : "";
    }
    if (names2.title.trim()) return names2.title;
    return others.map((person) => nicknames && person.nickname || participantFirstName(person)).filter(Boolean).join(", ");
  }
  var MAX_ROWS_READ = 576;
  function readRecentThreads(load, options, timeoutMs = 2e3) {
    const { viewer, mode, limit, fallbackName } = options;
    let stopped = false;
    return readMessengerDatabase(
      load,
      async ({ db, i64, load: load2 }) => {
        const q = load2("ReQL");
        const types = load2("LSMessagingThreadTypeUtil");
        if (typeof q?.toArrayAsync !== "function" || typeof types?.isMessengerOrE2EEInbox !== "function" || typeof types.isArmadilloSecure !== "function" || typeof types.isGroup !== "function" || typeof i64.to_string !== "function") {
          throw new Error("Messenger thread APIs changed");
        }
        const out = [];
        const seen = /* @__PURE__ */ new Set();
        let checked = 0;
        for (let want = limit * 4; ; want *= 4) {
          if (stopped) return out;
          const rows = await q.toArrayAsync(
            q.fromTableDescending(db.tables.threads.index("lastActivityTimestampMs")).take(want)
          );
          if (!Array.isArray(rows)) throw new Error("Messenger thread APIs changed");
          for (const row of rows.slice(checked)) {
            if (stopped) return out;
            if (out.length >= limit) break;
            if (!row || typeof row !== "object") continue;
            const thread2 = row;
            if (types.isMessengerOrE2EEInbox(thread2.folderName) !== true) continue;
            if (thread2.isHidden === true && types.isArmadilloSecure(thread2.threadType) !== true)
              continue;
            const id = i64.to_string(thread2.threadKey);
            if (typeof id !== "string" || !/^\d+$/.test(id) || seen.has(id)) continue;
            let name = types.isGroup(thread2.threadType) === true && typeof thread2.threadName === "string" ? thread2.threadName.trim() : "";
            if (!name) {
              const names2 = await readConversationNotificationNames(id, load2);
              if (stopped) return out;
              name = names2 ? conversationTitle2(names2, viewer, mode).trim() : "";
            }
            name || (name = fallbackName?.(id) ?? "");
            if (!name) continue;
            seen.add(id);
            out.push({ name: name.slice(0, MAX_NAME_CHARS), href: `/t/${id}/` });
          }
          checked = rows.length;
          if (out.length >= limit || rows.length < want || want >= MAX_ROWS_READ) break;
        }
        return out;
      },
      timeoutMs
    ).finally(() => {
      stopped = true;
    });
  }

  // inject/src/messenger/features/recent-threads.ts
  function initRecentThreads() {
    if (!window.__TAURI_INTERNALS__) return;
    const MAX_THREADS = 9;
    const EMPTY_GRACE_MS = 15e3;
    const rowName = (a) => {
      const row = a.closest('[role="row"]') || a;
      for (const span of row.querySelectorAll("span")) {
        const t = (span.textContent || "").replace(/\s+/g, " ").trim();
        if (t && !SEPARATOR_RE.test(t)) return t.slice(0, 60);
      }
      return "";
    };
    const chatListScrolledFromTop = (rows) => {
      const first = rows[0];
      if (!first) return false;
      for (let el = first.parentElement; el && el !== document.body; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 16) return el.scrollTop > 8;
      }
      return false;
    };
    const rowNames = () => {
      const names2 = /* @__PURE__ */ new Map();
      for (const a of chatRows()) {
        const id = threadIdFromHref(a.getAttribute("href"));
        if (id && !names2.has(id)) names2.set(id, rowName(a));
      }
      return names2;
    };
    const readDatabase = (viewer) => {
      let names2;
      return readRecentThreads(window.require, {
        viewer,
        mode: nicknameMode(window.__CARRIER_SETTINGS__),
        limit: MAX_THREADS,
        fallbackName: (id) => (names2 ?? (names2 = rowNames())).get(id) ?? ""
      });
    };
    const scan = () => {
      const rows = chatRows();
      if (chatListScrolledFromTop(rows)) return null;
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const a of rows) {
        const id = threadIdFromHref(a.getAttribute("href"));
        if (!id || seen.has(id)) continue;
        const name = rowName(a);
        if (!name) continue;
        seen.add(id);
        out.push({ name, href: `/t/${id}/` });
        if (out.length >= MAX_THREADS) break;
      }
      return out;
    };
    let lastSent = null;
    let emptySince = 0;
    let pushing = false;
    let pushAgain = false;
    const hidden = () => hidesNames(window.__CARRIER_SETTINGS__);
    const push = async () => {
      if (pushing) {
        pushAgain = true;
        return;
      }
      pushing = true;
      try {
        do {
          pushAgain = false;
          await send();
        } while (pushAgain);
      } finally {
        pushing = false;
      }
    };
    const send = async () => {
      const viewer = accountId(document.cookie);
      let threads = !viewer || hidden() ? [] : await readDatabase(viewer) ?? scan();
      const clear = !viewer || hidden() || accountId(document.cookie) !== viewer;
      if (clear) threads = [];
      if (threads === null) return;
      if (!clear && threads.length === 0) {
        const now = Date.now();
        if (!emptySince) emptySince = now;
        if (now - emptySince < EMPTY_GRACE_MS) return;
      } else {
        emptySince = 0;
      }
      const key = JSON.stringify(threads);
      if (key === lastSent) return;
      lastSent = key;
      invoke("plugin:event|emit", { event: "carrier:recent-threads", payload: threads })?.catch?.(
        () => {
        }
      );
    };
    let timer;
    const startPoll = () => {
      clearInterval(timer);
      timer = setInterval(push, document.hidden ? 6e4 : 1e4);
    };
    document.addEventListener("visibilitychange", () => {
      startPoll();
      if (!document.hidden) push();
    });
    window.addEventListener("carrier:settings", push);
    startPoll();
    setTimeout(push, 1500);
    setTimeout(push, 4e3);
  }

  // inject/src/messenger/features/scheduled-send.ts
  var account = () => accountScopedStorageKey("schedule", document.cookie)?.split(":")[1] ?? null;
  var thread = () => {
    const id = threadIdFromHref(location.pathname);
    return id ? `/t/${id}/` : null;
  };
  var loadedThread = thread();
  var routeChanged = false;
  var pushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    const previous = thread();
    pushState(...args);
    if (thread() !== previous) routeChanged = true;
  };
  var replaceState = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    const previous = thread();
    replaceState(...args);
    if (thread() !== previous) routeChanged = true;
  };
  window.addEventListener("popstate", () => {
    routeChanged = true;
  });
  var pause4 = () => new Promise((resolve) => setTimeout(resolve, 100));
  var ready = () => scheduledSendConnectionReady() && rateLimitRemainingMs() <= 0 && !window.__carrierInCall;
  var activeTextInput = () => document.hasFocus() && document.activeElement?.matches('input, textarea, [contenteditable="true"][role="textbox"]');
  var paneThread = () => {
    const pane = document.querySelector('[role="main"] [role="log"]');
    if (!pane) return null;
    const paneId = pane.getAttribute("data-thread-id");
    if (paneId && /^\d+$/.test(paneId)) return `/t/${paneId}/`;
    return !routeChanged && loadedThread === thread() ? loadedThread : null;
  };
  async function deliverScheduledMessage(message, connectionReady = ready) {
    if (!connectionReady() || account() !== message.account || sendWindow(message.due, Date.now()) !== "due")
      return "defer";
    const existing = findComposer();
    if (existing && (composerText(existing).trim() || hasComposerMedia(existing))) return "defer";
    if (thread() !== message.thread && activeTextInput()) return "defer";
    if (thread() !== message.thread) {
      const link = [...document.querySelectorAll('a[href*="/t/"]')].find(
        (a) => threadIdFromHref(a.getAttribute("href")) === threadIdFromHref(message.thread)
      );
      if (!link) return "defer";
      link.click();
      return "defer";
    }
    const deadline = Math.min(message.due + SEND_GRACE_MS, Date.now() + 12e3);
    let box = null;
    let inserted = false;
    let clicked = false;
    let cleared = false;
    let interrupted = false;
    let controls = /* @__PURE__ */ new Map();
    const onInput = (event) => {
      if (event.isTrusted) interrupted = true;
    };
    document.addEventListener("pointerdown", onInput, true);
    document.addEventListener("keydown", onInput, true);
    try {
      while (Date.now() <= deadline) {
        if (interrupted || account() !== message.account || !connectionReady()) break;
        const current = findComposer();
        if (thread() !== message.thread) {
          if (inserted) break;
          await pause4();
          continue;
        }
        if (!current || hasComposerMedia(current)) {
          if (inserted) break;
          await pause4();
          continue;
        }
        if (paneThread() !== message.thread) return "defer";
        if (!inserted) {
          if (composerText(current).trim()) return "defer";
          box = current;
          controls = composerControls(box);
          if (!replaceComposerText(box, message.text)) break;
          inserted = true;
          await pause4();
          continue;
        }
        if (current !== box || composerText(current) !== message.text) break;
        const send = findSendButton(current, controls);
        if (!send) {
          await pause4();
          continue;
        }
        if (Date.now() > message.due + SEND_GRACE_MS || account() !== message.account || !connectionReady())
          break;
        clicked = true;
        send.click();
        const confirmUntil = Date.now() + 5e3;
        while (Date.now() < confirmUntil) {
          if (thread() !== message.thread || account() !== message.account || !box.isConnected)
            return "uncertain";
          if (!composerText(box).trim()) return "sent";
          await pause4();
        }
        return "uncertain";
      }
    } finally {
      document.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("keydown", onInput, true);
      if (!clicked && inserted && box?.isConnected && thread() === message.thread && account() === message.account && composerText(box) === message.text)
        cleared = replaceComposerText(box, "");
    }
    if (clicked) return "uncertain";
    if (inserted && !cleared && (!box?.isConnected || !composerText(box).trim())) return "uncertain";
    if (inserted && box?.isConnected && composerText(box).trim()) return "missed";
    return sendWindow(message.due, Date.now()) === "missed" ? "missed" : "defer";
  }
  function element(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== void 0) el.textContent = text;
    return el;
  }
  var action = (label2, run, className = "carrier-schedule-action") => {
    const button = element("button", className, label2);
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      run();
    });
    return button;
  };
  function initScheduledSend() {
    let rows = [];
    let owner = null;
    let polling = false;
    let busy = false;
    let panel = null;
    let panelThread = null;
    let editing = null;
    let sourceBox = null;
    let sourceText = "";
    let button = null;
    let emoji = null;
    let cachedBox = null;
    let framePending = false;
    let canDeliver = false;
    const close = (focus = false) => {
      panel?.remove();
      panel = null;
      editing = null;
      button?.setAttribute("aria-expanded", "false");
      if (focus) button?.focus();
    };
    const request = async (operation) => {
      const current = account();
      if (!current) throw new Error("Sign in to schedule a message.");
      const response = await carrierScheduledSend({ ...operation, account: current });
      if (account() !== current) throw new Error("The signed-in account changed.");
      if (response.error) throw new Error(response.error);
      owner = current;
      rows = response.items;
      canDeliver = response.can_deliver;
      ensureButton();
      return response;
    };
    const failed = (error) => {
      toast(error instanceof Error ? error.message : "Could not update scheduled messages.");
      diag("scheduled-send.action", "schedule operation failed");
    };
    const warning = async () => {
      if (document.hidden || !window.__carrierToast) return;
      const missed = rows.filter(
        (row) => (row.status === "missed" || row.status === "missed_draft" || row.status === "uncertain") && !row.toast_seen
      );
      if (!missed.length) return;
      toast(
        missed.some((row) => row.status === "uncertain") ? "⚠ Scheduled send could not be confirmed. It will not be retried. Open Schedule send to review." : "⚠ Scheduled message not sent: its time window passed. Open Schedule send to reschedule.",
        void 0,
        { warning: true }
      );
      for (const row of missed) await request({ op: "seen", id: row.id });
    };
    const positionPanel = () => {
      if (!panel || !button) return;
      const anchor = button.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, anchor.right - panel.offsetWidth))}px`;
      panel.style.bottom = `${Math.max(8, innerHeight - anchor.top + 10)}px`;
      panel.style.maxHeight = `${Math.max(120, anchor.top - 20)}px`;
    };
    const syncColors = () => {
      if (!button || !emoji) return;
      const icon2 = emoji.querySelector("svg path") || emoji.querySelector("svg");
      const fill = icon2 ? getComputedStyle(icon2).fill : "";
      const accent = fill && fill !== "none" ? fill : getComputedStyle(emoji).color;
      button.style.color = accent;
      if (!panel) return;
      panel.style.setProperty("--schedule-accent", accent);
    };
    const save = async (due) => {
      if (busy) return;
      const current = account();
      if (!current || current !== owner || thread() !== panelThread) {
        close();
        return;
      }
      const text = editing?.text ?? sourceText;
      if (!text.trim() || [...text].length > MAX_SCHEDULED_CHARS) {
        toast("Use 1–2,000 characters for a scheduled message.");
        return;
      }
      if (!editing && (!sourceBox?.isConnected || composerText(sourceBox) !== sourceText || hasComposerMedia(sourceBox))) {
        toast("Your draft changed. Reopen Schedule send.");
        close();
        return;
      }
      if (due <= Date.now()) {
        toast("Choose a future date and time.");
        return;
      }
      busy = true;
      const editingItem = editing;
      const expectedBox = sourceBox;
      const expectedThread = panelThread;
      const expectedText = sourceText;
      const recoveredDraft = editingItem?.status === "draft" || editingItem?.status === "missed_draft";
      if (recoveredDraft && (editingItem.thread !== expectedThread || !expectedBox?.isConnected || composerText(expectedBox) !== editingItem.text || hasComposerMedia(expectedBox))) {
        busy = false;
        toast("Open the original conversation with its unchanged draft to schedule this message.");
        return;
      }
      try {
        let result;
        try {
          result = await request({
            op: "save",
            ...editingItem ? { id: editingItem.id } : {},
            thread: editingItem?.thread ?? expectedThread ?? void 0,
            text,
            due
          });
        } catch (error) {
          if (!editingItem || recoveredDraft) throw error;
          let saved;
          try {
            saved = (await request({ op: "list" })).items.find((row) => row.id === editingItem.id);
          } catch {
          }
          if (saved?.status !== "scheduled" || saved.account !== current || saved.thread !== editingItem.thread || saved.text !== text || saved.due !== due) {
            if (saved && (saved.due !== due || saved.status !== "scheduled")) throw error;
            throw new Error(
              "Scheduling could not be confirmed. Check Schedule send before retrying."
            );
          }
          result = {
            items: rows,
            saved: saved.id,
            claimed: null,
            error: null,
            can_deliver: canDeliver
          };
        }
        if (!result.saved) throw new Error("Message was not saved.");
        if (!editingItem || recoveredDraft) {
          const textToClear = recoveredDraft ? editingItem?.text ?? "" : expectedText;
          const unchanged = expectedBox?.isConnected && thread() === expectedThread && account() === current && composerText(expectedBox) === textToClear && !hasComposerMedia(expectedBox);
          if (!unchanged || !expectedBox) {
            if (!editingItem) await request({ op: "cancel", id: result.saved });
            throw new Error("Your draft changed. The message was not scheduled.");
          }
          const sameComposer = () => expectedBox.isConnected && findComposer() === expectedBox && thread() === expectedThread && account() === current && !hasComposerMedia(expectedBox);
          replaceComposerText(expectedBox, "");
          for (let attempt = 0; attempt < 10; attempt++) {
            await pause4();
            if (!sameComposer() || composerText(expectedBox) !== textToClear) break;
          }
          if (!sameComposer() || composerText(expectedBox).trim()) {
            close();
            throw new Error(
              "Draft clearing could not be confirmed. Your message is saved but not scheduled."
            );
          }
        }
        if (!editingItem || recoveredDraft) {
          try {
            await request({ op: "arm", id: result.saved });
          } catch (error) {
            let status;
            try {
              status = (await request({ op: "list" })).items.find(
                (row) => row.id === result.saved
              )?.status;
            } catch {
            }
            if (status !== "scheduled") {
              if (status === "draft" || status === "missed_draft") throw error;
              throw new Error(
                "Scheduling could not be confirmed. Check Schedule send before retrying."
              );
            }
          }
        }
        close();
        toast(`Message scheduled for ${formatScheduleTime(due, true)}. It will send automatically.`);
      } catch (error) {
        failed(error);
      } finally {
        busy = false;
      }
    };
    const customPicker = (container, due = Date.now() + 10 * 6e4) => {
      const fields = element("div", "carrier-schedule-fields");
      const dateLabel = element("label", "", "Date");
      const date = element("input", "");
      date.type = "date";
      date.value = localDateValue(due);
      date.min = localDateValue(Date.now());
      date.required = true;
      const timeLabel = element("label", "", "Time (24h)");
      const time = element("input", "");
      time.type = "text";
      time.inputMode = "numeric";
      time.placeholder = "HH:mm";
      time.pattern = "([01][0-9]|2[0-3]):[0-5][0-9]";
      time.required = true;
      const local = new Date(due);
      time.value = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
      dateLabel.append(date);
      timeLabel.append(time);
      fields.append(dateLabel, timeLabel);
      const confirm = action(
        editing ? "Reschedule message" : "Schedule message",
        () => {
          if (!date.reportValidity() || !time.reportValidity()) return;
          const value = localScheduleTime(date.value, time.value);
          if (value === null) {
            toast("Choose a valid local time in HH:mm format.");
            return;
          }
          void save(value);
        },
        "carrier-schedule-primary"
      );
      container.append(fields, confirm);
    };
    const render = () => {
      if (!panel) return;
      panel.replaceChildren();
      const heading = element("div", "carrier-schedule-heading");
      const closeButton = action("", () => close(true), "carrier-schedule-close");
      closeButton.setAttribute("aria-label", "Close scheduling");
      closeButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 4 12 12M16 4 4 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      heading.append(
        element("h2", "", editing ? "Reschedule message" : "Schedule send"),
        closeButton
      );
      panel.append(heading);
      if (editing) {
        panel.append(element("p", "carrier-schedule-preview", editing.text));
        if (editing.status === "uncertain")
          panel.append(
            element(
              "p",
              "carrier-schedule-warning",
              "Check the conversation before rescheduling. Messenger may already have accepted this message."
            )
          );
        customPicker(panel, Math.max(editing.due, Date.now() + 15 * 6e4));
      } else if (sourceText.trim()) {
        for (const preset of schedulePresets(Date.now())) {
          const choice = action(
            "",
            () => {
              const updated = schedulePresets(Date.now()).find((p) => p.label === preset.label);
              if (updated) void save(updated.due);
            },
            "carrier-schedule-preset"
          );
          choice.append(
            element("span", "", preset.label),
            element("span", "carrier-schedule-time", formatScheduleTime(preset.due))
          );
          panel.append(choice);
        }
        const details = element("details", "carrier-schedule-custom");
        details.append(element("summary", "", "Choose date & time"));
        customPicker(details);
        details.addEventListener("toggle", positionPanel);
        panel.append(details);
      } else
        panel.append(element("p", "carrier-schedule-note", "Write a text message to schedule it."));
      panel.append(
        element(
          "p",
          "carrier-schedule-note",
          `${Intl.DateTimeFormat().resolvedOptions().timeZone} · 24-hour time`
        ),
        element(
          "p",
          "carrier-schedule-note carrier-schedule-divider",
          "Sends automatically while Carrier is running and connected."
        )
      );
      if (rows.length && !editing) {
        panel.append(element("h3", "carrier-schedule-divider", "Scheduled messages"));
        for (const row of [...rows].sort((a, b) => a.due - b.due)) {
          const item = element("div", "carrier-schedule-item");
          const status = row.status === "missed" || row.status === "missed_draft" ? "Not sent" : row.status === "uncertain" ? "Send unconfirmed" : row.status === "sending" ? "Submitting…" : row.status === "draft" ? "Not scheduled" : "Scheduled";
          item.append(
            element(
              "strong",
              row.status === "missed" || row.status === "missed_draft" || row.status === "uncertain" ? "carrier-schedule-warning" : "",
              `${status} · ${formatScheduleTime(row.due, true)}`
            ),
            element(
              "small",
              "carrier-schedule-note",
              row.thread === thread() ? "This conversation" : "Another conversation"
            ),
            element("p", "carrier-schedule-preview", row.text)
          );
          const actions = element("div", "carrier-schedule-item-actions");
          if (row.status !== "sending") {
            actions.append(
              action(row.status === "scheduled" ? "Edit time" : "Reschedule", () => {
                editing = row;
                render();
              }),
              action("Cancel", () => {
                void request({ op: "cancel", id: row.id }).then(render).catch(failed);
              })
            );
          }
          actions.append(
            action("Copy text", () => {
              void navigator.clipboard.writeText(row.text).then(() => toast("Message copied")).catch(() => toast("Could not copy the message"));
            })
          );
          item.append(actions);
          panel.append(item);
        }
      }
      syncColors();
      positionPanel();
    };
    const open = async () => {
      if (panel) {
        close(true);
        return;
      }
      if (window.__CARRIER_SCHEDULED_SEND_AVAILABLE__ === false) {
        toast("Scheduled sending is unavailable with multiple app instances enabled.");
        return;
      }
      const box = findComposer();
      if (!box || hasComposerMedia(box) || !thread()) return;
      sourceBox = box;
      sourceText = composerText(box);
      panelThread = thread();
      try {
        await request({ op: "list" });
      } catch (error) {
        failed(error);
        return;
      }
      if (findComposer() !== box || thread() !== panelThread || hasComposerMedia(box)) return;
      panel = element("div", "carrier-schedule-panel");
      panel.id = "carrier-schedule-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Schedule send");
      document.body.append(panel);
      button?.setAttribute("aria-expanded", "true");
      render();
      panel.querySelector("button")?.focus();
    };
    function ensureButton() {
      const box = cachedBox?.isConnected && isShown(cachedBox) ? cachedBox : findComposer();
      cachedBox = box;
      const region = box && composerRegion(box);
      if (owner && owner !== account()) {
        rows = [];
        owner = null;
        close();
      }
      if (panel && (thread() !== panelThread || !box || hasComposerMedia(box))) close();
      if (!box || !region || !thread() || hasComposerMedia(box) || !composerText(box).trim() && !rows.length && !panel) {
        button?.remove();
        return;
      }
      const nextEmoji = emoji?.isConnected && region.contains(emoji) ? emoji : buttonByLabel(["choose an emoji", "emoji"], region) ?? [
        ...box.parentElement?.querySelectorAll('button, [role="button"]') ?? []
      ].find(
        (candidate) => (box.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && isShown(candidate) && !!candidate.querySelector("svg")
      );
      if (!nextEmoji) {
        button?.remove();
        return;
      }
      emoji = nextEmoji;
      let before = emoji;
      while (before.parentElement && !before.parentElement.contains(box))
        before = before.parentElement;
      const parent = before.parentElement;
      if (!parent || parent === region) {
        button?.remove();
        return;
      }
      if (!button) {
        button = action(
          "",
          () => {
            void open();
          },
          "carrier-schedule-button"
        );
        button.setAttribute("data-carrier-schedule", "");
        button.setAttribute("aria-label", "Schedule send");
        button.setAttribute("aria-haspopup", "dialog");
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-controls", "carrier-schedule-panel");
        button.title = "Schedule send";
        button.innerHTML = '<svg viewBox="2 2 20 20" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 4h2v5.4l3.5 2-.9 1.8L11 12.6Z"/></svg>';
      }
      if (button.parentElement !== parent || button.nextElementSibling !== before)
        parent.insertBefore(button, before);
      button.dataset.queued = String(rows.length > 0);
      button.title = rows.length ? `Schedule send · ${rows.length} saved` : "Schedule send";
      syncColors();
    }
    const poll = async () => {
      if (polling || busy || !account() || window.__CARRIER_SCHEDULED_SEND_AVAILABLE__ === false)
        return;
      polling = true;
      try {
        await request({ op: "list" });
        await warning();
        while (canDeliver && ready()) {
          const due = nextDueMessage(rows, Date.now());
          if (!due) break;
          const finished = await withComposerDelivery(async () => {
            const box = findComposer();
            if (box && (composerText(box).trim() || hasComposerMedia(box))) return false;
            if (thread() !== due.thread && activeTextInput() && !panel?.contains(document.activeElement))
              return false;
            if (routeChanged || loadedThread !== due.thread) {
              if (activeTextInput() && !panel?.contains(document.activeElement)) return false;
              location.href = `https://www.facebook.com/messages${due.thread}`;
              return false;
            }
            const claimed = await request({ op: "claim", id: due.id });
            if (claimed.claimed !== due.id) return false;
            const job = claimed.items.find((row) => row.id === due.id && row.status === "sending");
            if (!job) return false;
            if (panel) close();
            let outcome = "uncertain";
            try {
              outcome = await deliverScheduledMessage(job);
            } finally {
              if (account() === job.account) await request({ op: outcome, id: job.id, due: job.due });
            }
            return outcome !== "defer";
          });
          if (!finished) break;
        }
      } catch {
        diag("scheduled-send.poll", "schedule check failed");
      } finally {
        polling = false;
      }
    };
    const scheduleMount = () => {
      if (framePending) return;
      framePending = true;
      requestAnimationFrame(() => {
        framePending = false;
        ensureButton();
      });
    };
    const start = () => {
      ensureButton();
      new MutationObserver((records) => {
        if (records.every(
          (r) => r.target instanceof Element && (r.target.closest(".carrier-schedule-panel") || r.target === button) || r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every((n) => n === button)
        ))
          return;
        scheduleMount();
      }).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "src", "aria-label", "aria-disabled"]
      });
      document.addEventListener("change", scheduleMount, true);
      document.addEventListener("input", scheduleMount, true);
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape" && panel) {
            event.stopPropagation();
            close(true);
          }
        },
        true
      );
      document.addEventListener(
        "pointerdown",
        (event) => {
          if (panel && event.target instanceof Node && !panel.contains(event.target) && !button?.contains(event.target))
            close();
        },
        true
      );
      window.addEventListener("resize", positionPanel);
      window.addEventListener("online", () => {
        void poll();
      });
      document.addEventListener("visibilitychange", () => {
        void poll();
      });
      window.addEventListener("carrier:settings", scheduleMount);
      new MutationObserver(scheduleMount).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"]
      });
      setInterval(() => {
        scheduleMount();
        void poll();
      }, 5e3);
      void poll();
    };
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }

  // inject/src/messenger/lib/scrollbars.ts
  var INDICATOR_MIN_HEIGHT = 24;
  var INDICATOR_INSET = 9;
  function indicatorPlace(box, scroll) {
    const range = scroll.scrollHeight - scroll.clientHeight;
    if (range <= 1 || box.height <= 0 || scroll.scrollHeight <= 0) return null;
    const height = Math.min(
      box.height,
      Math.max(INDICATOR_MIN_HEIGHT, box.height * scroll.clientHeight / scroll.scrollHeight)
    );
    const progress = Math.min(1, Math.max(0, scroll.scrollTop / range));
    return {
      left: box.right - INDICATOR_INSET,
      top: box.top + (box.height - height) * progress,
      height
    };
  }

  // inject/src/messenger/features/scrollbars.ts
  var KIND_ATTR = "data-carrier-scrollbars";
  var INDICATOR_ID = "carrier-scroll-indicator";
  var CHATS_ATTR = "data-carrier-chats";
  var COVER_CHECK_MS = 250;
  var HIDE_AFTER_MS = 800;
  function drawsOverlayScrollbars(root) {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;top:-200px;left:0;width:0;height:0;overflow:hidden;";
    const box = document.createElement("div");
    box.style.cssText = "width:100px;height:100px;overflow:scroll;";
    host.attachShadow({ mode: "closed" }).append(box);
    root.append(host);
    const overlay = box.offsetWidth === box.clientWidth;
    host.remove();
    return overlay;
  }
  function initScrollbars() {
    const html = document.documentElement;
    const overlay = drawsOverlayScrollbars(html);
    html.setAttribute(KIND_ATTR, overlay ? "overlay" : "classic");
    if (overlay) return;
    const indicator = document.createElement("div");
    indicator.id = INDICATOR_ID;
    indicator.setAttribute("aria-hidden", "true");
    html.append(indicator);
    let scrolled = null;
    let frame = 0;
    let shownHeight = 0;
    let coverPane = null;
    let coverCheckedAt = Number.NEGATIVE_INFINITY;
    let covered = false;
    let hideTimer = 0;
    const hide = () => {
      indicator.style.opacity = "0";
    };
    const draw = (now) => {
      frame = 0;
      const pane = scrolled;
      scrolled = null;
      if (!pane?.isConnected) return;
      const rect = pane.getBoundingClientRect();
      const place = indicatorPlace(rect, pane);
      if (!place) return;
      if (pane !== coverPane || now - coverCheckedAt > COVER_CHECK_MS) {
        coverPane = pane;
        coverCheckedAt = now;
        const x = place.left + 3;
        covered = [place.top + 2, place.top + place.height / 2, place.top + place.height - 2].some(
          (y) => {
            const hit = document.elementFromPoint(x, y);
            return hit !== null && hit !== indicator && !pane.contains(hit);
          }
        );
      }
      window.clearTimeout(hideTimer);
      if (covered) return hide();
      if (place.height !== shownHeight) {
        shownHeight = place.height;
        indicator.style.height = `${place.height}px`;
      }
      indicator.style.transform = `translate(${place.left}px, ${place.top}px)`;
      indicator.style.opacity = "1";
      hideTimer = window.setTimeout(() => {
        hide();
        coverPane = null;
      }, HIDE_AFTER_MS);
    };
    document.addEventListener(
      "scroll",
      (event) => {
        if (!html.hasAttribute(CHATS_ATTR) || !(event.target instanceof Element)) return;
        scrolled = event.target;
        if (!frame) frame = requestAnimationFrame(draw);
      },
      { capture: true, passive: true }
    );
  }

  // inject/src/messenger/features/selection.ts
  var CHATS_ATTR2 = "data-carrier-chats";
  function initSelection() {
    const html = document.documentElement;
    const sync = () => {
      const onChats = isMessengerContentPath(location.pathname);
      if (html.hasAttribute(CHATS_ATTR2) !== onChats) html.toggleAttribute(CHATS_ATTR2, onChats);
    };
    for (const method2 of ["pushState", "replaceState"]) {
      const original = history[method2];
      history[method2] = function(...args) {
        const result = original.apply(this, args);
        sync();
        return result;
      };
    }
    window.addEventListener("popstate", sync);
    sync();
    const pageSelectAll = (target) => html.hasAttribute(CHATS_ATTR2) && !html.hasAttribute("data-carrier-login") && (target === document.body || target === html);
    document.addEventListener(
      "selectstart",
      (event) => {
        if (pageSelectAll(event.target)) event.preventDefault();
      },
      true
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.code !== "KeyA" || event.altKey || event.shiftKey) return;
        if (!(event.metaKey || event.ctrlKey) || event.metaKey && event.ctrlKey) return;
        const active = document.activeElement;
        if (active instanceof HTMLElement && (active.isContentEditable || active.closest("input, textarea")))
          return;
        if (pageSelectAll(document.body)) event.preventDefault();
      },
      true
    );
  }

  // inject/src/messenger/features/selector-health.ts
  var WATCHED_SELECTORS = [
    // The notification MutationObserver is intentionally scoped to this exact
    // grid. A looser chat-link selector can stay green while the scanner is dead.
    { key: "notification-grid", sel: '[role="navigation"] [role="grid"]' },
    // Conversation list links: Cmd/Ctrl+1–9, unread-conversations badge,
    // recent threads, hide-names blur.
    { key: "chat-list", sel: '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]' },
    // The conversation pane: media viewer, hide-names header blur.
    { key: "main-region", sel: '[role="main"]' },
    // The injected Settings gear depends on Messenger's localized overflow
    // control/icon. Watch the actual output rather than testing a copied icon
    // path constant against itself.
    // Mounted from a requestAnimationFrame callback, which a hidden webview
    // never runs — so a hidden window says nothing about whether the selector
    // still works, and checking one would report a break every interval for as
    // long as Carrier sits in the background.
    { key: "settings-button", sel: "[data-carrier-settings-button]", needsVisible: true }
  ];
  function initSelectorHealth() {
    if (!window.__TAURI_INTERNALS__) return;
    let warnedUser = false;
    const misses = /* @__PURE__ */ new Map();
    const check = () => {
      if (!location.pathname.startsWith("/messages")) return;
      if (document.querySelector('input[name="pass"]')) return;
      for (const { key, sel, needsVisible } of WATCHED_SELECTORS) {
        if (needsVisible && document.hidden) {
          misses.set(key, 0);
          continue;
        }
        if (document.querySelector(sel)) {
          misses.set(key, 0);
          continue;
        }
        const n = (misses.get(key) || 0) + 1;
        misses.set(key, n);
        if (n < 2) continue;
        diag(`selector.${key}`, "core selector matched nothing on a logged-in Messenger page");
        if (!warnedUser) {
          warnedUser = true;
          toast("A Messenger update may have broken part of Carrier — check for updates (F2).");
        }
      }
    };
    setTimeout(check, 45e3);
    setInterval(check, 3e5);
  }

  // inject/src/messenger/lib/settings-button.ts
  var MESSENGER_OVERFLOW_PATH_PREFIX = "M2.25 10a1.75 1.75";
  function isMessengerHeaderOverflowControl(iconPath) {
    return iconPath.trim().startsWith(MESSENGER_OVERFLOW_PATH_PREFIX);
  }

  // inject/src/messenger/features/settings-button.ts
  var SLOT_ATTR = "data-carrier-settings-slot";
  var BUTTON_ATTR = "data-carrier-settings-button";
  function isOverflowButton(button) {
    return button.matches('button, [role="button"]') && isMessengerHeaderOverflowControl(button.querySelector("svg path")?.getAttribute("d") || "");
  }
  function findOverflowButton() {
    const buttons = document.querySelectorAll(
      `[role="button"]:not([${BUTTON_ATTR}]), button:not([${BUTTON_ATTR}])`
    );
    let iconFallback = null;
    for (const button of buttons) {
      if (!isOverflowButton(button)) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width < 28 || rect.height < 28) continue;
      if (!iconFallback || rect.top < iconFallback.getBoundingClientRect().top) {
        iconFallback = button;
      }
    }
    return iconFallback;
  }
  function placementFor(button) {
    let wrapper = button.parentElement;
    for (let depth = 0; wrapper && depth < 4; depth += 1) {
      const row = wrapper.parentElement;
      if (!row) return null;
      if (row.children.length > 1) return { row, before: wrapper };
      wrapper = row;
    }
    return null;
  }
  function createGearIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "3");
    svg.appendChild(circle);
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.5 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"
    );
    svg.appendChild(path);
    return svg;
  }
  function createSettingsSlot() {
    const slot = document.createElement("div");
    slot.setAttribute(SLOT_ATTR, "");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(BUTTON_ATTR, "");
    button.setAttribute("aria-label", "Carrier Settings");
    button.title = "Carrier Settings";
    button.appendChild(createGearIcon());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.__carrierToggleSettings?.();
    });
    slot.appendChild(button);
    return slot;
  }
  function initSettingsButton() {
    let scheduled = false;
    let mounted;
    const ensureButton = () => {
      scheduled = false;
      if (!location.pathname.startsWith("/messages")) return;
      if (mounted?.slot.isConnected && mounted.overflow.isConnected && isOverflowButton(mounted.overflow)) {
        const placement2 = placementFor(mounted.overflow);
        const rect = mounted.overflow.getBoundingClientRect();
        if (placement2 && rect.width >= 28 && rect.height >= 28 && mounted.slot.parentElement === placement2.row && mounted.slot.nextElementSibling === placement2.before)
          return;
      }
      mounted = void 0;
      const overflow = findOverflowButton();
      if (!overflow) return;
      const placement = placementFor(overflow);
      if (!placement) return;
      const slots = Array.from(document.querySelectorAll(`[${SLOT_ATTR}]`));
      const slot = slots.shift() || createSettingsSlot();
      for (const duplicate of slots) duplicate.remove();
      if (slot.parentElement !== placement.row || slot.nextElementSibling !== placement.before) {
        placement.row.insertBefore(slot, placement.before);
      }
      mounted = { slot, overflow };
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(ensureButton);
    };
    const start = () => {
      schedule();
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["role", "d"]
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  // inject/src/messenger/features/share-intake.ts
  var COMPOSER_SELECTOR3 = '[role="main"] div[role="textbox"][contenteditable="true"]';
  var COMPOSER_POLL_MS = 1e3;
  function attachToComposer(composer2, files) {
    try {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      composer2.focus();
      const paste = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true
      });
      const pasted = dispatchTransferEvent(composer2, paste, "clipboardData", transfer);
      if (pasted.acknowledged) return "attached";
      if (pasted.payloadRead) return "uncertain";
      const drop = new DragEvent("drop", {
        bubbles: true,
        cancelable: true
      });
      const dropped = dispatchTransferEvent(composer2, drop, "dataTransfer", transfer);
      if (dropped.acknowledged) return "attached";
      return dropped.payloadRead ? "uncertain" : "retry";
    } catch {
      return "retry";
    }
  }
  function initShareIntake() {
    let pending = null;
    const tryDeliver = () => {
      if (!pending) return true;
      if (!shareIsDeliverable(pending.parkedAt, Date.now())) {
        clearTimeout(pending.timer);
        pending = null;
        toast("Shared file expired");
        return true;
      }
      const composer2 = firstShown(COMPOSER_SELECTOR3);
      if (!composer2) return false;
      const { files, timer } = pending;
      const result = attachToComposer(composer2, files);
      if (result === "retry") return false;
      clearTimeout(timer);
      pending = null;
      if (result === "attached") {
        diag("share.attached", `${files.length}`);
      } else {
        diag("share.attach-failed", `${files.length}`);
        toast("Could not attach the shared file");
      }
      return true;
    };
    const poll = () => {
      if (tryDeliver()) return;
      if (pending) {
        pending.timer = window.setTimeout(poll, COMPOSER_POLL_MS);
      }
    };
    Object.defineProperty(window, "__carrierShareMedia", {
      value: (payload) => {
        const entries = sanitizeSharedFiles(payload);
        const { files, failures: failures2 } = decodeSharedFiles(entries);
        if (failures2) {
          diag("share.partial-decode", `${failures2}`);
        }
        if (!files.length) {
          diag("share.empty-payload", "0");
          return;
        }
        const receivedAt = Date.now();
        if (pending && !shareIsDeliverable(pending.parkedAt, receivedAt)) {
          clearTimeout(pending.timer);
          pending = null;
        }
        if (pending) {
          if (pending.files.length + files.length > MAX_SHARED_FILES) {
            diag("share.busy", `${pending.files.length}`);
            toast("Attach the current shared files before sharing more");
            return;
          }
          clearTimeout(pending.timer);
          pending.files.push(...files);
          pending.parkedAt = receivedAt;
        } else {
          pending = { files, parkedAt: receivedAt };
        }
        if (!tryDeliver()) {
          diag("share.waiting-for-composer", `${pending.files.length}`);
          toast("Open a conversation to attach the shared file");
          pending.timer = window.setTimeout(poll, COMPOSER_POLL_MS);
        }
      },
      writable: false,
      configurable: false
    });
  }

  // inject/src/messenger/lib/zoom.ts
  var clampZoom = (p) => Math.min(200, Math.max(30, Math.round(p) || 100));

  // inject/src/messenger/features/zoom.ts
  var ZOOM_KEY = "carrier:zoom";
  var zoomLevel = 100;
  function setZoomLevel(percent, fromSettings) {
    const clamped = clampZoom(percent);
    const changed = clamped !== zoomLevel;
    zoomLevel = clamped;
    try {
      localStorage.setItem(ZOOM_KEY, String(clamped));
      const settings = window.__CARRIER_SETTINGS__ && typeof window.__CARRIER_SETTINGS__ === "object" && !Array.isArray(window.__CARRIER_SETTINGS__) ? window.__CARRIER_SETTINGS__ : null;
      if (settings) settings.zoom = clamped;
      const cached = JSON.parse(
        localStorage.getItem("__carrier_settings") || "null"
      );
      const nextSettings = cached && typeof cached === "object" && !Array.isArray(cached) ? cached : settings ? Object.assign({}, settings) : null;
      if (nextSettings) {
        nextSettings.zoom = clamped;
        localStorage.setItem("__carrier_settings", JSON.stringify(nextSettings));
      }
    } catch (_) {
    }
    if (changed && !fromSettings) {
      invoke("plugin:event|emit", { event: "carrier:zoom", payload: clamped })?.catch?.(() => {
      });
    }
  }
  var zoomIn = () => setZoomLevel(zoomLevel + 10);
  var zoomOut = () => setZoomLevel(zoomLevel - 10);
  var zoomReset = () => setZoomLevel(100);
  function syncZoomFromSettings() {
    const s = window.__CARRIER_SETTINGS__ || {};
    const z = typeof s.zoom === "number" && Number.isFinite(s.zoom) ? clampZoom(s.zoom) : 100;
    if (z !== zoomLevel) setZoomLevel(z, true);
  }
  function initZoomLevel() {
    const s = window.__CARRIER_SETTINGS__ || {};
    let z = typeof s.zoom === "number" && Number.isFinite(s.zoom) ? clampZoom(s.zoom) : 100;
    const stored = parseInt(localStorage.getItem(ZOOM_KEY) || "", 10);
    if (z === 100 && Number.isFinite(stored) && clampZoom(stored) !== 100) {
      z = clampZoom(stored);
      invoke("plugin:event|emit", { event: "carrier:zoom", payload: z })?.catch?.(() => {
      });
    }
    if (z !== zoomLevel) setZoomLevel(z, true);
    window.addEventListener("carrier:settings", syncZoomFromSettings);
  }
  function initZoom() {
    window.__carrierZoomIn = zoomIn;
    window.__carrierZoomOut = zoomOut;
    window.__carrierZoomReset = zoomReset;
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", initZoomLevel, { once: true });
    else initZoomLevel();
  }

  // inject/src/messenger/features/shortcuts.ts
  var isMac3 = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  var accel = (e) => !e.altKey && (isMac3 ? e.metaKey : e.ctrlKey);
  var shortcuts = {
    "[": () => stepConversation(-1),
    "]": () => stepConversation(1),
    "-": zoomOut,
    "=": zoomIn,
    "+": zoomIn,
    "0": zoomReset,
    r: () => location.reload(),
    k: () => focusChatSearch(),
    f: () => searchInConversation(),
    l: () => focusComposer(),
    e: () => openEmojiPicker(),
    g: () => openGifPicker(),
    t: () => attachFiles(),
    "/": () => window.__carrierToggleShortcuts?.()
  };
  function initShortcuts() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          stepConversation(e.shiftKey ? -1 : 1);
          return;
        }
        if (!accel(e)) return;
        const fn = shortcuts[e.key];
        if (fn) {
          e.preventDefault();
          fn();
        }
      },
      true
    );
  }
  function initFunctionKeys() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "F1") {
          e.preventDefault();
          window.__carrierToggleShortcuts?.();
        } else if (e.key === "F5") {
          e.preventDefault();
          location.reload();
        } else if (e.key === "F3") {
          e.preventDefault();
          window.__carrierToggleSettings?.();
        } else if (e.key === "F2") {
          e.preventDefault();
          window.__carrierCheckUpdates?.();
        } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
          const target = chatRows()[Number(e.key) - 1];
          if (target) {
            e.preventDefault();
            target.click();
          }
        }
      },
      true
    );
  }
  function initShortcutRegistry() {
    const actions = {
      nextConversation: () => stepConversation(1),
      prevConversation: () => stepConversation(-1),
      focusChatSearch,
      focusComposer,
      searchInConversation,
      openEmojiPicker,
      openGifPicker,
      attachFiles,
      newConversation
    };
    window.__carrierShortcuts = Object.fromEntries(
      Object.entries(actions).map(([name, action2]) => [
        name,
        () => {
          noteExplicitAction();
          stopThreadRestore();
          return action2();
        }
      ])
    );
  }

  // inject/src/messenger/features/spellcheck.ts
  var SPELL_SEL = '[contenteditable="true"], textarea, input[type="text"], input[type="search"]';
  function applySpellcheckNow() {
    const on2 = window.__CARRIER_SETTINGS__?.spellcheck === true;
    document.querySelectorAll(SPELL_SEL).forEach((el) => {
      el.setAttribute?.("spellcheck", on2 ? "true" : "false");
    });
  }
  function applySpellcheck() {
    applySpellcheckNow();
    registerAddedNodeSweep((root) => {
      const on2 = window.__CARRIER_SETTINGS__?.spellcheck === true;
      const want = on2 ? "true" : "false";
      const set = (el) => {
        if (el.getAttribute?.("spellcheck") !== want) el.setAttribute?.("spellcheck", want);
      };
      if (root.matches?.(SPELL_SEL)) set(root);
      root.querySelectorAll?.(SPELL_SEL).forEach(set);
    });
  }
  function initSpellcheck() {
    window.addEventListener("carrier:settings", applySpellcheckNow);
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", applySpellcheck);
    else applySpellcheck();
  }

  // inject/src/messenger/features/sync-health.ts
  var SYNC_CHECK_INTERVAL_MS = 1e4;
  function initSyncHealth() {
    const tracker = new SyncHealthTracker();
    const serverDelays = new RetryAfterWindow();
    const emitSyncAlert = (kind) => invoke("plugin:event|emit", { event: "carrier:sync-alert", payload: { kind } })?.catch?.(
      () => {
      }
    );
    let sawRateLimit = false;
    let recoveryFailed = false;
    let recoveryObservedAt = null;
    const observeResponse = (id, status, retryHeader, syncOperation) => {
      const now = Date.now();
      const delay = status === 429 && navigator.onLine ? serverDelays.observe(retryHeader, now) : void 0;
      if (tracker.response(id, status, now, navigator.onLine)) {
        reportRateLimit("http-429", delay);
      } else if (syncOperation && syncResponseSucceeded(status) && rateLimitRemainingMs() <= 0 && !tracker.degraded(now)) {
        recoveryObservedAt ?? (recoveryObservedAt = now);
      } else if (!syncResponseSucceeded(status)) {
        recoveryObservedAt = null;
      }
    };
    try {
      const nativeFetch = window.fetch;
      const wrappedFetch = new Proxy(nativeFetch, {
        apply(target, thisArg, args) {
          let tracked;
          let syncOperation = false;
          try {
            const input = args[0];
            const url = typeof input === "string" || input instanceof URL ? String(input) : input instanceof Request ? input.url : "";
            if (url && isMessengerContentPath(location.pathname) && isMessengerSyncRequest(url, location.href)) {
              tracked = tracker.started(Date.now());
              const headers = new Headers(
                args[1]?.headers ?? (input instanceof Request ? input.headers : void 0)
              );
              syncOperation = isMessengerSyncOperation(
                args[1]?.body,
                headers.get("x-fb-friendly-name")
              );
            }
          } catch (_) {
          }
          const result = Reflect.apply(target, thisArg, args);
          if (tracked !== void 0) {
            const id = tracked;
            result.then(
              (response) => {
                observeResponse(
                  id,
                  response.status,
                  response.status === 429 ? response.headers.get("Retry-After") : null,
                  syncOperation
                );
              },
              (error) => {
                const aborted = error?.name === "AbortError";
                if (navigator.onLine && !aborted) tracker.failed(id, Date.now());
                else tracker.abandoned(id);
              }
            );
          }
          return result;
        }
      });
      Object.defineProperty(window, "fetch", {
        value: wrappedFetch,
        writable: true,
        configurable: true
      });
    } catch (_) {
      diag("sync.requests", "could not observe Messenger sync fetches");
    }
    try {
      const xhrUrls = /* @__PURE__ */ new WeakMap();
      const nativeOpen = XMLHttpRequest.prototype.open;
      const nativeSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(...args) {
        try {
          xhrUrls.set(this, String(args[1]));
        } catch (_) {
        }
        return nativeOpen.apply(this, args);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        try {
          const url = xhrUrls.get(this);
          if (url && isMessengerContentPath(location.pathname) && isMessengerSyncRequest(url, location.href)) {
            const id = tracker.started(Date.now());
            const syncOperation = isMessengerSyncOperation(args[0]);
            this.addEventListener("abort", () => tracker.abandoned(id), { once: true });
            this.addEventListener(
              "loadend",
              () => {
                observeResponse(
                  id,
                  this.status,
                  this.status === 429 ? this.getResponseHeader("Retry-After") : null,
                  syncOperation
                );
              },
              { once: true }
            );
          }
        } catch (_) {
        }
        return nativeSend.apply(this, args);
      };
    } catch (_) {
      diag("sync.requests", "could not observe Messenger sync XHRs");
    }
    const stuckLoading = new SampledPersistence(STUCK_LOADING_SAMPLES);
    const hasRunningAnimation = (root) => {
      const nodes = [root, ...Array.from(root.querySelectorAll("*")).slice(0, 8)];
      for (const node of nodes) {
        const style = getComputedStyle(node);
        if (style.animationName !== "none" && style.animationPlayState !== "paused") return true;
      }
      return false;
    };
    const isActuallyVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
        return false;
      }
      let current = el;
      while (current) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) <= 0) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };
    const loadingSpinnerVisible = () => {
      try {
        for (const el of document.querySelectorAll('[role="progressbar"], [role="status"]')) {
          if (isActuallyVisible(el) && hasRunningAnimation(el)) return true;
        }
      } catch (_) {
      }
      return false;
    };
    const SYNC_BANNER_ID = "carrier-sync-banner";
    let manualRetryPending = false;
    const showSyncBanner = (limited = false) => {
      try {
        const existing = document.getElementById(SYNC_BANNER_ID);
        const banner = existing || document.createElement("div");
        banner.id = SYNC_BANNER_ID;
        let label2 = banner.querySelector("span");
        if (!label2) {
          label2 = document.createElement("span");
          label2.setAttribute("role", "alert");
          banner.appendChild(label2);
        }
        const message = limited ? rateLimitRemainingMs() > 0 ? `Messenger is rate limiting this session. Retrying automatically in ${Math.max(1, Math.ceil(rateLimitRemainingMs() / 6e4))} min. Chats may be out of date.` : "Messenger rate-limit cooldown ended. Automatic recovery is waiting for connectivity and any draft or call to finish." : recoveryFailed ? "Messenger could not reconnect. Chats may be out of date." : syncProcessingStalled ? "Messenger is slow to update messages. Chats may be out of date." : "⚠ Messenger sync is broken — chats may be out of date";
        if (label2.textContent !== message) label2.textContent = message;
        const buttonStyle = {
          background: "#1c1e21",
          color: "#fff",
          border: "none",
          borderRadius: "6px",
          padding: "6px 10px",
          font: "inherit",
          flexShrink: "0",
          cursor: "pointer",
          pointerEvents: "auto"
        };
        let retry = banner.querySelector("button:not([data-carrier-reload])");
        if ((limited || recoveryFailed) && !retry) {
          retry = document.createElement("button");
          retry.type = "button";
          retry.textContent = "Try again";
          Object.assign(retry.style, buttonStyle);
          retry.addEventListener("click", (event) => {
            if (!event.isTrusted || manualRetryPending) return;
            if (sawRateLimit) retryRateLimitNow();
            else window.dispatchEvent(new Event(SILENT_RECOVERY_RETRY_EVENT));
          });
          banner.appendChild(retry);
        }
        const protectedNow = !!window.__carrierInCall || [...document.querySelectorAll('[contenteditable="true"]')].some(
          (element2) => !!element2.textContent?.trim()
        );
        if (retry) {
          retry.hidden = !limited && !recoveryFailed;
          retry.disabled = limited ? manualRetryPending || rateLimitRemainingMs() <= 0 : protectedNow || !navigator.onLine;
          retry.textContent = limited ? retry.disabled ? "Retry pending…" : "Try again" : "Reconnect";
        }
        let reload = banner.querySelector("[data-carrier-reload]");
        if ((recoveryFailed || syncProcessingStalled) && !reload) {
          reload = document.createElement("button");
          reload.type = "button";
          reload.dataset.carrierReload = "";
          reload.textContent = "Reload";
          Object.assign(reload.style, buttonStyle);
          reload.addEventListener("click", (event) => {
            if (event.isTrusted) window.dispatchEvent(new Event(SILENT_RECOVERY_RELOAD_EVENT));
          });
          banner.appendChild(reload);
        }
        if (reload) {
          reload.hidden = limited || !recoveryFailed && !syncProcessingStalled;
          reload.disabled = protectedNow || !navigator.onLine;
        }
        if (existing) return;
        Object.assign(banner.style, {
          display: "flex",
          alignItems: "center",
          gap: "12px",
          boxSizing: "border-box",
          position: "fixed",
          top: "10px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: "2147483646",
          background: "#ffba00",
          color: "#1c1e21",
          padding: "6px 14px",
          borderRadius: "12px",
          boxShadow: "0 4px 16px rgba(0,0,0,.35)",
          font: "600 12px -apple-system, system-ui, sans-serif",
          pointerEvents: "none",
          maxWidth: "90vw",
          whiteSpace: "normal",
          overflow: "hidden",
          textOverflow: "ellipsis"
        });
        (document.body || document.documentElement).appendChild(banner);
      } catch (_) {
      }
    };
    window.addEventListener(RATE_LIMIT_RETRY_STATE_EVENT, (event) => {
      manualRetryPending = event.detail === true;
      showSyncBanner(true);
    });
    const hideSyncBanner = () => {
      try {
        document.getElementById(SYNC_BANNER_ID)?.remove();
      } catch (_) {
      }
    };
    window.addEventListener(SILENT_RECOVERY_EVENT, (event) => {
      recoveryFailed = event.detail === true;
      if (sawRateLimit) showSyncBanner(true);
      else if (recoveryFailed || degraded || syncProcessingStalled) showSyncBanner();
      else hideSyncBanner();
    });
    window.addEventListener("offline", () => tracker.abandonOutstanding());
    let degraded = false;
    const showRateLimit = () => {
      if (rateLimitRemainingMs() > 0) {
        recoveryObservedAt = null;
        if (!sawRateLimit) emitSyncAlert("rate-limited");
        sawRateLimit = true;
        tracker.abandonOutstanding();
        stuckLoading.observe(false);
      }
      if (sawRateLimit) showSyncBanner(true);
    };
    window.addEventListener(RATE_LIMIT_EVENT, showRateLimit);
    showRateLimit();
    setInterval(() => {
      if (rateLimitRemainingMs() > 0) {
        showRateLimit();
        return;
      }
      if (!navigator.onLine) {
        tracker.abandonOutstanding();
        return;
      }
      const now = Date.now();
      tracker.sweep(now);
      if (recoveryObservedAt !== null && now - recoveryObservedAt >= SYNC_CHECK_INTERVAL_MS && !tracker.degraded(now)) {
        sawRateLimit = false;
        recoveryObservedAt = null;
        if (clearRateLimitOnRecovery()) {
          serverDelays.clear();
          emitSyncAlert("recovered");
        }
      }
      if (!document.hidden && isMessengerContentPath(location.pathname)) {
        stuckLoading.observe(loadingSpinnerVisible());
      }
      const degradedNow = tracker.degraded(now) || stuckLoading.persistent() || syncProcessingStalled;
      if (degradedNow && !degraded) {
        degraded = true;
        const reason = syncProcessingStalled ? "message processing stalled" : stuckLoading.persistent() ? "loading UI stuck" : `requests failing (${tracker.summary(now)})`;
        diag("sync.stalled", `messenger sync degraded: ${reason}`);
        emitSyncAlert("degraded");
      } else if (!degradedNow && degraded) {
        degraded = false;
        diag("sync.stalled", "messenger sync recovered");
        emitSyncAlert("recovered");
      }
      if (sawRateLimit) showSyncBanner(true);
      else if (degraded || recoveryFailed) showSyncBanner();
      else hideSyncBanner();
    }, SYNC_CHECK_INTERVAL_MS);
  }

  // inject/src/messenger/features/system-emoji.ts
  var SOURCE_ATTR = "data-carrier-emoji-sprite";
  var GLYPH_ATTR = SYSTEM_EMOJI_GLYPH_ATTR;
  var REACTION_ATTR = "data-carrier-reaction-emoji";
  var CANDIDATE_SEL = "img[alt], [aria-label]";
  var INTERACTIVE_SEL = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]';
  function initSystemEmoji() {
    const html = document.documentElement;
    let observer = null;
    let pending = false;
    const queuedRoots = /* @__PURE__ */ new Set();
    const on2 = () => window.__CARRIER_SETTINGS__?.system_emoji === true;
    function sourceGlyph(el) {
      if (el?.nodeType !== 1 || el.hasAttribute(GLYPH_ATTR)) return "";
      if (el.matches?.("img[alt]")) {
        const img = el;
        const src = img.currentSrc || img.src || img.getAttribute("src") || "";
        if (!EMOJI_SOURCE_RE.test(src)) return "";
        return emojiGlyph(img.getAttribute("alt"));
      }
      if (el.matches?.(INTERACTIVE_SEL)) return "";
      const label2 = emojiGlyph(el.getAttribute("aria-label"));
      if (!label2) return "";
      const bg = getComputedStyle(el).backgroundImage || "";
      return EMOJI_SOURCE_RE.test(bg) ? label2 : "";
    }
    function clearGlyph(el) {
      el.__carrierSystemEmojiGlyph?.remove?.();
      el.removeAttribute(SOURCE_ATTR);
      el.removeAttribute("data-carrier-emoji-glyph");
      delete el.__carrierSystemEmojiGlyph;
    }
    function ensureGlyph(el) {
      const glyph = sourceGlyph(el);
      if (!glyph || !el.parentNode) {
        if (el?.hasAttribute?.(SOURCE_ATTR)) clearGlyph(el);
        return;
      }
      el.setAttribute(SOURCE_ATTR, "");
      el.setAttribute("data-carrier-emoji-glyph", glyph);
      let span = el.__carrierSystemEmojiGlyph;
      if (!span?.isConnected) {
        span = document.createElement("span");
        span.setAttribute(GLYPH_ATTR, "");
        span.setAttribute("role", "img");
        el.__carrierSystemEmojiGlyph = span;
        el.after(span);
      }
      if (span.previousSibling !== el) el.after(span);
      if (span.textContent !== glyph) span.textContent = glyph;
      if (span.getAttribute("aria-label") !== glyph) span.setAttribute("aria-label", glyph);
    }
    function scan(root) {
      if (!on2() || !root || root.nodeType !== 1) return;
      ensureGlyph(root);
      root.querySelectorAll?.(CANDIDATE_SEL).forEach(ensureGlyph);
    }
    function sweepOrphanGlyphs() {
      for (const glyph of document.querySelectorAll(`[${GLYPH_ATTR}]`)) {
        const source = glyph.previousElementSibling;
        if (!source?.hasAttribute(SOURCE_ATTR) || source.__carrierSystemEmojiGlyph !== glyph || !source.isConnected) {
          glyph.remove();
        }
      }
    }
    function markReactionGlyphs() {
      const reactions = /* @__PURE__ */ new Set();
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        const children = [...menu.children].map((child) => ({
          glyphs: child.querySelectorAll(`[${GLYPH_ATTR}]`).length,
          role: child.getAttribute("role")
        }));
        if (!isReactionMenuShape(children)) continue;
        menu.querySelectorAll(`[${GLYPH_ATTR}]`).forEach((glyph) => reactions.add(glyph));
      }
      document.querySelectorAll(`[${REACTION_ATTR}]`).forEach((glyph) => {
        if (!reactions.has(glyph)) glyph.removeAttribute(REACTION_ATTR);
      });
      reactions.forEach((glyph) => glyph.setAttribute(REACTION_ATTR, ""));
    }
    function schedule(root = document.documentElement) {
      if (!on2()) return;
      queuedRoots.add(root);
      if (queuedRoots.size > 50) {
        queuedRoots.clear();
        queuedRoots.add(document.documentElement);
      }
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const roots = [...queuedRoots];
        queuedRoots.clear();
        roots.forEach(scan);
        sweepOrphanGlyphs();
        markReactionGlyphs();
      });
    }
    function start() {
      if (observer) return;
      observer = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes") {
            schedule(m.target);
          } else {
            schedule(m.target);
            for (const n of m.addedNodes) schedule(n);
          }
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["alt", "aria-label", "src", "style", "role"]
      });
    }
    function stop() {
      observer?.disconnect();
      observer = null;
      pending = false;
      queuedRoots.clear();
      document.querySelectorAll(`[${GLYPH_ATTR}]`).forEach((el) => el.remove());
      document.querySelectorAll(`[${SOURCE_ATTR}]`).forEach((el) => {
        clearGlyph(el);
      });
    }
    const apply2 = () => {
      html.toggleAttribute("data-carrier-system-emoji", on2());
      if (on2()) {
        start();
        schedule();
      } else {
        stop();
      }
    };
    apply2();
    window.addEventListener("carrier:settings", apply2);
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", () => on2() && schedule(), { once: true });
  }

  // inject/src/messenger/lib/telemetry.ts
  var TELEMETRY_BLOCK_RE = new RegExp(
    [
      "^/ajax/bz(/|$)",
      // Banzai batch logging — the main telemetry firehose
      "^/a/bz(/|$)",
      // newer short Banzai alias
      "^/ajax/bnzai(/|$)",
      // legacy Banzai path
      "^/ajax/qm(\\.php)?(/|$)",
      // Quick Metrics performance beacons
      "^/common/scribe_endpoint(\\.php)?$",
      // legacy Scribe logging sink
      "^/security/hsts-pixel\\.gif$",
      // HSTS beacon
      "^/tr(/|$)",
      // Meta Pixel
      "^/ajax/error/"
      // browser JS-error reporting
    ].join("|")
  );
  function isBlockedTelemetryUrl(raw, base) {
    let u;
    try {
      u = new URL(raw, base);
    } catch (_) {
      return false;
    }
    if (!/(^|\.)(facebook\.com|messenger\.com)$/.test(u.hostname)) return false;
    if (u.hostname === "pixel.facebook.com") return true;
    return TELEMETRY_BLOCK_RE.test(u.pathname);
  }

  // inject/src/messenger/features/telemetry.ts
  function initTelemetryBlocking() {
    const on2 = () => window.__CARRIER_SETTINGS__?.block_telemetry === true;
    const shouldBlock = (raw) => on2() && isBlockedTelemetryUrl(raw, location.href);
    try {
      const origFetch = window.fetch;
      window.fetch = function(...args) {
        try {
          const input = args[0];
          const raw = typeof input === "string" ? input : input && input.url || String(input);
          if (raw && shouldBlock(raw)) return Promise.resolve(new Response(null, { status: 204 }));
        } catch (_) {
        }
        return origFetch.apply(this, args);
      };
    } catch (_) {
    }
    try {
      const proto = XMLHttpRequest.prototype;
      const origOpen = proto.open;
      const origSend = proto.send;
      proto.open = function(...args) {
        try {
          this.__carrierBlocked = shouldBlock(args[1]);
        } catch (_) {
          this.__carrierBlocked = false;
        }
        return origOpen.apply(this, args);
      };
      proto.send = function(...args) {
        if (this.__carrierBlocked && on2()) {
          setTimeout(() => {
            try {
              for (const [k, v] of [
                ["readyState", 4],
                ["status", 200],
                ["statusText", "OK"],
                ["responseText", ""],
                ["response", ""],
                ["responseURL", ""]
              ]) {
                Object.defineProperty(this, k, { value: v, configurable: true });
              }
              this.dispatchEvent(new Event("readystatechange"));
              this.dispatchEvent(new ProgressEvent("load"));
              this.dispatchEvent(new ProgressEvent("loadend"));
            } catch (_) {
            }
          }, 0);
          return;
        }
        return origSend.apply(this, args);
      };
    } catch (_) {
    }
    try {
      const origBeacon = Navigator.prototype.sendBeacon;
      Navigator.prototype.sendBeacon = function(...args) {
        try {
          if (shouldBlock(args[0])) return true;
        } catch (_) {
        }
        return origBeacon.apply(this, args);
      };
    } catch (_) {
    }
  }

  // inject/src/messenger/features/title-bar.ts
  var INSET_VAR = "--carrier-title-bar-inset";
  var KIND_ATTR = "data-carrier-title-bar";
  var STRIP_ID = "carrier-title-strip";
  var CONTROLS_ID = "carrier-window-controls";
  var state2 = null;
  function control(action2) {
    carrierWindowControl(action2)?.catch?.(
      () => diag("title-bar.control", "carrier:window-control emit failed")
    );
  }
  var ICONS = {
    minimize: '<path d="M2 6h8" />',
    maximize: '<rect x="2" y="2" width="8" height="8" rx="1" />',
    restore: '<rect x="2" y="4" width="6" height="6" rx="1" /><path d="M4.5 4V3a1 1 0 0 1 1-1H9a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H8" />',
    close: '<path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />'
  };
  function icon(name) {
    return `<svg viewBox="0 0 12 12" aria-hidden="true">${ICONS[name]}</svg>`;
  }
  function buildControls() {
    const box = document.createElement("div");
    box.id = CONTROLS_ID;
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Window");
    const button = (name, label2, action2) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.control = name;
      b.setAttribute("aria-label", label2);
      b.title = label2;
      b.addEventListener("click", () => control(action2));
      return b;
    };
    box.append(
      button("minimize", "Minimize", "minimize"),
      button("maximize", "Maximize", "toggle-maximize"),
      button("close", "Close", "close")
    );
    return box;
  }
  function buildStrip() {
    const strip = document.createElement("div");
    strip.id = STRIP_ID;
    strip.setAttribute("aria-hidden", "true");
    strip.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !state2?.controls) return;
      event.preventDefault();
      control(event.detail === 2 ? "toggle-maximize" : "drag");
    });
    return strip;
  }
  var stripObserver = null;
  var observedMain = null;
  function placeStrip() {
    const strip = document.getElementById(STRIP_ID);
    if (!strip) return;
    const main2 = document.querySelector('[role="main"]');
    const left = main2 ? Math.max(0, Math.round(main2.getBoundingClientRect().left)) : 0;
    strip.style.left = `${left}px`;
    if (main2 !== observedMain) {
      stripObserver?.disconnect();
      observedMain = main2;
      if (main2) {
        stripObserver ?? (stripObserver = new ResizeObserver(placeStrip));
        stripObserver.observe(main2);
      }
    }
  }
  function apply(next) {
    state2 = next;
    const root = document.documentElement;
    if (!root) return;
    root.style.setProperty(INSET_VAR, `${next.inset}px`);
    const kind = next.inset > 0 ? next.controls ?? "macos" : null;
    if (kind) root.setAttribute(KIND_ATTR, kind);
    else root.removeAttribute(KIND_ATTR);
    const drawn = next.controls && next.inset > 0;
    let controls = document.getElementById(CONTROLS_ID);
    let strip = document.getElementById(STRIP_ID);
    if (!drawn) {
      controls?.remove();
      strip?.remove();
      return;
    }
    if (!controls) controls = buildControls();
    if (!strip) strip = buildStrip();
    if (!controls.isConnected) root.append(strip, controls);
    const maximize = controls.querySelector('[data-control="maximize"]');
    const minimize = controls.querySelector('[data-control="minimize"]');
    const close = controls.querySelector('[data-control="close"]');
    if (minimize && !minimize.innerHTML) minimize.innerHTML = icon("minimize");
    if (close && !close.innerHTML) close.innerHTML = icon("close");
    if (maximize) {
      const name = next.maximized ? "restore" : "maximize";
      if (maximize.dataset.icon !== name) {
        maximize.dataset.icon = name;
        maximize.innerHTML = icon(name);
        const label2 = next.maximized ? "Restore" : "Maximize";
        maximize.setAttribute("aria-label", label2);
        maximize.title = label2;
      }
    }
    placeStrip();
  }
  function windowControlsInset() {
    return state2?.controls && state2.inset > 0 ? state2.inset : 0;
  }
  function initTitleBar() {
    const initial = window.__CARRIER_TITLE_BAR__;
    if (!initial) return;
    window.__carrierTitleBar = (next) => apply(next);
    const root = document.documentElement;
    if (root) {
      root.style.setProperty(INSET_VAR, `${initial.inset}px`);
      if (initial.inset > 0) root.setAttribute(KIND_ATTR, initial.controls ?? "macos");
    }
    const start = () => apply(state2 ?? initial);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else start();
    window.addEventListener("resize", placeStrip, { passive: true });
    setInterval(() => {
      if (document.hidden || !state2?.controls || state2.inset <= 0) return;
      if (!document.getElementById(STRIP_ID)?.isConnected) apply(state2);
      else if (document.querySelector('[role="main"]') !== observedMain) placeStrip();
    }, 1e3);
  }
  var viewerReported = null;
  function reportMediaViewer(open) {
    if (!/Mac/.test(navigator.platform) || !window.__CARRIER_TITLE_BAR__) return;
    if (open === viewerReported) return;
    viewerReported = open;
    carrierMediaViewer(open)?.catch?.(
      () => diag("title-bar.viewer", "carrier:media-viewer emit failed")
    );
  }

  // inject/src/messenger/lib/typing-block.ts
  /*! Includes code adapted from fMess (https://github.com/toanbku/fmess).
   *
   * MIT License
   *
   * Copyright (c) 2026 fMess contributors
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */
  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  function nested(object, key) {
    const value = object?.[key];
    const parsed = typeof value === "string" ? parseJson(value) : value;
    return parsed && typeof parsed === "object" ? parsed : null;
  }
  var TYPING_REQUEST = 4;
  var TYPING_LABEL = "3";
  var IS_TYPING = /(is_typing(?:\\)*":)1(?![0-9])/g;
  function clearTyping(text) {
    const request = parseJson(text);
    if (request?.type !== TYPING_REQUEST) return null;
    const update = nested(request, "payload");
    if (update?.label !== TYPING_LABEL || !nested(update, "payload")?.is_typing) return null;
    const edited = text.replace(IS_TYPING, "$10");
    return edited === text ? null : edited;
  }
  var PART_DATA = 13;
  var PART_CLOSE = 14;
  function clearTypingInFrame(bytes) {
    const parts = [];
    let edited = false;
    for (let pos = 0; pos < bytes.length; ) {
      if (bytes[pos] === PART_CLOSE) {
        parts.push(bytes.subarray(pos, pos + 3));
        pos += 3;
        continue;
      }
      if (pos + 6 > bytes.length) return null;
      const end = pos + 6 + ((bytes[pos + 3] ?? 0) | (bytes[pos + 4] ?? 0) << 8 | (bytes[pos + 5] ?? 0) << 16);
      if (end > bytes.length) return null;
      let part = bytes.subarray(pos, end);
      const json = bytes[pos] === PART_DATA && end > pos + 8 ? new TextDecoder().decode(bytes.subarray(pos + 8, end)) : null;
      const request = json && clearTyping(json);
      if (request) {
        const encoded = new TextEncoder().encode(request);
        const length = encoded.length + 2;
        part = new Uint8Array(8 + encoded.length);
        part.set(bytes.subarray(pos, pos + 3));
        part.set([length & 255, length >> 8 & 255, length >> 16], 3);
        part.set(bytes.subarray(pos + 6, pos + 8), 6);
        part.set(encoded, 8);
        edited = true;
      }
      parts.push(part);
      pos = end;
    }
    if (!edited) return null;
    const frame = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      frame.set(part, offset);
      offset += part.length;
    }
    return frame;
  }
  var CHAT_STATE = "sendChatStateFromComposer";
  var CHAT_IDLE = "idle";
  function idleChatStates(message) {
    if (!Array.isArray(message)) return null;
    const isTypingState = (item) => {
      const content = item?.content;
      return content?.name === CHAT_STATE && content.arg?.state !== CHAT_IDLE;
    };
    if (!message.some(isTypingState)) return null;
    return message.map((item) => {
      if (!isTypingState(item)) return item;
      const content = item.content ?? {};
      return {
        ...item,
        content: { ...content, arg: { ...content.arg, state: CHAT_IDLE } }
      };
    });
  }

  // inject/src/messenger/features/typing-block.ts
  var on = () => window.__CARRIER_SETTINGS__?.block_typing_indicator === true;
  function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data))
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }
  function initTypingBlock() {
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (on() && String(this.url).includes("/ws/lightspeed")) {
        const bytes = bytesOf(data);
        const edited = bytes && clearTypingInFrame(bytes);
        if (edited) {
          diag("privacy.typing-blocked", "socket");
          return nativeSend.call(this, edited);
        }
      }
      return nativeSend.call(this, data);
    };
    const nativePostMessage = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message, ...rest) {
      const edited = on() ? idleChatStates(message) : null;
      if (edited) diag("privacy.typing-blocked", "worker");
      return Reflect.apply(nativePostMessage, this, [edited ?? message, ...rest]);
    };
  }

  // inject/src/messenger/lib/thread-state.ts
  function muteIsActive(raw, now, i64ToString) {
    let value;
    try {
      if (typeof raw === "bigint") value = raw;
      else if (typeof raw === "number" && Number.isFinite(raw)) value = BigInt(Math.trunc(raw));
      else if (typeof raw === "string" && /^-?\d+$/.test(raw)) value = BigInt(raw);
      else if (raw != null && i64ToString) {
        const text = i64ToString(raw);
        if (typeof text !== "string" || !/^-?\d+$/.test(text)) return null;
        value = BigInt(text);
      } else return null;
    } catch {
      return null;
    }
    return value === -1n || value > BigInt(Math.floor(now));
  }
  function readThreadStates(ids, load, now, timeoutMs = 750) {
    return readMessengerDatabase(
      load,
      async ({ db, i64, load: load2 }) => {
        const { isThreadUnreadForViewer } = load2("MWPIsThreadUnread");
        if (typeof isThreadUnreadForViewer !== "function") {
          throw new Error("Messenger thread APIs changed");
        }
        const states = /* @__PURE__ */ new Map();
        for (const id of ids) {
          if (!/^\d+$/.test(id)) continue;
          const thread2 = await db.tables.threads.get(i64.of_string(id));
          if (!thread2 || typeof thread2 !== "object") continue;
          const unread = isThreadUnreadForViewer(thread2);
          const muted = muteIsActive(
            thread2.muteExpireTimeMs,
            now,
            i64.to_string?.bind(i64)
          );
          if (typeof unread !== "boolean" || muted === null) continue;
          states.set(id, { unread, muted });
        }
        return states;
      },
      timeoutMs
    );
  }

  // inject/src/messenger/features/unread-badge.ts
  function initUnreadBadge() {
    if (!window.__TAURI_INTERNALS__) return;
    const unreadStorage = pageReloadSafeStorage();
    const accountStorageKey = mutedUnreadStorageKey(document.cookie);
    const listReadiness = new UnreadListReadiness();
    const THREAD_STATE_LIMIT = 500;
    const threadStates = /* @__PURE__ */ new Map();
    let refreshingStates = false;
    let statesFailing = false;
    let stateEpoch = 0;
    const MUTE_ACTION_HOLD_MS = 5e3;
    const muteActions = /* @__PURE__ */ new Map();
    const heldMute = (id, muted) => {
      const action2 = muteActions.get(id);
      if (!action2) return muted;
      if (Date.now() - action2.at < MUTE_ACTION_HOLD_MS) return action2.muted;
      muteActions.delete(id);
      return muted;
    };
    const refreshThreadStates = (ids) => {
      if (refreshingStates || !ids.length) return;
      refreshingStates = true;
      const epoch2 = stateEpoch;
      readThreadStates(ids, window.require, Date.now()).then((states) => {
        if (epoch2 !== stateEpoch) return;
        if (states === null) {
          if (!statesFailing) diag("badge.thread-state", "Messenger database unavailable");
          statesFailing = true;
        } else statesFailing = false;
        let changed = false;
        for (const id of ids) {
          const read = states?.get(id);
          const state3 = read && { ...read, muted: heldMute(id, read.muted) };
          const old = threadStates.get(id);
          if (!state3) {
            if (threadStates.delete(id)) changed = true;
            continue;
          }
          if (old?.unread !== state3.unread || old?.muted !== state3.muted) changed = true;
          threadStates.delete(id);
          threadStates.set(id, state3);
          if (threadStates.size > THREAD_STATE_LIMIT) {
            threadStates.delete(threadStates.keys().next().value);
          }
        }
        if (changed) apply2(true);
      }).finally(() => {
        refreshingStates = false;
      });
    };
    const unreadConversationState = () => {
      const ignoreMuted = badgeIgnoresMutedConversations(window.__CARRIER_SETTINGS__);
      const openId = threadIdFromHref(location.pathname);
      if (openId) {
        observeOpenThreadMute(openId, [
          ...document.querySelectorAll('[role="main"]'),
          ...document.querySelectorAll('[role="complementary"], [role="dialog"]')
        ]);
      }
      const links = chatRows();
      const listedIds = [];
      const seen = /* @__PURE__ */ new Set();
      let count = 0;
      const rowObservations = [];
      for (const a of links) {
        const id = threadIdFromHref(a.getAttribute("href"));
        if (!id || seen.has(id)) continue;
        seen.add(id);
        listedIds.push(id);
        const known = threadStates.get(id);
        const row = a.closest('[role="row"]') || a;
        const spans = [...row.querySelectorAll("span")];
        let unread = known?.unread ?? false;
        for (const span of known ? [] : spans) {
          if (isUnreadConversationText(getComputedStyle(span).fontWeight, conversationNodeText(span))) {
            unread = true;
            break;
          }
        }
        const candidates = spans.map((span) => {
          const rect = span.getBoundingClientRect();
          return {
            node: span,
            text: conversationNodeText(span),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            ariaHidden: span.getAttribute("aria-hidden") === "true",
            inAbbreviation: !!span.closest("abbr"),
            hasTextChild: hasCandidateTextChild(span)
          };
        });
        const hydrated = conversationTextParts(candidates).body.length > 0;
        const hasTitle = candidates.some(
          (candidate) => !candidate.ariaHidden && !candidate.inAbbreviation && !candidate.hasTextChild && candidate.width > 1 && candidate.height > 1 && candidate.text.trim().length > 0
        );
        const muted = known ? observeDatabaseMute(id, known.muted) : observeConversationMute(id, row);
        rowObservations.push({ id, unread, muted, hydrated, hasTitle });
        if (!unread) continue;
        if (ignoreMuted && muted) continue;
        count++;
      }
      let scrolledFromTop = false;
      const first = links[0];
      for (let el = first?.parentElement; el && el !== document.body; el = el.parentElement) {
        if (el.scrollHeight <= el.clientHeight + 16) continue;
        scrolledFromTop = el.scrollTop > 8;
        break;
      }
      refreshThreadStates(listedIds);
      const listHydrated = rowObservations.length > 0 && rowObservations.every(({ hydrated }) => hydrated === true);
      const ready2 = listReadiness.observe(rowObservations);
      return {
        count,
        // Settled title-only rows can drive the badge, but keep the stricter
        // preview requirement before retiring persisted muted-unread evidence.
        muteObservations: rowObservations.map((observation) => ({
          ...observation,
          hydrated: listHydrated
        })),
        ready: ready2,
        trustworthy: ready2 && !scrolledFromTop
      };
    };
    let last = null;
    let lastDockError = false;
    const isMac4 = /mac/i.test(navigator.platform);
    let filteredUnreadBaseline = null;
    const knownMutedUnreads = new MutedUnreadStore(
      accountStorageKey ? unreadStorage : null,
      accountStorageKey || "__carrier_muted_unreads_anonymous__"
    );
    let ignoreMutedPolicy = null;
    const setBadge = (n, force) => {
      const dockError = isMac4 && rateLimitRemainingMs() > 0;
      if (n === last && dockError === lastDockError && !force) return;
      last = n;
      lastDockError = dockError;
      const dot = window.__CARRIER_SETTINGS__?.badge_mode === "dot";
      const command = isMac4 ? "plugin:window|set_badge_label" : "plugin:window|set_badge_count";
      const value = isMac4 ? dockError ? "ERR" : n > 0 ? dot ? "•" : String(n) : null : n > 0 && !dot ? n : null;
      invoke(command, { value })?.catch?.(() => diag("badge.set", "badge update failed"));
      invoke("plugin:event|emit", { event: "carrier:unread", payload: n })?.catch?.(
        () => diag("badge.emit", "carrier:unread emit failed")
      );
    };
    const apply2 = (force) => {
      const s = window.__CARRIER_SETTINGS__ || {};
      const ignoreMuted = badgeIgnoresMutedConversations(s);
      if (didMutedFilterPolicyChange(ignoreMutedPolicy, ignoreMuted)) {
        filteredUnreadBaseline = null;
      }
      ignoreMutedPolicy = ignoreMuted;
      const conversations = unreadConversationState();
      knownMutedUnreads.reconcile(conversations.muteObservations);
      if (s.unread_badge === false) {
        setBadge(0, force);
        return;
      }
      const titleCount = unreadCountFromTitle(document.title || "");
      if (ignoreMuted && conversations.trustworthy) {
        filteredUnreadBaseline = conversations.count;
      }
      const conv = s.badge_mode === "conversations";
      const n = conv ? reconcileUnreadConversationCount(
        conversations.count,
        conversations.trustworthy,
        ignoreMuted,
        filteredUnreadBaseline
      ) : reconcileUnreadMessageCount(
        titleCount,
        conversations.count,
        conversations.trustworthy,
        ignoreMuted && knownMutedUnreads.size > 0,
        filteredUnreadBaseline
      );
      const ready2 = conv ? conversations.ready : document.readyState === "complete" && (document.title || "").trim().length > 0;
      if (n === null || n === 0 && !ready2) {
        if (isMac4 && rateLimitRemainingMs() > 0) setBadge(last ?? 0, force);
        return;
      }
      setBadge(n, force);
    };
    window.addEventListener("carrier:thread-mute", (event) => {
      const detail = event.detail;
      if (typeof detail?.muted !== "boolean" || typeof detail.id !== "string") return;
      if (!detail.muted) knownMutedUnreads.invalidate(detail.id);
      stateEpoch++;
      muteActions.set(detail.id, { muted: detail.muted, at: Date.now() });
      if (muteActions.size > THREAD_STATE_LIMIT) {
        muteActions.delete(muteActions.keys().next().value);
      }
      const cached = threadStates.get(detail.id);
      if (cached) threadStates.set(detail.id, { ...cached, muted: detail.muted });
      setTimeout(() => apply2(true), 500);
    });
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        apply2(false);
        setTimeout(() => apply2(false), 800);
      }, 120);
    };
    const headObserver = new MutationObserver(schedule);
    const observeHead = () => {
      if (!document.head) return false;
      headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
      return true;
    };
    if (!observeHead()) {
      const waitForHead = new MutationObserver(() => {
        if (observeHead()) waitForHead.disconnect();
      });
      waitForHead.observe(document.documentElement, { childList: true, subtree: true });
    }
    window.addEventListener(RATE_LIMIT_EVENT, () => apply2(true));
    window.addEventListener("carrier:settings", () => apply2(true));
    let pollTimer;
    const startPoll = () => {
      clearInterval(pollTimer);
      pollTimer = setInterval(() => apply2(false), document.hidden ? 6e4 : 5e3);
    };
    document.addEventListener("visibilitychange", () => {
      startPoll();
      if (!document.hidden) apply2(false);
    });
    startPoll();
    apply2(true);
    setTimeout(() => apply2(true), 1500);
    setTimeout(() => apply2(true), 4e3);
  }

  // inject/src/messenger/lib/media-viewer.ts
  var MEDIA_VIEWER_ATTR = "data-carrier-media-viewer";
  var DIALOG = '[role="dialog"]';
  var HIDDEN = '[hidden], [aria-hidden="true"], [inert]';
  function isMediaViewerShape(shape) {
    if (shape.excluded || !shape.overlay || !shape.hasMedia) return false;
    if (!shape.hasDownload && !shape.hasVideoControls) return false;
    return coversViewport(shape.rect, shape.viewport);
  }
  function coversViewport(rect, viewport) {
    const visible = intersectImageClips(rect, viewport);
    const width2 = viewport.right - viewport.left;
    const height = viewport.bottom - viewport.top;
    return width2 > 0 && height > 0 && visible.right - visible.left >= width2 * 0.75 && visible.bottom - visible.top >= height * 0.7;
  }
  function isVisible(element2) {
    if (element2.closest(HIDDEN)) return false;
    const style = getComputedStyle(element2);
    const rect = element2.getBoundingClientRect();
    return style.visibility === "visible" && rect.width > 0 && rect.height > 0;
  }
  function isMediaViewerDialog(dialog) {
    if (!isVisible(dialog)) return false;
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const rect = dialog.getBoundingClientRect();
    if (!coversViewport(rect, viewport)) return false;
    let overlay = dialog.getAttribute("aria-modal") === "true";
    let excluded = !!dialog.closest("[data-carrier-shortcuts-overlay]");
    for (let ancestor = dialog; ancestor; ancestor = ancestor.parentElement) {
      const position = getComputedStyle(ancestor).position;
      if (position === "fixed" || position === "absolute") overlay = true;
    }
    const owns = (element2) => element2.closest(DIALOG) === dialog;
    excluded || (excluded = [...dialog.querySelectorAll('[role="navigation"], [contenteditable="true"]')].some(
      owns
    ));
    if (excluded || !overlay) return false;
    const media = [
      ...dialog.querySelectorAll("img, video")
    ].filter((element2) => {
      if (!owns(element2) || !isVisible(element2)) return false;
      const bounds = element2.getBoundingClientRect();
      const visible = intersectImageClips(intersectImageClips(bounds, rect), viewport);
      const width2 = (visible.right - visible.left) / Math.min(rect.width, viewport.right);
      const height = (visible.bottom - visible.top) / Math.min(rect.height, viewport.bottom);
      return width2 > 0 && height > 0 && (width2 >= 0.15 && height >= 0.15 || width2 >= 0.5 || height >= 0.5);
    });
    return isMediaViewerShape({
      rect,
      viewport,
      overlay,
      excluded,
      hasMedia: media.length > 0,
      hasDownload: [...dialog.querySelectorAll("a[download]")].some(
        (element2) => owns(element2) && isVisible(element2)
      ),
      hasVideoControls: media.some(
        (element2) => element2 instanceof HTMLVideoElement && element2.controls
      )
    });
  }

  // inject/src/messenger/lib/viewer-controls.ts
  var SAFE_TOP = 8;
  var MAX_OFFSET = 64;
  function viewerControlOffset(controlTops, appliedOffset = 0, reserved = 0) {
    const naturalTops = controlTops.filter(Number.isFinite).map((top) => top - (Number.isFinite(appliedOffset) ? appliedOffset : 0));
    if (!naturalTops.length) return 0;
    return Math.min(
      MAX_OFFSET + Math.max(0, reserved),
      Math.max(0, Math.ceil(SAFE_TOP + reserved - Math.min(...naturalTops)))
    );
  }

  // inject/src/messenger/features/viewer-controls.ts
  var DIALOG2 = '[role="dialog"]';
  var BANNER = 'div[role="banner"]';
  var CONTROL = 'a[href], button, [role="button"]';
  var BANNER_ATTR = "data-carrier-media-controls";
  var ACTIONS_ATTR = "data-carrier-media-actions";
  var OFFSET = "--carrier-media-controls-offset";
  var visibleControls = (root) => [...root.querySelectorAll(CONTROL)].map((control2) => control2.getBoundingClientRect()).filter(
    (rect) => rect.width >= 16 && rect.height >= 16 && rect.bottom > 0 && // Controls sit near the top; Carrier's strip (and the offset clearing
    // it) can move them further down, so the band grows with it.
    rect.top < 96 + windowControlsInset() && rect.right > 0 && rect.left < window.innerWidth
  );
  var applyOffset = (element2, controlTops, attr) => {
    const currentOffset = Number.parseFloat(element2.style.getPropertyValue(OFFSET)) || 0;
    const offset = viewerControlOffset(controlTops, currentOffset, windowControlsInset());
    if (!offset) return false;
    if (!element2.hasAttribute(attr)) element2.setAttribute(attr, "");
    const value = `${offset}px`;
    if (element2.style.getPropertyValue(OFFSET) !== value) {
      element2.style.setProperty(OFFSET, value);
    }
    return true;
  };
  var actionGroupFor = (download, dialog) => {
    let candidate = download;
    for (let parent = download.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
      const rect = parent.getBoundingClientRect();
      const controls = visibleControls(parent);
      if (controls.length >= 2 && rect.width <= 240 && rect.height <= 96) return parent;
      if (rect.width <= 240 && rect.height <= 96) candidate = parent;
    }
    return candidate;
  };
  function initViewerControls() {
    let frame = 0;
    let viewers = /* @__PURE__ */ new Set();
    let markedControls = /* @__PURE__ */ new Set();
    let observedDialogs = /* @__PURE__ */ new Set();
    const refresh = () => {
      frame = 0;
      const dialogs = new Set(document.querySelectorAll(DIALOG2));
      for (const dialog of observedDialogs) {
        if (!dialogs.has(dialog)) resizeObserver.unobserve(dialog);
      }
      for (const dialog of dialogs) {
        if (!observedDialogs.has(dialog)) resizeObserver.observe(dialog);
      }
      observedDialogs = dialogs;
      const nextViewers = new Set([...dialogs].filter(isMediaViewerDialog));
      for (const dialog of viewers) {
        if (!nextViewers.has(dialog)) dialog.removeAttribute(MEDIA_VIEWER_ATTR);
      }
      for (const dialog of nextViewers) {
        if (!dialog.hasAttribute(MEDIA_VIEWER_ATTR)) dialog.setAttribute(MEDIA_VIEWER_ATTR, "");
      }
      viewers = nextViewers;
      reportMediaViewer(viewers.size > 0);
      const previouslyMarked = markedControls;
      markedControls = /* @__PURE__ */ new Set();
      if (viewers.size) {
        for (const banner of document.querySelectorAll(BANNER)) {
          if (applyOffset(
            banner,
            visibleControls(banner).map((rect) => rect.top),
            BANNER_ATTR
          )) {
            markedControls.add(banner);
          }
        }
        for (const dialog of viewers) {
          for (const download of dialog.querySelectorAll("a[download]")) {
            if (download.closest(DIALOG2) !== dialog) continue;
            const group = actionGroupFor(download, dialog);
            if (applyOffset(
              group,
              visibleControls(group).map((rect) => rect.top),
              ACTIONS_ATTR
            )) {
              markedControls.add(group);
            }
          }
        }
      }
      for (const element2 of previouslyMarked) {
        if (markedControls.has(element2)) continue;
        element2.removeAttribute(BANNER_ATTR);
        element2.removeAttribute(ACTIONS_ATTR);
        element2.style.removeProperty(OFFSET);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(refresh);
    };
    const resizeObserver = new ResizeObserver(schedule);
    const affectsControls = (element2) => !!element2.closest(`${DIALOG2}, ${BANNER}`) || [...observedDialogs, ...markedControls].some((control2) => element2.contains(control2));
    new MutationObserver((records) => {
      if (records.some(
        (record4) => record4.target instanceof Element && affectsControls(record4.target) || record4.type === "childList" && [...record4.addedNodes, ...record4.removedNodes].some(
          (node) => node instanceof Element && (affectsControls(node) || node.querySelector(`${DIALOG2}, ${BANNER}`))
        )
      ))
        schedule();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "hidden",
        "aria-hidden",
        "inert",
        "role",
        "aria-modal",
        "class",
        "style",
        "download",
        "controls"
      ]
    });
    const mediaLoaded = (event) => {
      if (event.target instanceof Element && event.target.closest(DIALOG2)) schedule();
    };
    document.addEventListener("load", mediaLoaded, true);
    document.addEventListener("loadedmetadata", mediaLoaded, true);
    window.addEventListener("resize", schedule, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) schedule();
    });
    schedule();
  }

  // inject/src/messenger/index.ts
  function initFeature(name, init) {
    try {
      init();
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      diag(`init.${name}`, detail.slice(0, 500));
    }
  }
  function main() {
    initFeature("rate-limit", initRateLimit);
    initFeature("title-bar", initTitleBar);
    initFeature("facebook-workers", initFacebookWorkerOptimization);
    initFeature("facebook-modules", initFacebookModuleInterception);
    initFeature("typing-block", initTypingBlock);
    initFeature("emoji-images", initEmojiImageLoading);
    initFeature("composer-keys", initComposerKeys);
    initFeature("image-paste", initImagePaste);
    initFeature("composer-focus", initComposerFocus);
    initFeature("selection", initSelection);
    initFeature("shortcuts", initShortcuts);
    initFeature("zoom", initZoom);
    initFeature("selector-health", initSelectorHealth);
    initFeature("settings-button", initSettingsButton);
    initFeature("function-keys", initFunctionKeys);
    initFeature("shortcut-registry", initShortcutRegistry);
    initFeature("link-handling", initLinkHandling);
    initFeature("context-menu", initContextMenu);
    initFeature("download-anchors", initDownloadAnchors);
    initFeature("spellcheck", initSpellcheck);
    initFeature("telemetry", initTelemetryBlocking);
    initFeature("media-autoplay", initMediaAutoplay);
    initFeature("mute-action-tracking", initMuteActionTracking);
    initFeature("messenger-dnd", initMessengerDnd);
    initFeature("account-requests", initAccountRequests);
    initFeature("notifications", initNotificationBridge);
    initFeature("share-intake", initShareIntake);
    initFeature("sync-health", initSyncHealth);
    initFeature("auto-refresh", initAutoRefresh);
    initFeature("force-theme", initForceTheme);
    initFeature("theme-markers", initThemeMarkers);
    initFeature("scrollbars", initScrollbars);
    initFeature("chat-gradient", initChatGradient);
    initFeature("unread-badge", initUnreadBadge);
    initFeature("recent-threads", initRecentThreads);
    initFeature("thread-nav", initThreadNav);
    initFeature("conversation-export", initConversationExport);
    initFeature("quick-reply", initQuickReply);
    initFeature("quick-mute", initQuickMute);
    initFeature("read-ahead", initReadAhead);
    initFeature("notification-actions", initNotificationActions);
    initFeature("scheduled-send", initScheduledSend);
    initFeature("hide-names", initHideNames);
    initFeature("pane-resize", initPaneResize);
    initFeature("system-emoji", initSystemEmoji);
    initFeature("media-permissions", initMediaPermissionWarning);
    initFeature("linux-call-notice", initLinuxCallNotice);
    initFeature("cookie-consent", initCookieAutoDecline);
    initFeature("login-tidy", initLoginTidy);
    initFeature("media-viewer", initMediaViewer);
    initFeature("viewer-controls", initViewerControls);
    initFeature("fullscreen", initFullscreenPolyfill);
  }
  if (window.top === window.self) main();
})();
