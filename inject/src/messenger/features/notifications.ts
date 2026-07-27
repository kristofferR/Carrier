/* --------------------- Native message notifications ------------------- */
// Bridge the page's Web Notification API to native OS notifications so new
// messages notify you even when Carrier is in the background.
import { diag, invoke } from "../bridge";
import {
  conversationNodeText,
  conversationTextParts,
  hasCandidateTextChild,
  isUnreadConversationText,
} from "../lib/conversation-row";
import { EMOJI_SOURCE_RE } from "../lib/emoji";
import {
  ConversationNotificationTracker,
  groupPreviewSender,
  isOwnMessagePreview,
  NotifiedSignatureStore,
  notificationDedupeKey,
  notificationDeliveryDedupeKey,
  notificationTextMatches,
  PageNotificationQueue,
  PageNotificationReceiptStore,
  type PageNotificationSignal,
  READ_TRANSITION_CONFIRM_MS,
  READ_TRANSITION_MIN_OBSERVATIONS,
  StableMismatchTracker,
  UnreadArrivalTracker,
} from "../lib/notification-fallback";
import { avatarPhotoId, SenderAvatarStore } from "../lib/sender-avatars";
import { threadIdFromHref } from "../lib/threads";
import { unreadCountFromTitle } from "../lib/unread";
import { chatRows } from "./conversation-actions";

interface CarrierNotificationInstance {
  title?: string;
  onclick: ((e: Event) => unknown) | null;
  close: () => void;
}

type NativeNotificationDelivery = "accepted" | "duplicate" | "suppressed";

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

  const AVATAR_SIZE = 64;
  // Facebook serves fbcdn avatars with CORS, so an anonymous request can be
  // drawn to a canvas without tainting it. Bounded: a slow image must not hold
  // up the notification. Resolves null when the image cannot be used.
  const loadAvatarImage = (url: string | undefined) =>
    new Promise<HTMLImageElement | null>((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      let settled = false;
      const done = (value: HTMLImageElement | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), 2500);
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = url;
    });

  // Draw the given faces into one small PNG data URL, so the native side can
  // attach it without re-fetching: the page already holds Facebook's session
  // and the cached image. One face fills the icon. Two are drawn as offset
  // overlapping circles — the way Messenger itself draws a photo-less group —
  // so the pair reads as a group rather than as one badly cropped person.
  // Best-effort: resolves "" if nothing could be read (e.g. the canvas is
  // tainted) and the notification then shows text only.
  const facesToDataUrl = (urls: (string | undefined)[]) =>
    Promise.all(urls.slice(0, 2).map(loadAvatarImage)).then((images) => {
      const faces = images.filter((image): image is HTMLImageElement => image !== null);
      if (!faces.length) return "";
      try {
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const context = canvas.getContext("2d")!;
        const paired = faces.length > 1;
        const diameter = paired ? AVATAR_SIZE * 0.68 : AVATAR_SIZE;
        const offset = AVATAR_SIZE - diameter;
        faces.forEach((face, index) => {
          const left = index * offset;
          const top = index * offset;
          const centerX = left + diameter / 2;
          const centerY = top + diameter / 2;
          if (paired) {
            // Clear a slightly larger disc first, so the face on top sits in a
            // transparent gap instead of merging into the one behind it.
            context.save();
            context.globalCompositeOperation = "destination-out";
            context.beginPath();
            context.arc(centerX, centerY, diameter / 2 + 2, 0, 2 * Math.PI);
            context.fill();
            context.restore();
            context.save();
            context.beginPath();
            context.arc(centerX, centerY, diameter / 2, 0, 2 * Math.PI);
            context.clip();
          }
          // Cover-crop rather than squashing a non-square photo.
          const scale = Math.max(diameter / face.width, diameter / face.height);
          const sourceSize = diameter / scale;
          context.drawImage(
            face,
            (face.width - sourceSize) / 2,
            (face.height - sourceSize) / 2,
            sourceSize,
            sourceSize,
            left,
            top,
            diameter,
            diameter,
          );
          if (paired) context.restore();
        });
        return canvas.toDataURL("image/png");
      } catch (_) {
        return "";
      }
    });

  const avatarToDataUrl = (url: string | undefined) => facesToDataUrl([url]);

  // Clicking a native notification routes back here by id: bring the
  // conversation up by invoking the original `onclick` Facebook assigned to its
  // Notification (that's what opens the right thread). A small bounded map keeps
  // those handlers alive between "notification shown" and "notification clicked".
  // Keep ids unique across auto-refresh reloads so the native click route for
  // an older OS notification cannot collide with a fresh in-page handler.
  let notifySeq = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const notifyHandlers = new Map<number, () => void>();
  const deliveryHandlers = new Map<number, (delivery: NativeNotificationDelivery) => void>();
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

  window.__carrierNotifyResult = (id, delivery) => {
    if (delivery !== "accepted" && delivery !== "duplicate" && delivery !== "suppressed") return;
    const handler = deliveryHandlers.get(id);
    deliveryHandlers.delete(id);
    handler?.(delivery);
  };

  const emitNotification = (
    id: number,
    title: string,
    body: string,
    icon: string,
    dedupeKey: string,
    onClick: () => void,
    threadPath?: string,
    onDelivery?: (delivery: NativeNotificationDelivery) => void,
  ) => {
    notifyHandlers.set(id, onClick);
    if (notifyHandlers.size > 50) notifyHandlers.delete(notifyHandlers.keys().next().value!);
    if (onDelivery) {
      deliveryHandlers.set(id, onDelivery);
      if (deliveryHandlers.size > 50) {
        deliveryHandlers.delete(deliveryHandlers.keys().next().value!);
      }
    }
    invoke("plugin:event|emit", {
      event: "carrier:notify",
      payload: { id, title, body, icon, dedupe_key: dedupeKey, thread_path: threadPath || "" },
    })?.catch?.(() => {
      deliveryHandlers.delete(id);
      diag("notify.emit", "carrier:notify emit failed");
    });
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
  const senderAvatars = new SenderAvatarStore(notificationStorage);
  // For the dev-only MCP probe: cache sizes, or the verdict for a sender the
  // probe already read from the DOM. Nothing but counts and classifications
  // crosses this boundary — no names, no URLs.
  window.__carrierSenderAvatarStats = (thread?: string, sender?: string) =>
    thread === undefined
      ? senderAvatars.stats
      : { resolves: senderAvatars.describe(thread, sender || "") };

  interface PendingFallback {
    timer: number;
    title: string;
    body: string;
    threadPath: string;
    fingerprint: string;
    dedupeKey: string;
    confirmedRepeat: boolean;
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
    dedupeKey?: string;
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
        dedupeKey: pending.dedupeKey,
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
          pageMatch.dedupeKey ??
            pageMatch.signal?.dedupeKey ??
            notificationDedupeKey(originalTitle, originalBody),
          () => {
            // Facebook's onclick expects the click Event (it can read it / call
            // preventDefault); a native notification click carries no DOM
            // event, so hand it a synthetic one. Called through the captured
            // instance so `this` stays bound to the Notification.
            this.onclick?.(new Event("click"));
          },
          pageMatch.threadPath,
          pageMatch.signal
            ? (delivery) => {
                pageMatch.signal!.nativeDelivery = delivery;
                const handler = pageMatch.signal!.onNativeDelivery;
                pageMatch.signal!.onNativeDelivery = undefined;
                handler?.(delivery);
              }
            : undefined,
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

  // A group's conversation row only carries the thread picture, so the sender
  // named in a "Kim: …" preview has no face there. Messenger does pair the two
  // on surfaces that belong to the open conversation — every message row
  // (heading + avatar) and the conversation-info panel with its chat-member
  // list — so harvest those pairings as they render and look them up when a
  // group notification fires. All of `main` is this conversation: the thread
  // list is a `navigation` landmark, and a global people dialog such as the
  // forward or contact picker mounts outside it.
  const HARVEST_SEL = '[role="main"], [role="complementary"]';
  const HARVEST_THROTTLE_MS = 5_000;
  let lastHarvestAt = 0;
  // The route being waited on, and every route passed through since a pane was
  // last positively identified. Routing away from a thread does not unrender
  // it, so until some pane answers for itself each of those threads may still
  // be the one on screen — and a label that answers to any of them proves
  // nothing about the destination.
  let settlingRoute = "";
  const staleRoutes = new Set<string>();
  // How many times a route may re-check a pane that has not caught up.
  const SETTLE_ATTEMPT_LIMIT = 6;
  let settleAttempts = 0;
  const normalizedText = (value: string | null | undefined) =>
    (value || "").replace(/\s+/g, " ").trim();
  // Alt text on Messenger's avatars is the person's name; its photo and
  // attachment images describe themselves instead ("May be an image of …").
  const isPersonName = (value: string) =>
    value.length > 0 &&
    value.length <= 60 &&
    value.split(" ").length <= 5 &&
    /\p{Letter}/u.test(value) &&
    !/profile|picture|photo|image|avatar|bilde/i.test(value);

  interface HarvestedFace {
    name: string;
    url: string;
    owner: string;
    photo: string;
  }

  // What each thread's row calls itself, so a harvest can check that the pane
  // in front of it is the conversation the address bar names. In memory only.
  const rowTitles = new Map<string, string>();
  const ROW_TITLE_LIMIT = 300;
  const rememberRowTitle = (key: string, title: string) => {
    if (!key || !title) return;
    rowTitles.delete(key);
    rowTitles.set(key, title);
    if (rowTitles.size > ROW_TITLE_LIMIT) rowTitles.delete(rowTitles.keys().next().value!);
  };

  /**
   * Whether the thread pane is showing the conversation `title` names. The
   * message list — the surface the harvest reads — labels itself with the
   * conversation it belongs to, so that one label is the evidence; a
   * participant who happens to share the name cannot forge it. Two answers are
   * not evidence: a title too short to identify anything, and one that a thread
   * the pane has not been seen to leave answers to as well.
   */
  const paneShowsThread = (
    title: string,
    leaving: Iterable<string> = [],
  ): "yes" | "no" | "unknown" => {
    const needle = title.replace(/[…\s]+$/, "").toLowerCase();
    if (needle.length < 3) return "unknown";
    const log = document.querySelector('[role="main"] [role="log"][aria-label]');
    if (!log) return "no";
    const label = normalizedText(log.getAttribute("aria-label")).toLowerCase();
    if (!label.includes(needle)) return "no";
    // A thread still possibly on screen answers to this title too — one of them
    // is in front of us and the label cannot say which. Two conversations that
    // share a title are the same problem, exactly.
    for (const previous of leaving) {
      const other = previous.replace(/[…\s]+$/, "").toLowerCase();
      if (other && (other === needle || label.includes(other))) return "unknown";
    }
    return "yes";
  };

  const harvestSenderAvatars = (now: number) => {
    if (now - lastHarvestAt < HARVEST_THROTTLE_MS) return;
    // Only a group prints the sender's name above their message, so the open
    // thread proves its own kind — and a row's preview prefix is a real sender
    // only in a group (a direct message may simply start with "John: ").
    // Without an open thread there is nothing to attribute a face to, and
    // nothing that should spend the throttle a brief render then waits on.
    const openThread = threadIdFromHref(location.pathname);
    if (!openThread) return;
    // Messenger routes before it re-renders, so for a moment after switching
    // conversations the pane still shows the previous one's faces. Wait for the
    // pane to name the destination itself: a timeout only guesses, and a route
    // this scan has seen before proves nothing about what is rendered under it.
    // The render that changed the route was already coalesced into this pass,
    // so the retry below is what reads the destination.
    if (openThread !== settlingRoute) {
      // Nothing has identified the pane since the thread we just left, so that
      // thread joins the ones it may still be showing. Only a positive match
      // clears them — retiring one on the retry would let the very pane we are
      // waiting out answer for the destination.
      if (settlingRoute) staleRoutes.add(settlingRoute);
      settlingRoute = openThread;
      settleAttempts = 0;
    }
    const leaving: string[] = [];
    for (const route of staleRoutes) {
      // The destination is not evidence against itself, however it was reached.
      if (route === openThread) continue;
      const title = rowTitles.get(route);
      if (title) leaving.push(title);
    }
    const shown = paneShowsThread(rowTitles.get(openThread) || "", leaving);
    if (shown !== "yes") {
      // Retry while the render is plausibly still coming; the attempt limit
      // stops a title that can never be verified from waking Carrier twice a
      // second forever. This deliberately runs while hidden: the harvest feeds
      // notifications, which are read precisely when nobody is looking at the
      // window, and gating it on visibility left group senders unharvested for
      // as long as Carrier stayed in the background.
      if (settleAttempts < SETTLE_ATTEMPT_LIMIT) {
        settleAttempts++;
        scheduleHarvest(500);
      }
      return;
    }
    // The pane spoke for itself, so every thread behind it is off screen.
    staleRoutes.clear();
    settleAttempts = 0;
    lastHarvestAt = now;
    // Collect the whole pass before writing: one name wearing two different
    // faces at the same moment is two people — an avatar URL cannot rotate
    // mid-render — and neither of them may keep the name.
    const pass = new Map<string, HarvestedFace | null>();
    const note = (name: string, url: string, owner: string) => {
      const seen = pass.get(name.toLowerCase());
      if (seen === undefined) {
        pass.set(name.toLowerCase(), { name, url, owner, photo: avatarPhotoId(url) });
        return;
      }
      if (seen && seen.photo !== avatarPhotoId(url)) pass.set(name.toLowerCase(), null);
    };
    for (const container of document.querySelectorAll<HTMLElement>(HARVEST_SEL)) {
      for (const image of container.querySelectorAll<HTMLImageElement>("img[alt]")) {
        const source = image.currentSrc || image.src || "";
        if (!source || EMOJI_SOURCE_RE.test(source)) continue;
        const name = normalizedText(image.getAttribute("alt"));
        if (!isPersonName(name)) continue;
        note(name, source, name);
        // Group previews use the short name Messenger prints above a message
        // ("Kim"), while the avatar's alt holds the full one ("Kim Andersen").
        const heading = normalizedText(
          image.closest('[role="article"]')?.querySelector("h3, h4")?.textContent,
        );
        // Only a group prints who wrote above their message, and only a real
        // one pairs that name with the face it belongs to. A direct message
        // that merely starts with "John: " must not read as a sender prefix,
        // so nothing weaker than this pairing may mark the thread — but a
        // one-word name pairs exactly rather than as a prefix.
        if (isPersonName(heading) && (heading === name || name.startsWith(`${heading} `))) {
          senderAvatars.rememberGroupThread(openThread);
          if (heading !== name) note(heading, source, name);
        }
      }
    }
    for (const [key, face] of pass) {
      if (face) senderAvatars.remember(openThread, face.name, face.url, face.owner, now);
      else senderAvatars.markAmbiguous(openThread, key);
    }
  };

  // The row scan alone would miss a chat-member dialog or a thread opened and
  // closed between polls, so watch the harvested surfaces too. This runs while
  // hidden as well: the faces feed notifications, which matter precisely when
  // nobody is watching the window, and the throttle above is what keeps an
  // unfocused Carrier off the CPU.
  let harvestScheduled = false;
  const scheduleHarvest = (delay = 300) => {
    if (harvestScheduled) return;
    harvestScheduled = true;
    setTimeout(() => {
      harvestScheduled = false;
      // Surfaces mount and vanish between polls, so pick up whatever is
      // mounted now — this is also how the observer recovers when there was
      // nothing to observe yet at document-start.
      attachHarvestObserver();
      // A mutation the throttle rejects must not be dropped: the list that
      // just rendered may close again before the safety poll comes round.
      const wait = HARVEST_THROTTLE_MS - (Date.now() - lastHarvestAt);
      if (wait > 0) {
        scheduleHarvest(wait);
        return;
      }
      harvestSenderAvatars(Date.now());
    }, delay);
  };
  let harvestRoots: Element[] = [];
  let harvestAttached = false;
  const harvestObserver = new MutationObserver(() => scheduleHarvest());
  const attachHarvestObserver = () => {
    // Both harvested surfaces, whichever of them React has mounted.
    const roots = [...document.querySelectorAll<HTMLElement>(HARVEST_SEL)];
    if (
      harvestAttached &&
      harvestRoots.length === roots.length &&
      roots.every((root, index) => root === harvestRoots[index] && root.isConnected)
    ) {
      return;
    }
    harvestObserver.disconnect();
    harvestRoots = roots;
    for (const root of roots) harvestObserver.observe(root, { childList: true, subtree: true });
    // React mounts a whole surface at the body, outside either of them. This
    // script runs at document-start, so the body itself may still be missing —
    // watch the document until it appears rather than counting as attached.
    if (document.body) {
      harvestObserver.observe(document.body, { childList: true });
      harvestAttached = true;
    } else {
      harvestObserver.observe(document.documentElement, { childList: true });
      harvestAttached = false;
    }
  };

  const conversationFromLink = (link: HTMLAnchorElement) => {
    const id = threadIdFromHref(link?.getAttribute("href"));
    if (!id) return null;
    const row = link.closest('[role="row"]') || link;
    const surfaces = [...row.querySelectorAll<HTMLElement>("span")].map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        text: conversationNodeText(el),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        ariaHidden: el.getAttribute("aria-hidden") === "true",
        inAbbreviation: !!el.closest("abbr"),
        // An emoji sprite (and the System emoji glyph beside it) is part of
        // this span's own text, not a nested text surface of its own.
        hasTextChild: hasCandidateTextChild(el),
      };
    });
    const text = conversationTextParts(surfaces);
    // The same predicate the text extraction uses: a sprite counted here would
    // become the notification icon, or read as a group's member composite.
    const images = [...row.querySelectorAll<HTMLImageElement>("img[src]")].filter(
      (candidate) => !EMOJI_SOURCE_RE.test(candidate.currentSrc || candidate.src),
    );
    let unread = false;
    for (const span of row.querySelectorAll<HTMLElement>("span")) {
      if (isUnreadConversationText(getComputedStyle(span).fontWeight, conversationNodeText(span))) {
        unread = true;
        break;
      }
    }
    return {
      key: id,
      threadPath: `/t/${id}/`,
      title: text.title,
      body: text.body,
      // Every face the row draws, in render order. A photo-less group renders
      // several member images side by side, and no individual one of them is a
      // valid thread icon — taking just the first labelled every message in
      // the thread with whichever member happened to sort first. They are all
      // kept so they can be drawn together, which is a valid picture of the
      // group even though none of them is a picture of it alone.
      icons: images.map((candidate) => candidate.currentSrc || candidate.src).filter(Boolean),
      // A photo-less group draws its members side by side; one with a photo is
      // only known as a group once its thread has been read.
      isGroup: images.length > 1 || senderAvatars.isGroupThread(id),
      unread,
    };
  };

  type Conversation = NonNullable<ReturnType<typeof conversationFromLink>>;

  const scheduleFallback = (
    conversation: Conversation,
    detectedAt: number,
    confirmedRepeat = false,
  ) => {
    const fingerprint = notificationDedupeKey(conversation.title, conversation.body);
    const dedupeKey = notificationDeliveryDedupeKey(
      fingerprint,
      confirmedRepeat ? `${conversation.key}:${detectedAt}` : undefined,
    );
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
      // The page's async avatar conversion may still be in flight. Give that
      // pending path the same fresh identity so it remains paired with this row
      // while bypassing the native replay guard for a confirmed repeat. Once
      // emitted, changing the signal cannot update the payload already sent.
      if (!pageSignal.emitted) pageSignal.dedupeKey = dedupeKey;
      // The page path already delivered this logical notification. If it fired
      // before this row was known, its native notification carries no route —
      // attach one now so a click survives the auto-refresh reload.
      if (pageSignal.nativeId !== undefined && conversation.threadPath) {
        updateNotificationRoute(pageSignal.nativeId, conversation.threadPath);
      }
      if (pageSignal.emitted) {
        const finishDelivery = (delivery: NativeNotificationDelivery) => {
          if (confirmedRepeat && delivery === "duplicate") {
            // The page emitted with the old content fingerprint before this
            // row confirmed a new, identical message. Retry only when native
            // delivery reports that exact emit was suppressed.
            scheduleFallback(conversation, detectedAt, true);
            return;
          }
          notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
        };
        if (pageSignal.nativeDelivery) {
          finishDelivery(pageSignal.nativeDelivery);
        } else {
          pageSignal.onNativeDelivery = finishDelivery;
        }
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
    // In a group, show whoever wrote rather than the thread picture — falling
    // back to the row's single group photo when the sender is unknown or their
    // cached avatar URL has expired.
    // Both conversions run under their own bounded timeout at the same time:
    // chaining them could outlast the four-second auto-refresh nudge and lose
    // the banner entirely.
    const senderIcon = conversation.isGroup
      ? senderAvatars.lookup(conversation.key, groupPreviewSender(conversation.body))
      : "";
    // When the sender is unknown the row's own picture stands in — drawn from
    // every face the row carries, not just the first. A photo-less group's
    // first face is only whoever sorts first: alone it would label one member's
    // message with another's face, and every other message in the thread with
    // that same face. Drawn together they are a picture of the group, which is
    // what belongs beside a title naming the group.
    const rowIcons = conversation.icons;
    const rowAvatar = () => facesToDataUrl(rowIcons);
    const avatar =
      senderIcon && !(rowIcons.length === 1 && senderIcon === rowIcons[0])
        ? Promise.all([avatarToDataUrl(senderIcon), rowAvatar()]).then(
            ([sender, row]) => sender || row,
          )
        : rowAvatar();
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
      // Content-free breadcrumb: a group notification with nothing to show
      // means neither the sender's harvested face nor the row's own picture
      // resolved, which is otherwise invisible until someone reports a blank
      // banner. Not logged when the preview is hidden — that is meant to be
      // pictureless.
      if (!hidePreview && !icon && conversation.isGroup) {
        diag("notify.avatar", "group notification resolved no sender face and no thread picture");
      }
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
        dedupeKey,
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
      dedupeKey,
      confirmedRepeat,
    });
  };

  let scanRunning = false;
  let scanPending = false;
  let mismatchConfirmationTimer: number | undefined;
  let readConfirmationTimer: number | undefined;
  const unreadArrivals = new UnreadArrivalTracker(HYDRATION_SETTLE_MS);
  const mismatchTracker = new StableMismatchTracker(MISMATCH_STABLE_MS);
  // Arrivals attributed while their row preview was still empty. The
  // signature tracker only observes hydrated rows, so without carrying these
  // keys the later hydration would prime silently and the arrival would
  // never notify. Delivered once the row hydrates; dropped if it turns read.
  const pendingArrivalKeys = new Set<string>();
  // Threads this document has observed rendered hydrated-and-read, CONFIRMED
  // across scans spanning real time: mid-hydration a row can show its text
  // before its unread styling, and a single such glimpse must not qualify a
  // pre-existing unread thread for the early-arrival rescue. Bounded like the
  // sibling stores; a row from this set turning unread is a real arrival even
  // during the settle window.
  const READ_OBSERVED_LIMIT = 500;
  const readObservedKeys = new Set<string>();
  const readCandidates = new Map<string, { since: number; observations: number }>();
  // When the previous scan actually examined the list. Row mutations are
  // attributed against real elapsed time, but the scan that reads them is
  // deferred by a timer the webview throttles hard while hidden — and the
  // hidden poll runs a full minute apart. Measuring the attribution window
  // from the last scan instead of a fixed 2s keeps mutations eligible for as
  // long as nothing has looked at them, so a throttled scan no longer finds
  // the arrival already expired. Capped so a scan resuming after a long
  // suspend cannot attribute a count increase to hours-old churn.
  let lastScanAt = 0;
  const MAX_MUTATION_GRACE_MS = 90_000;
  const scanUnreadConversations = () => {
    if (scanRunning) {
      scanPending = true;
      return;
    }
    scanRunning = true;
    try {
      harvestSenderAvatars(Date.now());
      const links = chatRows();
      // A grid can exist briefly before its rows hydrate. Do not prime an empty
      // list or the first real render would look like a burst of new messages.
      if (!links.length) return;
      const observed = links
        .map(conversationFromLink)
        .filter((conversation): conversation is Conversation => conversation !== null);
      for (const conversation of observed) rememberRowTitle(conversation.key, conversation.title);
      const conversations = observed.filter(
        (conversation) => conversation.unread && !isOwnMessagePreview(conversation.body),
      );
      const detectedAt = Date.now();
      const mutationGrace = lastScanAt
        ? Math.min(MAX_MUTATION_GRACE_MS, Math.max(0, detectedAt - lastScanAt))
        : 0;
      lastScanAt = detectedAt;
      // Every rendered row carries preview text, so unread styling has had its
      // chance to apply. Both the read-state bookkeeping and the zero-unread
      // corroboration below rely on this to tell a settled list apart from one
      // that is still hydrating.
      const listHydrated = observed.length > 0 && observed.every(({ body }) => body.length > 0);
      // "Read" means the row is no longer unread — not merely filtered from
      // `conversations` (an unread row whose preview currently shows your own
      // reply must keep its entry; hydration can flap the preview form).
      notifiedStore.observeRead(
        new Set(observed.filter(({ unread }) => unread).map(({ key }) => key)),
        observed.map(({ key }) => key),
        detectedAt,
        listHydrated,
      );
      // Only hydrated rows feed the signature tracker — in both directions.
      // Priming an unhydrated row with its title would report a "change" the
      // moment the body arrives and replay store-less threads after every
      // reload; and an unhydrated row proves nothing about read state, so it
      // must not evict a tracked signature either. The first hydrated
      // observation primes silently instead.
      const hydrated = conversations.filter(({ body }) => body.length > 0);
      // Confirm read state before the signature tracker runs: a thread turning
      // unread again is only a new message if this document had established it
      // was read, and the tracker needs that verdict for the very scan the
      // transition shows up in.
      const hydratedReadKeys = new Set<string>(
        listHydrated ? observed.filter(({ unread }) => !unread).map(({ key }) => key) : [],
      );
      clearTimeout(readConfirmationTimer);
      readConfirmationTimer = undefined;
      let nextReadConfirmationIn: number | null = null;
      for (const key of readCandidates.keys()) {
        if (!hydratedReadKeys.has(key)) readCandidates.delete(key);
      }
      for (const conversation of observed) {
        if (!hydratedReadKeys.has(conversation.key)) continue;
        if (readObservedKeys.has(conversation.key)) continue;
        const candidate = readCandidates.get(conversation.key);
        if (candidate === undefined || detectedAt < candidate.since) {
          readCandidates.set(conversation.key, { since: detectedAt, observations: 1 });
          if (readCandidates.size > READ_OBSERVED_LIMIT) {
            readCandidates.delete(readCandidates.keys().next().value!);
          }
          nextReadConfirmationIn =
            nextReadConfirmationIn === null
              ? READ_TRANSITION_CONFIRM_MS
              : Math.min(nextReadConfirmationIn, READ_TRANSITION_CONFIRM_MS);
          continue;
        }
        candidate.observations += 1;
        const elapsed = detectedAt - candidate.since;
        if (
          elapsed >= READ_TRANSITION_CONFIRM_MS &&
          candidate.observations >= READ_TRANSITION_MIN_OBSERVATIONS
        ) {
          readCandidates.delete(conversation.key);
          readObservedKeys.add(conversation.key);
          if (readObservedKeys.size > READ_OBSERVED_LIMIT) {
            readObservedKeys.delete(readObservedKeys.keys().next().value!);
          }
        } else {
          // Once the elapsed-time guard is met, keep scanning until the
          // observation guard is met too. Otherwise the scheduled scan at the
          // time boundary can stop on observation two and never confirm.
          const remaining = Math.max(1, READ_TRANSITION_CONFIRM_MS - elapsed);
          nextReadConfirmationIn =
            nextReadConfirmationIn === null
              ? remaining
              : Math.min(nextReadConfirmationIn, remaining);
        }
      }
      if (nextReadConfirmationIn !== null) {
        readConfirmationTimer = setTimeout(
          scanUnreadConversations,
          Math.max(1, nextReadConfirmationIn),
        );
      }
      const readTransitions = new Set<string>();
      const changed = new Set(
        conversationTracker.observe(
          hydrated.map(({ key, body }) => ({ key, signature: body })),
          observed.filter(({ body }) => body.length > 0).map(({ key }) => key),
          readObservedKeys,
          readTransitions,
        ),
      );
      for (const key of unreadArrivals.observeUnreadCount(
        unreadCountFromTitle(document.title || ""),
        detectedAt,
        ROW_MUTATION_MATCH_MS + mutationGrace,
        // A fully hydrated list with no unread rows corroborates a zero
        // title: it is the inbox's real state, not a still-unstamped title,
        // so a first arrival inside the settle window can still report.
        listHydrated && !observed.some(({ unread }) => unread),
        readObservedKeys,
      )) {
        changed.add(key);
      }
      // Keep a confirmed-read verdict through the scan that first observes
      // the unread transition, then retire it. A later transient read-looking
      // render must earn confirmation again before it can arm another repeat.
      for (const { key, unread } of observed) {
        if (unread) readObservedKeys.delete(key);
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
      // A receipt matching a read row was evidently read — retire it so it
      // cannot swallow the pairing for a later identical-text message. This
      // drops even when an unread twin also matches: which thread the
      // receipt belonged to is unknowable then, and a possible duplicate
      // fallback (absorbed by the native dedupe) beats routing the click to
      // the wrong conversation or suppressing the unread thread's banner.
      pageNotificationReceipts.discardReadMatches(
        observed.filter(({ unread, body }) => !unread && body.length > 0),
        detectedAt,
      );
      const pageReceipts = pageNotificationReceipts.consumeUniquelyMatching(hydrated, detectedAt);
      const mismatches: [string, string][] = [];
      const stale = new Set<string>();
      const unhydrated = new Set<string>();
      const confirmedRepeats = new Set<string>();
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
        const pageSignal = pageReceipt
          ? unmatchedPageNotifications.consumeMatching(
              conversation,
              detectedAt,
              PAGE_NOTIFICATION_MATCH_MS,
            )
          : null;
        // A receipt proves that the page queued an emit, but the same-document
        // signal also carries the native result. For an identical post-read
        // message, "duplicate" means the old content key suppressed this new
        // banner, so it still needs the fresh-key fallback.
        const receiptSuppressedRepeat =
          pageReceipt !== undefined &&
          readTransitions.has(conversation.key) &&
          pageSignal?.nativeDelivery === "duplicate";
        const receiptPendingRepeat =
          pageReceipt !== undefined &&
          readTransitions.has(conversation.key) &&
          pageSignal !== null &&
          pageSignal.nativeDelivery === undefined;
        if (receiptPendingRepeat) {
          // Do not stamp an identical post-read message as delivered until the
          // native layer says whether the page's old content key was accepted.
          // A duplicate needs the fresh-key fallback; accepted/suppressed
          // results can safely retire the transition.
          const pending = pendingFallbacks.get(conversation.key);
          if (pending) clearTimeout(pending.timer);
          pendingFallbacks.delete(conversation.key);
          updateNotificationRoute(pageReceipt.nativeId, conversation.threadPath);
          pageSignal.onNativeDelivery = (delivery) => {
            if (delivery === "duplicate") {
              scheduleFallback(conversation, detectedAt, true);
              return;
            }
            notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
          };
          changed.delete(conversation.key);
          continue;
        }
        if (pageReceipt && !receiptSuppressedRepeat) {
          // An earlier scan may have armed a fallback while this receipt was
          // still ambiguous — the page already emitted this notification, so
          // that timer must not fire a possible duplicate.
          const pending = pendingFallbacks.get(conversation.key);
          if (pending) clearTimeout(pending.timer);
          pendingFallbacks.delete(conversation.key);
          notifiedStore.markNotified(conversation.key, fingerprint, bodyHash);
          updateNotificationRoute(pageReceipt.nativeId, conversation.threadPath);
        }

        const reconciliation = notifiedStore.reconcileFingerprint(
          conversation.key,
          conversation.title,
          fingerprint,
          bodyHash,
          readTransitions.has(conversation.key) && (!pageReceipt || receiptSuppressedRepeat),
        );
        if (reconciliation === "repeated") confirmedRepeats.add(conversation.key);
        if (reconciliation === "matched" || reconciliation === "migrated") {
          if (changed.has(conversation.key)) stale.add(conversation.key);
          // The current content is already delivered — an armed fallback for
          // this thread (e.g. from a mismatch the hydration then corrected)
          // would only replay it or emit an outdated preview. A confirmed
          // repeated message is the exception: its intentionally identical
          // fingerprint must stay armed until its fresh-key delivery fires.
          const pending = pendingFallbacks.get(conversation.key);
          if (pending && !pending.confirmedRepeat) {
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
          scheduleFallback(conversation, detectedAt, confirmedRepeats.has(conversation.key));
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
    attachHarvestObserver();
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
    attachHarvestObserver();
    if (!document.hidden) poll();
  });
  attachHarvestObserver();
  startPoll();
}
