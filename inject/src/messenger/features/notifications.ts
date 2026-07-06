/* --------------------- Native message notifications ------------------- */
// Bridge the page's Web Notification API to native OS notifications so new
// messages notify you even when Carrier is in the background.
import { diag, invoke } from "../bridge";
import { dndActive } from "../lib/dnd";

interface CarrierNotificationInstance {
  title?: string;
  onclick: ((e: Event) => unknown) | null;
  close: () => void;
}

export function initNotificationBridge() {
  if (!window.__TAURI_INTERNALS__) return;
  // Keep the page convinced notifications are granted (below) so Facebook keeps
  // firing them; this also flips on the OS-level grant the native side needs.
  invoke("plugin:notification|is_permission_granted")
    ?.then?.((granted) => granted || invoke("plugin:notification|request_permission"))
    ?.catch?.(() => diag("notify.permission", "notification permission invoke failed"));

  // Render the sender's avatar — Facebook puts its (remote fbcdn) URL on the
  // Notification's `icon` — to a small PNG data URL, so the native side can
  // attach it without re-fetching: the page already holds Facebook's session
  // and the cached image. Best-effort; resolves to "" if the image can't be
  // read (e.g. the canvas is tainted) and the notification then shows text only.
  const avatarToDataUrl = (url: string | undefined) =>
    new Promise<string>((resolve) => {
      if (!url) return resolve("");
      const img = new Image();
      img.crossOrigin = "anonymous";
      let settled = false;
      const done = (v: string) => {
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
          c.getContext("2d")!.drawImage(img, 0, 0, size, size);
          done(c.toDataURL("image/png"));
        } catch (_) {
          done("");
        }
      };
      img.onerror = () => done("");
      img.src = url;
    });

  // Clicking a native notification routes back here by id: bring the
  // conversation up by invoking the original `onclick` Facebook assigned to its
  // Notification (that's what opens the right thread). A small bounded map keeps
  // those handlers alive between "notification shown" and "notification clicked".
  let notifySeq = 0;
  const notifyHandlers = new Map<number, CarrierNotificationInstance>();
  window.__carrierNotifyClick = (id: number) => {
    const n = notifyHandlers.get(id);
    if (!n) return;
    notifyHandlers.delete(id);
    try {
      window.focus();
    } catch (_) {}
    try {
      // Facebook's onclick expects the click Event (it can read it / call
      // preventDefault); a native notification click carries no DOM event, so
      // hand it a synthetic one. Called as `n.onclick(...)` so `this` stays
      // bound to the Notification instance.
      n.onclick?.(new Event("click"));
    } catch (_) {}
  };

  function CarrierNotification(
    this: CarrierNotificationInstance,
    title?: string,
    options: { icon?: string; body?: string } | null = {},
  ) {
    const opts = options || {};
    const s = window.__CARRIER_SETTINGS__ || {};
    // Surface every new-message notification Facebook fires — even while
    // Carrier is focused (the native side presents it as a banner regardless of
    // focus) — unless notifications are muted or DND is active. (The
    // auto-refresh nudge below still runs when muted/DND so the window keeps
    // catching up.)
    if (!s.mute_notifications && !dndActive(s)) {
      const id = ++notifySeq;
      // Facebook assigns `this.onclick` right after construction; hold onto
      // this instance so the click route can call it. Cap the map so a long
      // session of unclicked notifications can't grow it without bound.
      notifyHandlers.set(id, this);
      if (notifyHandlers.size > 50) notifyHandlers.delete(notifyHandlers.keys().next().value!);
      // Hide preview: replace the sender name and message text with a generic
      // notification, and skip the avatar so the sender's face never leaks.
      const hidePreview = s.hide_notification_preview;
      avatarToDataUrl(hidePreview ? "" : opts.icon).then((icon) => {
        invoke("plugin:event|emit", {
          event: "carrier:notify",
          payload: {
            id,
            title: hidePreview ? "Messenger" : String(title || "Messenger"),
            body: hidePreview ? "New message" : String(opts.body || ""),
            icon,
          },
        })?.catch?.(() => diag("notify.emit", "carrier:notify emit failed"));
      });
    }
    // Nudge the auto-refresh so the conversation view catches up even when
    // Facebook's in-WebView live sync stalls.
    try {
      window.__carrierOnNotification?.();
    } catch (_) {}
    this.title = title;
    this.onclick = null;
    this.close = () => {};
  }
  CarrierNotification.permission = "granted";
  CarrierNotification.requestPermission = (cb?: (permission: string) => void) => {
    if (cb) cb("granted");
    return Promise.resolve("granted");
  };
  try {
    Object.defineProperty(window, "Notification", {
      value: CarrierNotification,
      writable: true,
      configurable: true,
    });
  } catch (_) {}
}
