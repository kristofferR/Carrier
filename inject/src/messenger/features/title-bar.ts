/* ------------------------- macOS title bar strip ----------------------- */
// On macOS Messenger windows have no separate title bar: the window buttons
// float over the top of the chat list, which keeps a strip free under them
// (messenger.css). The native side owns the strip's size
// (src-tauri/src/macos/title_bar.rs) and restates it as the window enters or
// leaves full screen; this sets it before the page first paints, and reports
// the photo viewer, which gets a title bar of its own while it's open.
import { diag, invoke } from "../bridge";

const INSET_VAR = "--carrier-title-bar-inset";

const hasTitleBarStrip = () => typeof window.__CARRIER_TITLE_BAR_INSET__ === "number";

export function initTitleBar() {
  const inset = window.__CARRIER_TITLE_BAR_INSET__;
  if (typeof inset !== "number") return;
  const apply = (root: HTMLElement) => {
    if (!root.style.getPropertyValue(INSET_VAR)) root.style.setProperty(INSET_VAR, `${inset}px`);
  };
  if (document.documentElement) {
    apply(document.documentElement);
    return;
  }
  const wait = new MutationObserver(() => {
    if (!document.documentElement) return;
    wait.disconnect();
    apply(document.documentElement);
  });
  wait.observe(document, { childList: true });
}

// Unknown until the first report, which always goes out: a new page may
// replace an open viewer while the native side still has its title bar up.
let viewerReported: boolean | null = null;

/** Tell the native side whether Messenger's photo viewer is open. */
export function reportMediaViewer(open: boolean) {
  if (!hasTitleBarStrip() || open === viewerReported) return;
  const label = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  if (!label) return;
  viewerReported = open;
  invoke("plugin:event|emit", {
    event: "carrier:media-viewer",
    payload: { window: label, open },
  })?.catch?.(() => diag("title-bar.viewer", "carrier:media-viewer emit failed"));
}
