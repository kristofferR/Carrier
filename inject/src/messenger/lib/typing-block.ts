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
type Edit = (value: Json) => boolean;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The JSON object in `text` after `edit`, or null when nothing changed. IDs are
 * 64-bit numbers that JSON.parse would round, so only JSON that a parse and
 * stringify give back byte-for-byte is ever edited.
 */
export function editJson(text: string, edit: Edit): string | null {
  const value = parseJson(text);
  if (!value || typeof value !== "object" || JSON.stringify(value) !== text) return null;
  return edit(value as Json) ? JSON.stringify(value) : null;
}

/** `edit` applied to object[key], which may hold the JSON as an object or a string. */
function editNested(object: Json, key: string, edit: Edit): boolean {
  const value = object[key];
  if (value && typeof value === "object") return edit(value as Json);
  const edited = typeof value === "string" ? editJson(value, edit) : null;
  if (edited === null) return false;
  object[key] = edited;
  return true;
}

const TYPING_REQUEST = 4;
const TYPING_LABEL = "3";

/** Turns a "typing" update into "not typing"; leaves every other request alone. */
function clearTyping(request: Json): boolean {
  if (request.type !== TYPING_REQUEST) return false;
  return editNested(
    request,
    "payload",
    (update) =>
      update.label === TYPING_LABEL &&
      editNested(update, "payload", (typing) => {
        if (!typing.is_typing) return false;
        typing.is_typing = 0;
        return true;
      }),
  );
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
    const request = json && editJson(json, clearTyping);
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
