import { invoke } from "@tauri-apps/api/core";
import { logger } from "./logger";

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

/** Whether the current platform is macOS */
export const isMac =
  typeof navigator !== "undefined" ? (navigator.platform?.startsWith("Mac") ?? false) : false;

/** Whether the current platform is Windows */
export const isWindows =
  typeof navigator !== "undefined" ? (navigator.platform?.startsWith("Win") ?? false) : false;

/** The primary modifier key label for display (⌘ on macOS, Ctrl on Windows/Linux) */
export const modLabel = isMac ? "\u2318" : "Ctrl";

/** The primary modifier key name for keybinding strings */
export const modKey = isMac ? "cmd" : "ctrl";

/** Check the platform-appropriate primary modifier on a keyboard event */
export function isPrimaryMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
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
