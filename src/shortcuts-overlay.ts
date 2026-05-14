import type { Config } from "./config";
import { buildShortcutGroups, formatBinding } from "./shortcuts-panel";
import { trapFocus } from "./utils";

/** Read-only "what are all the keyboard shortcuts" overlay, invoked from
 *  Help → Show Keyboard Shortcuts (#514). Separate from the settings panel
 *  so users can browse bindings without opening the editor surface. */
export function showShortcutsOverlay(config: Config): () => void {
  const overlay = document.createElement("div");
  overlay.className = "close-confirm-overlay shortcuts-overlay-bg";

  const dialog = document.createElement("div");
  dialog.className = "close-confirm-dialog shortcuts-overlay";

  const title = document.createElement("div");
  title.className = "close-confirm-title";
  title.textContent = "Keyboard Shortcuts";
  dialog.appendChild(title);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "shortcuts-search";
  search.placeholder = "Search shortcuts…";
  search.spellcheck = false;
  dialog.appendChild(search);

  const body = document.createElement("div");
  body.className = "shortcuts-overlay-body";
  dialog.appendChild(body);

  for (const group of buildShortcutGroups(config)) {
    const section = document.createElement("div");
    section.className = "shortcuts-group";

    const heading = document.createElement("div");
    heading.className = "shortcuts-group-title";
    heading.textContent = group.title;
    section.appendChild(heading);

    for (const entry of group.entries) {
      const row = document.createElement("div");
      row.className = "shortcuts-row";
      row.dataset.haystack = `${entry.label} ${entry.binding}`.toLowerCase();

      const label = document.createElement("span");
      label.className = "shortcuts-label";
      label.textContent = entry.label;
      if (entry.label.length > 60) label.title = entry.label;
      row.appendChild(label);

      const binding = document.createElement("span");
      binding.className = "shortcuts-binding";
      binding.textContent = formatBinding(entry.binding);
      row.appendChild(binding);

      section.appendChild(row);
    }

    body.appendChild(section);
  }

  const hint = document.createElement("div");
  hint.className = "close-confirm-body";
  hint.textContent = "Press Esc to close. Edit any binding from Settings → Keyboard Shortcuts.";
  dialog.appendChild(hint);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const ac = new AbortController();
  const releaseTrap = trapFocus(dialog);

  let disposed = false;
  const dismiss = () => {
    if (disposed) return;
    disposed = true;
    ac.abort();
    releaseTrap();
    overlay.remove();
  };

  search.addEventListener(
    "input",
    () => {
      const query = search.value.trim().toLowerCase();
      for (const section of body.querySelectorAll<HTMLElement>(".shortcuts-group")) {
        let visibleRows = 0;
        for (const row of section.querySelectorAll<HTMLElement>(".shortcuts-row")) {
          const haystack = row.dataset.haystack || "";
          const visible = !query || haystack.includes(query);
          row.style.display = visible ? "" : "none";
          if (visible) visibleRows++;
        }
        section.style.display = visibleRows > 0 ? "" : "none";
      }
    },
    { signal: ac.signal },
  );

  overlay.addEventListener(
    "click",
    (e) => {
      if (e.target === overlay) dismiss();
    },
    { signal: ac.signal },
  );

  overlay.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
      }
    },
    { signal: ac.signal },
  );

  search.focus();
  return dismiss;
}
