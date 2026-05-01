mod crypto;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Win32 declarations — no extra crate needed; user32 is always linked on Windows.
#[cfg(target_os = "windows")]
mod win32 {
    pub const GWL_EXSTYLE: i32 = -20;
    pub const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
    pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    pub const SW_SHOWNOACTIVATE: i32 = 4;

    #[link(name = "user32")]
    extern "system" {
        pub fn GetWindowLongPtrW(hwnd: *mut core::ffi::c_void, n_index: i32) -> isize;
        pub fn SetWindowLongPtrW(
            hwnd: *mut core::ffi::c_void,
            n_index: i32,
            dw_new_long: isize,
        ) -> isize;
        pub fn ShowWindow(hwnd: *mut core::ffi::c_void, n_cmd_show: i32) -> i32;
    }
}

/// Show a Tauri webview-window without activating it or stealing focus from the
/// foreground application. On Windows this sets WS_EX_NOACTIVATE via SetWindowLongPtrW
/// and calls ShowWindow(SW_SHOWNOACTIVATE) so Windows never hands us the foreground.
/// On other platforms it falls back to the regular show().
#[tauri::command]
fn show_noactivate(label: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window '{}' not found", label))?;

    #[cfg(target_os = "windows")]
    {
        use win32::*;
        let hwnd_struct = win.hwnd().map_err(|e| e.to_string())?;
        let hwnd = hwnd_struct.0 as *mut core::ffi::c_void;
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex | WS_EX_NOACTIVATE as isize | WS_EX_TOOLWINDOW as isize,
            );
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }

    #[cfg(not(target_os = "windows"))]
    win.show().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn setup_toast_window(label: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let win = app.get_webview_window(&label)
        .ok_or_else(|| format!("window '{}' not found", label))?;

    #[cfg(target_os = "windows")]
    {
        use win32::*; // Ensure you have the right imports (e.g. from window-v2 or similar)
        let hwnd = win.hwnd().map_err(|e| e.to_string())?.0 as *mut core::ffi::c_void;
        unsafe {
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex_style | WS_EX_NOACTIVATE as isize | WS_EX_TOOLWINDOW as isize,
            );
        }
    }
    Ok(())
}

#[tauri::command]
fn get_memory_usage() -> u64 {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    sys.total_memory()
}

#[tauri::command]
fn prepare_notification(label: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let win = app.get_webview_window(&label)
        .ok_or_else(|| format!("window '{}' not found", label))?;

    #[cfg(target_os = "windows")]
    {
        use win32::*; // Ensure your win32 crate/bindings are accessible
        let hwnd = win.hwnd().map_err(|e| e.to_string())?.0 as *mut core::ffi::c_void;
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            // Apply styles immediately while hidden
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE as isize | WS_EX_TOOLWINDOW as isize);
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()

        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_memory_usage,
            show_noactivate,
            setup_toast_window,
            prepare_notification,
            crypto::crypto::generate_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
