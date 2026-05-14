import type { Tab } from "./tab";
import type { PaneState, TabState } from "./tab-state";
import { logger } from "./logger";

interface ChildRefs {
  header: HTMLElement;
  title: HTMLElement;
  hint: HTMLElement;
  detail: HTMLElement;
  paneList: HTMLElement;
  claudeDot: HTMLElement;
}

const CLAUDE_DOT_LABEL: Record<string, string> = {
  "context-near-limit": "Context near limit",
  "rate-limit-near": "Rate limit approaching",
  "compaction-imminent": "Auto-compaction imminent",
};

export interface TabRenderActions {
  closeTab(id: string): void;
  switchToTab(id: string): void;
  showTabContextMenu(e: MouseEvent, id: string): void;
  reorderTab(dragId: string, targetId: string, insertBefore: boolean): void;
  renameTab(id: string): void;
  splitTab?(id: string): void;
  killProcess?(id: string): void;
  muteTab?(id: string): void;
  focusPane?(tabId: string, paneIndex: number): void;
}

/** Human-readable label for a single pane row in the sidebar sub-list. */
function paneRowLabel(pane: PaneState): string {
  return pane.gitBranch || pane.folderName || "terminal";
}

/**
 * Manages the sidebar tab list DOM.
 */
export class TabRenderer {
  private tabElements = new Map<string, HTMLElement>();
  private tabChildRefs = new Map<string, ChildRefs>();
  private dragTabId: string | null = null;

  constructor(private actions: TabRenderActions) {}

  /**
   * Render the tab list in the sidebar. Creates new DOM entries for new tabs,
   * updates existing entries, and removes entries for closed tabs.
   */
  renderTabList(
    list: HTMLElement,
    tabs: Map<string, Tab>,
    activeTabId: string | null,
    _groupByState = true,
    _expandActiveTab = false,
  ) {
    // Remove elements for closed tabs
    for (const [id, el] of this.tabElements) {
      if (!tabs.has(id)) {
        logger.debug(`[renderTabList] removing tab DOM id=${id}`);
        el.remove();
        this.tabElements.delete(id);
        this.tabChildRefs.delete(id);
      }
    }

    let index = 0;
    for (const [id, tab] of tabs) {
      this.renderTabEntry(list, id, tab, activeTabId, index, index);
      index++;
    }
  }

  private renderTabEntry(
    list: HTMLElement,
    id: string,
    tab: Tab,
    activeTabId: string | null,
    domIndex: number,
    _tabIndex: number,
  ) {
    let entry = this.tabElements.get(id);

    if (!entry) {
      logger.debug(`[renderTabList] adding tab DOM id=${id} title=${tab.title}`);
      entry = this.createTabEntry(id, list);
    }

    const refs = this.tabChildRefs.get(id)!;

    // Update classes
    let cls = "tab-entry";
    if (id === activeTabId) cls += " active";
    if (tab.state.needsAttention) cls += " needs-attention";
    if (tab.state.notification) cls += ` notif-${tab.state.notification}`;
    if (tab.pinned) cls += " pinned";
    if (tab.muted) cls += " muted";
    entry.className = cls;
    entry.setAttribute("aria-selected", id === activeTabId ? "true" : "false");

    // Title
    refs.title.textContent = tab.title;
    refs.title.className = "tab-title";

    const paneStates = tab.getPaneStates();
    const multiPane = paneStates.length > 1;

    // Detail: branch name (hidden when we're rendering a per-pane sub-list,
    // since the sub-list already shows the branch for every pane).
    const primary = paneStates[0];
    refs.detail.textContent = primary?.gitBranch ?? "";
    refs.detail.className = "tab-detail";
    refs.detail.style.display = !multiPane && primary?.gitBranch ? "" : "none";

    // Per-pane sub-list (#433). Rendered only for tabs with >1 panes so
    // single-pane tabs stay compact. Each row is clickable to focus that
    // pane; a .focused class marks the currently-focused pane.
    this.renderPaneList(refs.paneList, id, tab, paneStates, multiPane);

    refs.hint.textContent = "";
    refs.hint.style.display = "none";

    const attention = tab.state.claudeAttention;
    if (attention) {
      refs.claudeDot.style.display = "";
      refs.claudeDot.className = `tab-claude-dot tab-claude-dot-${attention}`;
      refs.claudeDot.title = CLAUDE_DOT_LABEL[attention] ?? "";
      refs.claudeDot.setAttribute("aria-label", refs.claudeDot.title);
    } else {
      refs.claudeDot.style.display = "none";
      refs.claudeDot.removeAttribute("aria-label");
    }

    // Ensure correct order in DOM
    const refChild = domIndex < list.children.length ? list.children[domIndex] : null;
    if (entry !== refChild) {
      list.insertBefore(entry, refChild);
    }
  }

  private createTabEntry(id: string, list: HTMLElement): HTMLElement {
    const entry = document.createElement("div");
    entry.setAttribute("data-id", id);
    entry.setAttribute("role", "tab");

    // Header row: title + close
    const header = document.createElement("div");
    header.className = "tab-header";

    const title = document.createElement("span");
    title.className = "tab-title";

    const hint = document.createElement("span");
    hint.className = "tab-shortcut";
    hint.style.display = "none";

    const close = document.createElement("button");
    close.className = "btn btn--icon tab-close";
    close.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2L8 8M8 2L2 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.actions.closeTab(id);
    });

    const claudeDot = document.createElement("span");
    claudeDot.className = "tab-claude-dot";
    claudeDot.style.display = "none";

    header.appendChild(title);
    header.appendChild(claudeDot);
    header.appendChild(hint);
    header.appendChild(close);

    // Detail line — branch name
    const detail = document.createElement("div");
    detail.className = "tab-detail";
    detail.style.display = "none";

    // Per-pane sub-list — one row per pane for multi-pane tabs (#433)
    const paneList = document.createElement("div");
    paneList.className = "tab-pane-list";
    paneList.style.display = "none";

    entry.appendChild(header);
    entry.appendChild(detail);
    entry.appendChild(paneList);

    entry.addEventListener("click", () => this.actions.switchToTab(id));
    title.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.actions.renameTab(id);
    });
    entry.addEventListener("contextmenu", (e) => {
      this.actions.showTabContextMenu(e as MouseEvent, id);
    });

    // Drag-and-drop reordering
    entry.setAttribute("draggable", "true");
    entry.addEventListener("dragstart", (e) => {
      this.dragTabId = id;
      entry.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
      }
    });
    entry.addEventListener("dragend", () => {
      this.dragTabId = null;
      entry.classList.remove("dragging");
      list.querySelectorAll(".tab-entry").forEach((node) => {
        node.classList.remove("drag-over-above", "drag-over-below");
      });
    });
    entry.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!this.dragTabId || this.dragTabId === id) return;
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = entry.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      entry.classList.toggle("drag-over-above", e.clientY < midY);
      entry.classList.toggle("drag-over-below", e.clientY >= midY);
    });
    entry.addEventListener("dragleave", () => {
      entry.classList.remove("drag-over-above", "drag-over-below");
    });
    entry.addEventListener("drop", (e) => {
      e.preventDefault();
      entry.classList.remove("drag-over-above", "drag-over-below");
      if (!this.dragTabId || this.dragTabId === id) return;
      const rect = entry.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const insertBefore = e.clientY < midY;
      this.actions.reorderTab(this.dragTabId, id, insertBefore);
    });

    this.tabElements.set(id, entry);
    this.tabChildRefs.set(id, { header, title, hint, detail, paneList, claudeDot });
    list.appendChild(entry);

    return entry;
  }

  /** Render the per-pane sub-list for a multi-pane tab. Rebuilds rows in-place,
   *  reusing existing DOM nodes so click listeners survive. (#433) */
  private renderPaneList(
    paneList: HTMLElement,
    tabId: string,
    tab: Tab,
    paneStates: PaneState[],
    visible: boolean,
  ) {
    if (!visible) {
      paneList.style.display = "none";
      paneList.replaceChildren();
      return;
    }
    paneList.style.display = "";

    const focused = tab.getFocusedPane();
    const panes = tab.getPanes();

    // Grow or shrink the row set to match pane count, reusing existing rows.
    while (paneList.children.length > paneStates.length) {
      paneList.lastElementChild?.remove();
    }
    while (paneList.children.length < paneStates.length) {
      const row = document.createElement("div");
      row.className = "tab-pane-line";
      const idx = paneList.children.length;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        this.actions.focusPane?.(tabId, idx);
      });
      paneList.appendChild(row);
    }

    for (let i = 0; i < paneStates.length; i++) {
      const row = paneList.children[i] as HTMLElement;
      row.textContent = paneRowLabel(paneStates[i]);
      row.classList.toggle("focused", panes[i] === focused);
      row.setAttribute("data-pane-index", String(i));
    }
  }

  /** Status bar removed — replaced by per-pane footers (#348). */
  updateStatusBar(_state: TabState | null) {}

  /** Build a snapshot string for change detection. */
  computeTabSnapshot(tabs: Map<string, Tab>, activeTabId: string | null): string {
    const parts: string[] = [];
    for (const [id, tab] of tabs) {
      const s = tab.state;
      const gs = s.gitStatus;
      const gitSnap = gs
        ? `${gs.modified}:${gs.staged}:${gs.untracked}:${gs.ahead}:${gs.behind}:${gs.is_worktree}`
        : "";
      // Include per-pane labels so the sub-list refreshes when panes are
      // split, closed, or their branch/folder changes. Focused-pane index is
      // part of the snapshot so the .focused highlight tracks focus changes
      // without forcing a full re-render from the caller. (#433)
      const panes = tab.getPaneStates();
      const focusedIdx = tab.getPanes().indexOf(tab.getFocusedPane());
      const paneSnap = panes.length > 1 ? `${focusedIdx}:${panes.map((p) => paneRowLabel(p)).join(",")}` : "";
      parts.push(
        `${id}|${tab.title}|${s.needsAttention}|${s.serverPort}|${s.lastError}|${s.gitBranch}|${gitSnap}|${s.folderName}|${s.notification}|${tab.pinned}|${tab.muted}|${paneSnap}|${s.claudeAttention ?? ""}`,
      );
    }
    parts.push(`active:${activeTabId}`);
    return parts.join(";");
  }

  /** Clean up all cached elements. */
  clear() {
    this.tabElements.clear();
    this.tabChildRefs.clear();
  }
}
