import { Tab } from "./tab";
import { loadConfig, applyConfigToCSS, type Config } from "./config";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  copyToClipboard,
  getLiveCwd,
  invokeWithTimeout,
  isMac,
  isTextInputFocused,
  trapFocus,
} from "./utils";
import { WorkspacePanel } from "./workspace-panel";
import {
  openWorktreeDialog as worktreeOpenDialog,
  openSplitToBranchDialog as worktreeOpenSplitDialog,
  splitWithChoice,
  type WorktreeContext,
} from "./worktree-actions";
import { computeFolderTitle, createDefaultTabState } from "./tab-state";
import { NotificationManager } from "./notifications";
import { ServerTracker } from "./server-tracker";
import { IdleTracker } from "./idle-tracker";
import { showContextMenu, type ContextMenuItem } from "./context-menu";
import { TabSwitcher, type SwitcherTab } from "./tab-switcher";
import type { OutputEvent } from "./matchers";
import { logger } from "./logger";
import { showToast } from "./toast";
import { loadSession, saveSession, type SessionTab, type SessionV2 } from "./session";
import { createProject, type Project } from "./project";
import { createSettingsPanel } from "./shortcuts-panel";
import { showShortcutsOverlay } from "./shortcuts-overlay";
import { manualCheckForUpdates } from "./updater";
import { showCommandPalette, type PaletteCommand } from "./command-palette";
import { createKeyHandler, type KeybindingActions } from "./keybinding-handler";
import { TabRenderer } from "./tab-renderer";
import { perfMetrics } from "./perf";
import { isMainWindow, openNewWindow } from "./window-manager";

const PLUS_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1.5V10.5M1.5 6H10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const TITLEBAR_NO_DRAG_SELECTOR = "#traffic-lights, #new-window-btn";

function el(tag: string, attrs?: Record<string, string>, ...children: (HTMLElement | string)[]): HTMLElement {
  const e = document.createElement(tag);
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "id") e.id = v;
      else e.setAttribute(k, v);
    }
  for (const c of children) e.append(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

/** Update sidebar CSS class based on width for responsive layout (#346).
 *  Wide (≥180px): full layout. Compact (120-179px): reduced padding/info.
 *  Slim (<120px): icon-only, maximum density. */
function updateSidebarMode(width: number): void {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  sidebar.classList.toggle("sidebar-compact", width >= 120 && width < 180);
  sidebar.classList.toggle("sidebar-slim", width < 120);
}

/** Map config.keybindings keys → menu item IDs. Used to mirror the user's
 *  bindings into the macOS menu's accelerators on startup and on every
 *  reload. Bindings the menu can't parse are dropped on the Rust side;
 *  the keybinding handler keeps firing on the raw key event. */
const KEYBINDING_TO_MENU_ID: Record<keyof Config["keybindings"], string> = {
  newTab: "createTab",
  newWindow: "createWindow",
  closeTab: "closeActiveTab",
  nextTab: "nextTab",
  prevTab: "prevTab",
  reloadConfig: "reloadConfig",
  cycleAttention: "cycleAttentionTabs",
  search: "toggleSearch",
  quickSwitch: "showQuickSwitch",
  splitHorizontal: "splitHorizontal",
  splitVertical: "splitVertical",
  closePane: "closeActivePane",
  focusNextPane: "focusNextPane",
  focusPrevPane: "focusPrevPane",
  commandPalette: "openCommandPalette",
  zoomIn: "zoomIn",
  zoomOut: "zoomOut",
  zoomReset: "zoomReset",
  restoreTab: "restoreClosedTab",
  nextProject: "nextProject",
  prevProject: "prevProject",
  newProject: "newProject",
  newWorktreeTab: "openWorktreeDialog",
  toggleWorkspacePanel: "toggleWorkspacePanel",
  jumpToBranch: "jumpToBranch",
};

function menuAcceleratorsForConfig(config: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const bindingKey of Object.keys(KEYBINDING_TO_MENU_ID) as (keyof Config["keybindings"])[]) {
    const accel = config.keybindings[bindingKey];
    if (accel) out[KEYBINDING_TO_MENU_ID[bindingKey]] = accel;
  }
  return out;
}

export class TerminalManager {
  private tabs: Map<string, Tab> = new Map();
  private activeTabId: string | null = null;
  private tabCounter = 0;
  config!: Config;
  /** All projects — each owns a subset of tab IDs (#401) */
  private projects: Project[] = [];
  private activeProjectIndex = 0;
  private dragProjectIndex: number | null = null;
  private notifications!: NotificationManager;
  private serverTracker!: ServerTracker;
  private tabSwitcher = new TabSwitcher();
  private tabRenderer!: TabRenderer;
  private resizeObserver: ResizeObserver | null = null;
  private resizeRaf = 0;
  /** Settled-resize timer — fires ~150ms after the last ResizeObserver
   *  tick to force-fit every pane in the active tab, so panes streaming
   *  output don't stay stuck at the old column count after a window
   *  resize gesture ends (#532). */
  private resizeSettledTimer: ReturnType<typeof setTimeout> | null = null;
  /** rAF ID for coalesced render — multiple scheduleRender() calls within
   *  the same frame are batched into a single renderTabList(). */
  private renderRaf = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Idle-mode bookkeeping for the central poll loop. Wake-up sources call
   *  this.idleTracker.wake(); the tick reports its anyActive scan via
   *  noteTick() and reads intervalFor() to pick the next delay. (#456, #480) */
  private readonly idleTracker = new IdleTracker();
  private unlistenFocus: (() => void) | null = null;
  private lastTabSnapshot = "";
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Main window owns session.json; secondaries are ephemeral (#522). */
  private isSecondaryWindow = false;
  /** macOS menu state is process-level. Only the focused window may push
   *  accelerators/disabled-set to avoid background windows clobbering
   *  whatever the user's actually looking at. (#522) */
  private isWindowFocused = true;
  private shortcutsPanel: { element: HTMLDivElement; destroy(): void } | null = null;
  /** Read-only keyboard-shortcuts overlay (#514). Stores the dismiss thunk
   *  so a second invocation of the menu toggles it off. */
  private shortcutsOverlayDismiss: (() => void) | null = null;
  private creatingTab = false;
  private quitting = false;
  private handleKey!: (e: KeyboardEvent) => boolean;
  private menuActions!: KeybindingActions;
  private unlistenMenu: (() => void) | null = null;
  private lastMenuDisabled = "";
  private closedTabStack: { cwd: string; title?: string }[] = [];
  private workspacePanel!: WorkspacePanel;
  /** Debounced config write — coalesces rapid changes (zoom, sidebar drag) */
  private configWriteTimer: ReturnType<typeof setTimeout> | null = null;
  /** AbortController for document-level event listeners — aborted on dispose */
  private readonly ac = new AbortController();

  /** Unlock a worktree and then remove it. Unlock is needed because we lock
   *  worktrees on creation to protect them from accidental deletion by agents. */
  private async unlockAndRemoveWorktree(
    repoDir: string,
    worktreePath: string,
    force: boolean,
  ): Promise<void> {
    await invoke("unlock_worktree", { repoDir, worktreePath }).catch((e) =>
      logger.debug("unlock_worktree failed (non-fatal):", e),
    );
    await invoke("remove_worktree", { repoDir, worktreePath, force });
  }

  /** Unlock a worktree without removing it (e.g. when autoCleanup is off). */
  private unlockWorktree(repoDir: string, worktreePath: string): void {
    invoke("unlock_worktree", { repoDir, worktreePath }).catch((e) =>
      logger.debug("unlock_worktree failed (non-fatal):", e),
    );
  }

  /** Check if a worktree path is used by any pane/tab OTHER than the given excludeTabId. */
  private isWorktreeInUse(worktreePath: string, excludeTabId: string): boolean {
    for (const [id, tab] of this.tabs) {
      if (id === excludeTabId) continue;
      // Check tab-level worktree (legacy)
      if (tab.worktreePath === worktreePath) return true;
      // Check per-pane worktrees
      for (const pane of tab.getPanes()) {
        if (pane.worktreePath === worktreePath) return true;
      }
    }
    return false;
  }

  /** The currently active project */
  private get activeProject(): Project {
    return this.projects[this.activeProjectIndex];
  }

  /** Tab IDs belonging to the active project */
  private get projectTabIds(): string[] {
    return this.activeProject.tabIds;
  }

  /** Tabs visible in the sidebar — only the active project's tabs */
  private get visibleTabs(): Map<string, Tab> {
    const ids = new Set(this.projectTabIds);
    const result = new Map<string, Tab>();
    for (const [id, tab] of this.tabs) {
      if (ids.has(id)) result.set(id, tab);
    }
    return result;
  }

  async init() {
    const config = await loadConfig();
    this.config = config;
    this.notifications = new NotificationManager(this.config.notifications);
    this.notifications.onFocusTab = (tabId) => {
      if (this.tabs.has(tabId)) {
        getCurrentWindow().setFocus();
        this.switchToTab(tabId);
      }
    };
    this.serverTracker = new ServerTracker(
      this.config.advanced.healthCheckIntervalMs,
      this.config.advanced.ipcTimeoutMs,
    );
    applyConfigToCSS(this.config);

    // Set up Claude Code status line integration (non-blocking)
    invoke("setup_claude_statusline").catch((e) => logger.warn("Failed to set up Claude statusline:", e));

    this.tabRenderer = new TabRenderer({
      closeTab: (id) => this.closeTab(id),
      switchToTab: (id) => this.switchToTab(id),
      showTabContextMenu: (e, id) => this.showTabContextMenu(e, id),
      reorderTab: (dragId, targetId, insertBefore) => this.reorderTab(dragId, targetId, insertBefore),
      renameTab: (id) => this.startTabRename(id),
      splitTab: (id) => {
        this.switchToTab(id);
        worktreeOpenDialog(this.worktreeCtx());
      },
      killProcess: (id) => {
        const tab = this.tabs.get(id);
        if (tab) tab.writeToPty("\x03"); // Ctrl+C
      },
      muteTab: (id) => {
        const tab = this.tabs.get(id);
        if (tab) {
          tab.muted = !tab.muted;
          this.scheduleRender();
        }
      },
      focusPane: (id, paneIndex) => {
        if (this.activeTabId !== id) this.switchToTab(id);
        this.tabs.get(id)?.focusPaneByIndex(paneIndex);
        this.scheduleRender();
      },
    });

    const actions: KeybindingActions = {
      createTab: () => this.createTab(),
      createWindow: () => {
        void openNewWindow();
      },
      closeActiveTab: () => {
        if (this.activeTabId) this.closeTab(this.activeTabId);
      },
      nextTab: () => this.nextTab(),
      prevTab: () => this.prevTab(),
      reloadConfig: () => this.reloadConfig(),
      cycleAttentionTabs: () => this.cycleAttentionTabs(),
      toggleSearch: () => {
        if (this.activeTabId) this.tabs.get(this.activeTabId)?.toggleSearch();
      },
      showQuickSwitch: () => this.showQuickSwitch(),
      openCommandPalette: () => this.openCommandPalette(),
      splitHorizontal: () => splitWithChoice(this.worktreeCtx(), "horizontal"),
      splitVertical: () => splitWithChoice(this.worktreeCtx(), "vertical"),
      closeActivePane: () => this.closeActivePane(),
      focusNextPane: () => {
        if (this.activeTabId) this.tabs.get(this.activeTabId)?.focusNextPane();
      },
      focusPrevPane: () => {
        if (this.activeTabId) this.tabs.get(this.activeTabId)?.focusPrevPane();
      },
      resizePane: (direction) => {
        if (this.activeTabId) this.tabs.get(this.activeTabId)?.resizeFocusedPane(direction);
      },
      focusPaneByIndex: (index) => {
        if (this.activeTabId) this.tabs.get(this.activeTabId)?.focusPaneByIndex(index);
      },
      switchToTabIndex: (index) => {
        const ids = this.projectTabIds;
        if (index < ids.length) this.switchToTab(ids[index]);
      },
      writeToActivePty: (text) => this.writeToActivePty(text),
      zoomIn: () => this.adjustFontSize(1),
      zoomOut: () => this.adjustFontSize(-1),
      zoomReset: () => this.resetFontSize(),
      restoreClosedTab: () => this.restoreClosedTab(),
      openWorktreeDialog: () => worktreeOpenDialog(this.worktreeCtx()),
      toggleWorkspacePanel: () => this.toggleWorkspacePanel(),
      jumpToBranch: () => this.jumpToBranch(),
      toggleSettings: () => this.toggleSettingsPanel(),
      nextProject: () => this.switchToProject((this.activeProjectIndex + 1) % this.projects.length),
      prevProject: () =>
        this.switchToProject((this.activeProjectIndex - 1 + this.projects.length) % this.projects.length),
      newProject: () => this.createNewProject(),
    };
    this.handleKey = createKeyHandler(() => this.config, actions);
    this.menuActions = actions;
    if (isMac) this.setupNativeMenu();

    this.workspacePanel = new WorkspacePanel({
      switchToTab: (id) => this.switchToTab(id),
      openWorktreeDialog: () => worktreeOpenDialog(this.worktreeCtx()),
      showTabContextMenu: (e, id) => this.showTabContextMenu(e, id),
    });

    this.isSecondaryWindow = !isMainWindow();

    // Start session load in parallel with synchronous DOM setup.
    const sessionPromise = this.isSecondaryWindow ? Promise.resolve(null) : loadSession();

    this.renderShell();
    // Apply sidebar mode classes now that #sidebar exists in the DOM (#346)
    updateSidebarMode(this.config.sidebar.width);
    this.setupResize();
    this.setupServerTracker();

    // Restore session or create a fresh tab.
    // V2 session format has projects; V1 is wrapped in a single project by loadSession.
    const session = await sessionPromise;
    if (session && session.projects.length > 0) {
      // Restore each project's tabs
      for (let pi = 0; pi < session.projects.length; pi++) {
        const sp = session.projects[pi];
        const proj = createProject(sp.name);
        this.projects.push(proj);

        // For the active project, restore the active tab first for responsiveness
        const isActiveProject = pi === session.activeProject;
        if (isActiveProject) this.activeProjectIndex = this.projects.length - 1;

        const activeIdx = Math.min(sp.activeIndex, sp.tabs.length - 1);
        const ordered = [sp.tabs[activeIdx], ...sp.tabs.filter((_, i) => i !== activeIdx)];

        let restored = 0;
        for (const savedTab of ordered) {
          try {
            await this.restoreOneTab(savedTab);
            restored++;
            if (isActiveProject && restored === 1) {
              const ids = Array.from(this.tabs.keys());
              if (ids.length > 0) this.switchToTab(ids[ids.length - 1]);
            } else {
              await new Promise((r) => setTimeout(r, 0));
            }
          } catch (e) {
            logger.warn("Failed to restore tab, skipping:", e);
          }
        }
      }

      // If no tabs were restored at all, start fresh
      if (this.tabs.size === 0) {
        logger.warn("Session restore failed completely — starting fresh");
        showToast("Session restore failed — starting fresh", "warn");
        this.projects = [createProject()];
        this.activeProjectIndex = 0;
        await this.createTab();
      }
    } else {
      // Fresh start — create a default project with one tab
      this.projects = [createProject()];
      this.activeProjectIndex = 0;
      await this.createTab();
      this.showFirstRunWelcome();
    }

    // Start polling after session restore so PTY PIDs have time to resolve
    this.startCentralPoll();

    // One-time hint for users with worktrees from the old in-repo default.
    // Fires async so it never blocks startup. (#416)
    void this.maybeShowLegacyWorktreeHint();
  }

  /** If the user has worktrees in the old in-repo `.clawterm-worktrees/`
   *  directory and is running with the new default, show a single
   *  non-blocking toast pointing them at the new sibling-of-repo layout.
   *  Tracks "shown" state in localStorage so the hint never repeats. (#416) */
  private async maybeShowLegacyWorktreeHint(): Promise<void> {
    if (this.config.worktree.directory !== "") return;
    const FLAG_KEY = "clawterm-legacy-worktree-hint-shown";
    if (localStorage.getItem(FLAG_KEY)) return;
    // Wait briefly so the active tab has a chance to resolve its cwd via
    // polling. Default pollIntervalMs is 2000ms, so wait 2500ms to give the
    // first poll cycle a chance to complete and populate lastFullCwd.
    await new Promise((r) => setTimeout(r, 2500));
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    // Prefer the polled live cwd; fall back to the constructor cwd (from
    // session restore or user intent) so the hint still works on the very
    // first launch when polling hasn't completed yet. (#416 review)
    const cwd = tab?.lastFullCwd ?? tab?.initialCwd;
    if (!cwd) return;
    let repoRoot: string;
    try {
      repoRoot = await invokeWithTimeout<string>("find_repo_root", { dir: cwd }, 3000);
    } catch {
      return; // not in a git repo — nothing to migrate
    }
    if (!repoRoot) return;
    let hasLegacy: boolean;
    try {
      hasLegacy = await invokeWithTimeout<boolean>("has_legacy_in_repo_worktrees", { repoRoot }, 3000);
    } catch {
      return;
    }
    if (!hasLegacy) return;
    localStorage.setItem(FLAG_KEY, "1");
    showToast(
      "Found old worktrees in .clawterm-worktrees/. New worktrees will now be created outside the repo (#415).",
      "info",
      8000,
    );
  }

  /** Restore a single tab from a session snapshot. */
  private async restoreOneTab(savedTab: SessionTab) {
    let cwd: string | undefined = savedTab.cwd || undefined;
    if (cwd) {
      try {
        const exists = await invokeWithTimeout<boolean>("validate_dir", { path: cwd }, 2000);
        if (!exists) {
          logger.warn(`Session restore: CWD "${cwd}" no longer exists, using home`);
          cwd = undefined;
        }
      } catch {
        cwd = undefined;
      }
    }
    await this.createTab(cwd);

    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab) {
        if (savedTab.splits) {
          try {
            await tab.restoreSplits(savedTab.splits);
          } catch (e) {
            logger.warn("Failed to restore splits for tab:", e);
          }
        }
        if (savedTab.pinned) tab.pinned = true;
        if (savedTab.muted) tab.muted = true;
        if (savedTab.manualTitle) tab.manualTitle = savedTab.manualTitle;
        if (savedTab.worktreePath) tab.worktreePath = savedTab.worktreePath;
        if (savedTab.repoRoot) tab.repoRoot = savedTab.repoRoot;
        if (savedTab.worktreePath && savedTab.repoRoot) {
          const panes = tab.getPanes();
          const firstPane = panes.length > 0 ? panes[0] : null;
          if (firstPane && !firstPane.worktreePath) {
            firstPane.worktreePath = savedTab.worktreePath;
            firstPane.repoRoot = savedTab.repoRoot;
          }
        }
      }
    }
  }

  private setupServerTracker() {
    this.serverTracker.onServerCrash((tabId, port) => {
      const tab = this.tabs.get(tabId);
      if (!tab) return;
      tab.state.lastError = `Server on :${port} crashed`;
      this.scheduleRender();
    });
  }

  private renderShell() {
    const app = document.getElementById("app")!;
    if (this.config.sidebar.position === "right") {
      app.classList.add("sidebar-right");
    }
    // Project tabs live inside the titlebar, right of traffic lights (#401)
    const projectBar = el(
      "div",
      { id: "project-bar" },
      el("div", { class: "project-tabs" }),
      el("button", { class: "project-add-btn", "aria-label": "New project", title: "New project" }),
    );
    app.append(
      el(
        "div",
        { id: "titlebar", class: "titlebar-mac" },
        el(
          "div",
          { id: "traffic-lights" },
          el("button", { class: "traffic-light close", id: "btn-close", "aria-label": "Close window" }),
          el("button", {
            class: "traffic-light minimize",
            id: "btn-minimize",
            "aria-label": "Minimize window",
          }),
          el("button", {
            class: "traffic-light maximize",
            id: "btn-maximize",
            "aria-label": "Maximize window",
          }),
        ),
        projectBar,
        el("button", {
          id: "new-window-btn",
          "aria-label": "New window",
          title: "New window",
        }),
      ),
      el(
        "div",
        { id: "main-area" },
        el(
          "div",
          { id: "sidebar" },
          el("div", { id: "tab-list", role: "tablist", "aria-label": "Terminal tabs" }),
          el(
            "div",
            { id: "sidebar-footer" },
            el("div", { id: "startup-pills" }),
            el(
              "div",
              { id: "sidebar-footer-row" },
              el("button", { id: "settings-btn", "aria-label": "Settings", title: "Settings" }),
              el("button", { id: "new-tab-btn" }),
            ),
          ),
        ),
        el("div", { id: "sidebar-divider" }),
        el("div", { id: "terminal-area" }, el("div", { id: "terminal-container" })),
      ),
    );

    // Add workspace panel to the app
    document.getElementById("app")!.appendChild(this.workspacePanel.element);

    const win = getCurrentWindow();
    document.getElementById("btn-close")!.addEventListener("click", () => win.close());
    document.getElementById("btn-minimize")!.addEventListener("click", () => win.minimize());
    document.getElementById("btn-maximize")!.addEventListener("click", () => win.toggleMaximize());

    const titlebar = document.getElementById("titlebar")!;
    const isTitlebarControl = (e: Event) => !!(e.target as HTMLElement).closest(TITLEBAR_NO_DRAG_SELECTOR);
    titlebar.addEventListener("mousedown", (e) => {
      if (isTitlebarControl(e)) return;
      win.startDragging();
    });
    titlebar.addEventListener("dblclick", (e) => {
      if (isTitlebarControl(e)) return;
      win.toggleMaximize();
    });

    const newTabBtn = document.getElementById("new-tab-btn")!;
    newTabBtn.innerHTML = PLUS_ICON_SVG;
    newTabBtn.addEventListener("click", () => {
      this.createTab();
    });

    const newWindowBtn = document.getElementById("new-window-btn")!;
    newWindowBtn.innerHTML = PLUS_ICON_SVG;
    newWindowBtn.addEventListener("click", () => {
      void openNewWindow();
    });

    const settingsBtn = document.getElementById("settings-btn")!;
    settingsBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 9a2 2 0 100-4 2 2 0 000 4z" stroke="currentColor" stroke-width="1.2"/><path d="M5.7 1.5l-.3 1.2a4.5 4.5 0 00-1.2.7L3 3l-1.3 2.2 1 .8a4.5 4.5 0 000 1.4l-1 .8L3 10.4l1.2-.4a4.5 4.5 0 001.2.7l.3 1.2h2.6l.3-1.2a4.5 4.5 0 001.2-.7l1.2.4 1.3-2.2-1-.8a4.5 4.5 0 000-1.4l1-.8L11 3l-1.2.4a4.5 4.5 0 00-1.2-.7l-.3-1.2H5.7z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
    settingsBtn.addEventListener("click", () => {
      this.toggleSettingsPanel();
    });

    // Right-click on new-tab button shows startup command options
    document.getElementById("new-tab-btn")!.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const items: ContextMenuItem[] = [{ label: "New Tab", action: () => this.createTab() }];
      const cmds = this.config.startupCommands;
      if (Object.keys(cmds).length > 0) {
        let first = true;
        for (const [name, cmd] of Object.entries(cmds)) {
          items.push({
            label: name,
            separator: first,
            action: () => this.createTab(undefined, cmd),
          });
          first = false;
        }
      }
      showContextMenu(e.clientX, e.clientY, items);
    });

    // Render startup command pills (#340)
    this.renderStartupPills();

    document.getElementById("shortcuts-btn")?.addEventListener("click", () => {
      this.toggleSettingsPanel();
    });

    document.getElementById("update-btn")?.addEventListener("click", () => {
      manualCheckForUpdates();
    });

    // Project bar — "+" button creates a new project
    const projectAddBtn = projectBar.querySelector(".project-add-btn") as HTMLElement;
    if (projectAddBtn) {
      projectAddBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
      projectAddBtn.addEventListener("click", () => this.createNewProject());
    }

    // Project tab context menu (right-click to close/rename)
    projectBar.addEventListener("contextmenu", (e) => {
      const tab = (e.target as HTMLElement).closest(".project-tab") as HTMLElement;
      if (!tab) return;
      e.preventDefault();
      const index = Number(tab.dataset.index);
      const items: ContextMenuItem[] = [
        { label: "Rename Project", action: () => this.startProjectRename(index) },
        { label: "Close Project", action: () => this.closeProject(index), separator: true },
      ];
      showContextMenu(e.clientX, e.clientY, items);
    });

    // Re-focus terminal when window regains focus (fixes Cmd+Tab focus loss)
    // Also refresh pane viewports to recover from silent renderer failures
    // (WebGL context loss or canvas blanking while the window was unfocused).
    win
      .onFocusChanged(({ payload: focused }) => {
        this.isWindowFocused = focused;
        if (focused && this.activeTabId) {
          const tab = this.tabs.get(this.activeTabId);
          if (tab) {
            requestAnimationFrame(() => {
              tab.refreshAllPanes();
              tab.focus();
            });
          }
          // Window came back to focus — wake the poll loop so the user
          // sees fresh state instead of waiting on the idle interval. (#456)
          this.wake();
          // Refresh menu accelerators + disabled set so the process-level
          // macOS menu reflects this window after a focus swap. (#522)
          if (isMac) {
            this.lastMenuDisabled = "";
            this.applyMenuAccelerators();
            this.updateMenuDisabled();
          }
        }
      })
      .then((unlisten) => {
        this.unlistenFocus = unlisten;
      });

    // Re-focus terminal when clicking on terminal area (e.g. wrapper padding)
    document.getElementById("terminal-container")!.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".search-bar")) return;
      if (this.activeTabId) {
        requestAnimationFrame(() => {
          const tab = this.tabs.get(this.activeTabId!);
          tab?.focus();
        });
      }
    });

    this.setupSidebarResize();
  }

  private setupSidebarResize() {
    const divider = document.getElementById("sidebar-divider")!;
    const isRight = this.config.sidebar.position === "right";
    let dragging = false;

    divider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      document.body.style.cursor = "col-resize";
      document.body.classList.add("no-select");
    });

    document.addEventListener(
      "mousemove",
      (e) => {
        if (!dragging) return;
        const width = isRight ? window.innerWidth - e.clientX : e.clientX;
        const minWidth = 100;
        const maxWidth = 600;
        const clamped = Math.min(maxWidth, Math.max(minWidth, width));
        document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);
        updateSidebarMode(clamped);
      },
      { signal: this.ac.signal },
    );

    document.addEventListener(
      "mouseup",
      () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = "";
        document.body.classList.remove("no-select");

        // Persist to config
        const width = parseInt(
          getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"),
        );
        if (width && width !== this.config.sidebar.width) {
          this.config.sidebar.width = width;
          this.persistConfig();
        }

        // Refit active terminal
        if (this.activeTabId) {
          const tab = this.tabs.get(this.activeTabId);
          tab?.fit();
        }
      },
      { signal: this.ac.signal },
    );
  }

  async createTab(restoreCwd?: string, startupCommand?: string) {
    // Guard against concurrent tab creation (e.g. rapid button clicks)
    if (this.creatingTab) return;
    this.creatingTab = true;

    try {
      await this._createTab(restoreCwd, startupCommand);
    } finally {
      this.creatingTab = false;
    }
  }

  private async _createTab(restoreCwd?: string, startupCommand?: string) {
    if (this.tabs.size >= this.config.maxTabs) {
      showToast(`Tab limit reached (${this.config.maxTabs})`, "warn");
      return;
    }

    this.tabCounter++;
    const id = `tab-${this.tabCounter}`;
    const title = computeFolderTitle(createDefaultTabState());

    let cwd: string | undefined = restoreCwd;
    if (!cwd && this.activeTabId) {
      const activeTab = this.tabs.get(this.activeTabId);
      if (activeTab?.ptyPid) {
        const live = await getLiveCwd(activeTab.ptyPid, this.config.advanced.ipcTimeoutMs);
        if (live) cwd = live;
      }
    }

    logger.debug(`[createTab] id=${id} cwd=${cwd ?? "default"}`);
    const tab = new Tab(id, title, this.config, this.handleKey, cwd);

    tab.onExit = () => {
      this.serverTracker.removeServer(id);
      this.forceCloseTab(id);
    };

    tab.onTitleChange = () => {
      this.scheduleRender();
    };

    tab.onStateChange = () => {
      this.scheduleRender();
    };

    tab.onNeedsAttention = () => {
      this.scheduleRender();
    };

    tab.onOscNotification = (text) => {
      // OSC 9;2 is the single notification surface (#547). Suppress for
      // muted tabs and for the active tab (user is already looking at it).
      // The sidebar attention dot is handled separately in Tab.handleOscNotification.
      if (tab.muted) return;
      if (this.activeTabId === tab.id && !document.hidden) return;
      this.notifications.notifyAgentAttention(text, tab.title, tab.id);
    };

    tab.onOutputEvent = (event: OutputEvent) => {
      this.handleTabOutputEvent(id, tab, event);
    };

    tab.onActivity = () => {
      this.wake();
    };

    tab.onPaneClose = (pane) => {
      if (!pane.worktreePath || !pane.repoRoot) return;
      const siblingUsing =
        tab.getPanes().some((p) => p !== pane && p.worktreePath === pane.worktreePath) ||
        tab.worktreePath === pane.worktreePath;
      const otherTabUsing = this.isWorktreeInUse(pane.worktreePath, id);
      if (siblingUsing || otherTabUsing) return;

      if (this.config.worktree.autoCleanup) {
        // Unlock and remove
        this.unlockAndRemoveWorktree(pane.repoRoot, pane.worktreePath, false)
          .then(() => logger.debug(`[paneClose] cleaned up worktree: ${pane.worktreePath}`))
          .catch((e) => logger.debug(`[paneClose] worktree cleanup failed (may have changes): ${e}`));
      } else {
        // Just unlock so the user can manually clean up later
        this.unlockWorktree(pane.repoRoot, pane.worktreePath);
      }
    };

    this.tabs.set(id, tab);
    this.activeProject.tabIds.push(id);
    this.renderTabList();

    // Start the PTY and open terminal in DOM first
    let started = false;
    try {
      started = await tab.start();
    } catch (e) {
      logger.warn(`Tab ${id}: PTY start threw:`, e);
    }

    if (!started) {
      // PTY failed to spawn — clean up and remove the tab
      logger.warn(`Tab ${id}: PTY failed to start, removing tab`);
      tab.dispose();
      this.tabs.delete(id);
      this.renderTabList();
      return;
    }

    // Now switch to it (show + focus) after terminal is ready
    this.switchToTab(id);

    // Extra focus after a frame to ensure terminal is interactive
    requestAnimationFrame(() => tab.focus());

    // Immediately poll process info so the tab title updates ASAP
    // (don't wait for the next interval tick)
    tab
      .pollProcessInfo()
      .then(() => this.scheduleRender())
      .catch((e) => logger.debug("[createTab] initial poll failed:", e));

    // Send startup command after a brief delay for shell init
    if (startupCommand) {
      const cmd = startupCommand.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      setTimeout(() => tab.writeToPty(cmd.endsWith("\n") ? cmd : cmd + "\n"), 300);
    }

    this.persistSession();
  }

  /** Build the current session snapshot from live tab state. */
  private buildSessionSnapshot(): SessionV2 {
    const sessionProjects = this.projects.map((proj) => {
      const tabs: SessionTab[] = [];
      for (const tabId of proj.tabIds) {
        const tab = this.tabs.get(tabId);
        if (!tab) continue;
        const cwd = tab.lastFullCwd;
        if (!cwd) continue;
        tabs.push({
          title: tab.manualTitle,
          cwd,
          splits: tab.serializeSplits(),
          pinned: tab.pinned || undefined,
          muted: tab.muted || undefined,
          manualTitle: tab.manualTitle,
          worktreePath: tab.worktreePath || undefined,
          repoRoot: tab.repoRoot || undefined,
        });
      }
      const activeIndex = proj.activeTabId ? proj.tabIds.indexOf(proj.activeTabId) : 0;
      return {
        name: proj.name,
        tabs,
        activeIndex: Math.max(0, activeIndex),
      };
    });
    return {
      version: 2,
      projects: sessionProjects.filter((p) => p.tabs.length > 0),
      activeProject: this.activeProjectIndex,
    };
  }

  /** Start inline tab rename — replaces tab title with an input field. */
  private startTabRename(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    const entry = document.querySelector(`.tab-entry[data-id="${tabId}"]`);
    if (!entry) return;

    const titleEl = entry.querySelector(".tab-title") as HTMLElement;
    if (!titleEl) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "tab-rename-input";
    input.value = tab.manualTitle || tab.title;

    const finish = () => {
      const newTitle = input.value.trim();
      tab.manualTitle = newTitle || null;
      this.renderTabList();
      this.persistSession();
    };

    input.addEventListener("blur", finish);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      if (e.key === "Escape") {
        input.value = "";
        input.blur();
      }
    });

    titleEl.textContent = "";
    titleEl.appendChild(input);
    input.focus();
    input.select();
  }

  /** Show a one-time welcome message for first-run users. */
  private showFirstRunWelcome() {
    const key = "clawterm_welcomed";
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");

    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    if (!tab) return;

    const mod = isMac ? "Cmd" : "Ctrl";
    // Write welcome text after a brief delay for the shell to initialize
    setTimeout(() => {
      const msg = [
        "",
        "\x1b[1m  Welcome to ClawTerm\x1b[0m",
        "",
        `  \x1b[36m${mod}+T\x1b[0m  New tab        \x1b[36m${mod}+D\x1b[0m  Split pane`,
        `  \x1b[36m${mod}+P\x1b[0m  Quick switch   \x1b[36m${mod}+Shift+P\x1b[0m  Commands`,
        `  \x1b[36m${mod}+K\x1b[0m  Clear          \x1b[36m${mod}+Shift+A\x1b[0m  Attention tabs`,
        "",
      ].join("\r\n");
      tab.writeToTerminal(msg);
    }, 500);
  }

  private persistSession() {
    if (this.quitting) return;
    if (this.isSecondaryWindow) return;
    // Debounce: multiple rapid calls (tab switch, create, close) coalesce
    // into a single write after 500ms of quiet
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      if (this.quitting) return;
      saveSession(this.buildSessionSnapshot());
    }, 500);
  }

  /** Flush any pending debounced session save immediately. Call before dispose(). */
  async flushSession() {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    if (this.isSecondaryWindow) return;
    const snapshot = this.buildSessionSnapshot();
    if (snapshot.projects.length > 0) {
      await saveSession(snapshot);
    }
  }

  /** Debounced config write — coalesces rapid changes into a single disk write. */
  private persistConfig() {
    if (this.configWriteTimer) clearTimeout(this.configWriteTimer);
    this.configWriteTimer = setTimeout(() => {
      this.configWriteTimer = null;
      invoke("write_config", { contents: JSON.stringify(this.config, null, 2) }).catch(() => {
        showToast("Couldn't save config", "warn");
      });
    }, 500);
  }

  private handleTabOutputEvent(tabId: string, _tab: Tab, event: OutputEvent) {
    // Track servers for the "Open localhost:PORT in Browser" context menu.
    // No system notification fires for server events — irrelevant to the
    // app's purpose, was noise (#547).
    if (event.type === "server-started" && event.port) {
      this.serverTracker.addServer(tabId, event.port);
    }

    // Re-render UI (coalesced — multiple output events per frame become one render)
    this.scheduleRender();
  }

  private switchToTab(id: string) {
    if (this.activeTabId === id) return;
    logger.debug(`[switchToTab] from=${this.activeTabId} to=${id}`);

    if (this.activeTabId) {
      const current = this.tabs.get(this.activeTabId);
      if (current) current.hide();
    }

    // Dismiss any stuck overlays (paste confirm, close confirm) so they can't block input
    document.querySelectorAll(".close-confirm-overlay").forEach((el) => el.remove());

    // Dismiss shortcuts panel if open
    if (this.shortcutsPanel) {
      this.shortcutsPanel.destroy();
      this.shortcutsPanel.element.remove();
      this.shortcutsPanel = null;
      document.getElementById("shortcuts-btn")?.classList.remove("active");
    }

    this.activeTabId = id;
    this.activeProject.activeTabId = id;
    const tab = this.tabs.get(id);
    if (tab) tab.show();

    this.renderTabList();
    this.persistSession();
    // User just switched tabs — break out of idle mode so footer / sidebar
    // for the newly active tab refresh on the next tick. (#456)
    this.wake();
  }

  private nextTab() {
    if (!this.activeTabId) return;
    const ids = this.projectTabIds;
    if (ids.length <= 1) return;
    const currentIndex = ids.indexOf(this.activeTabId);
    const nextIndex = (currentIndex + 1) % ids.length;
    this.switchToTab(ids[nextIndex]);
  }

  private prevTab() {
    if (!this.activeTabId) return;
    const ids = this.projectTabIds;
    if (ids.length <= 1) return;
    const currentIndex = ids.indexOf(this.activeTabId);
    const prevIndex = (currentIndex - 1 + ids.length) % ids.length;
    this.switchToTab(ids[prevIndex]);
  }

  private cycleAttentionTabs() {
    const attentionIds = Array.from(this.visibleTabs.entries())
      .filter(([, tab]) => tab.state.needsAttention)
      .map(([id]) => id);

    if (attentionIds.length === 0) return;

    const currentIndex = attentionIds.indexOf(this.activeTabId!);
    const nextIndex = (currentIndex + 1) % attentionIds.length;
    this.switchToTab(attentionIds[nextIndex]);
  }

  private showQuickSwitch() {
    const switcherTabs: SwitcherTab[] = Array.from(this.visibleTabs.entries()).map(([id, tab]) => ({
      id,
      title: tab.title,
      subtitle: tab.state.gitBranch ?? null,
      branch: tab.state.gitBranch,
    }));

    this.tabSwitcher.show(switcherTabs, (id) => {
      this.switchToTab(id);
      const tab = this.tabs.get(id);
      tab?.focus();
    });
  }

  /** Render startup command pills in the sidebar footer (#340) */
  private renderStartupPills() {
    const container = document.getElementById("startup-pills");
    if (!container) return;
    container.textContent = "";
    const cmds = this.config.startupCommands;
    if (Object.keys(cmds).length === 0) {
      container.style.display = "none";
      return;
    }
    container.style.display = "";
    for (const [name, cmd] of Object.entries(cmds)) {
      const pill = document.createElement("button");
      pill.className = "startup-pill";
      pill.textContent = name;
      pill.title = cmd;
      pill.addEventListener("click", () => this.createTab(undefined, cmd));
      container.appendChild(pill);
    }
  }

  private writeToActivePty(text: string) {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;
    // Interpret escape sequences like \n
    const resolved = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    tab.writeToPty(resolved);
  }

  /** Listen for macOS menu bar events emitted from menu.rs (#487).
   *  Dispatches into the same KeybindingActions surface as the keybinding
   *  handler and command palette so all three input paths stay in sync.
   *  Menu item IDs that match a KeybindingActions method name are
   *  forwarded to it directly; the rest go through dispatchMenuExtra. */
  private async setupNativeMenu() {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      this.unlistenMenu = await listen<string>("menu-action", (e) => {
        // macOS menu is process-level; ignore events not meant for us. (#522)
        if (!this.isWindowFocused) return;
        this.dispatchMenuAction(e.payload);
      });
      this.applyMenuAccelerators();
      this.updateMenuDisabled();
    } catch (err) {
      logger.debug("menu-action listen failed:", err);
    }
  }

  /** Mirror config.keybindings into the macOS menu. Called once at startup
   *  and again on every config reload so the labels next to each menu
   *  item track whatever the user has set. */
  private applyMenuAccelerators() {
    if (!isMac) return;
    if (!this.isWindowFocused) return;
    const accelerators = menuAcceleratorsForConfig(this.config);
    invoke("apply_menu_accelerators", { accelerators }).catch((err) => {
      logger.debug("apply_menu_accelerators failed:", err);
    });
  }

  /** Compute the set of menu items that should appear dimmed for the
   *  current context, and push it to the macOS menu. Piggybacks on
   *  scheduleRender's rAF debounce; an identical-set guard short-circuits
   *  the IPC before it crosses the bridge. */
  private updateMenuDisabled() {
    if (!isMac) return;
    if (!this.isWindowFocused) return;
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    const disabled: string[] = [];
    if (!tab) {
      disabled.push(
        "closeActiveTab",
        "closeActivePane",
        "splitVertical",
        "splitHorizontal",
        "focusNextPane",
        "focusPrevPane",
        "toggleSearch",
        "editCut",
        "editCopy",
        "editSelectAll",
      );
      // Paste is a PredefinedMenuItem since #546 — AppKit manages its
      // enabled state via the responder chain, so it's not in this set.
    } else if (tab.paneCount <= 1) {
      disabled.push("closeActivePane");
    }
    if (!tab?.state.gitBranch) {
      disabled.push("openWorktreeDialog", "jumpToBranch", "toggleWorkspacePanel");
    }
    if (this.closedTabStack.length === 0) disabled.push("restoreClosedTab");
    if (this.projects.length <= 1) disabled.push("nextProject", "prevProject");
    // rAF debounce — skip the IPC if nothing about the menu state changed.
    const key = disabled.join("|");
    if (key === this.lastMenuDisabled) return;
    this.lastMenuDisabled = key;
    invoke("apply_menu_disabled", { disabled }).catch((err) => {
      logger.debug("apply_menu_disabled failed:", err);
    });
  }

  private dispatchMenuAction(id: string): void {
    const fn = (this.menuActions as unknown as Record<string, ((arg?: unknown) => void) | undefined>)[id];
    if (typeof fn === "function") {
      fn();
      return;
    }
    switch (id) {
      case "toggleSettings":
        this.toggleSettingsPanel();
        return;
      case "showShortcuts":
        this.openShortcutsOverlay();
        return;
      case "openConfigFile":
        this.openConfigFile();
        return;
      case "checkForUpdates":
        manualCheckForUpdates();
        return;
      case "about":
        showToast(`ClawTerm v${__APP_VERSION__}`, "info");
        return;
      case "editCopy":
      case "editCut":
      case "editSelectAll":
        this.dispatchEditAction(id);
        return;
      default:
        logger.debug("Unhandled menu-action:", id);
    }
  }

  /** Edit menu Cut / Copy / Select All. When a text input has focus
   *  (settings, search bar, command palette), use the browser's native
   *  edit semantics. Otherwise route to the focused pane's xterm.
   *  Paste is not handled here — it routes through AppKit's native
   *  paste: action (PredefinedMenuItem::paste, see #546). */
  private dispatchEditAction(id: string): void {
    if (isTextInputFocused()) {
      const el = document.activeElement;
      if (id === "editSelectAll" && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        el.select();
      } else if (id === "editCopy" || id === "editCut") {
        document.execCommand(id === "editCut" ? "cut" : "copy");
      }
      return;
    }
    const pane = this.activeTabId ? this.tabs.get(this.activeTabId)?.getFocusedPane() : null;
    if (!pane) return;
    if (id === "editSelectAll") {
      pane.selectAll();
    } else {
      // editCopy / editCut — terminal has no cut concept; both copy the selection.
      const sel = pane.getSelection();
      if (sel) copyToClipboard(sel);
    }
  }

  private toggleSettingsPanel() {
    const container = document.getElementById("terminal-container")!;

    if (this.shortcutsPanel) {
      this.shortcutsPanel.destroy();
      this.shortcutsPanel.element.remove();
      this.shortcutsPanel = null;
      if (this.activeTabId) {
        const tab = this.tabs.get(this.activeTabId);
        tab?.show();
      }
      return;
    }

    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      tab?.hide();
    }

    this.shortcutsPanel = createSettingsPanel({
      config: this.config,
      onOpenConfig: () => this.openConfigFile(),
      onUpdate: (actionKey, binding) => {
        (this.config.keybindings as Record<string, string>)[actionKey] = binding;
        this.persistConfig();
      },
    });
    container.appendChild(this.shortcutsPanel.element);
  }

  /** Help → Show Keyboard Shortcuts: read-only overlay listing every binding
   *  from config.keybindings. Separate from the settings panel so users can
   *  browse without entering edit mode (#514). */
  private openShortcutsOverlay() {
    if (this.shortcutsOverlayDismiss) {
      this.shortcutsOverlayDismiss();
      this.shortcutsOverlayDismiss = null;
      return;
    }
    this.shortcutsOverlayDismiss = showShortcutsOverlay(this.config);
  }

  private openCommandPalette() {
    const commands: PaletteCommand[] = [
      { id: "new-tab", label: "New Tab", category: "Tabs", action: () => this.createTab() },
      {
        id: "new-worktree-tab",
        label: "New Agent Tab on Branch\u2026",
        category: "Worktree",
        action: () => worktreeOpenDialog(this.worktreeCtx()),
      },
      {
        id: "toggle-workspace",
        label: "Toggle Workspace Panel",
        category: "Worktree",
        action: () => this.toggleWorkspacePanel(),
      },
      {
        id: "jump-to-branch",
        label: "Jump to Branch\u2026",
        category: "Worktree",
        action: () => this.jumpToBranch(),
      },
      {
        id: "close-tab",
        label: "Close Tab",
        category: "Tabs",
        action: () => {
          if (this.activeTabId) this.closeTab(this.activeTabId);
        },
      },
      {
        id: "restore-tab",
        label: "Restore Closed Tab",
        category: "Tabs",
        action: () => this.restoreClosedTab(),
      },
      { id: "next-tab", label: "Next Tab", category: "Tabs", action: () => this.nextTab() },
      { id: "prev-tab", label: "Previous Tab", category: "Tabs", action: () => this.prevTab() },
      {
        id: "new-project",
        label: "New Project",
        category: "Projects",
        action: () => this.createNewProject(),
      },
      {
        id: "next-project",
        label: "Next Project",
        category: "Projects",
        action: () => this.switchToProject((this.activeProjectIndex + 1) % this.projects.length),
      },
      {
        id: "prev-project",
        label: "Previous Project",
        category: "Projects",
        action: () =>
          this.switchToProject((this.activeProjectIndex - 1 + this.projects.length) % this.projects.length),
      },
      {
        id: "split-right",
        label: "Split Right",
        category: "Panes",
        action: () => splitWithChoice(this.worktreeCtx(), "horizontal"),
      },
      {
        id: "split-right-worktree",
        label: "Split Right \u2192 Worktree",
        category: "Panes",
        action: () => worktreeOpenSplitDialog(this.worktreeCtx(), "horizontal"),
      },
      {
        id: "split-right-same",
        label: "Split Right \u2192 Same Branch",
        category: "Panes",
        action: () => this.tabs.get(this.activeTabId!)?.split("horizontal"),
      },
      {
        id: "split-down",
        label: "Split Down",
        category: "Panes",
        action: () => splitWithChoice(this.worktreeCtx(), "vertical"),
      },
      {
        id: "split-down-worktree",
        label: "Split Down \u2192 Worktree",
        category: "Panes",
        action: () => worktreeOpenSplitDialog(this.worktreeCtx(), "vertical"),
      },
      {
        id: "split-down-same",
        label: "Split Down \u2192 Same Branch",
        category: "Panes",
        action: () => this.tabs.get(this.activeTabId!)?.split("vertical"),
      },
      { id: "close-pane", label: "Close Pane", category: "Panes", action: () => this.closeActivePane() },
      {
        id: "focus-next-pane",
        label: "Focus Next Pane",
        category: "Panes",
        action: () => this.tabs.get(this.activeTabId!)?.focusNextPane(),
      },
      {
        id: "balance-splits",
        label: "Balance Split Panes",
        category: "Panes",
        action: () => this.tabs.get(this.activeTabId!)?.balanceSplits(),
      },
      {
        id: "search",
        label: "Find in Terminal",
        category: "Terminal",
        action: () => this.tabs.get(this.activeTabId!)?.toggleSearch(),
      },
      {
        id: "reload-config",
        label: "Reload Config",
        category: "Terminal",
        action: () => this.reloadConfig(),
      },
      {
        id: "show-perf-stats",
        label: "Show Performance Stats",
        category: "Debug",
        action: () => {
          console.log(perfMetrics.getSummary());
          showToast("Performance stats logged to console", "info");
        },
      },
      {
        id: "open-config",
        label: "Open Config File",
        category: "Appearance",
        action: () => this.openConfigFile(),
      },
      { id: "zoom-in", label: "Zoom In", category: "Terminal", action: () => this.adjustFontSize(1) },
      { id: "zoom-out", label: "Zoom Out", category: "Terminal", action: () => this.adjustFontSize(-1) },
      { id: "zoom-reset", label: "Reset Zoom", category: "Terminal", action: () => this.resetFontSize() },
      {
        id: "shortcuts",
        label: "Settings",
        category: "Terminal",
        action: () => this.toggleSettingsPanel(),
      },
      {
        id: "cycle-attention",
        label: "Cycle Attention Tabs",
        category: "Tabs",
        action: () => this.cycleAttentionTabs(),
      },
      { id: "quick-switch", label: "Quick Switch", category: "Tabs", action: () => this.showQuickSwitch() },
    ];

    // Add pinning for active tab
    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab) {
        commands.push({
          id: "toggle-pin",
          label: tab.pinned ? "Unpin Tab" : "Pin Tab",
          category: "Tabs",
          action: () => {
            tab.pinned = !tab.pinned;
            this.scheduleRender();
          },
        });
        commands.push({
          id: "kill-process",
          label: "Kill Process",
          category: "Terminal",
          action: () => tab.sendInterrupt(),
        });
        commands.push({
          id: "restart-shell",
          label: "Restart Shell",
          category: "Terminal",
          action: () => tab.restartShell(),
        });
      }
    }

    // Add startup commands
    for (const [name, cmd] of Object.entries(this.config.startupCommands)) {
      commands.push({
        id: `startup-${name}`,
        label: `New Tab: ${name}`,
        category: "Tabs",
        action: () => this.createTab(undefined, cmd),
      });
    }

    commands.push({
      id: "copy-debug-log",
      label: `Copy Debug Log (${logger.getBufferSize()} entries)`,
      category: "Debug",
      action: () => {
        const logs = logger.getBufferedLogs();
        navigator.clipboard.writeText(logs).then(
          () => showToast("Debug log copied to clipboard", "info"),
          () => showToast("Failed to copy debug log", "error"),
        );
      },
    });

    showCommandPalette(commands);
  }

  private closeActivePane() {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;
    // If only one pane, fall through to close tab
    if (!tab.closeFocusedPane()) {
      this.closeTab(this.activeTabId);
    }
  }

  /** Close multiple tabs with confirmation. */
  private bulkClose(ids: string[]) {
    if (ids.length === 0) return;
    this.showCloseConfirm(ids[0], `Close ${ids.length} tab${ids.length > 1 ? "s" : ""}?`, () => {
      for (const id of ids) this.forceCloseTab(id);
    });
  }

  private closeTab(id: string, force = false) {
    logger.debug(`[closeTab] id=${id} force=${force}`);
    const tab = this.tabs.get(id);
    if (!tab) return;

    // Pinned tabs can't be closed unless forced
    if (tab.pinned && !force) {
      showToast("Unpin the tab first to close it", "warn", 2000);
      return;
    }

    // Always confirm before closing (unless forced)
    if (!force) {
      this.showCloseConfirm(id, "Are you sure you want to close this tab?");
      return;
    }

    this.forceCloseTab(id);
  }

  private forceCloseTab(id: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    // Save CWD for restore-closed-tab feature (keep last 10)
    const cwd = tab.lastFullCwd;
    if (cwd) {
      this.closedTabStack.push({ cwd, title: tab.manualTitle ?? undefined });
      const MAX_CLOSED_TABS = 10;
      if (this.closedTabStack.length > MAX_CLOSED_TABS) this.closedTabStack.shift();
    }

    // Clean up or unlock worktrees — collect from both tab-level (legacy) and per-pane
    // Skip any worktree still used by another tab/pane to avoid deleting active work
    {
      const handled = new Set<string>();
      // Per-pane worktrees (new system)
      for (const pane of tab.getPanes()) {
        if (pane.worktreePath && pane.repoRoot) {
          const key = pane.worktreePath;
          if (!handled.has(key) && !this.isWorktreeInUse(key, id)) {
            handled.add(key);
            if (this.config.worktree.autoCleanup) {
              this.unlockAndRemoveWorktree(pane.repoRoot, pane.worktreePath, false).catch((e) =>
                logger.debug("Auto-cleanup worktree failed:", e),
              );
            } else {
              this.unlockWorktree(pane.repoRoot, pane.worktreePath);
            }
          }
        }
      }
      // Tab-level worktree (legacy "New Agent Tab" flow — may overlap with pane)
      if (
        tab.worktreePath &&
        tab.repoRoot &&
        !handled.has(tab.worktreePath) &&
        !this.isWorktreeInUse(tab.worktreePath, id)
      ) {
        if (this.config.worktree.autoCleanup) {
          this.unlockAndRemoveWorktree(tab.repoRoot, tab.worktreePath, false).catch((e) =>
            logger.debug("Auto-cleanup worktree failed:", e),
          );
        } else {
          this.unlockWorktree(tab.repoRoot, tab.worktreePath);
        }
      }
    }

    this.serverTracker.removeServer(id);
    try {
      tab.dispose();
    } catch (e) {
      logger.warn(`Tab ${id} dispose failed:`, e);
    }
    this.tabs.delete(id);
    // Remove from whichever project owns this tab
    for (const proj of this.projects) {
      const idx = proj.tabIds.indexOf(id);
      if (idx !== -1) {
        proj.tabIds.splice(idx, 1);
        break;
      }
    }

    if (this.activeTabId === id) {
      this.activeTabId = null;
      const remaining = this.projectTabIds;
      if (remaining.length > 0) {
        this.switchToTab(remaining[remaining.length - 1]);
      } else if (this.projects.length > 1) {
        // Project is empty — remove it and switch to adjacent project
        this.projects.splice(this.activeProjectIndex, 1);
        if (this.activeProjectIndex >= this.projects.length) {
          this.activeProjectIndex = this.projects.length - 1;
        }
        const proj = this.activeProject;
        const targetId = proj.activeTabId || proj.tabIds[proj.tabIds.length - 1] || null;
        if (targetId) {
          this.activeTabId = targetId;
          const tab = this.tabs.get(targetId);
          if (tab) tab.show();
        }
      } else {
        // destroy() not close(): the onCloseRequested hook in main.ts
        // re-enters dispose() and leaves the window frozen-but-alive if
        // we go through close() while still inside our own teardown. (#522)
        getCurrentWindow()
          .destroy()
          .catch((err) => logger.warn("window.destroy() failed:", err));
        return;
      }
    }

    this.renderTabList();
    this.persistSession();
  }

  private restoreClosedTab() {
    const entry = this.closedTabStack.pop();
    if (!entry) {
      showToast("No recently closed tabs", "warn", 2000);
      return;
    }
    this.createTab(entry.cwd);
  }

  // ── Project management (#401) ──────────────────────────────────────────

  /** Create a new project and switch to it */
  async createNewProject(name?: string) {
    const proj = createProject(name);
    this.projects.push(proj);
    this.switchToProject(this.projects.length - 1);
    await this.createTab();
    this.persistSession();
  }

  /** Switch to a different project by index */
  switchToProject(index: number) {
    if (index < 0 || index >= this.projects.length) return;
    if (index === this.activeProjectIndex) return;

    // Hide current active tab
    if (this.activeTabId) {
      const currentTab = this.tabs.get(this.activeTabId);
      if (currentTab) currentTab.hide();
    }

    this.activeProjectIndex = index;
    const proj = this.activeProject;

    // Show the project's active tab (or the last tab if no active)
    const targetId = proj.activeTabId || proj.tabIds[proj.tabIds.length - 1] || null;
    if (targetId) {
      this.activeTabId = targetId;
      proj.activeTabId = targetId;
      const tab = this.tabs.get(targetId);
      if (tab) tab.show();
    } else {
      this.activeTabId = null;
    }

    this.renderTabList();
    this.persistSession();
  }

  /** Close a project — confirms first, then disposes all tabs */
  closeProject(index: number) {
    if (index < 0 || index >= this.projects.length) return;

    if (this.projects.length <= 1) {
      showToast("Can't close the last project", "warn", 2000);
      return;
    }

    const proj = this.projects[index];
    const tabCount = proj.tabIds.length;
    const msg = tabCount === 1 ? `"${proj.name}" has 1 tab` : `"${proj.name}" has ${tabCount} tabs`;

    // Reuse the existing close-confirm dialog with a custom callback
    this.showCloseConfirm("", msg, () => this.forceCloseProject(index), "Close project?");
  }

  /** Actually close a project after confirmation */
  private forceCloseProject(index: number) {
    if (index < 0 || index >= this.projects.length) return;
    if (this.projects.length <= 1) return;

    // Hide the active tab before disposing anything
    if (this.activeTabId) {
      const activeTab = this.tabs.get(this.activeTabId);
      if (activeTab) activeTab.hide();
    }

    const proj = this.projects[index];

    // Dispose all tabs in this project
    for (const tabId of [...proj.tabIds]) {
      const tab = this.tabs.get(tabId);
      if (tab) {
        this.serverTracker.removeServer(tabId);
        try {
          tab.dispose();
        } catch {
          /* ignore */
        }
        this.tabs.delete(tabId);
      }
    }

    this.projects.splice(index, 1);

    // Adjust active project index — pick the previous project, or 0
    if (index <= this.activeProjectIndex) {
      this.activeProjectIndex = Math.max(0, this.activeProjectIndex - 1);
    }
    if (this.activeProjectIndex >= this.projects.length) {
      this.activeProjectIndex = this.projects.length - 1;
    }

    // Switch to the new active project's tab
    const newProj = this.activeProject;
    const targetId = newProj.activeTabId || newProj.tabIds[newProj.tabIds.length - 1] || null;
    this.activeTabId = targetId;
    if (targetId) {
      newProj.activeTabId = targetId;
      const tab = this.tabs.get(targetId);
      if (tab) tab.show();
    }

    this.renderTabList();
    this.persistSession();
  }

  /** Rename a project */
  renameProject(index: number, name: string) {
    if (index < 0 || index >= this.projects.length) return;
    this.projects[index].name = name.trim() || "Project";
    this.renderProjectBar();
    this.persistSession();
  }

  /** Render the project bar — updates tab highlights and labels */
  private renderProjectBar() {
    const bar = document.getElementById("project-bar");
    if (!bar) return;

    // Project bar is always visible — shows current project + "+" button

    const tabsContainer = bar.querySelector(".project-tabs") as HTMLElement;
    if (!tabsContainer) return;

    // Always rebuild to avoid stale closures after project add/remove
    tabsContainer.innerHTML = "";

    for (let i = 0; i < this.projects.length; i++) {
      const proj = this.projects[i];
      const idx = i; // capture for closures

      const tab = document.createElement("div");
      tab.className = "project-tab";
      if (i === this.activeProjectIndex) tab.classList.add("active");
      tab.dataset.index = String(i);

      const label = document.createElement("span");
      label.className = "project-tab-label";
      label.textContent = proj.name;
      tab.appendChild(label);

      const closeBtn = document.createElement("button");
      closeBtn.className = "btn btn--icon project-tab-close";
      closeBtn.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
      closeBtn.title = "Close project";
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        this.closeProject(idx);
      };
      tab.appendChild(closeBtn);

      tab.onclick = () => this.switchToProject(idx);
      tab.ondblclick = () => this.startProjectRename(idx);

      // Drag-to-reorder (#404)
      tab.setAttribute("draggable", "true");
      tab.addEventListener("dragstart", (e) => {
        this.dragProjectIndex = idx;
        tab.classList.add("dragging");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      tab.addEventListener("dragend", () => {
        this.dragProjectIndex = null;
        tab.classList.remove("dragging");
        tabsContainer.querySelectorAll(".project-tab").forEach((node) => {
          node.classList.remove("drag-over-left", "drag-over-right");
        });
      });
      tab.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (this.dragProjectIndex === null || this.dragProjectIndex === idx) return;
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = tab.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        tab.classList.toggle("drag-over-left", e.clientX < midX);
        tab.classList.toggle("drag-over-right", e.clientX >= midX);
      });
      tab.addEventListener("dragleave", () => {
        tab.classList.remove("drag-over-left", "drag-over-right");
      });
      tab.addEventListener("drop", (e) => {
        e.preventDefault();
        tab.classList.remove("drag-over-left", "drag-over-right");
        if (this.dragProjectIndex === null || this.dragProjectIndex === idx) return;
        const rect = tab.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const insertBefore = e.clientX < midX;
        this.reorderProject(this.dragProjectIndex, idx, insertBefore);
      });

      tabsContainer.appendChild(tab);
    }
  }

  /** Start inline rename of a project tab */
  private startProjectRename(index: number) {
    const bar = document.getElementById("project-bar");
    if (!bar) return;

    const tabEl = bar.querySelectorAll(".project-tab")[index] as HTMLElement;
    if (!tabEl) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "project-rename-input";
    input.value = this.projects[index].name;

    const finish = () => {
      const newName = input.value.trim();
      this.renameProject(index, newName || "Project");
      this.renderProjectBar();
    };

    input.addEventListener("blur", finish);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      if (e.key === "Escape") {
        input.value = "";
        input.blur();
      }
    });

    tabEl.textContent = "";
    tabEl.appendChild(input);
    input.focus();
    input.select();
  }

  /** Open the config file in the system's default editor/app. */
  private async openConfigFile() {
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      // Config lives at ~/.config/clawterm/config.json (see Rust config_path())
      const { configDir, join } = await import("@tauri-apps/api/path");
      const dir = await configDir();
      const path = await join(dir, "clawterm", "config.json");
      await openPath(path);
    } catch (e) {
      logger.warn("Failed to open config file:", e);
      showToast("Could not open config file", "error");
    }
  }

  /** Build a WorktreeContext for the extracted worktree actions module. */
  private worktreeCtx(): WorktreeContext {
    return {
      getActiveTab: () => (this.activeTabId ? (this.tabs.get(this.activeTabId) ?? null) : null),
      config: this.config,
      createTab: (cwd: string) => this.createTab(cwd),
      writeToActivePty: (text: string) => this.writeToActivePty(text),
    };
  }

  private toggleWorkspacePanel() {
    this.workspacePanel.toggle();
    if (this.workspacePanel.isVisible()) {
      this.workspacePanel.update(this.tabs, this.activeTabId);
    }
  }

  private jumpToBranch() {
    const switcherTabs: SwitcherTab[] = Array.from(this.tabs.entries())
      .filter(([, tab]) => !!tab.state.gitBranch)
      .map(([id, tab]) => ({
        id,
        title: tab.state.gitBranch || tab.title,
        subtitle: null,
        branch: tab.state.gitBranch,
      }));
    if (switcherTabs.length === 0) {
      showToast("No tabs with git branches", "warn", 2000);
      return;
    }
    this.tabSwitcher.show(switcherTabs, (id) => {
      this.switchToTab(id);
      this.tabs.get(id)?.focus();
    });
  }

  private showCloseConfirm(tabId: string, message: string, onConfirm?: () => void, title?: string) {
    // Remove existing confirm if any
    document.querySelector(".close-confirm-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "close-confirm-overlay";

    const dialog = document.createElement("div");
    dialog.className = "close-confirm-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "close-confirm-title");
    dialog.setAttribute("aria-describedby", "close-confirm-body");

    const titleEl = document.createElement("div");
    titleEl.className = "close-confirm-title";
    titleEl.id = "close-confirm-title";
    titleEl.textContent = title || "Close tab?";

    const bodyEl = document.createElement("div");
    bodyEl.className = "close-confirm-body";
    bodyEl.id = "close-confirm-body";
    bodyEl.textContent = message;

    const actionsEl = document.createElement("div");
    actionsEl.className = "close-confirm-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn--secondary close-confirm-btn";
    cancelBtn.textContent = "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn btn--destructive close-confirm-btn";
    confirmBtn.textContent = "Close";

    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(confirmBtn);
    dialog.appendChild(titleEl);
    dialog.appendChild(bodyEl);
    dialog.appendChild(actionsEl);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const removeTrap = trapFocus(dialog);
    const dismiss = () => {
      removeTrap();
      overlay.remove();
    };

    cancelBtn.addEventListener("click", dismiss);
    confirmBtn.addEventListener("click", () => {
      dismiss();
      if (onConfirm) {
        onConfirm();
      } else {
        this.forceCloseTab(tabId);
      }
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) dismiss();
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") dismiss();
      // Enter confirms the close
      if (e.key === "Enter") {
        e.preventDefault();
        dismiss();
        if (onConfirm) {
          onConfirm();
        } else {
          this.forceCloseTab(tabId);
        }
      }
    });

    // Auto-focus the confirm button so Enter closes quickly
    confirmBtn.focus();
  }

  private async showTabContextMenu(e: MouseEvent, tabId: string) {
    e.preventDefault();
    e.stopPropagation();

    const tab = this.tabs.get(tabId);
    if (!tab) return;

    const items: ContextMenuItem[] = [
      {
        label: "Rename Tab",
        action: () => this.startTabRename(tabId),
      },
      {
        label: tab.pinned ? "Unpin Tab" : "Pin Tab",
        action: () => {
          tab.pinned = !tab.pinned;
          this.scheduleRender();
        },
      },
      {
        label: tab.muted ? "Unmute Notifications" : "Mute Notifications",
        action: () => {
          tab.muted = !tab.muted;
          this.scheduleRender();
        },
      },
      {
        label: "Close",
        separator: true,
        disabled: tab.pinned,
        action: () => this.closeTab(tabId),
      },
      {
        label: "Split Right",
        separator: true,
        action: () => {
          this.switchToTab(tabId);
          tab.split("horizontal").catch((e) => {
            logger.warn("Split failed:", e);
            showToast("Failed to split terminal", "error");
          });
        },
      },
      {
        label: "Split Down",
        action: () => {
          this.switchToTab(tabId);
          tab.split("vertical").catch((e) => {
            logger.warn("Split failed:", e);
            showToast("Failed to split terminal", "error");
          });
        },
      },
      {
        label: "Close Others",
        separator: true,
        action: () => {
          const ids = Array.from(this.tabs.keys()).filter((id) => id !== tabId && !this.tabs.get(id)?.pinned);
          this.bulkClose(ids);
        },
      },
      {
        label: "Close to Right",
        action: () => {
          const ids = Array.from(this.tabs.keys());
          const idx = ids.indexOf(tabId);
          const targets = ids.slice(idx + 1).filter((id) => !this.tabs.get(id)?.pinned);
          this.bulkClose(targets);
        },
      },
    ];

    // Open in browser if server tab
    const server = this.serverTracker.getServer(tabId);
    if (server) {
      items.push({
        label: `Open localhost:${server.port} in Browser`,
        separator: true,
        action: () => {
          try {
            window.open(`http://localhost:${server.port}`, "_blank");
          } catch {
            showToast(`Failed to open localhost:${server.port}`, "error");
          }
        },
      });
    }

    // Process control
    items.push({
      label: "Kill Process",
      separator: true,
      disabled: tab.state.isIdle,
      action: () => {
        tab.sendInterrupt();
      },
    });

    items.push({
      label: "Restart Shell",
      action: () => {
        tab.restartShell();
      },
    });

    // Directory actions
    const cwd = tab.lastFullCwd ?? tab.initialCwd;
    items.push({
      label: "Copy Path",
      separator: true,
      disabled: !cwd,
      action: () => {
        if (cwd) {
          navigator.clipboard.writeText(cwd).catch(() => {
            showToast("Failed to copy to clipboard", "error");
          });
        }
      },
    });
    items.push({
      label: "Reveal in Finder",
      disabled: !cwd,
      action: async () => {
        if (!cwd) return;
        try {
          const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
          await revealItemInDir(cwd);
        } catch {
          showToast("Failed to reveal in Finder", "error");
        }
      },
    });

    // Editor actions — only show editors that are installed
    const editors = await invoke<string[]>("detect_editors").catch(() => [] as string[]);
    for (const editor of editors) {
      items.push({
        label: `Open in ${editor}`,
        disabled: !cwd,
        action: async () => {
          if (!cwd) return;
          try {
            await invoke("open_in_editor", { editor, path: cwd });
          } catch {
            showToast(`Failed to open in ${editor}`, "error");
          }
        },
      });
    }

    showContextMenu(e.clientX, e.clientY, items);
  }

  /** Schedule a coalesced render — multiple calls within the same frame
   *  are batched into a single renderTabList(). */
  private scheduleRender() {
    if (this.renderRaf) return;
    this.renderRaf = requestAnimationFrame(() => {
      this.renderRaf = 0;
      this.renderTabList();
      this.updateMenuDisabled();
    });
  }

  private renderTabList() {
    const start = performance.now();
    const list = document.getElementById("tab-list")!;
    const visible = this.visibleTabs;
    this.tabRenderer.renderTabList(list, visible, this.activeTabId);
    // Update workspace panel alongside tab list
    this.workspacePanel.update(visible, this.activeTabId);
    // Update project bar highlight
    this.renderProjectBar();
    perfMetrics.record("renderTabList", performance.now() - start);
  }

  private reorderTab(dragId: string, targetId: string, insertBefore: boolean) {
    // Reorder within the active project's tab list
    const keys = [...this.activeProject.tabIds];
    const dragIdx = keys.indexOf(dragId);
    if (dragIdx === -1) return;

    keys.splice(dragIdx, 1);

    let targetIdx = keys.indexOf(targetId);
    if (targetIdx === -1) return;

    if (!insertBefore) targetIdx += 1;
    keys.splice(targetIdx, 0, dragId);

    this.activeProject.tabIds = keys;

    // Also reorder in the global map so iteration order matches
    const reordered = new Map<string, Tab>();
    // Add non-project tabs first (preserve their order)
    const projSet = new Set(keys);
    for (const [id, tab] of this.tabs) {
      if (!projSet.has(id)) reordered.set(id, tab);
    }
    // Then add project tabs in new order
    for (const key of keys) {
      const tab = this.tabs.get(key);
      if (tab) reordered.set(key, tab);
    }
    this.tabs = reordered;

    this.renderTabList();
    this.persistSession();
  }

  private reorderProject(fromIndex: number, toIndex: number, insertBefore: boolean) {
    if (fromIndex === toIndex) return;
    const active = this.activeProject;
    const proj = this.projects[fromIndex];
    this.projects.splice(fromIndex, 1);

    let target = toIndex > fromIndex ? toIndex - 1 : toIndex;
    if (!insertBefore) target += 1;
    this.projects.splice(target, 0, proj);

    // Update activeProjectIndex to follow the active project
    this.activeProjectIndex = this.projects.indexOf(active);

    this.renderProjectBar();
    this.persistSession();
  }

  private adjustFontSize(delta: number) {
    const current = this.config.font.size;
    const newSize = Math.max(8, Math.min(32, current + delta));
    if (newSize === current) return;
    this.config.font.size = newSize;
    for (const tab of this.tabs.values()) {
      tab.applyConfig(this.config);
    }
    this.persistConfig();
  }

  private resetFontSize() {
    this.config.font.size = 14; // default
    for (const tab of this.tabs.values()) {
      tab.applyConfig(this.config);
    }
    this.persistConfig();
  }

  private async reloadConfig() {
    this.config = await loadConfig();
    this.notifications.updateConfig(this.config.notifications);
    applyConfigToCSS(this.config);
    updateSidebarMode(this.config.sidebar.width);
    this.renderStartupPills();

    for (const tab of this.tabs.values()) {
      tab.applyConfig(this.config);
    }

    // Restart poll timer with potentially new interval values
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.startCentralPoll();

    this.renderTabList();
    this.applyMenuAccelerators();
  }

  private pollCycleCount = 0;

  private startCentralPoll() {
    this.pollCycleCount = 0;
    this.idleTracker.reset();
    this.idleTracker.setWakeHandler(() => this.scheduleNextPoll(0));
    this.scheduleNextPoll(this.config.advanced.pollIntervalMs);
  }

  /** Schedule the next central poll tick. Uses setTimeout (not setInterval)
   *  so the cadence can be dynamically adjusted between fg and idle
   *  intervals based on whether anything is happening. (#456) */
  private scheduleNextPoll(delayMs: number) {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.pollTick(), delayMs);
  }

  /** Wake the central poll loop now. Called when an activity signal arrives
   *  (PTY data, OSC notification, terminal title change, tab switch, window
   *  focus regain) so the user doesn't wait the full IDLE_INTERVAL_MS to see
   *  state catch up after a quiet period. Cheap when not idle — early-returns
   *  inside IdleTracker before touching the timer. (#456, #480) */
  wake(): void {
    this.idleTracker.wake();
  }

  private async pollTick() {
    if (this.quitting) return;
    this.pollCycleCount++;
    const fgInterval = this.config.advanced.pollIntervalMs;
    const bgInterval = this.config.advanced.backgroundPollIntervalMs;

    // Snapshot active tab ID to avoid race if user switches mid-loop
    const activeId = this.activeTabId;

    // Stagger background polls across the bgInterval window. The old
    // "poll every bg tab once every 5s" triggered a simultaneous IPC
    // wave — N tabs each spawning a git-status subprocess at the same
    // instant, which manifested as a ~5s-cadence UI freeze as the
    // main thread waited on the Promise.all/renderTabList burst (#434).
    const bgIds: string[] = [];
    for (const id of this.tabs.keys()) {
      if (id !== activeId) bgIds.push(id);
    }
    const slots = Math.max(1, Math.round(bgInterval / fgInterval));
    const perSlot = bgIds.length > 0 ? Math.max(1, Math.ceil(bgIds.length / slots)) : 0;
    const slot = (this.pollCycleCount - 1) % slots;
    const sliceStart = slot * perSlot;
    const sliceEnd = Math.min(sliceStart + perSlot, bgIds.length);

    logger.debug(
      `[centralPoll] cycle=${this.pollCycleCount} tabs=${this.tabs.size} ` +
        `slot=${slot}/${slots} bgSlice=${sliceStart}..${sliceEnd}/${bgIds.length} ` +
        `active=${activeId} idleStreak=${this.idleTracker.streakCount}`,
    );

    // Poll tabs concurrently so one stuck IPC can't block the rest.
    const polls: Promise<void>[] = [];
    if (activeId) {
      const activeTab = this.tabs.get(activeId);
      if (activeTab) {
        polls.push(activeTab.pollProcessInfo("high").catch((e) => logger.debug("[poll] tab error:", e)));
      }
    }
    for (let i = sliceStart; i < sliceEnd; i++) {
      const tab = this.tabs.get(bgIds[i]);
      if (tab) {
        polls.push(tab.pollProcessInfo("low").catch((e) => logger.debug("[poll] tab error:", e)));
      }
    }
    await Promise.all(polls);

    const snapshot = this.computeTabSnapshot();
    if (snapshot !== this.lastTabSnapshot) {
      this.lastTabSnapshot = snapshot;
      this.renderTabList();
    }

    // Decide whether to drop into idle mode. anyActive here covers the
    // "fg process running but silent" case; PTY-data and user-input wake()
    // handles the active-streaming case independently.
    let anyActive = false;
    for (const tab of this.tabs.values()) {
      for (const pane of tab.getPanes()) {
        if (pane.state.isIdle === false) {
          anyActive = true;
          break;
        }
      }
      if (anyActive) break;
    }
    this.idleTracker.noteTick(anyActive);

    if (this.quitting) return;
    this.scheduleNextPoll(this.idleTracker.intervalFor(fgInterval));
  }

  private computeTabSnapshot(): string {
    return this.tabRenderer.computeTabSnapshot(this.visibleTabs, this.activeTabId);
  }

  private setupResize() {
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = 0;
        if (this.quitting) return;
        if (this.activeTabId) {
          const tab = this.tabs.get(this.activeTabId);
          // Skip resize during tab show/hide transitions — show() already
          // calls forceFit(), and a concurrent fit() from the ResizeObserver
          // creates a double-fit race that can corrupt scroll position (#177).
          if (tab && !tab.transitioning) tab.fit();
        }
      });
      // Settled hook: ~150ms after the last ResizeObserver tick, force-fit
      // every pane in the active tab. The per-frame tab.fit() above honors
      // the per-pane output-activity deferral (#177's scroll-jump guard),
      // which means a pane streaming continuous output would otherwise be
      // left at the old column count once the user stops dragging the
      // window edge. forceFit bypasses the deferral so the settled state
      // always reflects the final window size. (#532)
      if (this.resizeSettledTimer) clearTimeout(this.resizeSettledTimer);
      this.resizeSettledTimer = setTimeout(() => {
        this.resizeSettledTimer = null;
        if (this.quitting) return;
        if (this.activeTabId) {
          const tab = this.tabs.get(this.activeTabId);
          if (tab && !tab.transitioning) tab.forceFit();
        }
      }, 150);
    });
    this.resizeObserver.observe(document.getElementById("terminal-container")!);
  }

  dispose() {
    this.quitting = true;
    // Remove all document-level event listeners registered with AbortController
    this.ac.abort();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    if (this.configWriteTimer) {
      clearTimeout(this.configWriteTimer);
      this.configWriteTimer = null;
    }
    if (this.renderRaf) {
      cancelAnimationFrame(this.renderRaf);
      this.renderRaf = 0;
    }
    if (this.resizeRaf) {
      cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = 0;
    }
    if (this.resizeSettledTimer) {
      clearTimeout(this.resizeSettledTimer);
      this.resizeSettledTimer = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.unlistenFocus?.();
    this.unlistenFocus = null;
    this.unlistenMenu?.();
    this.unlistenMenu = null;
    this.serverTracker.dispose();
    this.notifications.dispose();
    this.tabSwitcher.dispose();
    for (const tab of this.tabs.values()) {
      tab.dispose();
    }
    this.tabs.clear();
    this.tabRenderer.clear();
  }
}
