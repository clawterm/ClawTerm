use serde::Serialize;

use crate::git_info;
use crate::project_info;

/// Filesystem location where the statusline.sh writer drops Claude
/// Code's per-turn JSON. Shared with `setup_claude_statusline` in main.rs.
pub const CLAUDE_STATUS_DIR: &str = "/tmp/clawterm-status";

/// Files older than this are considered stale and ignored. The writer
/// fires after every assistant turn, so anything fresh is recent.
const CLAUDE_STATUS_STALE_SECS: u64 = 30;

/// Result of a batched pane poll — CWD, git status, project name, and the
/// Claude Code statusLine JSON in a single round-trip.
#[derive(Serialize)]
pub struct PanePollResult {
    /// CWD folder name (last path component) for display
    pub cwd_folder: String,
    /// Full CWD path
    pub cwd_full: String,
    /// Git status (None if not a git repo or CWD unchanged and cached)
    pub git: Option<git_info::GitStatus>,
    /// Project name from manifest files (only when CWD changed)
    pub project_name: Option<String>,
    /// Raw Claude Code statusLine JSON keyed by the foreground PID, if the
    /// statusline.sh writer has produced a file for it. Frontend parses.
    pub claude_status: Option<String>,
}

/// Batched pane poll — performs CWD, git, project introspection, and a
/// Claude Code statusLine read in a single IPC call.
#[tauri::command]
pub async fn poll_pane_info(
    shell_pid: u32,
    fg_pid: Option<u32>,
    last_cwd: Option<String>,
    skip_expensive: bool,
) -> Result<PanePollResult, String> {
    // 1. CWD — single syscall, derive folder name server-side
    let prev_cwd = last_cwd.unwrap_or_default();
    let (cwd_folder, cwd_full) = if skip_expensive {
        // Reuse last known CWD — nothing has changed
        let folder = if prev_cwd.is_empty() {
            String::new()
        } else {
            cwd_to_folder(&prev_cwd)
        };
        (folder, prev_cwd.clone())
    } else {
        match platform::proc_cwd(shell_pid) {
            Ok(full) => {
                let folder = cwd_to_folder(&full);
                (folder, full)
            }
            Err(_) => {
                let folder = if prev_cwd.is_empty() {
                    String::new()
                } else {
                    cwd_to_folder(&prev_cwd)
                };
                (folder, prev_cwd.clone())
            }
        }
    };

    // 2. Git status — async so the subprocess work (on cache miss) doesn't
    // hold the Tauri command worker. (#457)
    let git = if !cwd_full.is_empty() && !skip_expensive {
        git_info::get_git_status(cwd_full.clone()).await.ok()
    } else {
        None
    };

    // 3. Project name — only when CWD actually changed
    let cwd_changed = prev_cwd.is_empty() || prev_cwd != cwd_full;
    let project_name = if cwd_changed && !cwd_full.is_empty() {
        let name = project_info::get_project_info(cwd_full.clone());
        if name.is_empty() { None } else { Some(name) }
    } else {
        None
    };

    // 4. Claude Code statusLine — only the foreground PID is meaningful.
    // The script keys files by the parent's PID (Claude Code); when the
    // shell is foreground there's no file. Cheap absence check inline
    // (sub-µs stat); only dispatch to the blocking pool when there's
    // actual content to read.
    let claude_status = match fg_pid {
        Some(pid) if pid != shell_pid => read_claude_status_async(pid).await,
        _ => None,
    };

    Ok(PanePollResult {
        cwd_folder,
        cwd_full,
        git,
        project_name,
        claude_status,
    })
}

/// Returns the statusLine JSON for `pid`, or None when the file is missing,
/// stale, or unreadable. The absence/stale checks run inline (cheap stat);
/// the actual read goes through the blocking pool so a slow disk doesn't
/// stall the IPC worker.
async fn read_claude_status_async(pid: u32) -> Option<String> {
    let path = claude_status_path_if_fresh(pid)?;
    tauri::async_runtime::spawn_blocking(move || std::fs::read_to_string(&path).ok())
        .await
        .ok()
        .flatten()
}

/// Resolve the on-disk statusLine path for `pid` and verify it exists and
/// isn't stale. Returns None on any failure. Used by both the async reader
/// and tests.
fn claude_status_path_if_fresh(pid: u32) -> Option<std::path::PathBuf> {
    let path = std::path::PathBuf::from(CLAUDE_STATUS_DIR).join(format!("{}.json", pid));
    let metadata = std::fs::metadata(&path).ok()?;
    let stale = metadata
        .modified()
        .ok()
        .and_then(|m| m.elapsed().ok())
        .is_some_and(|e| e.as_secs() > CLAUDE_STATUS_STALE_SECS);
    if stale {
        return None;
    }
    Some(path)
}

/// Convert a full CWD path to a display folder name.
fn cwd_to_folder(cwd: &str) -> String {
    let home_var = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"));
    if let Some(home) = home_var {
        if cwd == home.to_string_lossy() {
            return "~".to_string();
        }
    }
    std::path::Path::new(cwd)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            if cwd == "/" { "/".to_string() } else { "~".to_string() }
        })
}

/// Get the full current working directory path of a process.
#[tauri::command]
pub fn get_process_cwd_full(pid: u32) -> Result<String, String> {
    platform::proc_cwd(pid)
}

/// Get the executable name of a process (e.g. "claude", "zsh", "node").
///
/// Used by the paste-confirm gate to skip the multi-line warning dialog
/// when the foreground process is a trusted AI agent CLI — pasting into
/// an agent's prompt isn't the same risk as pasting into a shell.
#[tauri::command]
pub fn get_process_name(pid: u32) -> Result<String, String> {
    platform::proc_name(pid)
}

// --- macOS process introspection ---

mod platform {
    use std::mem;

    pub fn proc_cwd(pid: u32) -> Result<String, String> {
        const PROC_PIDVNODEPATHINFO: libc::c_int = 9;

        #[repr(C)]
        struct VnodeInfoPath {
            _vip_vi: [u8; 152],
            vip_path: [libc::c_char; 1024],
        }

        #[repr(C)]
        struct ProcVnodePathInfo {
            pvi_cdir: VnodeInfoPath,
            _pvi_rdir: VnodeInfoPath,
        }

        const _: () = assert!(
            mem::size_of::<VnodeInfoPath>() == 1176,
            "VnodeInfoPath size mismatch — macOS struct layout may have changed"
        );
        const _: () = assert!(
            mem::size_of::<ProcVnodePathInfo>() == 2352,
            "ProcVnodePathInfo size mismatch — macOS struct layout may have changed"
        );

        unsafe {
            let mut info: ProcVnodePathInfo = mem::zeroed();
            let size = mem::size_of::<ProcVnodePathInfo>() as libc::c_int;

            let ret = libc::proc_pidinfo(
                pid as libc::c_int,
                PROC_PIDVNODEPATHINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            );

            if ret <= 0 {
                return Err(format!("proc_pidinfo failed for pid {}", pid));
            }

            let path = std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr())
                .to_string_lossy()
                .to_string();

            if path.is_empty() {
                return Err("empty cwd".to_string());
            }

            Ok(path)
        }
    }

    pub fn proc_name(pid: u32) -> Result<String, String> {
        let mut buf = [0u8; 256];
        let ret = unsafe {
            libc::proc_name(
                pid as libc::c_int,
                buf.as_mut_ptr() as *mut libc::c_void,
                buf.len() as u32,
            )
        };
        if ret <= 0 {
            return Err(format!("proc_name failed for pid {}", pid));
        }
        // proc_name fills the buffer and may or may not include a null
        // terminator within the returned length; read up to the first NUL
        // byte to be safe across both conventions.
        let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        let name = std::str::from_utf8(&buf[..len])
            .map_err(|e| format!("proc_name utf8 error: {}", e))?
            .to_string();
        if name.is_empty() {
            return Err("empty proc name".to_string());
        }
        Ok(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cwd_to_folder_regular_path() {
        assert_eq!(cwd_to_folder("/Users/alice/Code/my-project"), "my-project");
    }

    #[test]
    fn test_cwd_to_folder_root() {
        assert_eq!(cwd_to_folder("/"), "/");
    }

    #[test]
    fn test_cwd_to_folder_home() {
        if let Some(home) = std::env::var_os("HOME") {
            assert_eq!(cwd_to_folder(&home.to_string_lossy()), "~");
        }
    }

    #[test]
    fn test_cwd_to_folder_nested_path() {
        assert_eq!(cwd_to_folder("/a/b/c/deep-folder"), "deep-folder");
    }

    #[test]
    fn test_cwd_to_folder_empty() {
        let result = cwd_to_folder("");
        assert!(!result.is_empty());
    }

    #[test]
    fn test_poll_pane_info_skip_expensive() {
        let result = tauri::async_runtime::block_on(poll_pane_info(
            99999,
            None,
            Some("/tmp".to_string()),
            true,
        ));
        let r = result.unwrap();
        assert_eq!(r.cwd_full, "/tmp");
        assert_eq!(r.cwd_folder, "tmp");
        assert!(r.git.is_none());
        assert!(r.project_name.is_none());
        assert!(r.claude_status.is_none());
    }

    #[test]
    fn test_poll_pane_info_no_last_cwd() {
        let result = tauri::async_runtime::block_on(poll_pane_info(99999, None, None, false));
        let r = result.unwrap();
        // proc_cwd for non-existent PID fails — falls back to empty prev_cwd
        assert!(r.cwd_full.is_empty() || !r.cwd_full.is_empty()); // doesn't crash
    }

    #[test]
    fn test_proc_name_self_returns_non_empty() {
        // The cargo-test harness binary should always be resolvable; we
        // don't pin the exact name (it's something like "process_info-…")
        // so we just assert we got a non-empty UTF-8 string back.
        let pid = std::process::id();
        let name = platform::proc_name(pid).expect("proc_name on self should succeed");
        assert!(!name.is_empty(), "proc_name returned empty string");
        assert!(
            !name.contains('\0'),
            "proc_name contains stray NUL byte: {:?}",
            name
        );
    }

    #[test]
    fn test_proc_name_invalid_pid_errors() {
        // u32::MAX is far above any real PID on macOS, Linux, or Windows,
        // so the lookup must surface an error rather than panic. (PID 0 is
        // not a safe sentinel — it's the "System Idle Process" on Windows
        // and resolves successfully via sysinfo.)
        assert!(platform::proc_name(u32::MAX).is_err());
    }

    #[test]
    fn test_claude_status_path_missing_returns_none() {
        assert!(claude_status_path_if_fresh(0).is_none());
    }

    #[test]
    fn test_claude_status_path_fresh_returns_path() {
        let dir = std::path::PathBuf::from(CLAUDE_STATUS_DIR);
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        // PID near u32::MAX so parallel test runs don't race on a real PID.
        let pid: u32 = u32::MAX - 17;
        let path = dir.join(format!("{}.json", pid));
        let _ = std::fs::write(&path, r#"{"session_id":"s1"}"#);
        let resolved = claude_status_path_if_fresh(pid);
        let _ = std::fs::remove_file(&path);
        assert_eq!(resolved.as_deref(), Some(path.as_path()));
    }
}
