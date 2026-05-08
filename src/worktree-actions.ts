import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout } from "./utils";
import { showWorktreeDialog, type WorktreeDialogResult } from "./worktree-dialog";
import { showSplitChoiceDialog } from "./split-choice-dialog";
import { resolveWorktreeBase } from "./worktree-base";
import type { Tab } from "./tab";
import type { Config } from "./config";
import { logger } from "./logger";
import { showToast } from "./toast";

/** Context passed to worktree actions — avoids coupling to TerminalManager. */
export interface WorktreeContext {
  getActiveTab(): Tab | null;
  config: Config;
  createTab(cwd: string): Promise<void>;
  writeToActivePty(text: string): void;
}

/** Resolve the main repo root, preferring pane.repoRoot for worktree-aware resolution. */
async function resolveRepoRoot(tab: Tab): Promise<string | null> {
  const cwd = tab.lastFullCwd;
  if (!cwd) {
    showToast("No working directory — open a tab first", "warn");
    return null;
  }
  const focusedPane = tab.getFocusedPane();
  if (focusedPane?.repoRoot) return focusedPane.repoRoot;
  try {
    return await invokeWithTimeout<string>("find_repo_root", { dir: cwd }, 3000);
  } catch {
    showToast("Not in a git repository", "warn");
    return null;
  }
}

/** Open the "New Agent Tab on Branch" dialog and create a worktree + tab. */
export async function openWorktreeDialog(ctx: WorktreeContext): Promise<void> {
  const tab = ctx.getActiveTab();
  if (!tab) return;

  const repoRoot = await resolveRepoRoot(tab);
  if (!repoRoot) return;

  // Resolve the absolute worktree base path once, before opening the dialog.
  // The dialog accepts a fully-resolved base so it never has to know about
  // auto/absolute/legacy modes — the resolver is the single source of truth. (#416)
  const worktreeBase = await resolveWorktreeBase(repoRoot, ctx.config.worktree.directory);
  const defaultAgent = ctx.config.worktree.defaultAgent;

  showWorktreeDialog(repoRoot, worktreeBase, defaultAgent, (result) => {
    createAgentTab(ctx, repoRoot, result);
  });
}

/** Create a worktree, open a new tab in it, and optionally launch an agent. */
async function createAgentTab(
  ctx: WorktreeContext,
  repoRoot: string,
  result: WorktreeDialogResult,
): Promise<void> {
  try {
    await invokeWithTimeout<string>(
      "create_worktree",
      {
        repoDir: repoRoot,
        worktreeDir: result.worktreeDir,
        branch: result.branch,
        baseBranch: result.baseBranch,
        createBranch: result.createBranch,
      },
      10000,
    );

    // Lock the worktree so agents/scripts can't accidentally delete it
    await invokeWithTimeout(
      "lock_worktree",
      { repoDir: repoRoot, worktreePath: result.worktreeDir },
      5000,
    ).catch((e) => logger.debug("Failed to lock worktree (non-fatal):", e));

    await ctx.createTab(result.worktreeDir);

    // Store worktree metadata on the tab and its initial pane
    const tab = ctx.getActiveTab();
    if (tab) {
      tab.worktreePath = result.worktreeDir;
      tab.repoRoot = repoRoot;
      const pane = tab.getFocusedPane();
      if (pane) {
        pane.worktreePath = result.worktreeDir;
        pane.repoRoot = repoRoot;
      }
    }

    // Run post-create hooks
    for (const hook of ctx.config.worktree.postCreateHooks) {
      ctx.writeToActivePty(hook + "\n");
      await new Promise((r) => setTimeout(r, 500));
    }

    // Launch agent if configured
    if (result.launchAgent) {
      await new Promise((r) => setTimeout(r, 300));
      ctx.writeToActivePty(result.launchAgent + "\n");
    }

    showToast(`Worktree created: ${result.branch}`, "info", 3000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`Failed to create worktree: ${msg}`, "error");
    logger.warn("createAgentTab failed:", e);
  }
}

/** Auto-create a worktree from the current branch and split the focused pane into it. */
export async function openSplitToBranchDialog(
  ctx: WorktreeContext,
  direction: "horizontal" | "vertical" = "horizontal",
): Promise<void> {
  const tab = ctx.getActiveTab();
  if (!tab) return;

  const repoRoot = await resolveRepoRoot(tab);
  if (!repoRoot) return;

  // Detect the current branch
  const cwd = tab.lastFullCwd ?? repoRoot;
  let currentBranch: string;
  try {
    currentBranch = await invokeWithTimeout<string>("get_git_branch", { dir: cwd }, 3000);
  } catch {
    showToast("Could not detect current branch", "warn");
    return;
  }
  if (!currentBranch) {
    showToast("Not on a branch (detached HEAD?)", "warn");
    return;
  }

  // Generate a unique worktree branch name: <rootBranch>-wt-1, -wt-2, etc.
  // Strip existing -wt-N suffix to prevent stacking (main-wt-1-wt-1) (#351).
  const rootBranch = currentBranch.replace(/-wt-\d+$/, "");
  // Resolve the absolute worktree base via the resolver — handles auto,
  // absolute, and legacy modes uniformly. (#416)
  const worktreeBase = await resolveWorktreeBase(repoRoot, ctx.config.worktree.directory);
  let existingBranches: string[] = [];
  try {
    const branches = await invokeWithTimeout<{ name: string }[]>(
      "list_branches",
      { repoDir: repoRoot },
      5000,
    );
    existingBranches = branches.map((b) => b.name);
  } catch {
    // If we can't list branches, we'll just try and let git error if there's a conflict
  }

  let suffix = 1;
  let newBranch = `${rootBranch}-wt-${suffix}`;
  while (existingBranches.includes(newBranch)) {
    suffix++;
    newBranch = `${rootBranch}-wt-${suffix}`;
  }

  const dirName = newBranch.replace(/[/\\:*?"<>|]/g, "-").replace(/^-+|-+$/g, "");
  const worktreeDir = `${worktreeBase}/${dirName}`;

  splitToBranch(
    ctx,
    tab,
    repoRoot,
    {
      branch: newBranch,
      baseBranch: currentBranch,
      createBranch: true,
      worktreeDir,
      launchAgent: "",
    },
    direction,
  );
}

/** Create a worktree and split the focused pane into it. */
async function splitToBranch(
  ctx: WorktreeContext,
  tab: Tab,
  repoRoot: string,
  result: WorktreeDialogResult,
  direction: "horizontal" | "vertical" = "horizontal",
): Promise<void> {
  try {
    await invokeWithTimeout<string>(
      "create_worktree",
      {
        repoDir: repoRoot,
        worktreeDir: result.worktreeDir,
        branch: result.branch,
        baseBranch: result.baseBranch,
        createBranch: result.createBranch,
      },
      10000,
    );

    // Lock the worktree so agents/scripts can't accidentally delete it
    await invokeWithTimeout(
      "lock_worktree",
      { repoDir: repoRoot, worktreePath: result.worktreeDir },
      5000,
    ).catch((e) => logger.debug("Failed to lock worktree (non-fatal):", e));

    // Track pane count to detect if split actually succeeded
    const paneBefore = tab.getFocusedPane();
    const paneCountBefore = tab.getPanes().length;
    await tab.splitWithCwd(direction, result.worktreeDir);
    const panesAfter = tab.getPanes().length;

    // If the split failed (pane limit, PTY error), clean up the orphaned worktree
    if (panesAfter === paneCountBefore) {
      logger.warn("splitToBranch: split failed, cleaning up orphaned worktree");
      await invoke("unlock_worktree", {
        repoDir: repoRoot,
        worktreePath: result.worktreeDir,
      }).catch((e) => logger.debug("Failed to unlock orphaned worktree:", e));
      try {
        await invoke("remove_worktree", {
          repoDir: repoRoot,
          worktreePath: result.worktreeDir,
          force: true,
        });
      } catch (e) {
        logger.warn("Failed to clean orphaned worktree:", e);
        showToast(
          `Split failed; orphaned worktree at ${result.worktreeDir} — clean up manually`,
          "error",
          6000,
        );
        return;
      }
      showToast("Failed to split — pane limit or PTY error", "error");
      return;
    }

    // The new pane is now focused — set worktree metadata on it
    const newPane = tab.getFocusedPane();
    if (newPane && newPane !== paneBefore) {
      newPane.worktreePath = result.worktreeDir;
      newPane.repoRoot = repoRoot;
    }

    // Run post-create hooks in the new pane
    for (const hook of ctx.config.worktree.postCreateHooks) {
      tab.writeToPty(hook + "\n");
      await new Promise((r) => setTimeout(r, 500));
    }

    showToast(`Split to branch: ${result.branch}`, "info", 3000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`Failed to split to branch: ${msg}`, "error");
    logger.warn("splitToBranch failed:", e);
  }
}

/**
 * Show a choice dialog before splitting: new worktree or same branch.
 * If not in a git repo, skips the dialog and splits on same branch directly.
 */
export async function splitWithChoice(
  ctx: WorktreeContext,
  direction: "horizontal" | "vertical",
): Promise<void> {
  const tab = ctx.getActiveTab();
  if (!tab) return;

  // Detect current branch — if not in a repo, skip dialog and split same-branch
  const cwd = tab.lastFullCwd;
  if (!cwd) {
    tab.split(direction);
    return;
  }

  let currentBranch: string | null = null;
  try {
    currentBranch = await invokeWithTimeout<string>("get_git_branch", { dir: cwd }, 3000);
  } catch {
    // Not in a git repo — just do a same-branch split
  }

  if (!currentBranch) {
    tab.split(direction);
    return;
  }

  showSplitChoiceDialog(currentBranch, (mode) => {
    if (mode === "worktree") {
      openSplitToBranchDialog(ctx, direction);
    } else {
      tab.split(direction);
    }
  });
}
