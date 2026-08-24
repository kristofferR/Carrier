/* Harvest Messenger mute state from GraphQL/XHR payloads and Mute menu clicks.
 *
 * Row glyphs are missing on unread muted chats (the Caprine-era failure), so
 * accessible-name scraping alone is not enough. Thread-list JSON carries
 * `mute_until`, and clicking Mute/Unmute is the moment the user told Messenger
 * to silence the thread — both write the shared MutedThreadStore.
 */
import {
  collectMuteLabels,
  mutedThreads,
  muteStateAfterMenuLabel,
  muteStatesFromPayload,
  parseFacebookPayload,
} from "../lib/mute";
import { threadIdFromHref } from "../lib/threads";

const LOCAL_HOLD_MS = 10_000;
const MUTE_PAYLOAD_RE = /graphql|mercury|ls_req|lightspeed/i;
const MUTE_PAYLOAD_HINT_RE = /mute_until|muteUntil|is_muted|isMuted/;

let lastRowThreadId: string | null = null;

function harvestUrl(raw: string | URL | Request | undefined): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (raw instanceof URL) return raw.href;
  if (typeof Request !== "undefined" && raw instanceof Request) return raw.url;
  return String((raw as { url?: string }).url || raw);
}

function shouldHarvest(raw: string): boolean {
  return MUTE_PAYLOAD_RE.test(raw);
}

function applyPayloadText(text: string) {
  if (!text || !MUTE_PAYLOAD_HINT_RE.test(text)) return;
  const payload = parseFacebookPayload(text);
  if (!payload) return;
  for (const { id, muted } of muteStatesFromPayload(payload)) {
    mutedThreads.observe(id, muted);
  }
}

function menuMuteState(item: Element): boolean | null {
  const labels = collectMuteLabels(item);
  labels.push((item.textContent || "").replace(/\s+/g, " ").trim());
  let next: boolean | null = null;
  for (const label of labels) {
    const state = muteStateAfterMenuLabel(label);
    if (state !== null) next = state;
  }
  return next;
}

export function initMuteHarvest() {
  try {
    const origFetch = window.fetch;
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const pending = origFetch.apply(this, args);
      try {
        if (shouldHarvest(harvestUrl(args[0]))) {
          pending.then(
            (res) => {
              try {
                if (!res.ok) return;
                res
                  .clone()
                  .text()
                  .then(applyPayloadText, () => {});
              } catch (_) {}
            },
            () => {},
          );
        }
      } catch (_) {}
      return pending;
    };
  } catch (_) {}

  try {
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function (
      this: XMLHttpRequest,
      ...args: [method: string, url: string | URL, ...rest: unknown[]]
    ) {
      try {
        this.__carrierMuteHarvest = shouldHarvest(String(args[1] || ""));
      } catch (_) {
        this.__carrierMuteHarvest = false;
      }
      return origOpen.apply(this, args as Parameters<XMLHttpRequest["open"]>);
    };
    proto.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>) {
      if (this.__carrierMuteHarvest) {
        this.addEventListener(
          "load",
          () => {
            try {
              applyPayloadText(String(this.responseText || ""));
            } catch (_) {}
          },
          { once: true },
        );
      }
      return origSend.apply(this, args);
    };
  } catch (_) {}

  document.addEventListener(
    "pointerover",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a[href*="/t/"]');
      const id = threadIdFromHref(link?.getAttribute("href"));
      if (id) lastRowThreadId = id;
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const item = target.closest(
        '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
      );
      if (!item) return;
      const next = menuMuteState(item);
      if (next === null) return;
      const row = item.closest('[role="row"]');
      const href = row?.querySelector("a[href*='/t/']")?.getAttribute("href");
      const id = threadIdFromHref(href) || lastRowThreadId || threadIdFromHref(location.pathname);
      if (id) mutedThreads.observe(id, next, LOCAL_HOLD_MS);
    },
    true,
  );
}
