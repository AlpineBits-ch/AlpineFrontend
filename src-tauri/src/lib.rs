mod crypto;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod media;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod rich_presence;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod ptt_hook;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop_notifications;

#[cfg(target_os = "windows")]
mod windows_notifications;

/// Device enumeration stubs for mobile -return sensible defaults so the
/// same Tauri commands exist on all targets.
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile_stubs {
    use serde::Serialize;

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct AudioDevice {
        id: String,
        name: String,
        is_default: bool,
    }

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct CameraDevice {
        id: String,
        name: String,
    }

    #[tauri::command]
    pub fn enumerate_audio_devices() -> Vec<AudioDevice> {
        vec![AudioDevice { id: "default".into(), name: "Default".into(), is_default: true }]
    }

    #[tauri::command]
    pub fn enumerate_output_devices() -> Vec<AudioDevice> {
        vec![AudioDevice { id: "default".into(), name: "Default".into(), is_default: true }]
    }

    #[tauri::command]
    pub fn enumerate_camera_devices() -> Vec<CameraDevice> {
        vec![]
    }
}

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

    pub const WM_GETMINMAXINFO: u32 = 0x0024;
    pub const MONITOR_DEFAULTTONEAREST: u32 = 0x00000002;

    #[repr(C)]
    pub struct POINT {
        pub x: i32,
        pub y: i32,
    }
    #[repr(C)]
    pub struct RECT {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }
    #[repr(C)]
    pub struct MINMAXINFO {
        pub pt_reserved: POINT,
        pub pt_max_size: POINT,
        pub pt_max_position: POINT,
        pub pt_min_track_size: POINT,
        pub pt_max_track_size: POINT,
    }
    #[repr(C)]
    pub struct MONITORINFO {
        pub cb_size: u32,
        pub rc_monitor: RECT,
        pub rc_work: RECT,
        pub dw_flags: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn MonitorFromWindow(
            hwnd: *mut core::ffi::c_void,
            dw_flags: u32,
        ) -> *mut core::ffi::c_void;
        pub fn GetMonitorInfoW(h_monitor: *mut core::ffi::c_void, lp_mi: *mut MONITORINFO) -> i32;
    }

    #[link(name = "comctl32")]
    extern "system" {
        pub fn SetWindowSubclass(
            hwnd: *mut core::ffi::c_void,
            pfn_subclass: unsafe extern "system" fn(
                *mut core::ffi::c_void,
                u32,
                usize,
                isize,
                usize,
                usize,
            ) -> isize,
            uid_subclass: usize,
            dw_ref_data: usize,
        ) -> i32;
        pub fn DefSubclassProc(
            hwnd: *mut core::ffi::c_void,
            u_msg: u32,
            w_param: usize,
            l_param: isize,
        ) -> isize;
    }

    /// Subclass proc that constrains maximized size to the monitor's work area,
    /// preventing undecorated windows from covering the taskbar.
    pub unsafe extern "system" fn maximize_subclass_proc(
        hwnd: *mut core::ffi::c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
        _subclass_id: usize,
        _ref_data: usize,
    ) -> isize {
        // Let the rest of the chain (winit's handler) run first so min-size
        // constraints and other state are set correctly.
        let result = DefSubclassProc(hwnd, msg, wparam, lparam);
        if msg == WM_GETMINMAXINFO {
            let mmi = lparam as *mut MINMAXINFO;
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if !monitor.is_null() {
                let mut info = MONITORINFO {
                    cb_size: core::mem::size_of::<MONITORINFO>() as u32,
                    rc_monitor: RECT {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    rc_work: RECT {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    dw_flags: 0,
                };
                if GetMonitorInfoW(monitor, &mut info) != 0 {
                    let w = info.rc_work;
                    // Only constrain the maximized SIZE to the work area so the
                    // window doesn't cover the taskbar.  ptMaxPosition is left
                    // at the default -Windows places the window correctly on
                    // any monitor, and overriding it breaks multi-monitor
                    // maximize by sending the window to the wrong position.
                    (*mmi).pt_max_size.x = w.right - w.left;
                    (*mmi).pt_max_size.y = w.bottom - w.top;
                }
            }
        }
        result
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
fn apply_maximize_fix(label: String, app: tauri::AppHandle) -> Result<(), String> {
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
            SetWindowSubclass(hwnd, maximize_subclass_proc, 1, 0);
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

#[tauri::command]
async fn prepare_notification_icon(url: String) -> Result<Option<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    return Ok(desktop_notifications::fetch_icon(&url).await);
    #[cfg(any(target_os = "android", target_os = "ios"))]
    Ok(None)
}

#[tauri::command]
async fn send_windows_toast(
    title: String,
    body: String,
    icon_url: Option<String>,
    extra: std::collections::HashMap<String, String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return windows_notifications::send_toast(app, &title, &body, icon_url.as_deref(), extra).await;
    #[cfg(not(target_os = "windows"))]
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            windows_notifications::setup("Alpine");
            Ok(())
        })
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())

        .plugin(tauri_plugin_secure_storage::init());

    // Desktop-only plugins
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_single_instance::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
         .plugin(tauri_plugin_single_instance::init(|_app, argv, _cwd| {
                          println!("a new app instance was opened with {argv:?} and the deep link event was already triggered");
                          // when defining deep link schemes at runtime, you must also check `argv` here
                        }))
         .setup(|app| {
           #[cfg(desktop)]
           use tauri_plugin_deep_link::DeepLinkExt;
           app.deep_link().register("venta")?;
           ptt_hook::init(app.handle());
           Ok(())
          })
        .plugin(tauri_plugin_notifications::init());

    // Mobile-only plugins
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_notifications::init());

    build_and_run(builder);
}

// Split into separate functions so #[cfg] can gate the full handler list.

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn build_and_run(builder: tauri::Builder<tauri::Wry>) {
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--remote-debugging-port=9222",
    );
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
            apply_maximize_fix,
            prepare_notification,
            send_windows_toast,
            prepare_notification_icon,
            crypto::crypto::generate_key,
            crypto::crypto::generate_key_pairs,
            crypto::crypto::setup_master_key,
            crypto::crypto::decrypt_master_key,
            crypto::mls::generate_mls_key_packages,
            crypto::mls::mls_generate_key_packages_with_handle,
            crypto::mls::mls_load_signing_key,
            crypto::mls::mls_unload_signing_key,
            crypto::mls::mls_create_group,
            crypto::mls::mls_add_members,
            crypto::mls::mls_join_group,
            crypto::mls::mls_send_message,
            crypto::mls::mls_process_message,
            crypto::mls::mls_remove_members,
            crypto::mls::mls_leave_group,
            crypto::mls::mls_commit_pending_proposals,
            crypto::mls::mls_export_group_info,
            crypto::mls::mls_rejoin_group,
            crypto::mls::mls_delete_group,
            crypto::mls::mls_get_members,
            crypto::mls::mls_get_group_info,
            crypto::mls::mls_init_storage,
            crypto::mls::mls_clear_storage,
            crypto::mls::mls_export_state,
            crypto::mls::mls_import_state,
            media::audio::enumerate_audio_devices,
            media::audio::enumerate_output_devices,
            media::camera::enumerate_camera_devices,
            media::audio::start_audio_capture,
            media::audio::stop_audio_capture,
            media::audio::start_loopback_capture,
            media::audio::stop_loopback_capture,
            media::screen::enumerate_screen_sources,
            media::screen::start_screen_capture,
            media::screen::stop_screen_capture,
            media::screen::set_screen_capture_fps,
            media::screen::set_screen_capture_resolution,
            rich_presence::scan_game_process,
            ptt_hook::ptt_supported,
            ptt_hook::ptt_set_binding,
            ptt_hook::ptt_arm,
            ptt_hook::ptt_disarm,
            ptt_hook::ptt_begin_capture,
            ptt_hook::ptt_cancel_capture,
            ptt_hook::ptt_label,
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
            apply_maximize_fix,
            prepare_notification,
            crypto::crypto::generate_key,
            crypto::crypto::generate_key_pairs,
            crypto::crypto::setup_master_key,
            crypto::crypto::decrypt_master_key,
            crypto::mls::generate_mls_key_packages,
            crypto::mls::mls_generate_key_packages_with_handle,
            crypto::mls::mls_load_signing_key,
            crypto::mls::mls_unload_signing_key,
            crypto::mls::mls_create_group,
            crypto::mls::mls_add_members,
            crypto::mls::mls_join_group,
            crypto::mls::mls_send_message,
            crypto::mls::mls_process_message,
            crypto::mls::mls_remove_members,
            crypto::mls::mls_leave_group,
            crypto::mls::mls_commit_pending_proposals,
            crypto::mls::mls_export_group_info,
            crypto::mls::mls_rejoin_group,
            crypto::mls::mls_delete_group,
            crypto::mls::mls_get_members,
            crypto::mls::mls_get_group_info,
            crypto::mls::mls_init_storage,
            crypto::mls::mls_clear_storage,
            crypto::mls::mls_export_state,
            crypto::mls::mls_import_state,
            mobile_stubs::enumerate_audio_devices,
            mobile_stubs::enumerate_output_devices,
            mobile_stubs::enumerate_camera_devices,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
