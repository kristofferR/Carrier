/* ------------------------- Conversation export ------------------------- */
// File ▸ Export Conversation as HTML/JSON…, or a chat-list row's right-click
// menu (Ref #371). Reads the conversation from Messenger's local database and
// hands the structured rows to the native shell, which validates them, renders
// the file, and asks where to save it. The page never renders the file: Facebook's scripts share this
// page and must not be able to put markup or script into it. Nothing is
// uploaded anywhere.
import { t, tn } from "../../i18n";
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

async function exportConversation(threadId: string, format: ExportFormat) {
  toast(t("page.export.preparing"));
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
    toast(t("page.export.read_failed"), undefined, { warning: true });
    return;
  }
  if (new TextEncoder().encode(JSON.stringify(conversation)).length > EXPORT_MAX_BYTES) {
    toast(t("page.export.too_large"), undefined, { warning: true });
    return;
  }
  const reveal = `chatpane-export:${randomHex()}`;
  try {
    await chatpaneExportConversation({ format, conversation, reveal });
  } catch (error) {
    if (error instanceof Error && error.message === "export cancelled") {
      toast(t("page.export.cancelled"));
      return;
    }
    diag("export.save", error instanceof Error ? error.message : "save failed");
    toast(t("page.export.save_failed"), undefined, { warning: true });
    return;
  }
  toast(tn("page.export.done", conversation.messages.length), {
    label: downloadRevealLabel(navigator.userAgent),
    kind: "reveal-download",
    url: reveal,
  });
}

let busy = false;

/** Export a conversation by its thread id; the open one when none is given. */
export function startConversationExport(
  format: ExportFormat,
  threadId = threadIdFromHref(location.pathname),
) {
  if (!threadId) {
    toast(t("page.export.no_conversation"));
    return;
  }
  if (busy) {
    toast(t("page.export.in_progress"));
    return;
  }
  busy = true;
  exportConversation(threadId, format)
    .catch(() => {
      diag("export.run", "export failed");
      toast(t("page.export.failed"), undefined, { warning: true });
    })
    .finally(() => {
      busy = false;
    });
}

export function initConversationExport() {
  window.__chatpaneExportConversation = (format: unknown) => {
    if (format === "html" || format === "json") startConversationExport(format);
  };
}
