import type { Config } from "./config";
import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout, getLiveCwd } from "./utils";
import { pollSemaphore, type PollPriority } from "./poll-throttle";
import {
  type TabState,
  type PaneState,
  type GitStatusInfo,
  createDefaultTabState,
  computeFolderTitle,
  parseStatusLine,
  deriveClaudeAttention,
  type StatusLineData,
} from "./tab-state";
import type { OutputEvent } from "./matchers";
import type { SessionSplitNode, SessionSplitLeaf } from "./session";
import { handleOutputEvent as processOutputEvent } from "./tab-output";
import { logger } from "./logger";
import { showToast } from "./toast";
import { perfMetrics } from "./perf";
import { Pane, type KeyHandler } from "./pane";

/** Result from the batched poll_pane_info Rust command. */
interface PanePollResult {
  cwd_folder: string;
  cwd_full: string;
  git: GitStatusInfo | null;
  project_name: string | null;
  claude_status: string | null;
}

export type SplitDirection = "horizontal" | "vertical";

interface SplitBranch {
  type: "split";
  direction: SplitDirection;
  children: [SplitNode, SplitNode];
  /** 0..1 ratio of first child's size */
  ratio: number;
  element: HTMLDivElement;
}

interface SplitLeaf {
  type: "leaf";
  pane: Pane;
}

type SplitNode = SplitBranch | SplitLeaf;

export class Tab {
  readonly id: string;
  title: string;
  readonly element: HTMLDivElement;
  private config: Config;
  private isVisible = false;
  manualTitle: string | null = null;
  pinned = false;
  muted = false;
  /** If this tab is in a git worktree, the worktree directory path */
  worktreePath: string | null = null;
  /** The repo root this worktree belongs to */
  repoRoot: string | null = null;
  state: TabState = createDefaultTabState();
  private pollFailures = 0;
  private pollStopped = false;
  private pollStoppedAt = 0;
  private keyHandler?: KeyHandler;
  /** The cwd this tab was constructed with (from session restore or user
   *  intent). Distinct from `pane.lastFullCwd` which is populated by the
   *  polling loop after the PTY's process tree resolves. Exposed read-only
   *  so callers can use it as a synchronous fallback before polling has
   *  populated lastFullCwd. */
  readonly initialCwd: string | undefined;

  /** The tree of split panes */
  private root: SplitNode;
  /** The currently focused pane */
  private focusedPane: Pane;
  /** All panes in this tab (flat list for easy iteration) */
  private panes: Pane[] = [];
  /** AbortControllers for document-level drag listeners, keyed by branch */
  private dividerCleanups = new Map<SplitBranch, AbortController>();
  /** Pending rAF ID from show() — cancelled on hide() to prevent stale focus */
  private showRafId: number | null = null;
  /** True during show/hide transition — used to suppress ResizeObserver fits */
  transitioning = false;
  /** Timestamp of last show() call — used to suppress spurious notifications
   *  from poll cycles that fire during the show() rAF pipeline (#278) */
  private lastShownAt = 0;
  /** When true, config was updated while this tab was hidden — apply on next show() */
  private configStale = false;

  onExit: (() => void) | null = null;
  onTitleChange: ((title: string) => void) | null = null;
  onNeedsAttention: (() => void) | null = null;
  /** Fires on every OSC 9;2 attention request from a pane, with the raw
   *  message text. Forwarded to NotificationManager so the user sees a
   *  system notification carrying the agent's message (#517). */
  onOscNotification: ((text: string) => void) | null = null;
  onOutputEvent: ((event: OutputEvent) => void) | null = null;
  /** Fires on PTY activity for any pane in this tab — forwarded to the
   *  central poll loop's wake() so adaptive idle mode can break out
   *  immediately. Expected to be cheap when no wake-up is needed. (#456) */
  onActivity: (() => void) | null = null;
  /** Fires on any status change that needs a sidebar re-render. */
  onStateChange: (() => void) | null = null;
  /** Called when a pane is closed, with worktree info for cleanup */
  onPaneClose: ((pane: Pane) => void) | null = null;

  // Expose for process polling — returns the focused pane's PTY pid
  get ptyPid(): number | null {
    return this.focusedPane.ptyPid;
  }

  get lastFullCwd(): string | null {
    return this.focusedPane.lastFullCwd;
  }

  constructor(id: string, title: string, config: Config, keyHandler?: KeyHandler, cwd?: string) {
    this.id = id;
    this.title = title;
    this.config = config;
    this.keyHandler = keyHandler;
    this.initialCwd = cwd;

    this.element = document.createElement("div");
    this.element.className = "terminal-wrapper";

    const pane = this.createPane(cwd);
    this.root = { type: "leaf", pane };
    this.focusedPane = pane;
  }

  private createPane(cwd?: string): Pane {
    const pane = new Pane(this.config, this.keyHandler, cwd);

    pane.onFocus = () => {
      this.focusedPane = pane;
      this.updateFocusedClass(pane);
    };

    pane.onExit = (exitCode: number) => {
      if (exitCode !== 0) {
        this.state.lastError = `Exit code ${exitCode}`;
        this.updateTitle();
      }
      if (this.panes.length === 1) {
        // Last pane — close the tab
        this.onExit?.();
      } else {
        this.closePane(pane);
      }
    };

    pane.onOutputEvent = (event: OutputEvent) => {
      this.handleOutputEvent(event);
    };

    pane.onActivity = () => {
      this.onActivity?.();
    };

    pane.onTerminalTitle = () => {
      // Title change is activity — let the next central poll pick it up
      // rather than dispatching a per-prompt-redraw IPC. (#461)
      pane.idleConsecutive = 0;
    };

    // OSC 9;2 notification — agent explicitly requesting attention
    pane.onOscNotification = (oscEvent) => {
      this.handleOscNotification(pane, oscEvent.text);
    };

    this.panes.push(pane);
    return pane;
  }

  private handleOutputEvent(event: OutputEvent) {
    processOutputEvent(event, {
      tabId: this.id,
      tabState: this.state,
      isVisible: this.isVisible,
      muted: this.muted,
      recentlyShown: Date.now() - this.lastShownAt < 3000 || this.transitioning,
      updateTitle: () => this.updateTitle(),
      onNeedsAttention: () => this.onNeedsAttention?.(),
    });
    this.onOutputEvent?.(event);
  }

  /** Handle OSC 9;2 notification — the agent explicitly wants attention.
   *  Two surfaces fire here: the sidebar attention dot (for background tabs)
   *  and a system notification carrying the message text (#517). */
  private handleOscNotification(_pane: Pane, text: string) {
    const showGrace = Date.now() - this.lastShownAt < 3000;
    if (!this.isVisible && !this.transitioning && !this.muted && !showGrace) {
      this.state.needsAttention = true;
      this.onNeedsAttention?.();
    }
    // Forward the payload to whoever subscribed (NotificationManager). The
    // subscriber decides whether to fire a system notification based on the
    // user's config and the active-tab/document-hidden state.
    this.onOscNotification?.(text);
  }

  private updateTitle() {
    if (!this.manualTitle) {
      const displayTitle = computeFolderTitle(this.state);
      if (displayTitle !== this.title) {
        logger.debug(`[updateTitle] tab=${this.id} "${this.title}" -> "${displayTitle}"`);
        this.title = displayTitle;
        this.onTitleChange?.(displayTitle);
      }
    }
  }

  async start(): Promise<boolean> {
    const container = document.getElementById("terminal-container")!;
    container.appendChild(this.element);

    // Mount the root pane
    this.element.appendChild(this.focusedPane.element);
    const ok = await this.focusedPane.start();
    this.focusedPane.element.classList.add("pane-focused");
    return ok;
  }

  /** Get the currently focused pane */
  getFocusedPane(): Pane {
    return this.focusedPane;
  }

  get paneCount(): number {
    return this.panes.length;
  }

  /** Split the focused pane with a specific CWD (used for split-to-branch) */
  async splitWithCwd(direction: SplitDirection, cwd: string): Promise<void> {
    await this.splitInternal(direction, cwd);
  }

  /** Split the focused pane in the given direction */
  async split(direction: SplitDirection) {
    const paneToSplit = this.focusedPane;

    let cwd: string | undefined = paneToSplit.lastFullCwd ?? this.initialCwd;
    if (paneToSplit.ptyPid) {
      const live = await getLiveCwd(paneToSplit.ptyPid, this.config.advanced.ipcTimeoutMs);
      if (live) cwd = live;
    }

    await this.splitInternal(direction, cwd);
  }

  /** Internal split implementation — creates a new pane in the given CWD */
  private async splitInternal(direction: SplitDirection, cwd: string | undefined) {
    if (this.panes.length >= this.config.maxPanes) {
      showToast(`Pane limit reached (${this.config.maxPanes})`, "warn");
      return;
    }
    const paneToSplit = this.focusedPane;
    const newPane = this.createPane(cwd);

    // Find the leaf node for the focused pane and replace it with a split
    const splitContainer = document.createElement("div");
    splitContainer.className = `split-container split-${direction}`;

    const divider = document.createElement("div");
    divider.className = `split-divider split-divider-${direction}`;

    const newBranch: SplitBranch = {
      type: "split",
      direction,
      children: [
        { type: "leaf", pane: paneToSplit },
        { type: "leaf", pane: newPane },
      ],
      ratio: 0.5,
      element: splitContainer,
    };

    // Replace the old leaf in the tree — swaps the pane's DOM element
    // with the split container. The pane element is briefly detached.
    this.replaceNode(paneToSplit, newBranch);

    // Build the DOM — re-add old pane + divider + new pane into the container
    splitContainer.appendChild(paneToSplit.element);
    splitContainer.appendChild(divider);
    splitContainer.appendChild(newPane.element);

    // Apply sizes
    this.applySplitSizes(newBranch);

    // Start the new pane's PTY before setting up drag listeners to avoid
    // leaking document-level listeners if the spawn fails (#430).
    const ok = await newPane.start();

    if (!ok) {
      // PTY spawn failed — revert the split
      logger.warn("Split failed: PTY spawn failed for new pane");
      this.panes = this.panes.filter((p) => p !== newPane);
      newPane.dispose();

      // Revert tree: replace the branch with just the original pane
      this.replaceNode(newBranch, { type: "leaf", pane: paneToSplit });
      splitContainer.remove();

      // Clear stale inline sizes on the surviving pane
      paneToSplit.element.style.width = "";
      paneToSplit.element.style.height = "";

      // Reset focusedPane back to the original pane so it doesn't reference
      // the disposed newPane (fixes #140)
      this.focusedPane = paneToSplit;
      this.updateFocusedClass(paneToSplit);

      showToast("Failed to start terminal in split pane", "error");
      requestAnimationFrame(() => this.fitAllPanes());
      return;
    }

    // Setup divider drag — only after successful PTY start (#430)
    this.setupDividerDrag(divider, newBranch);

    // Focus the new pane (only if tab is still visible — user may have switched away)
    this.focusedPane = newPane;
    this.updateFocusedClass(newPane);
    if (this.isVisible) newPane.focus();

    logger.debug(`[split] tab=${this.id} panesAfter=${this.panes.length} newPane=${newPane.id}`);

    // Refit all panes after layout change — use double-rAF so the browser
    // has fully resolved the split container's flexbox layout before
    // FitAddon measures .pane-terminal heights.  forceFitAllPanes bypasses
    // the 300ms output-activity deferral that would otherwise skip panes
    // with recent output (the existing pane likely has active output). (#402)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.forceFitAllPanes());
    });
  }

  /** Close a specific pane */
  private closePane(paneToClose: Pane) {
    logger.debug(`[closePane] tab=${this.id} pane=${paneToClose.id} panesBefore=${this.panes.length}`);
    // Find the parent split containing this pane
    const parentInfo = this.findParent(this.root, paneToClose);
    if (!parentInfo) return;

    const { parent, siblingNode } = parentInfo;

    // Notify listener before disposing (for worktree cleanup)
    this.onPaneClose?.(paneToClose);

    // Remove the pane from panes list
    this.panes = this.panes.filter((p) => p !== paneToClose);
    paneToClose.dispose();

    // Replace the parent split with the surviving sibling
    this.replaceNode(parent, siblingNode);

    // Clear stale inline sizes on the surviving element — revert to CSS flex: 1
    const survivingEl = siblingNode.type === "leaf" ? siblingNode.pane.element : siblingNode.element;
    survivingEl.style.flex = "";
    survivingEl.style.width = "";
    survivingEl.style.height = "";

    // If the closed pane was focused, focus the surviving pane
    if (this.focusedPane === paneToClose) {
      const nextFocus = this.getFirstPane(siblingNode);
      this.focusedPane = nextFocus;
      this.updateFocusedClass(nextFocus);
      nextFocus.focus();
    }

    // Clean up the split container element and its document-level drag listeners
    parent.element.remove();
    const ac = this.dividerCleanups.get(parent);
    if (ac) {
      ac.abort();
      this.dividerCleanups.delete(parent);
    }

    logger.debug(`[closePane] tab=${this.id} panesAfter=${this.panes.length}`);
    requestAnimationFrame(() => this.forceFitAllPanes());
  }

  /** Close the currently focused pane (or close tab if last) */
  closeFocusedPane() {
    if (this.panes.length <= 1) return false; // caller should close the tab
    this.closePane(this.focusedPane);
    return true;
  }

  /** Cycle focus to the next pane */
  focusNextPane() {
    if (this.panes.length <= 1) return;
    const idx = this.panes.indexOf(this.focusedPane);
    const next = this.panes[(idx + 1) % this.panes.length];
    this.setFocusedPane(next);
  }

  /** Cycle focus to the previous pane */
  focusPrevPane() {
    if (this.panes.length <= 1) return;
    const idx = this.panes.indexOf(this.focusedPane);
    const prev = this.panes[(idx - 1 + this.panes.length) % this.panes.length];
    this.setFocusedPane(prev);
  }

  /** Jump to pane by 0-based index */
  focusPaneByIndex(index: number) {
    if (index < 0 || index >= this.panes.length) return;
    this.setFocusedPane(this.panes[index]);
  }

  /** Update DOM classes so only the given pane has the focused outline */
  private updateFocusedClass(pane: Pane) {
    for (const p of this.panes) {
      p.element.classList.toggle("pane-focused", p === pane);
    }
  }

  private setFocusedPane(pane: Pane) {
    this.focusedPane = pane;
    this.updateFocusedClass(pane);
    pane.focus();
    this.showPaneNumberOverlay(pane);
  }

  /** @deprecated Pane number overlay removed to reduce visual noise (#333) */
  private showPaneNumberOverlay(_pane: Pane) {}

  /** Resize the focused pane in a direction by adjusting the parent split ratio */
  resizeFocusedPane(direction: "left" | "right" | "up" | "down", step = 0.05) {
    const parentInfo = this.findPaneBranch(this.root, this.focusedPane);
    if (!parentInfo) return;
    const { branch, childIndex } = parentInfo;

    // Only resize along the branch's split direction
    let delta: number;
    if (branch.direction === "horizontal" && (direction === "left" || direction === "right")) {
      delta = direction === "right" ? step : -step;
    } else if (branch.direction === "vertical" && (direction === "up" || direction === "down")) {
      delta = direction === "down" ? step : -step;
    } else {
      return; // Direction doesn't match split axis
    }

    // If focused pane is the second child, invert the delta
    if (childIndex === 1) delta = -delta;

    branch.ratio = Math.min(0.85, Math.max(0.15, branch.ratio + delta));
    this.applySplitSizes(branch);
    this.fitAllPanes();
  }

  /** Find the parent branch of a pane and which child index it's in */
  private findPaneBranch(node: SplitNode, pane: Pane): { branch: SplitBranch; childIndex: number } | null {
    if (node.type !== "split") return null;
    for (let i = 0; i < 2; i++) {
      const child = node.children[i];
      if (child.type === "leaf" && child.pane === pane) {
        return { branch: node, childIndex: i };
      }
      const result = this.findPaneBranch(child, pane);
      if (result) return result;
    }
    return null;
  }

  /** Reset all splits to equal ratios */
  balanceSplits() {
    this.balanceNode(this.root);
    this.fitAllPanes();
  }

  private balanceNode(node: SplitNode) {
    if (node.type !== "split") return;
    node.ratio = 0.5;
    this.applySplitSizes(node);
    this.balanceNode(node.children[0]);
    this.balanceNode(node.children[1]);
  }

  private replaceNode(target: SplitNode | Pane, replacement: SplitNode) {
    if (
      this.root === target ||
      (target instanceof Pane && this.root.type === "leaf" && this.root.pane === target)
    ) {
      this.root = replacement;
      // Mount replacement at the tab element level
      if (replacement.type === "split") {
        // The element replaces the pane's element in the DOM
        const parent =
          target instanceof Pane
            ? target.element.parentElement
            : (target as SplitBranch).element.parentElement;
        if (parent) {
          const oldEl = target instanceof Pane ? target.element : (target as SplitBranch).element;
          parent.replaceChild(replacement.element, oldEl);
        } else {
          this.element.appendChild(replacement.element);
        }
      } else {
        // Leaf replacement — put pane element in tab
        const pane = replacement.pane;
        const oldEl = target instanceof Pane ? target.element : (target as SplitBranch).element;
        const parent = oldEl.parentElement;
        if (parent) {
          parent.replaceChild(pane.element, oldEl);
        } else {
          this.element.appendChild(pane.element);
        }
      }
      return;
    }

    // Search the tree for the target
    this.replaceInTree(this.root, target, replacement);
  }

  private replaceInTree(node: SplitNode, target: SplitNode | Pane, replacement: SplitNode): boolean {
    if (node.type !== "split") return false;

    for (let i = 0; i < 2; i++) {
      const child = node.children[i];
      const isMatch =
        child === target || (target instanceof Pane && child.type === "leaf" && child.pane === target);

      if (isMatch) {
        node.children[i] = replacement;

        // Update DOM — replace old element with new
        if (replacement.type === "split") {
          const oldEl = child.type === "leaf" ? child.pane.element : child.element;
          node.element.replaceChild(replacement.element, oldEl);
        } else {
          const oldEl = child.type === "leaf" ? child.pane.element : child.element;
          node.element.replaceChild(replacement.pane.element, oldEl);
        }
        return true;
      }

      if (this.replaceInTree(child, target, replacement)) return true;
    }
    return false;
  }

  private findParent(node: SplitNode, pane: Pane): { parent: SplitBranch; siblingNode: SplitNode } | null {
    if (node.type !== "split") return null;

    for (let i = 0; i < 2; i++) {
      const child = node.children[i];
      if (child.type === "leaf" && child.pane === pane) {
        const siblingIdx = i === 0 ? 1 : 0;
        return { parent: node as SplitBranch, siblingNode: node.children[siblingIdx] };
      }
      const result = this.findParent(child, pane);
      if (result) return result;
    }
    return null;
  }

  private getFirstPane(node: SplitNode): Pane {
    if (node.type === "leaf") return node.pane;
    return this.getFirstPane(node.children[0]);
  }

  private applySplitSizes(branch: SplitBranch) {
    const first = branch.children[0];
    const second = branch.children[1];
    const firstEl = first.type === "leaf" ? first.pane.element : first.element;
    const secondEl = second.type === "leaf" ? second.pane.element : second.element;

    const pct = branch.ratio * 100;
    // Subtract half the divider width from each side so the panes fit
    // inside the container. Must match CSS --split-divider-width, which is
    // var(--space-3) = 8px after the 4pt-grid normalization (#493).
    const dividerPx = 8;
    const half = dividerPx / 2;
    // Use flex shorthand to override the CSS `flex: 1` on .pane / .split-container.
    // Setting width/height alone has no effect because flex-basis: 0% (from flex: 1)
    // takes priority over width/height in the flex algorithm.
    // `flex: 0 0 <basis>` = no grow, no shrink, explicit basis.
    firstEl.style.flex = `0 0 calc(${pct}% - ${half}px)`;
    secondEl.style.flex = `0 0 calc(${100 - pct}% - ${half}px)`;
  }

  private setupDividerDrag(divider: HTMLElement, branch: SplitBranch) {
    let dragging = false;
    let rafId = 0;
    /** Leaf panes under the dragged branch — only these change size during
     *  drag, so per-frame fit() can skip the rest of the tab's panes. (#464) */
    const affectedPanes: Pane[] = [];

    // Double-click to auto-balance (50/50)
    divider.addEventListener("dblclick", (e) => {
      e.preventDefault();
      branch.ratio = 0.5;
      this.applySplitSizes(branch);
      this.forceFitAllPanes();
    });

    const startDrag = (e: Event) => {
      e.preventDefault();
      dragging = true;
      affectedPanes.length = 0;
      this.collectPanes(branch, affectedPanes);
      document.body.style.cursor = branch.direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.classList.add("no-select");
      // Disable pointer events on all panes during drag so the xterm canvas
      // doesn't intercept mousemove events or start text selection
      for (const pane of this.panes) {
        pane.element.classList.add("pointer-none");
      }
    };

    divider.addEventListener("mousedown", startDrag);
    divider.addEventListener("touchstart", startDrag, { passive: false });

    const positionFromEvent = (e: MouseEvent | TouchEvent): { x: number; y: number } | null => {
      if ("touches" in e) {
        const t = e.touches[0];
        return t ? { x: t.clientX, y: t.clientY } : null;
      }
      return { x: e.clientX, y: e.clientY };
    };

    const onMove = (e: MouseEvent | TouchEvent) => {
      if (!dragging) return;
      const pos = positionFromEvent(e);
      if (!pos) return;
      const rect = branch.element.getBoundingClientRect();
      // Guard against zero-dimension containers (window minimized, etc.)
      if (rect.width === 0 || rect.height === 0) return;
      let ratio: number;
      if (branch.direction === "horizontal") {
        ratio = (pos.x - rect.left) / rect.width;
      } else {
        ratio = (pos.y - rect.top) / rect.height;
      }
      branch.ratio = Math.min(0.85, Math.max(0.15, ratio));
      // Apply CSS + refit terminals synchronously so both panes resize
      // together with the divider.  Using forceFit() bypasses the output-
      // activity deferral — during drag, immediate feedback matters more.
      // Previous approach deferred fit to rAF, causing one pane's content
      // to lag behind the CSS layout change and appear "stuck" (#183).
      this.applySplitSizes(branch);
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          // Only refit panes whose size actually changed — the rest of the
          // tab's panes are unaffected by this divider drag. (#464)
          for (const pane of affectedPanes) pane.forceFit();
        });
      }
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      document.body.style.cursor = "";
      document.body.classList.remove("no-select");
      // Restore pointer events on all panes
      for (const pane of this.panes) {
        pane.element.classList.remove("pointer-none");
      }
      // Final fit after drag completes — force-fit to ensure both panes
      // have correct dimensions regardless of output activity.
      this.forceFitAllPanes();
    };

    // Use an AbortController so all document-level listeners are cleaned up
    // atomically — even if manual cleanup is missed, aborting the signal
    // guarantees removal.
    const ac = new AbortController();
    document.addEventListener("mousemove", onMove as EventListener, { signal: ac.signal });
    document.addEventListener("mouseup", onUp, { signal: ac.signal });
    document.addEventListener("touchmove", onMove as EventListener, {
      signal: ac.signal,
      passive: false,
    });
    document.addEventListener("touchend", onUp, { signal: ac.signal });

    // Track for cleanup — keyed by branch so we can remove on pane close
    this.dividerCleanups.set(branch, ac);
  }

  private fitAllPanes() {
    for (const pane of this.panes) {
      pane.fit();
    }
  }

  /** Force-fit all panes immediately, bypassing the output-activity deferral.
   *  Used at end-of-drag and other user-initiated resizes where immediate
   *  visual feedback is more important than avoiding write/fit races. */
  private forceFitAllPanes() {
    for (const pane of this.panes) {
      pane.forceFit();
    }
  }

  /** Walk a split subtree and append every leaf pane to `out`. (#464) */
  private collectPanes(node: SplitNode, out: Pane[]): Pane[] {
    if (node.type === "leaf") {
      out.push(node.pane);
    } else {
      this.collectPanes(node.children[0], out);
      this.collectPanes(node.children[1], out);
    }
    return out;
  }

  /** Get per-pane states for rendering in the sidebar */
  getPaneStates(): PaneState[] {
    return this.panes.map((p) => p.state);
  }

  /** Get all panes (for worktree cleanup on tab close, etc.) */
  getPanes(): readonly Pane[] {
    return this.panes;
  }

  /** Poll process info for ALL panes. Called by TerminalManager.
   *  Active-tab callers pass priority="high" so their IPC slots jump
   *  ahead of any background-slice work. (#459) */
  async pollProcessInfo(priority: PollPriority = "low") {
    if (this.pollStopped) {
      // Resume polling if: (a) any pane produced output since we stopped, OR
      // (b) enough time has passed (30s) to retry in case the process is idle
      // but alive (e.g., shell waiting for input produces no output).
      const hasRecentOutput = this.panes.some(
        (p) => !p.getProcessInfo().disposed && p.lastOutputAt > this.pollStoppedAt,
      );
      const retryElapsed = Date.now() - this.pollStoppedAt > 30_000;
      if (hasRecentOutput || retryElapsed) {
        this.pollStopped = false;
        this.pollFailures = 0;
        logger.debug(`[pollProcessInfo] tab=${this.id} resuming poll — pane output detected`);
      } else {
        return;
      }
    }

    // Poll all panes concurrently — but throttle through pollSemaphore so we
    // don't slam the Tauri command pool when N panes × M tabs all dispatch
    // poll_pane_info on the same cycle. (#459)
    const pollable = this.panes.filter((p) => !p.getProcessInfo().disposed && p.getProcessInfo().pid);
    logger.debug(`[pollProcessInfo] tab=${this.id} panes=${this.panes.length} pollable=${pollable.length}`);
    const polls = pollable.map((pane) =>
      pollSemaphore
        .withSlot(priority, () => this.pollPane(pane))
        .catch((e) => logger.debug("[pollPane] error:", e)),
    );

    await Promise.all(polls);

    // Derive tab-level state from all pane states
    this.deriveTabState();
    this.updateTitle();
  }

  /** Poll a single pane's CWD, git, and project info. */
  private async pollPane(pane: Pane) {
    const pollStart = performance.now();
    const { pid, disposed } = pane.getProcessInfo();
    if (disposed || !pid) return;
    const shellPid = pid;
    const ps = pane.state;

    const timeout = this.config.advanced.ipcTimeoutMs;

    try {
      // Check if shell is idle (no foreground process) for throttling
      const fgPgid =
        pane.ptyHandle != null
          ? await invoke<number>("plugin:pty|foreground_pid", { pid: pane.ptyHandle }).catch(() => shellPid)
          : shellPid;

      const newIsIdle = fgPgid === shellPid;
      ps.isIdle = newIsIdle;

      if (newIsIdle) {
        pane.idleConsecutive++;
      } else {
        pane.idleConsecutive = 0;
      }

      const skipExpensive = newIsIdle && pane.idleConsecutive > 5;

      // Single batched IPC call for CWD + git + project + Claude status
      const result = await invokeWithTimeout<PanePollResult>(
        "poll_pane_info",
        {
          shellPid,
          fgPid: fgPgid !== shellPid ? fgPgid : null,
          lastCwd: pane.lastFullCwd || null,
          skipExpensive,
        },
        timeout,
      );

      // Skip re-parsing identical payloads — Claude only writes after each
      // assistant turn, so most polls see the same JSON.
      if (result.claude_status !== pane.lastClaudeStatusJson) {
        pane.lastClaudeStatusJson = result.claude_status;
        ps.statusLine = result.claude_status ? parseStatusLine(result.claude_status) : null;
      }

      const fullCwd = result.cwd_full || null;
      ps.folderName = result.cwd_folder || ps.folderName;

      // Apply CWD change + project name from batched result
      if (fullCwd && fullCwd !== pane.lastFullCwd) {
        pane.lastFullCwd = fullCwd;
        if (pane === this.focusedPane) {
          this.state.projectName = result.project_name || null;
        }
      }

      // Apply git status from batched result
      if (result.git) {
        const prevBranch = ps.gitBranch;
        const branch = result.git.branch || null;
        ps.gitBranch = branch;
        ps.gitStatus = result.git;

        // Detect unexpected branch change in a shared directory
        if (
          prevBranch &&
          branch &&
          prevBranch !== branch &&
          !pane.worktreePath &&
          pane === this.focusedPane
        ) {
          const siblingsAffected = this.panes.filter(
            (p) => p !== pane && !p.worktreePath && p.lastFullCwd === fullCwd,
          );
          if (siblingsAffected.length > 0) {
            showToast(
              `Branch changed to "${branch}" — ${siblingsAffected.length} other pane${siblingsAffected.length > 1 ? "s" : ""} in the same directory affected. Use Split (⌘D) for isolated worktrees.`,
              "warn",
              6000,
            );
          }
        }
        pane.updateBranchBadge();
      } else if (!skipExpensive && fullCwd) {
        // Git status returned null — fallback to simple branch detection
        try {
          const gitBranch = await invokeWithTimeout<string>("get_git_branch", { dir: fullCwd }, timeout);
          ps.gitBranch = gitBranch || null;
          ps.gitStatus = null;
        } catch (e) {
          logger.debug("Failed to get git branch:", e);
        }
        pane.updateBranchBadge();
      }

      this.pollFailures = 0;
      pane.updateFooter();
      perfMetrics.record("pollPane", performance.now() - pollStart);
    } catch (e) {
      this.pollFailures++;
      perfMetrics.record("pollPane", performance.now() - pollStart);
      logger.debug("Poll failed (process may have exited):", e);
      if (this.pollFailures === 5) {
        showToast("Process info unavailable — some tab features may not work", "warn");
      }
      if (this.pollFailures >= 20) {
        this.pollStopped = true;
        this.pollStoppedAt = Date.now();
        logger.warn(`Stopped polling tab ${this.id} after ${this.pollFailures} consecutive failures`);
      }
    }
  }

  /** Derive tab-level state from focused pane */
  private deriveTabState() {
    const fps = this.focusedPane.state;
    this.state.folderName = fps.folderName;
    this.state.isIdle = fps.isIdle;
    this.state.serverPort = fps.serverPort;
    this.state.lastError = fps.lastError;
    this.state.gitBranch = fps.gitBranch;
    this.state.gitStatus = fps.gitStatus;

    const statusLines: StatusLineData[] = [];
    for (const p of this.panes) if (p.state.statusLine) statusLines.push(p.state.statusLine);
    this.state.claudeAttention = deriveClaudeAttention(statusLines);

    logger.debug(`[deriveTabState] tab=${this.id} folder=${this.state.folderName}`);
  }

  toggleSearch() {
    this.focusedPane.toggleSearch();
  }

  writeToPty(data: string) {
    this.focusedPane.writeToPty(data);
  }

  /** Write directly to the focused pane's terminal display (not the PTY). */
  writeToTerminal(data: string) {
    this.focusedPane.writeToDisplay(data);
  }

  /** Send Ctrl-C to the focused pane's process. */
  sendInterrupt() {
    this.focusedPane.sendInterrupt();
  }

  /** Kill the focused pane's PTY and restart a fresh shell in the same CWD. */
  async restartShell() {
    const pane = this.focusedPane;
    const cwd = pane.lastFullCwd ?? this.initialCwd;

    // Dispose old pane
    const idx = this.panes.indexOf(pane);
    pane.dispose();

    // Preserve worktree metadata from the old pane
    const oldWorktreePath = pane.worktreePath;
    const oldRepoRoot = pane.repoRoot;

    // Create replacement pane in the same CWD
    const newPane = this.createPane(cwd);
    newPane.worktreePath = oldWorktreePath;
    newPane.repoRoot = oldRepoRoot;

    // Replace in the tree
    if (this.root.type === "leaf" && this.root.pane === pane) {
      this.root = { type: "leaf", pane: newPane };
      this.element.appendChild(newPane.element);
    } else {
      this.replaceLeafPane(this.root, pane, newPane);
    }

    // Remove old pane from list (createPane already added newPane)
    this.panes = this.panes.filter((p) => p !== pane);

    await newPane.start();
    this.focusedPane = newPane;
    this.updateFocusedClass(newPane);
    newPane.focus();

    // Reset tab state
    this.state.lastError = null;
    this.state.isIdle = true;
    this.pollFailures = 0;
    this.pollStopped = false;
    this.updateTitle();

    // Hack: the old pane was already at `idx` in the list; newPane got appended.
    // Reorder so newPane is at the same position.
    if (idx >= 0 && idx < this.panes.length - 1) {
      this.panes.splice(this.panes.indexOf(newPane), 1);
      this.panes.splice(idx, 0, newPane);
    }
  }

  /** Replace a leaf pane reference in the split tree. */
  private replaceLeafPane(node: SplitNode, oldPane: Pane, newPane: Pane): boolean {
    if (node.type !== "split") return false;
    for (let i = 0; i < 2; i++) {
      const child = node.children[i];
      if (child.type === "leaf" && child.pane === oldPane) {
        node.children[i] = { type: "leaf", pane: newPane };
        node.element.replaceChild(newPane.element, oldPane.element);
        return true;
      }
      if (this.replaceLeafPane(child, oldPane, newPane)) return true;
    }
    return false;
  }

  applyConfig(config: Config) {
    this.config = config;
    if (!this.isVisible) {
      // Defer pane updates until this tab is shown — avoids forceFit()
      // and xterm.js option updates on hidden terminals
      this.configStale = true;
      return;
    }
    for (const pane of this.panes) {
      pane.applyConfig(config);
    }
  }

  show() {
    const showStart = performance.now();
    this.isVisible = true;
    this.transitioning = true;
    this.lastShownAt = Date.now();
    this.state.needsAttention = false;
    this.state.notification = null;

    // Apply deferred config changes (font size, theme) that were skipped while hidden
    if (this.configStale) {
      this.configStale = false;
      for (const pane of this.panes) {
        pane.applyConfig(this.config);
      }
    }

    this.element.classList.add("active");

    // --- 2-frame show() pipeline with scroll lock (#184, #295) ---
    //
    // Collapsed from 4 rAFs (~67ms) to 2 rAFs (~33ms) for faster tab switching.
    // The scroll lock (acquired in hide()) spans the pipeline.
    //
    // Frame 1: Restore scroll, fit, flush writes, WebGL activation
    // Frame 2: Unlock scroll, focus terminal

    // Track the rAF chain so hide() can cancel if user switches away quickly.
    this.showRafId = requestAnimationFrame(() => {
      // Frame 1: All destabilizing operations in one frame
      for (const pane of this.panes) pane.restoreScrollPosition();
      for (const pane of this.panes) pane.forceFit();
      for (const pane of this.panes) pane.setVisible(true);
      for (const pane of this.panes) pane.activateWebGL(true);
      this.refreshAllPanes();

      this.showRafId = requestAnimationFrame(() => {
        // Frame 2: Unlock scroll + focus — all writes/fits are settled
        for (const pane of this.panes) pane.unlockScroll();
        // After scroll restoration, re-show the pill on any pane the user
        // landed on still scrolled up — guarantees a one-click way back to
        // the bottom even if no new output has occurred. (#419 Fix 4)
        for (const pane of this.panes) pane.refreshScrollPill();
        this.transitioning = false;
        this.showRafId = null;
        if (this.isVisible) this.focusedPane.focus();
        perfMetrics.record("tab.show", performance.now() - showStart);
      });
    });
  }

  hide() {
    this.isVisible = false;
    // Lock scroll position BEFORE any hiding operations — this captures
    // the authoritative viewportY while the terminal is still in a stable
    // state.  The lock persists until show() completes all destabilizing
    // operations (fit, write, WebGL), then unlockScroll() performs the
    // single authoritative restoration. (#184)
    for (const pane of this.panes) pane.lockScroll();
    // Save DOM scrollTop before hiding — defense-in-depth alongside
    // visibility:hidden which preserves scrollTop at the CSS level (#177).
    for (const pane of this.panes) pane.saveScrollPosition();
    this.element.classList.remove("active");
    // Cancel any pending show() rAF to prevent stale focus stealing.
    // Reset transitioning so it doesn't get stuck at true — a stuck flag
    // suppresses ResizeObserver fits and notification delivery (#278, #295).
    if (this.showRafId !== null) {
      cancelAnimationFrame(this.showRafId);
      this.showRafId = null;
      this.transitioning = false;
    }
    // Mark panes hidden so writes are queued without rAF flushing —
    // this dramatically reduces CPU for background tabs under heavy load (#170).
    for (const pane of this.panes) pane.setVisible(false);
    // WebGL contexts are managed by a shared LRU pool (#290) — no need to
    // deactivate on hide. The pool evicts the oldest context when capacity
    // (6 contexts) is reached, so recently-used tabs keep their context
    // alive for instant tab switching.
  }

  fit() {
    if (this.element.classList.contains("active")) {
      this.fitAllPanes();
    }
  }

  focus() {
    this.focusedPane.focus();
  }

  /** Force a full refresh of all pane viewports — used to recover from
   *  silent renderer failures (e.g. WebGL context loss that didn't fire
   *  the onContextLoss event, or canvas blanking in Tauri's WebView). */
  refreshAllPanes() {
    for (const pane of this.panes) {
      pane.terminal.refresh(0, pane.terminal.rows - 1);
    }
  }

  /** Serialize the split tree for session persistence. */
  serializeSplits(): SessionSplitNode | undefined {
    if (this.panes.length <= 1) return undefined;
    return this.serializeNode(this.root);
  }

  private serializeNode(node: SplitNode): SessionSplitNode {
    if (node.type === "leaf") {
      const leaf: SessionSplitLeaf = { type: "leaf", cwd: node.pane.lastFullCwd ?? "" };
      if (node.pane.worktreePath) leaf.worktreePath = node.pane.worktreePath;
      if (node.pane.repoRoot) leaf.repoRoot = node.pane.repoRoot;
      return leaf;
    }
    return {
      type: "split",
      direction: node.direction,
      ratio: node.ratio,
      children: [this.serializeNode(node.children[0]), this.serializeNode(node.children[1])],
    };
  }

  /** Restore splits from a serialized tree. Call after start(). */
  async restoreSplits(layout: SessionSplitNode): Promise<void> {
    if (layout.type !== "split") return;
    await this.restoreNode(layout);
  }

  private async restoreNode(node: SessionSplitNode): Promise<void> {
    if (node.type !== "split") return;

    // Remember the pane that will be split (currently focused)
    const originalPane = this.focusedPane;
    const paneCountBefore = this.panes.length;

    // Split it — after this, focusedPane = the NEW pane (child[1] side)
    await this.split(node.direction);
    const newPane = this.focusedPane;

    // If split failed (PTY spawn error, pane limit, etc.) the tree was reverted.
    // Bail out to avoid recursing into a subtree that doesn't exist.
    if (this.panes.length === paneCountBefore || newPane === originalPane) {
      logger.warn("[restoreNode] split failed, skipping subtree");
      return;
    }

    // Find the branch containing these two panes and adjust ratio
    const branch = this.findBranchWith(this.root, originalPane, newPane);
    if (branch) {
      branch.ratio = node.ratio;
      this.applySplitSizes(branch);
    }

    // Apply per-pane worktree metadata from session leaves
    if (node.children[0].type === "leaf") {
      if (node.children[0].worktreePath) originalPane.worktreePath = node.children[0].worktreePath;
      if (node.children[0].repoRoot) originalPane.repoRoot = node.children[0].repoRoot;
    }
    if (node.children[1].type === "leaf") {
      if (node.children[1].worktreePath) newPane.worktreePath = node.children[1].worktreePath;
      if (node.children[1].repoRoot) newPane.repoRoot = node.children[1].repoRoot;
    }

    // Recurse into child[1] (new pane, currently focused)
    if (node.children[1].type === "split") {
      await this.restoreNode(node.children[1]);
    }

    // Recurse into child[0] (original pane — need to focus it first)
    if (node.children[0].type === "split") {
      this.setFocusedPane(originalPane);
      await this.restoreNode(node.children[0]);
    }

    this.fitAllPanes();
  }

  /** Find the SplitBranch that directly contains both panes as leaves. */
  private findBranchWith(node: SplitNode, a: Pane, b: Pane): SplitBranch | null {
    if (node.type === "leaf") return null;
    const hasA = this.treeContainsPane(node.children[0], a) || this.treeContainsPane(node.children[1], a);
    const hasB = this.treeContainsPane(node.children[0], b) || this.treeContainsPane(node.children[1], b);
    if (hasA && hasB) {
      // Check children first for a tighter match
      const deeper =
        this.findBranchWith(node.children[0], a, b) ?? this.findBranchWith(node.children[1], a, b);
      return deeper ?? node;
    }
    return null;
  }

  private treeContainsPane(node: SplitNode, pane: Pane): boolean {
    if (node.type === "leaf") return node.pane === pane;
    return this.treeContainsPane(node.children[0], pane) || this.treeContainsPane(node.children[1], pane);
  }

  dispose() {
    // Clean up document-level divider drag listeners
    for (const ac of this.dividerCleanups.values()) {
      ac.abort();
    }
    this.dividerCleanups.clear();

    for (const pane of this.panes) {
      try {
        pane.dispose();
      } catch (e) {
        logger.warn("Pane dispose failed:", e);
      }
    }
    this.panes = [];
    this.element.remove();
  }
}
