/* --------------------- Adaptive context menu -------------------------- */
// Right-click an image, video or link to get the relevant actions
// (download / copy / copy address / open in browser), matching the original.
import { cleanSharedUrl, openUrl, toast, toastDownloadSaved } from "../bridge";
import { waitForNativeDownload } from "../lib/download-completion";
import { filenameFromUrl, friendlyDownloadName } from "../lib/downloads";
import { type MenuRect, pointerActivationIsSound } from "../lib/menu-integrity";

const MAX_BLOB = 512 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE = 32 * 1024 * 1024;
const MAX_NATIVE_CONTEXT_VALUE = 64 * 1024;

// Keep these names and arrays in sync with src-tauri/src/menu.rs. A Rust test
// reads these declarations so the native allowlist cannot drift silently.
const IMAGE_CONTEXT_MENU_LABELS = [
  "Copy image",
  "Download image",
  "Share…",
  "Copy image address",
  "Open image in browser",
] as const;
const VIDEO_CONTEXT_MENU_LABELS = ["Download video", "Share…", "Copy video address"] as const;
const LINK_CONTEXT_MENU_LABELS = ["Copy link address", "Open link in browser"] as const;

// Capture the native registrar at document start. Messenger code runs in the
// same JS world and may replace the prototype before a menu is opened.
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeObjectDefineProperty = Object.defineProperty;
const nativeObjectEntries = Object.entries;
const nativeReflectApply = Reflect.apply;
const nativeSetStyleProperty = CSSStyleDeclaration.prototype.setProperty;
// Same reason: the menu's isolation depends on these being the real ones.
const nativeAttachShadow = Element.prototype.attachShadow;
const nativeAppendChild = Node.prototype.appendChild;
const nativeCreateElement = Document.prototype.createElement;
const nativeFocus = HTMLElement.prototype.focus;
const nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const nativeGetKeyboardKey = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "key")?.get;
const nativeGetStyle = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "style")?.get;
const nativeSetAttribute = Element.prototype.setAttribute;
const nativeSetTextContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")?.set;
const nativeSetTabIndex = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "tabIndex")?.set;
const NativeUint8Array = Uint8Array;
const nativeGetRandomValues = crypto.getRandomValues.bind(crypto);

const appendOwn = <T>(items: T[], item: T) => {
  nativeReflectApply(nativeObjectDefineProperty, undefined, [
    items,
    `${items.length}`,
    { value: item, writable: true, enumerable: true, configurable: true },
  ]);
};

const setStyleProperty = (style: CSSStyleDeclaration, property: string, value: string) => {
  nativeReflectApply(nativeSetStyleProperty, style, [property, value]);
};

const applyStyles = (style: CSSStyleDeclaration, values: Partial<CSSStyleDeclaration>) => {
  for (const [property, value] of nativeReflectApply(nativeObjectEntries, undefined, [values]) as [
    string,
    string,
  ][]) {
    const cssProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    setStyleProperty(style, cssProperty, value);
  }
};

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

type ContextMenuItem = [label: string, run: (action?: string) => unknown, value?: string];

type NativeActionHandler = [action: string, run: () => void];

// The opaque actions never leave this closure. The native side signs a selected
// action before evaluating its event, so page code can neither forge a choice
// nor swap it for another menu row.
let nativeActionHandlers: NativeActionHandler[] = [];

const clearNativeActionHandlers = () => {
  nativeActionHandlers = [];
};

async function runNativeAction(event: Event) {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return;
  const { action, signature } = detail as { action?: unknown; signature?: unknown };
  if (typeof action !== "string" || !carrierVerifyResult) return;
  if (!(await carrierVerifyResult("carrier:context-action", { action }, signature))) return;

  const handlers = nativeActionHandlers;
  for (let index = 0; index < handlers.length; index += 1) {
    const handler = handlers[index];
    if (!handler || handler[0] !== action) continue;
    clearNativeActionHandlers();
    handler[1]();
    return;
  }
}

function showNativeContextMenu(items: ContextMenuItem[]) {
  const nativeItems: { label: string; action: string; value?: string }[] = [];
  // Replacing a menu makes any still-open native rows stale. Keep handlers
  // until native selection or replacement instead of expiring a live menu.
  clearNativeActionHandlers();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const action = contextActionToken();
    const run = () => {
      item[1](action);
    };
    appendOwn(nativeActionHandlers, [action, run]);
    appendOwn(
      nativeItems,
      item[2] ? { label: item[0], action, value: item[2] } : { label: item[0], action },
    );
  }
  carrierShowContextMenu(nativeItems)?.catch(() => {
    clearNativeActionHandlers();
    toast("Menu failed");
  });
}

// Save the media through the trusted download flow (the sheet needs a real
// file), then ask the native side to share it, anchored at the click point.
async function shareSrc(src: string, fallbackName: string, fx: number, fy: number, action: string) {
  const href = await downloadSrc(src, fallbackName);
  await carrierShareDownload(href, fx, fy, action);
}

// True when the response advertises a Content-Length over the cap. Absent or
// unparseable headers yield 0 (falsy), so callers fall back to the blob check.
const oversizeByHeader = (res: Response) => Number(res.headers.get("content-length")) > MAX_BLOB;

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

async function copyImageSrc(src: string, action?: string) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  const maxSize = action ? MAX_CLIPBOARD_IMAGE : MAX_BLOB;
  if (Number(res.headers.get("content-length")) > maxSize) {
    throw new Error("image too large");
  }
  const blob = await res.blob();
  if (blob.size > maxSize) throw new Error("image too large");
  if (!action) {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return;
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
  await carrierCopyImage(dataUrl, action);
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
  if (restoreFocus && ctxMenuReturnFocus) {
    nativeReflectApply(nativeFocus, ctxMenuReturnFocus, [{ preventScroll: true }]);
  }
  ctxMenuReturnFocus = null;
};

export function initContextMenu() {
  if (!nativeGetKeyboardKey || !nativeGetStyle) return;
  nativeReflectApply(nativeAddEventListener, window, [
    "carrier:context-action",
    runNativeAction,
    true,
  ]);
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
      const items: ContextMenuItem[] = [];
      const addItem = (item: ContextMenuItem) => {
        // Defining an own index bypasses numeric setters Messenger could add
        // to Array.prototype before a user opens this privileged-action menu.
        appendOwn(items, item);
      };
      if (imgSrc) {
        addItem([
          IMAGE_CONTEXT_MENU_LABELS[0],
          (action) =>
            copyImageSrc(imgSrc, action)
              .then(() => toast("Image copied"))
              .catch(() => toast("Copy failed")),
        ]);
        addItem([
          IMAGE_CONTEXT_MENU_LABELS[1],
          () =>
            downloadSrc(imgSrc, "image")
              .then(toastDownloadSaved)
              .catch(() => toast("Download failed")),
        ]);
        if (isMac) {
          addItem([
            IMAGE_CONTEXT_MENU_LABELS[2],
            (action) =>
              action
                ? shareSrc(imgSrc, "image", fx, fy, action).catch(() => toast("Share failed"))
                : undefined,
          ]);
        }
        addItem([IMAGE_CONTEXT_MENU_LABELS[3], () => copyAddress(imgSrc), cleanSharedUrl(imgSrc)]);
        addItem([IMAGE_CONTEXT_MENU_LABELS[4], () => openUrl(imgSrc)]);
      } else if (vidSrc) {
        addItem([
          VIDEO_CONTEXT_MENU_LABELS[0],
          () =>
            downloadSrc(vidSrc, "video")
              .then(toastDownloadSaved)
              .catch(() => toast("Download failed")),
        ]);
        if (isMac) {
          addItem([
            VIDEO_CONTEXT_MENU_LABELS[1],
            (action) =>
              action
                ? shareSrc(vidSrc, "video", fx, fy, action).catch(() => toast("Share failed"))
                : undefined,
          ]);
        }
        addItem([VIDEO_CONTEXT_MENU_LABELS[2], () => copyAddress(vidSrc), cleanSharedUrl(vidSrc)]);
      } else if (linkHref && !linkHref.startsWith("javascript:")) {
        addItem([
          LINK_CONTEXT_MENU_LABELS[0],
          () => copyAddress(linkHref),
          cleanSharedUrl(linkHref),
        ]);
        addItem([LINK_CONTEXT_MENU_LABELS[1], () => openUrl(linkHref)]);
      }
      if (!items.length) return; // fall through to the native menu (text etc.)
      let hasOversizedNativeValue = false;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item?.[2] && item[2].length > MAX_NATIVE_CONTEXT_VALUE) {
          hasOversizedNativeValue = true;
          break;
        }
      }
      if (isMac && hasOversizedNativeValue) {
        // A native menu rejects an oversized copied address as untrusted input.
        // Leave the original menu intact so its remaining actions still work.
        clearNativeActionHandlers();
        return;
      }

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
      ctxMenu = nativeReflectApply(nativeCreateElement, document, ["div"]) as HTMLDivElement;
      const ctxMenuStyle = nativeReflectApply(nativeGetStyle, ctxMenu, []) as CSSStyleDeclaration;
      applyStyles(ctxMenuStyle, {
        position: "fixed",
        left: `${e.clientX}px`,
        top: `${e.clientY}px`,
        zIndex: "2147483647",
      });
      const shadow = nativeReflectApply(nativeAttachShadow, ctxMenu, [
        { mode: "closed" },
      ]) as ShadowRoot;
      const menu = nativeReflectApply(nativeCreateElement, document, ["div"]) as HTMLDivElement;
      nativeReflectApply(nativeSetAttribute, menu, ["role", "menu"]);
      nativeReflectApply(nativeSetAttribute, menu, ["aria-label", "Media actions"]);
      const menuStyle = nativeReflectApply(nativeGetStyle, menu, []) as CSSStyleDeclaration;
      applyStyles(menuStyle, {
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
        const el = nativeReflectApply(nativeCreateElement, document, ["div"]) as HTMLDivElement;
        if (!nativeSetTextContent) return;
        nativeReflectApply(nativeSetTextContent, el, [label]);
        nativeReflectApply(nativeSetAttribute, el, ["role", "menuitem"]);
        if (!nativeSetTabIndex) return;
        nativeReflectApply(nativeSetTabIndex, el, [-1]);
        const elStyle = nativeReflectApply(nativeGetStyle, el, []) as CSSStyleDeclaration;
        applyStyles(elStyle, {
          padding: "8px 12px",
          cursor: "pointer",
          borderRadius: "6px",
          outline: "none",
        });
        nativeReflectApply(nativeAddEventListener, el, [
          "mouseenter",
          () =>
            setStyleProperty(elStyle, "background", "var(--hover-overlay, rgba(127,127,127,.18))"),
        ]);
        nativeReflectApply(nativeAddEventListener, el, [
          "mouseleave",
          () => setStyleProperty(elStyle, "background", ""),
        ]);
        nativeReflectApply(nativeAddEventListener, el, [
          "focus",
          () =>
            setStyleProperty(elStyle, "background", "var(--hover-overlay, rgba(127,127,127,.18))"),
        ]);
        nativeReflectApply(nativeAddEventListener, el, [
          "blur",
          () => setStyleProperty(elStyle, "background", ""),
        ]);
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
            const key = nativeReflectApply(nativeGetKeyboardKey, event, []) as string;
            if (key !== "Enter" && key !== " ") return;
            if (!event.isTrusted) return;
            event.preventDefault();
            event.stopPropagation();
            // Keyboard activation needs no geometry check: focus lives inside
            // the closed root, so page script cannot move it to another row.
            activate(fn);
          },
        ]);
        appendOwn(menuItems, el);
        nativeReflectApply(nativeAppendChild, menu, [el]);
      }
      nativeReflectApply(nativeAppendChild, shadow, [menu]);
      nativeReflectApply(nativeAppendChild, document.body, [ctxMenu]);
      const r = rectOf(menu);
      if (r.x + r.width > innerWidth) ctxMenuStyle.left = `${innerWidth - r.width - 8}px`;
      if (r.y + r.height > innerHeight) ctxMenuStyle.top = `${innerHeight - r.height - 8}px`;
      // Index loop, not for..of: iteration would run through a page-replaceable
      // Array.prototype[Symbol.iterator], handing out the rows again.
      for (let i = 0; i < menuItems.length; i += 1) {
        const row = menuItems[i];
        // Append unconditionally so the two arrays stay index-aligned; an empty
        // rectangle matches no real row, so it refuses rather than misfires.
        appendOwn(laidOutRects, row ? rectOf(row) : { x: 0, y: 0, width: 0, height: 0 });
      }
      nativeReflectApply(nativeAddEventListener, ctxMenu, [
        "keydown",
        (event: KeyboardEvent) => {
          // The host stays reachable from the page, so a synthetic ArrowDown or
          // End dispatched on it would otherwise move focus onto a row of the
          // page's choosing — inside the closed root, where it cannot reach
          // directly — and the user's next real Enter would activate it.
          if (!event.isTrusted) return;
          const key = nativeReflectApply(nativeGetKeyboardKey, event, []) as string;
          const current = focusedIndex;
          let next: number | null = null;
          if (key === "ArrowDown") next = (current + 1) % menuItems.length;
          if (key === "ArrowUp") next = (current - 1 + menuItems.length) % menuItems.length;
          if (key === "Home") next = 0;
          if (key === "End") next = menuItems.length - 1;
          if (key === "Escape") {
            event.preventDefault();
            closeMenu(true);
            return;
          }
          if (key === "Tab") {
            // closeMenu(true) restores focus synchronously; block the browser's
            // own Tab move so focus stays on the restoration target.
            event.preventDefault();
            closeMenu(true);
            return;
          }
          if (next !== null) {
            event.preventDefault();
            focusedIndex = next;
            const nextItem = menuItems[next];
            if (nextItem) nativeReflectApply(nativeFocus, nextItem, []);
          }
        },
      ]);
      focusedIndex = 0;
      const firstItem = menuItems[0];
      if (firstItem) nativeReflectApply(nativeFocus, firstItem, [{ preventScroll: true }]);
      setTimeout(() => {
        document.addEventListener("click", closeMenuFromClick, true);
        document.addEventListener("scroll", closeMenuFromScroll, true);
      }, 0);
    },
    true,
  );
}
