import "./fonts.css";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { TerminalManager } from "./terminal-manager";
import { startUpdateChecker, installStagedOnQuit, hasStagedUpdate } from "./updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { isMainWindow } from "./window-manager";

const main = isMainWindow();

// clear_sessions kills every PTY in the process, so only the main window
// may run it on startup — otherwise a secondary window would nuke the
// main window's PTYs. The updater is a process-level singleton for the
// same reason. (#522)
if (main) {
  invoke("plugin:pty|clear_sessions").catch((e) => console.debug("clear_sessions:", e));
}

const manager = new TerminalManager();
manager.init().then(() => {
  if (main) {
    startUpdateChecker(manager.config);
  }
});

// On Cmd+Q / window close: flush session to disk so it can be restored on
// next launch.  The debounced save may not have fired yet, so we save now.
// If a downloaded update is staged, apply it before disposing — the user
// is quitting anyway, so install() can swap the bundle and the next launch
// lands on the new version with no extra interruption. Updater state lives
// in the main window only (#522), so secondary-window quits skip the
// install step naturally. (#558)
getCurrentWindow().onCloseRequested(async () => {
  await manager.flushSession().catch(() => {
    // Best-effort during shutdown — no UI to show errors
  });
  if (main && hasStagedUpdate()) {
    showQuitInstallOverlay();
    await installStagedOnQuit();
  }
  manager.dispose();
});

/** Blocks the visible window with a quiet "Installing update…" overlay
 *  while install() does the bundle swap. ~2-5s on macOS; without this the
 *  window appears to hang during quit. Pure DOM — no framework deps. */
function showQuitInstallOverlay(): void {
  const overlay = document.createElement("div");
  overlay.className = "quit-install-overlay";
  overlay.textContent = "Installing update…";
  document.body.appendChild(overlay);
}

// Pause CSS animations when window is hidden to save battery
document.addEventListener("visibilitychange", () => {
  document.documentElement.classList.toggle("window-hidden", document.hidden);
});
