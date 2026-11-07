/*
 * Typing-indicator blocking (Ref #14). Adapted from fMess
 * (https://github.com/toanbku/fmess, src-tauri/src/inject/04-privacy.js).
 */
/*! Includes code adapted from fMess (https://github.com/toanbku/fmess).
 *
 * MIT License
 *
 * Copyright (c) 2026 fMess contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

type Json = Record<string, unknown>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** object[key] as an object, parsing it when Messenger nests it as a JSON string. */
function nested(object: unknown, key: string): Json | null {
  const value = (object as Json | null)?.[key];
  const parsed = typeof value === "string" ? parseJson(value) : value;
  return parsed && typeof parsed === "object" ? (parsed as Json) : null;
}

const TYPING_REQUEST = 4;
const TYPING_LABEL = "3";
// `"is_typing":1` at any nesting depth: the update sits in JSON strings inside
// the request, so its quotes arrive escaped once or more.
const IS_TYPING = /(is_typing(?:\\)*":)1(?![0-9])/g;

/**
 * The request text with a "typing" update turned into "not typing", or null
 * for any other request. Parsing only identifies the request; the edit is a
 * same-length text substitution, so 64-bit IDs that JSON.parse would round,
 * and Messenger's own escaping, pass through byte-for-byte.
 */
export function clearTyping(text: string): string | null {
  const request = parseJson(text);
  if ((request as Json | null)?.type !== TYPING_REQUEST) return null;
  const update = nested(request, "payload");
  if (update?.label !== TYPING_LABEL || !nested(update, "payload")?.is_typing) return null;
  const edited = text.replace(IS_TYPING, "$10");
  return edited === text ? null : edited;
}

const PART_DATA = 0x0d;
const PART_CLOSE = 0x0e;

/**
 * A Lightspeed WebSocket frame with typing updates cleared, or null when the
 * frame holds none (or does not parse). Requests are edited rather than
 * dropped, so Messenger never waits on or retries a missing request.
 */
export function clearTypingInFrame(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const parts: Uint8Array[] = [];
  let edited = false;
  for (let pos = 0; pos < bytes.length; ) {
    if (bytes[pos] === PART_CLOSE) {
      parts.push(bytes.subarray(pos, pos + 3));
      pos += 3;
      continue;
    }
    if (pos + 6 > bytes.length) return null;
    const end =
      pos +
      6 +
      ((bytes[pos + 3] ?? 0) | ((bytes[pos + 4] ?? 0) << 8) | ((bytes[pos + 5] ?? 0) << 16));
    if (end > bytes.length) return null;
    let part = bytes.subarray(pos, end);
    const json =
      bytes[pos] === PART_DATA && end > pos + 8
        ? new TextDecoder().decode(bytes.subarray(pos + 8, end))
        : null;
    const request = json && clearTyping(json);
    if (request) {
      const encoded = new TextEncoder().encode(request);
      const length = encoded.length + 2;
      part = new Uint8Array(8 + encoded.length);
      part.set(bytes.subarray(pos, pos + 3));
      part.set([length & 0xff, (length >> 8) & 0xff, length >> 16], 3);
      part.set(bytes.subarray(pos + 6, pos + 8), 6);
      part.set(encoded, 8);
      edited = true;
    }
    parts.push(part);
    pos = end;
  }
  if (!edited) return null;
  const frame = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    frame.set(part, offset);
    offset += part.length;
  }
  return frame;
}

const CHAT_STATE = "sendChatStateFromComposer";
const CHAT_IDLE = "idle";

interface WorkerRequest {
  content?: { name?: unknown; arg?: { state?: unknown } & Json } & Json;
}

/**
 * End-to-end encrypted chats send typing state to Messenger's worker as a
 * batch of `{type: "request", content: {name, arg}}`. Returns the batch with
 * every composer chat state forced to idle, or null when there is none.
 */
export function idleChatStates(message: unknown): unknown[] | null {
  if (!Array.isArray(message)) return null;
  const isTypingState = (item: unknown) => {
    const content = (item as WorkerRequest | null)?.content;
    return content?.name === CHAT_STATE && content.arg?.state !== CHAT_IDLE;
  };
  if (!message.some(isTypingState)) return null;
  return message.map((item) => {
    if (!isTypingState(item)) return item;
    const content = (item as WorkerRequest).content ?? {};
    return {
      ...(item as Json),
      content: { ...content, arg: { ...content.arg, state: CHAT_IDLE } },
    };
  });
}
