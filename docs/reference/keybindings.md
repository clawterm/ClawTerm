# Keybindings

Every keybinding shipped with ClawTerm, grouped by category. The **Mod** column shows the primary modifier for your platform: `Cmd` on macOS, `Ctrl` on Windows and Linux.

All bindings marked **configurable** can be remapped in `config.json` under the `keybindings` block — see [configuration.md](./configuration.md#keybindings). Hardcoded bindings cannot be changed.

Source of truth: [`src/config.ts`](../../src/config.ts) (defaults) and [`src/keybinding-handler.ts`](../../src/keybinding-handler.ts) (dispatch logic).

## Tabs

| Action | Default | Config key | Notes |
| --- | --- | --- | --- |
| New tab | `Mod+T` | `newTab` | |
| Close active tab | `Mod+W` | `closeTab` | |
| Restore last closed tab | `Mod+Shift+T` | `restoreTab` | |
| Next tab | `Mod+Shift+]` | `nextTab` | |
| Previous tab | `Mod+Shift+[` | `prevTab` | |
| Next tab (alt) | `Mod+↓` | — | Hardcoded |
| Previous tab (alt) | `Mod+↑` | — | Hardcoded |
| Switch to tab 1–9 | `Mod+1` … `Mod+9` | — | Hardcoded |
| Quick tab switcher | `Mod+P` | `quickSwitch` | Fuzzy-find across tabs |
| Cycle tabs needing attention | `Mod+Shift+A` | `cycleAttention` | Jumps between tabs whose agent is waiting |

## Split panes

| Action | Default | Config key | Notes |
| --- | --- | --- | --- |
| Split horizontally | `Mod+D` | `splitHorizontal` | |
| Split vertically | `Mod+Shift+D` | `splitVertical` | |
| Close active pane | `Mod+Shift+W` | `closePane` | |
| Focus next pane | `Mod+]` | `focusNextPane` | |
| Focus previous pane | `Mod+[` | `focusPrevPane` | |
| Focus pane 1–9 | `Mod+Alt+1` … `Mod+Alt+9` | — | Hardcoded |
| Resize pane | `Mod+Shift+←↑→↓` | — | Hardcoded |

## Projects

| Action | Default | Config key | Notes |
| --- | --- | --- | --- |
| Next project | `Mod+Alt+]` | `nextProject` | |
| Previous project | `Mod+Alt+[` | `prevProject` | |
| New project | *(unbound)* | `newProject` | Set in `config.json` to enable |

## Worktrees

| Action | Default | Config key | Notes |
| --- | --- | --- | --- |
| New worktree tab | `Mod+Shift+N` | `newWorktreeTab` | Opens the worktree dialog |
| Toggle workspace panel | `Mod+Shift+B` | `toggleWorkspacePanel` | |
| Jump to branch | `Mod+Shift+G` | `jumpToBranch` | |

## Search and palette

| Action | Default | Config key | Notes |
| --- | --- | --- | --- |
| Toggle in-terminal search | `Mod+F` | `search` | |
| Command palette | `Mod+Shift+P` | `commandPalette` | All actions, fuzzy-searchable |
| Open settings | `Cmd+,` | — | Hardcoded, **macOS only** |

## Zoom

| Action | Default | Config key | Notes |
| --- | --- | --- | --- |
| Zoom in | `Mod+=` | `zoomIn` | Also matches `Mod+Shift+=` / `Mod++` |
| Zoom out | `Mod+-` | `zoomOut` | |
| Reset zoom | `Mod+0` | `zoomReset` | |

## Miscellaneous

| Action | Default | Config key | Notes |
| --- | --- | --- | --- |
| Reload config | `Mod+Shift+R` | `reloadConfig` | Picks up edits to `config.json` without restarting |

## Quick commands

Quick commands are user-defined keybindings that **type a string into the active pane** instead of triggering an action. They live in `config.json` under `quickCommands` as `{ "binding": "text to type" }` pairs.

| Default binding | Text typed | Purpose |
| --- | --- | --- |
| `Mod+Shift+C` | `claude --dangerously-skip-permissions\n` | Launch Claude Code with permission prompts suppressed |

See [configuration.md](./configuration.md#quickcommands) for the full format and more examples.

## Binding format

Keybindings are strings of the form `modifier+modifier+key`, lowercase, joined with `+`:

- **Modifiers:** `cmd`, `ctrl`, `shift`, `alt` (`opt` is accepted as an alias for `alt`)
- **Keys:** single characters (`a`–`z`, `0`–`9`), punctuation (`[`, `]`, `=`, `-`, `,`, `.`, `/`, `;`, `'`, `` ` ``, `\`), or arrow keys
- `cmd` maps to the Meta key (⌘ on macOS); `ctrl` maps to Control. They are treated as **distinct** modifiers, so a binding that uses `cmd` will not fire on a `Ctrl` press.

Shifted punctuation is handled automatically: a binding of `cmd+=` also matches `Cmd+Shift+=` (which produces `+` on most layouts).

Invalid keybinding strings are logged and reset to the default for that action.
