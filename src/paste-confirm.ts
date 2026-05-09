import type { Terminal } from "@xterm/xterm";
import { trapFocus } from "./utils";
import { showToast } from "./toast";

/**
 * Show a confirmation dialog before pasting multi-line text into the terminal.
 * Extracted from Pane to keep pane.ts focused on terminal lifecycle.
 */
export function showPasteConfirm(
  text: string,
  terminal: Terminal,
  abortSignal: AbortSignal,
  onDismiss: () => void,
): HTMLDivElement | null {
  // Reject extremely large pastes to avoid freezing the UI
  const MAX_PASTE_BYTES = 5_000_000;
  if (text.length > MAX_PASTE_BYTES) {
    showToast("Paste too large (>5MB)", "error");
    return null;
  }

  const lineCount = text.split("\n").length;
  const preview = text.length > 300 ? text.slice(0, 300) + "\u2026" : text;

  const overlay = document.createElement("div");
  overlay.className = "close-confirm-overlay paste-confirm";

  const dialog = document.createElement("div");
  dialog.className = "close-confirm-dialog paste-confirm-dialog";

  const titleEl = document.createElement("div");
  titleEl.className = "close-confirm-title";
  titleEl.textContent = `Paste ${lineCount} lines?`;

  const bodyEl = document.createElement("div");
  bodyEl.className = "close-confirm-body";
  bodyEl.textContent =
    "This text contains newlines that may execute commands. Each line break acts as Enter.";

  const previewEl = document.createElement("pre");
  previewEl.className = "paste-preview";
  previewEl.textContent = preview;

  const actionsEl = document.createElement("div");
  actionsEl.className = "close-confirm-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--secondary close-confirm-btn";
  cancelBtn.textContent = "Cancel";

  const singleLineBtn = document.createElement("button");
  singleLineBtn.className = "btn btn--secondary close-confirm-btn";
  singleLineBtn.textContent = "Paste as Single Line";

  const pasteBtn = document.createElement("button");
  pasteBtn.className = "btn btn--primary close-confirm-btn";
  pasteBtn.textContent = "Paste";

  actionsEl.appendChild(cancelBtn);
  actionsEl.appendChild(singleLineBtn);
  actionsEl.appendChild(pasteBtn);
  dialog.appendChild(titleEl);
  dialog.appendChild(bodyEl);
  dialog.appendChild(previewEl);
  dialog.appendChild(actionsEl);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const removeTrap = trapFocus(dialog);
  const dismiss = () => {
    removeTrap();
    overlay.remove();
    onDismiss();
    terminal.focus();
  };

  cancelBtn.addEventListener("click", dismiss, { signal: abortSignal });
  singleLineBtn.addEventListener(
    "click",
    () => {
      dismiss();
      const singleLine = text.replace(/\n/g, " ");
      terminal.paste(singleLine);
    },
    { signal: abortSignal },
  );
  pasteBtn.addEventListener(
    "click",
    () => {
      dismiss();
      terminal.paste(text);
    },
    { signal: abortSignal },
  );
  overlay.addEventListener(
    "click",
    (e) => {
      if (e.target === overlay) dismiss();
    },
    { signal: abortSignal },
  );
  overlay.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") dismiss();
    },
    { signal: abortSignal },
  );

  cancelBtn.focus();

  return overlay;
}
