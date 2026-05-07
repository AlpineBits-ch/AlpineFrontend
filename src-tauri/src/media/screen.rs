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
    // Phase 1: enumerate metadata without capturing images (fast — just Win32 API calls).
    type Meta = (usize, String, u32, u32);
    let (monitor_meta, window_meta) = tokio::task::spawn_blocking(|| -> Result<(Vec<Meta>, Vec<Meta>), String> {
        let monitors: Vec<Meta> = Monitor::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .enumerate()
            .map(|(i, m)| {
                let w = m.width().unwrap_or(0);
                let h = m.height().unwrap_or(0);
                let name = format!("{} ({w}×{h})", m.name().unwrap_or_else(|_| format!("Display {}", i + 1)));
                (i, name, w, h)
            })
            .collect();

        let windows: Vec<Meta> = Window::all()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .filter_map(|(i, w)| {
                let title = w.title().ok().filter(|t| !t.is_empty())?;
                if w.is_minimized().unwrap_or(false) { return None; }
                let width = w.width().unwrap_or(0);
                let height = w.height().unwrap_or(0);
                if width < 50 || height < 50 { return None; }
                Some((i, title, width, height))
            })
            .collect();

        Ok((monitors, windows))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Phase 2: capture all thumbnails in parallel — total time ≈ slowest single capture
    // instead of sum of all captures.
    let mut handles: Vec<tokio::task::JoinHandle<Option<ScreenSource>>> = Vec::new();

    for (idx, name, w, h) in monitor_meta {
        handles.push(tokio::task::spawn_blocking(move || {
            let monitors = Monitor::all().ok()?;
            let monitor = monitors.into_iter().nth(idx)?;
            Some(ScreenSource {
                id: format!("monitor:{idx}"),
                name,
                is_monitor: true,
                thumbnail: capture_monitor_thumbnail(&monitor),
                width: w,
                height: h,
            })
        }));
    }

    // Windows: skip thumbnail capture entirely — live 1fps preview in the picker handles it.
    // Avoids spiking the GPU with dozens of simultaneous WGC sessions.
    let mut sources = Vec::new();
    for (idx, title, w, h) in window_meta {
        sources.push(ScreenSource {
            id: format!("window:{idx}"),
            name: title,
            is_monitor: false,
            thumbnail: String::new(),
            width: w,
            height: h,
        });
    }

    for handle in handles {
        if let Ok(Some(src)) = handle.await {
            sources.push(src);
        }
    }

    Ok(sources)
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
                // Downscale to at most 1920×1080 to keep IPC payload manageable.
                const MAX_W: u32 = 1920;
                const MAX_H: u32 = 1080;
                let dyn_img = if w > MAX_W || h > MAX_H {
                    dyn_img.resize(MAX_W, MAX_H, image::imageops::FilterType::Nearest)
                } else {
                    dyn_img
                };
                let out_w = dyn_img.width();
                let out_h = dyn_img.height();
                let jpeg = encode_jpeg(&dyn_img, 82);
                let data = base64_encode(&jpeg);
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                if on_frame.send(ScreenFrame { data, width: out_w, height: out_h, timestamp_ms: ts }).is_err() {
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
