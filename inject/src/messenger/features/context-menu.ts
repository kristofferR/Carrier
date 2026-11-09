/* --------------------- Adaptive context menu -------------------------- */
// Right-click an image, video or link to get the relevant actions
// (download / copy / copy address / open in browser), matching the original.
// Right-click a message (or press the context-menu key on a focused one) for
// its reactions and Messenger's own message actions, after any media actions.
// Right-click a conversation in the chat list for its own menu, plus export,
// in place of its link's. Selected text and other links keep their usual menus.
import { language, t } from "../../i18n";
import {
  cleanSharedUrl,
  openUrl,
  toast,
  toastDownloadFailure,
  toastDownloadSaved,
} from "../bridge";
import { CHAT_EXPORT_CONTEXT_MENU_KEYS, CHAT_ROW_CONTEXT_MENU_KEYS } from "../lib/chat-row-menu";
import { waitForNativeDownload } from "../lib/download-completion";
import { filenameFromUrl, friendlyDownloadName } from "../lib/downloads";
import { cssPropertyName, type MenuRect, pointerActivationIsSound } from "../lib/menu-integrity";
import {
  keyboardMenuPoint,
  MESSAGE_CONTEXT_MENU_KEYS,
  messageActions,
  type Reaction,
  reactionLabel,
} from "../lib/message-menu";
import { threadIdFromHref } from "../lib/threads";
import { chatRowFor, readChatRowActions, runChatRowAction } from "./chat-row-menu";
import { startConversationExport } from "./conversation-export";
import {
  messageFor,
  messageTextBlock,
  reactTo,
  readMessageOffer,
  runMessageAction,
} from "./message-menu";

const MAX_BLOB = 512 * 1024 * 1024;
// Native copying base64-encodes the blob before it crosses the IPC bridge, so
// the transferred payload is ~4/3 of this and the blob, decoded buffer, data
// URL, and IPC copy coexist at peak. Keep the cap conservative.
const MAX_CLIPBOARD_IMAGE = 16 * 1024 * 1024;
const MAX_NATIVE_CONTEXT_VALUE = 64 * 1024;

// Rows are named by the string keys of their labels, which the native side
// shows in the user's language. Keep these names and arrays in sync with
// src-tauri/src/menu.rs. A Rust test reads these declarations so the native
// allowlist cannot drift silently.
const IMAGE_CONTEXT_MENU_KEYS = [
  "shared.context.copy_image",
  "shared.context.download_image",
  "shared.context.share",
  "shared.context.copy_image_address",
  "shared.context.open_image_in_browser",
] as const;
const VIDEO_CONTEXT_MENU_KEYS = [
  "shared.context.download_video",
  "shared.context.share",
  "shared.context.copy_video_address",
] as const;
const LINK_CONTEXT_MENU_KEYS = [
  "shared.context.copy_link_address",
  "shared.context.open_link_in_browser",
] as const;

// The page-rendered menu's row labels and language, read at document start like the
// natives below: Messenger shares this JS world and could later rewrite the
// string table to mislabel a privileged row.
const ROW_LABELS: Record<string, string> = Object.fromEntries(
  [
    ...IMAGE_CONTEXT_MENU_KEYS,
    ...VIDEO_CONTEXT_MENU_KEYS,
    ...LINK_CONTEXT_MENU_KEYS,
    ...MESSAGE_CONTEXT_MENU_KEYS,
    ...CHAT_ROW_CONTEXT_MENU_KEYS,
    ...CHAT_EXPORT_CONTEXT_MENU_KEYS,
  ].map((key) => [key, t(key)]),
);
const ROW_LANGUAGE = language();

// Capture the native registrar at document start. Messenger code runs in the
// same JS world and may replace the prototype before a menu is opened.
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
const nativeObjectDefineProperty = Object.defineProperty;
const nativeObjectEntries = Object.entries;
const nativeReflectApply = Reflect.apply;
const nativeSetStyleProperty = CSSStyleDeclaration.prototype.setProperty;
const nativeSetTimeout = window.setTimeout;
// Same reason: the menu's isolation depends on these being the real ones.
const nativeAttachShadow = Element.prototype.attachShadow;
const nativeAppendChild = Node.prototype.appendChild;
const nativeContains = Node.prototype.contains;
const nativeCreateElement = Document.prototype.createElement;
const nativeFocus = HTMLElement.prototype.focus;
const nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const nativeGetEventTarget = Object.getOwnPropertyDescriptor(Event.prototype, "target")?.get;
const nativeGetMouseClientX = Object.getOwnPropertyDescriptor(MouseEvent.prototype, "clientX")?.get;
const nativeGetMouseClientY = Object.getOwnPropertyDescriptor(MouseEvent.prototype, "clientY")?.get;
const nativePreventDefault = Event.prototype.preventDefault;
const nativeRemove = Element.prototype.remove;
const nativeStopPropagation = Event.prototype.stopPropagation;
const nativeGetRectX = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "x")?.get;
const nativeGetRectY = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "y")?.get;
const nativeGetRectWidth = Object.getOwnPropertyDescriptor(DOMRectReadOnly.prototype, "width")?.get;
const nativeGetRectHeight = Object.getOwnPropertyDescriptor(
  DOMRectReadOnly.prototype,
  "height",
)?.get;
const nativeGetKeyboardKey = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "key")?.get;
const nativeGetStyle = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "style")?.get;
const nativeSetAttribute = Element.prototype.setAttribute;
const nativeSetTextContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")?.set;
const nativeSetTabIndex = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "tabIndex")?.set;
const NativePromise = Promise;
const NativeFileReader = FileReader;
const nativeReadAsDataURL = FileReader.prototype.readAsDataURL;
const nativeGetFileReaderResult = Object.getOwnPropertyDescriptor(
  FileReader.prototype,
  "result",
)?.get;
const NativeUint8Array = Uint8Array;
const nativeGetRandomValues = crypto.getRandomValues.bind(crypto);
const nativeShowContextMenu =
  typeof chatpaneShowContextMenu === "function" ? chatpaneShowContextMenu : undefined;

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
    setStyleProperty(style, cssPropertyName(property), value);
  }
};

const rectOf = (el: Element): MenuRect => {
  const r = nativeReflectApply(nativeGetBoundingClientRect, el, []) as DOMRect;
  return {
    x: nativeReflectApply(nativeGetRectX!, r, []) as number,
    y: nativeReflectApply(nativeGetRectY!, r, []) as number,
    width: nativeReflectApply(nativeGetRectWidth!, r, []) as number,
    height: nativeReflectApply(nativeGetRectHeight!, r, []) as number,
  };
};

const eventTargetOf = (event: Event) =>
  nativeReflectApply(nativeGetEventTarget!, event, []) as EventTarget | null;

const clientPointOf = (event: MouseEvent) => ({
  x: nativeReflectApply(nativeGetMouseClientX!, event, []) as number,
  y: nativeReflectApply(nativeGetMouseClientY!, event, []) as number,
});

// The macOS share sheet (NSSharingServicePicker) is native-only; other
// platforms have no equivalent Chatpane can reach, so the item stays hidden.
const isMac = /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);
const isLinux = !isMac && /linux/i.test(navigator.platform);

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

/** A row: its label's string key, or a reaction's emoji. */
type ContextMenuItem = [
  label: string,
  run: (action?: string) => unknown,
  value?: string,
  reaction?: Reaction,
];

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
  if (typeof action !== "string" || !chatpaneVerifyResult) return;
  if (!(await chatpaneVerifyResult("chatpane:context-action", { action }, signature))) return;

  const handlers = nativeActionHandlers;
  for (let index = 0; index < handlers.length; index += 1) {
    const handler = handlers[index];
    if (!handler || handler[0] !== action) continue;
    clearNativeActionHandlers();
    handler[1]();
    return;
  }
}

type NativeContextMenuItem = {
  label: string;
  action: string;
  value?: string;
  reaction?: true;
  checked?: true;
};

function showNativeContextMenu(
  items: ContextMenuItem[],
  position: [number, number] | null,
): Promise<void> {
  const nativeItems: NativeContextMenuItem[] = [];
  // Replacing a menu makes any still-open native rows stale. Keep handlers
  // until native selection or replacement instead of expiring a live menu.
  clearNativeActionHandlers();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const action = contextActionToken();
    const run = () => {
      item[1](isMac ? action : undefined);
    };
    appendOwn(nativeActionHandlers, [action, run]);
    const nativeItem: NativeContextMenuItem = { label: item[0], action };
    if (item[2]) nativeItem.value = item[2];
    if (item[3]) nativeItem.reaction = true;
    if (item[3]?.checked) nativeItem.checked = true;
    appendOwn(nativeItems, nativeItem);
  }
  if (!nativeShowContextMenu)
    return NativePromise.reject(new Error("native context menu unavailable"));
  return nativeShowContextMenu(nativeItems, position ?? undefined).catch((error: unknown) => {
    clearNativeActionHandlers();
    throw error;
  });
}

// Save the media through the trusted download flow (the sheet needs a real
// file), then ask the native side to share it, anchored at the click point.
async function shareSrc(src: string, fallbackName: string, fx: number, fy: number, action: string) {
  await chatpaneClaimContextAction(action);
  const { id } = await downloadSrc(src, fallbackName, action);
  await chatpaneShareDownload(id, fx, fy, action);
}

// True when the response advertises a Content-Length over the cap. Absent or
// unparseable headers yield 0 (falsy), so callers fall back to the blob check.
const oversizeByHeader = (res: Response) => Number(res.headers.get("content-length")) > MAX_BLOB;

const copyAddress = (text: string) =>
  navigator.clipboard
    ?.writeText(cleanSharedUrl(text))
    .then(() => toast(t("shared.context.address_copied")))
    .catch(() => toast(t("shared.context.copy_failed")));

const copyText = (text: string) =>
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast(t("shared.context.text_copied")))
    .catch(() => toast(t("shared.context.copy_failed")));

// Download a media src by letting the WebView initiate the download, which the
// Rust `on_download` handler then writes to Downloads. The page only prepares
// it (share binding, ask-mode save prompt) through `page_commands.rs`.
export async function downloadSrc(
  src: string,
  fallbackName: string,
  action?: string,
): Promise<{ id: string; url: string }> {
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
  a.setAttribute("data-chatpane-native-download", "");
  a.style.display = "none";
  document.body.appendChild(a);
  try {
    if (action) await chatpanePrepareDownload(action, href);
    if (window.__CHATPANE_SETTINGS__?.download_behavior === "ask") {
      await chatpaneChooseDownload(href, name);
    }
    const completion = waitForNativeDownload(window, href, chatpaneVerifyResult);
    a.click();
    return await completion;
  } finally {
    a.remove();
    URL.revokeObjectURL(href);
  }
}

async function copyImageSrc(src: string, action?: string) {
  if (action) await chatpaneClaimContextAction(action);
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
  const dataUrl = await new NativePromise<string>((resolve, reject) => {
    if (!nativeGetFileReaderResult) {
      reject(new Error("native FileReader result getter unavailable"));
      return;
    }
    const reader = new NativeFileReader();
    nativeReflectApply(nativeAddEventListener, reader, [
      "load",
      () => {
        const result = nativeReflectApply(nativeGetFileReaderResult, reader, []);
        if (typeof result === "string") resolve(result);
        else reject(new Error("image conversion failed"));
      },
      { once: true },
    ]);
    nativeReflectApply(nativeAddEventListener, reader, [
      "error",
      () => reject(new Error("image conversion failed")),
      { once: true },
    ]);
    nativeReflectApply(nativeReadAsDataURL, reader, [blob]);
  });
  await chatpaneCopyImage(dataUrl, action);
}

let ctxMenu: HTMLDivElement | null = null;
let ctxMenuReturnFocus: HTMLElement | null = null;
// This capture-phase listener runs before the row's own handler. Tearing the
// menu down here would detach the row first, leaving it unmeasurable — so a
// click inside the menu (which retargets to the host, the rows being in a
// closed root) is left for the row handler, which closes the menu itself.
const closeMenuFromClick = (event: Event) => {
  if (ctxMenu && eventTargetOf(event) === ctxMenu) return;
  closeMenu();
};
const closeMenuFromScroll = () => closeMenu();
const closeMenu = (restoreFocus = false) => {
  if (ctxMenu) nativeReflectApply(nativeRemove, ctxMenu, []);
  ctxMenu = null;
  nativeReflectApply(nativeRemoveEventListener, document, ["click", closeMenuFromClick, true]);
  nativeReflectApply(nativeRemoveEventListener, document, ["scroll", closeMenuFromScroll, true]);
  if (restoreFocus && ctxMenuReturnFocus) {
    nativeReflectApply(nativeFocus, ctxMenuReturnFocus, [{ preventScroll: true }]);
  }
  ctxMenuReturnFocus = null;
};

export function initContextMenu() {
  if (
    !nativeGetRectX ||
    !nativeGetRectY ||
    !nativeGetRectWidth ||
    !nativeGetRectHeight ||
    !nativeGetEventTarget ||
    !nativeGetMouseClientX ||
    !nativeGetMouseClientY ||
    !nativeGetKeyboardKey ||
    !nativeGetStyle ||
    !nativeSetTextContent ||
    !nativeSetTabIndex
  )
    return;
  nativeReflectApply(nativeAddEventListener, window, [
    "chatpane:context-action",
    runNativeAction,
    true,
  ]);
  let menuRequest = 0;
  const abandonMenu = (event: Event) => {
    if (!event.isTrusted) return;
    if (event.type === "keydown") {
      const key = nativeReflectApply(nativeGetKeyboardKey!, event, []) as string;
      if (key !== "Escape") return;
    }
    menuRequest += 1;
  };
  // Open Chatpane's menu for a genuine right-click, or for the context-menu
  // key on a focused message. `prevent` cancels the triggering event once the
  // menu is Chatpane's.
  const openContextMenu = async (
    target: Element,
    contextPoint: { x: number; y: number },
    keyboard: boolean,
    prevent: () => void,
    selectedByClick = false,
  ) => {
    const anchor = target.closest?.("a[href]") as HTMLAnchorElement | null;
    // A chat-list conversation's menu covers its avatar and preview images.
    const chatRow = anchor && chatRowFor(anchor);
    const video = chatRow
      ? null
      : target.closest?.("video") || (target.closest?.("div")?.querySelector?.("video") ?? null);
    const img = chatRow ? null : (target.closest?.("img[alt]") as HTMLImageElement | null);
    const imgSrc = img && (img.currentSrc || img.src);
    const vidSrc = video && (video.currentSrc || video.src);
    const linkHref = chatRow ? undefined : anchor?.href;

    // Anchor for the macOS share sheet: viewport fractions survive the
    // download delay and window resizes better than raw pixels.
    const fx = contextPoint.x / Math.max(1, innerWidth);
    const fy = contextPoint.y / Math.max(1, innerHeight);
    const items: ContextMenuItem[] = [];
    const addItem = (item: ContextMenuItem) => {
      // Defining an own index bypasses numeric setters Messenger could add
      // to Array.prototype before a user opens this privileged-action menu.
      appendOwn(items, item);
    };
    if (imgSrc) {
      addItem([
        IMAGE_CONTEXT_MENU_KEYS[0],
        (action) =>
          copyImageSrc(imgSrc, action)
            .then(() => toast(t("page.context.image_copied")))
            .catch(() => toast(t("shared.context.copy_failed"))),
      ]);
      addItem([
        IMAGE_CONTEXT_MENU_KEYS[1],
        () =>
          downloadSrc(imgSrc, "image")
            .then(({ url }) => toastDownloadSaved(url))
            .catch((error) => toastDownloadFailure(error)),
      ]);
      if (isMac) {
        addItem([
          IMAGE_CONTEXT_MENU_KEYS[2],
          (action) =>
            action
              ? shareSrc(imgSrc, "image", fx, fy, action).catch((error) =>
                  toastDownloadFailure(error, t("page.context.share_failed")),
                )
              : undefined,
        ]);
      }
      addItem([IMAGE_CONTEXT_MENU_KEYS[3], () => copyAddress(imgSrc), cleanSharedUrl(imgSrc)]);
      addItem([IMAGE_CONTEXT_MENU_KEYS[4], () => openUrl(imgSrc)]);
    } else if (vidSrc) {
      addItem([
        VIDEO_CONTEXT_MENU_KEYS[0],
        () =>
          downloadSrc(vidSrc, "video")
            .then(({ url }) => toastDownloadSaved(url))
            .catch((error) => toastDownloadFailure(error)),
      ]);
      if (isMac) {
        addItem([
          VIDEO_CONTEXT_MENU_KEYS[1],
          (action) =>
            action
              ? shareSrc(vidSrc, "video", fx, fy, action).catch((error) =>
                  toastDownloadFailure(error, t("page.context.share_failed")),
                )
              : undefined,
        ]);
      }
      addItem([VIDEO_CONTEXT_MENU_KEYS[2], () => copyAddress(vidSrc), cleanSharedUrl(vidSrc)]);
    } else if (linkHref && !linkHref.startsWith("javascript:")) {
      addItem([LINK_CONTEXT_MENU_KEYS[0], () => copyAddress(linkHref), cleanSharedUrl(linkHref)]);
      addItem([LINK_CONTEXT_MENU_KEYS[1], () => openUrl(linkHref)]);
    }
    // A link keeps its own menu, and selected text the webview's (so Copy
    // still copies the selection).
    // macOS selects the word under a right-click before the event arrives;
    // that selection is the click's, not the user's.
    const selection = getSelection();
    const selected =
      !selectedByClick &&
      selection !== null &&
      !selection.isCollapsed &&
      selection.containsNode(target, true);
    const message =
      (imgSrc || vidSrc || !items.length) && !(selected && !items.length)
        ? (messageFor(target) ?? null)
        : null;
    const conversation = selected ? null : chatRow;
    if (!items.length && !message && !conversation) return; // fall through to the native menu (text etc.)
    prevent();
    if (selectedByClick && selection && !selection.isCollapsed) selection.collapseToEnd();
    // The context-menu key reports no pointer on the message; pop up at it.
    // A keyboard-opened link menu anchors to the focused link itself.
    const keyboardPoint =
      message || keyboard
        ? keyboardMenuPoint(
            contextPoint,
            rectOf(target),
            rectOf(message ? (messageTextBlock(message) ?? message) : target),
          )
        : null;
    // Reading a message's actions takes a moment. A newer menu, a click, or
    // Escape in the meantime abandons this one.
    menuRequest += 1;
    const request = menuRequest;
    const readAbandonably = async <T>(read: () => Promise<T>): Promise<T> => {
      nativeReflectApply(nativeAddEventListener, document, ["pointerdown", abandonMenu, true]);
      nativeReflectApply(nativeAddEventListener, document, ["keydown", abandonMenu, true]);
      try {
        return await read();
      } finally {
        nativeReflectApply(nativeRemoveEventListener, document, ["pointerdown", abandonMenu, true]);
        nativeReflectApply(nativeRemoveEventListener, document, ["keydown", abandonMenu, true]);
      }
    };
    if (conversation) {
      const href = conversation.getAttribute("href") ?? "";
      const actions = await readAbandonably(() => readChatRowActions(conversation));
      if (request !== menuRequest) return;
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index];
        if (action) addItem([action, () => runChatRowAction(href, action)]);
      }
      const threadId = threadIdFromHref(href);
      if (threadId) {
        addItem([
          CHAT_EXPORT_CONTEXT_MENU_KEYS[0],
          () => startConversationExport("html", threadId),
        ]);
        addItem([
          CHAT_EXPORT_CONTEXT_MENU_KEYS[1],
          () => startConversationExport("json", threadId),
        ]);
      }
      if (!items.length) {
        toast(t("page.context.no_conversation_actions"));
        return;
      }
    }
    if (message) {
      const offer = await readAbandonably(() => readMessageOffer(message));
      if (request !== menuRequest) return;
      for (let index = 0; index < offer.reactions.length; index += 1) {
        const reaction = offer.reactions[index];
        if (reaction)
          addItem([
            reactionLabel(reaction.emoji),
            () => reactTo(message, reaction.emoji),
            undefined,
            reaction,
          ]);
      }
      const actions = messageActions(offer);
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index];
        if (action === MESSAGE_CONTEXT_MENU_KEYS[1])
          addItem([action, () => copyText(offer.text), offer.text]);
        else if (action) addItem([action, () => runMessageAction(message, action)]);
      }
      if (!items.length) {
        toast(t("page.context.no_message_actions"));
        return;
      }
    }
    // The native side rejects an oversized copied address as untrusted
    // input, which would reject the whole menu shape. The page-rendered
    // menu below copies through its own closure and needs no native value,
    // so route there instead — every row keeps working.
    let nativeItemsAreValid = true;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item?.[2] && item[2].length > MAX_NATIVE_CONTEXT_VALUE) {
        nativeItemsAreValid = false;
        break;
      }
    }

    // Copying an image through the page clipboard must remain inside the
    // trusted right-click activation. macOS uses Chatpane's native pasteboard;
    // other platforms keep image menus in-page until they have an equivalent.
    const nativeImageCopyIsSafe = isMac || !imgSrc;
    // A GTK menu popped up without a pointer event gets no keyboard focus on
    // Wayland, so a keyboard-opened Linux menu stays in the page, where
    // arrows, Enter, and Escape work.
    const nativeTakesKeyboard = !keyboard || !isLinux;
    if (
      nativeShowContextMenu &&
      nativeItemsAreValid &&
      nativeImageCopyIsSafe &&
      nativeTakesKeyboard
    ) {
      try {
        // GTK on Wayland cannot place a menu at the pointer once the click
        // event is gone, so Linux always names the point. Native zoom
        // scales CSS pixels to window coordinates.
        const zoom = (Number(window.__CHATPANE_SETTINGS__?.zoom) || 100) / 100;
        const point = keyboardPoint ?? (isLinux ? [contextPoint.x, contextPoint.y] : null);
        await showNativeContextMenu(
          items,
          point ? [Math.round(point[0] * zoom), Math.round(point[1] * zoom)] : null,
        );
        return;
      } catch {
        // The authenticated native result says presentation failed. Continue
        // into the hardened page-rendered menu so the click is not swallowed.
      }
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
    const priorReturnFocus =
      ctxMenu && nativeReflectApply(nativeContains, ctxMenu, [previouslyFocused])
        ? ctxMenuReturnFocus
        : previouslyFocused instanceof HTMLElement && previouslyFocused !== document.body
          ? previouslyFocused
          : null;
    closeMenu();
    ctxMenuReturnFocus =
      (target.closest?.(focusableSelector) as HTMLElement | null) ?? priorReturnFocus;
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
      left: `${keyboardPoint?.[0] ?? contextPoint.x}px`,
      top: `${keyboardPoint?.[1] ?? contextPoint.y}px`,
      zIndex: "2147483647",
    });
    const shadow = nativeReflectApply(nativeAttachShadow, ctxMenu, [
      { mode: "closed" },
    ]) as ShadowRoot;
    const menu = nativeReflectApply(nativeCreateElement, document, ["div"]) as HTMLDivElement;
    nativeReflectApply(nativeSetAttribute, menu, ["role", "menu"]);
    nativeReflectApply(nativeSetAttribute, menu, ["lang", ROW_LANGUAGE.lang]);
    nativeReflectApply(nativeSetAttribute, menu, ["dir", ROW_LANGUAGE.dir]);
    nativeReflectApply(nativeSetAttribute, menu, [
      "aria-label",
      t(
        message
          ? "page.context.message_actions"
          : conversation
            ? "page.context.conversation_actions"
            : "page.context.media_actions",
      ),
    ]);
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
    // Quick reactions share one row, like Messenger's own reaction bar.
    let reactionRow: HTMLDivElement | null = null;
    // Media rows, reactions, message actions, and conversation actions are
    // separated like the native menu's groups.
    let previousGroup: number | null = null;
    // Filled once the menu has been laid out, index-aligned with menuItems: a
    // row whose rectangle no longer matches its entry here is not the row the
    // user aimed at. Kept as a plain array rather than a Map keyed by row, so
    // no page-replaceable method is ever handed a row.
    const laidOutRects: MenuRect[] = [];
    let focusedIndex = 0;
    // Keyboard activation restores focus to where the user was (like Escape
    // does); a pointer click already established a new focus context.
    const activate = (fn: () => unknown, restoreFocus = false) => {
      closeMenu(restoreFocus);
      fn();
    };
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item) continue;
      const label = item[0];
      if (isMac && (label === IMAGE_CONTEXT_MENU_KEYS[2] || label === VIDEO_CONTEXT_MENU_KEYS[1])) {
        // The native-only share action has no authorization token in the
        // page-rendered fallback menu.
        continue;
      }
      const fn = item[1];
      const rowIndex = menuItems.length;
      const reaction = item[3];
      const group = reaction
        ? 1
        : (MESSAGE_CONTEXT_MENU_KEYS as readonly string[]).includes(label)
          ? 2
          : conversation && (CHAT_ROW_CONTEXT_MENU_KEYS as readonly string[]).includes(label)
            ? 3
            : conversation && (CHAT_EXPORT_CONTEXT_MENU_KEYS as readonly string[]).includes(label)
              ? 4
              : 0;
      if (previousGroup !== null && previousGroup !== group) {
        const divider = nativeReflectApply(nativeCreateElement, document, [
          "div",
        ]) as HTMLDivElement;
        nativeReflectApply(nativeSetAttribute, divider, ["role", "separator"]);
        applyStyles(nativeReflectApply(nativeGetStyle, divider, []) as CSSStyleDeclaration, {
          height: "1px",
          margin: "4px 8px",
          background: "var(--divider, rgba(127,127,127,.3))",
        });
        nativeReflectApply(nativeAppendChild, menu, [divider]);
      }
      previousGroup = group;
      const el = nativeReflectApply(nativeCreateElement, document, ["div"]) as HTMLDivElement;
      nativeReflectApply(nativeSetTextContent, el, [
        reaction ? label : (ROW_LABELS[label] ?? label),
      ]);
      nativeReflectApply(nativeSetAttribute, el, [
        "role",
        reaction ? "menuitemcheckbox" : "menuitem",
      ]);
      if (reaction) {
        nativeReflectApply(nativeSetAttribute, el, [
          "aria-label",
          t("page.context.react_with", { emoji: label }),
        ]);
        nativeReflectApply(nativeSetAttribute, el, ["aria-checked", `${reaction.checked}`]);
      }
      nativeReflectApply(nativeSetTabIndex, el, [-1]);
      const elStyle = nativeReflectApply(nativeGetStyle, el, []) as CSSStyleDeclaration;
      applyStyles(elStyle, {
        padding: reaction ? "6px 8px" : "8px 12px",
        cursor: "pointer",
        borderRadius: "6px",
        outline: "none",
      });
      if (reaction) {
        applyStyles(elStyle, { fontSize: "18px", lineHeight: "1" });
        if (reaction.checked) setStyleProperty(elStyle, "box-shadow", "inset 0 0 0 2px Highlight");
      }
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
        () => {
          // WebKit focuses a tabIndex=-1 row on click; keep arrow navigation
          // anchored to the row that actually holds focus.
          focusedIndex = rowIndex;
          setStyleProperty(elStyle, "background", "var(--hover-overlay, rgba(127,127,127,.18))");
        },
      ]);
      nativeReflectApply(nativeAddEventListener, el, [
        "blur",
        () => setStyleProperty(elStyle, "background", ""),
      ]);
      nativeReflectApply(nativeAddEventListener, el, [
        "click",
        (ev: MouseEvent) => {
          if (!ev.isTrusted) return;
          nativeReflectApply(nativeStopPropagation, ev, []);
          const expected = laidOutRects[rowIndex];
          const point = clientPointOf(ev);
          // No recorded rectangle means the click beat layout; refuse rather
          // than run a privileged action we cannot vouch for.
          if (!expected || !pointerActivationIsSound(expected, rectOf(el), point.x, point.y)) {
            closeMenu();
            toast(t("page.context.action_cancelled"));
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
          nativeReflectApply(nativePreventDefault, event, []);
          nativeReflectApply(nativeStopPropagation, event, []);
          // Keyboard activation needs no geometry check: focus lives inside
          // the closed root, so page script cannot move it to another row.
          activate(fn, true);
        },
      ]);
      appendOwn(menuItems, el);
      if (reaction) {
        if (!reactionRow) {
          reactionRow = nativeReflectApply(nativeCreateElement, document, [
            "div",
          ]) as HTMLDivElement;
          nativeReflectApply(nativeSetAttribute, reactionRow, ["role", "group"]);
          nativeReflectApply(nativeSetAttribute, reactionRow, [
            "aria-label",
            t("shared.context.react"),
          ]);
          applyStyles(nativeReflectApply(nativeGetStyle, reactionRow, []) as CSSStyleDeclaration, {
            display: "flex",
            gap: "2px",
          });
          nativeReflectApply(nativeAppendChild, menu, [reactionRow]);
        }
        nativeReflectApply(nativeAppendChild, reactionRow, [el]);
      } else {
        nativeReflectApply(nativeAppendChild, menu, [el]);
      }
    }
    nativeReflectApply(nativeAppendChild, shadow, [menu]);
    nativeReflectApply(nativeAppendChild, document.body, [ctxMenu]);
    const r = rectOf(menu);
    if (r.x + r.width > innerWidth) {
      setStyleProperty(ctxMenuStyle, "left", `${innerWidth - r.width - 8}px`);
    }
    if (r.y + r.height > innerHeight) {
      setStyleProperty(ctxMenuStyle, "top", `${innerHeight - r.height - 8}px`);
    }
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
          nativeReflectApply(nativePreventDefault, event, []);
          closeMenu(true);
          return;
        }
        if (key === "Tab") {
          // closeMenu(true) restores focus synchronously; block the browser's
          // own Tab move so focus stays on the restoration target.
          nativeReflectApply(nativePreventDefault, event, []);
          closeMenu(true);
          return;
        }
        if (next !== null) {
          nativeReflectApply(nativePreventDefault, event, []);
          focusedIndex = next;
          const nextItem = menuItems[next];
          if (nextItem) nativeReflectApply(nativeFocus, nextItem, []);
        }
      },
    ]);
    focusedIndex = 0;
    const firstItem = menuItems[0];
    if (firstItem) nativeReflectApply(nativeFocus, firstItem, [{ preventScroll: true }]);
    nativeReflectApply(nativeSetTimeout, window, [
      () => {
        nativeReflectApply(nativeAddEventListener, document, ["click", closeMenuFromClick, true]);
        nativeReflectApply(nativeAddEventListener, document, ["scroll", closeMenuFromScroll, true]);
      },
      0,
    ]);
  };
  // WebKitGTK sends no contextmenu event for the context-menu key or
  // Shift+F10, so a focused message opens its menu from the key itself.
  // Platforms that do send one get that duplicate suppressed.
  let keyboardMenu: { target: Element; at: number } | null = null;
  nativeReflectApply(nativeAddEventListener, window, [
    "keydown",
    (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      const key = nativeReflectApply(nativeGetKeyboardKey!, event, []) as string;
      if (key !== "ContextMenu" && !(key === "F10" && event.shiftKey)) return;
      const focused = document.activeElement;
      const message = focused && messageFor(focused);
      if (!focused || !message) return;
      // Selected text touching the message keeps the webview's own menu, so
      // Copy copies it. This covers every selection openContextMenu would
      // defer for, since the focused element lies inside the message.
      const selection = getSelection();
      if (selection && !selection.isCollapsed && selection.containsNode(message, true)) return;
      nativeReflectApply(nativePreventDefault, event, []);
      nativeReflectApply(nativeStopPropagation, event, []);
      keyboardMenu = { target: focused, at: Date.now() };
      void openContextMenu(focused, { x: -1, y: -1 }, true, () => {});
    },
    true,
  ]);
  // Whether text was selected when the secondary button went down, before
  // macOS selects the word under the pointer for the context click.
  let secondaryPress: { collapsed: boolean; at: number } | null = null;
  nativeReflectApply(nativeAddEventListener, window, [
    "mousedown",
    (e: MouseEvent) => {
      if (!e.isTrusted || !(e.button === 2 || (isMac && e.button === 0 && e.ctrlKey))) return;
      secondaryPress = { collapsed: getSelection()?.isCollapsed ?? true, at: Date.now() };
    },
    true,
  ]);
  nativeReflectApply(nativeAddEventListener, document, [
    "contextmenu",
    (e: MouseEvent) => {
      // Remote page code must not be able to create Chatpane's native-action menu.
      if (!e.isTrusted) return;
      const target = eventTargetOf(e) as Element;
      const duplicate = keyboardMenu?.target === target && Date.now() - keyboardMenu.at < 1000;
      keyboardMenu = null;
      if (duplicate) {
        nativeReflectApply(nativePreventDefault, e, []);
        return;
      }
      const selectedByClick = !!secondaryPress?.collapsed && Date.now() - secondaryPress.at < 1000;
      secondaryPress = null;
      void openContextMenu(
        target,
        clientPointOf(e),
        false,
        () => nativeReflectApply(nativePreventDefault, e, []),
        selectedByClick,
      );
    },
    true,
  ]);
}
