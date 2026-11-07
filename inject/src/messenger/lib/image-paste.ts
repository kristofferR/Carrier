/** What a paste carries, reduced to what decides whether to strip it. */
export interface PasteContents {
  fileTypes: string[];
  text: string;
  /** Visible text of the pasted HTML, or null when there is no HTML. */
  htmlText: string | null;
  htmlHasImage: boolean;
}

const ADDRESS = /^(https?|blob|data):\S+$/;

/**
 * WebKit's Copy Image puts the picture on the clipboard together with its
 * address, as plain text and as an `<img>` in HTML, and Messenger's composer
 * then takes the address instead of the picture. True only for that shape:
 * image files plus nothing but their address.
 */
export function isImageWithOnlyItsAddress(paste: PasteContents): boolean {
  if (!paste.fileTypes.length || !paste.fileTypes.every((type) => type.startsWith("image/"))) {
    return false;
  }
  const text = paste.text.trim();
  if (!text && paste.htmlText === null) return false;
  if (text && !ADDRESS.test(text)) return false;
  if (paste.htmlText === null) return true;
  return !paste.htmlText.trim() && paste.htmlHasImage;
}
