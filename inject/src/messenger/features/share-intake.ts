/* ------------------- Share-into-Carrier delivery ---------------------- */
// The native side delivers a validated share-extension payload through
// `window.__carrierShareMedia` (Ref #214). The files are reconstructed and
// pasted into the open conversation's composer; with no conversation open,
// the share waits until one is, and expires quietly after two minutes.
//
// Trust: the payload only ever comes from a native eval after the Rust side
// validated the one-time pasteboard handoff. A page calling the hook itself
// gains nothing — it can already construct File objects and synthesize paste
// events for its own composer.
import { diag, toast } from "../bridge";
import {
  dispatchTransferEvent,
  MAX_SHARED_FILES,
  mimeForName,
  type SharedFile,
  sanitizeSharedFiles,
  shareIsDeliverable,
} from "../lib/share-intake";
import { firstShown } from "./conversation-actions";

const COMPOSER_SELECTOR = '[role="main"] div[role="textbox"][contenteditable="true"]';
const COMPOSER_POLL_MS = 1000;

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

type AttachmentResult = "attached" | "retry" | "uncertain";

function attachToComposer(composer: HTMLElement, files: File[]): AttachmentResult {
  try {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    composer.focus();
    // Messenger accepts pasted files; a synthetic ClipboardEvent carries them
    // to the same handler a real paste reaches (React does not gate on
    // isTrusted). DragEvent drop is the fallback for a paste handler that
    // ignores synthetic events.
    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
    });
    // Cancellation alone could come from an unrelated delegated listener. The
    // handler must also inspect this exact transfer before it counts as an ack.
    const pasted = dispatchTransferEvent(composer, paste, "clipboardData", transfer);
    if (pasted.acknowledged) return "attached";
    // Once a handler has read the payload, delivery is ambiguous. Do not send
    // it a second time and risk duplicate composer attachments.
    if (pasted.payloadRead) return "uncertain";
    const drop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
    });
    const dropped = dispatchTransferEvent(composer, drop, "dataTransfer", transfer);
    if (dropped.acknowledged) return "attached";
    return dropped.payloadRead ? "uncertain" : "retry";
  } catch {
    return "retry";
  }
}

export function initShareIntake() {
  let pending: { files: File[]; parkedAt: number; timer?: number } | null = null;

  const tryDeliver = (): boolean => {
    if (!pending) return true;
    if (!shareIsDeliverable(pending.parkedAt, Date.now())) {
      clearTimeout(pending.timer);
      pending = null;
      toast("Shared file expired");
      return true;
    }
    const composer = firstShown<HTMLElement>(COMPOSER_SELECTOR);
    if (!composer) return false;
    const { files, timer } = pending;
    const result = attachToComposer(composer, files);
    if (result === "retry") return false;
    clearTimeout(timer);
    pending = null;
    // Counts only, never names or contents: the attach path depends on
    // Messenger's markup, so a field failure has to be diagnosable.
    if (result === "attached") {
      diag("share.attached", `${files.length}`);
    } else {
      diag("share.attach-failed", `${files.length}`);
      toast("Could not attach the shared file");
    }
    return true;
  };

  const poll = () => {
    if (tryDeliver()) return;
    if (pending) {
      pending.timer = window.setTimeout(poll, COMPOSER_POLL_MS);
    }
  };

  Object.defineProperty(window, "__carrierShareMedia", {
    value: (payload: unknown) => {
      const entries = sanitizeSharedFiles(payload);
      const files = entries.map(decodeToFile).filter((file): file is File => file !== null);
      if (!files.length) {
        diag("share.empty-payload", "0");
        return;
      }
      const receivedAt = Date.now();
      if (pending && !shareIsDeliverable(pending.parkedAt, receivedAt)) {
        clearTimeout(pending.timer);
        pending = null;
      }
      if (pending) {
        if (pending.files.length + files.length > MAX_SHARED_FILES) {
          diag("share.busy", `${pending.files.length}`);
          toast("Attach the current shared files before sharing more");
          return;
        }
        clearTimeout(pending.timer);
        pending.files.push(...files);
        pending.parkedAt = receivedAt;
      } else {
        pending = { files, parkedAt: receivedAt };
      }
      if (!tryDeliver()) {
        diag("share.waiting-for-composer", `${pending.files.length}`);
        toast("Open a conversation to attach the shared file");
        pending.timer = window.setTimeout(poll, COMPOSER_POLL_MS);
      }
    },
    writable: false,
    configurable: false,
  });
}
