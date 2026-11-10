/*
 * The one-time "Enjoying Chatpane?" toast. Native code decides when it is due
 * (src-tauri/src/growth.rs) and calls `__chatpaneStarPrompt` as the window gains
 * focus; this shows it only at a quiet moment and reports it as shown, after
 * which native code never asks again.
 */

import { t } from "../i18n";

/** Wait after focus before checking, so a quick Alt+Tab past it never shows it. */
const SETTLE_MS = 2_000;
/** A key press this recent means the user is typing. */
const TYPING_QUIET_MS = 10_000;
const VISIBLE_MS = 20_000;

export interface StarPromptMoment {
  focused: boolean;
  messengerUi: boolean;
  dialogOpen: boolean;
  msSinceKey: number;
  draftLength: number;
}

/** Never over a draft, while typing, or on the login page or a dialog. */
export const isQuietMoment = (moment: StarPromptMoment) =>
  moment.focused &&
  moment.messengerUi &&
  !moment.dialogOpen &&
  moment.msSinceKey >= TYPING_QUIET_MS &&
  moment.draftLength === 0;

export function installStarPrompt() {
  let lastKey = Number.NEGATIVE_INFINITY;
  window.addEventListener("keydown", () => (lastKey = performance.now()), true);

  let shown = false;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const moment = (): StarPromptMoment => ({
    focused: document.visibilityState === "visible" && document.hasFocus(),
    // The chat list, so not the login page.
    messengerUi: Boolean(document.querySelector('[role="navigation"] a[href*="/t/"]')),
    dialogOpen: [...document.querySelectorAll('[role="dialog"]')].some(
      (dialog) => dialog.getClientRects().length > 0,
    ),
    msSinceKey: performance.now() - lastKey,
    draftLength: [
      ...document.querySelectorAll('[role="main"] [contenteditable="true"][role="textbox"]'),
    ].reduce((length, box) => length + (box.textContent?.trim().length ?? 0), 0),
  });

  Object.defineProperty(window, "__chatpaneStarPrompt", {
    value: () => {
      if (shown) return;
      clearTimeout(pending);
      pending = setTimeout(() => {
        if (shown || !isQuietMoment(moment())) return;
        shown = true;
        window.__chatpaneToast?.(
          t("page.growth.star_prompt"),
          { label: t("shared.growth.star"), kind: "star-github" },
          { duration: VISIBLE_MS, closable: true, bottom: 88 },
        );
        chatpaneStarPrompt("shown")?.catch?.(() => {});
      }, SETTLE_MS);
    },
    writable: false,
    configurable: false,
  });
}
