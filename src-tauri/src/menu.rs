//! macOS native menu bar (#487).
//!
//! Builds the global menu bar to the right of the Apple logo and bridges
//! item clicks to the frontend by emitting a `menu-action` event with the
//! item ID. The TS side maps each ID to the existing `KeybindingActions`
//! surface used by the keybinding handler and command palette — there's
//! one action map shared across all three input paths.
//!
//! Menu state — accelerators (#495) and disabled set (#496) — lives in a
//! `MenuContext` mutex managed by Tauri. Each command updates one piece
//! and rebuilds the whole menu; the menu is small enough (~30 items) that
//! a full rebuild is cheaper than tracking per-item handles, and avoids
//! the lifetime headache of stashing `MenuItem<R>` across calls.
//!
//! Standard Window/App items use `PredefinedMenuItem` for free
//! localization + role behavior. macOS only — gated by cfg in main.rs.
//!
//! Edit menu cut/copy/paste/selectAll dispatch through custom IDs so
//! they reach the focused pane's xterm (or text input) rather than
//! relying on the macOS responder chain (#497).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Runtime, State,
};

#[derive(Default)]
pub struct MenuContext {
    accelerators: HashMap<String, String>,
    disabled: HashSet<String>,
}

pub type MenuState = Mutex<MenuContext>;

/// Build and attach the macOS menu bar with no accelerators and nothing
/// disabled. Frontend follows up with `apply_menu_accelerators` and
/// `apply_menu_disabled` once it has loaded config and computed context.
pub fn build_and_set<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let ctx = MenuContext::default();
    let menu = build_menu(app, &ctx)?;
    app.set_menu(menu)?;
    Ok(())
}

#[tauri::command]
pub fn apply_menu_accelerators<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, MenuState>,
    accelerators: HashMap<String, String>,
) -> Result<(), String> {
    let mut ctx = state.lock().map_err(|e| e.to_string())?;
    if accelerators == ctx.accelerators {
        return Ok(());
    }
    ctx.accelerators = accelerators;
    rebuild(&app, &ctx).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn apply_menu_disabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, MenuState>,
    disabled: Vec<String>,
) -> Result<(), String> {
    let mut ctx = state.lock().map_err(|e| e.to_string())?;
    let next: HashSet<String> = disabled.into_iter().collect();
    if next == ctx.disabled {
        return Ok(()); // No-op skip — rAF debounce can fire identical sets.
    }
    ctx.disabled = next;
    rebuild(&app, &ctx).map_err(|e| e.to_string())
}

fn rebuild<R: Runtime>(app: &AppHandle<R>, ctx: &MenuContext) -> tauri::Result<()> {
    let menu = build_menu(app, ctx)?;
    app.set_menu(menu)?;
    Ok(())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, ctx: &MenuContext) -> tauri::Result<Menu<R>> {
    let app_submenu = SubmenuBuilder::new(app, "ClawTerm")
        .item(&item(app, "about", "About ClawTerm", ctx)?)
        .item(&item(app, "checkForUpdates", "Check for Updates…", ctx)?)
        .separator()
        .item(&item(app, "toggleSettings", "Settings…", ctx)?)
        .item(&item(app, "openConfigFile", "Open Config File…", ctx)?)
        .item(&item(app, "reloadConfig", "Reload Config", ctx)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file_submenu = SubmenuBuilder::new(app, "File")
        .item(&item(app, "createWindow", "New Window", ctx)?)
        .item(&item(app, "createTab", "New Tab", ctx)?)
        .item(&item(app, "openWorktreeDialog", "New Agent Tab on Branch…", ctx)?)
        .item(&item(app, "newProject", "New Project", ctx)?)
        .separator()
        .item(&item(app, "restoreClosedTab", "Restore Closed Tab", ctx)?)
        .separator()
        .item(&item(app, "closeActivePane", "Close Pane", ctx)?)
        .item(&item(app, "closeActiveTab", "Close Tab", ctx)?)
        .build()?;

    // Edit menu accelerators are standard macOS bindings and not driven by
    // config.keybindings — they're fixed strings that the dispatcher routes
    // to xterm or the focused text input (#497).
    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .item(&edit_item(app, "editCut", "Cut", "CmdOrCtrl+X", ctx)?)
        .item(&edit_item(app, "editCopy", "Copy", "CmdOrCtrl+C", ctx)?)
        .item(&edit_item(app, "editPaste", "Paste", "CmdOrCtrl+V", ctx)?)
        .item(&edit_item(app, "editSelectAll", "Select All", "CmdOrCtrl+A", ctx)?)
        .separator()
        .item(&item(app, "toggleSearch", "Find…", ctx)?)
        .build()?;

    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&item(app, "zoomIn", "Zoom In", ctx)?)
        .item(&item(app, "zoomOut", "Zoom Out", ctx)?)
        .item(&item(app, "zoomReset", "Reset Zoom", ctx)?)
        .separator()
        .item(&item(app, "toggleWorkspacePanel", "Toggle Workspace Panel", ctx)?)
        .separator()
        .item(&item(app, "openCommandPalette", "Show Command Palette", ctx)?)
        .item(&item(app, "showQuickSwitch", "Quick Switch", ctx)?)
        .item(&item(app, "jumpToBranch", "Jump to Branch…", ctx)?)
        .item(&item(app, "cycleAttentionTabs", "Cycle Attention Tabs", ctx)?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let tab_submenu = SubmenuBuilder::new(app, "Tab")
        .item(&item(app, "nextTab", "Next Tab", ctx)?)
        .item(&item(app, "prevTab", "Previous Tab", ctx)?)
        .build()?;

    let pane_submenu = SubmenuBuilder::new(app, "Pane")
        .item(&item(app, "splitVertical", "Split Right", ctx)?)
        .item(&item(app, "splitHorizontal", "Split Down", ctx)?)
        .separator()
        .item(&item(app, "focusNextPane", "Focus Next Pane", ctx)?)
        .item(&item(app, "focusPrevPane", "Focus Previous Pane", ctx)?)
        .build()?;

    let project_submenu = SubmenuBuilder::new(app, "Project")
        .item(&item(app, "newProject", "New Project", ctx)?)
        .item(&item(app, "nextProject", "Next Project", ctx)?)
        .item(&item(app, "prevProject", "Previous Project", ctx)?)
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    let help_submenu = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "openDocs", "ClawTerm Documentation", ctx)?)
        .item(&item(app, "reportIssue", "Report an Issue", ctx)?)
        .item(&item(app, "showShortcuts", "Show Keyboard Shortcuts", ctx)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &tab_submenu,
            &pane_submenu,
            &project_submenu,
            &window_submenu,
            &help_submenu,
        ])
        .build()
}

/// Build a custom menu item, attaching an accelerator and enabled state
/// from `ctx`. If Tauri rejects the accelerator string (compound chord
/// the menu can't represent), fall back to a no-accelerator item — the
/// keybinding handler keeps firing on the raw key event regardless.
fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    ctx: &MenuContext,
) -> tauri::Result<MenuItem<R>> {
    let accel = ctx.accelerators.get(id).map(String::as_str).filter(|s| !s.is_empty());
    let enabled = !ctx.disabled.contains(id);
    if let Some(a) = accel {
        if let Ok(item) = MenuItemBuilder::with_id(id, label).accelerator(a).enabled(enabled).build(app) {
            return Ok(item);
        }
    }
    MenuItemBuilder::with_id(id, label).enabled(enabled).build(app)
}

/// Edit menu items use a fixed accelerator and never appear in
/// config.keybindings; they still respect the enabled state.
fn edit_item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accel: &str,
    ctx: &MenuContext,
) -> tauri::Result<MenuItem<R>> {
    let enabled = !ctx.disabled.contains(id);
    MenuItemBuilder::with_id(id, label).accelerator(accel).enabled(enabled).build(app)
}

/// Forward custom menu item clicks to the frontend. Predefined items
/// are handled by the OS; this only fires for our `MenuItemBuilder` IDs.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    // Help menu items open URLs directly from Rust — simpler than a
    // round-trip through the frontend, and they don't need any in-app
    // state.
    match id {
        "openDocs" => {
            let _ = tauri_plugin_opener::OpenerExt::opener(app)
                .open_url("https://clawterm.github.io/clawterm/docs/", None::<&str>);
            return;
        }
        "reportIssue" => {
            let _ = tauri_plugin_opener::OpenerExt::opener(app)
                .open_url("https://github.com/clawterm/clawterm/issues/new", None::<&str>);
            return;
        }
        _ => {}
    }
    // Broadcast to every window; the frontend's setupNativeMenu listener
    // gates dispatch on the per-window `isWindowFocused` flag so only the
    // focused window acts (#522).
    let _ = app.emit("menu-action", id.to_string());
}
