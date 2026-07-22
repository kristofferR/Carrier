/* --------------------- Native message notifications ------------------- */
// Bridge the page's Web Notification API to native OS notifications so new
// messages notify you even when Carrier is in the background.
import { diag, invoke } from "../bridge";
import { conversationTextParts, isUnreadConversationText } from "../lib/conversation-row";
import {
  ConversationNotificationTracker,
  isOwnMessagePreview,
  NotifiedSignatureStore,
  notificationDedupeKey,
  notificationTextMatches,
  PageNotificationQueue,
  PageNotificationReceiptStore,
  type PageNotificationSignal,
  StableMismatchTracker,
  UnreadArrivalTracker,
} from "../lib/notification-fallback";
import { threadIdFromHref } from "../lib/threads";
import { unreadCountFromTitle } from "../lib/unread";
import { chatRows } from "./conversation-actions";

interface CarrierNotificationInstance {
  title?: string;
  onclick: ((e: Event) => unknown) | null;
  close: () => void;
}

const FALLBACK_DELAY_MS = 2500;
const PAGE_NOTIFICATION_MATCH_MS = 3000;
const FALLBACK_POLL_VISIBLE_MS = 10_000;
const FALLBACK_POLL_HIDDEN_MS = 60_000;
const ROW_MUTATION_MATCH_MS = 2000;
// A delivered-fingerprint mismatch must remain unchanged for real elapsed time
// before it counts as new content (see StableMismatchTracker).
const MISMATCH_STABLE_MS = 1_000;
// How long after the first scan a zero unread count is treated as the title
// still hydrating rather than a real all-read baseline (see UnreadArrivalTracker).
const HYDRATION_SETTLE_MS = 10_000;

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
  // Keep ids unique across auto-refresh reloads so the native click route for
  // an older OS notification cannot collide with a fresh in-page handler.
  let notifySeq = Date.now() * 1000 + Math.floor(Math.random() * 1000);
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
    return handler !== undefined;
  };

  const emitNotification = (
    id: number,
    title: string,
    body: string,
    icon: string,
    dedupeKey: string,
    onClick: () => void,
    threadPath?: string,
  ) => {
    notifyHandlers.set(id, onClick);
    if (notifyHandlers.size > 50) notifyHandlers.delete(notifyHandlers.keys().next().value!);
    invoke("plugin:event|emit", {
      event: "carrier:notify",
      payload: { id, title, body, icon, dedupe_key: dedupeKey, thread_path: threadPath || "" },
    })?.catch?.(() => diag("notify.emit", "carrier:notify emit failed"));
  };

  // Attach (or refresh) the native-side route for an already-emitted
  // notification. Used when a page Notification fired before its conversation
  // row was known: the row-driven pairing supplies the route here so a click
  // still opens the conversation after the auto-refresh reload drops the
  // in-page handler map.
  const updateNotificationRoute = (id: number, threadPath: string) => {
    invoke("plugin:event|emit", {
      event: "carrier:notify-route",
      payload: { id, thread_path: threadPath },
    })?.catch?.(() => diag("notify.route", "carrier:notify-route emit failed"));
  };

  // The trackers die with every page reload, and the auto-refresh reloads an
  // unfocused window periodically. Persist delivered fingerprints so hydration
  // after a reload cannot replay old unread rows.
  const notificationStorage = (() => {
    try {
      return window.localStorage;
    } catch (_) {
      return null;
    }
  })();
  const notifiedStore = new NotifiedSignatureStore(notificationStorage);
  const pageNotificationReceipts = new PageNotificationReceiptStore(notificationStorage);

  interface PendingFallback {
    timer: number;
    title: string;
    body: string;
    threadPath: string;
    fingerprint: string;
  }
  const pendingFallbacks = new Map<string, PendingFallback>();
  const unmatchedPageNotifications = new PageNotificationQueue();

  // Facebook may construct its Notification just before or just after its
  // conversation row changes. Pair the two signals so the row-driven safety
  // net below never duplicates Facebook's normal native notification.
  // Persisting "delivered" is NOT this function's job: the native emit is
  // still waiting on the avatar conversion, and a reload in that window must
  // find no delivered state or the post-reload fallback would be suppressed
  // for a banner that never existed. The pairing is returned as `deliver` and
  // the emitter persists it right after the emit is actually queued.
  const markPageNotification = (
    title: string,
    body: string,
  ): {
    threadPath?: string;
    deliver?: { key: string; fingerprint: string; bodyHash?: string; expect?: string };
    signal?: PageNotificationSignal;
  } => {
    for (const [key, pending] of pendingFallbacks) {
      if (!notificationTextMatches(title, body, pending.title, pending.body)) continue;
      clearTimeout(pending.timer);
      pendingFallbacks.delete(key);
      return {
        threadPath: pending.threadPath,
        deliver: {
          key,
          fingerprint: pending.fingerprint,
          bodyHash: notificationDedupeKey("", pending.body),
          expect: notifiedStore.notifiedFingerprint(key),
        },
      };
    }
    // Page-first: no row matched yet. Return the queued signal so the emitter
    // can stamp it with the native id, letting the row-driven pairing route it.
    return { signal: unmatchedPageNotifications.add({ at: Date.now(), title, body }) };
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
    const pageMatch = markPageNotification(String(title || "Messenger"), String(opts.body || ""));
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
      const originalTitle = String(title || "Messenger");
      const originalBody = String(opts.body || "");
      // Reserve the native id synchronously and stamp it onto the queued
      // page-first signal now, before the avatar (async) resolves — otherwise a
      // fast row match could consume the signal before it learned its id and the
      // reload-safe route would never be attached.
      const id = ++notifySeq;
      if (pageMatch.signal) pageMatch.signal.nativeId = id;
      avatarToDataUrl(hidePreview ? "" : opts.icon).then((icon) => {
        // Persist only content-opaque matching hashes, and only now that the
        // native emit is actually queued. If a reload destroys the in-memory
        // page queue before the row appears, the next document's first
        // hydrated scan can still attach the route and suppress the fallback
        // copy — but a reload that lands during the avatar conversion (before
        // any banner exists) must leave no receipt, or the fallback would be
        // suppressed for a notification that was never shown. Likewise a
        // signal a row already consumed during the conversion is delivered
        // and done — a receipt written now would outlive it and swallow a
        // later same-text message.
        if (pageMatch.signal && !pageMatch.signal.matched) {
          pageNotificationReceipts.add(originalTitle, originalBody, id);
        }
        emitNotification(
          id,
          hidePreview ? "Messenger" : originalTitle,
          hidePreview ? "New message" : originalBody,
          icon,
          notificationDedupeKey(originalTitle, originalBody),
          () => {
            // Facebook's onclick expects the click Event (it can read it / call
            // preventDefault); a native notification click carries no DOM
            // event, so hand it a synthetic one. Called through the captured
            // instance so `this` stays bound to the Notification.
            this.onclick?.(new Event("click"));
          },
          pageMatch.threadPath,
        );
        // The banner is queued — only now is it safe to persist "delivered"
        // for the pairings this signal absorbed, whether the row matched
        // before construction (deliver) or during the conversion
        // (pendingDelivery, parked by scheduleFallback). Each write is
        // conditional on the store still holding what it held at pairing
        // time: if a NEWER message in the thread was delivered during the
        // conversion, this late write must not regress the store to the
        // older fingerprint (the next scan would mismatch and replay).
        if (
          pageMatch.deliver &&
          notifiedStore.notifiedFingerprint(pageMatch.deliver.key) === pageMatch.deliver.expect
        ) {
          notifiedStore.markNotified(
            pageMatch.deliver.key,
            pageMatch.deliver.fingerprint,
            pageMatch.deliver.bodyHash,
          );
        }
        if (pageMatch.signal) {
          pageMatch.signal.emitted = true;
          const delivery = pageMatch.signal.pendingDelivery;
          if (delivery && notifiedStore.notifiedFingerprint(delivery.key) === delivery.expect) {
            notifiedStore.markNotified(delivery.key, delivery.fingerprint, delivery.bodyHash);
          }
        }
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
    const text = conversationTextParts(
      [...row.querySelectorAll<HTMLElement>("span")].map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: el.textContent || "",
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          ariaHidden: el.getAttribute("aria-hidden") === "true",
          inAbbreviation: !!el.closest("abbr"),
          hasTextChild: [...el.children].some((child) => !!(child.textContent || "").trim()),
        };
      }),
    );
    const image = row.querySelector<HTMLImageElement>("img[src]");
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
      unread,
    };
  };

  type Conversation = NonNullable<ReturnType<typeof conversationFromLink>>;

  const scheduleFallback = (conversation: Conversation, detectedAt: number) => {
    const fingerprint = notificationDedupeKey(conversation.title, conversation.body);
    const bodyHash = notificationDedupeKey("", conversation.body);
    // Clear an older pending preview for this thread before checking the page
    // queue. Otherwise a page Notification can consume the new row while the
    // stale timer remains armed and later produces a duplicate.
    const previous = pendingFallbacks.get(conversation.key);
    if (previous) clearTimeout(previous.timer);
    const pageSignal = unmatchedPageNotifications.consumeMatching(
      conversation,
      detectedAt,
      PAGE_NOTIFICATION_MATCH_MS,
    );
    if (pageSignal) {
      // The page path already delivered this logical notification. If it fired
      // before this row was known, its native notification carries no route —
      // attach one now so a click survives the auto-refresh reload.
      if (pageSignal.nativeId !== undefined && conversation.threadPath) {
        updateNotificationRoute(pageSignal.nativeId, conversation.threadPath);
      }
      if (pageSignal.emitted) {
        notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
      } else {
        // The signal's native emit is still waiting on the avatar conversion.
        // A reload before it queues would leave no banner, so the delivered
        // state must ride the emitter, not this pairing.
        pageSignal.pendingDelivery = {
          key: conversation.key,
          fingerprint,
          bodyHash,
          expect: notifiedStore.notifiedFingerprint(conversation.key),
        };
      }
      pageNotificationReceipts.consumeMatching(conversation, detectedAt);
      pendingFallbacks.delete(conversation.key);
      return;
    }
    // Start the bounded avatar conversion during the pairing grace period.
    // Delivery therefore stays ahead of the four-second auto-refresh nudge.
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
      // Keep the entry cancellable until the avatar conversion finishes. A
      // late page Notification must still win instead of producing a second
      // native notification while this fallback is in flight.
      if (pendingFallbacks.get(conversation.key)?.timer !== timer) return;
      pendingFallbacks.delete(conversation.key);
      // Mark only at the actual delivery boundary. A reload before this point
      // must not persist a false "already delivered" state.
      notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
      diag(
        "notify.fallback",
        `unread row changed without a page Notification (visibility: ${document.visibilityState})`,
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
        conversation.threadPath,
      );
    }, FALLBACK_DELAY_MS);
    pendingFallbacks.set(conversation.key, {
      timer,
      title: conversation.title,
      body: conversation.body,
      threadPath: conversation.threadPath,
      fingerprint,
    });
  };

  let scanRunning = false;
  let scanPending = false;
  let mismatchConfirmationTimer: number | undefined;
  const unreadArrivals = new UnreadArrivalTracker(HYDRATION_SETTLE_MS);
  const mismatchTracker = new StableMismatchTracker(MISMATCH_STABLE_MS);
  // Arrivals attributed while their row preview was still empty. The
  // signature tracker only observes hydrated rows, so without carrying these
  // keys the later hydration would prime silently and the arrival would
  // never notify. Delivered once the row hydrates; dropped if it turns read.
  const pendingArrivalKeys = new Set<string>();
  // Threads this document has observed rendered hydrated-and-read. A row from
  // this set turning unread is a real arrival even during the settle window —
  // hydrating rows are never observed read first.
  const readObservedKeys = new Set<string>();
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
      const observed = links
        .map(conversationFromLink)
        .filter((conversation): conversation is Conversation => conversation !== null);
      const conversations = observed.filter(
        (conversation) => conversation.unread && !isOwnMessagePreview(conversation.body),
      );
      const detectedAt = Date.now();
      // "Read" means the row is no longer unread — not merely filtered from
      // `conversations` (an unread row whose preview currently shows your own
      // reply must keep its entry; hydration can flap the preview form).
      notifiedStore.observeRead(
        new Set(observed.filter(({ unread }) => unread).map(({ key }) => key)),
        observed.map(({ key }) => key),
        detectedAt,
      );
      // Only hydrated rows feed the signature tracker — in both directions.
      // Priming an unhydrated row with its title would report a "change" the
      // moment the body arrives and replay store-less threads after every
      // reload; and an unhydrated row proves nothing about read state, so it
      // must not evict a tracked signature either. The first hydrated
      // observation primes silently instead.
      const hydrated = conversations.filter(({ body }) => body.length > 0);
      const changed = new Set(
        conversationTracker.observe(
          hydrated.map(({ key, body }) => ({ key, signature: body })),
          observed.filter(({ body }) => body.length > 0).map(({ key }) => key),
        ),
      );
      for (const conversation of observed) {
        if (!conversation.unread && conversation.body.length > 0) {
          readObservedKeys.add(conversation.key);
        }
      }
      for (const key of unreadArrivals.observeUnreadCount(
        unreadCountFromTitle(document.title || ""),
        detectedAt,
        ROW_MUTATION_MATCH_MS,
        // A fully hydrated list with no unread rows corroborates a zero
        // title: it is the inbox's real state, not a still-unstamped title,
        // so a first arrival inside the settle window can still report.
        observed.length > 0 &&
          conversations.length === 0 &&
          observed.every(({ body }) => body.length > 0),
        readObservedKeys,
      )) {
        changed.add(key);
      }
      // Carry earlier attributed arrivals whose row has hydrated since, and
      // drop the ones whose row was read before ever hydrating.
      for (const conversation of hydrated) {
        if (pendingArrivalKeys.delete(conversation.key)) changed.add(conversation.key);
      }
      for (const key of pendingArrivalKeys) {
        const row = observed.find((conversation) => conversation.key === key);
        if (row && !conversations.some((conversation) => conversation.key === key)) {
          pendingArrivalKeys.delete(key);
        }
      }
      // Reconcile every hydrated row before honoring any changed verdict. This
      // is the single gate for exact replays, legacy placeholder migration,
      // reload-persistent page receipts, and stable delivered mismatches.
      // Receipts are matched against all hydrated rows at once: only an
      // identity with exactly one visible candidate may consume one, so two
      // threads sharing display text cannot steal each other's receipt.
      // A receipt matching only read rows was evidently read — retire it so
      // it cannot swallow the pairing for a later identical-text message.
      pageNotificationReceipts.discardReadMatches(
        observed.filter(({ unread, body }) => !unread && body.length > 0),
        observed.filter(({ unread, body }) => unread && body.length > 0),
        detectedAt,
      );
      const pageReceipts = pageNotificationReceipts.consumeUniquelyMatching(hydrated, detectedAt);
      const mismatches: [string, string][] = [];
      const stale = new Set<string>();
      const unhydrated = new Set<string>();
      for (const conversation of conversations) {
        if (!conversation.body) {
          if (changed.has(conversation.key)) {
            unhydrated.add(conversation.key);
            // Park the arrival until a scan sees the hydrated preview —
            // nothing else will re-report it once the count has moved on.
            pendingArrivalKeys.add(conversation.key);
            if (pendingArrivalKeys.size > 50) {
              pendingArrivalKeys.delete(pendingArrivalKeys.keys().next().value!);
            }
          }
          continue;
        }
        const fingerprint = notificationDedupeKey(conversation.title, conversation.body);
        const bodyHash = notificationDedupeKey("", conversation.body);

        const pageReceipt = pageReceipts.get(conversation.key);
        if (pageReceipt) {
          // An earlier scan may have armed a fallback while this receipt was
          // still ambiguous — the page already showed this notification, so
          // that timer must not fire a duplicate.
          const pending = pendingFallbacks.get(conversation.key);
          if (pending) clearTimeout(pending.timer);
          pendingFallbacks.delete(conversation.key);
          notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
          // Remove the same-document raw signal too; otherwise it could linger
          // briefly and pair with a different but text-identical row.
          unmatchedPageNotifications.consumeMatching(
            conversation,
            detectedAt,
            PAGE_NOTIFICATION_MATCH_MS,
          );
          updateNotificationRoute(pageReceipt.nativeId, conversation.threadPath);
        }

        const reconciliation = notifiedStore.reconcileFingerprint(
          conversation.key,
          conversation.title,
          fingerprint,
          bodyHash,
        );
        if (reconciliation === "matched" || reconciliation === "migrated") {
          if (changed.has(conversation.key)) stale.add(conversation.key);
          // The current content is already delivered — an armed fallback for
          // this thread (e.g. from a mismatch the hydration then corrected)
          // would only replay it or emit an outdated preview.
          const pending = pendingFallbacks.get(conversation.key);
          if (pending) {
            clearTimeout(pending.timer);
            pendingFallbacks.delete(conversation.key);
          }
        } else if (reconciliation === "mismatched") {
          // A raw row/title change cannot bypass the hydration-stability guard.
          // Only StableMismatchTracker may put this key back into `changed`.
          changed.delete(conversation.key);
          mismatches.push([conversation.key, fingerprint]);
          // If the preview moved on while a fallback for the old text was
          // armed, that timer would deliver a stale preview — cancel it; the
          // mismatch tracker re-arms once the new fingerprint stabilizes.
          const pending = pendingFallbacks.get(conversation.key);
          if (pending && pending.fingerprint !== fingerprint) {
            clearTimeout(pending.timer);
            pendingFallbacks.delete(conversation.key);
          }
        }
      }
      // A stably diverged fingerprint means new content since the last
      // delivery — typically a message that arrived while a reload was in
      // flight, which every freshly-primed tracker above stays silent about.
      const mismatchObservation = mismatchTracker.observe(mismatches, detectedAt);
      clearTimeout(mismatchConfirmationTimer);
      mismatchConfirmationTimer = undefined;
      if (mismatchObservation.confirmInMs !== null) {
        mismatchConfirmationTimer = setTimeout(
          scanUnreadConversations,
          Math.max(1, mismatchObservation.confirmInMs),
        );
      }
      const recovered = mismatchObservation.recovered;
      if (recovered.length) {
        diag("notify.recovered", "unread preview diverged from its delivered fingerprint");
        for (const key of recovered) changed.add(key);
      }
      if (!changed.size) return;
      if (stale.size) {
        diag("notify.stale", "suppressed replay of an already-delivered preview");
      }
      // Skip the auto-refresh nudge too when nothing genuinely changed, so a
      // stale or unhydrated replay cannot schedule the very reload that
      // re-triggers it.
      if ([...changed].every((key) => stale.has(key) || unhydrated.has(key))) return;
      try {
        window.__carrierOnNotification?.();
      } catch (_) {}
      for (const conversation of conversations) {
        if (
          changed.has(conversation.key) &&
          !stale.has(conversation.key) &&
          !unhydrated.has(conversation.key)
        ) {
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
  const scheduleScan = (records: MutationRecord[] = []) => {
    const changedKeys = new Set<string>();
    const inspect = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      if (!element) return;
      const links = new Set<HTMLAnchorElement>();
      const closest = element.closest<HTMLAnchorElement>('a[href*="/t/"]');
      if (closest) links.add(closest);
      for (const link of element.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]')) {
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

  let observedGrid: Element | null = null;
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
      attributeFilter: ["class", "src", "alt", "style"],
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

  // Mutations drive the fast path. This slow safety poll also re-attaches when
  // React replaces the grid element, and backs off while Carrier is hidden.
  let pollTimer: number | undefined;
  const poll = () => {
    attachScanner();
    scanUnreadConversations();
  };
  const startPoll = () => {
    clearInterval(pollTimer);
    pollTimer = setInterval(
      poll,
      document.hidden ? FALLBACK_POLL_HIDDEN_MS : FALLBACK_POLL_VISIBLE_MS,
    );
  };
  document.addEventListener("visibilitychange", () => {
    startPoll();
    if (!document.hidden) poll();
  });
  startPoll();
}
