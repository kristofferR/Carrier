const MESSENGER_OVERFLOW_PATH_PREFIX = "M2.25 10a1.75 1.75";

/** Identify Messenger's chat-list overflow control without relying on classes. */
export function isMessengerHeaderOverflowControl(iconPath: string): boolean {
  return iconPath.trim().startsWith(MESSENGER_OVERFLOW_PATH_PREFIX);
}
