/*
 * Read-ahead for end-to-end encrypted chats. Adapted from fMess
 * (https://github.com/toanbku/fmess, src-tauri/src/inject/16-read-ahead.js).
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

export const READ_AHEAD = {
  /** Chats read ahead per round. */
  chats: 12,
  /** Rows read from the thread index to find them (some are plain or archived). */
  rowsRead: 36,
  /** Messages per chat: a window's worth, and some to scroll up through. */
  messages: 40,
  /** Rounds start at most this often, however often they are asked for. */
  minGapMs: 20_000,
  /** Between chats; the worker reads its own store. */
  chatGapMs: 200,
  /** One chat's preload may take this long before the round moves on. */
  chatTimeoutMs: 15_000,
} as const;

/** Messenger's LSAuthorityLevel for a thread the server has confirmed. */
const AUTHORITATIVE = "80";

export interface ThreadTypeUtil {
  isMessengerOrE2EEInbox(folderName: unknown): unknown;
  isOpenOrArmadilloFnFThread(thread: unknown): unknown;
  isArmadilloSecure(threadType: unknown): unknown;
}

export interface ReadAheadThread {
  id: string;
  threadKey: unknown;
  authorityLevel: unknown;
}

/**
 * The encrypted inbox chats worth reading ahead, newest first: friends' 1:1
 * and group chats the server has confirmed, not disappearing-message chats
 * (their timers are Messenger's), and not the open chat (already loaded).
 * `toId` turns Messenger's 64-bit values into decimal strings, or null.
 */
export function selectReadAheadThreads(
  rows: unknown[],
  types: ThreadTypeUtil,
  toId: (value: unknown) => string | null,
  openThreadId: string | null,
  limit: number = READ_AHEAD.chats,
): ReadAheadThread[] {
  const out: ReadAheadThread[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= limit) break;
    if (!row || typeof row !== "object") continue;
    const thread = row as Record<string, unknown>;
    if (types.isMessengerOrE2EEInbox(thread.folderName) !== true) continue;
    if (types.isArmadilloSecure(thread.threadType) !== true) continue;
    if (types.isOpenOrArmadilloFnFThread(thread) !== true) continue;
    if (thread.isDisappearingMode === true) continue;
    if (toId(thread.authorityLevel) !== AUTHORITATIVE) continue;
    const id = toId(thread.threadKey);
    if (!id || !/^\d+$/.test(id) || id === openThreadId || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, threadKey: thread.threadKey, authorityLevel: thread.authorityLevel });
  }
  return out;
}

/** How long a round asked for now must still wait for the minimum gap. */
export function readAheadWait(lastRunAt: number | null, now: number): number {
  return lastRunAt === null ? 0 : Math.max(0, lastRunAt + READ_AHEAD.minGapMs - now);
}
