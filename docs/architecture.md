# Architecture

A single-page tour of how ClawTerm is put together. Read this once before changing any code that touches tabs, panes, polling, the show/hide pipeline, the PTY layer, or session persistence.

> **Source-of-truth invariant.** When this document and the code disagree, the code wins. Update this page in the same commit that changes the design.

## Stack

| Layer | Tech | Why |
| --- | --- | --- |
| Desktop shell | [Tauri 2](https://v2.tauri.app/) | Native window, OS APIs, autoupdater, signing |
| Backend | Rust | Process introspection (`proc_*` on macOS), git, fs, server health checks |
| Frontend | TypeScript + Vite | Application logic, state machine, UI |
| Terminal | [xterm.js](https://xtermjs.org/) v6 | Cell rendering, scrollback, addons |
| PTY | [`tauri-pty`](https://github.com/marc2332/tauri-pty) | OS pseudo-terminal bridge |

The **only** language boundary is the Tauri IPC layer (`invoke()` from JS, `#[tauri::command]` in Rust). Everything else lives on one side or the other.

## Source layout

```
src/                           ← TypeScript frontend
├── main.ts                    ← Entry point — instantiates TerminalManager
├── terminal-manager.ts        ← Top-of-tree owner; init, polling, projects, lifecycle
├── tab.ts                     ← Tab + split tree (binary SplitNode); show/hide pipeline
├── pane.ts                    ← Single xterm.js terminal + PTY + scroll lock + write batching
├── pane-webgl.ts              ← Shared LRU pool of WebGL contexts (cap: 6)
├── output-analyzer.ts         ← Regex matching against PTY output (debounced)
├── matchers.ts                ← Default agent / server / error patterns
├── tab-state.ts               ← PaneState / TabState data shapes + helpers
├── tab-polling.ts             ← Adaptive idle-timeout math (95th-percentile output gap)
├── session.ts                 ← Load/save the V2 session JSON via Rust
├── config.ts                  ← Defaults, deepMerge, validation, reload
├── config-types.ts            ← TypeScript shape of the config schema
├── notifications.ts           ← OS notifications via @tauri-apps/plugin-notification
├── server-tracker.ts          ← Polled localhost port health checks
├── worktree-base.ts           ← resolveWorktreeBase() — the three-mode path resolver
├── worktree-actions.ts        ← Frontend worktree orchestration (dialog → IPC → tab)
├── worktree-dialog.ts         ← Branch picker UI for new worktree tabs
├── logger.ts                  ← Console-only logger with in-memory ring buffer (2000)
├── perf.ts                    ← perfMetrics — tiny instrumentation harness
└── ...                        ← UI bits: command palette, sidebar, settings, dialogs

src-tauri/src/                 ← Rust backend
├── main.rs                    ← Tauri command registration, config + session paths
├── worktree.rs                ← git worktree add/remove/lock + repo-root resolution
├── git_info.rs                ← branch + status (with caching)
├── process_info.rs            ← Batched poll_pane_info: process + cwd + git in one IPC
├── project_info.rs            ← Detect project name from package.json / Cargo.toml / go.mod
└── server_check.rs            ← TCP probe for localhost port health
```

## Object hierarchy

```
TerminalManager (singleton)
├── Project[]                       (each owns a subset of tab IDs — sidebar grouping)
├── Map<string, Tab>                (all tabs across all projects)
├── NotificationManager
├── ServerTracker                   (polls localhost ports)
├── TabRenderer                     (sidebar DOM)
└── WorkspacePanel                  (worktree list panel)

Tab
├── root: SplitNode                 (binary tree — see below)
├── panes: Pane[]                   (flat list mirror of leaves, for iteration)
├── focusedPane: Pane
├── state: TabState                 (derived from pane states each poll)
└── (per-tab polling, fit, show/hide)

SplitNode (discriminated union, src/tab.ts:32)
├── { type: "leaf", pane: Pane }
└── { type: "split", direction, ratio, children: [SplitNode, SplitNode] }

Pane
├── terminal: xterm.js Terminal
├── pty: tauri-pty IPty
├── analyzer: OutputAnalyzer        (regex matchers — feeds events back to Tab)
├── state: PaneState                (activity, agent, gitStatus, statusLine, ...)
├── webgl: WebGLManager             (lazy; LRU pool eviction)
└── (write batching, scroll lock, footer, gutter, paste confirm)
```

The **split tree** is a real binary tree. Splitting a pane replaces a `SplitLeaf` with a `SplitBranch` whose two children are the old leaf and a new one. Closing a pane collapses the branch back into its sibling. The flat `panes: Pane[]` mirror exists for fast iteration (`for (const pane of tab.panes)` is everywhere); `tab.root` is the source of truth for layout.

## Lifecycle

### Init (cold start)

`src/main.ts` instantiates `TerminalManager` and calls `await manager.init()`. The init sequence (`src/terminal-manager.ts:145`) runs in this order:

1. **Load config** from `~/.config/clawterm/config.json` (deepMerge with defaults, validate, fall back per-field on bad values)
2. **Construct subsystems** — `NotificationManager`, `ServerTracker`, `TabRenderer`, `WorkspacePanel`
3. **Apply CSS** — theme tokens injected from config
4. **Load session in parallel** with synchronous DOM setup — `loadSession()` reads `session.json` via Rust, validates the recursive split tree, normalizes V1 → V2
5. **Render shell DOM** — sidebar, titlebar, status bar, project tabs
6. **Restore tabs** — for each project, restore the active tab first (responsiveness), then the rest with rAF yields between
7. **Fall back to a fresh tab** if every restore failed
8. **Start the central poll** (`startCentralPoll()`)
9. **Fire the legacy-worktree hint** (non-blocking, async, see [Worktrees](./features/worktrees.md))

The `await manager.init()` resolves once the first tab is interactive. Polling and the legacy hint continue in the background.

### Shutdown

`src/main.ts:29` registers a `beforeunload` listener that calls `await manager.flushSession()` synchronously. This serializes the current split tree of every tab into JSON and writes it via Rust before the window closes. Session writes during normal operation are debounced (~3 s) to coalesce rapid state changes.

## The polling pipeline

There is **one** central poll loop (`startCentralPoll()` in `terminal-manager.ts`). It uses a single `setInterval` keyed off `config.advanced.pollIntervalMs` (foreground) and falls back to `backgroundPollIntervalMs` for tabs that aren't visible. Each tick:

1. **Snapshot the active tab ID** so the loop is robust against tab switches mid-poll
2. **Concurrently poll** the active tab and any background tab whose interval has elapsed
3. **Refresh xterm renderers** every ~10 ticks (recovers from silent WebGL context loss)
4. **Recompute tab snapshots** and re-render the sidebar if anything changed
5. **Update the status bar**

A single tab's poll (`Tab.pollProcessInfo()` → `pollPane()` per pane) is **two** IPC calls:

- `plugin:pty|foreground_pid` — get the shell's foreground process group via the PTY fd
- `poll_pane_info` — **batched** call returning `{ process_name, fg_pid, cwd, full_cwd, git_status, project_name, has_children }` in one round trip

This batch replaced 5–7 sequential IPC calls. After 5+ consecutive idle polls, expensive work (CWD, git, project name) is skipped via the `skipExpensive` flag.

**Agent state detection** combines two signals:

- **Process name match** (`AGENT_PROCESS_MAP` in `src/matchers.ts`) — claude, aider, copilot, cursor, codex, gemini. The TUI process name is checked even when the shell looks idle, because Claude Code etc. don't fork.
- **OSC 9;4 progress sequences** parsed by `osc-handler.ts` — the most reliable working/idle signal when the agent emits it.
- **Output regex matchers** in `output-analyzer.ts` — fallback for agents that don't speak OSC.

The **adaptive idle timeout** (`tab-polling.ts:32`) uses the 95th percentile of recent output gaps × 2, clamped to 15–60 s, to decide when an agent has actually paused versus is just thinking. When OSC is active, it falls back to a tight 5 s window because OSC is ground truth.

## The show/hide pipeline

This is the most performance-sensitive part of the codebase. Read the full prior-art trail in issues #167, #182, #184, #227, #305, and #419 before changing it. The current architecture is documented in `pane.ts:64-81` and below.

### `Tab.hide()` (`tab.ts:1322`)

1. `pane.lockScroll()` — captures `lockedDistanceFromBottom` and `lockedBufferLength` (the tripwire baseline). **Distance from bottom**, not `viewportY`, because xterm's scrollback can be trimmed under us during the hidden window (#305 / #419).
2. `pane.saveScrollPosition()` — DOM-level `scrollTop` backup; defense in depth alongside CSS `visibility: hidden`.
3. Cancel any pending show() rAF — prevents stale focus stealing.
4. `pane.setVisible(false)` — flips `tabVisible`, queues subsequent PTY data into `pendingWriteData[]` instead of flushing per frame, trims the scrollback to `HIDDEN_SCROLLBACK = 1000` lines (skipped when `userScrolledUp` is true so the user's view isn't yanked, #419 Fix 2), and pauses the gutter timer.

### `Tab.show()` (`tab.ts:1261`) — 2-frame rAF chain

The pipeline used to be 4 frames (~67 ms); collapsing it to 2 (~33 ms) is intentional and load-bearing for tab-switch responsiveness.

**Frame 1** — destabilizing operations:
1. `pane.restoreScrollPosition()` — DOM scrollTop restore
2. `pane.forceFit()` — xterm reflow to current container dimensions, bypassing the 300 ms output-activity deferral
3. `pane.setVisible(true)` — restores original scrollback cap, schedules an rAF flush of any queued PTY writes, resumes gutter timer
4. `pane.activateWebGL(true)` — picks up a context from the LRU pool (or creates one if pool isn't full)
5. `this.refreshAllPanes()` — xterm refresh

**Frame 2** — single authoritative restore:
1. `pane.unlockScroll()` — performs the **only** scroll restoration after a tab transition. Uses `lockedDistanceFromBottom` to compute the new `viewportY`. The Fix 5 invariant tripwire (`pane.ts:1108`) fires here if the buffer length changed in an unexpected way (the legitimate #305 trim is gated via `trimmedDuringHide`).
2. `pane.refreshScrollPill()` — reattaches the "jump to bottom" pill if the user is still scrolled up
3. `this.transitioning = false` — re-enables ResizeObserver fits
4. Focus the focused pane

### Why it's structured this way

Every prior fix in this lineage failed because it locked `viewportY` (an index into a buffer that the #305 path mutates underneath the lock). #419 switched to **distance from bottom** because the bottom of the buffer is the only stable reference point across a hide/show cycle: xterm only ever trims the front of the scrollback, never lines near the bottom. See `pane.ts:1071-1133` and the prior-art comment in #419 for the full archaeology.

## The PTY → xterm pipeline

`Pane.start()` (`pane.ts:453`) spawns a PTY via `tauri-pty.spawn(shell, args, opts)`, awaits `pty._init`, then captures the OS PID via `plugin:pty|child_pid`. From there:

1. `pty.onData(Uint8Array)` fires for every PTY chunk
2. **Output gap tracking** — gap duration since the previous chunk is recorded into `pane.outputGaps[]` (capped at 20) for adaptive idle timeout
3. **OSC bypass** — if the OSC handler reports `oscActive && !oscProgressActive` and the chunk is small, skip the timestamp update (the OSC stream is ground truth for activity)
4. **Feed `OutputAnalyzer`** — the analyzer accumulates a 4 KB rolling buffer, strips ANSI, runs regex matchers (debounced 100 ms), and fires `OutputEvent`s back to the Tab via `onOutputEvent`
5. **Queue the write** — the chunk is pushed onto `pendingWriteData[]` and a single `requestAnimationFrame` writes the merged buffer per frame (`flushWrites()`)

### Write batching

Without rAF batching, `terminal.write()` runs once per PTY chunk and races `fitAddon.fit()` mid-reflow. The batching:
- merges all queued chunks into a **reusable** `Uint8Array` (`mergeBuffer`, never shrinks) — avoids per-frame allocation
- uses a single `terminal.write(data, callback)` call so xterm can parse asynchronously and run our scroll-restoration in the callback (#257)
- caps queued bytes at `MAX_HIDDEN_PENDING_BYTES = 128 KB` for hidden tabs (down from 512 KB in #305) to limit memory pressure with many tabs

Hidden tabs **don't** flush — writes accumulate until `setVisible(true)` schedules a flush. This is the largest CPU win for many-tab workloads.

## Output analysis

`OutputAnalyzer` (`src/output-analyzer.ts`) runs a list of regex matchers against the PTY output stream, producing typed `OutputEvent`s that drive the tab state machine. Matchers live in `src/matchers.ts` and are grouped by purpose:

- **Agent-waiting** — detects `[Y/n]`, "Approve?", "Do you want to proceed?" etc. Triggers desktop notifications.
- **Server-started** — extracts port numbers from "listening on port NNNN" patterns. Hands off to `ServerTracker`.
- **Error** — "Address already in use", "Connection refused", and similar. Surfaces in the sidebar.
- **Agent-working** — scanned via `Tab.scanBufferForWorkingPatterns()` rather than the streaming analyzer.

Every matcher has a cooldown (5–30 s) to prevent event spam. Matchers tagged `oscSuperseded` are skipped while OSC 9;4 is reporting progress, since OSC is the higher-confidence signal.

`Tab.handleOutputEvent()` (`tab.ts:207`) is the single dispatch point. It updates `pane.state.activity` (`idle → running → agent-waiting → completed → idle`), increments action counts, stores events in `analyzer.eventHistory[]` for the gutter timeline, and calls `notifications.dispatch()` if the tab isn't currently focused.

## Rust ↔ JS boundary

Every command lives in `src-tauri/src/` and is registered in `main.rs`. Frontend calls come exclusively through `invoke()` (or `invokeWithTimeout()` from `src/utils.ts`, which adds an abort timeout). Grouped by purpose:

| Purpose | Most-used commands | Lives in |
| --- | --- | --- |
| **PTY** (plugin) | `plugin:pty|foreground_pid`, `plugin:pty|child_pid`, `plugin:pty|clear_sessions` | `tauri-pty` plugin |
| **Polling** | `poll_pane_info` (batched) | `process_info.rs` |
| **Worktree** | `create_worktree`, `lock_worktree`, `find_repo_root`, `list_branches`, `unlock_worktree`, `remove_worktree` | `worktree.rs` |
| **Git** | `get_git_branch`, `get_git_status` | `git_info.rs` |
| **Server health** | `check_port` | `server_check.rs` |
| **Persistence** | `read_session`, `write_session`, `write_config` | `main.rs` |
| **Filesystem** | `validate_dir`, `validate_shell`, `has_legacy_in_repo_worktrees` | `main.rs` |
| **Project info** | `get_project_info` | `project_info.rs` |

There is no shared state across commands beyond what each command derives from its arguments and the filesystem. All Rust handlers are stateless functions; persistence is whatever each command writes to disk.

## Session persistence

Format and behaviour:

- **Path**: `~/.config/clawterm/session.json` (macOS/Linux), `%APPDATA%\clawterm\session.json` (Windows)
- **Format**: V2 — `{ version: 2, projects: SessionProject[], activeProject: number }`. V1 (`{ tabs, activeIndex }`) is auto-wrapped into a single project on load.
- **Per-tab record**: `{ title?, cwd, splits?, pinned?, muted?, manualTitle?, worktreePath?, repoRoot? }`
- **Splits**: recursive `SessionSplitNode` mirroring the in-memory `SplitNode` tree.
- **Save cadence**: debounced 3 s during normal operation; synchronous flush on shutdown (`main.ts:29`)
- **Load**: `loadSession()` validates the split tree recursively, returns `null` on any structural error, falls through to a fresh tab.

The session does **not** persist scrollback, agent state, or any runtime data. Only structural information needed to recreate the same layout in the same cwds.

## Where to find things

| If you're touching... | Start here |
| --- | --- |
| Tabs / projects / sidebar UI | `terminal-manager.ts` |
| The split tree | `tab.ts` (look for `SplitNode`) |
| A single terminal's behaviour | `pane.ts` |
| The show/hide / scroll lock | `tab.ts:1261-1349` + `pane.ts:1071-1133` |
| Write batching, fit timing | `pane.ts:843-932` |
| Agent state detection | `output-analyzer.ts` + `matchers.ts` + `tab.ts:207` |
| Polling logic | `terminal-manager.ts` + `tab.ts:868-1011` |
| Adaptive idle math | `tab-polling.ts:32` |
| Rust-side process probing | `src-tauri/src/process_info.rs` |
| Worktrees | [`docs/features/worktrees.md`](./features/worktrees.md) |
| Config schema | `config-types.ts` (types) + `config.ts` (defaults + validation) |
| Keybinding dispatch | `keybinding-handler.ts` |
| Notifications | `notifications.ts` |

## Things to know before changing this code

- **The 2-frame rAF chain in `Tab.show()` is load-bearing.** Adding a third frame is a 30%+ regression in tab-switch latency. If you need a new step, fold it into Frame 1 (destabilizing) or Frame 2 (single authoritative restore).
- **`Pane.lockScroll()` locks distance-from-bottom, not viewportY.** Saving an absolute index is broken because the buffer length can change while the tab is hidden (#305). See `pane.ts:1071`.
- **Hidden tabs queue PTY writes — they don't drop them.** The cap is 128 KB; over the cap, oldest data is discarded. Tabs that print megabytes per second while hidden will lose history, by design.
- **Polling is centralized.** Don't add a per-tab `setInterval`. Use `startCentralPoll()` and add your work to `Tab.pollProcessInfo()`.
- **Defaults live in `config.ts`, schemas in `config-types.ts`.** Don't hardcode defaults elsewhere. `validateConfig()` falls back per-field, never refuses to start.
- **The session format is versioned.** Change `V2` → `V3` if you change the schema, and add a normalizer in `loadSession()` so old session files keep loading.
