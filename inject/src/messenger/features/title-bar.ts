/* ---------------------------- Title bar strip --------------------------- */
// Messenger windows have no separate title bar (src-tauri/src/title_bar.rs).
// The native side owns the strip's state and restates it as the window
// enters or leaves full screen, zooms or maximizes; the first state arrives
// before the page's first paint (window.__CHATPANE_TITLE_BAR__).
//
// - macOS: the native window buttons float over the top of the chat list,
//   which keeps the strip free under them (messenger.css). The photo viewer is
//   reported, as it gets a title bar of its own while it's open.
// - Windows, and Linux windows the compositor doesn't tile: Chatpane draws
//   minimize, maximize and close at the top right, over a strip above the chat that drags the
//   window: natively on Windows (WebView2 app-region), through the native side
//   on Linux. The chat list starts at the top.
import { t } from "../../i18n";
import { diag } from "../bridge";

type Controls = "windows" | "linux";

interface TitleBarState {
  inset: number;
  controls: Controls | null;
  /** Tiling window managers can't minimize, and most can't maximize. */
  minimize: boolean;
  maximize: boolean;
  maximized: boolean;
}

const INSET_VAR = "--chatpane-title-bar-inset";
const KIND_ATTR = "data-chatpane-title-bar";
const STRIP_ID = "chatpane-title-strip";
const CONTROLS_ID = "chatpane-window-controls";

let state: TitleBarState | null = null;

function control(action: Parameters<typeof chatpaneWindowControl>[0]) {
  chatpaneWindowControl(action)?.catch?.(() =>
    diag("title-bar.control", "chatpane:window-control emit failed"),
  );
}

const ICONS = {
  minimize: '<path d="M2 6h8" />',
  maximize: '<rect x="2" y="2" width="8" height="8" rx="1" />',
  restore:
    '<rect x="2" y="4" width="6" height="6" rx="1" /><path d="M4.5 4V3a1 1 0 0 1 1-1H9a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H8" />',
  close: '<path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />',
};

function icon(name: keyof typeof ICONS) {
  return `<svg viewBox="0 0 12 12" aria-hidden="true">${ICONS[name]}</svg>`;
}

function buildControls(): HTMLElement {
  const box = document.createElement("div");
  box.id = CONTROLS_ID;
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", t("page.window.controls"));
  const button = (name: string, label: string, action: Parameters<typeof control>[0]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.control = name;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.addEventListener("click", () => control(action));
    return b;
  };
  box.append(
    button("minimize", t("page.window.minimize"), "minimize"),
    button("maximize", t("page.window.maximize"), "toggle-maximize"),
    button("close", t("page.window.close"), "close"),
  );
  return box;
}

function buildStrip(): HTMLElement {
  const strip = document.createElement("div");
  strip.id = STRIP_ID;
  strip.setAttribute("aria-hidden", "true");
  // Windows drags through app-region (messenger.css), and WebView2 then keeps
  // the press from the page; otherwise (Linux, or an older WebView2) the native
  // side moves the window.
  strip.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !state?.controls) return;
    event.preventDefault();
    control(event.detail === 2 && state.maximize ? "toggle-maximize" : "drag");
  });
  return strip;
}

// The strip sits above the chat only: the chat list starts at the top.
let stripObserver: ResizeObserver | null = null;
let observedMain: Element | null = null;
function placeStrip() {
  const strip = document.getElementById(STRIP_ID);
  if (!strip) return;
  const main = document.querySelector('[role="main"]');
  const left = main ? Math.max(0, Math.round(main.getBoundingClientRect().left)) : 0;
  strip.style.left = `${left}px`;
  if (main !== observedMain) {
    stripObserver?.disconnect();
    observedMain = main;
    if (main) {
      stripObserver ??= new ResizeObserver(placeStrip);
      stripObserver.observe(main);
    }
  }
}

function apply(next: TitleBarState) {
  state = next;
  const root = document.documentElement;
  if (!root) return;
  root.style.setProperty(INSET_VAR, `${next.inset}px`);
  const kind = next.inset > 0 ? (next.controls ?? "macos") : null;
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
  if (!strip.isConnected || !controls.isConnected) root.append(strip, controls);
  const maximize = controls.querySelector<HTMLButtonElement>('[data-control="maximize"]');
  const minimize = controls.querySelector<HTMLButtonElement>('[data-control="minimize"]');
  const close = controls.querySelector<HTMLButtonElement>('[data-control="close"]');
  if (minimize && !minimize.innerHTML) minimize.innerHTML = icon("minimize");
  if (close && !close.innerHTML) close.innerHTML = icon("close");
  if (minimize) minimize.hidden = !next.minimize;
  if (maximize) maximize.hidden = !next.maximize;
  if (maximize) {
    const name = next.maximized ? "restore" : "maximize";
    if (maximize.dataset.icon !== name) {
      maximize.dataset.icon = name;
      maximize.innerHTML = icon(name);
      const label = next.maximized ? t("page.window.restore") : t("page.window.maximize");
      maximize.setAttribute("aria-label", label);
      maximize.title = label;
    }
  }
  placeStrip();
}

/** How far Messenger's own top-right controls (the photo viewer's) keep clear. */
export function windowControlsInset(): number {
  return state?.controls && state.inset > 0 ? state.inset : 0;
}

export function initTitleBar() {
  const initial = window.__CHATPANE_TITLE_BAR__;
  if (!initial) return;
  window.__chatpaneTitleBar = (next) => apply(next as TitleBarState);
  // Before the first paint, so Messenger's first layout keeps the strip; the
  // controls follow once <body> is there.
  const root = document.documentElement;
  if (root) {
    root.style.setProperty(INSET_VAR, `${initial.inset}px`);
    if (initial.inset > 0) root.setAttribute(KIND_ATTR, initial.controls ?? "macos");
  }
  const start = () => apply(state ?? initial);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else start();
  window.addEventListener("resize", placeStrip, { passive: true });
  // Messenger replaces its layout as it loads and navigates: keep the strip
  // attached and over the chat. A query a second, skipped while hidden.
  setInterval(() => {
    if (document.hidden || !state?.controls || state.inset <= 0) return;
    if (!document.getElementById(STRIP_ID)?.isConnected) apply(state);
    else if (document.querySelector('[role="main"]') !== observedMain) placeStrip();
  }, 1000);
}

// Unknown until the first report, which always goes out: a new page may
// replace an open viewer while the native side still has its title bar up.
let viewerReported: boolean | null = null;

/** macOS: tell the native side whether Messenger's photo viewer is open. */
export function reportMediaViewer(open: boolean) {
  if (!/Mac/.test(navigator.platform) || !window.__CHATPANE_TITLE_BAR__) return;
  if (open === viewerReported) return;
  viewerReported = open;
  chatpaneMediaViewer(open)?.catch?.(() =>
    diag("title-bar.viewer", "chatpane:media-viewer emit failed"),
  );
}
