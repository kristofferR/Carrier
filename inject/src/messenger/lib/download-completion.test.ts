import { describe, expect, test } from "bun:test";
import {
  DOWNLOAD_FINISHED_EVENT,
  waitForNativeDownload,
  watchDeniedDownloads,
} from "./download-completion";
import { DOWNLOAD_ACCESS_DENIED } from "./downloads";

const acceptCompletion = async () => true;

function completionEvent(url: string, success: boolean, id = "download-id", denied = false) {
  const event = new Event(DOWNLOAD_FINISHED_EVENT);
  Object.defineProperty(event, "detail", {
    value: { id, url, success, denied, signature: "signature" },
  });
  return event;
}

describe("waitForNativeDownload", () => {
  test("resolves only for the matching successful native download", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:chatpane/expected", acceptCompletion, 100);

    target.dispatchEvent(completionEvent("blob:chatpane/other", true));
    target.dispatchEvent(completionEvent("blob:chatpane/expected", true));

    await expect(pending).resolves.toEqual({
      id: "download-id",
      url: "blob:chatpane/expected",
    });
  });

  test("rejects a matching native failure", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:chatpane/expected", acceptCompletion, 100);

    target.dispatchEvent(completionEvent("blob:chatpane/expected", false));

    await expect(pending).rejects.toThrow("native download failed");
  });

  test("rejects a folder-access refusal with its own error", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:chatpane/expected", acceptCompletion, 100);

    target.dispatchEvent(completionEvent("blob:chatpane/expected", false, "download-id", true));

    await expect(pending).rejects.toThrow(DOWNLOAD_ACCESS_DENIED);
  });

  test("rejects when the native hook never acknowledges the download", async () => {
    const target = new EventTarget();

    await expect(
      waitForNativeDownload(target, "blob:chatpane/missing", acceptCompletion, 1),
    ).rejects.toThrow("native download timed out");
  });

  test("rejects when the verification bridge is unavailable", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:chatpane/expected", undefined, 100);

    target.dispatchEvent(completionEvent("blob:chatpane/expected", true));

    await expect(pending).rejects.toThrow("native download bridge unavailable");
  });

  test("ignores an unauthenticated completion", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:chatpane/expected", async () => false, 20);

    target.dispatchEvent(completionEvent("blob:chatpane/expected", true));

    await expect(pending).rejects.toThrow("native download timed out");
  });

  test("ignores a completion whose verification rejects", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(
      target,
      "blob:chatpane/expected",
      async () => {
        throw new Error("bridge failure");
      },
      20,
    );

    target.dispatchEvent(completionEvent("blob:chatpane/expected", true));

    await expect(pending).rejects.toThrow("native download timed out");
  });
});

describe("watchDeniedDownloads", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("reports authenticated folder-access refusals for any download", async () => {
    const target = new EventTarget();
    const verified: unknown[] = [];
    let denied = 0;
    watchDeniedDownloads(
      target,
      async (_event, value) => {
        verified.push(value);
        return true;
      },
      () => {
        denied += 1;
      },
    );

    target.dispatchEvent(completionEvent("https://cdn.fbsbx.com/file.pdf", false, "a", true));
    target.dispatchEvent(completionEvent("blob:chatpane/failed", false, "b", false));
    target.dispatchEvent(completionEvent("blob:chatpane/saved", true, "c", false));
    await settle();

    expect(denied).toBe(1);
    // Key order is part of the signed wire contract with the native side.
    expect(JSON.stringify(verified)).toBe(
      '[{"id":"a","url":"https://cdn.fbsbx.com/file.pdf","success":false,"denied":true}]',
    );
  });

  test("ignores unauthenticated refusals", async () => {
    const target = new EventTarget();
    let denied = 0;
    watchDeniedDownloads(
      target,
      async () => false,
      () => {
        denied += 1;
      },
    );

    target.dispatchEvent(completionEvent("blob:chatpane/forged", false, "a", true));
    await settle();

    expect(denied).toBe(0);
  });
});
