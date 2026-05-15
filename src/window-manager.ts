import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

let counter = 0;

async function nextLabel(): Promise<string> {
  const existing = await getAllWebviewWindows();
  const used = new Set(existing.map((w) => w.label));
  while (true) {
    counter += 1;
    const label = `window-${counter}`;
    if (!used.has(label)) return label;
  }
}

export async function openNewWindow(): Promise<void> {
  const label = await nextLabel();
  const w = new WebviewWindow(label, {
    url: "index.html",
    title: "Clawterm",
    width: 1100,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    decorations: false,
    transparent: true,
    shadow: true,
  });
  w.once("tauri://error", (e) => {
    console.error("failed to open new window", e);
  });
}
