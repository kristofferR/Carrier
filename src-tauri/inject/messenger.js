/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/messenger/ (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // inject/src/messenger/bridge.ts
  var invoke = (cmd, args) => window.__TAURI_INTERNALS__?.invoke(cmd, args);
  var toast = (msg) => window.__carrierToast ? window.__carrierToast(msg) : console.log("[carrier]", msg);
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
  var openUrl = (url) => invoke("plugin:opener|open_url", { url, with: null })?.catch?.(
    () => diag("ipc.open-url", "opener invoke failed")
  );

  // inject/src/messenger/features/auto-refresh.ts
  function initAutoRefresh() {
    const PERIODIC_MS = 15 * 60 * 1e3;
    const NOTIF_GAP_MS = 5 * 60 * 1e3;
    let lastFresh = Date.now();
    let pending = false;
    let timer;
    const clearPending = () => {
      pending = false;
      clearTimeout(timer);
      timer = void 0;
      lastFresh = Date.now();
    };
    const composerHasText = () => {
      try {
        for (const el of document.querySelectorAll('[contenteditable="true"]')) {
          if ((el.textContent || "").trim().length > 0) return true;
        }
      } catch (_) {
      }
      return false;
    };
    const pageIsActive = () => !document.hidden || document.hasFocus();
    const maybeReload = () => {
      timer = void 0;
      if (!pending) return;
      if (pageIsActive()) {
        clearPending();
        return;
      }
      if (composerHasText() || window.__carrierInCall) {
        timer = setTimeout(maybeReload, 8e3);
        return;
      }
      pending = false;
      lastFresh = Date.now();
      location.reload();
    };
    const schedule = (delay) => {
      if (pageIsActive()) {
        lastFresh = Date.now();
        return;
      }
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(maybeReload, delay);
    };
    window.addEventListener("focus", clearPending);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) clearPending();
    });
    window.__carrierOnNotification = () => {
      if (!pageIsActive() && Date.now() - lastFresh >= NOTIF_GAP_MS) schedule(4e3);
    };
    setInterval(() => {
      if (pageIsActive()) {
        lastFresh = Date.now();
        return;
      }
      if (Date.now() - lastFresh >= PERIODIC_MS) schedule(2e3);
    }, 60 * 1e3);
  }

  // inject/src/messenger/lib/composer-keys.ts
  function shouldKeepEnterInComposer(state) {
    if (state.key !== "Enter") return false;
    if (state.isComposing || state.compositionActive || state.keyCode === 229) return true;
    return state.requireAccelerator && !state.acceleratorPressed && !state.shiftKey;
  }

  // inject/src/messenger/features/composer-keys.ts
  var isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  var composerSelector = '[contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"], textarea';
  function isComposerTarget(target) {
    if (!(target instanceof Element)) return false;
    const editor = target.closest(composerSelector);
    return !!editor?.closest('[role="main"]');
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
  }

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

  // inject/src/messenger/features/context-menu.ts
  var MAX_BLOB = 512 * 1024 * 1024;
  var oversizeByHeader = (res) => Number(res.headers.get("content-length")) > MAX_BLOB;
  var copyAddress = (text) => navigator.clipboard?.writeText(text).then(() => toast("Address copied")).catch(() => toast("Copy failed"));
  async function downloadSrc(src, fallbackName) {
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
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1e4);
  }
  async function copyImageSrc(src) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    if (oversizeByHeader(res)) throw new Error("image too large");
    const blob = await res.blob();
    if (blob.size > MAX_BLOB) throw new Error("image too large");
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  }
  var ctxMenu = null;
  var ctxMenuReturnFocus = null;
  var closeMenuFromPointer = () => closeMenu();
  var closeMenu = (restoreFocus = false) => {
    ctxMenu?.remove();
    ctxMenu = null;
    document.removeEventListener("click", closeMenuFromPointer, true);
    document.removeEventListener("scroll", closeMenuFromPointer, true);
    if (restoreFocus) ctxMenuReturnFocus?.focus({ preventScroll: true });
    ctxMenuReturnFocus = null;
  };
  function initContextMenu() {
    document.addEventListener(
      "contextmenu",
      (e) => {
        const t = e.target;
        const video = t.closest?.("video") || (t.closest?.("div")?.querySelector?.("video") ?? null);
        const img = t.closest?.("img[alt]");
        const anchor = t.closest?.("a[href]");
        const imgSrc = img && (img.currentSrc || img.src);
        const vidSrc = video && (video.currentSrc || video.src);
        const linkHref = anchor?.href;
        const items = [];
        if (imgSrc) {
          items.push([
            "Copy image",
            () => copyImageSrc(imgSrc).then(() => toast("Image copied")).catch(() => toast("Copy failed"))
          ]);
          items.push([
            "Download image",
            () => downloadSrc(imgSrc, "image").then(() => toast("Saved to Downloads")).catch(() => toast("Download failed"))
          ]);
          items.push(["Copy image address", () => copyAddress(imgSrc)]);
          items.push(["Open image in browser", () => openUrl(imgSrc)]);
        } else if (vidSrc) {
          items.push([
            "Download video",
            () => downloadSrc(vidSrc, "video").then(() => toast("Saved to Downloads")).catch(() => toast("Download failed"))
          ]);
          items.push(["Copy video address", () => copyAddress(vidSrc)]);
        } else if (linkHref && !linkHref.startsWith("javascript:")) {
          items.push(["Copy link address", () => copyAddress(linkHref)]);
          items.push(["Open link in browser", () => openUrl(linkHref)]);
        }
        if (!items.length) return;
        e.preventDefault();
        const focusableSelector = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
        const previouslyFocused = document.activeElement;
        const priorReturnFocus = ctxMenu?.contains(previouslyFocused) ? ctxMenuReturnFocus : previouslyFocused instanceof HTMLElement && previouslyFocused !== document.body ? previouslyFocused : null;
        closeMenu();
        ctxMenuReturnFocus = t.closest?.(focusableSelector) ?? priorReturnFocus;
        ctxMenu = document.createElement("div");
        ctxMenu.setAttribute("role", "menu");
        ctxMenu.setAttribute("aria-label", "Media actions");
        Object.assign(ctxMenu.style, {
          position: "fixed",
          left: `${e.clientX}px`,
          top: `${e.clientY}px`,
          zIndex: 2147483647,
          background: "var(--card-background, Canvas)",
          color: "var(--primary-text, CanvasText)",
          border: "1px solid var(--divider, rgba(127,127,127,.3))",
          borderRadius: "8px",
          padding: "4px",
          boxShadow: "0 6px 24px rgba(0,0,0,.4)",
          minWidth: "170px",
          font: "13px -apple-system, system-ui, sans-serif"
        });
        for (const [label, fn] of items) {
          const el = document.createElement("div");
          el.textContent = label;
          el.setAttribute("role", "menuitem");
          el.tabIndex = -1;
          Object.assign(el.style, {
            padding: "8px 12px",
            cursor: "pointer",
            borderRadius: "6px",
            outline: "none"
          });
          el.onmouseenter = () => el.style.background = "var(--hover-overlay, rgba(127,127,127,.18))";
          el.onmouseleave = () => el.style.background = "";
          el.onfocus = () => el.style.background = "var(--hover-overlay, rgba(127,127,127,.18))";
          el.onblur = () => el.style.background = "";
          el.onclick = (ev) => {
            ev.stopPropagation();
            closeMenu();
            fn();
          };
          ctxMenu.appendChild(el);
        }
        document.body.appendChild(ctxMenu);
        const r = ctxMenu.getBoundingClientRect();
        if (r.right > innerWidth) ctxMenu.style.left = `${innerWidth - r.width - 8}px`;
        if (r.bottom > innerHeight) ctxMenu.style.top = `${innerHeight - r.height - 8}px`;
        const menuItems = [...ctxMenu.querySelectorAll('[role="menuitem"]')];
        ctxMenu.addEventListener("keydown", (event) => {
          const current = Math.max(0, menuItems.indexOf(document.activeElement));
          let next = null;
          if (event.key === "ArrowDown") next = (current + 1) % menuItems.length;
          if (event.key === "ArrowUp") next = (current - 1 + menuItems.length) % menuItems.length;
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = menuItems.length - 1;
          if (event.key === "Escape") {
            event.preventDefault();
            closeMenu(true);
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            closeMenu(true);
            return;
          }
          if ((event.key === "Enter" || event.key === " ") && document.activeElement) {
            event.preventDefault();
            document.activeElement.click();
            return;
          }
          if (next !== null) {
            event.preventDefault();
            menuItems[next]?.focus();
          }
        });
        menuItems[0]?.focus({ preventScroll: true });
        setTimeout(() => {
          document.addEventListener("click", closeMenuFromPointer, true);
          document.addEventListener("scroll", closeMenuFromPointer, true);
        }, 0);
      },
      true
    );
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
    return scores.length >= 2 && (Math.max(...scores) > 40 || scores.length === 2);
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
  var primaryBlueScore = (el) => {
    let best = 0;
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const c = rgb(getComputedStyle(cur).backgroundColor);
      if (!c || c.a < 0.35) continue;
      best = Math.max(best, c.b - Math.max(c.r, c.g) + Math.max(0, c.b - 120));
      if (c.a > 0.9) break;
    }
    return best;
  };
  var actionButtonsIn = (root) => {
    const selector = 'button, [role="button"]';
    const buttons = [];
    if (root.matches?.(selector)) buttons.push(root);
    buttons.push(...root.querySelectorAll?.(selector) || []);
    return buttons.filter((button) => {
      if (button.closest('[aria-hidden="true"]')) return false;
      const r = visibleBox(button);
      if (!r || r.width < 90 || r.height < 28) return false;
      if (button.disabled || button.getAttribute("aria-disabled") === "true")
        return false;
      if (button.hasAttribute("aria-expanded")) return false;
      if (button.getAttribute("aria-haspopup")) return false;
      return true;
    });
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
    const roots = [...queuedSweepRoots];
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
        a.removeAttribute("target");
        e.preventDefault();
        e.stopImmediatePropagation();
        downloadSrc(href, a.getAttribute("download") || "download").then(() => toast("Saved to Downloads")).catch(() => toast("Download failed"));
      },
      true
    );
  }

  // inject/src/messenger/features/force-theme.ts
  function initForceTheme() {
    const html = document.documentElement;
    let forcedClass = null;
    const apply = () => {
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
    apply();
    window.addEventListener("carrier:settings", apply);
    new MutationObserver(apply).observe(html, { attributes: true, attributeFilter: ["class"] });
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

  // inject/src/messenger/features/hide-names.ts
  var IDENTITY_ATTR = "data-carrier-private-identity";
  var THREAD_ROW_SEL = '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]';
  var TEXT_SURFACE_SEL = "span, div, h1, h2, h3, h4";
  var VISUAL_SEL = 'img, svg, image, [style*="background-image"]';
  function initHideNames() {
    const html = document.documentElement;
    let observer = null;
    let pending = false;
    let suppressMutations = false;
    const on = () => window.__CARRIER_SETTINGS__?.hide_names_avatars === true;
    function textValue(el) {
      return (el?.textContent || "").replace(/\s+/g, " ").trim();
    }
    function normalizedRect(el) {
      const rect = el.getBoundingClientRect();
      const configuredZoom = Number(window.__CARRIER_SETTINGS__?.zoom) || 100;
      const scale = Math.min(2, Math.max(0.3, configuredZoom / 100));
      return new DOMRect(rect.x / scale, rect.y / scale, rect.width / scale, rect.height / scale);
    }
    function visible(el) {
      const r = el ? normalizedRect(el) : null;
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    }
    function mark(el) {
      if (el?.setAttribute) el.setAttribute(IDENTITY_ATTR, "");
    }
    function clearMarkers() {
      document.querySelectorAll(`[${IDENTITY_ATTR}]`).forEach((el) => {
        el.removeAttribute(IDENTITY_ATTR);
      });
    }
    function textLeaves(root) {
      const out = [];
      root.querySelectorAll?.(TEXT_SURFACE_SEL).forEach((el) => {
        if (!visible(el) || el.closest?.('[contenteditable="true"]')) return;
        if (!textValue(el)) return;
        for (const child of el.children || []) {
          if (textValue(child)) return;
        }
        out.push(el);
      });
      return out.sort((a, b) => {
        const ar = normalizedRect(a);
        const br = normalizedRect(b);
        return ar.y - br.y || ar.x - br.x;
      });
    }
    function textSurfaces(root) {
      const out = [];
      root.querySelectorAll?.(TEXT_SURFACE_SEL).forEach((el) => {
        if (!visible(el) || el.closest?.('[contenteditable="true"]')) return;
        if (!textValue(el)) return;
        out.push(el);
      });
      return out.sort((a, b) => {
        const ar = normalizedRect(a);
        const br = normalizedRect(b);
        return ar.y - br.y || ar.x - br.x || ar.height - br.height;
      });
    }
    function area(el) {
      const r = normalizedRect(el);
      return r.width * r.height;
    }
    function deepest(elements) {
      return elements.filter((el) => !elements.some((other) => other !== el && el.contains(other)));
    }
    function markDeepest(elements) {
      let count = 0;
      deepest(elements).sort((a, b) => {
        const ar = normalizedRect(a);
        const br = normalizedRect(b);
        return ar.x - br.x || area(a) - area(b);
      }).forEach((el) => {
        if (isMetaText(textValue(el))) return;
        mark(el);
        count += 1;
      });
      return count > 0;
    }
    function markPreviewSenderPrefix(el) {
      const value = textValue(el);
      const identity = previewIdentity(value);
      if (!identity) return false;
      const candidates = [el, ...textSurfaces(el)].filter((candidate, index, all) => all.indexOf(candidate) === index).filter((candidate) => {
        const candidateText = textValue(candidate);
        if (!candidateText) return false;
        if (candidateText === identity.prefix) return true;
        if (identity.colon && candidateText === `${identity.prefix}:`) return true;
        return false;
      }).sort((a, b) => area(a) - area(b));
      if (candidates.length) {
        mark(candidates[0]);
        return true;
      }
      mark(el);
      return true;
    }
    function markConversationRows() {
      const seen = /* @__PURE__ */ new Set();
      for (const row of document.querySelectorAll(THREAD_ROW_SEL)) {
        const href = row.getAttribute("href") || "";
        if (!href || seen.has(href) || !visible(row)) continue;
        seen.add(href);
        const rr = normalizedRect(row);
        row.querySelectorAll(VISUAL_SEL).forEach((el) => {
          if (!visible(el)) return;
          const r = normalizedRect(el);
          const leftAvatar = r.left < rr.left + 80 && r.width >= 20 && r.height >= 20;
          const rightReceipt = r.right > rr.right - 56 && r.width >= 12 && r.width <= 34 && r.height >= 12 && r.height <= 34;
          if (leftAvatar || rightReceipt) mark(el);
        });
        const surfaces = textSurfaces(row).filter((el) => {
          if (el.getAttribute("aria-hidden") === "true") return false;
          if (el.closest("abbr")) return false;
          const r = normalizedRect(el);
          return r.left > rr.left + 56;
        });
        if (!surfaces.length) continue;
        const firstLineY = Math.min(...surfaces.map((el) => normalizedRect(el).top));
        const firstLine = [];
        surfaces.forEach((el) => {
          const r = normalizedRect(el);
          if (Math.abs(r.top - firstLineY) < 4 && r.height <= 24) firstLine.push(el);
          else if (r.top > firstLineY + 8 && r.height <= 24) markPreviewSenderPrefix(el);
        });
        markDeepest(firstLine);
      }
    }
    function mainPane() {
      return document.querySelector('[role="main"]') || document.querySelector("main");
    }
    function markThreadHeader(main2) {
      const mr = normalizedRect(main2);
      const headerBottom = mr.top + 96;
      const actionStart = mr.right - 150;
      textLeaves(main2).forEach((el) => {
        const r = normalizedRect(el);
        if (r.top >= mr.top && r.bottom <= headerBottom && r.left < actionStart) mark(el);
      });
      main2.querySelectorAll(VISUAL_SEL).forEach((el) => {
        if (!visible(el)) return;
        const r = normalizedRect(el);
        if (r.top >= mr.top && r.bottom <= headerBottom && r.left < actionStart && r.width >= 20 && r.height >= 20) {
          mark(el);
        }
      });
    }
    function markThreadMessages(main2) {
      main2.querySelectorAll('[role="article"]').forEach((article) => {
        article.querySelectorAll("h3, h3 *").forEach((el) => {
          if (visible(el) && textValue(el)) mark(el);
        });
        article.querySelectorAll(
          'img[referrerpolicy="origin-when-cross-origin"], img[height="14"][width="14"][tabindex="-1"]'
        ).forEach((el) => {
          if (visible(el)) mark(el);
        });
        textLeaves(article).forEach((el) => {
          if (/\breplied to\b/i.test(textValue(el))) mark(el);
        });
      });
      textSurfaces(main2).forEach((el) => {
        const r = normalizedRect(el);
        if (r.height <= 32 && r.width <= 420 && /\breplied to\b/i.test(textValue(el))) {
          mark(el);
        }
      });
    }
    function scan() {
      suppressMutations = true;
      try {
        clearMarkers();
        if (!on()) return;
        markConversationRows();
        const main2 = mainPane();
        if (main2) {
          markThreadHeader(main2);
          markThreadMessages(main2);
        }
      } finally {
        queueMicrotask(() => {
          suppressMutations = false;
        });
      }
    }
    const SCAN_MIN_GAP_MS = 150;
    let lastScanAt = 0;
    function schedule() {
      if (suppressMutations || !on() || pending) return;
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
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
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
    const apply = () => {
      html.toggleAttribute("data-carrier-hide-names", on());
      if (on()) {
        start();
        schedule();
      } else {
        stop();
      }
    };
    apply();
    window.addEventListener("carrier:settings", apply);
  }

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
  function isAuth(u) {
    const host = u.hostname.toLowerCase();
    return AUTH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
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

  // inject/src/messenger/features/login-tidy.ts
  var HIDE = "data-carrier-hide";
  var COL = "data-carrier-login-col";
  var ANC = "data-carrier-login-anc";
  var FORM = "data-carrier-login-form";
  var CARD = "data-carrier-login-card";
  var REQUIRED = "data-carrier-login-required";
  var FOOTER = "data-carrier-login-footer";
  var FOOTER_KEEP = "data-carrier-login-footer-keep";
  var FOOTER_LINKS = "data-carrier-login-footer-links";
  var LANGUAGES = "data-carrier-login-languages";
  var LANGUAGE_LINK = "data-carrier-login-language-link";
  function initLoginTidy() {
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
      for (let node = footer; node; node = node.parentElement) {
        node.removeAttribute(HIDE);
        node.removeAttribute(FOOTER_LINKS);
        if (node !== footer && node !== languageRoot) node.setAttribute(FOOTER_KEEP, "");
        if (node === languageRoot) break;
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
      for (const link of allLinks) {
        if (languageSet.has(link) || link.hasAttribute(LANGUAGE_LINK)) continue;
        (link.closest("li") || link).setAttribute(FOOTER_LINKS, "");
      }
      for (const el of document.body.querySelectorAll("div, span")) {
        if (el.contains(col) || col.contains(el)) continue;
        if (languageLinks.some((link) => el.contains(link))) continue;
        if (/(\bMeta\s*©|\bMeta\s+\d{4}\b|©\s*\d{4})/i.test(el.textContent || "")) {
          el.setAttribute(FOOTER_LINKS, "");
        }
      }
    };
    function tidy() {
      const html = document.documentElement;
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
          clearFooterMarks();
          if (html.hasAttribute("data-carrier-darkswap")) {
            html.classList.replace("__fb-dark-mode", "__fb-light-mode");
            html.removeAttribute("data-carrier-darkswap");
          }
        }
        if (tidyObserver && /\bc_user=/.test(document.cookie) && !html.hasAttribute("data-carrier-authtext") && document.readyState === "complete") {
          tidyObserver.disconnect();
          tidyObserver = null;
          window.removeEventListener("resize", schedule);
        }
        return;
      }
      html.setAttribute("data-carrier-login", "");
      const dark = wantDark();
      if (dark && html.classList.contains("__fb-light-mode")) {
        html.classList.replace("__fb-light-mode", "__fb-dark-mode");
        html.setAttribute("data-carrier-darkswap", "");
      } else if (!dark && html.hasAttribute("data-carrier-darkswap")) {
        html.classList.replace("__fb-dark-mode", "__fb-light-mode");
        html.removeAttribute("data-carrier-darkswap");
      }
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
      for (const el of document.querySelectorAll("[data-carrier-cleared-bg]")) {
        el.style.removeProperty("background-color");
        el.removeAttribute("data-carrier-cleared-bg");
      }
      if (dark) {
        const clearLight = (el) => {
          if (!isLightFill(getComputedStyle(el).backgroundColor)) return;
          el.setAttribute("data-carrier-cleared-bg", "");
          el.style.setProperty("background-color", "transparent", "important");
        };
        for (const el of document.body.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.5)
            clearLight(el);
        }
        for (const el of col.querySelectorAll("*")) clearLight(el);
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
    const on = () => window.__CARRIER_SETTINGS__?.stop_media_autoplay === true;
    let lastActivationAt = Number.NEGATIVE_INFINITY;
    let observer = null;
    const noteActivation = (event) => {
      if (event.isTrusted) lastActivationAt = performance.now();
    };
    window.addEventListener("pointerdown", noteActivation, true);
    window.addEventListener("keydown", noteActivation, true);
    const shouldSuppress = () => shouldSuppressMediaPlay(on(), lastActivationAt, performance.now());
    const suppress = (video, force = false) => {
      if (!on() || !force && !shouldSuppress()) return;
      video.autoplay = false;
      video.removeAttribute("autoplay");
      if (!video.paused) video.pause();
    };
    const scan = (root, force = false) => {
      if (!on()) return;
      if (root.nodeType === Node.ELEMENT_NODE) {
        const element = root;
        if (element.matches(VIDEO_SELECTOR)) suppress(element, force);
        element.querySelectorAll(VIDEO_SELECTOR).forEach((video) => suppress(video, force));
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
    const apply = () => {
      if (on()) {
        start();
        scan(document, true);
      } else {
        stop();
      }
    };
    apply();
    window.addEventListener("carrier:settings", apply);
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

  // inject/src/messenger/features/media-permissions.ts
  function initMediaPermissionWarning() {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const original = md.getUserMedia.bind(md);
    const liveTracks = new LiveMediaTrackCounter((inCall) => {
      window.__carrierInCall = inCall;
    });
    md.getUserMedia = async (constraints) => {
      try {
        const stream = await original(constraints);
        stream.getTracks().forEach((track) => liveTracks.add(track));
        return stream;
      } catch (err) {
        const name = err?.name;
        if (err && (name === "NotAllowedError" || name === "NotFoundError")) {
          const kind = constraints?.video ? "camera" : "microphone";
          toast(`Carrier needs ${kind} access — check System Settings → Privacy & Security`);
          const pane = kind === "camera" ? "Privacy_Camera" : "Privacy_Microphone";
          openUrl(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
        }
        throw err;
      }
    };
  }

  // inject/src/messenger/features/media-viewer.ts
  function initMediaViewer() {
    const MIN = 1;
    const MAX = 8;
    const STEP = 1.15;
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
    function pickTarget(e) {
      const t = e.target;
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
    function exit() {
      if (!active) return;
      active = false;
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
      const r = target.getBoundingClientRect();
      const prev = scale;
      scale = e.deltaY < 0 ? Math.min(MAX, scale * STEP) : Math.max(MIN, scale / STEP);
      if (scale <= 1) {
        tx = 0;
        ty = 0;
      } else {
        const k = scale / prev;
        tx += (e.clientX - (r.left + r.width / 2)) * (1 - k);
        ty += (e.clientY - (r.top + r.height / 2)) * (1 - k);
      }
      render();
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
      if (!dragging) return;
      tx = stx + (e.clientX - sx);
      ty = sty + (e.clientY - sy);
      render();
    };
    const onUp = () => {
      dragging = false;
      render();
    };
    const onKey = (e) => {
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
      ["click", onClick, { capture: true }]
    ];
    document.addEventListener(
      "dblclick",
      (e) => {
        const t = pickTarget(e);
        if (!t) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (active) return exit();
        active = true;
        target = t;
        targetCssText = t.style.cssText;
        targetTabIndex = t.getAttribute("tabindex");
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        t.setAttribute("tabindex", "-1");
        const r = t.getBoundingClientRect();
        scale = 2;
        tx = (e.clientX - (r.left + r.width / 2)) * (1 - scale);
        ty = (e.clientY - (r.top + r.height / 2)) * (1 - scale);
        render(false);
        t.focus({ preventScroll: true });
        handlers.forEach(([type, f, o]) => {
          document.addEventListener(type, f, o);
        });
      },
      { capture: true }
    );
  }

  // inject/src/messenger/lib/conversation-row.ts
  function conversationTextParts(candidates) {
    const values = [];
    for (const candidate of candidates.filter(
      ({ text, width, height, ariaHidden, inAbbreviation, hasTextChild }) => !ariaHidden && !inAbbreviation && !hasTextChild && width > 1 && height > 1 && text.trim().length > 0
    ).sort((left, right) => left.y - right.y || left.x - right.x)) {
      const text = candidate.text.replace(/\s+/g, " ").trim();
      if (text && values[values.length - 1] !== text) values.push(text);
    }
    return {
      title: (values[0] || "Messenger").slice(0, 80),
      body: (values[1] || "New message").slice(0, 240)
    };
  }
  function isUnreadConversationText(fontWeight, text) {
    const weight = typeof fontWeight === "number" ? fontWeight : Number.parseInt(fontWeight, 10) || 0;
    return weight >= 600 && text.trim().length > 1;
  }

  // inject/src/messenger/lib/notification-fallback.ts
  var ConversationNotificationTracker = class {
    constructor() {
      __publicField(this, "signatures", /* @__PURE__ */ new Map());
      __publicField(this, "primed", false);
    }
    observe(current, observedKeys) {
      const currentKeys = /* @__PURE__ */ new Set();
      const changed = [];
      for (const conversation of current) {
        currentKeys.add(conversation.key);
        const previous = this.signatures.get(conversation.key);
        this.signatures.set(conversation.key, conversation.signature);
        if (this.primed && previous !== void 0 && previous !== conversation.signature) {
          changed.push(conversation.key);
        }
      }
      for (const key of observedKeys || currentKeys) {
        if (!currentKeys.has(key)) this.signatures.delete(key);
      }
      this.primed = true;
      return changed;
    }
  };
  var normalizeNotificationText = (value) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
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
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (const byte of new TextEncoder().encode(value)) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * prime);
    }
    return hash.toString(16).padStart(16, "0");
  }
  var NOTIFIED_STORE_LIMIT = 300;
  var STABLE_READ_SCANS = 3;
  var NotifiedSignatureStore = class {
    constructor(storage = null, storageKey = "__carrier_notified_previews__") {
      __publicField(this, "storage", storage);
      __publicField(this, "storageKey", storageKey);
      __publicField(this, "entries", /* @__PURE__ */ new Map());
      /** In-memory only: read-observation streaks per conversation (see observeRead). */
      __publicField(this, "readStreak", /* @__PURE__ */ new Map());
      try {
        const raw = this.storage?.getItem(this.storageKey);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        for (const entry of parsed) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
            this.entries.set(entry[0], entry[1]);
          }
        }
      } catch (_) {
      }
      let trimmed = false;
      while (this.entries.size > NOTIFIED_STORE_LIMIT) {
        this.entries.delete(this.entries.keys().next().value);
        trimmed = true;
      }
      if (trimmed) this.persist();
    }
    persist() {
      try {
        this.storage?.setItem(this.storageKey, JSON.stringify([...this.entries]));
      } catch (_) {
      }
    }
    alreadyNotified(conversationKey, fingerprint) {
      return this.entries.get(conversationKey) === fingerprint;
    }
    markNotified(conversationKey, fingerprint) {
      this.readStreak.delete(conversationKey);
      if (this.entries.get(conversationKey) === fingerprint) return;
      this.entries.delete(conversationKey);
      this.entries.set(conversationKey, fingerprint);
      while (this.entries.size > NOTIFIED_STORE_LIMIT) {
        const oldest = this.entries.keys().next().value;
        this.entries.delete(oldest);
        this.readStreak.delete(oldest);
      }
      this.persist();
    }
    /**
     * Forget conversations that are rendered without an unread preview — the
     * user has read them, so an identical future preview must notify again.
     * Requires STABLE_READ_SCANS consecutive read observations (an unread
     * observation resets the count) because hydration can transiently render
     * an unread row as read, and one flicker must not clear the suppression.
     */
    observeRead(unreadKeys, observedKeys) {
      let dropped = false;
      for (const key of new Set(observedKeys)) {
        if (unreadKeys.has(key)) {
          this.readStreak.delete(key);
          continue;
        }
        if (!this.entries.has(key)) continue;
        const streak = (this.readStreak.get(key) || 0) + 1;
        if (streak < STABLE_READ_SCANS) {
          this.readStreak.set(key, streak);
          continue;
        }
        this.readStreak.delete(key);
        this.entries.delete(key);
        dropped = true;
      }
      if (dropped) this.persist();
    }
  };
  var PageNotificationQueue = class {
    constructor() {
      __publicField(this, "signals", []);
    }
    add(signal) {
      this.signals.push(signal);
      if (this.signals.length > 20) this.signals.shift();
      return signal;
    }
    /**
     * Return (and remove) the queued page signal that matches this row, or null.
     * Returning the signal — rather than a boolean — lets the caller reach its
     * `nativeId` and route the already-emitted page-first notification.
     */
    consumeMatching(row, rowChangeAt, matchWindowMs) {
      for (let index = this.signals.length - 1; index >= 0; index--) {
        const signal = this.signals[index];
        const age = rowChangeAt - signal.at;
        if (age > matchWindowMs) {
          this.signals.splice(index, 1);
          continue;
        }
        if (age >= 0 && notificationTextMatches(signal.title, signal.body, row.title, row.body)) {
          this.signals.splice(index, 1);
          return signal;
        }
      }
      return null;
    }
  };
  var UnreadArrivalTracker = class {
    constructor() {
      __publicField(this, "changedAt", /* @__PURE__ */ new Map());
      __publicField(this, "unreadCount", null);
    }
    markRowsChanged(keys, at) {
      for (const key of keys) this.changedAt.set(key, at);
    }
    observeUnreadCount(count, at, maxMutationAgeMs) {
      for (const [key, changedAt] of this.changedAt) {
        if (at - changedAt > maxMutationAgeMs) this.changedAt.delete(key);
      }
      const previous = this.unreadCount;
      this.unreadCount = count;
      if (previous === null || count <= previous) return [];
      const candidates = [...this.changedAt].sort((left, right) => right[1] - left[1]).slice(0, count - previous).map(([key]) => key);
      for (const key of candidates) this.changedAt.delete(key);
      return candidates;
    }
  };
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

  // inject/src/messenger/lib/threads.ts
  function threadIdFromHref(href) {
    const m = (href || "").match(/\/t\/(\d+)/);
    return m ? m[1] : null;
  }
  function threadPathId(href) {
    const m = String(href || "").match(/^\/t\/(\d+)\/?$/);
    return m ? m[1] : null;
  }
  var SEPARATOR_RE = /^[·•.,\s]+$/;

  // inject/src/messenger/lib/unread.ts
  function unreadCountFromTitle(title) {
    const m = (title || "").match(/\((\d+)\)/);
    return m ? parseInt(m[1], 10) : 0;
  }

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
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      if (needles.some((n) => label.includes(n))) return el;
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
      const label = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      if (label === "search" || label === "search in conversation") return el;
    }
    return null;
  }
  function searchInConversation() {
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

  // inject/src/messenger/features/notifications.ts
  var FALLBACK_DELAY_MS = 2500;
  var PAGE_NOTIFICATION_MATCH_MS = 3e3;
  var FALLBACK_POLL_VISIBLE_MS = 1e4;
  var FALLBACK_POLL_HIDDEN_MS = 6e4;
  var ROW_MUTATION_MATCH_MS = 2e3;
  function initNotificationBridge() {
    if (!window.__TAURI_INTERNALS__) return;
    invoke("plugin:notification|is_permission_granted")?.then?.((granted) => granted || invoke("plugin:notification|request_permission"))?.catch?.(() => diag("notify.permission", "notification permission invoke failed"));
    const avatarToDataUrl = (url) => new Promise((resolve) => {
      if (!url) return resolve("");
      const img = new Image();
      img.crossOrigin = "anonymous";
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => done(""), 2500);
      img.onload = () => {
        try {
          const size = 64;
          const c = document.createElement("canvas");
          c.width = size;
          c.height = size;
          c.getContext("2d").drawImage(img, 0, 0, size, size);
          done(c.toDataURL("image/png"));
        } catch (_) {
          done("");
        }
      };
      img.onerror = () => done("");
      img.src = url;
    });
    let notifySeq = Date.now() * 1e3 + Math.floor(Math.random() * 1e3);
    const notifyHandlers = /* @__PURE__ */ new Map();
    window.__carrierNotifyClick = (id) => {
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
    const emitNotification = (id, title, body, icon, dedupeKey, onClick, threadPath) => {
      notifyHandlers.set(id, onClick);
      if (notifyHandlers.size > 50) notifyHandlers.delete(notifyHandlers.keys().next().value);
      invoke("plugin:event|emit", {
        event: "carrier:notify",
        payload: { id, title, body, icon, dedupe_key: dedupeKey, thread_path: threadPath || "" }
      })?.catch?.(() => diag("notify.emit", "carrier:notify emit failed"));
    };
    const updateNotificationRoute = (id, threadPath) => {
      invoke("plugin:event|emit", {
        event: "carrier:notify-route",
        payload: { id, thread_path: threadPath }
      })?.catch?.(() => diag("notify.route", "carrier:notify-route emit failed"));
    };
    const notifiedStore = new NotifiedSignatureStore(
      (() => {
        try {
          return window.localStorage;
        } catch (_) {
          return null;
        }
      })()
    );
    const pendingFallbacks = /* @__PURE__ */ new Map();
    const unmatchedPageNotifications = new PageNotificationQueue();
    const markPageNotification = (title, body) => {
      for (const [key, pending] of pendingFallbacks) {
        if (!notificationTextMatches(title, body, pending.title, pending.body)) continue;
        clearTimeout(pending.timer);
        pendingFallbacks.delete(key);
        notifiedStore.markNotified(key, pending.fingerprint);
        return { threadPath: pending.threadPath };
      }
      return { signal: unmatchedPageNotifications.add({ at: Date.now(), title, body }) };
    };
    function CarrierNotification(title, options = {}) {
      const opts = options || {};
      const s = window.__CARRIER_SETTINGS__ || {};
      diag(
        "notify.fired",
        `page constructed a Notification (visibility: ${document.visibilityState})`
      );
      const pageMatch = markPageNotification(String(title || "Messenger"), String(opts.body || ""));
      if (!s.mute_notifications) {
        const hidePreview = s.hide_notification_preview;
        const originalTitle = String(title || "Messenger");
        const originalBody = String(opts.body || "");
        const id = ++notifySeq;
        if (pageMatch.signal) pageMatch.signal.nativeId = id;
        avatarToDataUrl(hidePreview ? "" : opts.icon).then((icon) => {
          emitNotification(
            id,
            hidePreview ? "Messenger" : originalTitle,
            hidePreview ? "New message" : originalBody,
            icon,
            notificationDedupeKey(originalTitle, originalBody),
            () => {
              this.onclick?.(new Event("click"));
            },
            pageMatch.threadPath
          );
        });
      }
      try {
        window.__carrierOnNotification?.();
      } catch (_) {
      }
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
    const conversationFromLink = (link) => {
      const id = threadIdFromHref(link?.getAttribute("href"));
      if (!id) return null;
      const row = link.closest('[role="row"]') || link;
      const text = conversationTextParts(
        [...row.querySelectorAll("span")].map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            text: el.textContent || "",
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            ariaHidden: el.getAttribute("aria-hidden") === "true",
            inAbbreviation: !!el.closest("abbr"),
            hasTextChild: [...el.children].some((child) => !!(child.textContent || "").trim())
          };
        })
      );
      const image = row.querySelector("img[src]");
      let unread = false;
      for (const span of row.querySelectorAll("span")) {
        if (isUnreadConversationText(getComputedStyle(span).fontWeight, span.textContent || "")) {
          unread = true;
          break;
        }
      }
      return {
        key: id,
        threadPath: `/t/${id}/`,
        title: text.title,
        body: text.body,
        icon: image?.currentSrc || image?.src || "",
        unread
      };
    };
    const scheduleFallback = (conversation, detectedAt) => {
      const fingerprint = notificationDedupeKey(conversation.title, conversation.body);
      const previous = pendingFallbacks.get(conversation.key);
      if (previous) clearTimeout(previous.timer);
      const pageSignal = unmatchedPageNotifications.consumeMatching(
        conversation,
        detectedAt,
        PAGE_NOTIFICATION_MATCH_MS
      );
      if (pageSignal) {
        if (pageSignal.nativeId !== void 0 && conversation.threadPath) {
          updateNotificationRoute(pageSignal.nativeId, conversation.threadPath);
        }
        notifiedStore.markNotified(conversation.key, fingerprint);
        pendingFallbacks.delete(conversation.key);
        return;
      }
      const avatar = avatarToDataUrl(conversation.icon);
      const timer = setTimeout(async () => {
        const settings = window.__CARRIER_SETTINGS__ || {};
        if (settings.mute_notifications) {
          if (pendingFallbacks.get(conversation.key)?.timer === timer) {
            pendingFallbacks.delete(conversation.key);
          }
          return;
        }
        const hidePreview = settings.hide_notification_preview === true;
        const icon = hidePreview ? "" : await avatar;
        if (pendingFallbacks.get(conversation.key)?.timer !== timer) return;
        pendingFallbacks.delete(conversation.key);
        notifiedStore.markNotified(conversation.key, fingerprint);
        diag(
          "notify.fallback",
          `unread row changed without a page Notification (visibility: ${document.visibilityState})`
        );
        emitNotification(
          ++notifySeq,
          hidePreview ? "Messenger" : conversation.title,
          hidePreview ? "New message" : conversation.body,
          icon,
          fingerprint,
          () => {
            window.__carrierOpenThread?.(conversation.threadPath);
          },
          conversation.threadPath
        );
      }, FALLBACK_DELAY_MS);
      pendingFallbacks.set(conversation.key, {
        timer,
        title: conversation.title,
        body: conversation.body,
        threadPath: conversation.threadPath,
        fingerprint
      });
    };
    let scanRunning = false;
    let scanPending = false;
    const unreadArrivals = new UnreadArrivalTracker();
    const scanUnreadConversations = () => {
      if (scanRunning) {
        scanPending = true;
        return;
      }
      scanRunning = true;
      try {
        const links = chatRows();
        if (!links.length) return;
        const observed = links.map(conversationFromLink).filter((conversation) => conversation !== null);
        const conversations = observed.filter(
          (conversation) => conversation.unread && !isOwnMessagePreview(conversation.body)
        );
        notifiedStore.observeRead(
          new Set(observed.filter(({ unread }) => unread).map(({ key }) => key)),
          observed.map(({ key }) => key)
        );
        const detectedAt = Date.now();
        const changed = new Set(
          conversationTracker.observe(
            conversations.map(({ key, body, title }) => ({ key, signature: body || title })),
            observed.map(({ key }) => key)
          )
        );
        for (const key of unreadArrivals.observeUnreadCount(
          unreadCountFromTitle(document.title || ""),
          detectedAt,
          ROW_MUTATION_MATCH_MS
        )) {
          changed.add(key);
        }
        if (!changed.size) return;
        const stale = /* @__PURE__ */ new Set();
        for (const conversation of conversations) {
          if (changed.has(conversation.key) && notifiedStore.alreadyNotified(
            conversation.key,
            notificationDedupeKey(conversation.title, conversation.body)
          )) {
            stale.add(conversation.key);
          }
        }
        if (stale.size) {
          diag("notify.stale", "suppressed replay of an already-delivered preview");
        }
        if ([...changed].every((key) => stale.has(key))) return;
        try {
          window.__carrierOnNotification?.();
        } catch (_) {
        }
        for (const conversation of conversations) {
          if (changed.has(conversation.key) && !stale.has(conversation.key)) {
            scheduleFallback(conversation, detectedAt);
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
      const inspect = (node) => {
        const element = node instanceof Element ? node : node.parentElement;
        if (!element) return;
        const links = /* @__PURE__ */ new Set();
        const closest = element.closest('a[href*="/t/"]');
        if (closest) links.add(closest);
        for (const link of element.querySelectorAll('a[href*="/t/"]')) {
          links.add(link);
        }
        for (const link of links) {
          const key = threadIdFromHref(link.getAttribute("href"));
          if (key) changedKeys.add(key);
        }
      };
      for (const record of records) {
        inspect(record.target);
        for (const node of record.addedNodes) inspect(node);
      }
      unreadArrivals.markRowsChanged(changedKeys, Date.now());
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
        attributeFilter: ["class", "src", "alt", "style"]
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
      if (!document.hidden) poll();
    });
    startPoll();
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
    const push = () => {
      const hide = window.__CARRIER_SETTINGS__?.hide_names_avatars === true;
      const threads = hide ? [] : scan();
      if (threads === null) return;
      if (!hide && threads.length === 0) {
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
    { key: "settings-button", sel: "[data-carrier-settings-button]" }
  ];
  function initSelectorHealth() {
    if (!window.__TAURI_INTERNALS__) return;
    let warnedUser = false;
    const misses = /* @__PURE__ */ new Map();
    const check = () => {
      if (!location.pathname.startsWith("/messages")) return;
      if (document.querySelector('input[name="pass"]')) return;
      for (const { key, sel } of WATCHED_SELECTORS) {
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
  function findOverflowButton() {
    const buttons = document.querySelectorAll(
      `[role="button"]:not([${BUTTON_ATTR}]), button:not([${BUTTON_ATTR}])`
    );
    let iconFallback = null;
    for (const button of buttons) {
      const iconPath = button.querySelector("svg path")?.getAttribute("d") || "";
      if (!isMessengerHeaderOverflowControl(iconPath)) continue;
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
    const ensureButton = () => {
      scheduled = false;
      if (!location.pathname.startsWith("/messages")) return;
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
        subtree: true
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  // inject/src/messenger/lib/zoom.ts
  var clampZoom = (p) => Math.min(200, Math.max(30, Math.round(p) || 100));

  // inject/src/messenger/features/zoom.ts
  var ZOOM_KEY = "carrier:zoom";
  var isWindows = /windows/i.test(navigator.userAgent);
  var zoomLevel = 100;
  function applyZoom(percent, fromSettings) {
    const clamped = clampZoom(percent);
    if (isWindows) {
      const scale = clamped / 100;
      document.body.style.transformOrigin = "top left";
      document.body.style.transform = `scale(${scale})`;
      document.body.style.width = `${100 / scale}%`;
      document.body.style.height = `${100 / scale}%`;
      window.dispatchEvent(new Event("resize"));
    } else {
      document.documentElement.style.zoom = `${clamped}%`;
      window.dispatchEvent(new Event("resize"));
    }
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
  var zoomIn = () => applyZoom(zoomLevel + 10);
  var zoomOut = () => applyZoom(zoomLevel - 10);
  var zoomReset = () => applyZoom(100);
  function syncZoomFromSettings() {
    const s = window.__CARRIER_SETTINGS__ || {};
    const z = typeof s.zoom === "number" && Number.isFinite(s.zoom) ? clampZoom(s.zoom) : 100;
    if (z !== zoomLevel) applyZoom(z, true);
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
    if (z !== zoomLevel) applyZoom(z, true);
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
  var isMac2 = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  var accel = (e) => !e.altKey && (isMac2 ? e.metaKey : e.ctrlKey);
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
    window.__carrierShortcuts = {
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
  }

  // inject/src/messenger/features/spellcheck.ts
  var SPELL_SEL = '[contenteditable="true"], textarea, input[type="text"], input[type="search"]';
  function applySpellcheckNow() {
    const on = window.__CARRIER_SETTINGS__?.spellcheck === true;
    document.querySelectorAll(SPELL_SEL).forEach((el) => {
      el.setAttribute?.("spellcheck", on ? "true" : "false");
    });
  }
  function applySpellcheck() {
    applySpellcheckNow();
    registerAddedNodeSweep((root) => {
      const on = window.__CARRIER_SETTINGS__?.spellcheck === true;
      const want = on ? "true" : "false";
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

  // inject/src/messenger/lib/emoji.ts
  var EMOJI_SOURCE_RE = /(?:emoji|emoji\.php|\/images\/emoji)/i;
  var EMOJI_TEXT_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}]/u;
  var LABEL_TEXT_RE = /[\p{Letter}\p{Number}]/u;
  function emojiGlyph(value) {
    const text = String(value || "").trim();
    if (!text || text.length > 24 || !EMOJI_TEXT_RE.test(text)) return "";
    if (LABEL_TEXT_RE.test(text)) return "";
    return text;
  }
  function isReactionMenuShape(children) {
    if (children.length < 6 || children.length > 9) return false;
    const addButton = children.at(-1);
    return addButton?.glyphs === 0 && addButton.role === "button" && children.slice(0, -1).every((child) => child.glyphs === 1);
  }

  // inject/src/messenger/features/system-emoji.ts
  var SOURCE_ATTR = "data-carrier-emoji-sprite";
  var GLYPH_ATTR = "data-carrier-system-emoji-glyph";
  var REACTION_ATTR = "data-carrier-reaction-emoji";
  var CANDIDATE_SEL = "img[alt], [aria-label]";
  var INTERACTIVE_SEL = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]';
  function initSystemEmoji() {
    const html = document.documentElement;
    let observer = null;
    let pending = false;
    const queuedRoots = /* @__PURE__ */ new Set();
    const on = () => window.__CARRIER_SETTINGS__?.system_emoji === true;
    function sourceGlyph(el) {
      if (el?.nodeType !== 1 || el.hasAttribute(GLYPH_ATTR)) return "";
      if (el.matches?.("img[alt]")) {
        const img = el;
        const src = img.currentSrc || img.src || img.getAttribute("src") || "";
        if (!EMOJI_SOURCE_RE.test(src)) return "";
        return emojiGlyph(img.getAttribute("alt"));
      }
      if (el.matches?.(INTERACTIVE_SEL)) return "";
      const label = emojiGlyph(el.getAttribute("aria-label"));
      if (!label) return "";
      const bg = getComputedStyle(el).backgroundImage || "";
      return EMOJI_SOURCE_RE.test(bg) ? label : "";
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
      if (!on() || !root || root.nodeType !== 1) return;
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
      if (!on()) return;
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
    const apply = () => {
      html.toggleAttribute("data-carrier-system-emoji", on());
      if (on()) {
        start();
        schedule();
      } else {
        stop();
      }
    };
    apply();
    window.addEventListener("carrier:settings", apply);
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", () => on() && schedule(), { once: true });
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
    const on = () => window.__CARRIER_SETTINGS__?.block_telemetry === true;
    const shouldBlock = (raw) => on() && isBlockedTelemetryUrl(raw, location.href);
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
        if (this.__carrierBlocked && on()) {
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

  // inject/src/messenger/features/thread-nav.ts
  function initThreadNav() {
    window.__carrierOpenThread = (href) => {
      const id = threadPathId(href);
      if (!id) return false;
      for (const a of document.querySelectorAll('a[href*="/t/"]')) {
        if (threadIdFromHref(a.getAttribute("href")) === id) {
          a.click();
          return true;
        }
      }
      location.href = `https://www.facebook.com/messages/t/${id}/`;
      return true;
    };
    window.__carrierToggleInfo = () => {
      const wanted = (el) => {
        const l = (el.getAttribute("aria-label") || "").toLowerCase();
        return l.includes("conversation information") || l.includes("conversation details");
      };
      let btn = document.querySelector(
        '[role="button"][aria-label="Conversation information"]'
      );
      if (!btn) {
        for (const el of document.querySelectorAll("[aria-label]"))
          if (wanted(el)) {
            btn = el.closest('[role="button"]') || el;
            break;
          }
      }
      if (btn) {
        btn.click();
        return true;
      }
      toast("Open a conversation first");
      return false;
    };
  }

  // inject/src/messenger/features/unread-badge.ts
  function initUnreadBadge() {
    if (!window.__TAURI_INTERNALS__) return;
    const countUnreadMessages = () => unreadCountFromTitle(document.title || "");
    const countUnreadConversations = () => {
      const seen = /* @__PURE__ */ new Set();
      let n = 0;
      for (const a of document.querySelectorAll('a[href*="/t/"]')) {
        const id = threadIdFromHref(a.getAttribute("href"));
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const row = a.closest('[role="row"]') || a;
        for (const span of row.querySelectorAll("span")) {
          if (isUnreadConversationText(getComputedStyle(span).fontWeight, span.textContent || "")) {
            n++;
            break;
          }
        }
      }
      return n;
    };
    let last = null;
    const setBadge = (n, force) => {
      if (n === last && !force) return;
      last = n;
      invoke("plugin:window|set_badge_count", { value: n > 0 ? n : null })?.catch?.(
        () => diag("badge.set", "set_badge_count invoke failed")
      );
      invoke("plugin:event|emit", { event: "carrier:unread", payload: n })?.catch?.(
        () => diag("badge.emit", "carrier:unread emit failed")
      );
    };
    const apply = (force) => {
      const s = window.__CARRIER_SETTINGS__ || {};
      if (s.unread_badge === false) {
        setBadge(0, force);
        return;
      }
      const conv = s.badge_mode === "conversations";
      const n = conv ? countUnreadConversations() : countUnreadMessages();
      const ready = conv ? document.querySelector('a[href*="/t/"]') !== null : document.readyState === "complete" && (document.title || "").trim().length > 0;
      if (n === 0 && !ready) return;
      setBadge(n, force);
    };
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        apply(false);
        setTimeout(() => apply(false), 800);
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
    window.addEventListener("carrier:settings", () => apply(true));
    let pollTimer;
    const startPoll = () => {
      clearInterval(pollTimer);
      pollTimer = setInterval(() => apply(false), document.hidden ? 6e4 : 5e3);
    };
    document.addEventListener("visibilitychange", () => {
      startPoll();
      if (!document.hidden) apply(false);
    });
    startPoll();
    apply(true);
    setTimeout(() => apply(true), 1500);
    setTimeout(() => apply(true), 4e3);
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
    initFeature("composer-keys", initComposerKeys);
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
    initFeature("notifications", initNotificationBridge);
    initFeature("auto-refresh", initAutoRefresh);
    initFeature("force-theme", initForceTheme);
    initFeature("unread-badge", initUnreadBadge);
    initFeature("recent-threads", initRecentThreads);
    initFeature("thread-nav", initThreadNav);
    initFeature("hide-names", initHideNames);
    initFeature("system-emoji", initSystemEmoji);
    initFeature("media-permissions", initMediaPermissionWarning);
    initFeature("cookie-consent", initCookieAutoDecline);
    initFeature("login-tidy", initLoginTidy);
    initFeature("media-viewer", initMediaViewer);
    initFeature("fullscreen", initFullscreenPolyfill);
  }
  if (window.top === window.self) main();
})();
