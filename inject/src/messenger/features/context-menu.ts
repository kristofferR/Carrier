/* --------------------- Adaptive context menu -------------------------- */
// Right-click an image, video or link to get the relevant actions
// (download / copy / copy address / open in browser), matching the original.
import { cleanSharedUrl, openUrl, toast, toastDownloadSaved } from "../bridge";
import { waitForNativeDownload } from "../lib/download-completion";
import { filenameFromUrl, friendlyDownloadName } from "../lib/downloads";
import { type MenuRect, pointerActivationIsSound } from "../lib/menu-integrity";

const MAX_BLOB = 512 * 1024 * 1024;

// Capture the native registrar at document start. Messenger code runs in the
// same JS world and may replace the prototype before a menu is opened.
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeObjectDefineProperty = Object.defineProperty;
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
const nativeReflectApply = Reflect.apply;
// Same reason: the menu's isolation depends on these being the real ones. A
// replaced `push` would be handed each privileged row as an argument, which is
// exactly the reference the closed shadow root exists to withhold.
const nativeAttachShadow = Element.prototype.attachShadow;
const nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const nativeArrayPush = Array.prototype.push;
const NativeUint8Array = Uint8Array;
const nativeGetRandomValues = crypto.getRandomValues.bind(crypto);
const nativeSetTimeout = window.setTimeout.bind(window);

const rectOf = (el: Element): MenuRect => {
  const r = nativeReflectApply(nativeGetBoundingClientRect, el, []) as DOMRect;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

// The macOS share sheet (NSSharingServicePicker) is native-only; other
// platforms have no equivalent Carrier can reach, so the item stays hidden.
const isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);

function contextActionToken() {
  const bytes = new NativeUint8Array(16);
  nativeGetRandomValues(bytes);
  const hex = "0123456789abcdef";
  let token = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    token += (hex[byte >> 4] ?? "") + (hex[byte & 15] ?? "");
  }
  return token;
}

function showNativeContextMenu(items: [string, () => unknown][]) {
  const nativeItems: { label: string; action: string }[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const action = contextActionToken();
    const eventName = `carrier:context-action:${action}`;
    const run = () => {
      nativeReflectApply(nativeRemoveEventListener, window, [eventName, run, true]);
      item[1]();
    };
    nativeReflectApply(nativeAddEventListener, window, [eventName, run, true]);
    nativeSetTimeout(
      () => nativeReflectApply(nativeRemoveEventListener, window, [eventName, run, true]),
      120_000,
    );
    nativeReflectApply(nativeObjectDefineProperty, nativeItems, [
      String(nativeItems.length),
      {
        value: { label: item[0], action },
        writable: true,
        enumerable: true,
        configurable: true,
      },
    ]);
  }
  carrierShowContextMenu(nativeItems)?.catch(() => toast("Menu failed"));
}

// Save the media through the trusted download flow (the sheet needs a real
// file), then ask the native side to share it, anchored at the click point.
async function shareSrc(src: string, fallbackName: string, fx: number, fy: number) {
  const href = await downloadSrc(src, fallbackName);
  await carrierShareDownload(href, fx, fy);
}

// True when the response advertises a Content-Length over the cap. Absent or
// unparseable headers yield 0 (falsy), so callers fall back to the blob check.
const oversizeByHeader = (res: Response) => Number(res.headers.get("content-length")) > MAX_BLOB;

// Copy a URL to the clipboard with the same success/failure toasting the
// download actions use (writeText can reject on a denied clipboard grant).
const copyAddress = (text: string) =>
  navigator.clipboard
    ?.writeText(cleanSharedUrl(text))
    .then(() => toast("Address copied"))
    .catch(() => toast("Copy failed"));

// Download a media src by letting the WebView initiate the download, which the
// Rust `on_download` handler then writes to Downloads. (Custom commands can't
// be called from the remote Facebook origin, only plugins / WebView hooks.)
export async function downloadSrc(src: string, fallbackName: string): Promise<string> {
  // Fetch into a same-origin blob so the `download` attribute is honoured (it's
  // ignored for cross-origin URLs) and so we can derive the real extension.
  const res = await fetch(src);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  // Best-effort early reject before buffering the whole body into memory (a
  // response can omit or misreport Content-Length, so keep the post-read cap).
  if (oversizeByHeader(res)) throw new Error("file too large");
  const blob = await res.blob();
  if (blob.size > MAX_BLOB) throw new Error("file too large");
  const href = URL.createObjectURL(blob);
  let name = friendlyDownloadName(filenameFromUrl(src, location.href) || fallbackName);
  if (!name.includes(".")) {
    const ext = ((blob.type || "").split("/")[1] || "").split(";")[0];
    if (ext) name += `.${ext}`;
  }
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.setAttribute("data-carrier-native-download", "");
  a.style.display = "none";
  document.body.appendChild(a);
  try {
    const completion = waitForNativeDownload(window, href);
    a.click();
    return await completion;
  } finally {
    a.remove();
    URL.revokeObjectURL(href);
  }
}

async function copyImageSrc(src: string) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  if (oversizeByHeader(res)) throw new Error("image too large");
  const blob = await res.blob();
  if (blob.size > MAX_BLOB) throw new Error("image too large");
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

let ctxMenu: HTMLDivElement | null = null;
let ctxMenuReturnFocus: HTMLElement | null = null;
// This capture-phase listener runs before the row's own handler. Tearing the
// menu down here would detach the row first, leaving it unmeasurable — so a
// click inside the menu (which retargets to the host, the rows being in a
// closed root) is left for the row handler, which closes the menu itself.
const closeMenuFromClick = (event: Event) => {
  if (ctxMenu && event.target === ctxMenu) return;
  closeMenu();
};
const closeMenuFromScroll = () => closeMenu();
const closeMenu = (restoreFocus = false) => {
  ctxMenu?.remove();
  ctxMenu = null;
  document.removeEventListener("click", closeMenuFromClick, true);
  document.removeEventListener("scroll", closeMenuFromScroll, true);
  if (restoreFocus) ctxMenuReturnFocus?.focus({ preventScroll: true });
  ctxMenuReturnFocus = null;
};

export function initContextMenu() {
  document.addEventListener(
    "contextmenu",
    (e) => {
      // Remote page code must not be able to create Carrier's native-action menu.
      if (!e.isTrusted) return;
      const t = e.target as Element;
      const video = t.closest?.("video") || (t.closest?.("div")?.querySelector?.("video") ?? null);
      const img = t.closest?.("img[alt]") as HTMLImageElement | null;
      const anchor = t.closest?.("a[href]") as HTMLAnchorElement | null;
      const imgSrc = img && (img.currentSrc || img.src);
      const vidSrc = video && (video.currentSrc || video.src);
      const linkHref = anchor?.href;

      // Anchor for the macOS share sheet: viewport fractions survive the
      // download delay and window resizes better than raw pixels.
      const fx = e.clientX / Math.max(1, innerWidth);
      const fy = e.clientY / Math.max(1, innerHeight);
      const items: [string, () => unknown][] = [];
      const addItem = (item: [string, () => unknown]) => {
        // Defining an own index bypasses numeric setters Messenger could add
        // to Array.prototype before a user opens this privileged-action menu.
        nativeReflectApply(nativeObjectDefineProperty, items, [
          String(items.length),
          {
            value: item,
            writable: true,
            enumerable: true,
            configurable: true,
          },
        ]);
      };
      if (imgSrc) {
        addItem([
          "Copy image",
          () =>
            copyImageSrc(imgSrc)
              .then(() => toast("Image copied"))
              .catch(() => toast("Copy failed")),
        ]);
        addItem([
          "Download image",
          () =>
            downloadSrc(imgSrc, "image")
              .then(toastDownloadSaved)
              .catch(() => toast("Download failed")),
        ]);
        if (isMac) {
          addItem([
            "Share…",
            () => shareSrc(imgSrc, "image", fx, fy).catch(() => toast("Share failed")),
          ]);
        }
        addItem(["Copy image address", () => copyAddress(imgSrc)]);
        addItem(["Open image in browser", () => openUrl(imgSrc)]);
      } else if (vidSrc) {
        addItem([
          "Download video",
          () =>
            downloadSrc(vidSrc, "video")
              .then(toastDownloadSaved)
              .catch(() => toast("Download failed")),
        ]);
        if (isMac) {
          addItem([
            "Share…",
            () => shareSrc(vidSrc, "video", fx, fy).catch(() => toast("Share failed")),
          ]);
        }
        addItem(["Copy video address", () => copyAddress(vidSrc)]);
      } else if (linkHref && !linkHref.startsWith("javascript:")) {
        addItem(["Copy link address", () => copyAddress(linkHref)]);
        addItem(["Open link in browser", () => openUrl(linkHref)]);
      }
      if (!items.length) return; // fall through to the native menu (text etc.)

      e.preventDefault();
      if (isMac) {
        closeMenu();
        showNativeContextMenu(items);
        return;
      }
      // Capture the restore target before closeMenu()/menu creation shifts
      // focus. The right-click target is usually a non-focusable image or span,
      // so climb to the nearest focusable ancestor and fall back to whatever
      // held focus before the menu opened — never a bare image that .focus()
      // would silently no-op on, losing the user's place.
      const focusableSelector =
        'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
      const previouslyFocused = document.activeElement;
      // If a menu is already open and focus is inside it, closeMenu() is about
      // to detach that item — reuse the open menu's own restore target instead
      // of saving a node that .focus() can no longer reach.
      const priorReturnFocus = ctxMenu?.contains(previouslyFocused)
        ? ctxMenuReturnFocus
        : previouslyFocused instanceof HTMLElement && previouslyFocused !== document.body
          ? previouslyFocused
          : null;
      closeMenu();
      ctxMenuReturnFocus =
        (t.closest?.(focusableSelector) as HTMLElement | null) ?? priorReturnFocus;
      // The rows carry privileged actions, so they live in a *closed* shadow
      // root: Messenger shares this JS world and would otherwise be able to
      // find a row by its label and slide it under the pointer, turning the
      // user's genuine click into one for an action they never chose. A closed
      // root hands out no reference, so page script cannot reach the rows at
      // all; moving the host it can still see shifts every row together, which
      // the per-row geometry check below refuses.
      ctxMenu = document.createElement("div");
      Object.assign(ctxMenu.style, {
        position: "fixed",
        left: `${e.clientX}px`,
        top: `${e.clientY}px`,
        zIndex: 2147483647,
      });
      const shadow = nativeReflectApply(nativeAttachShadow, ctxMenu, [
        { mode: "closed" },
      ]) as ShadowRoot;
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "Media actions");
      Object.assign(menu.style, {
        background: "var(--card-background, Canvas)",
        color: "var(--primary-text, CanvasText)",
        border: "1px solid var(--divider, rgba(127,127,127,.3))",
        borderRadius: "8px",
        padding: "4px",
        boxShadow: "0 6px 24px rgba(0,0,0,.4)",
        minWidth: "170px",
        font: "13px -apple-system, system-ui, sans-serif",
      });
      const menuItems: HTMLElement[] = [];
      // Filled once the menu has been laid out, index-aligned with menuItems: a
      // row whose rectangle no longer matches its entry here is not the row the
      // user aimed at. Kept as a plain array rather than a Map keyed by row, so
      // no page-replaceable method is ever handed a row.
      const laidOutRects: MenuRect[] = [];
      let focusedIndex = 0;
      const activate = (fn: () => unknown) => {
        closeMenu();
        fn();
      };
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item) continue;
        const label = item[0];
        const fn = item[1];
        const el = document.createElement("div");
        el.textContent = label;
        el.setAttribute("role", "menuitem");
        el.tabIndex = -1;
        Object.assign(el.style, {
          padding: "8px 12px",
          cursor: "pointer",
          borderRadius: "6px",
          outline: "none",
        });
        el.onmouseenter = () =>
          (el.style.background = "var(--hover-overlay, rgba(127,127,127,.18))");
        el.onmouseleave = () => (el.style.background = "");
        el.onfocus = () => (el.style.background = "var(--hover-overlay, rgba(127,127,127,.18))");
        el.onblur = () => (el.style.background = "");
        nativeReflectApply(nativeAddEventListener, el, [
          "click",
          (ev: MouseEvent) => {
            if (!ev.isTrusted) return;
            ev.stopPropagation();
            const expected = laidOutRects[index];
            // No recorded rectangle means the click beat layout; refuse rather
            // than run a privileged action we cannot vouch for.
            if (
              !expected ||
              !pointerActivationIsSound(expected, rectOf(el), ev.clientX, ev.clientY)
            ) {
              closeMenu();
              toast("Menu action cancelled");
              return;
            }
            activate(fn);
          },
        ]);
        nativeReflectApply(nativeAddEventListener, el, [
          "keydown",
          (event: KeyboardEvent) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (!event.isTrusted) return;
            event.preventDefault();
            event.stopPropagation();
            // Keyboard activation needs no geometry check: focus lives inside
            // the closed root, so page script cannot move it to another row.
            activate(fn);
          },
        ]);
        nativeReflectApply(nativeArrayPush, menuItems, [el]);
        menu.appendChild(el);
      }
      shadow.appendChild(menu);
      document.body.appendChild(ctxMenu);
      const r = rectOf(menu);
      if (r.x + r.width > innerWidth) ctxMenu.style.left = `${innerWidth - r.width - 8}px`;
      if (r.y + r.height > innerHeight) ctxMenu.style.top = `${innerHeight - r.height - 8}px`;
      // Index loop, not for..of: iteration would run through a page-replaceable
      // Array.prototype[Symbol.iterator], handing out the rows again.
      for (let i = 0; i < menuItems.length; i += 1) {
        const row = menuItems[i];
        // Push unconditionally so the two arrays stay index-aligned; an empty
        // rectangle matches no real row, so it refuses rather than misfires.
        nativeReflectApply(nativeArrayPush, laidOutRects, [
          row ? rectOf(row) : { x: 0, y: 0, width: 0, height: 0 },
        ]);
      }
      nativeReflectApply(nativeAddEventListener, ctxMenu, [
        "keydown",
        (event: KeyboardEvent) => {
          // The host stays reachable from the page, so a synthetic ArrowDown or
          // End dispatched on it would otherwise move focus onto a row of the
          // page's choosing — inside the closed root, where it cannot reach
          // directly — and the user's next real Enter would activate it.
          if (!event.isTrusted) return;
          const current = focusedIndex;
          let next: number | null = null;
          if (event.key === "ArrowDown") next = (current + 1) % menuItems.length;
          if (event.key === "ArrowUp") next = (current - 1 + menuItems.length) % menuItems.length;
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = menuItems.length - 1;
          if (event.key === "Escape") {
            event.preventDefault();
            closeMenu(true);
            return;
          }
          if (event.key === "Tab") {
            // closeMenu(true) restores focus synchronously; block the browser's
            // own Tab move so focus stays on the restoration target.
            event.preventDefault();
            closeMenu(true);
            return;
          }
          if (next !== null) {
            event.preventDefault();
            focusedIndex = next;
            menuItems[next]?.focus();
          }
        },
      ]);
      focusedIndex = 0;
      menuItems[0]?.focus({ preventScroll: true });
      setTimeout(() => {
        document.addEventListener("click", closeMenuFromClick, true);
        document.addEventListener("scroll", closeMenuFromScroll, true);
      }, 0);
    },
    true,
  );
}
