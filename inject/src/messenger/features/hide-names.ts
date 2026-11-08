/* ----------------------- Hide names & avatars ------------------------- */
// Toggle marker attributes the injected CSS keys off of to blur contact
// names and avatars (Settings ▸ Privacy, View ▸ Hide Names and Avatars,
// Cmd+Shift+H). Names and avatars are marked separately so either can be
// hidden alone (Ref #364).
// Facebook's generated class names churn, so this keeps the selectors shallow
// and marks identity surfaces by stable roles, links, and layout shape.
import {
  hidesAvatars,
  hidesNames,
  isMetaText,
  locateSpan,
  mentionRanges,
  prefixRange,
  previewIdentity,
} from "../lib/privacy";

const IDENTITY_ATTR = "data-carrier-private-identity";
const AVATAR_ATTR = "data-carrier-private-avatar";
const THREAD_ROW_SEL = '[role="grid"] a[href*="/t/"], [role="navigation"] a[href*="/t/"]';
const TEXT_SURFACE_SEL = "span, div, h1, h2, h3, h4";
const VISUAL_SEL = 'img, svg, image, [style*="background-image"]';
// Sender names that share a text node with the message, hidden through the
// CSS Custom Highlight API so React-owned text is never split (messenger.css).
const PREFIX_HIGHLIGHT = "carrier-private-identity";
// WebKit paints no highlight on user-select: none text and keeps an explicit
// -webkit-text-fill-color, both of which Messenger sets on previews. The text
// elements under a name range get those reset (messenger.css).
const PREFIX_HOST_ATTR = "data-carrier-private-prefix";

export function initHideNames() {
  const html = document.documentElement;
  let observer: MutationObserver | null = null;
  let pending = false;
  let suppressMutations = false;

  const namesHidden = () => hidesNames(window.__CHATPANE_SETTINGS__);
  const avatarsHidden = () => hidesAvatars(window.__CHATPANE_SETTINGS__);
  const on = () => namesHidden() || avatarsHidden();

  function textValue(el: Element | null | undefined) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function visible(el: Element | null | undefined) {
    const r = el?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el!);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }

  /** A picture by what it renders: an image element, or any background
   * image however it is applied (inline shorthand, class, inherited rule). */
  function isPicture(el: Element) {
    if (el.matches("img, svg, image")) return true;
    return /url\(/.test(getComputedStyle(el).backgroundImage || "");
  }

  /** A name or other identifying text. Pictures inside it are avatars too, so
   * Hide Avatars alone still covers a face nested in a heading or attribution. */
  function mark(el: Element | null | undefined) {
    if (!el?.setAttribute) return;
    want(el, IDENTITY_ATTR);
    for (const node of [el, ...el.querySelectorAll("*")]) {
      // Emoji in a name are pictures too, but not faces.
      if (isPicture(node) && node.getBoundingClientRect().width >= 20) markAvatar(node);
    }
  }

  /** An avatar, group picture or read-receipt face. */
  function markAvatar(el: Element | null | undefined) {
    if (el?.setAttribute) want(el, AVATAR_ATTR);
  }

  // A scan collects the markers and name ranges it wants, then applies only
  // the difference: re-marking every blurred element on each pass restyled
  // and repainted them all, which made hovering in a conversation lag.
  const MARKER_ATTRS = [IDENTITY_ATTR, AVATAR_ATTR, PREFIX_HOST_ATTR];
  let wanted = new Map<Element, Set<string>>();
  let wantedRanges: Range[] = [];
  let appliedRanges: Range[] = [];

  function want(el: Element, attr: string) {
    let attrs = wanted.get(el);
    if (!attrs) {
      attrs = new Set();
      wanted.set(el, attrs);
    }
    attrs.add(attr);
  }

  const sameRange = (a: Range, b: Range) =>
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset;

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
    const unchanged =
      wantedRanges.length === appliedRanges.length &&
      wantedRanges.every((range, i) => sameRange(range, appliedRanges[i]!));
    if (highlights && !unchanged) {
      if (wantedRanges.length) highlights.set(PREFIX_HIGHLIGHT, new Highlight(...wantedRanges));
      else highlights.delete(PREFIX_HIGHLIGHT);
    }
    appliedRanges = wantedRanges;
  }

  function clearMarkers() {
    wanted = new Map();
    wantedRanges = [];
    applyMarkers();
  }

  function textSurfaces(root: Element) {
    const out: Element[] = [];
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

  function area(el: Element) {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  }

  function deepest(elements: Element[]) {
    return elements.filter((el) => !elements.some((other) => other !== el && el.contains(other)));
  }

  function markDeepest(elements: Element[]) {
    let count = 0;
    deepest(elements)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.x - br.x || area(a) - area(b);
      })
      .forEach((el) => {
        if (isMetaText(textValue(el))) return;
        mark(el);
        count += 1;
      });
    return count > 0;
  }

  /** The sender prefix and any @mentions in a preview line. Names with an
   * element of their own are blurred; names inside the message's text node
   * get a highlight range, which leaves React's text alone. */
  function markPreviewNames(el: Element) {
    const identity = previewIdentity(textValue(el));
    let prefixDone = !identity;
    if (identity) {
      const candidate = [el, ...textSurfaces(el)]
        .filter((candidate) => {
          // An element that also holds the message's emoji or image is not
          // just the name; blurring it would hide content.
          if (candidate.querySelector(VISUAL_SEL)) return false;
          const candidateText = textValue(candidate);
          return (
            candidateText === identity.prefix ||
            (identity.colon && candidateText === `${identity.prefix}:`)
          );
        })
        .sort((a, b) => area(a) - area(b))[0];
      if (candidate) {
        mark(candidate);
        prefixDone = true;
      }
    }

    const nodes: Text[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const texts = nodes.map((node) => node.data);
    const joined = texts.join("");
    const ranges = mentionRanges(joined);
    if (identity && !prefixDone) {
      const prefix = prefixRange(joined, identity.prefix);
      if (prefix) ranges.push(prefix);
      else ranges.length = 0;
    }
    if (!ranges.length) {
      // A prefix that is in neither its own element nor the text nodes.
      if (identity && !prefixDone) mark(el);
      return;
    }
    // Without the Highlight API, blur the whole line rather than show names.
    if (!highlightRanges(nodes, texts, ranges)) mark(el);
  }

  function highlightRanges(nodes: Text[], texts: string[], ranges: [number, number][]) {
    if (!globalThis.CSS?.highlights || typeof Highlight === "undefined") return false;
    for (const [from, to] of ranges) {
      const span = locateSpan(texts, from, to);
      for (const node of nodes.slice(span.start[0], span.end[0] + 1)) {
        if (node.parentElement) want(node.parentElement, PREFIX_HOST_ATTR);
      }
      const range = document.createRange();
      range.setStart(nodes[span.start[0]]!, span.start[1]);
      range.setEnd(nodes[span.end[0]]!, span.end[1]);
      wantedRanges.push(range);
    }
    return true;
  }

  function markConversationRows() {
    const seen = new Set<string>();
    for (const row of document.querySelectorAll(THREAD_ROW_SEL)) {
      const href = row.getAttribute("href") || "";
      if (!href || seen.has(href) || !visible(row)) continue;
      seen.add(href);

      const rr = row.getBoundingClientRect();
      row.querySelectorAll(VISUAL_SEL).forEach((el) => {
        if (!visible(el)) return;
        const r = el.getBoundingClientRect();
        const leftAvatar = r.left < rr.left + 80 && r.width >= 20 && r.height >= 20;
        const rightReceipt =
          r.right > rr.right - 56 &&
          r.width >= 12 &&
          r.width <= 34 &&
          r.height >= 12 &&
          r.height <= 34;
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
      const firstLine: Element[] = [];
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

  function markThreadHeader(main: Element) {
    const mr = main.getBoundingClientRect();
    const headerBottom = mr.top + 96;
    const actionStart = mr.right - 150;

    // Position first: the pane holds thousands of elements, and the style
    // reads in visible() are only worth doing for the few in the header.
    const inHeader = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top >= mr.top && r.bottom <= headerBottom && r.left < actionStart;
    };
    // Messages scrolled up under the header share its strip of the pane. The
    // message list is the nearest scrolling ancestor of a message; the header
    // sits outside it (though possibly inside an outer scroller).
    let list: Element | null = null;
    for (let a = main.querySelector('[role="article"]')?.parentElement; a && a !== main; ) {
      const overflow = getComputedStyle(a).overflowY;
      if (overflow === "auto" || overflow === "scroll") {
        list = a;
        break;
      }
      a = a.parentElement;
    }
    const scrolledContent = (el: Element) =>
      Boolean(el.closest('[role="article"]')) || Boolean(list?.contains(el));
    main.querySelectorAll(TEXT_SURFACE_SEL).forEach((el) => {
      if (!inHeader(el) || !visible(el) || el.closest('[contenteditable="true"]')) return;
      if (!textValue(el) || [...el.children].some((child) => textValue(child))) return;
      if (scrolledContent(el)) return;
      mark(el);
    });

    main.querySelectorAll(VISUAL_SEL).forEach((el) => {
      if (!inHeader(el) || !visible(el) || scrolledContent(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width >= 20 && r.height >= 20) markAvatar(el);
    });
  }

  /** A bare (non-whitespace) text node directly inside this element. */
  function hasBareText(el: Element) {
    return [...el.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim(),
    );
  }

  /**
   * Profile links whose name shares an element with a picture (bare text in
   * the link or in a picture-bearing descendant, or text on a link drawn as a
   * background image) have no element holding just the name, so mark the
   * whole link as a name. Names-only then blurs its picture too, erring on the
   * side of hiding; links whose name sits in its own element stay precise.
   */
  function markMixedProfileLinks(main: Element) {
    main
      .querySelectorAll(
        'a[href^="/"][href$="/"]:not([href*="/messages/"]), a[href*="/profile.php"]',
      )
      .forEach((link) => {
        if (!visible(link)) return;
        // Every picture in a profile link is an avatar, however it is drawn
        // (the CSS only sees inline backgrounds). Computed styles are read
        // once per element here, not again per text-bearing ancestor below.
        const nodes = [link, ...link.querySelectorAll("*")];
        const pictures = nodes.filter(isPicture);
        pictures.forEach(markAvatar);
        if (!textValue(link) || !pictures.length) return;
        const textBesidePicture =
          pictures[0] === link ||
          hasBareText(link) ||
          nodes.some((el) => hasBareText(el) && pictures.some((pic) => el.contains(pic)));
        if (textBesidePicture) mark(link);
      });
  }

  function markThreadMessages(main: Element) {
    main.querySelectorAll('[role="article"]').forEach((article) => {
      // Group sender labels are h4. (h3 holds call titles such as "Missed
      // audio call", which are not names.) The label's blur covers its
      // children; marking them too would nest blurs (messenger.css).
      article.querySelectorAll("h4").forEach((el) => {
        if (visible(el) && textValue(el)) mark(el);
      });

      article
        .querySelectorAll(
          'img[referrerpolicy="origin-when-cross-origin"], img[height="14"][width="14"][tabindex="-1"], a[href^="/"][href$="/"]:not([href*="/messages/"]) [style*="background-image"], a[href*="/profile.php"] [style*="background-image"]',
        )
        .forEach((el) => {
          if (!visible(el)) return;
          // Messenger serves faces, shared photos and reaction emoji with the
          // same referrer policy. Faces are small squares; photos are larger
          // and reaction emoji smaller.
          if (el.matches('img[referrerpolicy="origin-when-cross-origin"]')) {
            const r = el.getBoundingClientRect();
            const square = Math.abs(r.width - r.height) <= 2;
            if (!square || r.width < 20 || r.width > 64) return;
          }
          markAvatar(el);
        });
    });

    // "Kim replied to Tobias": find the phrase in text nodes, then blur the
    // largest attribution-sized element around it, which holds both names.
    // Walking text is far cheaper than measuring every element in the pane.
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!/\breplied to\b/i.test(node.data)) continue;
      let target: Element | null = null;
      for (let el = node.parentElement; el && el !== main; el = el.parentElement) {
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
      wanted = new Map();
      wantedRanges = [];
      if (on()) {
        markConversationRows();
        const main = mainPane();
        if (main) {
          markThreadHeader(main);
          markThreadMessages(main);
          markMixedProfileLinks(main);
        }
      }
      applyMarkers();
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
    observer = new MutationObserver((records) => {
      // Text changes matter only in conversation rows, where a preview is
      // rewritten in place and a highlight range would not follow a new
      // sender's name. Messenger rewrites other text constantly, and
      // rescanning for it kept the page busy (a full core).
      if (
        records.some(
          (record) =>
            record.type !== "characterData" || record.target.parentElement?.closest(THREAD_ROW_SEL),
        )
      ) {
        schedule();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
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
    html.toggleAttribute("data-carrier-hide-names", namesHidden());
    html.toggleAttribute("data-carrier-hide-avatars", avatarsHidden());
    if (on()) {
      start();
      schedule();
    } else {
      stop();
    }
  };
  apply();
  window.addEventListener("chatpane:settings", apply);
}
