/* --------------------- Download anchors + DOM sweeps ------------------ */
// Facebook's image/file viewer "Download" button is an `<a download target="_blank">`
// pointing at a blob: URL. On macOS the target="_blank" makes wry load the blob in the
// webview (its new-window path drops the `download` attribute), so the file just opens
// instead of saving — and a `_blank` activation isn't cancelable from the DOM click,
// so intercepting alone doesn't help. Fix it in two steps:
//   1. Strip `target` off download anchors as they appear, removing the new-window
//      path so a click becomes an ordinary, cancelable in-page activation.
//   2. Intercept that click and run downloadSrc() — the same fetch -> untargeted
//      anchor -> Rust `on_download` path the working right-click "Download" uses.
import { toast } from "../bridge";
import { downloadSrc } from "./context-menu";

const stripDlTarget = (a: Node | null) => {
  const el = a as Element | null;
  if (el?.matches?.("a[download][target]")) {
    el.removeAttribute("target");
    el.removeAttribute("rel");
  }
};
const sweepDlAnchors = (root: Element) => {
  stripDlTarget(root);
  root.querySelectorAll?.("a[download][target]").forEach(stripDlTarget);
};

// One shared document-wide observer runs every registered added-node sweep
// (download anchors here, spellcheck elsewhere), debounced over a queue of added
// roots so Facebook's constant DOM churn costs one batched pass instead of a
// sweep per mutation record. The `target`/`download` *attribute* branch stays
// synchronous: a debounce there would leave a re-targeted anchor clickable,
// and stripDlTarget is a cheap match, no querySelectorAll. While the window
// is hidden nothing observed here is user-reachable (no clicks, no typing),
// so the observer disconnects entirely and a full re-sweep on show catches up.
const addedNodeSweeps: ((root: Element) => void)[] = [];
const queuedSweepRoots = new Set<Element>();
let sweepTimer = 0;
const runSweeps = () => {
  sweepTimer = 0;
  const roots = [...queuedSweepRoots];
  queuedSweepRoots.clear();
  for (const root of roots) {
    if (!root.isConnected) continue;
    for (const fn of addedNodeSweeps) fn(root);
  }
};
const sweepObserver = new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === "attributes") stripDlTarget(m.target);
    else for (const n of m.addedNodes) if (n.nodeType === 1) queuedSweepRoots.add(n as Element);
  }
  if (!sweepTimer && queuedSweepRoots.size) sweepTimer = setTimeout(runSweeps, 50);
});
const observeSweeps = () =>
  sweepObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["target", "download"],
  });

/** Run `fn` over every batch of freshly added DOM roots (shared observer). */
export function registerAddedNodeSweep(fn: (root: Element) => void) {
  addedNodeSweeps.push(fn);
}

export function initDownloadAnchors() {
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
      const a = (e.target as Element | null)?.closest?.("a[download]") as HTMLAnchorElement | null;
      const href = a?.href;
      if (!a || !href || !/^(blob:|data:|https?:)/i.test(href)) return;
      // downloadSrc() creates this one-shot anchor to enter Tauri's native
      // download pipeline. Intercepting it again would recurse forever, never
      // reach the WebView hook, and continuously reset the success toast.
      if (a.hasAttribute("data-carrier-native-download")) return;
      a.removeAttribute("target");
      e.preventDefault();
      e.stopImmediatePropagation();
      downloadSrc(href, a.getAttribute("download") || "download")
        .then(() => toast("Saved to Downloads"))
        .catch(() => toast("Download failed"));
    },
    true,
  );
}
