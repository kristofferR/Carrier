/* --------------------------- Hidden menus ------------------------------ */
// Chatpane's message and conversation menus learn what Messenger offers by
// opening Messenger's own menu briefly while hidden
// (data-carrier-message-menu-probe, see messenger.css), reading its rows,
// and closing it again. Choosing a row later opens it hidden once more and
// presses the matching row.

const PROBE_ATTRIBUTE = "data-carrier-message-menu-probe";
const POLL_MS = 16;
const MENU_WAIT_MS = 800;

export async function waitFor<T>(read: () => T | null | undefined, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (true) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const expanded = (button: HTMLElement) => button.getAttribute("aria-expanded") === "true";

/** The newest open menu that has rows; Messenger nests a labelled menu
 * inside an unlabelled one, and the inner one comes last. */
function openMenu(): Element | null {
  const menus = document.querySelectorAll('[role="menu"]');
  for (let index = menus.length - 1; index >= 0; index -= 1) {
    const menu = menus[index];
    if (menu?.querySelector('[role^="menuitem"]')) return menu;
  }
  return null;
}

/**
 * Open a menu button's menu hidden, hand it to `use`, and close it again
 * unless `use` picked a row (which closes it). Focus returns to where it was.
 */
export async function withHiddenMenu<T>(
  button: HTMLElement,
  use: (menu: Element) => T,
  picks = false,
): Promise<T | null> {
  const root = document.documentElement;
  const focused = document.activeElement;
  root.setAttribute(PROBE_ATTRIBUTE, "");
  try {
    if (!expanded(button)) button.click();
    const menu = await waitFor(() => (expanded(button) ? openMenu() : null), MENU_WAIT_MS);
    if (!menu) return null;
    const result = use(menu);
    if (picks && result) await waitFor(() => !expanded(button), MENU_WAIT_MS);
    return result;
  } finally {
    if (expanded(button)) {
      button.click();
      await waitFor(() => !expanded(button), MENU_WAIT_MS);
    }
    root.removeAttribute(PROBE_ATTRIBUTE);
    if (!picks && focused instanceof HTMLElement && focused.isConnected)
      focused.focus({ preventScroll: true });
  }
}
