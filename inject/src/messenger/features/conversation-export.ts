/* ------------------------- Conversation export ------------------------- */
// File ▸ Export Conversation as HTML/JSON… (Ref #371). Reads the open
// conversation from Messenger's local database and hands the structured rows
// to the native shell, which validates them, renders the file, and asks where
// to save it. The page never renders the file: Facebook's scripts share this
// page and must not be able to put markup or script into it. Nothing is
// uploaded anywhere.
import { diag, toast } from "../bridge";
import { type ExportFormat, readConversationExport } from "../lib/conversation-export";
import { downloadRevealLabel } from "../lib/downloads";
import { accountId, threadIdFromHref } from "../lib/threads";

// Keep well under the native signed-message cap once the model is JSON-escaped.
const EXPORT_MAX_BYTES = 32 * 1024 * 1024;

function randomHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function exportConversation(format: ExportFormat) {
  const threadId = threadIdFromHref(location.pathname);
  if (!threadId) {
    toast("Open a conversation to export it");
    return;
  }
  toast("Preparing export…");
  const conversation = await readConversationExport(
    threadId,
    (window as unknown as { require?: unknown }).require,
    {
      viewerId: accountId(document.cookie),
      utcOffsetMinutes: (timestampMs) => -new Date(timestampMs).getTimezoneOffset(),
    },
  );
  if (!conversation) {
    diag("export.read", "conversation database unavailable");
    toast("Couldn't read this conversation", undefined, { warning: true });
    return;
  }
  if (new TextEncoder().encode(JSON.stringify(conversation)).length > EXPORT_MAX_BYTES) {
    toast("This conversation is too large to export", undefined, { warning: true });
    return;
  }
  const reveal = `carrier-export:${randomHex()}`;
  try {
    await carrierExportConversation({ format, conversation, reveal });
  } catch (error) {
    if (error instanceof Error && error.message === "export cancelled") {
      toast("Export cancelled");
      return;
    }
    diag("export.save", error instanceof Error ? error.message : "save failed");
    toast("Couldn't save the export", undefined, { warning: true });
    return;
  }
  const count = conversation.messages.length;
  toast(`Exported ${count.toLocaleString()} ${count === 1 ? "message" : "messages"}`, {
    label: downloadRevealLabel(navigator.userAgent),
    kind: "reveal-download",
    url: reveal,
  });
}

export function initConversationExport() {
  let busy = false;
  window.__carrierExportConversation = (format: unknown) => {
    if (format !== "html" && format !== "json") return;
    if (busy) {
      toast("An export is already in progress");
      return;
    }
    busy = true;
    exportConversation(format)
      .catch(() => {
        diag("export.run", "export failed");
        toast("Couldn't export this conversation", undefined, { warning: true });
      })
      .finally(() => {
        busy = false;
      });
  };
}
