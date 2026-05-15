import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

export const MAIN_WINDOW_LABEL = "main";

export function isMainWindow(): boolean {
  return getCurrentWindow().label === MAIN_WINDOW_LABEL;
}

async function nextLabel(): Promise<string> {
  const existing = await getAllWebviewWindows();
  let max = 0;
  for (const w of existing) {
    const m = w.label.match(/^window-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `window-${max + 1}`;
}

export async function openNewWindow(): Promise<void> {
  const label = await nextLabel();
  const w = new WebviewWindow(label, {
    url: "index.html",
    title: "ClawTerm",
    width: 1100,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    decorations: false,
    transparent: true,
    shadow: true,
  });
  void w.once("tauri://error", (e) => {
    console.error("failed to open new window", e);
  });
}
