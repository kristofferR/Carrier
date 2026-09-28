// Observed on Messenger's fatal close-and-reopen dialog after a long offline period.
const RELOAD_ERROR_CODE = 1357004;

/** Read the mounted exception's code; localized copy and chat content are irrelevant. */
function isReloadException(dialog: HTMLElement): boolean {
  try {
    const facebookRequire = (window as unknown as { require?: (name: string) => unknown }).require;
    const component = facebookRequire?.("FDSCometExceptionDialogImpl.react");
    if (typeof component !== "function") return false;
    const reactDOM = facebookRequire?.("ReactDOM") as
      | {
          __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { Events?: unknown };
        }
      | undefined;
    const events = reactDOM?.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?.Events;
    // Messenger's React build keeps host fibers in a WeakMap. Its first Events
    // accessor reads that map without changing React or invoking a component.
    if (!Array.isArray(events) || typeof events[0] !== "function") return false;
    let fiber: unknown = events[0](dialog);
    if (
      !fiber ||
      typeof fiber !== "object" ||
      !("stateNode" in fiber) ||
      fiber.stateNode !== dialog
    ) {
      return false;
    }
    for (let depth = 0; fiber && typeof fiber === "object" && depth < 80; depth++) {
      const node = fiber as { type?: unknown; memoizedProps?: unknown; return?: unknown };
      if (node.type === component) {
        const props = node.memoizedProps;
        return (
          !!props &&
          typeof props === "object" &&
          "errorCode" in props &&
          props.errorCode === RELOAD_ERROR_CODE
        );
      }
      fiber = node.return;
    }
  } catch (_) {
    // Missing modules or changed private APIs retain manual recovery.
  }
  return false;
}

export function hasFacebookReloadDialog(): boolean {
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
    if (!hidden && isReloadException(dialog)) return true;
  }
  return false;
}
