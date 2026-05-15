import "./fonts.css";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { TerminalManager } from "./terminal-manager";
import { startUpdateChecker } from "./updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

const isMainWindow = getCurrentWindow().label === "main";

// Clean up stale PTY sessions from previous hot reloads (dev mode). Only
// the main window may do this — clear_sessions kills every PTY in the
// process, which would nuke a secondary window's PTYs if run there. (#522)
if (isMainWindow) {
  invoke("plugin:pty|clear_sessions").catch((e) => console.debug("clear_sessions:", e));
}

const manager = new TerminalManager();
manager.init().then(() => {
  // Updater and analytics are process-level singletons; run only in the
  // main window so opening a second window doesn't double-fire either.
  if (isMainWindow) {
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
