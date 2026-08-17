/// Names the faulting module when the process dies on an access violation. See the module.
#[cfg(windows)]
mod crash_reporter;
/// Tees stderr into a rotating log file. See the module.
mod logging;

mod crypto;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod media;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod rich_presence;

/// Rich presence: the Discord-compatible RPC server and the arbiter that merges every source into
/// the one `presence://changed` event the Angular layer listens for. Desktop-only by platform -
/// mobile cannot enumerate processes or bind these sockets.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod presence;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod ptt_hook;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop_notifications;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod data_export;

/// An honest read of the OS keychain: `NoEntry` is absence, every other `keyring` failure is an
/// error. Exists because `tauri-plugin-secure-storage`'s desktop `get_item` reports both as `null`,
/// and "no entry" is what licenses the MLS layer to mint a fresh state key over one that is still
/// there. `#[cfg(desktop)]`, matching the gate the plugin itself uses to pick `desktop.rs` - see the
/// module header for why mobile must not reach it.
#[cfg(desktop)]
mod keychain;

/// The pre-launch update gate: checks for and installs an update before the main
/// window is built, so a client that panics during startup can still be fixed.
/// See docs/superpowers/plans/2026-08-06-pre-launch-update-gate.md.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod update_gate;

/// Size, display and maximized/fullscreen state of the main window, remembered
/// across launches. Replaces `tauri-plugin-window-state`, which had no notion of
/// which monitor a window was on and stored physical pixels, so it could not
/// survive a resolution, scale or arrangement change. See the module docs.
mod window_state;

/// The main (`echo`) window, built in code rather than declared in
/// `tauri.conf.json`. See the module docs for why that distinction matters.
/// Not desktop-gated: removing the window from the config removed it on every
/// platform, so mobile has to build it too - just without the update gate.
mod main_window;

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
    // Before anything else has a chance to print. `attach_parent_console` has already run in
    // `main`, so the console handle this borrows is the real one.
    if let Some(path) = logging::start() {
        eprintln!("[venta] logging to {}", path.display());
    }

    // Bridge the `log` facade onto the stderr we just teed into that file.
    //
    // This is the only view into the crates underneath us. `webrtc-ice` narrates its connectivity
    // checks and its nomination decisions through `log::trace!` and nothing else, so with no
    // subscriber installed those lines went nowhere - and a connection whose candidate pairs all
    // read `Succeeded` while nothing is ever nominated cannot be explained from outside the agent.
    //
    // **A debug build turns the ICE agent's trace on by default**, rather than waiting for someone
    // to set `RUST_LOG`. The bug this exists for reproduces on one person's machine and not on
    // ours, so the run that captures it is a run somebody else makes - and "set this environment
    // variable, through `tauri dev`, on Windows" has already silently produced a log with no trace
    // in it once. `RUST_LOG` still wins when it is set, for narrowing or for turning this off.
    //
    // Release stays silent. Nothing here logs through the facade, so `off` costs a shipped build
    // nothing at all.
    let default_filter = if cfg!(debug_assertions) {
        "webrtc_ice=trace"
    } else {
        "off"
    };
    if let Err(e) = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or(default_filter),
    )
    .try_init()
    {
        eprintln!("[venta] could not install the log bridge: {e}");
    }
    #[cfg(windows)]
    crash_reporter::install();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|_app| {
            // Stays ahead of the update gate, unlike everything else that used to
            // live here. This sets the process AppUserModelID, which Windows reads
            // when a window is first created - running it after the gate would mean
            // running it after `echo` exists, and the taskbar identity would already
            // be wrong. It is also the one initialiser with no panic path: every
            // fallible call inside is handled and reported.
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
        // No window-state plugin: `window_state` handles the main window from
        // `main_window::build`. `splash` is simply never attached there, which
        // is what the plugin's denylist existed to achieve.
        .plugin(tauri_plugin_autostart::Builder::new().build())
         .plugin(tauri_plugin_single_instance::init(|_app, argv, _cwd| {
                          println!("a new app instance was opened with {argv:?} and the deep link event was already triggered");
                          // when defining deep link schemes at runtime, you must also check `argv` here
                        }))
        // The update gate, and everything that must not precede it.
        //
        // Ordering here is load-bearing, not stylistic. Every initialiser below the
        // gate used to run before any window existed, so a panic in any of them made
        // the client permanently unupdatable - we could never ship the fix. Nothing
        // that is not required to *perform* an update may be moved back above
        // `update_gate::run`. See
        // docs/superpowers/plans/2026-08-06-pre-launch-update-gate.md.
        .setup(|app| {
            let handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                let splash = tauri::WebviewWindowBuilder::new(
                    &handle,
                    "splash",
                    tauri::WebviewUrl::App("assets/splash.html".into()),
                )
                .title("Venta")
                .inner_size(320.0, 260.0)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .center()
                .always_on_top(true)
                .build();

                let splash = match splash {
                    Ok(w) => Some(w),
                    Err(e) => {
                        // No splash is survivable; no update is not. Press on.
                        eprintln!("[update-gate] splash window failed to build: {e}");
                        None
                    }
                };

                update_gate::run(&handle).await;

                // Only reached when there was no update, or installing one failed.
                // A successful Windows install never returns here - the plugin execs
                // the installer and calls std::process::exit(0).

                // The main window is built BEFORE the splash is closed, and the
                // order is load-bearing. Tauri exits the process when its last
                // window closes, so closing the splash first leaves zero windows
                // open and races `main_window::build` against the runtime tearing
                // the app down. That race is why the app would show the splash,
                // flicker, and vanish - and why it survived testing on one machine
                // and died on another. Overlapping the two windows for a moment
                // costs nothing; the gap between them costs the whole app.
                if let Err(e) = main_window::build(&handle) {
                    eprintln!("[startup] failed to build main window: {e}");
                    return;
                }

                if let Some(splash) = splash {
                    let _ = splash.close();
                }

                {
                    use tauri_plugin_deep_link::DeepLinkExt;
                    // Was `?` inside setup, which aborted startup on failure. A deep
                    // link that cannot register is not worth refusing to launch over.
                    if let Err(e) = handle.deep_link().register("venta") {
                        eprintln!("[startup] deep link registration failed: {e}");
                    }
                }
                ptt_hook::init(&handle);
                // Installs the arbiter only. The RPC server binds nothing until
                // `presence_rpc_start` is called - taking `discord-ipc-0` from the
                // real Discord is the user's decision.
                presence::init(&handle);
                // Fetch Cisco's OpenH264 binary in the background. Unattended by
                // design; screen sharing falls back to the webview's encoder if it
                // never arrives.
                media::publisher::spawn_provisioning(&handle);
            });

            Ok(())
        })
        .plugin(tauri_plugin_notifications::init());

    // Mobile-only plugins
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_notifications::init())
        // Mobile has no updater and no splash: it builds the main window straight
        // away. It still needs this, because `echo` is no longer declared in
        // tauri.conf.json and would otherwise never be created on any platform.
        .setup(|app| {
            main_window::build(app.handle())?;
            Ok(())
        });

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
            data_export::download_data_export,
            // Desktop list only, and deliberately absent from the mobile list below - the module
            // header says why: on mobile the plugin does not use `keyring`, and on Android `keyring`
            // has no store and falls back to an in-memory mock that answers "no entry" for
            // everything. A missing command fails the `invoke` loudly; a mock would answer wrongly
            // and quietly, which is the failure mode this command exists to remove.
            keychain::keychain_read,
            crypto::crypto::generate_key,
            crypto::crypto::generate_key_pairs,
            crypto::crypto::setup_master_key,
            crypto::crypto::setup_master_key_dual,
            crypto::crypto::rewrap_master_key,
            crypto::crypto::generate_recovery_code,
            crypto::crypto::normalize_recovery_code_checked,
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
            crypto::mls::mls_merge_pending_commit,
            crypto::mls::mls_inspect_key_package,
            crypto::mls::mls_signing_key_fingerprint,
            crypto::mls::mls_clear_pending_commit,
            crypto::mls::mls_export_group_info,
            crypto::mls::mls_rejoin_group,
            crypto::mls::mls_delete_group,
            crypto::mls::mls_get_members,
            crypto::mls::mls_get_group_info,
            crypto::mls::mls_init_storage,
            crypto::mls::mls_clear_storage,
            crypto::mls::mls_export_state,
            crypto::mls::mls_import_state,
            crypto::mls::mls_export_backup,
            crypto::mls::mls_import_backup,
            crypto::mls::mls_drain_pending_messages,
            crypto::mls::mls_current_state_dir,
            crypto::device_cert::device_cert_verify,
            media::audio::enumerate_audio_devices,
            media::audio::enumerate_output_devices,
            media::camera::enumerate_camera_devices,
            media::audio::start_loopback_capture,
            media::audio::stop_loopback_capture,
            media::screen::enumerate_screen_sources,
            media::screen::capture_source_thumbnails,
            media::screen::start_screen_capture,
            media::screen::stop_screen_capture,
            media::screen::set_screen_capture_fps,
            media::screen::set_screen_capture_geometry,
            media::publisher::openh264_status,
            media::publisher::start_screen_publish,
            media::publisher::stop_screen_publish,
            media::publisher::set_publish_fps,
            media::publisher::set_publish_spec,
            media::publisher::set_screen_audio_muted,
            media::publisher::set_local_stream_enabled,
            media::publisher::publish_stats,
            media::voice::voice_start,
            media::voice::voice_stop,
            media::voice::voice_set_mute,
            media::voice::voice_set_ptt_open,
            media::voice::voice_set_processing,
            media::voice::voice_subscribe,
            media::voice::voice_unsubscribe,
            media::voice::voice_stats,
            media::voice::voice_set_user_volume,
            media::voice::voice_set_deafened,
            media::voice::voice_set_spatial_model,
            media::voice::voice_set_position,
            rich_presence::scan_game_process,
            presence::presence_rpc_start,
            presence::presence_rpc_stop,
            presence::presence_rpc_status,
            presence::presence_current,
            presence::presence_catalog_state,
            presence::presence_load_catalog,
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
            // No `keychain::keychain_read` here, and that asymmetry is intended rather than an
            // oversight in keeping the two lists aligned. The `crypto::` lines are what these lists
            // hold byte-identical; `keychain_read` is `#[cfg(desktop)]` because `keyring` addresses a
            // different credential than the plugin's mobile implementation writes, and on Android no
            // credential store exists at all. See `keychain.rs`'s header.
            crypto::crypto::generate_key,
            crypto::crypto::generate_key_pairs,
            crypto::crypto::setup_master_key,
            crypto::crypto::setup_master_key_dual,
            crypto::crypto::rewrap_master_key,
            crypto::crypto::generate_recovery_code,
            crypto::crypto::normalize_recovery_code_checked,
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
            crypto::mls::mls_merge_pending_commit,
            crypto::mls::mls_inspect_key_package,
            crypto::mls::mls_signing_key_fingerprint,
            crypto::mls::mls_clear_pending_commit,
            crypto::mls::mls_export_group_info,
            crypto::mls::mls_rejoin_group,
            crypto::mls::mls_delete_group,
            crypto::mls::mls_get_members,
            crypto::mls::mls_get_group_info,
            crypto::mls::mls_init_storage,
            crypto::mls::mls_clear_storage,
            crypto::mls::mls_export_state,
            crypto::mls::mls_import_state,
            crypto::mls::mls_export_backup,
            crypto::mls::mls_import_backup,
            crypto::mls::mls_drain_pending_messages,
            crypto::mls::mls_current_state_dir,
            crypto::device_cert::device_cert_verify,
            mobile_stubs::enumerate_audio_devices,
            mobile_stubs::enumerate_output_devices,
            mobile_stubs::enumerate_camera_devices,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
