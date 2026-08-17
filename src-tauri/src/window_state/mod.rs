//! Remembering where the main window was, and putting it back.
//!
//! Replaces `tauri-plugin-window-state`, which stored physical pixels with no
//! record of which display a window was on, and so could not survive a
//! resolution, scale or arrangement change. See
//! `docs/superpowers/specs/2026-08-15-window-geometry-restore-design.md`.
//!
//! Everything interesting lives in the three modules below, which are pure and
//! carry the tests. This file is the adapter: it converts Tauri's types to
//! theirs, decides *when* to read the window, and applies the result.

pub mod model;
pub mod placement;
pub mod store;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, Monitor, Runtime, WebviewWindow, WindowEvent};

use model::{LogicalSize, MonitorId, PhysPoint, PhysSize, WindowGeometry, WindowMode};
use placement::{MonitorInfo, Observation, Placement};
use store::Store;

/// The size a first launch gets, and the floor every restore is clamped to.
/// `main_window` builds from these so the two cannot drift apart.
pub const DEFAULT_SIZE: LogicalSize = LogicalSize {
    width: 1200.0,
    height: 800.0,
};
pub const MIN_SIZE: LogicalSize = LogicalSize {
    width: 900.0,
    height: 600.0,
};

/// How long the window must be still before its geometry is believed.
///
/// This is not a throttle. Reading a window mid-transition is how the plugin
/// this replaces recorded a maximized origin as a windowed position; waiting
/// for quiet and only then asking what the window is removes that whole class
/// of ordering bug. 500ms is comfortably longer than any maximize or
/// DPI-change animation and short enough that a hard kill loses nothing.
#[cfg(desktop)]
const DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(500);

pub struct WindowStateManager {
    store: Store,
    windows: Mutex<BTreeMap<String, WindowGeometry>>,
}

impl WindowStateManager {
    /// A poisoned lock means some other thread panicked while holding it, not
    /// that the data is wrong. Recovering beats silently never saving again.
    fn windows(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, WindowGeometry>> {
        self.windows.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Loads the saved state and registers it on the app. Call once, before the
/// window is built.
///
/// A failure here leaves nothing managed, which every function below treats as
/// "the feature is off". The window still opens.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let dir = match app.path().app_config_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[window-state] no config directory, geometry will not persist: {e}");
            return;
        }
    };

    let store = Store::new(dir);
    let windows = store.load();
    app.manage(WindowStateManager {
        store,
        windows: Mutex::new(windows),
    });
}

/// Where the given window should open, or `None` to leave it where the
/// platform put it.
pub fn placement_for<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<Placement> {
    let manager = app.try_state::<WindowStateManager>()?;
    let monitors = monitors(app);
    let windows = manager.windows();
    placement::resolve(windows.get(label), &monitors, DEFAULT_SIZE, MIN_SIZE)
}

/// Moves the window to a resolved placement. The window should still be hidden:
/// every step here is visible if it is not.
pub fn apply<R: Runtime>(
    window: &WebviewWindow<R>,
    placement: Option<Placement>,
) -> tauri::Result<()> {
    let Some(placement) = placement else {
        return Ok(());
    };

    let position = tauri::PhysicalPosition {
        x: placement.position.x,
        y: placement.position.y,
    };

    // Position first, so the window is on the target display before its size is
    // interpreted. Physical setters throughout: the logical ones are resolved
    // against whichever display the window currently occupies, which is exactly
    // what is being changed.
    window.set_position(position)?;
    window.set_size(tauri::PhysicalSize {
        width: placement.size.width,
        height: placement.size.height,
    })?;
    // Not redundant. Crossing a DPI boundary raises WM_DPICHANGED on Windows,
    // which carries a suggested rect and can move the window after the size is
    // applied.
    window.set_position(position)?;

    match placement.mode {
        WindowMode::Windowed => {}
        WindowMode::Maximized => window.maximize()?,
        WindowMode::Fullscreen => window.set_fullscreen(true)?,
    }

    Ok(())
}

/// Starts tracking a window. Windows that are never attached - `splash` - are
/// never persisted, which is what the plugin needed a denylist for.
pub fn attach<R: Runtime>(window: &WebviewWindow<R>) {
    let label = window.label().to_string();

    // Seed from the window as it stands, so a maximize on a first launch still
    // has a windowed rect to fall back to.
    if let Some(observation) = observe(window) {
        record(window.app_handle(), &label, &observation);
    }

    // Per-window, so two tracked windows cannot cancel each other's saves.
    let generation = Arc::new(AtomicU64::new(0));
    let tracked = window.clone();

    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_)
        | WindowEvent::Moved(_)
        | WindowEvent::ScaleFactorChanged { .. } => {
            schedule(&tracked, &label, &generation);
        }
        // Already on the main thread, and there may be no later chance to
        // write. Cancel any pending debounce so it cannot run against a
        // half-destroyed window afterwards.
        WindowEvent::CloseRequested { .. } => {
            generation.fetch_add(1, Ordering::AcqRel);
            if let Some(observation) = observe(&tracked) {
                record(tracked.app_handle(), &label, &observation);
            }
            flush(tracked.app_handle());
        }
        // Deliberately does not re-read the window. Teardown is a transition
        // like any other, and a geometry reported by a window that is being
        // destroyed is not one the user chose - reading it here would let the
        // last moment of the session overwrite the whole session. Whatever
        // `CloseRequested` recorded is already correct; this only makes sure it
        // reached disk, for the paths where that event never fires.
        WindowEvent::Destroyed => {
            generation.fetch_add(1, Ordering::AcqRel);
            flush(tracked.app_handle());
        }
        _ => {}
    });
}

/// Writes the current state to disk. Cheap enough to call on every settle.
pub fn flush<R: Runtime>(app: &AppHandle<R>) {
    let Some(manager) = app.try_state::<WindowStateManager>() else {
        return;
    };

    // Snapshot and drop the lock: the write must not block window events.
    let snapshot = manager.windows().clone();

    if let Err(e) = manager.store.save(&snapshot) {
        eprintln!("[window-state] could not save window geometry: {e}");
    }
}

/// Queues a save for `DEBOUNCE` from now, superseding any already queued.
///
/// Desktop-only because `tokio` is a desktop-only dependency of this crate, and
/// because the transitions the debounce exists to outlast are desktop
/// window-manager behaviour. `main_window::build` is deliberately not
/// desktop-gated - mobile has to build the window too - so this is gated here
/// rather than at the call site.
#[cfg(desktop)]
fn schedule<R: Runtime>(window: &WebviewWindow<R>, label: &str, generation: &Arc<AtomicU64>) {
    let mine = generation.fetch_add(1, Ordering::AcqRel) + 1;
    let generation = Arc::clone(generation);
    let window = window.clone();
    let label = label.to_string();

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DEBOUNCE).await;
        if generation.load(Ordering::Acquire) != mine {
            return; // A later event arrived; it owns the save now.
        }

        let app = window.app_handle().clone();

        // The window must be read on the main thread. Doing it here rather than
        // in the event handler is the point of the debounce: by now the
        // platform has settled and `is_maximized` and friends tell the truth.
        let (tx, rx) = tokio::sync::oneshot::channel();
        if app
            .run_on_main_thread(move || {
                let _ = tx.send(observe(&window));
            })
            .is_err()
        {
            return; // Shutting down.
        }

        let Ok(Some(observation)) = rx.await else {
            return;
        };

        record(&app, &label, &observation);
        flush(&app);
    });
}

/// Records straight away, with no debounce. See the desktop version above for
/// why there are two: this one exists so the module still compiles for mobile.
#[cfg(not(desktop))]
fn schedule<R: Runtime>(window: &WebviewWindow<R>, label: &str, _generation: &Arc<AtomicU64>) {
    let app = window.app_handle();
    if let Some(observation) = observe(window) {
        record(app, label, &observation);
        flush(app);
    }
}

/// Reads the window. **Main thread only.**
fn observe<R: Runtime>(window: &WebviewWindow<R>) -> Option<Observation> {
    // A minimized window reports meaningless geometry, and on Windows tao
    // clears its maximized bit on WM_SIZE/SIZE_MINIMIZED - so a window that
    // will come back maximized reads as not maximized. Nothing observed here
    // is worth recording.
    if window.is_minimized().unwrap_or(false) {
        return None;
    }

    let mode = if window.is_fullscreen().unwrap_or(false) {
        WindowMode::Fullscreen
    } else if window.is_maximized().unwrap_or(false) {
        WindowMode::Maximized
    } else {
        WindowMode::Windowed
    };

    let monitor = window.current_monitor().ok().flatten()?;
    let work_area = monitor.work_area();

    // Only a plain windowed reading is a windowed rect. `commit` relies on
    // this being `None` otherwise.
    let rect = match mode {
        WindowMode::Windowed => match (window.outer_position(), window.inner_size()) {
            (Ok(position), Ok(size)) => Some((
                PhysPoint {
                    x: position.x,
                    y: position.y,
                },
                PhysSize {
                    width: size.width,
                    height: size.height,
                },
            )),
            _ => None,
        },
        _ => None,
    };

    Some(Observation {
        mode,
        monitor: monitor_id(&monitor),
        work_area_pos: PhysPoint {
            x: work_area.position.x,
            y: work_area.position.y,
        },
        scale: monitor.scale_factor(),
        rect,
    })
}

fn record<R: Runtime>(app: &AppHandle<R>, label: &str, observation: &Observation) {
    let Some(manager) = app.try_state::<WindowStateManager>() else {
        return;
    };

    let mut windows = manager.windows();
    let updated = placement::commit(windows.get(label), observation, DEFAULT_SIZE);
    windows.insert(label.to_string(), updated);
}

fn monitor_id(monitor: &Monitor) -> MonitorId {
    MonitorId {
        name: monitor.name().cloned(),
        position: PhysPoint {
            x: monitor.position().x,
            y: monitor.position().y,
        },
        size: PhysSize {
            width: monitor.size().width,
            height: monitor.size().height,
        },
        scale: monitor.scale_factor(),
    }
}

/// Enumerates the displays.
///
/// Called from `main_window::build`, which on the desktop path runs in a
/// spawned task rather than on the main thread. That is deliberate and known:
/// `AppHandle::available_monitors` is a public API with no main-thread
/// requirement, and `tauri-runtime-wry` reads its window target directly here
/// rather than dispatching (unlike `cursor_position` next to it). On Windows it
/// bottoms out in `EnumDisplayMonitors`, which is thread-safe. If this ever
/// needs to hold on another platform, hop through `run_on_main_thread` the way
/// `schedule` does for `observe`.
fn monitors<R: Runtime>(app: &AppHandle<R>) -> Vec<MonitorInfo> {
    // Tauri exposes no `is_primary`, so the primary is fetched separately and
    // matched by identity.
    let primary = app.primary_monitor().ok().flatten().map(|m| monitor_id(&m));

    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let id = monitor_id(monitor);
            let work_area = monitor.work_area();
            MonitorInfo {
                primary: primary.as_ref().is_some_and(|p| p.matches_exactly(&id)),
                id,
                work_area_pos: PhysPoint {
                    x: work_area.position.x,
                    y: work_area.position.y,
                },
                work_area_size: PhysSize {
                    width: work_area.size.width,
                    height: work_area.size.height,
                },
            }
        })
        .collect()
}
