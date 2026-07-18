export const DOWNLOAD_FINISHED_EVENT = "carrier:download-finished";

type DownloadFinishedDetail = {
  url: string;
  success: boolean;
};

function detailFor(event: Event): DownloadFinishedDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return null;
  const candidate = detail as Partial<DownloadFinishedDetail>;
  if (typeof candidate.url !== "string" || typeof candidate.success !== "boolean") return null;
  return { url: candidate.url, success: candidate.success };
}

/**
 * Resolve only after Tauri's native download hook reports that the file was
 * written. The URL is a unique object URL created for this one download.
 */
export function waitForNativeDownload(
  target: EventTarget,
  expectedUrl: string,
  timeoutMs = 120_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(DOWNLOAD_FINISHED_EVENT, onFinished);
    };
    const onFinished: EventListener = (event) => {
      const detail = detailFor(event);
      if (!detail || detail.url !== expectedUrl) return;
      cleanup();
      if (detail.success) resolve();
      else reject(new Error("native download failed"));
    };

    target.addEventListener(DOWNLOAD_FINISHED_EVENT, onFinished);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("native download timed out"));
    }, timeoutMs);
  });
}
