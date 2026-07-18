import { describe, expect, test } from "bun:test";
import { DOWNLOAD_FINISHED_EVENT, waitForNativeDownload } from "./download-completion";

function completionEvent(url: string, success: boolean) {
  const event = new Event(DOWNLOAD_FINISHED_EVENT);
  Object.defineProperty(event, "detail", { value: { url, success } });
  return event;
}

describe("waitForNativeDownload", () => {
  test("resolves only for the matching successful native download", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:carrier/expected", 100);

    target.dispatchEvent(completionEvent("blob:carrier/other", true));
    target.dispatchEvent(completionEvent("blob:carrier/expected", true));

    await expect(pending).resolves.toBeUndefined();
  });

  test("rejects a matching native failure", async () => {
    const target = new EventTarget();
    const pending = waitForNativeDownload(target, "blob:carrier/expected", 100);

    target.dispatchEvent(completionEvent("blob:carrier/expected", false));

    await expect(pending).rejects.toThrow("native download failed");
  });

  test("rejects when the native hook never acknowledges the download", async () => {
    const target = new EventTarget();

    await expect(waitForNativeDownload(target, "blob:carrier/missing", 1)).rejects.toThrow(
      "native download timed out",
    );
  });
});
