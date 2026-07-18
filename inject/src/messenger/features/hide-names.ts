/* ----------------------- Hide names & avatars ------------------------- */
// Toggle marker attributes the injected CSS keys off of to blur contact
// names and avatars (Settings / View ▸ Hide Names & Avatars / Cmd+Shift+H).
// Facebook's generated class names churn, so this keeps the selectors shallow
// and marks identity surfaces by stable roles, links, and layout shape.
import { isMetaText, previewIdentity } from "../lib/privacy";

const IDENTITY_ATTR = "data-carrier-private-identity";
const THREAD_ROW_SEL = '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]';
const TEXT_SURFACE_SEL = "span, div, h1, h2, h3, h4";
const VISUAL_SEL = 'img, svg, image, [style*="background-image"]';

export function initHideNames() {
  const html = document.documentElement;
  let observer: MutationObserver | null = null;
  let pending = false;
  let suppressMutations = false;

  const on = () => window.__CARRIER_SETTINGS__?.hide_names_avatars === true;

  function textValue(el: Element | null | undefined) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function normalizedRect(el: Element) {
    const rect = el.getBoundingClientRect();
    const configuredZoom = Number(window.__CARRIER_SETTINGS__?.zoom) || 100;
    const scale = Math.min(2, Math.max(0.3, configuredZoom / 100));
    return new DOMRect(rect.x / scale, rect.y / scale, rect.width / scale, rect.height / scale);
  }

  function visible(el: Element | null | undefined) {
    const r = el ? normalizedRect(el) : null;
    if (!r || r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el!);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }

  function mark(el: Element | null | undefined) {
    if (el?.setAttribute) el.setAttribute(IDENTITY_ATTR, "");
  }

  function clearMarkers() {
    document.querySelectorAll(`[${IDENTITY_ATTR}]`).forEach((el) => {
      el.removeAttribute(IDENTITY_ATTR);
    });
  }

  function textLeaves(root: Element) {
    const out: Element[] = [];
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

  function textSurfaces(root: Element) {
    const out: Element[] = [];
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

  function area(el: Element) {
    const r = normalizedRect(el);
    return r.width * r.height;
  }

  function deepest(elements: Element[]) {
    return elements.filter((el) => !elements.some((other) => other !== el && el.contains(other)));
  }

  function markDeepest(elements: Element[]) {
    let count = 0;
    deepest(elements)
      .sort((a, b) => {
        const ar = normalizedRect(a);
        const br = normalizedRect(b);
        return ar.x - br.x || area(a) - area(b);
      })
      .forEach((el) => {
        if (isMetaText(textValue(el))) return;
        mark(el);
        count += 1;
      });
    return count > 0;
  }

  function markPreviewSenderPrefix(el: Element) {
    const value = textValue(el);
    const identity = previewIdentity(value);
    if (!identity) return false;

    const candidates = [el, ...textSurfaces(el)]
      .filter((candidate, index, all) => all.indexOf(candidate) === index)
      .filter((candidate) => {
        const candidateText = textValue(candidate);
        if (!candidateText) return false;
        if (candidateText === identity.prefix) return true;
        if (identity.colon && candidateText === `${identity.prefix}:`) return true;
        return false;
      })
      .sort((a, b) => area(a) - area(b));

    if (candidates.length) {
      mark(candidates[0]);
      return true;
    }

    // Never split or replace React-owned text nodes. When Messenger does not
    // expose the sender as its own element, accept a wider blur on the nearest
    // native surface so subsequent preview updates keep reconciling normally.
    mark(el);
    return true;
  }

  function markConversationRows() {
    const seen = new Set<string>();
    for (const row of document.querySelectorAll(THREAD_ROW_SEL)) {
      const href = row.getAttribute("href") || "";
      if (!href || seen.has(href) || !visible(row)) continue;
      seen.add(href);

      const rr = normalizedRect(row);
      row.querySelectorAll(VISUAL_SEL).forEach((el) => {
        if (!visible(el)) return;
        const r = normalizedRect(el);
        const leftAvatar = r.left < rr.left + 80 && r.width >= 20 && r.height >= 20;
        const rightReceipt =
          r.right > rr.right - 56 &&
          r.width >= 12 &&
          r.width <= 34 &&
          r.height >= 12 &&
          r.height <= 34;
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
      const firstLine: Element[] = [];
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

  function markThreadHeader(main: Element) {
    const mr = normalizedRect(main);
    const headerBottom = mr.top + 96;
    const actionStart = mr.right - 150;

    textLeaves(main).forEach((el) => {
      const r = normalizedRect(el);
      if (r.top >= mr.top && r.bottom <= headerBottom && r.left < actionStart) mark(el);
    });

    main.querySelectorAll(VISUAL_SEL).forEach((el) => {
      if (!visible(el)) return;
      const r = normalizedRect(el);
      if (
        r.top >= mr.top &&
        r.bottom <= headerBottom &&
        r.left < actionStart &&
        r.width >= 20 &&
        r.height >= 20
      ) {
        mark(el);
      }
    });
  }

  function markThreadMessages(main: Element) {
    main.querySelectorAll('[role="article"]').forEach((article) => {
      article.querySelectorAll("h3, h3 *").forEach((el) => {
        if (visible(el) && textValue(el)) mark(el);
      });

      article
        .querySelectorAll(
          'img[referrerpolicy="origin-when-cross-origin"], img[height="14"][width="14"][tabindex="-1"]',
        )
        .forEach((el) => {
          if (visible(el)) mark(el);
        });

      textLeaves(article).forEach((el) => {
        if (/\breplied to\b/i.test(textValue(el))) mark(el);
      });
    });

    textSurfaces(main).forEach((el) => {
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
      const main = mainPane();
      if (main) {
        markThreadHeader(main);
        markThreadMessages(main);
      }
    } finally {
      queueMicrotask(() => {
        suppressMutations = false;
      });
    }
  }

  // scan() is a full-document sweep with forced-layout reads, so cap it at
  // one pass per SCAN_MIN_GAP_MS instead of every animation frame during DOM
  // churn (trailing-edge: the last mutation in a burst always gets a scan).
  // The window where a freshly rendered name can show unblurred is bounded by
  // the gap; the pure-CSS blur rules in messenger.css don't wait on this scan.
  // A timeout queued before stop() may still fire — scan() no-ops via on().
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
      attributeFilter: ["aria-label", "href", "role", "src", "style"],
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
