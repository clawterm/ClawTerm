import { invoke } from "@tauri-apps/api/core";
import { logger } from "./logger";
import { showToast } from "./toast";

/**
 * Invoke a Tauri command with a timeout. Rejects if the command
 * doesn't resolve within `ms` milliseconds.
 */
export function invokeWithTimeout<T>(cmd: string, args?: Record<string, unknown>, ms = 5000): Promise<T> {
  return Promise.race([
    invoke<T>(cmd, args),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`IPC timeout: ${cmd} exceeded ${ms}ms`)), ms),
    ),
  ]);
}

/** Insert into a Map with a fixed maximum size, evicting the oldest entry
 *  (insertion-order, FIFO) when at capacity. Map preserves insertion order,
 *  so `keys().next().value` is the oldest. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.size >= max && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Query a shell PID's live CWD via the Rust backend.  Returns null on
 *  any failure so callers can fall back to their cached value. (#462) */
export async function getLiveCwd(shellPid: number, timeoutMs: number): Promise<string | null> {
  try {
    return await invokeWithTimeout<string>("get_process_cwd_full", { pid: shellPid }, timeoutMs);
  } catch (e) {
    logger.debug("getLiveCwd failed:", e);
    return null;
  }
}

/** Whether the current platform is macOS. ClawTerm is macOS-only; kept as a
 *  constant so legacy callers don't have to be rewritten, but it's always
 *  true in shipped builds (#515). */
export const isMac = true;

/** The primary modifier key label for display (⌘ on macOS) */
export const modLabel = "\u2318";

/** The primary modifier key name for keybinding strings */
export const modKey = "cmd";

/** Check the macOS primary modifier (Cmd) on a keyboard event. */
export function isPrimaryMod(e: KeyboardEvent): boolean {
  return e.metaKey;
}

/** True when the document's currently focused element is a text input —
 *  used by the macOS Edit menu and global shortcuts to decide whether
 *  cut/copy/paste should target the WebView or the focused xterm. xterm
 *  parks focus in a hidden `<textarea class="xterm-helper-textarea">` to
 *  capture key events; that helper is not a real text-input target, so
 *  treat it as "no input focused" and let cut/copy/paste route to the
 *  terminal instead. */
export function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement && el.classList.contains("xterm-helper-textarea")) {
    return false;
  }
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/** Write text to the clipboard, showing a generic error toast on failure.
 *  Centralizes the pane copy-on-select / context-menu copy / Edit-menu
 *  copy paths so they stay in lockstep. */
export function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text).catch((e) => {
    logger.debug("Clipboard write failed:", e);
    showToast("Failed to copy to clipboard", "error");
  });
}

/**
 * Trap Tab focus within a container element.
 * Returns a cleanup function to remove the listener.
 */
export function trapFocus(container: HTMLElement): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  container.addEventListener("keydown", handler);
  return () => container.removeEventListener("keydown", handler);
}
