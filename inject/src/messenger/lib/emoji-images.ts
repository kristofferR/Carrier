export interface ImageRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const FACEBOOK_EMOJI_PATH = "/images/emoji.php/";

export const isFacebookEmojiImage = (value: unknown): value is string =>
  typeof value === "string" && value.includes(FACEBOOK_EMOJI_PATH);

export function intersectsImageClip(rect: ImageRect, clip: ImageRect): boolean {
  return !(
    rect.bottom < clip.top ||
    rect.top > clip.bottom ||
    rect.right < clip.left ||
    rect.left > clip.right
  );
}

export function intersectImageClips(left: ImageRect, right: ImageRect): ImageRect {
  return {
    top: Math.max(left.top, right.top),
    right: Math.min(left.right, right.right),
    bottom: Math.min(left.bottom, right.bottom),
    left: Math.max(left.left, right.left),
  };
}

export function expandedImageClip(rect: ImageRect, margin: number): ImageRect {
  return {
    top: rect.top - margin,
    right: rect.right + margin,
    bottom: rect.bottom + margin,
    left: rect.left - margin,
  };
}
