export const DOWNLOAD_FINISHED_EVENT = "carrier:download-finished";

type DownloadFinishedDetail = {
  id: string;
  url: string;
  success: boolean;
  signature: string;
};

export type NativeDownload = {
  id: string;
  url: string;
};

function detailFor(event: Event): DownloadFinishedDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return null;
  const candidate = detail as Partial<DownloadFinishedDetail>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.url !== "string" ||
    typeof candidate.success !== "boolean" ||
    typeof candidate.signature !== "string"
  )
    return null;
  return {
    id: candidate.id,
    url: candidate.url,
    success: candidate.success,
    signature: candidate.signature,
  };
}

/**
 * Resolve only after Tauri's native download hook reports that the file was
 * written. The URL is a unique object URL created for this one download.
 */
export function waitForNativeDownload(
  target: EventTarget,
  expectedUrl: string,
  verifyResult:
    | ((event: string, value: unknown, signature: unknown) => Promise<boolean>)
    | undefined,
  timeoutMs = 120_000,
): Promise<NativeDownload> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(DOWNLOAD_FINISHED_EVENT, onFinished);
    };
    const onFinished: EventListener = (event) => {
      const detail = detailFor(event);
      if (!detail || detail.url !== expectedUrl) return;
      if (!verifyResult) {
        cleanup();
        reject(new Error("native download bridge unavailable"));
        return;
      }
      void verifyResult(
        DOWNLOAD_FINISHED_EVENT,
        { id: detail.id, url: detail.url, success: detail.success },
        detail.signature,
      )
        .then((authenticated) => {
          if (!authenticated) return;
          cleanup();
          if (detail.success) resolve({ id: detail.id, url: detail.url });
          else reject(new Error("native download failed"));
        })
        .catch(() => {});
    };

    target.addEventListener(DOWNLOAD_FINISHED_EVENT, onFinished);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("native download timed out"));
    }, timeoutMs);
  });
}
