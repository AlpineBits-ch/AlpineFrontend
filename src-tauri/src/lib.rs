mod crypto;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

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

    // On non-Windows desktop and mobile, just show normally
    #[cfg(all(not(target_os = "windows"), not(mobile)))]
    {
        win.show().map_err(|e| e.to_string())?;
    }

    #[cfg(mobile)]
    {
        // iOS/Android: window visibility is managed by the OS
        // Nothing to do here
    }
    Ok(())
}

#[tauri::command]
fn setup_toast_window(label: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let _win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window '{}' not found", label))?;

    #[cfg(target_os = "windows")]
    {
        use win32::*;
        let hwnd = _win.hwnd().map_err(|e| e.to_string())?.0 as *mut core::ffi::c_void;
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
    let _win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window '{}' not found", label))?;

    #[cfg(target_os = "windows")]
    {
        use win32::*;
        let hwnd = _win.hwnd().map_err(|e| e.to_string())?.0 as *mut core::ffi::c_void;
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex | WS_EX_NOACTIVATE as isize | WS_EX_TOOLWINDOW as isize,
            );
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // Desktop-only plugins
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_notification::init());

    // Mobile-only plugins
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_notifications::init());

    builder
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