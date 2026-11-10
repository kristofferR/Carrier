import { t } from "../../i18n";
import { readMessengerDatabase } from "./messenger-db";

/**
 * Introduce an attached photo with the sender line, for a message that is
 * just one photo (`photo`) or has an empty body. Messenger's body is then
 * only its translated summary ("Sent a photo."). Link and caption text stay.
 */
export function notificationPhotoText(
  title: string,
  body: string,
  hasThumbnail: boolean,
  photo: boolean,
) {
  if (hasThumbnail && (photo || !body.trim())) {
    return { title: t("page.notification.sent_image", { name: title }), body: "" };
  }
  return { title, body };
}

interface PhotoQueries {
  fromTableAscending(table: unknown): { getKeyRange(...key: unknown[]): unknown };
  toArrayAsync(query: unknown): Promise<unknown>;
}

/**
 * Whether a message without text is a single photo, read from its
 * attachments as Messenger's own notification does. False when unknown.
 */
export async function readSinglePhoto(
  load: unknown,
  threadId: string,
  messageId: string,
): Promise<boolean> {
  const photo = await readMessengerDatabase(load, async ({ db, i64, load }) => {
    const q = load("ReQL") as PhotoQueries;
    const { unwrapIntEnum } = load("LSIntEnum") as { unwrapIntEnum(value: unknown): unknown };
    const types = load("MessagingAttachmentType") as { IMAGE: number; EPHEMERAL_IMAGE: number };
    const attachments = (db.tables as Record<string, unknown>).attachments;
    const rows = await q.toArrayAsync(
      q.fromTableAscending(attachments).getKeyRange(i64.of_string(threadId), messageId),
    );
    if (!Array.isArray(rows) || rows.length !== 1) return false;
    const kind = unwrapIntEnum((rows[0] as { attachmentType?: unknown }).attachmentType);
    return kind === types.IMAGE || kind === types.EPHEMERAL_IMAGE;
  });
  return photo === true;
}

/** Keep the whole image, bounded to the native notification decoder's limit. */
export function notificationThumbnailSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, 256 / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Best-effort CORS conversion, with a deadline so a photo cannot delay delivery indefinitely. */
export function notificationThumbnail(source: string, timeoutMs = 2500): Promise<string> {
  if (!source || timeoutMs <= 0) return Promise.resolve("");
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    let settled = false;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      resolve(result);
    };
    const timer = setTimeout(() => finish(""), Math.min(timeoutMs, 2500));
    image.onerror = () => finish("");
    image.onload = () => {
      try {
        const size = notificationThumbnailSize(image.naturalWidth, image.naturalHeight);
        if (!size) return finish("");
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        if (!context) return finish("");
        context.drawImage(image, 0, 0, size.width, size.height);
        finish(canvas.toDataURL("image/png"));
      } catch {
        finish("");
      }
    };
    image.src = source;
  });
}
