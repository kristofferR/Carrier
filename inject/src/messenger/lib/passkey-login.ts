/* Facebook's passkey two-factor step (#470). Its Continue button lives in a
 * cross-origin accounts.meta.com frame that calls navigator.credentials.get().
 * That can't succeed in every webview Chatpane runs in, and Facebook picks the
 * step on the server, so the page just spins. */

/** Whether a passkey prompt can ever finish in this webview. macOS WKWebView
 * exposes WebAuthn but rejects it at once: apps may only use passkeys for
 * their Associated Domains, and facebook.com is not Chatpane's. WebKitGTK
 * builds ship without WebAuthn (no PublicKeyCredential). WebView2 hands
 * passkeys to Windows Hello, like Edge. */
export function passkeysCanWork(
  platform: "macos" | "windows" | "linux",
  hasPublicKeyCredential: boolean,
): boolean {
  return platform !== "macos" && hasPublicKeyCredential;
}

/** Facebook's two-factor pages, such as /two_step_verification/two_factor/. */
export function isTwoStepVerificationPath(pathname: string): boolean {
  return /^\/two_step_verification(?:\/|$)/i.test(pathname);
}

/** The accounts.meta.com frame that renders the passkey step's Continue button. */
export function isPasskeyAssertFrame(src: string): boolean {
  try {
    const url = new URL(src);
    return (
      url.protocol === "https:" &&
      url.hostname === "accounts.meta.com" &&
      /^\/passkey\/iframe\/assert(?:\/|$)/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
