use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CameraDevice {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub fn enumerate_camera_devices() -> Vec<CameraDevice> {
    enumerate_impl()
}

#[cfg(target_os = "windows")]
fn enumerate_impl() -> Vec<CameraDevice> {
    query_nokhwa(nokhwa::utils::ApiBackend::MediaFoundation)
}

#[cfg(target_os = "macos")]
fn enumerate_impl() -> Vec<CameraDevice> {
    query_nokhwa(nokhwa::utils::ApiBackend::AVFoundation)
}

#[cfg(target_os = "linux")]
fn enumerate_impl() -> Vec<CameraDevice> {
    query_nokhwa(nokhwa::utils::ApiBackend::Video4Linux)
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn query_nokhwa(backend: nokhwa::utils::ApiBackend) -> Vec<CameraDevice> {
    match nokhwa::query(backend) {
        Ok(cameras) => cameras
            .iter()
            .map(|info| {
                let id = match info.index() {
                    nokhwa::utils::CameraIndex::Index(n) => n.to_string(),
                    nokhwa::utils::CameraIndex::String(s) => s.clone(),
                };
                CameraDevice {
                    id,
                    name: info.human_name().to_string(),
                }
            })
            .collect(),
        Err(e) => {
            eprintln!("[camera] enumeration failed: {e}");
            vec![]
        }
    }
}
