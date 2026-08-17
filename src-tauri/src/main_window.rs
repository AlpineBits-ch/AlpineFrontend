//! Construction of the main (`echo`) window.
//!
//! This lives in Rust rather than `tauri.conf.json` because a config-declared
//! window is created before `setup()` finishes, which would let it appear
//! before the update gate has run. Building it here is what lets the gate go
//! first. See docs/superpowers/plans/2026-08-06-pre-launch-update-gate.md.
//!
//! The window is built hidden and shown at the end of `build`. That order is
//! load-bearing: the saved geometry is applied in between, and every step of
//! applying it - moving to the target display, resizing, maximizing - would be
//! visible as a jump if the window were already on screen.

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

use crate::window_state;

/// Builds the main window, restores its geometry, and shows it.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    // Before the window exists: `available_monitors` works on the app handle,
    // so the placement is known up front and never has to be corrected later.
    window_state::install(app);
    let placement = window_state::placement_for(app, "echo");

    let window = WebviewWindowBuilder::new(app, "echo", WebviewUrl::default())
        .title("Venta")
        .inner_size(
            window_state::DEFAULT_SIZE.width,
            window_state::DEFAULT_SIZE.height,
        )
        .min_inner_size(window_state::MIN_SIZE.width, window_state::MIN_SIZE.height)
        .decorations(false)
        .shadow(true)
        // The config equivalent was `"dragDropEnabled": false`.
        .disable_drag_drop_handler()
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        // Only ever seen on a first launch, or when every remembered display is
        // gone; `window_state::apply` overrides it otherwise.
        .center()
        .transparent(true)
        .visible(false)
        .build()?;

    // A failure to restore is not a reason to withhold the window - it just
    // opens where it was built.
    if let Err(e) = window_state::apply(&window, placement) {
        eprintln!("[window-state] could not restore window geometry: {e}");
    }

    window_state::attach(&window);

    window.show()?;
    window.set_focus()?;

    Ok(())
}
