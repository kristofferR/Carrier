import { describe, expect, test } from "bun:test";
import { logOutOfFacebook } from "./log-out";

// A page module system whose Bootloader hands out the given modules.
function pageModules(modules: Record<string, unknown>) {
  const load = (name: string) => {
    if (name === "Bootloader") {
      return { loadModules: (_names: string[], done: () => void) => done() };
    }
    if (!(name in modules)) throw new Error(`missing ${name}`);
    return modules[name];
  };
  return load;
}

function facebook(hash: unknown) {
  return {
    CometRelayEnvironment: { default: "environment" },
    "relay-runtime": {
      fetchQuery: (environment: unknown) => ({
        toPromise: async () =>
          environment === "environment" ? { viewer: { logout_hash: hash } } : null,
      }),
    },
    "CometLogoutHandlerQuery.graphql": {},
    DTSG: { getToken: () => "dtsg-token" },
    XLogoutControllerRouteBuilder: {
      default: { buildURL: () => "/logout.php?button_location=settings&button_name=logout" },
    },
  };
}

describe("logOutOfFacebook", () => {
  test("posts Facebook's logout token and resolves once the session cookie is gone", async () => {
    let cookie = "c_user=1234; xs=secret";
    const posts: [string, string][] = [];
    await logOutOfFacebook({
      load: pageModules(facebook("hash-1")),
      cookie: () => cookie,
      post: async (url, body) => {
        posts.push([url, body.toString()]);
        cookie = "";
      },
    });
    expect(posts).toEqual([
      [
        "/logout.php?button_location=settings&button_name=logout",
        "h=hash-1&ref=mb&fb_dtsg=dtsg-token",
      ],
    ]);
  });

  test("fails while the session cookie remains, even when the request errored", async () => {
    const run = logOutOfFacebook({
      load: pageModules(facebook("hash-1")),
      cookie: () => "c_user=1234",
      post: () => Promise.reject(new TypeError("Load failed")),
    });
    await expect(run).rejects.toThrow("Facebook didn't end the session.");
  });

  test("refuses to post without a logout token", async () => {
    let posted = false;
    const run = logOutOfFacebook({
      load: pageModules(facebook(null)),
      cookie: () => "c_user=1234",
      post: async () => {
        posted = true;
      },
    });
    await expect(run).rejects.toThrow("Facebook sent no logout token.");
    expect(posted).toBe(false);
  });

  test("does nothing when no one is signed in", async () => {
    await logOutOfFacebook({
      load: null,
      cookie: () => "",
      post: () => Promise.reject(new Error("must not post")),
    });
  });
});
