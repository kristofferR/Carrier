/**
 * Pure logic for share-into-Carrier delivery (Ref #214): validating the
 * native payload and deciding when a parked share is still deliverable.
 */

export type SharedFile = { name: string; data: string };

// The extension's activation rule allows 10 images + 1 movie + 10 files in
// one mixed selection; every advertised selection must survive sanitizing.
export const MAX_SHARED_FILES = 21;
export const MAX_SHARED_NAME_BYTES = 255;
/** Base64 of the native side's 100 MB cap, with slack for encoding overhead. */
export const MAX_SHARED_DATA_LENGTH = 140 * 1024 * 1024;
/** Matches the native SHARE_INTAKE_TTL: an old share must not surprise. */
export const SHARE_DELIVERY_TTL_MS = 2 * 60 * 1000;

const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  ["pdf", "application/pdf"],
]);

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

/** Dispatch a synthetic file-transfer event and prove a handler inspected it. */
export function dispatchTransferEvent(
  target: Pick<EventTarget, "dispatchEvent">,
  event: Event,
  property: "clipboardData" | "dataTransfer",
  transfer: unknown,
): { acknowledged: boolean; payloadRead: boolean } {
  let payloadRead = false;
  Object.defineProperty(event, property, {
    configurable: true,
    get: () => {
      payloadRead = true;
      return transfer;
    },
  });
  const cancelled = !target.dispatchEvent(event);
  return { acknowledged: cancelled && payloadRead, payloadRead };
}

/** The native payload, filtered down to entries this code will touch. */
export function sanitizeSharedFiles(
  payload: unknown,
  maxTotalDataLength = MAX_SHARED_DATA_LENGTH,
): SharedFile[] {
  if (!Array.isArray(payload)) return [];
  const files: SharedFile[] = [];
  let totalData = 0;
  for (const entry of payload) {
    if (files.length >= MAX_SHARED_FILES) break;
    if (!entry || typeof entry !== "object") continue;
    if (!Object.hasOwn(entry, "name") || !Object.hasOwn(entry, "data")) continue;
    const { name, data } = entry as Partial<SharedFile>;
    if (typeof name !== "string" || typeof data !== "string") continue;
    if (name.length === 0 || utf8Length(name) > MAX_SHARED_NAME_BYTES) continue;
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) continue;
    totalData += data.length;
    if (totalData > maxTotalDataLength) break;
    files.push({ name, data });
  }
  return files;
}

function decodeToFile(entry: SharedFile): File | null {
  try {
    if ("fromBase64" in Uint8Array && typeof Uint8Array.fromBase64 === "function") {
      return new File([Uint8Array.fromBase64(entry.data)], entry.name, {
        type: mimeForName(entry.name),
      });
    }
    const binary = atob(entry.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], entry.name, { type: mimeForName(entry.name) });
  } catch {
    return null;
  }
}

/** Decode sanitized entries while retaining a count of any field failures. */
export function decodeSharedFiles(entries: SharedFile[]): { files: File[]; failures: number } {
  const files = entries.map(decodeToFile).filter((file): file is File => file !== null);
  return { files, failures: entries.length - files.length };
}

/** Whether a parked share is still fresh enough to attach. */
export function shareIsDeliverable(parkedAtMs: number, nowMs: number): boolean {
  const age = nowMs - parkedAtMs;
  return age >= 0 && age <= SHARE_DELIVERY_TTL_MS;
}

/** A rough MIME guess from the file name, for the File constructor. */
export function mimeForName(name: string): string {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXTENSION.get(extension) ?? "application/octet-stream";
}
