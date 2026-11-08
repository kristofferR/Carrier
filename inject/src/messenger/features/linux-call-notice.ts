/* --------------------- Linux call availability notice ---------------------- */
// WebKitGTK builds ship without WebRTC, so Messenger can't place calls on Linux
// and greys out its call buttons with a terse "not supported on this browser"
// tooltip. Hovering either button explains why instead and links to #345.
import { openUrl } from "../bridge";
import { engineSupportsCalls } from "../lib/calls";

const CALL_BUTTON_LABELS = [
  "Start a voice call",
  "Start a video call",
  "Voice calling is not supported on this browser",
  "Video calling is not supported on this browser",
];
const CALL_BUTTONS = CALL_BUTTON_LABELS.map(
  (label) => `[role="button"][aria-label="${label}"]`,
).join(", ");
const ISSUE_URL = "https://github.com/kristofferR/Carrier/issues/345";
const WIDTH = 280;
const GAP = 8;

const inside = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

export function initLinuxCallNotice() {
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
    <p>The browser engine Chatpane uses on Linux is missing the calling support Messenger
      needs, so voice and video calls can't start here.</p>
    <button type="button">Read more about it</button>
  </section>`;
  root.querySelector("button")!.addEventListener("click", () => openUrl(ISSUE_URL));

  // Messenger's own tooltip on the same button would overlap the notice.
  const hideFacebookTooltips = document.createElement("style");
  hideFacebookTooltips.textContent = '[role="tooltip"] { visibility: hidden !important; }';

  let anchor: Element | null = null;
  const hide = () => {
    if (!anchor) return;
    anchor = null;
    host.remove();
    hideFacebookTooltips.remove();
    document.removeEventListener("pointermove", track, true);
  };
  // Stay open while the pointer is on the button, the notice, or the gap
  // between them, so the link can be reached.
  function track(event: PointerEvent) {
    if (!anchor?.isConnected) return hide();
    const button = anchor.getBoundingClientRect();
    const notice = host.getBoundingClientRect();
    const zone = new DOMRect(
      Math.min(button.left, notice.left),
      button.top,
      Math.max(button.right, notice.right) - Math.min(button.left, notice.left),
      notice.bottom - button.top,
    );
    if (!inside(zone, event.clientX, event.clientY)) hide();
  }
  const show = (button: Element) => {
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

  // A disabled button may not receive pointer events itself, so also look
  // inside the element under the pointer and confirm by position.
  document.addEventListener(
    "pointerover",
    (event) => {
      if (!(event.target instanceof Element) || event.target === host) return;
      const button = event.target.closest(CALL_BUTTONS) ?? event.target.querySelector(CALL_BUTTONS);
      if (button && inside(button.getBoundingClientRect(), event.clientX, event.clientY))
        show(button);
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target !== host) hide();
    },
    true,
  );
  document.documentElement.addEventListener("pointerleave", hide);
  window.addEventListener("blur", hide);
}
