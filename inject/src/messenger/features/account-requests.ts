/* ----------------------- Account requests ------------------------------ */
// Native asks through `window.__carrierAccount(request, action, value)` and
// reads the answer on `carrier:account-result`: Messenger's own account
// settings for Settings → Account (Ref #358).
import { diag, invoke } from "../bridge";
import { pageRequire } from "../lib/facebook-loader";
import { changeMessengerAccount, readMessengerAccount } from "../lib/messenger-account";
import { setMessengerDndUntil } from "../lib/messenger-dnd";
import { accountId } from "../lib/threads";

type Action = (value: unknown) => Promise<unknown>;

export function initAccountRequests() {
  if (!window.__TAURI_INTERNALS__) return;
  const signedIn = () => {
    const account = accountId(document.cookie);
    if (!account) throw new Error("Log in to Messenger first.");
    return account;
  };
  const actions: Record<string, Action> = {
    read: () => readMessengerAccount(pageRequire(), signedIn()),
    "set-active-status": (value) =>
      changeMessengerAccount(pageRequire(), signedIn(), {
        setting: "activeStatus",
        value: value === true,
      }),
    "set-sounds": (value) =>
      changeMessengerAccount(pageRequire(), signedIn(), {
        setting: "sounds",
        value: value === true,
      }),
    "set-dnd": async (value) => {
      const state = await changeMessengerAccount(pageRequire(), signedIn(), {
        setting: "doNotDisturb",
        value: Number(value),
      });
      // Notifications honor it at once rather than at the next refresh.
      setMessengerDndUntil(state.dndUntil);
      return state;
    },
  };
  const reply = (request: string, payload: object) =>
    invoke("plugin:event|emit", {
      event: "carrier:account-result",
      payload: { request, ...payload },
    });

  window.__carrierAccount = (request, action, value) => {
    const run = actions[action];
    (run ? Promise.resolve().then(() => run(value)) : Promise.reject(new Error("Unknown request")))
      .then((state) => reply(request, { ok: true, state }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        diag(`account.${action}`, message.slice(0, 200));
        return reply(request, { ok: false, error: message });
      });
  };
}
