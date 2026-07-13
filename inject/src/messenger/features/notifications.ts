/* --------------------- Native message notifications ------------------- */
// Bridge the page's Web Notification API to native OS notifications so new
// messages notify you even when Carrier is in the background.
import { diag, invoke } from "../bridge";
import {
  ConversationNotificationTracker,
  isOwnMessagePreview,
  notificationTextMatches,
  pageNotificationMatches,
} from "../lib/notification-fallback";
import { threadIdFromHref } from "../lib/threads";
import { chatRows } from "./conversation-actions";

interface CarrierNotificationInstance {
  title?: string;
  onclick: ((e: Event) => unknown) | null;
  close: () => void;
}

const FALLBACK_DELAY_MS = 1500;
const PAGE_NOTIFICATION_MATCH_MS = 2000;
const FALLBACK_POLL_MS = 1000;
const INITIAL_ROW_STABILITY_MS = 2000;

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
  const notifyHandlers = new Map<number, () => void>();
  window.__carrierNotifyClick = (id: number) => {
    const handler = notifyHandlers.get(id);
    notifyHandlers.delete(id);
    try {
      window.focus();
    } catch (_) {}
    try {
      handler?.();
    } catch (_) {}
  };

  const emitNotification = (title: string, body: string, icon: string, onClick: () => void) => {
    const id = ++notifySeq;
    notifyHandlers.set(id, onClick);
    if (notifyHandlers.size > 50) notifyHandlers.delete(notifyHandlers.keys().next().value!);
    invoke("plugin:event|emit", {
      event: "carrier:notify",
      payload: { id, title, body, icon },
    })?.catch?.(() => diag("notify.emit", "carrier:notify emit failed"));
  };

  interface PendingFallback {
    timer: number;
    title: string;
    body: string;
  }
  const pendingFallbacks = new Map<string, PendingFallback>();
  let unmatchedPageNotification: { at: number; title: string; body: string } | null = null;

  // Facebook may construct its Notification just before or just after its
  // conversation row changes. Pair the two signals so the row-driven safety
  // net below never duplicates Facebook's normal native notification.
  const markPageNotification = (title: string, body: string) => {
    for (const [key, pending] of pendingFallbacks) {
      if (!notificationTextMatches(title, body, pending.title, pending.body)) continue;
      clearTimeout(pending.timer);
      pendingFallbacks.delete(key);
      unmatchedPageNotification = null;
      return;
    }
    unmatchedPageNotification = { at: Date.now(), title, body };
  };

  function CarrierNotification(
    this: CarrierNotificationInstance,
    title?: string,
    options: { icon?: string; body?: string } | null = {},
  ) {
    const opts = options || {};
    const s = window.__CARRIER_SETTINGS__ || {};
    // Content-free breadcrumb: proves Facebook fired a Notification at all
    // (the unread badge rides a separate path, so "badge but no banner"
    // reports need this to split page-side from native-side failures).
    diag(
      "notify.fired",
      `page constructed a Notification (visibility: ${document.visibilityState})`,
    );
    markPageNotification(String(title || "Messenger"), String(opts.body || ""));
    // Surface every new-message notification Facebook fires — even while
    // Carrier is focused (the native side presents it as a banner regardless of
    // focus) — unless notifications are muted. (The auto-refresh nudge below
    // still runs when muted so the window keeps catching up.)
    if (!s.mute_notifications) {
      // Facebook assigns `this.onclick` right after construction; the callback
      // below captures this instance so a native click can call it later.
      // Hide preview: replace the sender name and message text with a generic
      // notification, and skip the avatar so the sender's face never leaks.
      const hidePreview = s.hide_notification_preview;
      avatarToDataUrl(hidePreview ? "" : opts.icon).then((icon) => {
        emitNotification(
          hidePreview ? "Messenger" : String(title || "Messenger"),
          hidePreview ? "New message" : String(opts.body || ""),
          icon,
          () => {
            // Facebook's onclick expects the click Event (it can read it / call
            // preventDefault); a native notification click carries no DOM
            // event, so hand it a synthetic one. Called through the captured
            // instance so `this` stays bound to the Notification.
            this.onclick?.(new Event("click"));
          },
        );
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

  // Meta no longer reliably constructs Web Notifications for Messenger. Use
  // the conversation list as the source of truth: prime existing unread rows,
  // then notify only when an unread conversation's preview signature changes.
  // This is the modern Caprine/Wheemer strategy, adapted to Carrier's stable
  // role/link selectors and kept as a delayed fallback to the page bridge.
  const conversationTracker = new ConversationNotificationTracker();

  const conversationFromLink = (link: HTMLAnchorElement) => {
    const id = threadIdFromHref(link?.getAttribute("href"));
    if (!id) return null;
    const row = link.closest('[role="row"]') || link;
    const leaves = [...row.querySelectorAll<HTMLElement>("span")]
      .filter((el) => {
        if (el.getAttribute("aria-hidden") === "true" || el.closest("abbr")) return false;
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) return false;
        // Keep only the deepest text surface so nested Messenger wrappers do
        // not duplicate the sender or preview.
        for (const child of el.children) {
          if ((child.textContent || "").trim()) return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.y - br.y || ar.x - br.x;
      });
    const values: string[] = [];
    for (const el of leaves) {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text && values.at(-1) !== text) values.push(text);
    }
    const image = row.querySelector<HTMLImageElement>("img[src]");
    let unread = false;
    for (const span of row.querySelectorAll("span")) {
      const weight = Number.parseInt(getComputedStyle(span).fontWeight, 10) || 0;
      if (weight >= 600 && (span.textContent || "").trim().length > 1) {
        unread = true;
        break;
      }
    }
    return {
      key: id,
      threadPath: `/t/${id}/`,
      title: (values[0] || "Messenger").slice(0, 80),
      body: (values[1] || "New message").slice(0, 240),
      icon: image?.currentSrc || image?.src || "",
      unread,
    };
  };

  type Conversation = NonNullable<ReturnType<typeof conversationFromLink>>;

  const scheduleFallback = (conversation: Conversation, detectedAt: number) => {
    if (
      unmatchedPageNotification &&
      pageNotificationMatches(
        unmatchedPageNotification.at,
        detectedAt,
        PAGE_NOTIFICATION_MATCH_MS,
      ) &&
      notificationTextMatches(
        unmatchedPageNotification.title,
        unmatchedPageNotification.body,
        conversation.title,
        conversation.body,
      )
    ) {
      unmatchedPageNotification = null;
      return;
    }
    const previous = pendingFallbacks.get(conversation.key);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      const settings = window.__CARRIER_SETTINGS__ || {};
      if (settings.mute_notifications) {
        if (pendingFallbacks.get(conversation.key)?.timer === timer) {
          pendingFallbacks.delete(conversation.key);
        }
        return;
      }
      const hidePreview = settings.hide_notification_preview === true;
      avatarToDataUrl(hidePreview ? "" : conversation.icon).then((icon) => {
        // Keep the entry cancellable until the avatar conversion finishes. A
        // late page Notification must still win instead of producing a second
        // native notification while this fallback is in flight.
        if (pendingFallbacks.get(conversation.key)?.timer !== timer) return;
        pendingFallbacks.delete(conversation.key);
        diag(
          "notify.fallback",
          `unread row changed without a page Notification (visibility: ${document.visibilityState})`,
        );
        emitNotification(
          hidePreview ? "Messenger" : conversation.title,
          hidePreview ? "New message" : conversation.body,
          icon,
          () => {
            window.__carrierOpenThread?.(conversation.threadPath);
          },
        );
      });
    }, FALLBACK_DELAY_MS);
    pendingFallbacks.set(conversation.key, {
      timer,
      title: conversation.title,
      body: conversation.body,
    });
  };

  let scanRunning = false;
  let scanPending = false;
  let scannerReadyAt = 0;
  const scanUnreadConversations = () => {
    if (scanRunning) {
      scanPending = true;
      return;
    }
    scanRunning = true;
    try {
      const links = chatRows();
      // A grid can exist briefly before its rows hydrate. Do not prime an empty
      // list or the first real render would look like a burst of new messages.
      if (!links.length) return;
      if (!scannerReadyAt) scannerReadyAt = Date.now() + INITIAL_ROW_STABILITY_MS;
      const observed = links
        .map(conversationFromLink)
        .filter((conversation): conversation is Conversation => conversation !== null);
      const conversations = observed.filter(
        (conversation) => conversation.unread && !isOwnMessagePreview(conversation.body),
      );
      const changed = new Set(
        conversationTracker.observe(
          conversations.map(({ key, body, title }) => ({ key, signature: body || title })),
          observed.map(({ key }) => key),
        ),
      );
      // Keep refreshing the baseline while Messenger hydrates its initial row
      // text and unread styles; none of those startup mutations are messages.
      if (Date.now() < scannerReadyAt) return;
      if (!changed.size) return;
      const detectedAt = Date.now();
      try {
        window.__carrierOnNotification?.();
      } catch (_) {}
      for (const conversation of conversations) {
        if (changed.has(conversation.key)) scheduleFallback(conversation, detectedAt);
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
  const scheduleScan = () => {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanUnreadConversations();
    }, 120);
  };

  const startScanner = (grid: Element) => {
    const observer = new MutationObserver(scheduleScan);
    observer.observe(grid, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "src", "alt", "style"],
    });
    scanUnreadConversations();
    setInterval(scanUnreadConversations, FALLBACK_POLL_MS);
  };

  const grid = document.querySelector('[role="navigation"] [role="grid"]');
  if (grid) startScanner(grid);
  else {
    const waitForGrid = new MutationObserver(() => {
      const found = document.querySelector('[role="navigation"] [role="grid"]');
      if (!found) return;
      waitForGrid.disconnect();
      startScanner(found);
    });
    waitForGrid.observe(document.documentElement, { childList: true, subtree: true });
  }
}
