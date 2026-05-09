mod crypto;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod media;

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

    /// Adds WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW to a window's extended style.
    ///
    /// Safety: hwnd must be a valid Win32 window handle for the lifetime of the call.
    pub unsafe fn set_noactivate_exstyle(hwnd: *mut core::ffi::c_void) {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            ex | WS_EX_NOACTIVATE as isize | WS_EX_TOOLWINDOW as isize,
        );
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
        let hwnd = win.hwnd().map_err(|e| e.to_string())?.0;
        // Safety: hwnd comes from a live Tauri window handle.
        unsafe {
            set_noactivate_exstyle(hwnd);
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
        let hwnd = _win.hwnd().map_err(|e| e.to_string())?.0;
        // Safety: hwnd comes from a live Tauri window handle.
        unsafe {
            win32::set_noactivate_exstyle(hwnd);
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
        let hwnd = _win.hwnd().map_err(|e| e.to_string())?.0;
        // Safety: hwnd comes from a live Tauri window handle.
        unsafe {
            win32::set_noactivate_exstyle(hwnd);
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
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
    let builder = builder.plugin(tauri_plugin_notifications::init());

    build_and_run(builder);
}

// Split into separate functions so #[cfg] can gate the full handler list.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn build_and_run(builder: tauri::Builder<tauri::Wry>) {
    builder
        .manage(media::audio::AudioCaptureState::default())
        .manage(media::audio::LoopbackCaptureState::default())
        .manage(media::screen::ScreenCaptureState::default())
        .manage(crypto::mls::MlsStateHandle::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_memory_usage,
            show_noactivate,
            setup_toast_window,
            prepare_notification,
            crypto::crypto::generate_key,
            crypto::crypto::generate_key_pairs,
            crypto::crypto::setup_master_key,
            crypto::mls::generate_mls_key_packages,
            crypto::mls::mls_load_signing_key,
            crypto::mls::mls_unload_signing_key,
            crypto::mls::mls_create_group,
            crypto::mls::mls_add_members,
            crypto::mls::mls_join_group,
            crypto::mls::mls_send_message,
            crypto::mls::mls_process_message,
            crypto::mls::mls_remove_members,
            crypto::mls::mls_leave_group,
            crypto::mls::mls_export_group_info,
            crypto::mls::mls_rejoin_group,
            crypto::mls::mls_delete_group,
            crypto::mls::mls_get_members,
            crypto::mls::mls_get_group_info,
            media::audio::enumerate_audio_devices,
            media::audio::start_audio_capture,
            media::audio::stop_audio_capture,
            media::audio::start_loopback_capture,
            media::audio::stop_loopback_capture,
            media::screen::enumerate_screen_sources,
            media::screen::start_screen_capture,
            media::screen::stop_screen_capture,
            media::screen::set_screen_capture_fps,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn build_and_run(builder: tauri::Builder<tauri::Wry>) {
    builder
        .manage(crypto::mls::MlsStateHandle::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_memory_usage,
            show_noactivate,
            setup_toast_window,
            prepare_notification,
            crypto::crypto::generate_key,
            crypto::crypto::generate_key_pairs,
            crypto::crypto::setup_master_key,
            crypto::mls::generate_mls_key_packages,
            crypto::mls::mls_load_signing_key,
            crypto::mls::mls_unload_signing_key,
            crypto::mls::mls_create_group,
            crypto::mls::mls_add_members,
            crypto::mls::mls_join_group,
            crypto::mls::mls_send_message,
            crypto::mls::mls_process_message,
            crypto::mls::mls_remove_members,
            crypto::mls::mls_leave_group,
            crypto::mls::mls_export_group_info,
            crypto::mls::mls_rejoin_group,
            crypto::mls::mls_delete_group,
            crypto::mls::mls_get_members,
            crypto::mls::mls_get_group_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
