/** Only the confirmed fatal dialog, never generic error copy or chat content. */
export function hasFacebookReloadDialog(): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  for (const dialog of document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"]',
  )) {
    const rect = dialog.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= innerHeight ||
      rect.left >= innerWidth
    ) {
      continue;
    }
    let hidden = false;
    for (let el: HTMLElement | null = dialog; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (
        el.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.contentVisibility === "hidden" ||
        Number(style.opacity) === 0
      ) {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;
    const hasTitle = [...dialog.querySelectorAll<HTMLElement>('h1, h2, h3, [role="heading"]')].some(
      (heading) => /^Sorry, something went wrong\.?$/.test(normalize(heading.innerText)),
    );
    if (
      hasTitle &&
      normalize(dialog.innerText).includes("Please try closing and re-opening your browser window.")
    ) {
      return true;
    }
  }
  return false;
}
