# Clawterm

[![CI](https://github.com/clawterm/clawterm/actions/workflows/ci.yml/badge.svg)](https://github.com/clawterm/clawterm/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/clawterm/clawterm)](https://github.com/clawterm/clawterm/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A terminal for running many AI agents at once and keeping track of them.

![Clawterm](docs/screenshots/clawterm.png)

Vertical tabs with live agent status, split panes, per-pane context tracking, desktop notifications, and auto-updates. Built with [Tauri 2](https://v2.tauri.app/) + [xterm.js](https://xtermjs.org/).

📖 **Docs:** <https://clawterm.github.io/clawterm/docs/>

## Install

Clawterm is **macOS only** (Apple Silicon and Intel).

```bash
curl -fsSL https://raw.githubusercontent.com/clawterm/clawterm/main/install.sh | bash
```

Or grab the universal DMG manually from the [latest release](https://github.com/clawterm/clawterm/releases/latest). Updates are automatic.

> **macOS note:** You may need `xattr -cr /Applications/Clawterm.app` to clear the quarantine flag until Apple notarization is set up.

## Highlights

- **Live tab status** — see which agents are idle, running, waiting for input, or errored without clicking through tabs
- **Desktop notifications** — get notified when agents need input or long commands finish
- **Split panes** — `Cmd+D` / `Cmd+Shift+D` to split horizontally or vertically
- **Command palette** — `Cmd+Shift+P` for quick access to all actions
- **Git worktrees** — run agents on isolated branches from a single project
- **Auto-updates** — built-in update checker with release notes and silent install option
- **Settings page** — shortcuts reference, version info, and update controls
- **Fully configurable** — config at `~/.config/clawterm/config.json`, all keybindings remappable

## Where worktrees live

By default, Clawterm creates new git worktrees in a sibling directory next to your repo, namespaced by repo name:

```
~/Code/
├── myrepo/                              ← your main repo (working tree untouched)
│   └── .git/
└── .clawterm-worktrees/                 ← sibling, hidden, namespaced
    └── myrepo/
        ├── feature-x-wt-1/              ← actual worktrees
        └── feature-y-wt-2/
```

This isolation is deliberate: tools that walk a repo (Biome, Vitest, tsc, ESLint) would otherwise discover the worktrees' copies of your root config files (`biome.jsonc`, `vitest.config.mts`, etc.) and break your pre-commit hooks, double-run tests, or refuse to start. Sibling worktrees stay structurally invisible to anything invoked from the main repo (#415).

You can override the default with `worktree.directory` in `~/.config/clawterm/config.json`:

| Value | Resolves to | Use case |
|---|---|---|
| `""` (default) | `<parent-of-repo>/.clawterm-worktrees/<repo-name>/` | Most users — just works |
| `"/Users/me/.cache/wt"` | `/Users/me/.cache/wt/<repo-name>/` | Central worktree cache |
| `"~/wt"` | `~/wt/<repo-name>/` | Same, with tilde expansion |
| `".clawterm-worktrees"` | `<repo-root>/.clawterm-worktrees/` | **Legacy in-repo** — opt-in only, breaks tools that walk the repo |

Existing worktrees from older installs continue to work — the resolver only runs at *creation* time, and existing worktree paths are stored as absolute paths in your session.

## Build from Source

```bash
git clone https://github.com/clawterm/clawterm.git && cd clawterm
npm install && npm run tauri dev
```

Requires [Rust](https://rustup.rs/) and [Node.js](https://nodejs.org/) 18+.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports: [open an issue](https://github.com/clawterm/clawterm/issues).

## License

[MIT](LICENSE)
