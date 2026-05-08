use serde::Serialize;
use std::path::Path;
use std::process::Command;

struct WorktreeInfo {
    branch: String,
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub commit: String,
    pub is_remote: bool,
    /// Whether this branch already has a worktree checked out
    pub has_worktree: bool,
}

/// List worktree branches for a repo. Used internally by list_branches to mark
/// which branches already have a worktree checked out.
fn list_worktrees(repo_dir: String) -> Result<Vec<WorktreeInfo>, String> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git worktree list failed: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees = Vec::new();
    let mut branch = String::new();
    let mut path_seen = false;

    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            if path_seen {
                worktrees.push(WorktreeInfo { branch: branch.clone() });
            }
            path_seen = true;
            branch = String::new();
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            branch = b.to_string();
        }
    }
    if path_seen {
        worktrees.push(WorktreeInfo { branch });
    }

    Ok(worktrees)
}

/// Detect whether `dir` is inside a git worktree (rather than the main repo).
///
/// Compares `--git-dir` (worktree-specific: `.git/worktrees/<name>`) against
/// `--git-common-dir` (always the main repo's `.git`). If they differ, we are
/// inside a worktree. Returns `Ok(true)` if inside a worktree, `Ok(false)` if
/// inside the main repo, or `Err` if `dir` is not a git repository at all.
///
/// Both flags are passed to a single `git rev-parse` invocation — rev-parse
/// emits each requested path on its own line in the order requested, so we
/// only spawn one subprocess per check.
fn is_inside_worktree(dir: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .args([
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
        ])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git rev-parse failed: {}", e))?;
    if !output.status.success() {
        return Err("not a git repository".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let git_dir = lines.next().unwrap_or("").trim();
    let common_dir = lines.next().unwrap_or("").trim();
    if git_dir.is_empty() || common_dir.is_empty() {
        return Err("git rev-parse returned unexpected output".to_string());
    }
    Ok(git_dir != common_dir)
}

/// Create a new worktree with an optional new branch.
#[tauri::command]
pub fn create_worktree(
    repo_dir: String,
    worktree_dir: String,
    branch: String,
    base_branch: String,
    create_branch: bool,
) -> Result<String, String> {
    // Defense in depth on top of #351 — refuse to create a worktree from
    // inside another worktree. The frontend already resolves the main repo
    // root via `find_repo_root` (which uses `--git-common-dir`), but if any
    // future code path slips a worktree path in here we want a clear error
    // instead of silently nesting worktrees inside each other (#416).
    if is_inside_worktree(&repo_dir).unwrap_or(false) {
        return Err(
            "Refusing to create a worktree from inside another worktree. \
             Open a tab in the main repository first."
                .to_string(),
        );
    }

    // Ensure parent directory exists
    if let Some(parent) = Path::new(&worktree_dir).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create worktree parent dir: {}", e))?;
    }

    let mut args = vec!["worktree", "add"];
    if create_branch {
        args.push("-b");
        args.push(&branch);
    }
    args.push(&worktree_dir);
    if create_branch {
        args.push(&base_branch);
    } else {
        args.push(&branch);
    }

    let output = Command::new("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git worktree add failed: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(worktree_dir)
}

/// Remove a worktree.
#[tauri::command]
pub fn remove_worktree(repo_dir: String, worktree_path: String, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&worktree_path);

    let output = Command::new("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git worktree remove failed: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// List all branches (local and remote).
#[tauri::command]
pub fn list_branches(repo_dir: String) -> Result<Vec<BranchInfo>, String> {
    // Get worktree branches first to mark which have worktrees
    let worktree_branches: Vec<String> = list_worktrees(repo_dir.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|w| w.branch)
        .collect();

    // Get actual remote names to correctly distinguish remote branches
    // from local branches containing "/" (e.g. "feature/auth")
    let remote_prefixes: Vec<String> = Command::new("git")
        .args(["remote"])
        .current_dir(&repo_dir)
        .output()
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|r| format!("{}/", r))
                .collect()
        })
        .unwrap_or_default();

    let output = Command::new("git")
        .args(["branch", "-a", "--format=%(refname:short)|%(objectname:short)"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git branch failed: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(2, '|').collect();
        let name = parts.first().unwrap_or(&"").to_string();
        let commit = parts.get(1).unwrap_or(&"").to_string();
        if name.is_empty() {
            continue;
        }

        // Skip HEAD pointer entries like "origin/HEAD"
        if name.ends_with("/HEAD") {
            continue;
        }

        // A branch is remote if its name starts with a known remote prefix
        // (e.g. "origin/main"). Local branches like "feature/auth" are NOT remote.
        let is_remote = remote_prefixes.iter().any(|prefix| name.starts_with(prefix.as_str()));
        let has_worktree = if is_remote {
            false
        } else {
            worktree_branches.contains(&name)
        };

        branches.push(BranchInfo {
            name,
            commit,
            is_remote,
            has_worktree,
        });
    }

    Ok(branches)
}

/// Lock a worktree so `git worktree remove` (without --force) is rejected.
/// This protects active worktrees from accidental deletion by agents or scripts.
#[tauri::command]
pub fn lock_worktree(repo_dir: String, worktree_path: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["worktree", "lock", "--reason", "In use by Clawterm", &worktree_path])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git worktree lock failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // Already locked is fine — don't treat as error
        if stderr.contains("already locked") {
            return Ok(());
        }
        return Err(stderr);
    }
    Ok(())
}

/// Unlock a previously locked worktree so it can be removed.
#[tauri::command]
pub fn unlock_worktree(repo_dir: String, worktree_path: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["worktree", "unlock", &worktree_path])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git worktree unlock failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // Not locked is fine — don't treat as error
        if stderr.contains("not locked") {
            return Ok(());
        }
        return Err(stderr);
    }
    Ok(())
}

/// Find the **main** repository root, even when called from inside a worktree.
/// Uses `--git-common-dir` which returns the shared `.git` directory — this is
/// the main repo's `.git` for both worktrees and regular checkouts (#351).
/// `--show-toplevel` is wrong here because it returns the worktree directory,
/// not the main repo root, causing nested worktree creation.
#[tauri::command]
pub fn find_repo_root(dir: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("git rev-parse failed: {}", e))?;

    if !output.status.success() {
        return Err("not a git repository".to_string());
    }

    let git_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // Strip trailing "/.git" to get the repo root
    Ok(git_dir.strip_suffix("/.git").unwrap_or(&git_dir).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Initialize a fresh git repo in a temp dir, return its path.
    fn init_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(&dir)
            .output()
            .unwrap();
        // git needs a user.name/user.email to commit
        Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(&dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&dir)
            .output()
            .unwrap();
        // Make an initial commit so worktree add works
        fs::write(dir.join("README.md"), "test\n").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(&dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-q", "-m", "init"])
            .current_dir(&dir)
            .output()
            .unwrap();
        dir
    }

    #[test]
    fn is_inside_worktree_returns_false_for_main_repo() {
        let repo = init_repo("clawterm_test_inside_main");
        let result = is_inside_worktree(&repo.to_string_lossy()).unwrap();
        assert!(!result, "main repo should not be classified as inside a worktree");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn is_inside_worktree_returns_true_for_worktree() {
        let repo = init_repo("clawterm_test_inside_wt");
        let wt_path = repo.parent().unwrap().join("clawterm_test_inside_wt_wt1");
        let _ = fs::remove_dir_all(&wt_path);
        // Create a worktree the normal way
        Command::new("git")
            .args(["worktree", "add", "-b", "feature-x", wt_path.to_str().unwrap()])
            .current_dir(&repo)
            .output()
            .unwrap();
        let result = is_inside_worktree(&wt_path.to_string_lossy()).unwrap();
        assert!(result, "worktree path should be classified as inside a worktree");
        // Cleanup
        Command::new("git")
            .args(["worktree", "remove", "--force", wt_path.to_str().unwrap()])
            .current_dir(&repo)
            .output()
            .ok();
        let _ = fs::remove_dir_all(&repo);
        let _ = fs::remove_dir_all(&wt_path);
    }

    #[test]
    fn create_worktree_refuses_from_inside_worktree() {
        let repo = init_repo("clawterm_test_refuse_nested");
        let wt_path = repo.parent().unwrap().join("clawterm_test_refuse_nested_wt1");
        let nested_path = repo.parent().unwrap().join("clawterm_test_refuse_nested_wt2");
        let _ = fs::remove_dir_all(&wt_path);
        let _ = fs::remove_dir_all(&nested_path);

        // Create a real worktree the normal way
        Command::new("git")
            .args(["worktree", "add", "-b", "feature-a", wt_path.to_str().unwrap()])
            .current_dir(&repo)
            .output()
            .unwrap();

        // Now try to create_worktree from INSIDE that worktree — must refuse
        let result = create_worktree(
            wt_path.to_string_lossy().to_string(),
            nested_path.to_string_lossy().to_string(),
            "feature-b".to_string(),
            "main".to_string(),
            true,
        );
        assert!(result.is_err(), "create_worktree from inside a worktree should error");
        let err = result.unwrap_err();
        assert!(
            err.contains("Refusing to create a worktree from inside another worktree"),
            "expected refusal message, got: {err}"
        );

        // Cleanup
        Command::new("git")
            .args(["worktree", "remove", "--force", wt_path.to_str().unwrap()])
            .current_dir(&repo)
            .output()
            .ok();
        let _ = fs::remove_dir_all(&repo);
        let _ = fs::remove_dir_all(&wt_path);
        let _ = fs::remove_dir_all(&nested_path);
    }
}
