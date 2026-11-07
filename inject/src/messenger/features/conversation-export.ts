/* ------------------------- Conversation export ------------------------- */
// File ▸ Export Conversation as HTML/JSON… (Ref #371). Reads the open
// conversation from Messenger's local database, renders the file here, and
// hands it to the native shell, which asks where to save it. Nothing is
// uploaded anywhere.
import { diag, toast } from "../bridge";
import {
  type ExportFormat,
  exportFileName,
  readConversationExport,
  renderConversationHtml,
  renderConversationJson,
} from "../lib/conversation-export";
import { downloadRevealLabel } from "../lib/downloads";
import { accountId, threadIdFromHref } from "../lib/threads";

// Keep well under the native signed-message cap once the content is JSON-escaped.
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
  const data = await readConversationExport(
    threadId,
    (window as unknown as { require?: unknown }).require,
    { now: Date.now(), viewerId: accountId(document.cookie) },
  );
  if (!data) {
    diag("export.read", "conversation database unavailable");
    toast("Couldn't read this conversation", undefined, { warning: true });
    return;
  }
  const content =
    format === "html"
      ? renderConversationHtml(data, { locale: navigator.language })
      : renderConversationJson(data);
  if (new TextEncoder().encode(content).length > EXPORT_MAX_BYTES) {
    toast("This conversation is too large to export", undefined, { warning: true });
    return;
  }
  const reveal = `carrier-export:${randomHex()}`;
  try {
    await carrierExportConversation({
      format,
      name: exportFileName(data.conversation.title),
      content,
      reveal,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "export cancelled") {
      toast("Export cancelled");
      return;
    }
    diag("export.save", error instanceof Error ? error.message : "save failed");
    toast("Couldn't save the export", undefined, { warning: true });
    return;
  }
  const count = data.messages.length;
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
