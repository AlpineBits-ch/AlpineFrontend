//! Construction of the main (`echo`) window.
//!
//! This lives in Rust rather than `tauri.conf.json` because a config-declared
//! window is created before `setup()` finishes, and the vendored
//! `tauri-plugin-window-state` shows and focuses it from its `on_window_ready`
//! hook regardless of `"visible": false` (see `restore_state`, which ends with
//! `if flags.contains(StateFlags::VISIBLE) && should_show { self.show()?; }` and
//! initialises `should_show` to `true`). Building the window here is what lets
//! the update gate run first.
//!
//! See docs/superpowers/plans/2026-08-06-pre-launch-update-gate.md.

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// Builds the main window. Values mirror the `app.windows[0]` block that this
/// replaced in `tauri.conf.json`.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "echo", WebviewUrl::default())
        .title("Venta")
        .inner_size(1200.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .decorations(false)
        .shadow(true)
        // The config equivalent was `"dragDropEnabled": false`.
        .disable_drag_drop_handler()
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .center()
        .transparent(true)
        // Left hidden deliberately: tauri-plugin-window-state shows and focuses
        // it from on_window_ready once geometry has been restored.
        .visible(false)
        .build()?;
    Ok(())
}
