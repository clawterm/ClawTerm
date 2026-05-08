use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Cache TTL for successful git status results.
const GIT_CACHE_TTL: Duration = Duration::from_secs(3);

/// Cache TTL for failed git status — prevents repeated subprocess spawns
/// for directories with broken git (corrupted .git, NFS mount, etc.).
const GIT_ERROR_CACHE_TTL: Duration = Duration::from_secs(10);

/// Timeout for git subprocess — prevents a hung `git status` from blocking
/// the entire batched poll and eventually exhausting the Tauri thread pool.
const GIT_SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(3);

struct GitCacheEntry {
    result: Result<GitStatus, String>,
    fetched_at: Instant,
}

static GIT_CACHE: std::sync::LazyLock<Mutex<HashMap<PathBuf, GitCacheEntry>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Parse a HEAD file to extract the branch name or short commit hash.
fn parse_head_file(head_path: &std::path::Path) -> String {
    if let Ok(content) = std::fs::read_to_string(head_path) {
        let content = content.trim();
        if let Some(branch) = content.strip_prefix("ref: refs/heads/") {
            return branch.to_string();
        }
        if content.len() >= 8 {
            return content[..8].to_string();
        }
    }
    String::new()
}

/// Read the current git branch for a directory by parsing .git/HEAD.
/// Walks up the directory tree to find the nearest .git entry.
/// Handles both regular repos and worktrees (.git file with gitdir pointer).
#[tauri::command]
pub fn get_git_branch(dir: String) -> String {
    let mut path = match std::fs::canonicalize(&dir) {
        Ok(p) => p,
        Err(_) => return String::new(),
    };

    loop {
        let git_entry = path.join(".git");
        if git_entry.exists() {
            if git_entry.is_dir() {
                return parse_head_file(&git_entry.join("HEAD"));
            } else if git_entry.is_file() {
                if let Ok(content) = std::fs::read_to_string(&git_entry) {
                    let content = content.trim();
                    if let Some(gitdir) = content.strip_prefix("gitdir: ") {
                        let gitdir_path = if std::path::Path::new(gitdir).is_absolute() {
                            std::path::PathBuf::from(gitdir)
                        } else {
                            path.join(gitdir)
                        };
                        return parse_head_file(&gitdir_path.join("HEAD"));
                    }
                }
                return String::new();
            }
        }
        if !path.pop() {
            break;
        }
    }

    String::new()
}

/// Structured git status for a directory.
#[derive(Serialize, Clone, Debug)]
pub struct GitStatus {
    pub branch: String,
    pub modified: u32,
    pub staged: u32,
    pub untracked: u32,
    pub ahead: u32,
    pub behind: u32,
    pub is_worktree: bool,
}

/// Get structured git status using `git status --porcelain=v2 --branch`.
/// Results are cached per-directory: successes with a 3s TTL, errors with
/// a 10s TTL (prevents repeated subprocess spawns for broken directories).
///
/// Async Tauri command — the entire body (canonicalize, cache lookup,
/// subprocess on miss, cache insert) runs on the blocking thread pool so
/// the Tauri command worker is free to service other IPC while a slow
/// `git status` (NFS, large index) is in flight. (#457)
#[tauri::command]
pub async fn get_git_status(dir: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || get_git_status_sync(dir))
        .await
        .map_err(|e| format!("git task join error: {}", e))?
}

/// Sync core of get_git_status — used directly by tests and by the
/// blocking-pool task spawned from the async Tauri command.
pub fn get_git_status_sync(dir: String) -> Result<GitStatus, String> {
    let path = match std::fs::canonicalize(&dir) {
        Ok(p) => p,
        Err(e) => return Err(format!("invalid dir: {}", e)),
    };

    // Check cache — both successes and errors are cached
    if let Ok(cache) = GIT_CACHE.lock() {
        if let Some(entry) = cache.get(&path) {
            let ttl = if entry.result.is_ok() {
                GIT_CACHE_TTL
            } else {
                GIT_ERROR_CACHE_TTL
            };
            if entry.fetched_at.elapsed() < ttl {
                return entry.result.clone();
            }
        }
    }

    let result = run_git_status(&path);

    // Store in cache (both Ok and Err) and evict stale entries
    if let Ok(mut cache) = GIT_CACHE.lock() {
        cache.insert(path, GitCacheEntry {
            result: result.clone(),
            fetched_at: Instant::now(),
        });
        // Evict entries that haven't been refreshed in 30s — these are
        // directories the user has navigated away from.
        if cache.len() > 16 {
            cache.retain(|_, entry| entry.fetched_at.elapsed() < Duration::from_secs(30));
        }
    }

    result
}

/// Run git status and parse the output.  Uses a 3-second subprocess timeout
/// to prevent a hung `git status` (NFS, corrupted index) from blocking the
/// poll batch and exhausting the Tauri thread pool.
pub fn run_git_status(path: &std::path::Path) -> Result<GitStatus, String> {
    let mut child = std::process::Command::new("git")
        .args(["--no-optional-locks", "status", "--porcelain=v2", "--branch"])
        .current_dir(path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("git spawn failed: {}", e))?;

    // Poll for completion with timeout — avoids blocking indefinitely
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err("not a git repo".to_string());
                }
                break;
            }
            Ok(None) => {
                if start.elapsed() > GIT_SUBPROCESS_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait(); // reap zombie
                    return Err("git status timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("git wait failed: {}", e)),
        }
    }

    let stdout = {
        use std::io::Read;
        let mut buf = String::new();
        if let Some(mut out) = child.stdout.take() {
            let _ = out.read_to_string(&mut buf);
        }
        buf
    };
    let mut branch = String::new();
    let mut modified: u32 = 0;
    let mut staged: u32 = 0;
    let mut untracked: u32 = 0;
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            let xy: &str = line.split_whitespace().nth(1).unwrap_or("..");
            let x = xy.as_bytes().first().copied().unwrap_or(b'.');
            let y = xy.as_bytes().get(1).copied().unwrap_or(b'.');
            if x != b'.' {
                staged += 1;
            }
            if y != b'.' {
                modified += 1;
            }
        } else if line.starts_with("? ") {
            untracked += 1;
        }
    }

    let is_worktree = path.join(".git").is_file();

    Ok(GitStatus {
        branch,
        modified,
        staged,
        untracked,
        ahead,
        behind,
        is_worktree,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_get_git_branch_regular_repo() {
        let dir = std::env::temp_dir().join("clawterm_test_git_regular");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let result = get_git_branch(dir.to_string_lossy().to_string());
        assert_eq!(result, "main");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_get_git_branch_worktree() {
        let base = std::env::temp_dir().join("clawterm_test_git_worktree");
        let _ = fs::remove_dir_all(&base);
        let main_git = base.join("main_repo").join(".git").join("worktrees").join("feature-x");
        fs::create_dir_all(&main_git).unwrap();
        fs::write(main_git.join("HEAD"), "ref: refs/heads/feature-x\n").unwrap();
        let worktree = base.join("worktree-feature-x");
        fs::create_dir_all(&worktree).unwrap();
        let gitdir_line = format!("gitdir: {}\n", main_git.to_string_lossy());
        fs::write(worktree.join(".git"), &gitdir_line).unwrap();
        let result = get_git_branch(worktree.to_string_lossy().to_string());
        assert_eq!(result, "feature-x");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn test_get_git_branch_detached_head() {
        let dir = std::env::temp_dir().join("clawterm_test_git_detached");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git").join("HEAD"), "abc12345def67890\n").unwrap();
        let result = get_git_branch(dir.to_string_lossy().to_string());
        assert_eq!(result, "abc12345");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_get_git_status_clean_repo() {
        let dir = std::env::temp_dir().join("clawterm_test_git_status");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "--initial-branch=main"])
            .current_dir(&dir)
            .output();
        if init.is_err() || !init.as_ref().unwrap().status.success() {
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let _ = std::process::Command::new("git").args(["config", "user.email", "test@test.com"]).current_dir(&dir).output();
        let _ = std::process::Command::new("git").args(["config", "user.name", "Test"]).current_dir(&dir).output();
        fs::write(dir.join("README.md"), "test").unwrap();
        let _ = std::process::Command::new("git").args(["add", "README.md"]).current_dir(&dir).output();
        let _ = std::process::Command::new("git").args(["commit", "-m", "init"]).current_dir(&dir).output();
        let result = get_git_status_sync(dir.to_string_lossy().to_string());
        assert!(result.is_ok());
        let status = result.unwrap();
        assert_eq!(status.branch, "main");
        assert_eq!(status.modified, 0);
        assert_eq!(status.staged, 0);
        assert_eq!(status.untracked, 0);
        assert!(!status.is_worktree);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_get_git_status_with_changes() {
        let dir = std::env::temp_dir().join("clawterm_test_git_status_dirty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let init = std::process::Command::new("git").args(["init", "--initial-branch=develop"]).current_dir(&dir).output();
        if init.is_err() || !init.as_ref().unwrap().status.success() { let _ = fs::remove_dir_all(&dir); return; }
        let _ = std::process::Command::new("git").args(["config", "user.email", "test@test.com"]).current_dir(&dir).output();
        let _ = std::process::Command::new("git").args(["config", "user.name", "Test"]).current_dir(&dir).output();
        fs::write(dir.join("file1.txt"), "hello").unwrap();
        let _ = std::process::Command::new("git").args(["add", "file1.txt"]).current_dir(&dir).output();
        let _ = std::process::Command::new("git").args(["commit", "-m", "init"]).current_dir(&dir).output();
        fs::write(dir.join("file1.txt"), "modified").unwrap();
        fs::write(dir.join("file2.txt"), "new staged").unwrap();
        let _ = std::process::Command::new("git").args(["add", "file2.txt"]).current_dir(&dir).output();
        fs::write(dir.join("file3.txt"), "untracked").unwrap();
        let result = get_git_status_sync(dir.to_string_lossy().to_string());
        assert!(result.is_ok());
        let status = result.unwrap();
        assert_eq!(status.branch, "develop");
        assert_eq!(status.modified, 1);
        assert_eq!(status.staged, 1);
        assert_eq!(status.untracked, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_get_git_status_non_git_dir() {
        let dir = std::env::temp_dir().join("clawterm_test_git_status_nongit");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let result = get_git_status_sync(dir.to_string_lossy().to_string());
        assert!(result.is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_error_caching_prevents_repeated_subprocess_spawns() {
        // A non-git dir should return Err and cache it.
        // Calling again immediately should return the cached Err without
        // spawning a new git subprocess.
        let dir = std::env::temp_dir().join("clawterm_test_git_err_cache");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let r1 = get_git_status_sync(dir.to_string_lossy().to_string());
        assert!(r1.is_err());

        // Second call — should hit the error cache (10s TTL)
        let r2 = get_git_status_sync(dir.to_string_lossy().to_string());
        assert!(r2.is_err());
        assert_eq!(r1.unwrap_err(), r2.unwrap_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_success_caching_returns_same_result() {
        let dir = std::env::temp_dir().join("clawterm_test_git_ok_cache");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "--initial-branch=main"])
            .current_dir(&dir)
            .output();
        if init.is_err() || !init.as_ref().unwrap().status.success() {
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let _ = std::process::Command::new("git").args(["config", "user.email", "t@t.com"]).current_dir(&dir).output();
        let _ = std::process::Command::new("git").args(["config", "user.name", "T"]).current_dir(&dir).output();
        fs::write(dir.join("f.txt"), "x").unwrap();
        let _ = std::process::Command::new("git").args(["add", "."]).current_dir(&dir).output();
        let _ = std::process::Command::new("git").args(["commit", "-m", "i"]).current_dir(&dir).output();

        let r1 = get_git_status_sync(dir.to_string_lossy().to_string());
        assert!(r1.is_ok());

        // Mutate the working tree — cached result should still return clean
        fs::write(dir.join("f.txt"), "changed").unwrap();
        let r2 = get_git_status_sync(dir.to_string_lossy().to_string());
        assert!(r2.is_ok());
        // Within 3s TTL — should return cached (0 modified)
        assert_eq!(r2.unwrap().modified, 0);

        let _ = fs::remove_dir_all(&dir);
    }
}
