/* ------------------- Share-into-Carrier delivery ---------------------- */
// The native side delivers a validated share-extension payload through
// `window.__carrierShareMedia` (Ref #214). The files are reconstructed and
// pasted into the open conversation's composer; with no conversation open,
// the share waits until one is, and expires quietly after two minutes.
//
// Trust: the payload only ever comes from a native eval after the Rust side
// validated the app-group inbox. A page calling the hook itself gains
// nothing — it can already construct File objects and synthesize paste
// events for its own composer.
import { toast } from "../bridge";
import {
  mimeForName,
  type SharedFile,
  sanitizeSharedFiles,
  shareIsDeliverable,
} from "../lib/share-intake";

const COMPOSER_SELECTOR = 'div[role="textbox"][contenteditable="true"]';
const COMPOSER_POLL_MS = 1000;

function decodeToFile(entry: SharedFile): File | null {
  try {
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

function attachToComposer(composer: HTMLElement, files: File[]): boolean {
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
      clipboardData: transfer,
    });
    const handled = !composer.dispatchEvent(paste);
    if (handled || (paste.clipboardData?.files.length ?? 0) > 0) return true;
    const drop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    composer.dispatchEvent(drop);
    return true;
  } catch {
    return false;
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
    const composer = document.querySelector<HTMLElement>(COMPOSER_SELECTOR);
    if (!composer) return false;
    const { files, timer } = pending;
    clearTimeout(timer);
    pending = null;
    if (!attachToComposer(composer, files)) {
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
      if (!files.length) return;
      if (pending) clearTimeout(pending.timer);
      pending = { files, parkedAt: Date.now() };
      if (!tryDeliver()) {
        toast("Open a conversation to attach the shared file");
        pending.timer = window.setTimeout(poll, COMPOSER_POLL_MS);
      }
    },
    writable: false,
    configurable: false,
  });
}
