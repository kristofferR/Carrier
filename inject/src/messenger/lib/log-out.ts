/*
 * Facebook's own Log Out (Ref #356): what its account menu does, so the
 * server ends the session rather than Chatpane just dropping cookies.
 * Facebook's handler (CometLogoutHandler.react) posts a logout token from
 * CometLogoutHandlerQuery to /logout.php.
 */
import { defaultExport, type Load, loadFacebookModules } from "./facebook-loader";
import { accountId } from "./threads";

interface Relay {
  fetchQuery(
    environment: unknown,
    query: unknown,
    variables: object,
    options?: object,
  ): { toPromise(): Promise<unknown> };
}

interface LogoutQueryData {
  logout_whitelist?: unknown;
  viewer?: { logout_hash?: unknown } | null;
}

export interface LogOutDeps {
  load: Load | null;
  cookie: () => string;
  post: (url: string, body: URLSearchParams) => Promise<unknown>;
}

/**
 * Ends the signed-in Facebook session. Resolves once the session cookie is
 * gone (at once when no one is signed in); rejects when it is still there.
 */
export async function logOutOfFacebook({ load, cookie, post }: LogOutDeps): Promise<void> {
  if (!accountId(cookie())) return;
  const [environment, relay, query, dtsg, route] = await loadFacebookModules(load, [
    "CometRelayEnvironment",
    "relay-runtime",
    "CometLogoutHandlerQuery.graphql",
    "DTSG",
    "XLogoutControllerRouteBuilder",
  ]);
  const data = (await (relay as Relay)
    .fetchQuery(defaultExport(environment), query, {}, { fetchPolicy: "network-only" })
    .toPromise()) as LogoutQueryData | null;
  const hash = data?.viewer?.logout_hash;
  if (typeof hash !== "string" || !hash) throw new Error("Facebook sent no logout token.");

  const body = new URLSearchParams({ h: hash, ref: "mb" });
  const token = (dtsg as { getToken?(): unknown }).getToken?.();
  if (typeof token === "string" && token) body.set("fb_dtsg", token);
  const built = (defaultExport(route) as { buildURL?(params: object): unknown }).buildURL?.({
    button_location: "settings",
    button_name: "logout",
  });
  const url = typeof built === "string" && built.startsWith("/logout.php") ? built : "/logout.php";
  // The response redirects to the login page; the cookie check decides.
  await post(url, body).catch(() => {});
  if (accountId(cookie())) throw new Error("Facebook didn't end the session.");

  // Facebook's own cleanup after logging out; best effort.
  try {
    const [monster, serviceWorker] = await loadFacebookModules(
      load,
      ["WebStorageMonster", "ServiceWorkerLoginAndLogout"],
      3000,
    );
    const whitelist = Array.isArray(data?.logout_whitelist) ? data.logout_whitelist : [];
    (defaultExport(monster) as { cleanOnLogout?(keep: unknown[]): void }).cleanOnLogout?.(
      whitelist,
    );
    (defaultExport(serviceWorker) as { logout?(): void }).logout?.();
  } catch (_) {}
}
