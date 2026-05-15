# Development guide

How to be productive in the ClawTerm codebase. Aimed at new contributors and AI agents — designed so you can get to "running dev build, tests passing, know where to look" in about ten minutes.

> If you're trying to understand *what* the code does instead of *how to work on it*, start with [`architecture.md`](./architecture.md).

## Prerequisites

- **Rust** (stable) — `rustup install stable` if missing
- **Node.js 18+** (Node 24 is what CI uses)
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your distro
- **Windows**: Visual Studio Build Tools with C++ workload

Check everything works:

```bash
rustup show && node --version && npm --version
```

## First-time setup

```bash
git clone https://github.com/clawterm/clawterm.git
cd clawterm
npm install
```

`npm install` pulls JS dependencies and triggers the Tauri CLI install. The Rust toolchain doesn't fetch dependencies until the first `tauri dev` or `tauri build` run.

## Running the dev build

```bash
npm run tauri dev
```

This:

1. Starts the Vite dev server on `http://localhost:1420` (`vite.config.ts:16`, strict port — fails if 1420 is taken)
2. Compiles the Rust backend (`src-tauri/`) — first build is slow, subsequent rebuilds use `sccache` if installed
3. Launches the ClawTerm desktop app pointing at the dev server

**Hot reload behaviour**:

- ✅ **TypeScript / CSS** — instant HMR via Vite (port 1421 for HMR websocket if `TAURI_DEV_HOST` is set)
- ❌ **Rust** — no hot reload. After editing any file under `src-tauri/`, kill `npm run tauri dev` and re-run it. The Vite watcher explicitly ignores `**/src-tauri/**` (`vite.config.ts:27`) so frontend HMR isn't triggered by Rust edits.

## Tests

| Command | What it runs | Where |
| --- | --- | --- |
| `npm run test` | Vitest, all `tests/**/*.test.ts` | `vitest.config.ts` |
| `npm run test:backend` | `cargo test` in `src-tauri/` | `src-tauri/src/**/mod tests` |
| `npm run lint` | ESLint over `src/` | `eslint.config.js` |
| `npm run format:check` | Prettier check (no writes) | `package.json:27` |
| `npx tsc --noEmit` | TypeScript typecheck | `tsconfig.json` |
| `npm run preflight:frontend` | Lint + format check + Vitest + tsc, **all in parallel** | `package.json:30` |
| `npm run preflight` | `preflight:frontend` then `cargo test` | `package.json:31` |

`npm run preflight` is the gate CI runs. If you run nothing else before pushing, run this. The frontend portion is parallelized so it completes in a few seconds even on a cold cache.

A single Vitest test file:

```bash
npx vitest run tests/worktree-base.test.ts
```

A single Rust test:

```bash
cargo test --manifest-path src-tauri/Cargo.toml worktree::tests::is_inside_worktree
```

## Logging

The logger lives at [`src/logger.ts`](../src/logger.ts) and is **console-only** — there is no on-disk log file emitted by the app itself. Levels:

```
debug → info → warn → error
```

Default level is `debug`. Change at runtime from the DevTools console:

```js
logger.setLevel("info")
```

Logs are also kept in an in-memory **circular buffer of the last 2000 entries**, exposed via `logger.getBufferedLogs()` (returns the buffer as a single newline-joined string for export). This is what the "Copy debug log" command palette action uses.

**There are no log files on disk.** If you need persistent logs across sessions, copy them out of the buffer manually before reload, or pipe `stdout`/`stderr` of `npm run tauri dev` to a file.

The Tauri webview also writes its own native logs to OS-standard locations:

| Platform | Webview log dir |
| --- | --- |
| macOS | `~/Library/Logs/com.clawterm.clawterm/` |
| Windows | `%LOCALAPPDATA%\com.clawterm.clawterm\logs\` |
| Linux | `~/.local/share/com.clawterm.clawterm/logs/` |

These are mostly empty unless something crashed at the Tauri/webview layer.

## DevTools

In dev builds (`npm run tauri dev`), the Tauri webview includes Chromium DevTools. To open them:

- **macOS**: right-click → **Inspect Element**
- **Windows / Linux**: F12 (default Chromium binding)

DevTools are enabled by Tauri's default dev profile. There's no in-app keybinding to toggle them — modifying that would mean teaching the keybinding handler to call out to the Tauri webview API, which we haven't done.

In production builds DevTools are disabled. If you need to inspect a release build, build a `tauri dev` instead.

## Performance metrics

[`src/perf.ts`](../src/perf.ts) defines a tiny `perfMetrics` instance that records `count`, `total`, `max`, and `last` for any labelled timing. Existing call sites:

- `tab.show` — full show pipeline duration (`tab.ts:1318`)
- `renderTabList` — sidebar render (`terminal-manager.ts:1963`)
- ...and others scattered through the hot paths

To view the current numbers:

- **Command palette** → **"Show Performance Stats"** (logs to console)
- **DevTools console**: `perfMetrics.getSummary()`
- **Reset**: `perfMetrics.reset()`

To instrument a new code path, use the helpers from `src/perf.ts`:

```ts
import { timed, timedAsync } from "./perf";

const result = timed("my.operation", () => doExpensiveThing());
const asyncResult = await timedAsync("my.async-operation", async () => fetchSomething());
```

Or call `perfMetrics.record("label", durationMs)` directly if you have your own timing.

## Reloading config without restart

`Cmd+Shift+R` (`Ctrl+Shift+R` on Windows/Linux) — bound to `reloadConfig` in `keybindings`. Calls `TerminalManager.reloadConfig()` which:

1. Re-reads `~/.config/clawterm/config.json` from disk
2. Validates and falls back per-field on bad values
3. Re-applies CSS theme tokens
4. Calls `pane.applyConfig()` on every pane (font, cursor, scrollback, theme)
5. Restarts the central poll timer with the new interval
6. Re-renders the sidebar

Takes ~50–200 ms total. Much faster than killing and restarting the dev build.

## Where things live on disk

| Thing | macOS / Linux | Windows |
| --- | --- | --- |
| Config | `~/.config/clawterm/config.json` | `%APPDATA%\clawterm\config.json` |
| Session | `~/.config/clawterm/session.json` | `%APPDATA%\clawterm\session.json` |
| Custom themes | `~/.config/clawterm/themes/` | `%APPDATA%\clawterm\themes\` |
| Webview logs (Tauri) | `~/Library/Logs/com.clawterm.clawterm/` | `%LOCALAPPDATA%\com.clawterm.clawterm\logs\` |

Resetting ClawTerm completely:

```bash
# macOS / Linux
rm -rf ~/.config/clawterm
# Windows
Remove-Item -Recurse "$env:APPDATA\clawterm"
```

A fresh `config.json` is written on next launch.

## Build artifacts

| Build | Output |
| --- | --- |
| `npm run build` (frontend only) | `dist/` (Vite bundle) |
| `npm run tauri dev` | Runs from `dist/` and `src-tauri/target/debug/` |
| `npm run tauri build` | Bundled installer in `src-tauri/target/release/bundle/` |

Per-platform release bundles:

| Platform | Path |
| --- | --- |
| macOS | `src-tauri/target/release/bundle/dmg/Clawterm_<version>_*.dmg` |
| Windows | `src-tauri/target/release/bundle/nsis/Clawterm_<version>_x64-setup.exe` |
| Linux (deb) | `src-tauri/target/release/bundle/deb/clawterm_<version>_amd64.deb` |
| Linux (AppImage) | `src-tauri/target/release/bundle/appimage/Clawterm_<version>_amd64.AppImage` |

The Rust target dir is huge (~2 GB after a few builds). `cargo clean --manifest-path src-tauri/Cargo.toml` if you need the space.

## CI

Workflows live in `.github/workflows/`:

- **`ci.yml`** — runs on every push and PR. Frontend job (Ubuntu, Node 24): `npm run preflight:frontend`. Backend job (macOS, Windows, Linux): `cargo clippy -- -D warnings` + `cargo test`. Plus a version-sync check that asserts `package.json`, `tauri.conf.json`, and `Cargo.toml` agree.
- **`release.yml`** — triggered by pushing a `vX.Y.Z` tag. Builds and publishes the GitHub Release with macOS / Windows / Linux artifacts. See [`RELEASING.md`](../RELEASING.md) for the full release workflow.

There are no pre-commit hooks installed by `npm install`. CI is the only gate. Run `npm run preflight` locally before pushing if you want fast feedback.

## State inspection from DevTools

`TerminalManager` does **not** expose itself on `window`, so there's no `window.__clawterm` or similar global. If you need to poke at runtime state interactively:

1. Open DevTools (`Inspect Element` in dev)
2. Set a breakpoint in `src/main.ts:13` (right after `manager.init()`)
3. From the paused state, walk the closure or temporarily expose `manager` to a global:

```ts
// src/main.ts — temporary debug only, do NOT commit
const manager = new TerminalManager();
(window as any).__clawterm = manager;
await manager.init();
```

Then in DevTools:

```js
__clawterm.tabs                 // Map<string, Tab>
__clawterm.activeTabId
[...__clawterm.tabs.values()][0].panes[0].state
```

Don't commit the `window` assignment. We deliberately don't expose it in shipped builds.

## Common gotchas

These are the load-bearing invariants and surprising patterns most likely to bite a contributor.

### 1. The 2-frame show/hide rAF chain in `tab.ts:1261-1349` is performance-critical

This pipeline took **eleven** issues (#167, #182, #184, #227, #305, #419, plus earlier ones) to stabilize. Adding a third frame is a 30%+ tab-switch latency regression. Don't add work to it without folding it into Frame 1 (destabilizing operations) or Frame 2 (single authoritative restore). Read [the architecture doc's show/hide section](./architecture.md#the-showhide-pipeline) before changing it.

### 2. The scroll lock locks distance-from-bottom, not viewportY

`pane.lockScroll()` (`pane.ts:1081`) saves `lockedDistanceFromBottom`, **not** an absolute position index. This is because the hidden-tab scrollback trim from #305 mutates the buffer underneath the lock, invalidating any saved index. Distance from the bottom survives because xterm only ever trims the front of the scrollback. There's a tripwire in `unlockScroll()` that fires `logger.warn` if the buffer length changed unexpectedly during the lock window — gated via `trimmedDuringHide` so it doesn't fire on the legitimate #305 path.

### 3. Polling is centralized

All process-info polling goes through `TerminalManager.startCentralPoll()`. Don't add a per-tab `setInterval`. If you need to poll new state, add a field to the `poll_pane_info` Rust handler and consume it in `Tab.pollProcessInfo()`. Adding a parallel polling loop will silently double IPC pressure.

### 4. The WebGL pool's eviction order matters (`pane-webgl.ts`)

The shared LRU pool of WebGL contexts (cap: 6) requires that `pool.shift()` removes the victim **before** calling `victim.deactivate()`, otherwise the victim's own `pool.remove()` call inside `deactivate()` becomes a silent no-op. Easy ordering bug. Look for the `IMPORTANT` comment.

### 5. Project-switching keybindings are checked **before** tab-switching keybindings

If a user binds the same key to both `nextTab` and `nextProject` (or accidentally collides them), the project action wins. This is intentional (#410) but surprising — if a tab keybinding "doesn't fire," check whether a project binding is shadowing it.

### 6. PTY env var setup strips `CLAUDECODE`

`src-tauri/src/main.rs` removes `CLAUDECODE` from the spawn environment to prevent nested Claude Code invocation issues, and sets `TERM` / `COLORTERM` / `TERM_PROGRAM` for color rendering and agent detection in child shells. If you change PTY env handling, don't blindly inherit the parent env.

### 7. Defaults live in `config.ts`, schemas in `config-types.ts`

`validateConfig()` falls back per-field, never refuses to start because of a bad config. Don't hardcode defaults anywhere else, and don't add validation that throws — the contract is "log + replace bad fields." The full schema is documented in [`docs/reference/configuration.md`](./reference/configuration.md).

### 8. Session format is versioned

`session.json` is V2: `{ version, projects, activeProject }`. V1 (`{ tabs, activeIndex }`) is auto-wrapped on load. If you add fields to the session shape, decide whether you need to bump to V3 and add a normalizer in `loadSession()` so old session files keep loading. Breaking session compatibility silently means users lose their tab layouts on upgrade.

## Editor / LSP tips

- **VS Code**: install `rust-analyzer` and `Tauri` extensions. The TypeScript LSP picks up `tsconfig.json` from the repo root automatically.
- **JetBrains**: open the repo as a single project; both the TypeScript and Rust IDEs work side by side with no extra config.
- **Format on save**: Prettier handles TypeScript/CSS, `rustfmt` handles Rust. The repo's preflight check runs `prettier --check`, so set your editor to format on save and `npm run preflight` will pass without manual fixup.

## Ten-minute onboarding checklist

```
[ ] Install Rust + Node 18+
[ ] git clone && cd clawterm
[ ] npm install
[ ] npm run tauri dev          ← takes a few minutes the first time (Rust build)
[ ] Right-click in the app window → Inspect Element to verify DevTools
[ ] Open command palette (Cmd+Shift+P) → "Show Performance Stats" to verify metrics
[ ] In a separate terminal: npm run preflight  (must pass before push)
[ ] Read docs/architecture.md
[ ] Read docs/features/worktrees.md if you're touching worktree code
[ ] Look up the file you're editing in architecture.md's "Where to find things" table
```

If anything in this guide is wrong or missing, fix it and ship the fix. This file exists to make the next contributor's first day shorter than yours.
