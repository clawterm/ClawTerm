mod git_info;
mod menu;
mod process_info;
mod project_info;
mod server_check;
mod worktree;

use std::fs;
use std::io::Write;
use std::path::PathBuf;

fn clawterm_dir() -> PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| {
            let home = dirs::home_dir().expect("Could not determine home directory");
            home.join(".config")
        });
    config_dir.join("clawterm")
}

fn config_path() -> PathBuf {
    clawterm_dir().join("config.json")
}

fn session_path() -> PathBuf {
    clawterm_dir().join("session.json")
}

/// Write a file with owner-only read/write permissions (mode 0o600).
fn write_private(path: &PathBuf, contents: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(contents.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_config() -> Result<String, String> {
    let path = config_path();
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_config(contents: String) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_private(&path, &contents)
}

#[tauri::command]
fn read_session() -> Result<String, String> {
    let path = session_path();
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_session(contents: String) -> Result<(), String> {
    let path = session_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_private(&path, &contents)
}

#[tauri::command]
fn clear_session() -> Result<(), String> {
    let path = session_path();
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Set up the Claude Code status line script and configure settings.json
#[tauri::command]
fn setup_claude_statusline() -> Result<(), String> {
    // Use ~/.config/clawterm/ (no spaces in path) instead of platform config dir
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let dir = home.join(".config").join("clawterm");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script_path = dir.join("statusline.sh");

    // Write the status line script — receives JSON on stdin, writes a
    // file keyed by the parent PID (Claude Code). Reader path lives at
    // process_info::CLAUDE_STATUS_DIR; both must agree.
    let script = format!(
        "#!/bin/sh\ninput=$(cat)\ndir=\"{dir}\"\nmkdir -p \"$dir\"\necho \"$input\" > \"$dir/$PPID.json\"\n",
        dir = process_info::CLAUDE_STATUS_DIR,
    );
    write_private(&script_path, &script)?;

    // Make executable
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }

    // Configure Claude Code's settings.json to use our script
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let claude_settings_path = home.join(".claude").join("settings.json");
    let script_path_str = script_path.to_string_lossy().to_string();

    let mut settings: serde_json::Value = if claude_settings_path.exists() {
        let text = fs::read_to_string(&claude_settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).unwrap_or(serde_json::json!({}))
    } else {
        fs::create_dir_all(claude_settings_path.parent().unwrap()).map_err(|e| e.to_string())?;
        serde_json::json!({})
    };

    // Set or update to our script path
    let needs_update = match settings.get("statusLine") {
        None => true,
        Some(sl) => sl.get("command").and_then(|c| c.as_str()) != Some(&script_path_str),
    };
    if needs_update {
        settings["statusLine"] = serde_json::json!({
            "type": "command",
            "command": script_path_str
        });
        let contents = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        write_private(&claude_settings_path, &contents)?;
    }

    Ok(())
}

/// Detect which editors are available on the system by checking for their CLIs on PATH.
#[tauri::command]
fn detect_editors() -> Vec<String> {
    let candidates = [("code", "VS Code"), ("cursor", "Cursor")];
    let mut found = Vec::new();
    for (cmd, label) in candidates {
        if let Ok(output) = std::process::Command::new("which").arg(cmd).output() {
            if output.status.success() {
                found.push(label.to_string());
            }
        }
    }
    found
}

/// Open a directory in a specific editor.
#[tauri::command]
fn open_in_editor(editor: String, path: String) -> Result<(), String> {
    let cmd = match editor.as_str() {
        "VS Code" => "code",
        "Cursor" => "cursor",
        _ => return Err(format!("Unknown editor: {}", editor)),
    };
    std::process::Command::new(cmd)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open {}: {}", editor, e))?;
    Ok(())
}

#[tauri::command]
fn validate_dir(path: String) -> bool {
    // Canonicalize to resolve symlinks, then check the real path
    match fs::canonicalize(&path) {
        Ok(real) => real.is_dir(),
        Err(_) => false,
    }
}

/// Check whether `<repo_root>/.clawterm-worktrees/` exists and contains at
/// least one subdirectory. Used by the one-time launch hint that points
/// users at the new sibling-of-repo worktree layout (#416). Returns false
/// (not an error) for any failure mode — this is a UX hint, not a hard
/// requirement.
#[tauri::command]
fn has_legacy_in_repo_worktrees(repo_root: String) -> bool {
    let legacy = std::path::Path::new(&repo_root).join(".clawterm-worktrees");
    let Ok(entries) = fs::read_dir(&legacy) else {
        return false;
    };
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            return true;
        }
    }
    false
}

#[tauri::command]
fn validate_shell(path: String) -> Result<bool, String> {
    use std::os::unix::fs::PermissionsExt;
    // Canonicalize to resolve symlinks and validate the real target
    let real = match fs::canonicalize(&path) {
        Ok(p) => p,
        Err(_) => return Ok(false),
    };
    let meta = fs::metadata(&real).map_err(|e| e.to_string())?;
    Ok(meta.is_file() && (meta.permissions().mode() & 0o111 != 0))
}

fn main() {
    // Clean env vars that prevent tools from running inside our PTYs
    std::env::remove_var("CLAUDECODE");

    // Set terminal env vars so child PTYs inherit them.
    std::env::set_var("TERM", "xterm-256color");
    std::env::set_var("COLORTERM", "truecolor");
    std::env::set_var("TERM_PROGRAM", "clawterm");

    tauri::Builder::default()
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            use tauri::Manager;
            app.manage(menu::MenuState::default());
            let handle = app.handle().clone();
            menu::build_and_set(&handle)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::on_menu_event(app, event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            read_config,
            write_config,
            read_session,
            write_session,
            clear_session,
            process_info::get_process_cwd,
            process_info::get_process_cwd_full,
            process_info::get_process_name,
            process_info::poll_pane_info,
            git_info::get_git_branch,
            git_info::get_git_status,
            server_check::check_port,
            worktree::create_worktree,
            worktree::remove_worktree,
            worktree::lock_worktree,
            worktree::unlock_worktree,
            worktree::list_branches,
            worktree::find_repo_root,
            detect_editors,
            open_in_editor,
            validate_dir,
            has_legacy_in_repo_worktrees,
            validate_shell,
            setup_claude_statusline,
            menu::apply_menu_accelerators,
            menu::apply_menu_disabled,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Session is now flushed by the JS side (flushSession) before dispose.
            // No Rust-side session clearing needed.
        });
}
