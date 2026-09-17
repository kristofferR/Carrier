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
export function notificationThumbnail(source: string): Promise<string> {
  if (!source) return Promise.resolve("");
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
    const timer = setTimeout(() => finish(""), 2500);
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
