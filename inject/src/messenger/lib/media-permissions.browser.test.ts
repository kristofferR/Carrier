import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

test.skipIf(!chromium)(
  "capture recovery lifecycle in a real DOM",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "carrier-permissions-test-"));
    try {
      const entry = fileURLToPath(new URL("../features/media-permissions.ts", import.meta.url));
      const bundle = await build({
        stdin: {
          contents: `import { initMediaPermissionWarning } from ${JSON.stringify(entry)}; (${runFixtures.toString()})(initMediaPermissionWarning);`,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const file = join(directory, "index.html");
      await writeFile(
        file,
        `<!doctype html><html><body><pre id="result">RUNNING</pre><script>${bundle.outputFiles[0]!.text}</script></body></html>`,
      );
      const process = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          "--window-size=480,900",
          "--virtual-time-budget=5000",
          "--dump-dom",
          pathToFileURL(file).href,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      const [output, errors, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(exit, errors).toBe(0);
      expect(output.match(/<pre id="result">([^<]+)/)?.[1]).toBe("PASS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

async function runFixtures(init: () => void) {
  const result = document.getElementById("result")!;
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  // Capture closed roots only in this synthetic fixture; production keeps the
  // native action buttons out of Messenger's DOM queries.
  const roots = new WeakMap<Element, ShadowRoot>();
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options) {
    const root = attach.call(this, options);
    roots.set(this, root);
    return root;
  };
  const banner = () => document.getElementById("carrier-media-permission-banner");
  const root = () => roots.get(banner()!)!;
  let nativeCalls = 0;
  Object.assign(window, {
    carrierOpenMediaPrivacy: async () => {
      nativeCalls++;
    },
  });
  try {
    for (const platform of ["macos", "windows", "linux"]) {
      Object.assign(window, { carrierMediaPlatform: platform });
      let error: DOMException | undefined;
      const track = new EventTarget();
      Object.assign(track, { readyState: "live", stop() {} });
      const stream = { getTracks: () => [track] };
      let pendingReject: ((error: DOMException) => void) | undefined;
      let pending = false;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (pending)
              return new Promise((_resolve, reject) => {
                pendingReject = reject;
              });
            if (error) throw error;
            return stream;
          },
        },
      });
      init();
      const capture = async (constraints: MediaStreamConstraints) => {
        try {
          await navigator.mediaDevices.getUserMedia(constraints);
        } catch (caught) {
          assert("original error preserved", caught === error);
        }
      };
      for (const constraints of [{ audio: true }, { video: true }, { audio: true, video: true }]) {
        error = new DOMException("fixture", "NotAllowedError");
        await capture(constraints);
        assert("persistent accessible denial", !!root().querySelector('[role="alert"]'));
        const text = root().textContent!;
        assert("microphone label", !constraints.audio || text.includes("microphone"));
        assert("camera label", !constraints.video || text.includes("camera"));
        const buttons = [...root().querySelectorAll<HTMLButtonElement>("button:not([hidden])")];
        assert(
          "platform actions",
          buttons.length ===
            (platform === "linux"
              ? 1
              : 1 + Number(!!constraints.audio) + Number(!!constraints.video)),
        );
        for (const button of buttons.slice(0, -1)) button.click();
        assert("no automatic or synthetic settings launch", nativeCalls === 0);
        const rect = banner()!.getBoundingClientRect();
        assert("fits viewport", rect.left >= 0 && rect.right <= innerWidth);
        buttons.at(-1)!.click();
        assert("dismiss", !banner());
      }
      for (const name of [
        "NotFoundError",
        "NotReadableError",
        "OverconstrainedError",
        "AbortError",
      ]) {
        error = new DOMException("fixture", name);
        await capture({ audio: true, video: true });
        assert(
          "non-denial has no privacy shortcut",
          root().querySelectorAll<HTMLButtonElement>("button:not([hidden])").length === 1,
        );
        assert("not mislabelled as denied", !root().textContent!.includes("Access was denied"));
      }
      error = undefined;
      await capture({ audio: true });
      assert("partial success preserves recovery", !!banner() && window.__carrierInCall === true);
      await capture({ video: true });
      assert("all requested devices recovered", !banner());
      track.dispatchEvent(new Event("ended"));
      assert("track ending restores refresh", window.__carrierInCall === false);
      pending = true;
      const concurrentFailure = capture({ video: true });
      pending = false;
      await capture({ audio: true });
      error = new DOMException("fixture", "NotAllowedError");
      pendingReject!(error);
      await concurrentFailure;
      assert("audio success does not suppress pending camera denial", !!banner());
      error = undefined;
      await capture({ audio: true });
      assert("audio success after camera denial preserves recovery", !!banner());
      await capture({ video: true });
      assert("camera success clears camera denial", !banner());
      error = new DOMException("fixture", "NotAllowedError");
      await capture({ video: true });
      error = new DOMException("fixture", "NotFoundError");
      await capture({ audio: true });
      assert(
        "independent failures keep their own guidance",
        root().textContent!.includes("Access was denied") &&
          root().textContent!.includes("No matching device"),
      );
      error = undefined;
      await capture({ audio: true });
      assert("later microphone recovery retains earlier camera failure", !!banner());
      await capture({ video: true });
      assert("independent device failures clear after both recover", !banner());
      error = new DOMException("fixture", "NotAllowedError");
      await capture({ video: true });
      pending = true;
      const lateFailure = capture({ video: true });
      root()
        .querySelectorAll<HTMLButtonElement>("button:not([hidden])")
        .item(platform === "linux" ? 0 : 1)
        .click();
      pendingReject!(error);
      await lateFailure;
      assert("dismissed pending failure stays dismissed", !banner());
    }
    let states = { camera: "denied", microphone: "allowed" };
    let reads = 0;
    let requests = 0;
    Object.assign(window, {
      carrierMediaPlatform: "macos",
      carrierMediaPermissionStatus: async (device?: "camera" | "microphone") => {
        reads++;
        if (device) requests++;
        return states;
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("fixture", "NotAllowedError");
        },
      },
    });
    init();
    const denied = () =>
      navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => {});
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    await denied();
    await settle();
    assert(
      "confirmed camera denial",
      root().querySelector("h2")!.textContent === "Camera access is blocked",
    );
    assert("separate microphone grant", root().textContent!.includes("Allowed by macOS"));
    assert(
      "only blocked device has action",
      root().querySelectorAll<HTMLButtonElement>("button:not([hidden])").length === 2,
    );
    states = { camera: "allowed", microphone: "allowed" };
    window.dispatchEvent(new Event("focus"));
    await settle();
    assert(
      "return from Settings refreshes status",
      root().querySelector("h2")!.textContent === "Access updated",
    );
    assert(
      "permission grant does not promise a working call",
      root().textContent!.includes("Try your call again in Messenger"),
    );
    states = { camera: "restricted", microphone: "allowed" };
    window.dispatchEvent(new Event("focus"));
    await settle();
    assert(
      "revoked permission cancels confirmation",
      root().querySelector("h2")!.textContent !== "Access updated",
    );
    assert(
      "restricted permission has no misleading grant button",
      root().querySelectorAll<HTMLButtonElement>("button:not([hidden])").length === 1,
    );
    states = { camera: "not-determined", microphone: "allowed" };
    window.dispatchEvent(new Event("focus"));
    await settle();
    assert(
      "unrequested permission offers explicit Allow",
      root().querySelector('button[aria-label="Allow access to camera"]')?.textContent ===
        "Allow access",
    );
    // Browsers may emit additional focus events while this fixture loads.
    window.dispatchEvent(new Event("focus"));
    await settle();
    const readsBeforeClick = reads;
    root()
      .querySelector('button[aria-label="Allow access to camera"]')!
      .dispatchEvent(new MouseEvent("click"));
    assert(
      "synthetic allow cannot request OS access",
      requests === 0 && reads === readsBeforeClick,
    );
    root().querySelector("footer button")!.dispatchEvent(new MouseEvent("click"));
    const readsAfterDismiss = reads;
    window.dispatchEvent(new Event("focus"));
    await settle();
    assert("dismiss releases focus listener", reads === readsAfterDismiss && !banner());
    let resolveStatus: ((value: typeof states) => void) | undefined;
    Object.assign(window, {
      carrierMediaPermissionStatus: () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    });
    await denied();
    root().querySelector("footer button")!.dispatchEvent(new MouseEvent("click"));
    resolveStatus!({ camera: "allowed", microphone: "allowed" });
    await settle();
    assert("late native result cannot resurrect dismissed card", !banner());
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = String(error);
  }
}
