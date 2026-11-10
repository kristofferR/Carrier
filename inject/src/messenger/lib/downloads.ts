/* Download-name helpers for the media download path (context menu + the
 * viewer's Download button). */
import { t } from "../../i18n";

/** The basename of a URL's path, when it looks like a real filename. */
export const filenameFromUrl = (u: string, base: string): string => {
  try {
    const p = new URL(u, base).pathname.split("/").pop();
    return p?.includes(".") ? decodeURIComponent(p) : "";
  } catch {
    return "";
  }
};

/**
 * The contents of a `data:` URL. Facebook's CSP stops `fetch()` reading one,
 * and Messenger draws some thumbnails from them. Null when malformed.
 */
export function dataUrlBlob(src: string): Blob | null {
  const match = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(src);
  if (!match) return null;
  const [, params = "", base64, data = ""] = match;
  const type = params.split(";")[0] || "text/plain";
  try {
    if (!base64) return new Blob([decodeURIComponent(data)], { type });
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
}

const GENERIC_DOWNLOAD_STEMS = new Set(["download", "image", "video"]);

export const splitDownloadName = (name: unknown): { stem: string; ext: string } => {
  const file =
    String(name || "")
      .trim()
      .split(/[\\/]/)
      .pop() || "";
  const dot = file.lastIndexOf(".");
  if (dot > 0 && dot < file.length - 1) {
    return { stem: file.slice(0, dot), ext: file.slice(dot) };
  }
  return { stem: file, ext: "" };
};

/** Swap Facebook's generic stems ("download.jpg") for a friendlier one. */
export const friendlyDownloadName = (name: string): string => {
  const { stem, ext } = splitDownloadName(name);
  if (!stem || GENERIC_DOWNLOAD_STEMS.has(stem.toLowerCase())) {
    // Keep the basename stable; Rust `unique_path` owns "(n)" de-duping.
    return `Messenger${ext}`;
  }
  return name;
};

export const downloadRevealLabel = (userAgent: string): string =>
  /Mac/i.test(userAgent) ? t("page.download.show_in_finder") : t("page.download.show_in_folder");

export const isDownloadCancellation = (error: unknown): boolean =>
  error instanceof Error && error.message === "download cancelled";

export const DOWNLOAD_ACCESS_DENIED = "download folder access denied";

export const isDownloadAccessDenied = (error: unknown): boolean =>
  error instanceof Error && error.message === DOWNLOAD_ACCESS_DENIED;

/** What the page says when the OS blocked Chatpane from the download folder.
 *  Only macOS has a settings pane that grants the access back. */
export const downloadAccessDeniedToast = (
  platform: "macos" | "windows" | "linux",
): { message: string; action?: ChatpaneToastAction } =>
  platform === "macos"
    ? {
        message: t("page.download.access_denied_macos"),
        action: { label: t("page.download.open_privacy_settings"), kind: "open-download-privacy" },
      }
    : { message: t("page.download.access_denied") };
