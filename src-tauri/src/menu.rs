//! macOS native menu bar (#487).
//!
//! Builds the global menu bar to the right of the Apple logo and bridges
//! item clicks to the frontend by emitting a `menu-action` event with the
//! item ID. The TS side maps each ID to the existing `KeybindingActions`
//! surface used by the keybinding handler and command palette — there's
//! one action map shared across all three input paths.
//!
//! Scope of this v1 (per the #487 close comment):
//! - Static menu structure with all actions reachable
//! - No accelerators — user keybindings still fire via the existing
//!   keybinding handler; mirroring config.keybindings into menu
//!   accelerators (and rebuilding on reload) is a follow-up
//! - All custom items always enabled — handlers no-op when context is
//!   wrong; context-aware dimming is a follow-up
//! - Standard system items (Quit/Hide/Services/Window/Fullscreen) use
//!   PredefinedMenuItem for free localization + role behavior
//! - macOS only — gated by cfg in main.rs
//!
//! Edit menu cut/copy/paste use predefined items, which route through
//! the macOS responder chain. xterm-specific forwarding (so they hit
//! the focused pane's terminal rather than the WebView focus) is the
//! follow-up that the issue calls out.

use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Runtime,
};

/// Build and attach the macOS menu bar. Idempotent — call once on setup.
pub fn build_and_set<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    app.set_menu(menu)?;
    Ok(())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_submenu = SubmenuBuilder::new(app, "Clawterm")
        .item(&MenuItemBuilder::with_id("about", "About Clawterm").build(app)?)
        .item(&MenuItemBuilder::with_id("checkForUpdates", "Check for Updates…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("toggleSettings", "Settings…").build(app)?)
        .item(&MenuItemBuilder::with_id("openConfigFile", "Open Config File…").build(app)?)
        .item(&MenuItemBuilder::with_id("reloadConfig", "Reload Config").build(app)?)
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
        .item(&MenuItemBuilder::with_id("newTab", "New Tab").build(app)?)
        .item(&MenuItemBuilder::with_id("newWorktreeTab", "New Agent Tab on Branch…").build(app)?)
        .item(&MenuItemBuilder::with_id("newProject", "New Project").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("restoreClosedTab", "Restore Closed Tab").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("closeActivePane", "Close Pane").build(app)?)
        .item(&MenuItemBuilder::with_id("closeActiveTab", "Close Tab").build(app)?)
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("toggleSearch", "Find…").build(app)?)
        .build()?;

    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("zoomIn", "Zoom In").build(app)?)
        .item(&MenuItemBuilder::with_id("zoomOut", "Zoom Out").build(app)?)
        .item(&MenuItemBuilder::with_id("zoomReset", "Reset Zoom").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("toggleWorkspacePanel", "Toggle Workspace Panel").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("openCommandPalette", "Show Command Palette").build(app)?)
        .item(&MenuItemBuilder::with_id("showQuickSwitch", "Quick Switch").build(app)?)
        .item(&MenuItemBuilder::with_id("jumpToBranch", "Jump to Branch…").build(app)?)
        .item(&MenuItemBuilder::with_id("cycleAttentionTabs", "Cycle Attention Tabs").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    let tab_submenu = SubmenuBuilder::new(app, "Tab")
        .item(&MenuItemBuilder::with_id("nextTab", "Next Tab").build(app)?)
        .item(&MenuItemBuilder::with_id("prevTab", "Previous Tab").build(app)?)
        .build()?;

    let pane_submenu = SubmenuBuilder::new(app, "Pane")
        .item(&MenuItemBuilder::with_id("splitVertical", "Split Right").build(app)?)
        .item(&MenuItemBuilder::with_id("splitHorizontal", "Split Down").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("focusNextPane", "Focus Next Pane").build(app)?)
        .item(&MenuItemBuilder::with_id("focusPrevPane", "Focus Previous Pane").build(app)?)
        .build()?;

    let project_submenu = SubmenuBuilder::new(app, "Project")
        .item(&MenuItemBuilder::with_id("newProject", "New Project").build(app)?)
        .item(&MenuItemBuilder::with_id("nextProject", "Next Project").build(app)?)
        .item(&MenuItemBuilder::with_id("prevProject", "Previous Project").build(app)?)
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    let help_submenu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("openDocs", "Clawterm Documentation").build(app)?)
        .item(&MenuItemBuilder::with_id("reportIssue", "Report an Issue").build(app)?)
        .item(&MenuItemBuilder::with_id("showShortcuts", "Show Keyboard Shortcuts").build(app)?)
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
    // Everything else dispatches into the frontend's existing action map.
    let _ = app.emit("menu-action", id.to_string());
}
