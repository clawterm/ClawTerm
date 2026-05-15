import "./fonts.css";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { TerminalManager } from "./terminal-manager";
import { startUpdateChecker } from "./updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { isMainWindow } from "./window-manager";

const main = isMainWindow();

// clear_sessions kills every PTY in the process, so only the main window
// may run it on startup — otherwise a secondary window would nuke the
// main window's PTYs. Updater and analytics are process-level singletons
// for the same reason. (#522)
if (main) {
  invoke("plugin:pty|clear_sessions").catch((e) => console.debug("clear_sessions:", e));
}

const manager = new TerminalManager();
manager.init().then(() => {
  if (main) {
    startUpdateChecker(manager.config);

    if (navigator.onLine) {
      const pa = document.createElement("script");
      pa.src = "https://plausible.io/js/pa-YbvLcN8JR7kX94JxIPUIL.js";
      pa.async = true;
      document.head.appendChild(pa);
    }
  }
});

// On Cmd+Q / window close: flush session to disk so it can be restored on
// next launch.  The debounced save may not have fired yet, so we save now.
getCurrentWindow().onCloseRequested(async () => {
  await manager.flushSession().catch(() => {
    // Best-effort during shutdown — no UI to show errors
  });
  manager.dispose();
});

// Pause CSS animations when window is hidden to save battery
document.addEventListener("visibilitychange", () => {
  document.documentElement.classList.toggle("window-hidden", document.hidden);
});
