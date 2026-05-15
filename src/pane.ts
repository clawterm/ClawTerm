import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SearchAddon } from "@xterm/addon-search";
import { WebGLManager } from "./pane-webgl";
import { invoke } from "@tauri-apps/api/core";
import { spawn, type IPty, type IPtyForkOptions } from "tauri-pty";
import { TERMINAL_THEME, type Config } from "./config";
import { OutputAnalyzer } from "./output-analyzer";
import { ScrollAnchor } from "./scroll-anchor";
import type { OutputEvent, OutputMatcher } from "./matchers";
import { DEFAULT_MATCHERS } from "./matchers";
import { registerOscHandlers, type OscNotificationEvent } from "./osc-handler";
import { type PaneState, type StatusLineData, createDefaultPaneState, formatElapsed } from "./tab-state";
import { SearchBar } from "./search-bar";
import { logger } from "./logger";
import { showToast } from "./toast";
import { showContextMenu } from "./context-menu";
import { FileLinkProvider } from "./file-link-provider";
import { copyToClipboard, isPrimaryMod } from "./utils";
import { showPasteConfirm as showPasteDialog } from "./paste-confirm";
import { TRUSTED_AGENT_PROCESSES, isTrustedAgentForeground } from "./trust-gate";

export type KeyHandler = (e: KeyboardEvent) => boolean;

/** Internal extension of IPty that exposes the undocumented _init promise from tauri-pty */
interface IPtyWithInit extends IPty {
  _init?: Promise<void>;
}

let paneCounter = 0;

function pushSpan(parent: HTMLElement, cls: string, text: string, title?: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  if (title) el.title = title;
  parent.appendChild(el);
  return el;
}

/**
 * Build the Claude statusLine portion of the footer: model name, effort
 * badge, context %, and vim mode when relevant. Mutates `row` in place.
 * Cost and thinking-enabled dot are intentionally omitted — the footer
 * is a glanceable status line, not a billing surface.
 */
function renderClaudeMetrics(row: HTMLElement, sl: StatusLineData): void {
  pushSpan(row, "footer-claude-model", sl.model.displayName);

  const effort = sl.effort?.level;
  if (effort && effort !== "low" && effort !== "medium") {
    pushSpan(row, `footer-claude-effort footer-claude-effort-${effort}`, effort, `Effort: ${effort}`);
  }

  if (sl.contextWindow) {
    const used = sl.contextWindow.usedPercentage;
    const wrap = pushSpan(row, "footer-claude-context", "");
    const level = used >= 85 ? "crit" : used >= 60 ? "warn" : "ok";
    // .context-bar is the shared bar layout (sidebar uses it too, #507);
    // the footer wrapper still owns gap/inline-flex.
    const bar = pushSpan(wrap, `context-bar context-bar-${level}`, "");
    const fill = pushSpan(bar, "context-bar-fill", "");
    fill.style.width = `${Math.min(100, Math.max(0, used)).toFixed(0)}%`;
    pushSpan(wrap, "footer-claude-context-label", `${used.toFixed(0)}%`);
    if (sl.exceeds200kTokens) {
      pushSpan(wrap, "footer-claude-tag", ">200k", "Exceeds 200k tokens — auto-compaction soon");
    }
  }

  if (sl.vim && sl.vim.mode !== "NORMAL") {
    const cls = `footer-claude-vim footer-claude-vim-${sl.vim.mode.toLowerCase().replace(" ", "-")}`;
    pushSpan(row, cls, sl.vim.mode);
  }
}

/**
 * A single terminal pane — owns a Terminal + PTY + output analysis.
 * Multiple Panes can live inside a single Tab via splits.
 */
export class Pane {
  readonly id: string;
  readonly terminal: Terminal;
  readonly fitAddon: FitAddon;
  private _searchAddon: SearchAddon | null = null;
  private _searchLoading = false;
  readonly element: HTMLDivElement;
  private terminalWrapper: HTMLDivElement;
  private pty: IPty | null = null;
  ptyPid: number | null = null;
  /** Internal pty session handle (NOT an OS PID) — used for IPC calls to the plugin */
  ptyHandle: number | null = null;
  private disposed = false;
  private config: Config;
  readonly analyzer: OutputAnalyzer;
  private searchBar: SearchBar | null = null;
  private cwd: string | undefined;
  lastFullCwd: string | null = null;
  /** Last raw Claude statusLine JSON observed; used to skip re-parsing
   *  identical payloads on polls between assistant turns. */
  lastClaudeStatusJson: string | null = null;
  private scrollPill: HTMLDivElement | null = null;
  private pasteOverlay: HTMLDivElement | null = null;
  private webgl: WebGLManager | null = null;
  /** Encapsulates all scroll-preservation invariants: hide/show locking,
   *  user-intent flag, fit-in-progress flag, multi-frame flush anchor,
   *  and the buffer-mutation tripwire. (#476 — extracted from #184/#305/#419/#432/#437). */
  private readonly scrollAnchor: ScrollAnchor;
  /** RAF-based write batching — queues PTY data and flushes once per frame
   *  to prevent terminal.write() from racing with fitAddon.fit() mid-reflow.
   *  Append-only with a head pointer; eviction nulls slots and advances
   *  head, then the dead prefix is splice-compacted past a threshold. (#468) */
  private pendingWriteData: (Uint8Array | undefined)[] = [];
  private pendingHead = 0;
  private pendingBytes = 0;
  private static readonly PENDING_COMPACT_THRESHOLD = 256;
  /** Cap each visible-flush rAF at this much data so a hidden-tab backlog
   *  doesn't drop a frame on tab focus. (#467) */
  private static readonly FLUSH_CHUNK_BYTES = 32 * 1024;
  /** Reusable merge buffer for flushWrites() — grows as needed, never shrinks.
   *  Avoids allocating a new Uint8Array on every animation frame. */
  private mergeBuffer: Uint8Array | null = null;
  private writeRafId = 0;
  /** Whether the owning Tab is currently visible.  When false, writes are
   *  queued but not flushed via rAF — they accumulate and are flushed in
   *  bulk when the tab becomes visible.  This dramatically reduces CPU and
   *  xterm.js processing for background tabs under heavy multi-tab load. */
  private tabVisible = true;
  /** Max bytes to accumulate for a hidden tab before discarding oldest data.
   *  Reduced from 512KB to 128KB to limit memory pressure with many tabs (#305). */
  private static readonly MAX_HIDDEN_PENDING_BYTES = 128 * 1024; // 128KB
  /** Scrollback cap applied to hidden tabs to reduce memory usage (#305).
   *  The original scrollback is restored when the tab becomes visible. */
  private static readonly HIDDEN_SCROLLBACK = 1000;
  private savedScrollback: number | null = null;
  private eventGutter: HTMLDivElement | null = null;
  private gutterTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-pane status footer — replaces global status bar (#348) */
  private footer: HTMLDivElement | null = null;
  private footerRow: HTMLDivElement | null = null;
  /** Cache for the structural part of the footer (everything except the
   *  elapsed counter). When unchanged, the per-second poll only rewrites
   *  the elapsed span instead of rebuilding the whole row. */
  private footerStructuralKey = "";
  private footerElapsedSpan: HTMLSpanElement | null = null;
  private readonly ac = new AbortController();
  private readonly createdAt = Date.now();
  private readonly disposables: { dispose(): void }[] = [];

  /** Per-pane state (updated by Tab during polling) */
  state: PaneState = createDefaultPaneState();
  /** Number of consecutive polls where the pane was idle — used to skip
   *  expensive CWD/git lookups after the state has stabilized. */
  idleConsecutive = 0;
  /** Timestamp of last data received from the PTY — used for fit() deferral */
  lastOutputAt = 0;

  /** If this pane is in a git worktree, the worktree directory path */
  worktreePath: string | null = null;
  /** The repo root this worktree belongs to */
  repoRoot: string | null = null;

  onExit: ((exitCode: number) => void) | null = null;
  onOutputEvent: ((event: OutputEvent) => void) | null = null;
  /** Fires when the shell sets the terminal title (OSC sequence) — used for instant CWD detection */
  onTerminalTitle: ((title: string) => void) | null = null;
  /** Fires when an OSC 9;2 notification sequence is received — agent needs attention */
  onOscNotification: ((event: OscNotificationEvent) => void) | null = null;
  /** Fires on every PTY data chunk — used by the central poll loop to wake
   *  out of idle mode. The handler is expected to early-return cheaply when
   *  no wake-up is needed, since this fires at PTY-data rate. (#456) */
  onActivity: (() => void) | null = null;
  onFocus: (() => void) | null = null;

  constructor(config: Config, keyHandler?: KeyHandler, cwd?: string) {
    paneCounter++;
    this.id = `pane-${paneCounter}`;
    this.config = config;
    this.cwd = cwd;

    // Build matchers: defaults + user-defined
    const matchers: OutputMatcher[] = [...DEFAULT_MATCHERS];
    for (const um of config.outputAnalysis?.customMatchers ?? []) {
      try {
        matchers.push({
          id: um.id,
          pattern: new RegExp(um.pattern, "i"),
          type: um.type,
          cooldownMs: um.cooldownMs ?? 5000,
        });
      } catch (e) {
        logger.warn(`Invalid regex in custom matcher "${um.id}": ${e instanceof Error ? e.message : e}`);
      }
    }

    this.analyzer = new OutputAnalyzer(matchers);

    this.terminal = new Terminal({
      cursorBlink: config.cursor.blink,
      cursorStyle: config.cursor.style,
      fontSize: config.font.size,
      fontFamily: config.font.family,
      lineHeight: config.font.lineHeight,
      scrollback: config.scrollback,
      theme: TERMINAL_THEME,
      allowProposedApi: true,
      // macOptionIsMeta stays false so Option-composed characters reach the
      // terminal on non-US Mac keyboards — Norwegian Option+Shift+7 → `\`,
      // German Option+L → `@`, etc. (#513). Word-motion (Option+Arrow,
      // Option+Backspace) is wired explicitly in the customKeyEventHandler
      // below, so we don't depend on xterm's meta-prefix behavior.
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
    });
    this.scrollAnchor = new ScrollAnchor(this.terminal, this.id);

    // Intercept keys before xterm processes them
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (keyHandler && !keyHandler(e)) {
        return false;
      }

      // Cmd + key → shell escape sequences
      const cmdKeys: Record<string, string> = { Backspace: "\x15", ArrowLeft: "\x01", ArrowRight: "\x05" };
      // Alt + key → word-level movement / deletion
      const altKeys: Record<string, string> = { ArrowLeft: "\x1bb", ArrowRight: "\x1bf", Backspace: "\x17" };

      if (e.type === "keydown" && this.pty && !this.disposed) {
        if (isPrimaryMod(e) && cmdKeys[e.key]) {
          e.preventDefault();
          // In TUI mode (alternate screen buffer), Ctrl+U is a whole-input
          // kill in most multi-line editors (Claude Code, Ink, Readline),
          // which destroys a long prompt on a single keystroke. Downgrade
          // Cmd+Backspace to the same word-kill Alt+Backspace uses, so the
          // user loses one word at a time instead of the entire input. (#435)
          let seq = cmdKeys[e.key];
          if (e.key === "Backspace" && this.terminal.buffer.active.type === "alternate") {
            seq = altKeys.Backspace;
          }
          this.pty.write(seq);
          return false;
        }
        if (isPrimaryMod(e) && e.key === "k") {
          e.preventDefault();
          this.terminal.clear();
          this.analyzer.eventHistory.clear();
          this.renderGutter();
          return false;
        }
        // Shift+Enter → CSI u sequence for TUI apps (Claude Code)
        if (e.key === "Enter" && e.shiftKey && !isPrimaryMod(e) && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          this.pty.write("\x1b[13;2u");
          return false;
        }
        if (e.altKey && !isPrimaryMod(e) && !e.ctrlKey && altKeys[e.key]) {
          e.preventDefault();
          this.pty.write(altKeys[e.key]);
          return false;
        }
      }

      return true;
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openUrl(uri).catch((e) => logger.debug("Failed to open URL:", e));
      }),
    );
    // SearchAddon + Unicode11Addon loaded lazily for bundle splitting (#317)
    import("@xterm/addon-unicode11")
      .then(({ Unicode11Addon }) => {
        if (this.disposed) return;
        this.terminal.loadAddon(new Unicode11Addon());
        this.terminal.unicode.activeVersion = "11";
      })
      .catch((e) => logger.debug("Unicode11Addon load failed:", e));

    this.element = document.createElement("div");
    this.element.className = "pane";

    // Wrapper for the terminal — FitAddon measures the parent of .xterm,
    // so this isolates the terminal from the footer height (#397).
    this.terminalWrapper = document.createElement("div");
    this.terminalWrapper.className = "pane-terminal";
    this.element.appendChild(this.terminalWrapper);

    // Per-pane status footer (#348) — DOM created here, appended in start()
    // after terminal.open() so the footer appears below the terminal.
    this.footer = document.createElement("div");
    this.footer.className = "pane-footer";
    this.footerRow = document.createElement("div");
    this.footerRow.className = "pane-footer-row";
    this.footer.appendChild(this.footerRow);

    // Fire onFocus when this pane's element receives focus (click/tab)
    this.element.addEventListener("focusin", () => this.onFocus?.(), { signal: this.ac.signal });

    // Copy selection to clipboard on select
    if (config.copyOnSelect) {
      this.disposables.push(
        this.terminal.onSelectionChange(() => {
          const selection = this.terminal.getSelection();
          if (selection) copyToClipboard(selection);
        }),
      );
    }

    // Right-click context menu with Copy / Paste
    this.element.addEventListener(
      "contextmenu",
      (e: MouseEvent) => {
        e.preventDefault();
        const selection = this.terminal.getSelection();
        showContextMenu(e.clientX, e.clientY, [
          {
            label: "Copy",
            disabled: !selection,
            action: () => {
              if (selection) copyToClipboard(selection);
            },
          },
          {
            label: "Paste",
            separator: true,
            action: () => {
              navigator.clipboard
                .readText()
                .then((text) => this.requestPaste(text))
                .catch((e) => {
                  logger.debug("Clipboard read failed:", e);
                  showToast("Failed to read clipboard", "error");
                });
            },
          },
          {
            label: "Clear",
            separator: true,
            action: () => {
              this.terminal.clear();
              this.analyzer.eventHistory.clear();
              this.renderGutter();
            },
          },
        ]);
      },
      { signal: this.ac.signal },
    );

    // Intercept paste to confirm multi-line text before sending to terminal
    this.element.addEventListener(
      "paste",
      (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData("text");
        if (!text || this.disposed) return;
        // Skip if single line or bracketed paste mode is active (app handles it)
        if (!text.includes("\n") || this.terminal.modes.bracketedPasteMode) return;
        e.preventDefault();
        e.stopPropagation();
        void this.pasteWithAgentTrust(text);
      },
      { signal: this.ac.signal },
    );

    // Listen for terminal title changes (OSC 0/2 from the shell).
    // Zsh/oh-my-zsh set the title on every prompt, giving us instant CWD detection.
    this.disposables.push(
      this.terminal.onTitleChange((title) => {
        // Cap untrusted title text — symmetric with the OSC 9;2 cap (#479)
        const safe = title.length > 256 ? title.slice(0, 256) + "…" : title;
        this.onTerminalTitle?.(safe);
      }),
    );

    // Register OSC 9 handlers for notification (9;2) sequences.
    this.disposables.push(
      ...registerOscHandlers(this.terminal, {
        onNotification: (event) => {
          this.onOscNotification?.(event);
        },
      }),
    );

    // Wire output analyzer events
    if (config.outputAnalysis?.enabled !== false) {
      this.analyzer.onEvent((event) => {
        logger.debug(
          `[pane.analyzerEvent] pane=${this.id} type=${event.type} detail=${event.detail.slice(0, 60)}`,
        );
        this.onOutputEvent?.(event);
      });
    }
  }

  async start(): Promise<boolean> {
    this.terminal.open(this.terminalWrapper);

    // Footer is already in the DOM (appended after wrapper in constructor).
    // Just ensure it's present.
    if (this.footer && !this.footer.parentElement) this.element.appendChild(this.footer);

    // Clamp macOS trackpad momentum/inertial scrolling during active output.
    // Only suppress DOWNWARD momentum — upward scroll (user reading history)
    // must never be blocked. Threshold and window are tight to avoid eating
    // intentional scroll-start events (#431).
    this.terminal.attachCustomWheelEventHandler((ev: WheelEvent) => {
      if (ev.deltaY < 0) {
        // Mark the user as scrolled-up synchronously.  The native
        // .xterm-viewport scroll event that normally sets this fires
        // asynchronously, so a flushWrites() landing between the wheel
        // event and the scroll event would read viewportY == baseY and
        // let xterm auto-follow snap the viewport back to the bottom —
        // the user has to scroll repeatedly before one event "sticks".
        // Setting the flag up-front closes that race. (#432)
        this.scrollAnchor.setUserScrolledUp(true);
        // If the show() pipeline hasn't finished releasing the scroll
        // lock yet, user intent wins — abandon the pending restore so
        // updateScrollState() stops early-returning on isLocked
        // and the next flushWrites() doesn't snap back to baseY. (#437)
        if (this.scrollAnchor.isLocked) this.scrollAnchor.abandon();
        return true;
      }
      const outputAge = Date.now() - this.lastOutputAt;
      if (outputAge < 200 && ev.deltaY > 0 && ev.deltaY < 2) {
        // During active output, suppress tiny downward momentum tails only.
        return false;
      }
      return true;
    });

    // WebGL + ImageAddon are loaded lazily via activateWebGL() / deactivateWebGL()
    // so that only the active tab's panes consume GPU contexts.  The Tab calls
    // activateWebGL() in show() and deactivateWebGL() in hide().
    // For the initial tab (already visible), activate now.
    this.activateWebGL();

    // Register file path link provider (click to copy path)
    this.terminal.registerLinkProvider(new FileLinkProvider(this.terminal));

    // Double-rAF: the first frame lets the browser compute flex layout for
    // the pane-terminal wrapper (especially in split containers where the
    // pane height is constrained).  The second frame ensures the computed
    // height has propagated so FitAddon measures correctly (#397, #402).
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Guard against zero-dimension elements (e.g. display:none parent) —
    // fit() on a zero-sized element can produce NaN cols/rows
    if (this.element.offsetWidth > 0 && this.element.offsetHeight > 0) {
      this.fitAddon.fit();
    }

    // Ensure valid dimensions — xterm.js may produce 0 or NaN on hidden elements
    const cols = this.terminal.cols > 0 && Number.isFinite(this.terminal.cols) ? this.terminal.cols : 80;
    const rows = this.terminal.rows > 0 && Number.isFinite(this.terminal.rows) ? this.terminal.rows : 24;

    const spawnOpts: IPtyForkOptions = {
      cols,
      rows,
      name: "xterm-256color",
    };
    if (this.cwd) spawnOpts.cwd = this.cwd;

    try {
      this.pty = spawn(this.config.shell, this.config.shellArgs, spawnOpts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Failed to start shell: ${this.config.shell}`, "error", 8000);
      logger.warn("PTY spawn failed:", e);
      this.showPaneError(`Failed to start shell: ${this.config.shell}`, msg);
      return false;
    }

    if (!this.pty) {
      logger.warn("PTY spawn returned null");
      return false;
    }
    // The pty plugin's .pid is an internal session ID (0, 1, 2...), NOT the OS PID.
    // Wait for init, then store the handle and fetch the real shell PID.
    const ptyObj = this.pty as IPtyWithInit;
    const ptyInit = ptyObj._init;
    if (ptyInit) {
      ptyInit
        .then(() => {
          if (this.disposed) return;
          this.ptyHandle = ptyObj.pid as number;
          logger.debug(`[pane.start] pane=${this.id} ptyHandle=${this.ptyHandle}`);
          return invoke<number>("plugin:pty|child_pid", { pid: this.ptyHandle });
        })
        .then((osPid) => {
          if (this.disposed || osPid == null) return;
          this.ptyPid = osPid;
          logger.debug(`[pane.start] pane=${this.id} osPid=${osPid}`);
        })
        .catch((e) => logger.warn("Failed to get shell PID:", e));
    }

    this.pty.onData((data: Uint8Array | number[]) => {
      if (!this.disposed) {
        this.lastOutputAt = Date.now();
        this.onActivity?.();
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

        // Feed the output analyzer immediately (no batching needed — it's
        // just string processing, and debounces internally).
        if (this.config.outputAnalysis?.enabled !== false) {
          const buf = this.terminal.buffer.active;
          this.analyzer.currentLine = buf.baseY + buf.cursorY;
          this.analyzer.totalLines = buf.baseY + this.terminal.rows;
          this.analyzer.feed(bytes);
        }

        // Queue the write and flush once per animation frame.  This serializes
        // writes with fit() (both happen at most once per frame via rAF) and
        // eliminates the core race where terminal.write() mutates baseY/viewportY
        // between fit()'s save and restore.
        //
        // When the tab is hidden, data is queued but NOT flushed via rAF.
        // This avoids per-frame terminal.write() for every background tab,
        // dramatically reducing CPU under heavy multi-tab load (#170).
        // Accumulated data is flushed in bulk when the tab becomes visible.
        this.pendingWriteData.push(bytes);
        this.pendingBytes += bytes.length;
        if (!this.tabVisible) {
          // Cap accumulated data to prevent unbounded memory growth. Advance
          // pendingHead instead of shift()-ing — avoids O(n) per eviction
          // when the queue is long. (#468)
          while (
            this.pendingBytes > Pane.MAX_HIDDEN_PENDING_BYTES &&
            this.pendingWriteData.length - this.pendingHead > 1
          ) {
            const evicted = this.pendingWriteData[this.pendingHead]!;
            this.pendingBytes -= evicted.length;
            this.pendingWriteData[this.pendingHead] = undefined;
            this.pendingHead++;
          }
          // Compact the dead prefix in one splice when it gets large, so the
          // backing array doesn't grow unboundedly during long hidden periods.
          if (this.pendingHead > Pane.PENDING_COMPACT_THRESHOLD) {
            this.pendingWriteData.splice(0, this.pendingHead);
            this.pendingHead = 0;
          }
          return;
        }
        if (!this.writeRafId) {
          this.writeRafId = requestAnimationFrame(() => this.flushWrites());
        }
      }
    });

    this.pty.onExit((exitInfo: { exitCode: number; signal?: number }) => {
      if (!this.disposed) {
        const code = exitInfo.exitCode;
        const signal = exitInfo.signal;
        const color = code === 0 ? "90" : "31"; // gray for 0, red for non-zero
        let msg = `\r\n\x1b[${color}m[Process exited with code ${code}`;
        if (signal) msg += `, signal ${signal}`;
        msg += `]\x1b[0m\r\n`;
        this.scrollSafeWrite(msg);
        this.onExit?.(code);
      }
    });

    this.disposables.push(
      this.terminal.onData((data: string) => {
        if (this.pty && !this.disposed) {
          this.pty.write(data);
        }
      }),
      this.terminal.onResize(({ cols, rows }) => {
        if (this.pty && !this.disposed) {
          this.pty.resize(cols, rows);
        }
      }),
    );

    // SearchBar created lazily on first toggleSearch() call

    // Event timeline gutter — renders markers for detected output events.
    // Hidden by default to reduce visual noise (#349); enable via config.
    if (this.config.outputAnalysis?.showEventGutter) {
      this.eventGutter = document.createElement("div");
      this.eventGutter.className = "event-gutter";
      this.element.appendChild(this.eventGutter);
      // Update gutter periodically (events may accumulate between renders)
      this.gutterTimer = setInterval(() => this.renderGutter(), 2000);
    }

    // Track scroll position to show "new output" pill.
    // Skip updates during programmatic scrolls from fit() to prevent a
    // race-induced jump from incorrectly marking the viewport as scrolled up.
    this.disposables.push(
      this.terminal.onScroll(() => {
        this.updateScrollState();
      }),
    );

    // Native scroll listener on .xterm-viewport for reliable user scroll
    // detection.  terminal.onScroll only fires on buffer growth (new lines),
    // NOT on user-initiated scrolling (xtermjs/xterm.js#3201, #3864).
    // This ensures userScrolledUp is set correctly when the user scrolls
    // via mouse wheel, trackpad, or scrollbar drag.
    const viewport = this.element.querySelector(".xterm-viewport");
    if (viewport) {
      viewport.addEventListener(
        "scroll",
        () => {
          this.updateScrollState();
        },
        { passive: true, signal: this.ac.signal },
      );
    }

    return true;
  }

  /** @deprecated Branch badge removed (#333) — branch info shown in sidebar */
  updateBranchBadge(): void {}

  /** Get process info for polling (used by Tab) */
  getProcessInfo(): { pid: number | null; disposed: boolean } {
    return { pid: this.ptyPid, disposed: this.disposed };
  }

  async toggleSearch() {
    // Lazy-load SearchAddon and SearchBar on first use (#317)
    if (!this._searchAddon && !this._searchLoading) {
      this._searchLoading = true;
      const { SearchAddon } = await import("@xterm/addon-search");
      this._searchAddon = new SearchAddon();
      this.terminal.loadAddon(this._searchAddon);
      this._searchLoading = false;
    }
    if (!this._searchAddon) return; // Still loading from a concurrent call
    if (!this.searchBar) {
      this.searchBar = new SearchBar(this.element, this._searchAddon, () => this.terminal.focus());
    }
    this.searchBar.toggle();
  }

  applyConfig(config: Config) {
    this.config = config;
    this.terminal.options.fontSize = config.font.size;
    this.terminal.options.fontFamily = config.font.family;
    this.terminal.options.lineHeight = config.font.lineHeight;
    this.terminal.options.cursorBlink = config.cursor.blink;
    this.terminal.options.cursorStyle = config.cursor.style;
    this.terminal.options.theme = TERMINAL_THEME;
    // Use forceFit — config changes are user-initiated (zoom, reload) and
    // must take effect immediately, even during active output.
    this.forceFit();
  }

  /**
   * Set whether this pane's owning tab is visible.  When hidden, PTY writes
   * are queued but not flushed to xterm.js — this avoids per-frame
   * terminal.write() processing for every background tab and significantly
   * reduces CPU/memory pressure under heavy multi-tab load (#170).
   */
  setVisible(visible: boolean) {
    this.tabVisible = visible;
    this.analyzer.setVisibility(visible);
    if (visible) {
      // Restore original scrollback from before hiding (#305)
      if (this.savedScrollback !== null) {
        this.terminal.options.scrollback = this.savedScrollback;
        this.savedScrollback = null;
      }
      if (this.pendingWriteData.length - this.pendingHead > 0 && !this.writeRafId) {
        // Flush accumulated writes now that we're visible
        this.writeRafId = requestAnimationFrame(() => this.flushWrites());
      }
      // Resume gutter timer — render immediately to catch events accumulated while hidden
      if (this.eventGutter && !this.gutterTimer) {
        this.renderGutter();
        this.gutterTimer = setInterval(() => this.renderGutter(), 2000);
      }
    } else {
      // Compact scrollback on hidden tabs to reduce memory usage (#305).
      // Save original value and cap at HIDDEN_SCROLLBACK.
      //
      // Skip the trim entirely if the user is actively scrolled up — they're
      // reading history, and trimming the buffer would yank their viewing
      // position out from under them on tab return (#419 Fix 2). Distance-
      // from-bottom restoration would still produce a clean clamp in that
      // case, but the perfect restoration is "no mutation at all" so we
      // prefer that path when we can detect it.
      if (!this.scrollAnchor.isUserScrolledUp) {
        const currentScrollback = this.terminal.options.scrollback ?? this.config.scrollback;
        if (currentScrollback > Pane.HIDDEN_SCROLLBACK) {
          this.savedScrollback = currentScrollback;
          this.terminal.options.scrollback = Pane.HIDDEN_SCROLLBACK;
          // Mark this as a known-legitimate buffer mutation so the Fix 5
          // invariant warning in unlock() doesn't fire on it. (#419)
          this.scrollAnchor.noteTrimmedDuringHide();
        }
      }
      // Pause gutter timer for hidden panes — no point updating invisible DOM
      if (this.gutterTimer) {
        clearInterval(this.gutterTimer);
        this.gutterTimer = null;
      }
    }
  }

  /** Update per-pane status footer with current state. Called after each
   *  poll cycle. Two-tier cache: when only the elapsed counter has
   *  changed, just rewrite that one span; rebuild the whole row only
   *  when a structural field (branch, gitStatus, statusLine) changes. */
  updateFooter() {
    if (!this.footerRow) return;
    const s = this.state;
    const gs = s.gitStatus;
    const sl = s.statusLine;
    const ctx = sl?.contextWindow;
    const slKey = sl
      ? `${sl.model.displayName}|${ctx?.usedPercentage ?? ""}|${sl.exceeds200kTokens ?? ""}|${sl.effort?.level ?? ""}|${sl.vim?.mode ?? ""}`
      : "no-sl";
    const structuralKey = `${s.folderName}|${s.gitBranch}|${gs?.modified ?? ""}|${gs?.staged ?? ""}|${gs?.untracked ?? ""}|${gs?.ahead ?? ""}|${gs?.behind ?? ""}|${slKey}`;
    const elapsed = formatElapsed(this.createdAt);

    if (structuralKey === this.footerStructuralKey) {
      if (this.footerElapsedSpan) this.footerElapsedSpan.textContent = elapsed;
      return;
    }
    this.footerStructuralKey = structuralKey;

    this.footerRow.textContent = "";
    if (sl) renderClaudeMetrics(this.footerRow, sl);
    pushSpan(this.footerRow, "footer-spacer", "");
    if (s.gitBranch) {
      // Two spans so the branch can ellipsis while the ahead-counter
      // stays pinned next to it via flex-shrink:0.
      pushSpan(this.footerRow, "footer-branch", s.gitBranch);
      if (gs && gs.ahead > 0) {
        pushSpan(this.footerRow, "footer-branch-ahead", `\u2191${gs.ahead}`, `${gs.ahead} ahead of remote`);
      }
    }
    this.footerElapsedSpan = pushSpan(this.footerRow, "footer-elapsed", elapsed);
  }

  private deferredFitTimer: ReturnType<typeof setTimeout> | null = null;

  fit() {
    if (this.element.offsetWidth === 0 || this.element.offsetHeight === 0) return;

    // During active output, fitAddon.fit() races with terminal.write() —
    // writes between saving viewportY and the reflow can invalidate the
    // saved position, causing a scroll jump.  Defer the fit until output
    // settles; the next write will naturally position the viewport.
    // Use 300ms grace (up from 150ms) to cover bursty agent output gaps
    // between streaming chunks and tool calls.
    const outputAge = Date.now() - this.lastOutputAt;
    if (outputAge < 300) {
      // Always reschedule so the final fit() uses up-to-date dimensions
      // and no resize operation is silently dropped.
      if (this.deferredFitTimer) clearTimeout(this.deferredFitTimer);
      this.deferredFitTimer = setTimeout(() => {
        this.deferredFitTimer = null;
        this.fit();
      }, 300);
      return;
    }

    this.fitCore();
  }

  /**
   * Fit the terminal to its container, bypassing the output-activity deferral.
   * Used when the pane becomes visible (tab show) or after a user-initiated
   * config change (zoom, font size) — in these cases the terminal MUST be
   * sized correctly immediately, even if there is active output.
   */
  forceFit() {
    if (this.element.offsetWidth === 0 || this.element.offsetHeight === 0) return;
    // Cancel any pending deferred fit — we're fitting now.
    if (this.deferredFitTimer) {
      clearTimeout(this.deferredFitTimer);
      this.deferredFitTimer = null;
    }
    this.fitCore();
  }

  /** Shared fit implementation — preserves scroll position across reflow. */
  private fitCore() {
    // ScrollAnchor.currentDistance() returns the locked anchor when in a
    // tab-transition critical section, otherwise the live distance. The
    // actual restoration on unlock happens in scrollAnchor.unlock().
    const distance = this.scrollAnchor.currentDistance();
    this.scrollAnchor.setFitting(true);
    try {
      this.fitAddon.fit();
      this.scrollAnchor.restore(distance);
    } finally {
      this.scrollAnchor.setFitting(false);
    }
  }

  /** Flush queued PTY writes to xterm.js, capped at FLUSH_CHUNK_BYTES per
   *  frame.  When a tab becomes visible with a large accumulated backlog,
   *  the flush is split across multiple animation frames so the parse pass
   *  can't drop a frame at the moment of focus. (#467) */
  private flushWrites() {
    this.writeRafId = 0;
    const totalQueued = this.pendingWriteData.length - this.pendingHead;
    if (this.disposed || totalQueued === 0) {
      this.scrollAnchor.clearFlushAnchor();
      return;
    }

    // Snapshot scroll state ONCE per flush sequence (held across chunks).
    // Use distance-from-bottom because the write grows baseY underneath
    // any saved viewportY index. (#419)
    const savedDistance = this.scrollAnchor.ensureFlushAnchor();

    // Decide how many chunks to consume this frame: up to FLUSH_CHUNK_BYTES,
    // always at least one (so we make forward progress even on a giant chunk).
    let bytesThisFrame = 0;
    let consumeCount = 0;
    for (let i = this.pendingHead; i < this.pendingWriteData.length; i++) {
      const c = this.pendingWriteData[i]!;
      if (consumeCount > 0 && bytesThisFrame + c.length > Pane.FLUSH_CHUNK_BYTES) break;
      bytesThisFrame += c.length;
      consumeCount++;
    }

    // Build the chunk to write this frame.
    let data: Uint8Array;
    if (consumeCount === 1) {
      data = this.pendingWriteData[this.pendingHead]!;
    } else {
      if (!this.mergeBuffer || this.mergeBuffer.length < bytesThisFrame) {
        this.mergeBuffer = new Uint8Array(Math.max(bytesThisFrame, (this.mergeBuffer?.length ?? 4096) * 2));
      }
      let offset = 0;
      for (let i = this.pendingHead; i < this.pendingHead + consumeCount; i++) {
        const c = this.pendingWriteData[i]!;
        this.mergeBuffer.set(c, offset);
        offset += c.length;
      }
      data = new Uint8Array(this.mergeBuffer.buffer, 0, bytesThisFrame);
    }

    // Null consumed slots so chunk byte buffers can be GC'd before compaction.
    for (let i = this.pendingHead; i < this.pendingHead + consumeCount; i++) {
      this.pendingWriteData[i] = undefined;
    }
    this.pendingHead += consumeCount;
    this.pendingBytes -= bytesThisFrame;
    const moreRemaining = this.pendingWriteData.length - this.pendingHead > 0;

    if (!moreRemaining) {
      this.pendingWriteData.length = 0;
      this.pendingHead = 0;
      this.pendingBytes = 0;
    } else if (this.pendingHead > Pane.PENDING_COMPACT_THRESHOLD) {
      // Steady visible output flushes one chunk per frame while pty.onData
      // keeps appending — the array would grow forever without this splice.
      this.pendingWriteData.splice(0, this.pendingHead);
      this.pendingHead = 0;
    }

    // Write with callback — restores scroll position AFTER xterm.js finishes
    // parsing and updating baseY, preventing the viewport from jumping. (#257)
    this.terminal.write(data, () => {
      if (this.disposed) return;

      // Restore scroll position on every chunk so a user who is scrolled up
      // doesn't see their viewport snap to the bottom mid-flush.
      //   savedDistance   — pre-flush snapshot (held across all chunks).
      //   liveDistance    — current distance (reflects any wheel scroll
      //                     that committed during the write).
      //   userScrolledUp  — set synchronously by the wheel handler for
      //                     upward scrolls; survives xterm's auto-follow
      //                     snap-back when the pre-write snapshot missed
      //                     the user's intent. (#432)
      const liveDistance = this.scrollAnchor.currentDistance();
      let distance = Math.max(savedDistance, liveDistance);
      if (distance === 0 && this.scrollAnchor.isUserScrolledUp) {
        distance = 1;
      }
      if (distance > 0) {
        this.scrollAnchor.restoreSuppressed(distance);
      }

      if (moreRemaining) {
        // Schedule the next chunk.
        if (!this.writeRafId) {
          this.writeRafId = requestAnimationFrame(() => this.flushWrites());
        }
        return;
      }

      // Final chunk — drop the saved distance and surface the scroll pill.
      this.scrollAnchor.clearFlushAnchor();
      const finalBuf = this.terminal.buffer.active;
      if (finalBuf.viewportY < finalBuf.baseY) {
        this.showScrollPill("new-output");
      }
    });
  }

  focus() {
    this.terminal.focus();
  }

  /** Write a string to the PTY (as if the user typed it). */
  writeToPty(data: string) {
    if (this.pty && !this.disposed) {
      this.pty.write(data);
    }
  }

  /** Write directly to the terminal display (for UI messages, not shell I/O).
   *  Uses scroll-safe write to preserve viewport position when scrolled up. */
  writeToDisplay(data: string) {
    this.scrollSafeWrite(data);
  }

  /** Write data to the terminal, preserving scroll position if the user has
   *  scrolled up.  Uses the write callback to restore the saved
   *  distance-from-bottom after xterm.js finishes parsing — preventing
   *  Viewport._sync() from corrupting scroll. (#419) */
  private scrollSafeWrite(data: string) {
    const savedDistance = this.scrollAnchor.currentDistance();
    const wasScrolledUp = this.scrollAnchor.isUserScrolledUp;
    this.terminal.write(data, () => {
      if (wasScrolledUp) {
        this.scrollAnchor.restoreSuppressed(savedDistance);
      }
    });
  }

  private showPasteConfirm(text: string) {
    this.pasteOverlay?.remove();
    this.pasteOverlay = showPasteDialog(text, this.terminal, this.ac.signal, () => {
      this.pasteOverlay = null;
    });
  }

  /** Paste multi-line text, but skip the confirm dialog when the foreground
   *  process is a trusted AI agent CLI — pasting into Claude Code's prompt
   *  isn't the same risk profile as pasting into a shell (#508).
   *
   *  Before the pty has finished initializing there's nothing to protect
   *  against (no shell, no prompt) so we skip the dialog too — otherwise
   *  a paste fired right after pane creation surfaces the dialog with no
   *  way for the trust gate to resolve, which has been observed in
   *  practice. (#519 hypothesis C) */
  private async pasteWithAgentTrust(text: string): Promise<void> {
    if (this.ptyHandle == null || this.ptyPid == null) {
      if (this.disposed) return;
      this.terminal.paste(text);
      return;
    }
    if (await this.foregroundIsTrustedAgent()) {
      if (this.disposed) return;
      this.terminal.paste(text);
      return;
    }
    if (this.disposed) return;
    this.showPasteConfirm(text);
  }

  /** Resolve the pane's foreground process name and check it against the
   *  trusted-agent allowlist. Returns false on any failure so we fall back
   *  to the safe (dialog) path.
   *
   *  When the immediate foreground isn't trusted, walk up the ancestor
   *  chain toward the shell. Claude Code spawns subshells (zsh / bash /
   *  node) for tool calls, which briefly become the pane's foreground —
   *  we still want to trust pastes during those windows because the
   *  session driver is `claude`. The chain stops at `shellPid`, so we
   *  never accidentally trust the shell itself. (#519) */
  private async foregroundIsTrustedAgent(): Promise<boolean> {
    const handle = this.ptyHandle;
    const shellPid = this.ptyPid;
    if (handle == null || shellPid == null) return false;
    try {
      const fgPid = await invoke<number>("plugin:pty|foreground_pid", { pid: handle });
      // No foreground process — we're at the shell prompt, where the dialog
      // is the right safety net (multi-line paste can execute commands).
      if (fgPid === shellPid) return false;
      const name = await invoke<string>("get_process_name", { pid: fgPid });
      if (TRUSTED_AGENT_PROCESSES.has(name)) return true;
      // Fast path missed: foreground is e.g. a tool subshell. Walk up to
      // the pty's shell looking for a trusted ancestor.
      const ancestors = await invoke<Array<{ pid: number; name: string }>>(
        "get_process_ancestors",
        { startPid: fgPid, stopPid: shellPid },
      );
      return isTrustedAgentForeground(name, ancestors);
    } catch (e) {
      logger.debug("foregroundIsTrustedAgent: lookup failed", e);
      return false;
    }
  }

  /** Public paste entrypoint — applies the same multi-line gate as the
   *  keyboard paste handler, so the macOS Edit menu and right-click menu
   *  can't bypass the paste-confirm dialog. */
  requestPaste(text: string): void {
    if (!text || this.disposed) return;
    if (text.includes("\n") && !this.terminal.modes.bracketedPasteMode) {
      void this.pasteWithAgentTrust(text);
    } else {
      this.terminal.paste(text);
    }
  }

  /** Public selection accessors so callers (Edit menu, context menu) don't
   *  need to reach into `pane.terminal` directly. */
  getSelection(): string {
    return this.terminal.getSelection();
  }

  selectAll(): void {
    this.terminal.selectAll();
  }

  /** Replace the terminal viewport with a designed error overlay. Used
   *  when the PTY can't spawn. */
  private showPaneError(title: string, body: string): void {
    const overlay = document.createElement("div");
    overlay.className = "pane-error";
    pushSpan(overlay, "pane-error-title", title);
    pushSpan(overlay, "pane-error-body", body);
    this.element.appendChild(overlay);
  }

  /** Shared scroll state update — called from both terminal.onScroll (buffer
   *  growth) and the native .xterm-viewport scroll listener (user scroll).
   *  Suppressed during programmatic scrolls (fit, scroll lock) to prevent
   *  race-induced misclassification of scroll intent. */
  private updateScrollState() {
    if (this.scrollAnchor.isFitting || this.scrollAnchor.isLocked) return;
    const buf = this.terminal.buffer.active;
    const atBottom = buf.viewportY >= buf.baseY;
    if (atBottom) {
      this.scrollAnchor.setUserScrolledUp(false);
      this.hideScrollPill();
    } else {
      this.scrollAnchor.setUserScrolledUp(true);
      // Show the pill whenever the user is scrolled up — not just when new
      // output arrives. The pill is the user's one-click escape hatch back
      // to the live tail; gating it on "new output" left users stuck
      // scrolling manually whenever they paused an idle agent's tab. (#419)
      this.showScrollPill("scrolled");
    }
  }

  /** Show the scroll pill at the bottom of the pane.
   *  @param reason  "scrolled" — user scrolled up, no new output yet.
   *                 "new-output" — new output arrived while scrolled up.
   *                 The "new-output" reason promotes an existing pill (so a
   *                 user who scrolled up first then sees output gets the
   *                 stronger label) and adds a CSS hook for visual accent. */
  private showScrollPill(reason: "scrolled" | "new-output" = "scrolled") {
    if (this.scrollPill) {
      // Pill already visible — promote label if new output arrived
      if (reason === "new-output" && !this.scrollPill.classList.contains("has-new-output")) {
        this.scrollPill.textContent = "New output \u2193";
        this.scrollPill.classList.add("has-new-output");
      }
      return;
    }
    const pill = document.createElement("div");
    pill.className = "scroll-pill";
    if (reason === "new-output") {
      pill.textContent = "New output \u2193";
      pill.classList.add("has-new-output");
    } else {
      pill.textContent = "Jump to bottom \u2193";
    }
    pill.addEventListener("click", () => {
      this.terminal.scrollToBottom();
      this.scrollAnchor.setUserScrolledUp(false);
      this.hideScrollPill();
    });
    this.element.appendChild(pill);
    this.scrollPill = pill;
  }

  private hideScrollPill() {
    if (this.scrollPill) {
      this.scrollPill.remove();
      this.scrollPill = null;
    }
  }

  /** Re-show the scroll pill if the user is still scrolled up after a
   *  tab transition.  Called from tab.show() to guarantee the user always
   *  has a one-click escape hatch when landing on a scrolled-up pane —
   *  including the case where Fix 1's distance-from-bottom clamp deposited
   *  them at a non-bottom position. (#419 Fix 4) */
  refreshScrollPill() {
    if (this.scrollAnchor.isUserScrolledUp && !this.scrollPill) {
      this.showScrollPill("scrolled");
    }
  }

  /** Render event markers in the scrollbar gutter */
  private renderGutter() {
    if (!this.eventGutter || this.disposed) return;
    const events = this.analyzer.eventHistory;
    if (events.length === 0) {
      this.eventGutter.innerHTML = "";
      return;
    }

    const totalLines = this.analyzer.totalLines > 0 ? this.analyzer.totalLines : 1;
    const gutterHeight = this.eventGutter.clientHeight;
    if (gutterHeight === 0) return;

    // Build markers — reuse DOM when possible
    const frag = document.createDocumentFragment();
    for (const evt of events) {
      const line = evt.line ?? 0;
      const pct = Math.min(1, line / totalLines);
      const top = Math.round(pct * gutterHeight);

      const marker = document.createElement("div");
      marker.className = `event-marker event-marker-${evt.type}`;
      marker.style.top = `${top}px`;
      marker.title = `${evt.type}: ${evt.detail.slice(0, 60)}`;

      // Click to scroll to approximate position
      marker.addEventListener("click", () => {
        const scrollTo = Math.max(0, line - Math.floor(this.terminal.rows / 2));
        this.terminal.scrollToLine(scrollTo);
      });

      frag.appendChild(marker);
    }

    this.eventGutter.innerHTML = "";
    this.eventGutter.appendChild(frag);
  }

  private savedScrollTop: number | null = null;

  /** Save the DOM-level scrollTop before the pane is hidden.
   *  Browsers reset scrollTop to 0 when elements leave the formatting structure.
   *  This provides defense-in-depth alongside the visibility:hidden approach. */
  saveScrollPosition() {
    const vp = this.element.querySelector(".xterm-viewport") as HTMLElement | null;
    if (vp) this.savedScrollTop = vp.scrollTop;
  }

  /** Restore the DOM-level scrollTop after the pane becomes visible.
   *  Must be called BEFORE any xterm.js operation that triggers _sync(). */
  restoreScrollPosition() {
    if (this.savedScrollTop !== null) {
      const vp = this.element.querySelector(".xterm-viewport") as HTMLElement | null;
      if (vp) vp.scrollTop = this.savedScrollTop;
      this.savedScrollTop = null;
    }
  }

  /** Acquire a scroll lock — saves the authoritative scroll position and
   *  prevents any scroll mutations during the tab show/hide transition.
   *  While locked: onScroll is suppressed, fitCore() uses the locked position,
   *  and flushWrites() corrects scroll after each write.
   *
   *  We lock **distance from the bottom**, not viewportY, because the bottom of
   *  the buffer is the only stable reference point across a hide/show cycle —
   *  scrollback trimming (#305) only ever drops oldest lines from the front,
   *  never lines near the bottom, so "N lines above the bottom" survives any
   *  legitimate buffer mutation while a tab is hidden. (#184, #419) */
  lockScroll() {
    this.scrollAnchor.lock();
  }

  /** Release the scroll lock and perform the single authoritative scroll
   *  restoration. Delegates to ScrollAnchor.unlock() — see the class-level
   *  doc on ScrollAnchor for the full semantics around the buffer-length
   *  tripwire and the hidden-trim gate. (#184, #305, #419) */
  unlockScroll() {
    this.scrollAnchor.unlock();
  }

  /**
   * Load WebGL + Image addons if not already active and element has dimensions.
   * @param force  Bypass the output-activity deferral (used during tab show).
   */
  activateWebGL(force = false) {
    if (!this.webgl) {
      this.webgl = new WebGLManager(
        this.id,
        this.terminal,
        () => this.element,
        () => this.lastOutputAt,
        () => this.disposed,
      );
    }
    this.webgl.activate(force);
  }

  deactivateWebGL(contextLost = false) {
    this.webgl?.deactivate(contextLost);
  }

  /** Read the last N lines from the terminal buffer (for content-based status detection). */
  getLastLines(count: number): string[] {
    const buf = this.terminal.buffer.active;
    const totalRows = buf.baseY + this.terminal.rows;
    const lines: string[] = [];
    for (let i = Math.max(0, totalRows - count); i < totalRows; i++) {
      const line = buf.getLine(i);
      if (line) {
        const text = line.translateToString(true).trim();
        if (text) lines.push(text);
      }
    }
    return lines;
  }

  /** Send SIGINT (Ctrl-C) to the PTY foreground process group. */
  sendInterrupt() {
    if (this.pty && !this.disposed) {
      // \x03 is Ctrl-C / ETX — the PTY driver sends SIGINT to the fg group
      this.pty.write("\x03");
    }
  }

  dispose() {
    logger.debug(`[pane.dispose] pane=${this.id} ptyPid=${this.ptyPid}`);
    this.disposed = true;
    // Cancel any deferred fit / WebGL timers and pending write RAF
    if (this.deferredFitTimer) {
      clearTimeout(this.deferredFitTimer);
      this.deferredFitTimer = null;
    }
    this.webgl?.dispose();
    this.webgl = null;
    if (this.writeRafId) {
      cancelAnimationFrame(this.writeRafId);
      this.writeRafId = 0;
      this.pendingWriteData.length = 0;
      this.pendingHead = 0;
      this.pendingBytes = 0;
      this.scrollAnchor.clearFlushAnchor();
    }
    // Dismiss any open paste confirm dialog for this pane
    this.pasteOverlay?.remove();
    this.pasteOverlay = null;
    // Remove all DOM event listeners registered with AbortController
    this.ac.abort();
    // Dispose all xterm event subscriptions
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    // Capture and null PTY ref before kill to prevent double-dispose
    // and block any further writes from terminal.onData / onResize
    const pty = this.pty;
    const ptyHandle = this.ptyHandle;
    this.pty = null;
    this.ptyHandle = null;
    if (pty) {
      this.gracefulKill(pty);
    }
    // Free the PTY session handle in the Rust plugin to prevent leak (#430)
    if (ptyHandle != null) {
      invoke("plugin:pty|close_session", { pid: ptyHandle }).catch(() => {});
    }
    this.analyzer.dispose();
    this.searchBar?.dispose();
    this.hideScrollPill();
    if (this.gutterTimer) {
      clearInterval(this.gutterTimer);
      this.gutterTimer = null;
    }
    this.terminal.dispose();
    this.element.remove();
  }

  /**
   * Gracefully shut down a PTY: SIGHUP first, then SIGKILL after a timeout.
   * This gives shells and child processes a chance to clean up.
   */
  private gracefulKill(pty: IPty) {
    let exited = false;
    const onExit = pty.onExit(() => {
      exited = true;
      onExit.dispose();
    });

    try {
      pty.kill("SIGHUP");
    } catch {
      // Already dead — nothing to do
      return;
    }

    setTimeout(() => {
      if (!exited) {
        try {
          pty.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      onExit.dispose();
    }, 2000);
  }
}
