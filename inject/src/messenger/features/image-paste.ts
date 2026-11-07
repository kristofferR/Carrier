/* -------------------- Paste a copied image as an image ------------------- */
// WebKit's Copy Image leaves the picture on the clipboard along with its
// address, and Messenger's composer took the address instead of the picture.
// Such a paste is re-sent with the picture alone, as Chrome would deliver it;
// every other paste passes through untouched (Ref #361). Idea from fMess
// (github.com/toanbku/fmess, MIT).
import { isImageWithOnlyItsAddress } from "../lib/image-paste";
import { dispatchTransferEvent } from "../lib/share-intake";
import { isComposerTarget } from "./composer-keys";

function htmlContents(html: string): { htmlText: string | null; htmlHasImage: boolean } {
  if (!html) return { htmlText: null, htmlHasImage: false };
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return { htmlText: body.textContent ?? "", htmlHasImage: body.querySelector("img") !== null };
}

export function initImagePaste() {
  document.addEventListener(
    "paste",
    (event) => {
      // Only real pastes. Synthetic ones (this listener's own re-send, share
      // intake) must not even be read: share intake treats a read of its
      // payload as delivery.
      if (!event.isTrusted || !isComposerTarget(event.target)) return;
      const data = event.clipboardData;
      if (!data?.files.length) return;
      const files = [...data.files];
      const contents = {
        fileTypes: files.map((file) => file.type),
        text: data.getData("text/plain"),
        ...htmlContents(data.getData("text/html")),
      };
      if (!isImageWithOnlyItsAddress(contents)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const pictures = new DataTransfer();
      for (const file of files) pictures.items.add(file);
      const again = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      dispatchTransferEvent(event.target as Element, again, "clipboardData", pictures);
    },
    true,
  );
}
