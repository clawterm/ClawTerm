# Worktrees

ClawTerm uses [git worktrees](https://git-scm.com/docs/git-worktree) to give each agent its own working directory and branch on the same repository, without the cost of a fresh clone or the friction of `git stash`/`git checkout`. This page is the single source of truth for how worktrees work in the app.

> **TL;DR** — `Cmd+Shift+N` opens the new-worktree dialog, picks (or creates) a branch, and opens a tab in `<parent-of-repo>/.clawterm-worktrees/<repo-name>/<branch>/`. The location is configurable via `worktree.directory`. Existing worktrees from older installs continue to work unchanged.

## Why worktrees

Running multiple coding agents against the same repo means each one needs:

- **Its own branch** — agents shouldn't fight over a single working tree
- **Its own filesystem state** — file edits, build artifacts, dependency installs all need to be isolated
- **Fast startup** — fresh `git clone` is too slow to do interactively per agent

`git worktree` is the right primitive: it creates a second working directory backed by the same `.git`, so branches and history are shared but file state is isolated. ClawTerm wraps the lifecycle (create / lock / unlock / remove) and resolves the location automatically.

## Where worktrees live

The default since [#416](https://github.com/clawterm/clawterm/issues/416) is **sibling-of-repo, namespaced by repo name**:

```
~/Code/
├── myrepo/                              ← your main repo (working tree untouched)
│   └── .git/
└── .clawterm-worktrees/                 ← sibling, hidden, namespaced
    └── myrepo/
        ├── feature-x-wt-1/              ← actual worktrees
        └── feature-y-wt-2/
```

This isolation is **not cosmetic**. The previous default put `.clawterm-worktrees/` *inside* the main repo, which broke every tool that walks the repo from the root: Biome, Vitest, tsc, ESLint, Prettier all discovered the worktrees' copies of `biome.jsonc`, `vitest.config.mts`, etc., and either crashed pre-commit hooks or doubled-ran tests against the wrong tree. The sibling layout makes the worktrees structurally invisible to anything invoked from the main repo. Full background in [#415](https://github.com/clawterm/clawterm/issues/415).

### The three resolver modes

`worktree.directory` in `~/.config/clawterm/config.json` is interpreted by [`src/worktree-base.ts`](../../src/worktree-base.ts) at worktree-creation time. The string's shape selects one of three modes:

| Mode | Trigger | Resolves to | Use case |
| --- | --- | --- | --- |
| **Auto** (default) | `""` | `<parent-of-repo>/.clawterm-worktrees/<repo-name>/` | Most users — just works |
| **Absolute** | `"/abs/path"` | `<abs-path>/<repo-name>/` | Central worktree cache shared across repos |
| **Tilde** | `"~"` or `"~/foo"` | `<expanded>/<repo-name>/` | Same as absolute, with `$HOME` expansion |
| **Legacy in-repo** | `"foo"` or `".foo"` | `<repo-root>/foo/` | **Opt-in only** — breaks parent-repo tooling, see #415 |

**Auto mode fallbacks** (rare): if the repo is at the filesystem root (`/repo` — no parent dir to write to) or the parent isn't writable, the resolver falls back to `~/.clawterm-worktrees/<repo-name>/`. The parent-writable check is a no-op in production (returns true) and only the parent-empty case actually triggers the fallback; tests inject the probe via `ResolveWorktreeBaseOptions.isWritable`.

**Tilde edge case**: only `"~"` and `"~/foo"` are recognized as home expansions. POSIX `~user` shorthand (another user's home) is **not** supported — it falls through to legacy mode so the literal `~user` appears under the repo root and the misconfiguration is visible. See [test cases](../../tests/worktree-base.test.ts).

## Creating a worktree

Two entry points, both defined in `src/worktree-actions.ts`:

### `Cmd+Shift+N` — new worktree tab

Keybinding: `newWorktreeTab` (configurable in `keybindings.newWorktreeTab`). Opens [`showWorktreeDialog`](../../src/worktree-dialog.ts) with:

- **Branch picker** — search-as-you-type over all local + remote branches, with `• has worktree` annotations on branches that already have one
- **Create-new-branch panel** — appears when you type a name that doesn't match any existing branch; lets you pick a base branch (defaults to `main` or `master`)
- **Agent launcher** — optional command to run automatically in the new tab once the worktree is ready (e.g. `claude`); defaults to `worktree.defaultAgent`
- **Cancel / Create Tab** buttons

On submit, `createAgentTab()` runs:

1. `invoke("create_worktree", ...)` — Rust does `git worktree add` (see below)
2. `invoke("lock_worktree", ...)` — locks the worktree against accidental `git worktree remove`
3. `ctx.createTab(worktreeDir)` — opens a new tab with the worktree as cwd
4. Stores `worktreePath` and `repoRoot` on the tab and its initial pane
5. Runs `worktree.postCreateHooks` in order, with 500 ms gaps
6. Optionally runs the agent launcher command after another 300 ms

### `Cmd+D` / `Cmd+Shift+D` → split-to-branch

The split shortcuts call `splitWithChoice()` which detects whether the focused pane's cwd is in a git repo. If yes, you get a small choice dialog: **same branch** (regular split, both panes share state) or **new worktree** (split into a freshly-created worktree on a new branch).

The "new worktree" path runs `openSplitToBranchDialog()`, which:

1. Detects the current branch via `get_git_branch`
2. Strips any `-wt-N` suffix to prevent stacking like `main-wt-1-wt-1` (#351)
3. Generates a unique branch name `<root>-wt-1`, `<root>-wt-2`, etc., by checking against `list_branches`
4. Resolves the worktree base via `resolveWorktreeBase()`
5. Calls `splitToBranch()` which runs the same Rust IPC sequence as above and then splits the focused pane into the new worktree

Command palette also exposes both flows: **"New Agent Tab on Branch"**, **"Split Right → Worktree"**, **"Split Down → Worktree"**.

## What `create_worktree` does

[`src-tauri/src/worktree.rs:107`](../../src-tauri/src/worktree.rs) is the Rust handler. It:

1. **Refuses to nest** — calls `is_inside_worktree(repo_dir)` which compares `git rev-parse --git-dir` against `--git-common-dir` (combined into a single subprocess call). If they differ, the caller is inside a worktree, and creation is rejected with a clear error: *"Refusing to create a worktree from inside another worktree. Open a tab in the main repository first."* This is defense in depth on top of [#351](https://github.com/clawterm/clawterm/issues/351)'s `find_repo_root` fix.
2. **Creates the parent directory** — `std::fs::create_dir_all()` for whatever directory will hold the new worktree
3. **Runs `git worktree add`** — with `-b <branch>` if `createBranch` is true, otherwise checking out an existing branch
4. **Returns the worktree path** on success, or git's stderr on failure

The frontend calls this through `invokeWithTimeout("create_worktree", ..., 10000)` so the IPC has a 10 s upper bound.

## Locking

After creation succeeds, the frontend immediately calls `invoke("lock_worktree", ...)`. This runs `git worktree lock --reason "In use by ClawTerm"` on the new worktree. The lock prevents `git worktree remove` (without `--force`) from succeeding — protection against an agent or script in another pane accidentally deleting the worktree someone else is editing.

The lock is **released** in three places:

- **Tab close with `autoCleanup: true`** — `unlockAndRemoveWorktree()` unlocks then removes
- **Tab close with `autoCleanup: false`** (default) — `unlockWorktree()` unlocks but leaves the worktree on disk for manual cleanup later
- **Split-to-branch failure rollback** — if creating the worktree succeeded but the actual split failed (pane limit, PTY error), the worktree is unlocked and force-removed in `splitToBranch()`'s cleanup branch

`lock_worktree` and `unlock_worktree` both treat "already locked" / "not locked" as benign no-ops, so re-running them is safe.

## Tab close lifecycle

When a tab containing a worktree pane is closed (`Tab.onPaneClose` callback in `terminal-manager.ts`):

1. **Sibling check** — does another pane in the same tab still use this worktree? If yes, do nothing.
2. **Cross-tab check** — does another tab still use this worktree (`isWorktreeInUse()` in `worktree.rs`)? If yes, do nothing.
3. **`autoCleanup` check** — if the config flag is `true`, run `unlockAndRemoveWorktree()`. If `false` (default), just `unlockWorktree()` so the directory survives for manual cleanup.

`autoCleanup` defaults to `false` because deleting an active worktree is a destructive operation ClawTerm can't always tell apart from "the user is just closing the tab to free a slot in the sidebar." Set it to `true` only if your workflow is "agent finishes → I'm done with this branch."

## Persistence

Worktree metadata is persisted on a per-tab and per-pane basis in [`session.json`](../../src/session.ts):

```jsonc
// SessionTab
{
  "title": "feature-auth",
  "cwd": "/Users/me/Code/.clawterm-worktrees/myrepo/feature-auth-wt-1",
  "worktreePath": "/Users/me/Code/.clawterm-worktrees/myrepo/feature-auth-wt-1",
  "repoRoot": "/Users/me/Code/myrepo",
  // ...
}
```

The same fields exist on `SessionSplitLeaf` for split panes that own a worktree independently.

On session restore (`restoreOneTab()` in `terminal-manager.ts`), ClawTerm:

1. Validates that the saved cwd still exists (`validate_dir`); falls back to `$HOME` if not
2. Re-creates the tab in that cwd
3. Re-attaches the saved `worktreePath` and `repoRoot` to the tab and its initial pane

The resolver does **not** run on restore — it only runs at *creation* time. This means existing worktrees from older ClawTerm versions (when the default was `.clawterm-worktrees` inside the repo) continue to work indefinitely. The next worktree you create after upgrading uses the new sibling layout, but the old ones stay where they are.

## The legacy migration hint

`maybeShowLegacyWorktreeHint()` in [`terminal-manager.ts`](../../src/terminal-manager.ts) is a one-time non-blocking startup check for users upgrading from the pre-#416 default. It runs only if:

- `worktree.directory === ""` (the new auto mode)
- The localStorage flag `clawterm-legacy-worktree-hint-shown` is not set
- The active tab has resolved its cwd (waits 2.5 s for the first poll cycle, falls back to the constructor cwd if polling hasn't run yet)
- The cwd is in a git repository
- That repository has a non-empty `.clawterm-worktrees/` directory at its root (Rust check: `has_legacy_in_repo_worktrees`)

If all conditions match, it shows an 8-second info toast:

> Found old worktrees in `.clawterm-worktrees/`. New worktrees will now be created outside the repo (#415).

The localStorage flag is set after the first time the toast fires (regardless of how many repos have legacy worktrees), so the user sees it at most once across all their repos. Existing worktrees keep working — the hint is purely informational, no migration is performed.

## Failure modes

| What can go wrong | What happens | Where |
| --- | --- | --- |
| Branch already exists when `createBranch: true` | `git worktree add` errors; toast shows the stderr verbatim | `worktree-actions.ts:108` |
| Worktree directory already exists on disk | Same — `git worktree add` errors | Same |
| Repository at filesystem root (`/repo`) | Resolver falls back to `~/.clawterm-worktrees/<repo-name>/` | `worktree-base.ts:71` |
| Caller is inside another worktree | Rust refuses with clear error message | `worktree.rs:120` |
| Split succeeds but pane limit hit, no PTY slot | Frontend detects via pane-count comparison, unlocks + force-removes the orphaned worktree | `worktree-actions.ts:213` |
| User cancels the dialog mid-flow | `onResult` callback never fires; nothing is created | `worktree-dialog.ts` |
| `lock_worktree` fails (e.g., already locked) | Treated as benign; debug log only, creation continues | `worktree-actions.ts:79` |
| Tab close with `autoCleanup: true` but worktree has uncommitted changes | `git worktree remove` errors; debug log; the directory stays | `terminal-manager.ts:733` |

## Configuration

Defaults live in [`src/config.ts:122`](../../src/config.ts), schema in [`src/config-types.ts:74`](../../src/config-types.ts). All keys live under `worktree`:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `directory` | `string` | `""` | Resolver mode selector. See [the three modes](#the-three-resolver-modes). |
| `postCreateHooks` | `string[]` | `[]` | Shell commands to run in the new worktree after creation, in order. 500 ms gap between each. Use this for `npm install`, `mise install`, etc. |
| `autoCleanup` | `boolean` | `false` | Run `git worktree remove` automatically when the last tab/pane using a worktree closes. |
| `defaultAgent` | `string` | `""` | Pre-fills the dialog's "agent launcher" input. Set to `"claude"` if you want every new worktree to start Claude Code automatically. |

Keybinding (under `keybindings`):

| Key | Default | Description |
| --- | --- | --- |
| `newWorktreeTab` | `Cmd+Shift+N` (macOS), `Ctrl+Shift+N` (Windows/Linux) | Open the new-worktree dialog |

## Common workflows

### "I'm starting a new agent task — give me a fresh branch"

`Cmd+Shift+N` → type a new branch name → pick base branch (usually `main`) → optionally type `claude` in the agent field → Enter. ClawTerm creates the worktree, opens a tab in it, and runs `claude` for you.

### "I want two agents on the same task, comparing approaches"

`Cmd+D` to split → pick **new worktree** → confirm. The split pane gets `<branch>-wt-1`. Repeat with another `Cmd+D` for `-wt-2`. Both agents work in isolation.

### "I want a central worktree cache so all my repos share one location"

Set in `config.json`:

```json
{
  "worktree": {
    "directory": "~/.cache/clawterm-worktrees"
  }
}
```

Worktrees from `myrepo` land in `~/.cache/clawterm-worktrees/myrepo/`, worktrees from `otherrepo` in `~/.cache/clawterm-worktrees/otherrepo/`, etc. Repo-name namespacing prevents collisions when two different parent directories contain repos with the same name.

### "I want the old in-repo behaviour back"

```json
{
  "worktree": {
    "directory": ".clawterm-worktrees"
  }
}
```

This goes through the **legacy** branch of the resolver. Be aware: tools that walk the repo will now discover the worktrees' nested config files. Don't do this unless you have a specific reason (shared `node_modules`, IDE workspace scope, etc.) and you've added `.clawterm-worktrees` to every relevant tool's ignore list.

## Maintainer reference (file:line)

| Concern | File | Range |
| --- | --- | --- |
| Path resolver (three modes, edge cases) | `src/worktree-base.ts` | full file |
| Frontend orchestration (entry points, dialog wiring, IPC sequence) | `src/worktree-actions.ts` | full file |
| Branch-picker dialog UI | `src/worktree-dialog.ts` | full file |
| Rust git-worktree handlers | `src-tauri/src/worktree.rs` | full file |
| Inside-worktree detection | `src-tauri/src/worktree.rs` | `is_inside_worktree`, `:84` |
| `find_repo_root` (uses `--git-common-dir`) | `src-tauri/src/worktree.rs` | `:271` |
| Resolver unit tests | `tests/worktree-base.test.ts` | full file (16 cases) |
| Rust worktree tests | `src-tauri/src/worktree.rs` | `mod tests`, end of file |
| Config defaults | `src/config.ts` | `:122` |
| Config schema | `src/config-types.ts` | `:74` |
| Session persistence shape | `src/session.ts` | `:4-37` |
| Session restore wire-up | `src/terminal-manager.ts` | `restoreOneTab` |
| Legacy hint | `src/terminal-manager.ts` | `maybeShowLegacyWorktreeHint`, `:312` |
| `has_legacy_in_repo_worktrees` Rust check | `src-tauri/src/main.rs` | `:208` |

## Related issues

- [#233](https://github.com/clawterm/clawterm/issues/233) — Original multi-branch multi-agent workspace feature
- [#235](https://github.com/clawterm/clawterm/issues/235) — Worktree metadata lost on session restore
- [#351](https://github.com/clawterm/clawterm/issues/351) — `find_repo_root` returning the worktree path; introduced `--git-common-dir`
- [#415](https://github.com/clawterm/clawterm/issues/415) — Worktrees inside main repo broke parent-repo tools (the bug)
- [#416](https://github.com/clawterm/clawterm/issues/416) — Worktree relocation: implementation plan (the fix)
