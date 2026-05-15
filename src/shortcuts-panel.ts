import type { Config } from "./config";
import { eventToBinding, isUnbound } from "./config";
import { modLabel } from "./utils";
import { manualCheckForUpdates } from "./updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { logger } from "./logger";

declare const __APP_VERSION__: string;

type ActionKey = keyof Config["keybindings"];

export type ShortcutUpdate = (actionKey: ActionKey, binding: string) => void;

export interface ShortcutsPanel {
  element: HTMLDivElement;
  /** Detach all listeners. Caller invokes before removing the element. */
  destroy(): void;
}

export interface ShortcutEntry {
  label: string;
  binding: string;
  /** Key in Config.keybindings — present means the row is editable. */
  actionKey?: ActionKey;
}

export interface ShortcutGroup {
  title: string;
  entries: ShortcutEntry[];
}

export function formatBinding(raw: string): string {
  if (!raw) return "—";
  return raw
    .replace(/cmd/gi, modLabel)
    .replace(/shift/gi, "⇧")
    .replace(/alt|opt/gi, "⌥")
    .replace(/ctrl/gi, "⌃")
    .replace(/\+/g, " ")
    .toUpperCase();
}

export function buildShortcutGroups(config: Config): ShortcutGroup[] {
  const kb = config.keybindings;
  return [
    {
      title: "Tabs",
      entries: [
        { label: "New tab", binding: kb.newTab, actionKey: "newTab" },
        { label: "Close tab", binding: kb.closeTab, actionKey: "closeTab" },
        { label: "Next tab", binding: kb.nextTab, actionKey: "nextTab" },
        { label: "Previous tab", binding: kb.prevTab, actionKey: "prevTab" },
        { label: "Tab above", binding: "cmd+↑" },
        { label: "Tab below", binding: "cmd+↓" },
        { label: "Quick switch", binding: kb.quickSwitch, actionKey: "quickSwitch" },
        { label: "Restore closed tab", binding: kb.restoreTab, actionKey: "restoreTab" },
      ],
    },
    {
      title: "Projects",
      entries: [
        { label: "Next project", binding: kb.nextProject, actionKey: "nextProject" },
        { label: "Previous project", binding: kb.prevProject, actionKey: "prevProject" },
        { label: "New project", binding: kb.newProject, actionKey: "newProject" },
      ],
    },
    {
      title: "Panes",
      entries: [
        { label: "Split horizontal", binding: kb.splitHorizontal, actionKey: "splitHorizontal" },
        { label: "Split vertical", binding: kb.splitVertical, actionKey: "splitVertical" },
        { label: "Close pane", binding: kb.closePane, actionKey: "closePane" },
        { label: "Focus next pane", binding: kb.focusNextPane, actionKey: "focusNextPane" },
        { label: "Focus previous pane", binding: kb.focusPrevPane, actionKey: "focusPrevPane" },
        { label: "Resize pane", binding: "cmd+shift+arrow" },
        { label: "Jump to pane 1-9", binding: "cmd+alt+1-9" },
        { label: "Balance splits", binding: "Double-click divider" },
      ],
    },
    {
      title: "Terminal",
      entries: [
        { label: "Command palette", binding: kb.commandPalette, actionKey: "commandPalette" },
        { label: "Settings", binding: "cmd+," },
        { label: "Search", binding: kb.search, actionKey: "search" },
        { label: "Zoom in", binding: kb.zoomIn, actionKey: "zoomIn" },
        { label: "Zoom out", binding: kb.zoomOut, actionKey: "zoomOut" },
        { label: "Reset zoom", binding: kb.zoomReset, actionKey: "zoomReset" },
        { label: "Reload config", binding: kb.reloadConfig, actionKey: "reloadConfig" },
        { label: "Cycle attention tabs", binding: kb.cycleAttention, actionKey: "cycleAttention" },
      ],
    },
    ...(Object.keys(config.quickCommands).length > 0
      ? [
          {
            title: "Quick Commands",
            entries: Object.entries(config.quickCommands).map(([binding, cmd]) => ({
              label: cmd.replace(/\\n$/, "").replace(/\n$/, ""),
              binding,
            })),
          },
        ]
      : []),
  ];
}

function findConflict(config: Config, binding: string, exceptKey: ActionKey): ActionKey | null {
  for (const [k, v] of Object.entries(config.keybindings)) {
    if (k === exceptKey) continue;
    if (v && v === binding) return k as ActionKey;
  }
  return null;
}

/** Look up the human-readable label for an action key (for conflict banners). */
function labelForAction(config: Config, key: ActionKey): string {
  for (const group of buildShortcutGroups(config)) {
    for (const entry of group.entries) {
      if (entry.actionKey === key) return entry.label;
    }
  }
  return String(key);
}

interface PanelOptions {
  config: Config;
  onOpenConfig: () => void;
  onUpdate?: ShortcutUpdate;
}

export function createSettingsPanel(opts: PanelOptions): ShortcutsPanel {
  const { config, onUpdate } = opts;

  const panelAbort = new AbortController();
  const panelSignal = panelAbort.signal;
  let captureAbort: AbortController | null = null;

  const panel = document.createElement("div");
  panel.className = "shortcuts-panel";

  const aboutHeader = document.createElement("div");
  aboutHeader.className = "shortcuts-header";
  aboutHeader.textContent = "ClawTerm";
  panel.appendChild(aboutHeader);

  const tagline = document.createElement("div");
  tagline.className = "shortcuts-hint";
  tagline.textContent = "A terminal for running many AI agents at once and keeping track of them.";
  panel.appendChild(tagline);

  const version = document.createElement("div");
  version.className = "shortcuts-hint";
  version.textContent = `Version ${__APP_VERSION__} · MIT License`;
  panel.appendChild(version);

  const repoLink = document.createElement("a");
  repoLink.className = "shortcuts-hint settings-repo-link";
  repoLink.href = "https://github.com/clawterm/clawterm";
  repoLink.textContent = "github.com/clawterm/clawterm";
  repoLink.addEventListener(
    "click",
    (e) => {
      e.preventDefault();
      openUrl(repoLink.href).catch((err) => logger.debug("Failed to open repo URL:", err));
    },
    { signal: panelSignal },
  );
  panel.appendChild(repoLink);

  const configRow = document.createElement("div");
  configRow.className = "settings-config-row";

  const configPath = document.createElement("span");
  configPath.className = "settings-config-path";
  configPath.textContent = "~/.config/clawterm/config.json";
  configRow.appendChild(configPath);

  const openBtn = document.createElement("button");
  openBtn.className = "btn btn--ghost settings-open-btn";
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", opts.onOpenConfig, { signal: panelSignal });
  configRow.appendChild(openBtn);

  panel.appendChild(configRow);

  const updatesHeader = document.createElement("div");
  updatesHeader.className = "shortcuts-group-title";
  updatesHeader.textContent = "Updates";
  panel.appendChild(updatesHeader);

  const updatesRow = document.createElement("div");
  updatesRow.className = "settings-config-row";

  const versionLabel = document.createElement("span");
  versionLabel.className = "settings-config-path";
  versionLabel.textContent = `v${__APP_VERSION__}`;
  updatesRow.appendChild(versionLabel);

  const checkBtn = document.createElement("button");
  checkBtn.className = "btn btn--ghost settings-update-btn";
  checkBtn.textContent = "Check for Updates";
  checkBtn.addEventListener(
    "click",
    async () => {
      checkBtn.textContent = "Checking…";
      checkBtn.disabled = true;
      try {
        await manualCheckForUpdates();
        checkBtn.textContent = "Up to date";
        setTimeout(() => {
          checkBtn.textContent = "Check for Updates";
          checkBtn.disabled = false;
        }, 2000);
      } catch {
        checkBtn.textContent = "Check failed";
        setTimeout(() => {
          checkBtn.textContent = "Check for Updates";
          checkBtn.disabled = false;
        }, 2000);
      }
    },
    { signal: panelSignal },
  );
  updatesRow.appendChild(checkBtn);
  panel.appendChild(updatesRow);

  const shortcutsHeader = document.createElement("div");
  shortcutsHeader.className = "shortcuts-group-title";
  shortcutsHeader.style.marginTop = "var(--space-7)";
  shortcutsHeader.textContent = "Keyboard Shortcuts";
  panel.appendChild(shortcutsHeader);

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "shortcuts-search";
  searchInput.placeholder = "Search shortcuts…";
  searchInput.spellcheck = false;
  panel.appendChild(searchInput);

  const groupsContainer = document.createElement("div");
  panel.appendChild(groupsContainer);

  /** Map from actionKey to its row element, for targeted updates. */
  const rowsByAction = new Map<ActionKey, HTMLDivElement>();

  searchInput.addEventListener("input", () => applyFilter(), { signal: panelSignal });

  function currentQuery(): string {
    return searchInput.value.trim().toLowerCase();
  }

  function applyFilter() {
    const query = currentQuery();
    for (const section of groupsContainer.querySelectorAll<HTMLElement>(".shortcuts-group")) {
      let visibleRows = 0;
      for (const row of section.querySelectorAll<HTMLElement>(".shortcuts-row")) {
        const haystack = row.dataset.haystack || "";
        const visible = !query || haystack.includes(query);
        row.style.display = visible ? "" : "none";
        if (visible) visibleRows++;
      }
      section.style.display = visibleRows > 0 ? "" : "none";
    }
  }

  function renderGroups() {
    rowsByAction.clear();
    groupsContainer.replaceChildren();
    for (const group of buildShortcutGroups(config)) {
      const section = document.createElement("div");
      section.className = "shortcuts-group";

      const title = document.createElement("div");
      title.className = "shortcuts-group-title";
      title.textContent = group.title;
      section.appendChild(title);

      for (const entry of group.entries) {
        const row = buildRow(entry);
        section.appendChild(row);
        if (entry.actionKey) rowsByAction.set(entry.actionKey, row);
      }

      groupsContainer.appendChild(section);
    }
    applyFilter();
  }

  function buildRow(entry: ShortcutEntry): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "shortcuts-row";
    row.dataset.haystack = `${entry.label} ${entry.binding}`.toLowerCase();

    const label = document.createElement("span");
    label.className = "shortcuts-label";
    // Cap the visible label and stash the full text in a tooltip so a
    // long quick-command binding (the entire shell command) doesn't
    // balloon the row to multiple lines.
    if (entry.label.length > 60) {
      label.textContent = entry.label.slice(0, 58) + "…";
      label.title = entry.label;
    } else {
      label.textContent = entry.label;
    }
    row.appendChild(label);

    const right = document.createElement("span");
    right.className = "shortcuts-row-right";

    const kbd = document.createElement("kbd");
    kbd.className = "shortcuts-kbd";
    if (isUnbound(entry.binding)) kbd.classList.add("shortcuts-kbd-unbound");
    kbd.textContent = formatBinding(entry.binding);
    right.appendChild(kbd);

    if (entry.actionKey && onUpdate) {
      kbd.tabIndex = 0;
      kbd.title = "Click to rebind";
      kbd.classList.add("shortcuts-kbd-editable");
      const startCapture = () => enterCaptureMode(row, kbd, entry.actionKey!);
      kbd.addEventListener("click", startCapture, { signal: panelSignal });
      kbd.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            startCapture();
          }
        },
        { signal: panelSignal },
      );

      const trash = document.createElement("button");
      trash.className = "shortcuts-trash";
      trash.title = "Unbind";
      trash.setAttribute("aria-label", `Unbind ${entry.label}`);
      trash.textContent = "×";
      trash.addEventListener("click", () => commitBinding(entry.actionKey!, ""), {
        signal: panelSignal,
      });
      right.appendChild(trash);
    }

    row.appendChild(right);
    return row;
  }

  function refreshRow(actionKey: ActionKey) {
    const row = rowsByAction.get(actionKey);
    if (!row) return;
    const binding = config.keybindings[actionKey];
    const kbd = row.querySelector<HTMLElement>(".shortcuts-kbd");
    if (kbd) {
      kbd.textContent = formatBinding(binding);
      kbd.classList.toggle("shortcuts-kbd-unbound", isUnbound(binding));
    }
    const labelText = row.querySelector(".shortcuts-label")?.textContent ?? "";
    row.dataset.haystack = `${labelText} ${binding}`.toLowerCase();
    row.querySelector(".shortcuts-conflict")?.remove();
  }

  function endCapture(kbd: HTMLElement, restoreText?: string) {
    captureAbort?.abort();
    captureAbort = null;
    kbd.classList.remove("shortcuts-kbd-capturing");
    if (restoreText !== undefined) kbd.textContent = restoreText;
  }

  function enterCaptureMode(row: HTMLDivElement, kbd: HTMLElement, actionKey: ActionKey) {
    captureAbort?.abort();
    captureAbort = new AbortController();
    const captureSignal = captureAbort.signal;

    const previous = kbd.textContent ?? "";
    kbd.textContent = "Press a key…";
    kbd.classList.add("shortcuts-kbd-capturing");

    document.addEventListener(
      "keydown",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          endCapture(kbd, previous);
          row.querySelector(".shortcuts-conflict")?.remove();
          return;
        }
        const binding = eventToBinding(e);
        if (!binding) return;
        const conflict = findConflict(config, binding, actionKey);
        if (conflict) {
          showConflictBanner(row, kbd, actionKey, binding, conflict, previous);
          return;
        }
        endCapture(kbd);
        commitBinding(actionKey, binding);
      },
      { signal: captureSignal, capture: true },
    );
  }

  function showConflictBanner(
    row: HTMLDivElement,
    kbd: HTMLElement,
    actionKey: ActionKey,
    binding: string,
    conflictKey: ActionKey,
    previousText: string,
  ) {
    row.querySelector(".shortcuts-conflict")?.remove();
    const banner = document.createElement("div");
    banner.className = "shortcuts-conflict";
    banner.textContent = `Already bound to ${labelForAction(config, conflictKey)} — replace?`;

    const replace = document.createElement("button");
    replace.textContent = "Replace";
    replace.addEventListener(
      "click",
      () => {
        commitBinding(conflictKey, "");
        commitBinding(actionKey, binding);
        endCapture(kbd);
      },
      { signal: panelSignal },
    );

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener(
      "click",
      () => {
        banner.remove();
        endCapture(kbd, previousText);
      },
      { signal: panelSignal },
    );

    banner.appendChild(replace);
    banner.appendChild(cancel);
    row.appendChild(banner);
  }

  function commitBinding(actionKey: ActionKey, binding: string) {
    onUpdate?.(actionKey, binding);
    refreshRow(actionKey);
  }

  renderGroups();

  return {
    element: panel,
    destroy: () => {
      captureAbort?.abort();
      captureAbort = null;
      panelAbort.abort();
    },
  };
}
