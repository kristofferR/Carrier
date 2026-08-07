import { describe, expect, test } from "bun:test";
import { DOWNLOAD_FINISHED_EVENT, waitForNativeDownload } from "./download-completion";

const acceptCompletion = async () => true;

function completionEvent(url: string, success: boolean, id = "download-id") {
  const event = new Event(DOWNLOAD_FINISHED_EVENT);
  Object.defineProperty(event, "detail", {
    value: { id, url, success, signature: "signature" },
  });
  return event;
}

describe("waitForNativeDownload", () => {
  test("resolves only for the matching successful native download", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:carrier/expected", acceptCompletion, 100);

    target.dispatchEvent(completionEvent("blob:carrier/other", true));
    target.dispatchEvent(completionEvent("blob:carrier/expected", true));

    await expect(pending).resolves.toEqual({
      id: "download-id",
      url: "blob:carrier/expected",
    });
  });

  test("rejects a matching native failure", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:carrier/expected", acceptCompletion, 100);

    target.dispatchEvent(completionEvent("blob:carrier/expected", false));

    await expect(pending).rejects.toThrow("native download failed");
  });

  test("rejects when the native hook never acknowledges the download", async () => {
    const target = new EventTarget();

    await expect(
      waitForNativeDownload(target, "blob:carrier/missing", acceptCompletion, 1),
    ).rejects.toThrow("native download timed out");
  });

  test("rejects when the verification bridge is unavailable", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:carrier/expected", undefined, 100);

    target.dispatchEvent(completionEvent("blob:carrier/expected", true));

    await expect(pending).rejects.toThrow("native download bridge unavailable");
  });

  test("ignores an unauthenticated completion", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:carrier/expected", async () => false, 20);

    target.dispatchEvent(completionEvent("blob:carrier/expected", true));

    await expect(pending).rejects.toThrow("native download timed out");
  });

  test("ignores a completion whose verification rejects", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(
      target,
      "blob:carrier/expected",
      async () => {
        throw new Error("bridge failure");
      },
      20,
    );

    target.dispatchEvent(completionEvent("blob:carrier/expected", true));

    await expect(pending).rejects.toThrow("native download timed out");
  });
});
