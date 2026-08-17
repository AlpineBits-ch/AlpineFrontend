use std::collections::HashMap;
use sysinfo::System;
use tauri::Manager;

fn parse_game_map(csv: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in csv.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((process, title)) = line.split_once(',') {
            map.insert(process.trim().to_lowercase(), title.trim().to_owned());
        }
    }
    map
}

/// The name of the running game, or `None`.
///
/// **This is the legacy path, and it defers.** When a catalog is loaded, `presence::detect` owns
/// detection and this returns whatever it currently holds without touching the process list -
/// otherwise the frontend's 30 s poll and the detector's own 15 s scan would each walk every process
/// on the machine. The CSV below runs only on a client that has no catalog yet: a fresh install, or
/// one that has not been able to reach the server.
///
/// The two paths cannot both be live. `presence::report_process_scan` is a no-op once a catalog
/// exists, so the arbiter's `ProcessScan` slot always has exactly one owner.
///
/// The CSV answer carries no application id and is therefore **dropped by the server** -
/// `ActivityWriteGuard` accepts an unvouched name only from `Manual`/`Media`. It survives purely so
/// that a catalogue-less client still renders something locally rather than looking broken.
#[tauri::command]
pub fn scan_game_process(app: tauri::AppHandle) -> Result<Option<String>, String> {
    if crate::presence::catalog_loaded() {
        return Ok(crate::presence::detected_game_name());
    }

    let found = scan_csv(app);
    crate::presence::report_process_scan(found.as_ref().ok().and_then(Clone::clone));
    found
}

/// The pre-catalog matcher, unchanged: 67 basenames, `System::new_all()`, first match wins.
fn scan_csv(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let csv_path = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("game_map.csv");

    let csv = std::fs::read_to_string(&csv_path)
        .map_err(|e| format!("Failed to read game_map.csv at {}: {e}", csv_path.display()))?;

    let game_map = parse_game_map(&csv);

    let mut sys = System::new_all();
    sys.refresh_all();

    for (_pid, process) in sys.processes() {
        let raw = process.name().to_string_lossy().to_lowercase();
        let name = raw.trim_end_matches(".exe");
        if let Some(title) = game_map.get(name) {
            return Ok(Some(title.clone()));
        }
    }

    Ok(None)
}
