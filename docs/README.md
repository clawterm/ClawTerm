# Clawterm documentation

Documentation for Clawterm — a terminal for running many AI agents at once and keeping track of them.

> **Scope:** this is the in-repo reference for humans reading on GitHub or in an editor, and for AI agents assisting with the codebase. It is not a marketing site. For the project overview and screenshots, see the top-level [`README.md`](../README.md).

## What Clawterm is

Clawterm is a Tauri + xterm.js desktop terminal that treats AI coding agents as first-class citizens. Vertical tabs show live agent status (idle / running / waiting / errored) so you can fan out many Claude Code or similar sessions and glance at them without clicking through each one. It adds split panes, git worktrees, desktop notifications, a command palette, and auto-updates on top of a plain terminal emulator.

## How to read these docs

Pick the section that matches what you're doing:

### Getting started
Start here if you've never run Clawterm before, or you need to update or reinstall.

- **[Installation and updates](./getting-started/installation.md)** — install on macOS, verify checksums, control auto-updates, uninstall cleanly

### Reference
Exhaustive lookup tables. Read top-to-bottom once, then skim as needed.

- **[Configuration](./reference/configuration.md)** — every key in `config.json`: type, default, range, and description
- **[Keybindings](./reference/keybindings.md)** — every shortcut, grouped by category, with the config key to remap it

### Features
Per-feature guides covering the user-facing model, end-to-end flow, config keys, and maintainer file:line lookups for one feature at a time.

- **[Worktrees](./features/worktrees.md)** — per-agent isolated branches: the resolver's three modes, creation flows, locking, lifecycle, persistence, migration from the legacy in-repo layout

More feature pages tracked in [#408](https://github.com/clawterm/clawterm/issues/408). Planned: `projects.md`, `split-panes.md`, `agent-detection.md`.

### For contributors and AI agents working on the codebase

- **[Architecture](./architecture.md)** — single-page system overview: TerminalManager → Tab → SplitNode → Pane hierarchy, init/shutdown lifecycle, polling pipeline, show/hide rAF chain with scroll lock invariants, PTY → xterm pipeline, Rust ↔ JS boundary, "where to find things" lookup table
- **[Development guide](./development.md)** — 10-minute onboarding: dev build, tests, logging, DevTools, perfMetrics, disk paths, common gotchas (the load-bearing invariants you should know before changing code)

## Quick facts

| Thing | Answer | Source |
| --- | --- | --- |
| Config file | `~/.config/clawterm/config.json` | [configuration.md](./reference/configuration.md) |
| Reload config without restart | `Mod+Shift+R` | [keybindings.md](./reference/keybindings.md) |
| Primary modifier | `Cmd` (macOS-only) | [`src/utils.ts`](../src/utils.ts) |
| Command palette | `Mod+Shift+P` | [keybindings.md](./reference/keybindings.md) |
| Update check interval default | 1 hour | [configuration.md → updates](./reference/configuration.md#updates) |
| Default worktree directory | `<parent-of-repo>/.clawterm-worktrees/<repo-name>/` (sibling, namespaced) | [configuration.md → worktree](./reference/configuration.md#worktree) |
| License | MIT | [`LICENSE`](../LICENSE) |

## For AI agents

If you're an AI assistant reading this tree:

- **This file (`docs/README.md`) is the entry point.** Follow the links above before reading individual files.
- **Read [`architecture.md`](./architecture.md) before changing any non-trivial code.** It's the single-page map of how everything fits together — object hierarchy, lifecycle, polling, the show/hide pipeline, the PTY layer, the Rust ↔ JS boundary, and the load-bearing invariants you'll regret breaking.
- **Read [`development.md`](./development.md) before your first edit.** It covers the dev build, tests, logging, DevTools, common gotchas, and a 10-minute onboarding checklist.
- The docs are **Markdown-only, single source of truth.** There is no generated HTML, no `llms.txt`, and no `llms-full.txt`. The landing page assets in `docs/index.html`, `docs/favicon.*`, `docs/sitemap.xml`, and `docs/screenshots/` are unrelated to the documentation tree and should not be treated as documentation.
- **Defaults and schemas live in source.** When a doc page and the code disagree, the code is authoritative. Primary sources:
  - `src/config-types.ts` — config schema
  - `src/config.ts` — config defaults and validation
  - `src/terminal-manager.ts` — top-of-tree owner; init, polling, projects, lifecycle
  - `src/tab.ts` — tab + split tree + show/hide pipeline
  - `src/pane.ts` — single terminal + PTY + scroll lock + write batching
  - `src/keybinding-handler.ts` — keybinding dispatch
  - `src/notifications.ts` — notification config and dispatch
  - `src/worktree-base.ts` — worktree path resolver (three modes)
  - `src-tauri/src/worktree.rs` — Rust git-worktree handlers
- **The top-level [`README.md`](../README.md) is the project pitch.** The top-level [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`RELEASING.md`](../RELEASING.md), and [`CHANGELOG.md`](../CHANGELOG.md) cover contribution, release process, and version history respectively.

## Troubleshooting

Short answers to the most common issues. If none of these match, file an issue with steps to reproduce: <https://github.com/clawterm/clawterm/issues>.

### macOS: "Clawterm can't be opened because Apple cannot check it for malicious software"

Clawterm isn't notarized yet. Clear the quarantine flag once:

```bash
xattr -cr /Applications/Clawterm.app
```

Tracking: [#378](https://github.com/clawterm/clawterm/issues/378).

### My config changes aren't taking effect

Either reload the config with **`Mod+Shift+R`** or restart Clawterm. If a field was rejected as invalid, check the developer console — Clawterm logs every rejected field and the reason, then falls back to the default for that field (the rest of your config is still applied).

### A keybinding isn't firing

Possible causes:

1. The binding uses a format Clawterm doesn't recognize — check the rules in [keybindings.md → Binding format](./reference/keybindings.md#binding-format). Invalid bindings are reset to the default on load.
2. Two bindings collide. Project-switching shortcuts (`nextProject` / `prevProject`) are checked **before** tab-switching shortcuts, so sharing a binding between them means the project action wins.
3. The binding is handled by the OS or the shell instead of Clawterm. Try a different combo.
4. The binding is one of the hardcoded ones (`Cmd+,`, `Mod+Arrow`, `Mod+Shift+Arrow`, `Mod+1–9`, `Mod+Alt+1–9`) — these can't be remapped.

### The shell I set in `config.json` is being ignored

Clawterm validates the shell path at startup. If the path doesn't exist or isn't executable, it logs a warning, shows a toast, and falls back to `/bin/zsh`. Check that the path is absolute and the binary is executable.

### Agent status isn't updating / I'm not getting notifications

- Make sure `outputAnalysis.enabled` is `true` in `config.json` — the tab state detector depends on it.
- Make sure `notifications.enabled` is `true` and the specific notification type (`notifications.types.agentWaiting.enabled`, etc.) is on.
- Notifications are **intentionally suppressed** for the currently focused tab when the app window is visible. Background the tab (or the app) to see them.
- On first launch Clawterm asks for notification permission. If you denied it, re-grant it in your OS notification settings.

### Auto-update isn't finding a new version

- Check `updates.autoCheck` is `true` and `updates.checkIntervalMs` is within the `5 min – 24 h` range. Values outside this range are clamped.
- Trigger a manual check from the settings page.
- If the update dialog never appears even when a newer version exists, look in `~/Library/Logs/clawterm/`.

### I broke my config and Clawterm won't start properly

Clawterm is designed to **never refuse to start** because of a bad config — it logs rejected fields and falls back to defaults for those fields only. If you want to start fresh, delete the config file and relaunch:

```bash
rm ~/.config/clawterm/config.json
```

A fresh `config.json` is written on next launch with all defaults.
