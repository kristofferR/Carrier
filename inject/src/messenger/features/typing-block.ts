/* ------------------------ Block typing indicator ------------------------ */
// With the setting on, nobody sees "typing…" while you draft (Ref #14).
// Regular chats send typing updates over the Lightspeed WebSocket; encrypted
// chats hand them to Messenger's worker over a MessagePort. Both are edited to
// "not typing" rather than dropped. Reading others' typing is unaffected.
import { diag } from "../bridge";
import { clearTypingInFrame, idleChatStates } from "../lib/typing-block";

const on = () => window.__CARRIER_SETTINGS__?.block_typing_indicator === true;

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function initTypingBlock() {
  // Covers sockets the page owns. A socket opened inside a worker would not
  // pass through this hook; encrypted chats' typing state is caught below at
  // the MessagePort instead.
  const nativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data) {
    if (on() && String(this.url).includes("/ws/lightspeed")) {
      const bytes = bytesOf(data);
      const edited = bytes && clearTypingInFrame(bytes);
      if (edited) {
        // Kind only, never content: proves the rewrite still matches Messenger.
        diag("privacy.typing-blocked", "socket");
        return nativeSend.call(this, edited);
      }
    }
    return nativeSend.call(this, data);
  };

  const nativePostMessage = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (
    this: MessagePort,
    message: unknown,
    ...rest: unknown[]
  ) {
    const edited = on() ? idleChatStates(message) : null;
    if (edited) diag("privacy.typing-blocked", "worker");
    return Reflect.apply(nativePostMessage, this, [edited ?? message, ...rest]);
  } as typeof MessagePort.prototype.postMessage;
}
