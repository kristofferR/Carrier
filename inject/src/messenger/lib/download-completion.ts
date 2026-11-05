import { DOWNLOAD_ACCESS_DENIED } from "./downloads";

export const DOWNLOAD_FINISHED_EVENT = "carrier:download-finished";

const NativePromise = Promise;
const nativePromiseThen = Promise.prototype.then;
const nativeReflectApply = Reflect.apply;
// The listener and timer paths guard the same completion flow the Promise
// intrinsics above do: a replaced addEventListener would swallow every
// completion, a replaced removeEventListener would keep listeners observing
// after cleanup. `globalThis` rather than `window` so Bun tests load this
// module too.
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;

type DownloadFinishedDetail = {
  id: string;
  url: string;
  success: boolean;
  /** The OS refused Carrier access to the destination folder. */
  denied: boolean;
  signature: string;
};

type VerifyResult = (event: string, value: unknown, signature: unknown) => Promise<boolean>;

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
    typeof candidate.denied !== "boolean" ||
    typeof candidate.signature !== "string"
  )
    return null;
  return {
    id: candidate.id,
    url: candidate.url,
    success: candidate.success,
    denied: candidate.denied,
    signature: candidate.signature,
  };
}

// Field order matches the native `DownloadFinished` signature payload.
const verifyDetail = (verifyResult: VerifyResult, detail: DownloadFinishedDetail) =>
  verifyResult(
    DOWNLOAD_FINISHED_EVENT,
    { id: detail.id, url: detail.url, success: detail.success, denied: detail.denied },
    detail.signature,
  );

/**
 * Resolve only after Tauri's native download hook reports that the file was
 * written. The URL is a unique object URL created for this one download.
 */
export function waitForNativeDownload(
  target: EventTarget,
  expectedUrl: string,
  verifyResult: VerifyResult | undefined,
  timeoutMs = 120_000,
): Promise<NativeDownload> {
  return new NativePromise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      nativeReflectApply(nativeClearTimeout, globalThis, [timer]);
      nativeReflectApply(nativeRemoveEventListener, target, [DOWNLOAD_FINISHED_EVENT, onFinished]);
    };
    const onFinished: EventListener = (event) => {
      const detail = detailFor(event);
      if (!detail || detail.url !== expectedUrl) return;
      if (!verifyResult) {
        cleanup();
        reject(new Error("native download bridge unavailable"));
        return;
      }
      nativeReflectApply(nativePromiseThen, verifyDetail(verifyResult, detail), [
        (authenticated: boolean) => {
          if (!authenticated) return;
          cleanup();
          if (detail.success) resolve({ id: detail.id, url: detail.url });
          else reject(new Error(detail.denied ? DOWNLOAD_ACCESS_DENIED : "native download failed"));
        },
        () => {},
      ]);
    };

    nativeReflectApply(nativeAddEventListener, target, [DOWNLOAD_FINISHED_EVENT, onFinished]);
    timer = nativeReflectApply(nativeSetTimeout, globalThis, [
      () => {
        cleanup();
        reject(new Error("native download timed out"));
      },
      timeoutMs,
    ]) as ReturnType<typeof setTimeout>;
  });
}

/**
 * Call `onDenied` for every authenticated download the OS refused to save
 * because Carrier may not access the folder. This covers downloads nobody
 * awaits, such as attachment links the WebView turns into downloads itself.
 */
export function watchDeniedDownloads(
  target: EventTarget,
  verifyResult: VerifyResult | undefined,
  onDenied: () => void,
) {
  const onFinished: EventListener = (event) => {
    const detail = detailFor(event);
    if (!detail || detail.success || !detail.denied || !verifyResult) return;
    nativeReflectApply(nativePromiseThen, verifyDetail(verifyResult, detail), [
      (authenticated: boolean) => {
        if (authenticated) onDenied();
      },
      () => {},
    ]);
  };
  nativeReflectApply(nativeAddEventListener, target, [DOWNLOAD_FINISHED_EVENT, onFinished]);
}
