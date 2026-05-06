use image::{DynamicImage, RgbaImage};
use serde::Serialize;
use std::{
    io::Cursor,
    sync::{Arc, Mutex},
};
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use xcap::{Monitor, Window};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSource {
    /// "monitor:N" or "window:N" (N = index in the enumeration)
    pub id: String,
    pub name: String,
    pub is_monitor: bool,
    /// base64-encoded JPEG thumbnail (~320×200)
    pub thumbnail: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScreenFrame {
    /// base64-encoded JPEG frame
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub timestamp_ms: u64,
}

pub struct ScreenCaptureState(pub Arc<Mutex<Option<oneshot::Sender<()>>>>);

impl Default for ScreenCaptureState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

#[tauri::command]
pub async fn enumerate_screen_sources() -> Result<Vec<ScreenSource>, String> {
    tokio::task::spawn_blocking(|| {
        let mut sources = Vec::new();

        // Monitors
        let monitors = Monitor::all().map_err(|e| e.to_string())?;
        for (i, monitor) in monitors.iter().enumerate() {
            let w = monitor.width().unwrap_or(0);
            let h = monitor.height().unwrap_or(0);
            let name_str = monitor.name().unwrap_or_else(|_| format!("Display {}", i + 1));
            let name = format!("{name_str} ({w}×{h})");
            let thumbnail = capture_monitor_thumbnail(monitor);
            sources.push(ScreenSource {
                id: format!("monitor:{i}"),
                name,
                is_monitor: true,
                thumbnail,
                width: w,
                height: h,
            });
        }

        // Windows — filter to visible, titled, large-enough windows
        if let Ok(windows) = Window::all() {
            for (i, window) in windows.iter().enumerate() {
                let title = match window.title() {
                    Ok(t) if !t.is_empty() => t,
                    _ => continue,
                };
                // Skip minimized windows
                if window.is_minimized().unwrap_or(false) {
                    continue;
                }
                let w = window.width().unwrap_or(0);
                let h = window.height().unwrap_or(0);
                if w < 50 || h < 50 {
                    continue;
                }
                let thumbnail = capture_window_thumbnail(window);
                sources.push(ScreenSource {
                    id: format!("window:{i}"),
                    name: title,
                    is_monitor: false,
                    thumbnail,
                    width: w,
                    height: h,
                });
            }
        }

        Ok(sources)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_screen_capture(
    source_id: String,
    fps: u32,
    on_frame: Channel<ScreenFrame>,
    state: tauri::State<'_, ScreenCaptureState>,
) -> Result<(), String> {
    stop_screen_capture_inner(&state);

    let fps = fps.clamp(1, 60);
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    *state.0.lock().unwrap() = Some(stop_tx);

    tauri::async_runtime::spawn(async move {
        let interval_ms = 1000 / fps as u64;
        let mut ticker = tokio::time::interval(tokio::time::Duration::from_millis(interval_ms));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            if stop_rx.try_recv().is_ok() {
                break;
            }

            // All xcap calls happen on a blocking thread to avoid Send constraints
            let src = source_id.clone();
            let frame_result = tokio::task::spawn_blocking(move || capture_source_frame(&src)).await;

            if let Ok(Some((rgba, w, h))) = frame_result {
                let dyn_img = DynamicImage::ImageRgba8(rgba);
                let jpeg = encode_jpeg(&dyn_img, 82);
                let data = base64_encode(&jpeg);
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                if on_frame.send(ScreenFrame { data, width: w, height: h, timestamp_ms: ts }).is_err() {
                    break;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_screen_capture(state: tauri::State<'_, ScreenCaptureState>) {
    stop_screen_capture_inner(&state);
}

fn stop_screen_capture_inner(state: &ScreenCaptureState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
}

// ── Capture helpers ───────────────────────────────────────────────────────────

/// Captures a single frame for the given source ID.
/// Returns (image, width, height) or None on failure.
fn capture_source_frame(source_id: &str) -> Option<(RgbaImage, u32, u32)> {
    if let Some(idx_str) = source_id.strip_prefix("monitor:") {
        let idx: usize = idx_str.parse().ok()?;
        let monitors = Monitor::all().ok()?;
        let monitor = monitors.into_iter().nth(idx)?;
        let img = monitor.capture_image().ok()?;
        let w = img.width();
        let h = img.height();
        Some((img, w, h))
    } else if let Some(idx_str) = source_id.strip_prefix("window:") {
        let idx: usize = idx_str.parse().ok()?;
        let windows = Window::all().ok()?;
        let window = windows.into_iter().nth(idx)?;
        let img = window.capture_image().ok()?;
        let w = img.width();
        let h = img.height();
        Some((img, w, h))
    } else {
        None
    }
}

fn capture_monitor_thumbnail(monitor: &Monitor) -> String {
    match monitor.capture_image() {
        Ok(img) => {
            let dyn_img = DynamicImage::ImageRgba8(img);
            let thumb = dyn_img.thumbnail(320, 200);
            base64_encode(&encode_jpeg(&thumb, 70))
        }
        Err(_) => String::new(),
    }
}

fn capture_window_thumbnail(window: &Window) -> String {
    match window.capture_image() {
        Ok(img) => {
            let dyn_img = DynamicImage::ImageRgba8(img);
            let thumb = dyn_img.thumbnail(320, 200);
            base64_encode(&encode_jpeg(&thumb, 70))
        }
        Err(_) => String::new(),
    }
}

fn encode_jpeg(img: &DynamicImage, quality: u8) -> Vec<u8> {
    let rgb = img.to_rgb8();
    let mut buf = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(&rgb)
        .ok();
    buf.into_inner()
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}
