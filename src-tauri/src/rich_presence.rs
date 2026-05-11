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

/// Returns the title of the first detected running game, or `None` if no match is found.
/// The game map CSV is read from the app's resource directory on each call.
#[tauri::command]
pub fn scan_game_process(app: tauri::AppHandle) -> Result<Option<String>, String> {
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
