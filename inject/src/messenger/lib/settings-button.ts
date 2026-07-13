const MESSENGER_OVERFLOW_LABEL = "Settings, help and more";
const MESSENGER_OVERFLOW_PATH_PREFIX = "M2.25 10a1.75 1.75";

/** Identify Messenger's chat-list overflow control without relying on classes. */
export function isMessengerHeaderOverflowControl(label: string, iconPath: string): boolean {
  return (
    label.trim() === MESSENGER_OVERFLOW_LABEL ||
    iconPath.trim().startsWith(MESSENGER_OVERFLOW_PATH_PREFIX)
  );
}
