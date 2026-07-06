/* --------------------------- Link handling ---------------------------- */
// External links open in the real browser (Facebook's l.php tracking
// redirect is unwrapped on the Rust side). Internal links that would spawn a
// new window via Shift/Ctrl/Cmd/middle-click navigate in place instead
// (fixes the "Shift+Click internal links" bug).
import { openUrl } from "../bridge";
import { classifyHref } from "../lib/links";

function handleLink(e: MouseEvent) {
  const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.href;
  if (!href || href.startsWith("javascript:")) return;
  const modified = e.shiftKey || e.metaKey || e.ctrlKey || e.button === 1;
  const blank = a.target === "_blank";
  if (classifyHref(href, location.href).external) {
    e.preventDefault();
    e.stopImmediatePropagation();
    openUrl(href);
  } else if (modified || blank) {
    e.preventDefault();
    e.stopImmediatePropagation();
    location.href = href;
  }
}

export function initLinkHandling() {
  document.addEventListener("click", handleLink, true);
  document.addEventListener("auxclick", (e) => e.button === 1 && handleLink(e), true);
}
