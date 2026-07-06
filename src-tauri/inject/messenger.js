/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: inject/src/messenger/ (bundled by inject/build.ts via `bun run build:inject`).
 */
"use strict";
(() => {
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
    const maybeReload = () => {
      timer = void 0;
      if (!pending) return;
      if (document.hasFocus()) {
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
      if (document.hasFocus()) {
        lastFresh = Date.now();
        return;
      }
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(maybeReload, delay);
    };
    window.addEventListener("focus", clearPending);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && document.hasFocus()) clearPending();
    });
    window.__carrierOnNotification = () => {
      if (!document.hasFocus() && Date.now() - lastFresh >= NOTIF_GAP_MS) schedule(4e3);
    };
    setInterval(() => {
      if (document.hasFocus()) {
        lastFresh = Date.now();
        return;
      }
      if (Date.now() - lastFresh >= PERIODIC_MS) schedule(2e3);
    }, 60 * 1e3);
  }

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
  async function downloadSrc(src, fallbackName) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
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
    const blob = await res.blob();
    if (blob.size > MAX_BLOB) throw new Error("image too large");
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  }
  var ctxMenu = null;
  var closeMenu = () => {
    ctxMenu?.remove();
    ctxMenu = null;
    document.removeEventListener("click", closeMenu, true);
    document.removeEventListener("scroll", closeMenu, true);
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
          items.push([
            "Copy image address",
            () => navigator.clipboard?.writeText(imgSrc).then(() => toast("Address copied"))
          ]);
          items.push(["Open image in browser", () => openUrl(imgSrc)]);
        } else if (vidSrc) {
          items.push([
            "Download video",
            () => downloadSrc(vidSrc, "video").then(() => toast("Saved to Downloads")).catch(() => toast("Download failed"))
          ]);
          items.push([
            "Copy video address",
            () => navigator.clipboard?.writeText(vidSrc).then(() => toast("Address copied"))
          ]);
        } else if (linkHref && !linkHref.startsWith("javascript:")) {
          items.push([
            "Copy link address",
            () => navigator.clipboard?.writeText(linkHref).then(() => toast("Address copied"))
          ]);
          items.push(["Open link in browser", () => openUrl(linkHref)]);
        }
        if (!items.length) return;
        e.preventDefault();
        closeMenu();
        ctxMenu = document.createElement("div");
        Object.assign(ctxMenu.style, {
          position: "fixed",
          left: `${e.clientX}px`,
          top: `${e.clientY}px`,
          zIndex: 2147483647,
          background: "#242526",
          color: "#e4e6eb",
          border: "1px solid #3a3b3c",
          borderRadius: "8px",
          padding: "4px",
          boxShadow: "0 6px 24px rgba(0,0,0,.4)",
          minWidth: "170px",
          font: "13px -apple-system, system-ui, sans-serif"
        });
        for (const [label, fn] of items) {
          const el = document.createElement("div");
          el.textContent = label;
          Object.assign(el.style, { padding: "8px 12px", cursor: "pointer", borderRadius: "6px" });
          el.onmouseenter = () => el.style.background = "#3a3b3c";
          el.onmouseleave = () => el.style.background = "";
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
        setTimeout(() => {
          document.addEventListener("click", closeMenu, true);
          document.addEventListener("scroll", closeMenu, true);
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
    const m = bg?.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const [r = NaN, g = NaN, b = NaN, a = 1] = m[1].split(",").map((s) => parseFloat(s));
    return a > 0.9 && (r + g + b) / 3 > 200;
  };

  // inject/src/messenger/features/cookie-consent.ts
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
    })).filter((row) => row.primaryScore > 40 || row.items.length === 2).sort((a, b) => b.bottom - a.bottom)[0]?.items;
  };
  function findOptionalCookieDeclineButton(root = document) {
    if (!onFacebookLoginSurface()) return null;
    const roots = /* @__PURE__ */ new Set();
    for (const button of actionButtonsIn(root)) {
      let node = button.parentElement;
      for (let depth = 0; node && node !== document.body && depth < 12; depth++, node = node.parentElement) {
        const row = bottomActionRow(node);
        if (row?.length === 2 && !node.querySelector?.('input[name="email"], input[name="pass"], input[type="password"]')) {
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
      const target = row.reduce(
        (best, item) => primaryBlueScore(item.button) < primaryBlueScore(best.button) ? item : best
      );
      return target.button;
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
    if (/[\d:;!?]/.test(prefix)) return null;
    return { prefix, colon: !!colon };
  }

  // inject/src/messenger/features/hide-names.ts
  var IDENTITY_ATTR = "data-carrier-private-identity";
  var WRAPPER_ATTR = "data-carrier-private-wrapper";
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
    function visible(el) {
      const r = el?.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    }
    function mark(el) {
      if (el?.setAttribute) el.setAttribute(IDENTITY_ATTR, "");
    }
    function unwrap(el) {
      const parent = el?.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(el.textContent || ""), el);
      parent.normalize?.();
    }
    function clearMarkers() {
      document.querySelectorAll(`[${WRAPPER_ATTR}]`).forEach(unwrap);
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
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
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
      if (wrapPreviewPrefix(el, identity)) return true;
      if (!identity.colon && value.length <= 90) {
        mark(el);
        return true;
      }
      return false;
    }
    function wrapPreviewPrefix(el, identity) {
      const needle = identity.prefix + (identity.colon ? ":" : "");
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node2) {
          if (!node2.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node2.parentElement;
          if (!parent || parent.closest(`[${WRAPPER_ATTR}]`) || parent.closest("abbr")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node;
      while (node = walker.nextNode()) {
        const text = node.nodeValue || "";
        const start2 = text.search(/\S/);
        if (start2 < 0) continue;
        if (text.slice(start2, start2 + needle.length) === needle) {
          return wrapTextRange(node, start2, needle.length);
        }
        if (!identity.colon && text.slice(start2, start2 + identity.prefix.length) === identity.prefix) {
          return wrapTextRange(node, start2, identity.prefix.length);
        }
      }
      return false;
    }
    function wrapTextRange(node, start2, length) {
      const parent = node.parentNode;
      const text = node.nodeValue || "";
      if (!parent || length <= 0 || start2 < 0 || start2 + length > text.length) return false;
      const fragment = document.createDocumentFragment();
      const before = text.slice(0, start2);
      const selected = text.slice(start2, start2 + length);
      const after = text.slice(start2 + length);
      if (before) fragment.appendChild(document.createTextNode(before));
      const span = document.createElement("span");
      span.setAttribute(IDENTITY_ATTR, "");
      span.setAttribute(WRAPPER_ATTR, "");
      span.textContent = selected;
      fragment.appendChild(span);
      if (after) fragment.appendChild(document.createTextNode(after));
      parent.replaceChild(fragment, node);
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
          if (leftAvatar || rightReceipt) mark(el);
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
          else if (r.top > firstLineY + 8 && r.height <= 24) markPreviewSenderPrefix(el);
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
      textLeaves(main2).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.top >= mr.top && r.bottom <= headerBottom && r.left < actionStart) mark(el);
      });
      main2.querySelectorAll(VISUAL_SEL).forEach((el) => {
        if (!visible(el)) return;
        const r = el.getBoundingClientRect();
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
        const r = el.getBoundingClientRect();
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
  function classifyHref(href, base) {
    try {
      const u = new URL(href, base);
      if (u.protocol === "mailto:" || u.protocol === "tel:") return { external: true };
      if (!/^https?:$/.test(u.protocol)) return { external: false };
      if (isAuth(u)) return { external: false };
      const host = u.hostname.replace(/^www\./, "");
      const tracking = host === "l.facebook.com" || host === "lm.facebook.com" || host === "facebook.com" && u.pathname === "/l.php";
      const internal = INTERNAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
      return { external: tracking || !internal };
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
    const COOKIE_TEXT_RE = /\b(cookie|cookies)\b|informasjonskapsl|tillat alle informasjonskapsler|avvis valgfrie informasjonskapsler/i;
    const COOKIE_ACTION_RE = /allow all|reject optional|accept all|decline optional|tillat alle|avvis valgfrie|godta alle|avsl[aå] valgfrie/i;
    const hasCookieConsentText = (el) => {
      const text = (el.textContent || "").replace(/\s+/g, " ").slice(0, 4e3);
      if (!COOKIE_TEXT_RE.test(text)) return false;
      return COOKIE_ACTION_RE.test(text) || /privacy|personvern|Meta|Facebook/i.test(text);
    };
    const hasCookieConsentLabel = (el) => {
      const ownAria = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("aria-labelledby") || ""}`;
      if (COOKIE_TEXT_RE.test(ownAria) || COOKIE_ACTION_RE.test(ownAria)) return true;
      const nodes = el.querySelectorAll?.("[aria-label], [aria-labelledby]") || [];
      for (const node of nodes) {
        const aria = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("aria-labelledby") || ""}`;
        if (COOKIE_TEXT_RE.test(aria) || COOKIE_ACTION_RE.test(aria)) return true;
      }
      return false;
    };
    const isRequiredLoginUi = (el) => {
      if (el?.nodeType !== 1) return false;
      if (el === document.documentElement || el === document.body) return false;
      const role = el.getAttribute("role");
      if (role === "dialog" || role === "alertdialog") return true;
      if (el.querySelector?.('[role="dialog"], [role="alertdialog"]')) return true;
      if (findOptionalCookieDeclineButton(el)) return true;
      return hasCookieConsentLabel(el) || hasCookieConsentText(el);
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
    const FOOTER_NOISE_RE = /registrer|logg inn|messenger|facebook|lite|video|meta(?:\s|$)|instagram|threads|quest|ray-ban|personvern|privacy|cookie|informasjonskaps|annonse|annonsevalg|utviklere|developer|jobber|hjelp|help|betingelser|terms|opplasting/i;
    const isLanguageFooterLink = (link) => {
      if (link.hasAttribute(LANGUAGE_LINK)) return true;
      const href = (link.getAttribute("href") || "").trim();
      return href === "#" || href.endsWith("#");
    };
    const isFooterNoiseLink = (link) => FOOTER_NOISE_RE.test((link.textContent || "").replace(/\s+/g, " ").trim());
    const topLanguageLinks = (links) => {
      const langs = links.filter((link) => isLanguageFooterLink(link) && !isFooterNoiseLink(link));
      return langs.length >= 2 ? langs : [];
    };
    const linksOutside = (root, inner) => [...root.querySelectorAll?.("a[href]") || []].filter((link) => !inner.contains(link));
    const isFooterContainer = (el, inner) => {
      if (!el?.querySelector) return false;
      if (el.querySelector("#pageFooter, .localeSelectorList")) return true;
      const links = linksOutside(el, inner);
      return links.length >= 6 && (topLanguageLinks(links).length >= 2 || links.filter(isLanguageFooterLink).length >= 2);
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

  // inject/src/messenger/features/media-permissions.ts
  function initMediaPermissionWarning() {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      try {
        const stream = await original(constraints);
        window.__carrierInCall = true;
        const tracks = stream.getTracks();
        let live = tracks.length;
        tracks.forEach((t) => {
          t.addEventListener("ended", () => {
            if (--live <= 0) window.__carrierInCall = false;
          });
        });
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
      if (target) {
        target.style.cssText = target.style.cssText.replace(/transform[^;]*;?/g, "").replace(/transition[^;]*;?/g, "").replace(/max-(width|height)[^;]*;?/g, "").replace(/z-index[^;]*;?/g, "").replace(/cursor[^;]*;?/g, "");
      }
      target = null;
      scale = 1;
      tx = 0;
      ty = 0;
      dragging = false;
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
        const r = t.getBoundingClientRect();
        scale = 2;
        tx = (e.clientX - (r.left + r.width / 2)) * (1 - scale);
        ty = (e.clientY - (r.top + r.height / 2)) * (1 - scale);
        render(false);
        handlers.forEach(([type, f, o]) => {
          document.addEventListener(type, f, o);
        });
      },
      { capture: true }
    );
  }

  // inject/src/messenger/lib/dnd.ts
  function parseDndTime(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  }
  function dndActive(settings, now = /* @__PURE__ */ new Date()) {
    const start = parseDndTime(settings?.dnd_start);
    const end = parseDndTime(settings?.dnd_end);
    if (start == null || end == null || start === end) return false;
    const minutes = now.getHours() * 60 + now.getMinutes();
    return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }

  // inject/src/messenger/features/notifications.ts
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
    let notifySeq = 0;
    const notifyHandlers = /* @__PURE__ */ new Map();
    window.__carrierNotifyClick = (id) => {
      const n = notifyHandlers.get(id);
      if (!n) return;
      notifyHandlers.delete(id);
      try {
        window.focus();
      } catch (_) {
      }
      try {
        n.onclick?.(new Event("click"));
      } catch (_) {
      }
    };
    function CarrierNotification(title, options = {}) {
      const opts = options || {};
      const s = window.__CARRIER_SETTINGS__ || {};
      if (!s.mute_notifications && !dndActive(s)) {
        const id = ++notifySeq;
        notifyHandlers.set(id, this);
        if (notifyHandlers.size > 50) notifyHandlers.delete(notifyHandlers.keys().next().value);
        const hidePreview = s.hide_notification_preview;
        avatarToDataUrl(hidePreview ? "" : opts.icon).then((icon) => {
          invoke("plugin:event|emit", {
            event: "carrier:notify",
            payload: {
              id,
              title: hidePreview ? "Messenger" : String(title || "Messenger"),
              body: hidePreview ? "New message" : String(opts.body || ""),
              icon
            }
          })?.catch?.(() => diag("notify.emit", "carrier:notify emit failed"));
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
    // Conversation list links: Cmd/Ctrl+1–9, unread-conversations badge,
    // recent threads, hide-names blur.
    { key: "chat-list", sel: '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]' },
    // The conversation pane: media viewer, hide-names header blur.
    { key: "main-region", sel: '[role="main"]' }
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
  var isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
  var accel = (e) => isMac ? e.metaKey : e.ctrlKey;
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
    t: () => attachFiles()
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
        if (e.key === "F5") {
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
    const on = window.__CARRIER_SETTINGS__?.spellcheck !== false;
    document.querySelectorAll(SPELL_SEL).forEach((el) => {
      el.setAttribute?.("spellcheck", on ? "true" : "false");
    });
  }
  function applySpellcheck() {
    applySpellcheckNow();
    registerAddedNodeSweep((root) => {
      const on = window.__CARRIER_SETTINGS__?.spellcheck !== false;
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

  // inject/src/messenger/features/system-emoji.ts
  var SOURCE_ATTR = "data-carrier-emoji-sprite";
  var GLYPH_ATTR = "data-carrier-system-emoji-glyph";
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
      });
    }
    function start() {
      if (observer) return;
      observer = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes") {
            schedule(m.target);
          } else {
            for (const n of m.addedNodes) schedule(n);
          }
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["alt", "aria-label", "src", "style"]
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

  // inject/src/messenger/lib/unread.ts
  function unreadCountFromTitle(title) {
    const m = (title || "").match(/\((\d+)\)/);
    return m ? parseInt(m[1], 10) : 0;
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
          const w = parseInt(getComputedStyle(span).fontWeight, 10) || 0;
          if (w >= 600 && (span.textContent || "").trim().length > 1) {
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
      const ready = conv ? document.querySelector('a[href*="/t/"]') !== null : /Messenger|Facebook/i.test(document.title || "");
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
  function main() {
    initShortcuts();
    initZoom();
    initSelectorHealth();
    initFunctionKeys();
    initShortcutRegistry();
    initLinkHandling();
    initContextMenu();
    initDownloadAnchors();
    initSpellcheck();
    initTelemetryBlocking();
    initNotificationBridge();
    initAutoRefresh();
    initForceTheme();
    initUnreadBadge();
    initRecentThreads();
    initThreadNav();
    initHideNames();
    initSystemEmoji();
    initMediaPermissionWarning();
    initCookieAutoDecline();
    initLoginTidy();
    initMediaViewer();
    initFullscreenPolyfill();
  }
  if (window.top === window.self) main();
})();
