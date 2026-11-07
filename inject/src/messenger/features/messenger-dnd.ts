/* ------------------ Honor Messenger's Do Not Disturb -------------------- */
// Keep Messenger's account-level Do Not Disturb (set here, in Messenger's
// settings or on the phone) current, so notification delivery can honor it
// (Ref #353). A failed read keeps the last known state.
import { diag } from "../bridge";
import {
  messengerDndActive,
  readMessengerDndUntil,
  setMessengerDndUntil,
} from "../lib/messenger-dnd";
import { accountId } from "../lib/threads";

const REFRESH_MS = 30_000;

export function initMessengerDnd() {
  let reading = false;
  let lastActive: boolean | null = null;
  let unavailableReported = false;
  const refresh = () => {
    const account = accountId(document.cookie);
    if (reading || !account) return;
    reading = true;
    readMessengerDndUntil(account, (window as unknown as { require?: unknown }).require)
      .then((until) => {
        if (until === null) {
          // Its own diag key: sharing one with the state lines let the
          // per-minute limit drop the recovery that follows a slow first read.
          if (!unavailableReported) {
            diag("notify.messenger-dnd-unreadable", "Do Not Disturb unreadable");
          }
          unavailableReported = true;
          // Report the state again once a read succeeds.
          lastActive = null;
          return;
        }
        unavailableReported = false;
        setMessengerDndUntil(until);
        const active = messengerDndActive();
        if (active !== lastActive) diag("notify.messenger-dnd", active ? "on" : "off");
        lastActive = active;
      })
      .finally(() => {
        reading = false;
      });
  };
  setInterval(refresh, REFRESH_MS);
  window.addEventListener("focus", refresh);
  if (document.readyState === "complete") refresh();
  else window.addEventListener("load", refresh, { once: true });
}
