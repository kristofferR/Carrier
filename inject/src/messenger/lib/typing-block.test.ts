import { describe, expect, test } from "bun:test";
import { clearTypingInFrame, editJson, idleChatStates } from "./typing-block";

/** One Lightspeed data part: 3 header bytes, 3-byte length, 2 more bytes, then JSON. */
function dataPart(json: string): Uint8Array {
  const body = new TextEncoder().encode(json);
  const length = body.length + 2;
  const part = new Uint8Array(8 + body.length);
  part.set([0x0d, 0x01, 0x02, length & 0xff, (length >> 8) & 0xff, length >> 16, 0x07, 0x08]);
  part.set(body, 8);
  return part;
}

function frame(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decodeParts(bytes: Uint8Array): unknown[] {
  const requests: unknown[] = [];
  for (let pos = 0; pos < bytes.length; ) {
    if (bytes[pos] === 0x0e) {
      pos += 3;
      continue;
    }
    const end = pos + 6 + (bytes[pos + 3]! | (bytes[pos + 4]! << 8) | (bytes[pos + 5]! << 16));
    requests.push(JSON.parse(new TextDecoder().decode(bytes.subarray(pos + 8, end))));
    pos = end;
  }
  return requests;
}

const typing = (isTyping: number) =>
  JSON.stringify({
    type: 4,
    payload: JSON.stringify({
      label: "3",
      payload: JSON.stringify({ thread_key: 1, is_typing: isTyping }),
    }),
  });

describe("clearTypingInFrame", () => {
  test("clears a typing update and keeps the rest of the frame intact", () => {
    const other = JSON.stringify({ type: 3, payload: "{}" });
    const close = new Uint8Array([0x0e, 0x00, 0x00]);
    const edited = clearTypingInFrame(frame(dataPart(other), dataPart(typing(1)), close));
    expect(edited).not.toBeNull();
    const [first, second] = decodeParts(edited!) as [unknown, { payload: string }];
    expect(first).toEqual(JSON.parse(other));
    const update = JSON.parse(second.payload) as { label: string; payload: string };
    expect(update.label).toBe("3");
    expect(JSON.parse(update.payload)).toEqual({ thread_key: 1, is_typing: 0 });
    // Header bytes around the length are carried over unchanged.
    expect([...edited!.subarray(0, 3)]).toEqual([0x0d, 0x01, 0x02]);
    expect([...edited!.subarray(edited!.length - 3)]).toEqual([0x0e, 0x00, 0x00]);
  });

  test("leaves frames without a typing update, already-idle updates and bad frames alone", () => {
    expect(clearTypingInFrame(frame(dataPart(typing(0))))).toBeNull();
    expect(
      clearTypingInFrame(frame(dataPart(JSON.stringify({ type: 4, payload: "{}" })))),
    ).toBeNull();
    expect(clearTypingInFrame(new Uint8Array([0x0d, 0x00, 0x00, 0xff, 0x00]))).toBeNull();
    const truncated = dataPart(typing(1)).subarray(0, 12);
    expect(clearTypingInFrame(truncated)).toBeNull();
  });
});

describe("editJson", () => {
  test("never re-encodes JSON whose 64-bit IDs would lose precision", () => {
    const text = '{"type":4,"thread_key":12345678901234567890}';
    expect(editJson(text, () => true)).toBeNull();
  });
});

describe("idleChatStates", () => {
  test("forces composer chat state to idle and keeps other requests", () => {
    const batch = [
      {
        type: "request",
        content: { name: "sendChatStateFromComposer", arg: { state: "typing", thread: 7 } },
      },
      { type: "request", content: { name: "sendMessage", arg: { text: "hi" } } },
    ];
    expect(idleChatStates(batch)).toEqual([
      {
        type: "request",
        content: { name: "sendChatStateFromComposer", arg: { state: "idle", thread: 7 } },
      },
      batch[1],
    ]);
    // The original batch is not mutated.
    expect(batch[0]?.content.arg.state).toBe("typing");
  });

  test("returns null when there is nothing to change", () => {
    expect(idleChatStates("not a batch")).toBeNull();
    expect(
      idleChatStates([{ content: { name: "sendChatStateFromComposer", arg: { state: "idle" } } }]),
    ).toBeNull();
    expect(idleChatStates([{ content: { name: "sendMessage" } }])).toBeNull();
  });
});
