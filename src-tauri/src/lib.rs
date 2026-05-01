mod crypto;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_memory_usage() -> u64 {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    sys.total_memory()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_memory_usage,
            crypto::crypto::generate_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
