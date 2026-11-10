/* ----------------------- Account requests ------------------------------ */
// Native asks through `window.__chatpaneAccount(request, action, value)` and
// reads the answer on `chatpane:account-result`: Messenger's own account
// settings for Settings → Account (Ref #358), and Log Out (Ref #356).
import { t } from "../../i18n";
import { diag, invoke } from "../bridge";
import { pageRequire } from "../lib/facebook-loader";
import { logOutOfFacebook } from "../lib/log-out";
import { changeMessengerAccount, readMessengerAccount } from "../lib/messenger-account";
import { setMessengerDndUntil } from "../lib/messenger-dnd";
import { accountId } from "../lib/threads";

type Action = (value: unknown) => Promise<unknown>;

export function initAccountRequests() {
  if (!window.__TAURI_INTERNALS__) return;
  const signedIn = () => {
    const account = accountId(document.cookie);
    if (!account) throw new Error(t("page.account.log_in_first"));
    return account;
  };
  const actions: Record<string, Action> = {
    // Log Out (Ref #356): Facebook's own logout, so the session ends there too.
    "log-out": () =>
      logOutOfFacebook({
        load: pageRequire(),
        cookie: () => document.cookie,
        post: (url, body) => fetch(url, { method: "POST", body, credentials: "include" }),
      }).then(() => null),
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
    "set-read-receipts": (value) =>
      changeMessengerAccount(pageRequire(), signedIn(), {
        setting: "readReceipts",
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
      event: "chatpane:account-result",
      payload: { request, ...payload },
    });

  window.__chatpaneAccount = (request, action, value) => {
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
