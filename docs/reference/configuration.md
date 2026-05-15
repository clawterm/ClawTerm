# Configuration

ClawTerm reads its configuration from a single JSON file:

| Platform | Path |
| --- | --- |
| macOS / Linux | `~/.config/clawterm/config.json` |
| Windows | `%APPDATA%\clawterm\config.json` |

The file is created with defaults the first time ClawTerm launches. Reload it at runtime with **`Mod+Shift+R`** (or restart the app).

**Source of truth:** [`src/config-types.ts`](../../src/config-types.ts) (schema) and [`src/config.ts`](../../src/config.ts) (defaults and validation).

## Top-level structure

```json
{
  "configVersion": 2,
  "shell": "/bin/zsh",
  "shellArgs": ["--login"],
  "font": { ... },
  "cursor": { ... },
  "scrollback": 5000,
  "copyOnSelect": false,
  "sidebar": { ... },
  "keybindings": { ... },
  "quickCommands": { ... },
  "startupCommands": { ... },
  "maxTabs": 20,
  "maxPanes": 8,
  "outputAnalysis": { ... },
  "notifications": { ... },
  "updates": { ... },
  "worktree": { ... },
  "advanced": { ... }
}
```

Unknown fields are ignored. Invalid values are logged and replaced with the default for that field — ClawTerm will not refuse to start because of a bad config.

## Shell

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `shell` | `string` | `/bin/zsh` (macOS/Linux), `powershell.exe` (Windows) | Absolute path to the shell binary. If the path is missing or not executable, ClawTerm falls back to the platform default and shows a toast. |
| `shellArgs` | `string[]` | `["--login"]` (POSIX), `["-NoLogo"]` (PowerShell), `[]` (cmd), `["-l"]` (nu/nushell) | Arguments passed to the shell on launch. Auto-derived from the shell name if you set `shell` but omit `shellArgs`. |

## Font

| Key | Type | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `font.family` | `string` | `"JetBrains Mono Variable", "JetBrains Mono", monospace` | — | CSS font stack used by xterm. |
| `font.size` | `number` | `14` | `6`–`72` | Font size in pixels. |
| `font.lineHeight` | `number` | `1.3` | `0.5`–`3` | Line-height multiplier. |

## Cursor

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `cursor.style` | `"bar" \| "block" \| "underline"` | `"bar"` | Cursor shape. |
| `cursor.blink` | `boolean` | `false` | Whether the cursor blinks. |

## Terminal behaviour

| Key | Type | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `scrollback` | `number` | `5000` | `100`–`100000` | Number of scrollback lines kept per pane. |
| `copyOnSelect` | `boolean` | `false` | — | Copy selected text to the clipboard automatically. |

## Sidebar

| Key | Type | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `sidebar.width` | `number` | `200` | `100`–`600` | Sidebar width in pixels. |
| `sidebar.position` | `"left" \| "right"` | `"left"` | — | Which side the sidebar appears on. |

## Keybindings

Every configurable keybinding lives under `keybindings`. See [keybindings.md](./keybindings.md) for the full shortcut table and default values.

The format is `modifier+modifier+key`, lowercase, joined with `+`. Example:

```json
{
  "keybindings": {
    "newTab": "cmd+t",
    "closeTab": "cmd+w",
    "splitHorizontal": "cmd+d"
  }
}
```

Set a key to `""` (empty string) to disable that binding. Invalid formats are logged and reset to the default.

Available keys (all string): `newTab`, `closeTab`, `nextTab`, `prevTab`, `reloadConfig`, `cycleAttention`, `search`, `quickSwitch`, `splitHorizontal`, `splitVertical`, `closePane`, `focusNextPane`, `focusPrevPane`, `commandPalette`, `zoomIn`, `zoomOut`, `zoomReset`, `restoreTab`, `nextProject`, `prevProject`, `newProject`, `newWorktreeTab`, `toggleWorkspacePanel`, `jumpToBranch`.

## quickCommands

User-defined bindings that **type a string into the active pane** instead of triggering an action. Format: `{ "binding": "text to type" }`. Use `\n` to submit.

```json
{
  "quickCommands": {
    "cmd+shift+c": "claude --dangerously-skip-permissions\n",
    "cmd+shift+g": "git status\n"
  }
}
```

Default: a single entry binding `Mod+Shift+C` to launch Claude Code.

## startupCommands

Commands typed into new panes automatically when they open, keyed by tab title or pattern. String values only.

```json
{
  "startupCommands": {
    "work": "cd ~/work && ls\n"
  }
}
```

Default: empty.

## Limits

| Key | Type | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `maxTabs` | `number` | `20` | — | Maximum simultaneous tabs. |
| `maxPanes` | `number` | `8` | `1`–`16` | Maximum panes per tab. |

## outputAnalysis

Controls the engine that detects agent state, server activity, and errors from terminal output.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `outputAnalysis.enabled` | `boolean` | `true` | Turn the analyzer on or off. Disabling hides live tab status and notifications. |
| `outputAnalysis.bufferSize` | `number` | `4096` | Bytes of rolling output kept per pane for matching. |
| `outputAnalysis.customMatchers` | `UserMatcher[]` | `[]` | User-defined regex matchers (see below). |
| `outputAnalysis.showEventGutter` | `boolean` | `false` | Show event markers in the scrollbar gutter. |

### UserMatcher format

```json
{
  "id": "my-custom-waiting-pattern",
  "pattern": "waiting for your input",
  "type": "agent-waiting",
  "cooldownMs": 2000
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | yes | Unique identifier. |
| `pattern` | `string` | yes | Regex to match against recent terminal output. |
| `type` | `"agent-waiting" \| "agent-working" \| "server-started" \| "server-crashed" \| "error" \| "agent-completed"` | yes | Event type to emit when the pattern matches. |
| `cooldownMs` | `number` | no | Minimum milliseconds between re-fires of the same matcher. |

## notifications

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `notifications.enabled` | `boolean` | `true` | Master switch. Disabling silences everything. |
| `notifications.sound` | `boolean` | `true` | Master sound switch. Disabling mutes all tones while leaving notifications on. |
| `notifications.types.completion.enabled` | `boolean` | `true` | Notify when a command finishes in a background tab. |
| `notifications.types.completion.sound` | `boolean` | `false` | Play a tone on completion. |
| `notifications.types.agentWaiting.enabled` | `boolean` | `true` | Notify when an agent is waiting for input. |
| `notifications.types.agentWaiting.sound` | `boolean` | `true` | Two-tone chime on agent-waiting. |
| `notifications.types.serverStarted.enabled` | `boolean` | `true` | Notify when a server starts. |
| `notifications.types.serverStarted.sound` | `boolean` | `false` | — |
| `notifications.types.serverCrashed.enabled` | `boolean` | `true` | Notify on server crash. |
| `notifications.types.serverCrashed.sound` | `boolean` | `true` | Low alert tone. |
| `notifications.types.error.enabled` | `boolean` | `true` | Notify on detected error output. |
| `notifications.types.error.sound` | `boolean` | `false` | — |

Notifications are suppressed for the currently focused tab when the app window is visible.

## updates

| Key | Type | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `updates.autoCheck` | `boolean` | `true` | — | Check for updates automatically on launch and periodically. |
| `updates.checkIntervalMs` | `number` | `3_600_000` (1 hour) | `300_000`–`86_400_000` (5 min – 24 h) | How often to poll for updates. |
| `updates.autoInstall` | `boolean` | `false` | — | Silently install updates instead of prompting. |

## worktree

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `worktree.directory` | `string` | `""` | Where new worktrees are created. See [Worktree directory modes](#worktree-directory-modes) below for the three accepted forms. |
| `worktree.postCreateHooks` | `string[]` | `[]` | Shell commands run after a worktree is created, in order. |
| `worktree.autoCleanup` | `boolean` | `false` | Delete the worktree when its tab closes. |
| `worktree.defaultAgent` | `string` | `""` | Command to launch automatically when a new worktree tab opens (e.g. `claude`). Empty means no auto-launch. |

### Worktree directory modes

`worktree.directory` is interpreted by [`src/worktree-base.ts`](../../src/worktree-base.ts) at worktree-creation time. There are three modes; the resolver picks one based on the shape of the string:

| Value | Resolves to | When to use |
| --- | --- | --- |
| `""` (default) | `<parent-of-repo>/.clawterm-worktrees/<repo-name>/` | **Auto.** Sibling-of-repo, hidden, namespaced by repo name. The default since #416 — keeps worktree config files outside the main repo so Biome / Vitest / tsc / ESLint don't discover them and break parent-repo tooling (#415). |
| `"/abs/path"` or `"~/path"` | `<expanded>/<repo-name>/` | **Absolute.** A central worktree cache shared across repos. Tilde expands to `$HOME`; only `~` and `~/foo` forms are supported (POSIX `~user` shorthand is not — those fall through to legacy mode). |
| `"foo"` or `".foo"` | `<repo-root>/foo/` | **Legacy in-repo.** Preserved for users with a reason to opt back in (shared `node_modules`, IDE workspace scope). **Not recommended** — it's the layout that broke parent-repo tooling in #415. |

Existing worktrees from previous installs continue to work — the resolver only runs at *creation* time, and existing worktree paths are stored as absolute paths in the session file. The first time you launch with the new default and have legacy in-repo worktrees, ClawTerm shows a one-time toast pointing this out.

## advanced

Internal timing knobs. Don't touch these unless you know why you're touching them.

| Key | Type | Default | Range | Description |
| --- | --- | --- | --- | --- |
| `advanced.pollIntervalMs` | `number` | `1000` | `500`–`30000` | Foreground pane poll interval. |
| `advanced.backgroundPollIntervalMs` | `number` | `5000` | `1000`–`60000` | Background pane poll interval. |
| `advanced.healthCheckIntervalMs` | `number` | `10000` | `2000`–`120000` | Agent health check interval. |
| `advanced.completedFadeMs` | `number` | `5000` | `1000`–`30000` | How long a "completed" badge stays highlighted before fading. |
| `advanced.ipcTimeoutMs` | `number` | `5000` | `2000`–`30000` | Timeout for Tauri IPC calls. |

## configVersion and migrations

`configVersion` is an integer that lets ClawTerm migrate older configs forward when the schema changes. Don't edit it by hand — ClawTerm writes the current version on save and runs migrations automatically on load.

Current version: **2**.

| From | To | Migration |
| --- | --- | --- |
| 0 | 1 | Adds `configVersion` and the `updates` section |
| 1 | 2 | Bumps `updates.checkIntervalMs` from `60_000` (1 min) to `3_600_000` (1 h) if still at the old aggressive default |
