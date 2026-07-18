/* --------------------- Adaptive context menu -------------------------- */
// Right-click an image, video or link to get the relevant actions
// (download / copy / copy address / open in browser), matching the original.
import { openUrl, toast } from "../bridge";
import { filenameFromUrl, friendlyDownloadName } from "../lib/downloads";

const MAX_BLOB = 512 * 1024 * 1024;

// True when the response advertises a Content-Length over the cap. Absent or
// unparseable headers yield 0 (falsy), so callers fall back to the blob check.
const oversizeByHeader = (res: Response) => Number(res.headers.get("content-length")) > MAX_BLOB;

// Copy a URL to the clipboard with the same success/failure toasting the
// download actions use (writeText can reject on a denied clipboard grant).
const copyAddress = (text: string) =>
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast("Address copied"))
    .catch(() => toast("Copy failed"));

// Download a media src by letting the WebView initiate the download, which the
// Rust `on_download` handler then writes to Downloads. (Custom commands can't
// be called from the remote Facebook origin, only plugins / WebView hooks.)
export async function downloadSrc(src: string, fallbackName: string) {
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
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
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
const closeMenuFromPointer = () => closeMenu();
const closeMenu = (restoreFocus = false) => {
  ctxMenu?.remove();
  ctxMenu = null;
  document.removeEventListener("click", closeMenuFromPointer, true);
  document.removeEventListener("scroll", closeMenuFromPointer, true);
  if (restoreFocus) ctxMenuReturnFocus?.focus({ preventScroll: true });
  ctxMenuReturnFocus = null;
};

export function initContextMenu() {
  document.addEventListener(
    "contextmenu",
    (e) => {
      const t = e.target as Element;
      const video = t.closest?.("video") || (t.closest?.("div")?.querySelector?.("video") ?? null);
      const img = t.closest?.("img[alt]") as HTMLImageElement | null;
      const anchor = t.closest?.("a[href]") as HTMLAnchorElement | null;
      const imgSrc = img && (img.currentSrc || img.src);
      const vidSrc = video && (video.currentSrc || video.src);
      const linkHref = anchor?.href;

      const items: [string, () => unknown][] = [];
      if (imgSrc) {
        items.push([
          "Copy image",
          () =>
            copyImageSrc(imgSrc)
              .then(() => toast("Image copied"))
              .catch(() => toast("Copy failed")),
        ]);
        items.push([
          "Download image",
          () =>
            downloadSrc(imgSrc, "image")
              .then(() => toast("Saved to Downloads"))
              .catch(() => toast("Download failed")),
        ]);
        items.push(["Copy image address", () => copyAddress(imgSrc)]);
        items.push(["Open image in browser", () => openUrl(imgSrc)]);
      } else if (vidSrc) {
        items.push([
          "Download video",
          () =>
            downloadSrc(vidSrc, "video")
              .then(() => toast("Saved to Downloads"))
              .catch(() => toast("Download failed")),
        ]);
        items.push(["Copy video address", () => copyAddress(vidSrc)]);
      } else if (linkHref && !linkHref.startsWith("javascript:")) {
        items.push(["Copy link address", () => copyAddress(linkHref)]);
        items.push(["Open link in browser", () => openUrl(linkHref)]);
      }
      if (!items.length) return; // fall through to the native menu (text etc.)

      e.preventDefault();
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
      ctxMenu = document.createElement("div");
      ctxMenu.setAttribute("role", "menu");
      ctxMenu.setAttribute("aria-label", "Media actions");
      Object.assign(ctxMenu.style, {
        position: "fixed",
        left: `${e.clientX}px`,
        top: `${e.clientY}px`,
        zIndex: 2147483647,
        background: "var(--card-background, Canvas)",
        color: "var(--primary-text, CanvasText)",
        border: "1px solid var(--divider, rgba(127,127,127,.3))",
        borderRadius: "8px",
        padding: "4px",
        boxShadow: "0 6px 24px rgba(0,0,0,.4)",
        minWidth: "170px",
        font: "13px -apple-system, system-ui, sans-serif",
      });
      for (const [label, fn] of items) {
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
        el.onclick = (ev) => {
          ev.stopPropagation();
          closeMenu();
          fn();
        };
        ctxMenu.appendChild(el);
      }
      document.body.appendChild(ctxMenu);
      const r = ctxMenu.getBoundingClientRect();
      if (r.right > innerWidth) ctxMenu.style.left = `${innerWidth - r.width - 8}px`;
      if (r.bottom > innerHeight) ctxMenu.style.top = `${innerHeight - r.height - 8}px`;
      const menuItems = [...ctxMenu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      ctxMenu.addEventListener("keydown", (event) => {
        const current = Math.max(0, menuItems.indexOf(document.activeElement as HTMLElement));
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
        if ((event.key === "Enter" || event.key === " ") && document.activeElement) {
          event.preventDefault();
          (document.activeElement as HTMLElement).click();
          return;
        }
        if (next !== null) {
          event.preventDefault();
          menuItems[next]?.focus();
        }
      });
      menuItems[0]?.focus({ preventScroll: true });
      setTimeout(() => {
        document.addEventListener("click", closeMenuFromPointer, true);
        document.addEventListener("scroll", closeMenuFromPointer, true);
      }, 0);
    },
    true,
  );
}
