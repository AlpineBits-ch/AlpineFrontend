use image::{DynamicImage, RgbaImage};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::ipc::Channel;
use xcap::{Monitor, Window};

// Global serialisation lock for all xcap/WGC calls.
// WGC is not safe to initialise concurrently -even on separate threads —
// on Windows 10/11. All Monitor::all() and Window::all() calls must be
// serialised through this lock. Without it, concurrent WGC initialisations
// (e.g. enumerate_screen_sources + start_screen_capture called close together
// from the frontend) corrupt the COM/WGC heap and produce STATUS_HEAP_CORRUPTION.
static WGC_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn wgc_lock() -> &'static Mutex<()> {
    WGC_LOCK.get_or_init(|| Mutex::new(()))
}

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

pub struct ScreenCaptureState {
    stop: Arc<Mutex<Option<std::sync::mpsc::SyncSender<()>>>>,
    fps: Arc<AtomicU32>,
    max_w: Arc<AtomicU32>,
    max_h: Arc<AtomicU32>,
}

impl Default for ScreenCaptureState {
    fn default() -> Self {
        Self {
            stop: Arc::new(Mutex::new(None)),
            fps: Arc::new(AtomicU32::new(15)),
            max_w: Arc::new(AtomicU32::new(1920)),
            max_h: Arc::new(AtomicU32::new(1080)),
        }
    }
}

/// Owns a live WGC capture session for the duration of a streaming session.
/// Created once per session -recreating it each frame causes heap corruption.
enum CaptureHandle {
    Monitor(Monitor),
    Window(Window),
}

impl CaptureHandle {
    fn capture(&self) -> Option<(RgbaImage, u32, u32)> {
        let img = match self {
            CaptureHandle::Monitor(m) => m.capture_image().ok()?,
            CaptureHandle::Window(w) => w.capture_image().ok()?,
        };
        let (w, h) = (img.width(), img.height());
        Some((img, w, h))
    }
}

fn find_capture_source(source_id: &str) -> Option<CaptureHandle> {
    // Hold the WGC lock for the entire enumeration so this cannot race with
    // enumerate_screen_sources or another find_capture_source call.
    let _guard = wgc_lock().lock().unwrap();

    if let Some(idx_str) = source_id.strip_prefix("monitor:") {
        let idx: usize = idx_str.parse().ok()?;
        Monitor::all()
            .ok()?
            .into_iter()
            .nth(idx)
            .map(CaptureHandle::Monitor)
    } else if let Some(id_str) = source_id.strip_prefix("window:") {
        let hwnd_id: u32 = id_str.parse().ok()?;
        Window::all()
            .ok()?
            .into_iter()
            .find(|w| w.id().ok() == Some(hwnd_id))
            .map(CaptureHandle::Window)
    } else {
        None
    }
}

#[tauri::command]
pub async fn enumerate_screen_sources() -> Result<Vec<ScreenSource>, String> {
    // Phase 1: enumerate metadata -no WGC, just Win32 API calls.
    // The WGC lock is held for the entire blocking closure so Monitor::all()
    // and Window::all() cannot race with a concurrent find_capture_source call.
    type MonitorMeta = (usize, String, u32, u32);
    type WindowMeta = (u32, String, u32, u32);
    let (monitor_meta, window_meta) =
        tokio::task::spawn_blocking(|| -> Result<(Vec<MonitorMeta>, Vec<WindowMeta>), String> {
            let _guard = wgc_lock().lock().unwrap();

            let monitors: Vec<MonitorMeta> = Monitor::all()
                .map_err(|e| e.to_string())?
                .into_iter()
                .enumerate()
                .map(|(i, m)| {
                    let w = m.width().unwrap_or(0);
                    let h = m.height().unwrap_or(0);
                    let name = format!(
                        "{} ({w}×{h})",
                        m.name().unwrap_or_else(|_| format!("Display {}", i + 1))
                    );
                    (i, name, w, h)
                })
                .collect();

            let windows: Vec<WindowMeta> = Window::all()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|w| {
                    let title = w.title().ok().filter(|t| !t.is_empty())?;
                    let width = w.width().unwrap_or(0);
                    let height = w.height().unwrap_or(0);
                    if width < 50 || height < 50 {
                        return None;
                    }
                    Some((w.id().ok()?, title, width, height))
                })
                .collect();

            Ok((monitors, windows))
            // _guard dropped here -lock released before Phase 2
        })
        .await
        .map_err(|e| e.to_string())??;

    // Phase 2: capture monitor thumbnails sequentially on one blocking thread.
    //
    // Monitor::all() is called ONCE before the loop and the WGC lock is held
    // for the entire phase. Calling Monitor::all() inside the iterator (as was
    // done previously) creates a new WGC session per iteration; multiple
    // concurrent or rapidly sequential WGC sessions corrupt the COM heap.
    let monitor_sources: Vec<Option<ScreenSource>> = tokio::task::spawn_blocking(move || {
        let _guard = wgc_lock().lock().unwrap();

        // Single Monitor::all() call -one WGC initialisation for the whole phase.
        let all_monitors = match Monitor::all() {
            Ok(m) => m,
            Err(_) => return monitor_meta.iter().map(|_| None).collect(),
        };

        monitor_meta
            .into_iter()
            .map(|(idx, name, w, h)| {
                let monitor = all_monitors.get(idx)?;
                Some(ScreenSource {
                    id: format!("monitor:{idx}"),
                    name,
                    is_monitor: true,
                    thumbnail: capture_monitor_thumbnail(monitor),
                    width: w,
                    height: h,
                })
            })
            .collect()
        // _guard dropped here
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut sources: Vec<ScreenSource> = monitor_sources.into_iter().flatten().collect();

    // Windows: skip live thumbnail -the picker renders a 1fps preview instead.
    for (hwnd_id, title, w, h) in window_meta {
        sources.push(ScreenSource {
            id: format!("window:{hwnd_id}"),
            name: title,
            is_monitor: false,
            thumbnail: String::new(),
            width: w,
            height: h,
        });
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
    state.fps.store(fps, Ordering::Relaxed);
    let fps_arc = Arc::clone(&state.fps);
    let max_w_arc = Arc::clone(&state.max_w);
    let max_h_arc = Arc::clone(&state.max_h);

    let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
    *state.stop.lock().unwrap() = Some(stop_tx);

    // Two dedicated OS threads implement a capture→encode pipeline so that
    // WGC capture (~17 ms) and JPEG encoding (~23 ms) overlap instead of
    // running sequentially (~40 ms/frame → 25 fps ceiling).
    //
    // With the pipeline and a 33 ms interval (30 fps):
    //   - Capture thread fires every 33 ms and hands raw RGBA to the encoder.
    //   - Encode thread finishes in ~23 ms -always before the next frame
    //     arrives -so every captured frame is encoded and sent.
    //   - Result: one completed frame every 33 ms = 30 fps.
    //
    // Channel capacity 1: if the encoder hasn't finished by the time the next
    // frame is ready (e.g. on a slow machine), try_send drops the frame rather
    // than buffering it -this keeps latency low at the cost of an occasional
    // dropped frame instead of growing lag.
    std::thread::Builder::new()
        .name("sc-capture".into())
        .spawn(move || {
            let Some(source) = find_capture_source(&source_id) else {
                return;
            };
            let mut next_frame = std::time::Instant::now();

            let (encode_tx, encode_rx) = std::sync::mpsc::sync_channel::<(RgbaImage, u32, u32)>(1);

            // Encode thread: resize + JPEG + base64 + IPC send, independent of capture.
            let _ = std::thread::Builder::new()
                .name("sc-encode".into())
                .spawn(move || {
                    let mut jpeg_buf = Vec::with_capacity(512 * 1024);
                    while let Ok((rgba, w, h)) = encode_rx.recv() {
                        let dyn_img = DynamicImage::ImageRgba8(rgba);
                        let max_w = max_w_arc.load(Ordering::Relaxed);
                        let max_h = max_h_arc.load(Ordering::Relaxed);
                        let dyn_img = if w > max_w || h > max_h {
                            // Triangle (bilinear) is ~5–8× faster than CatmullRom for real-time
                            // streaming -the difference is imperceptible at video frame rates and
                            // is lost in JPEG compression anyway.
                            dyn_img.resize(max_w, max_h, image::imageops::FilterType::Triangle)
                        } else {
                            dyn_img
                        };

                        // Convert RGBA→RGB before JPEG: 25% less encoder input, ~10–15% encoding speedup.
                        let rgb_img = dyn_img.to_rgb8();
                        let out_w = rgb_img.width();
                        let out_h = rgb_img.height();

                        encode_jpeg_into(&DynamicImage::ImageRgb8(rgb_img), 90, &mut jpeg_buf);
                        let data = base64_encode(&jpeg_buf);
                        let ts = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        if on_frame
                            .send(ScreenFrame {
                                data,
                                width: out_w,
                                height: out_h,
                                timestamp_ms: ts,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    // encode_rx exhausted or on_frame closed -thread exits cleanly.
                });

            // Capture loop: reads fps each iteration so set_screen_capture_fps takes effect
            // within one frame (worst-case latency = current frame duration).
            loop {
                let current_fps = fps_arc.load(Ordering::Relaxed).clamp(1, 60);
                let interval = Duration::from_millis(1000 / current_fps as u64);
                let now = std::time::Instant::now();
                let wait = next_frame.saturating_duration_since(now);
                match stop_rx.recv_timeout(wait) {
                    Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                }
                next_frame += interval;

                let Some((rgba, w, h)) = source.capture() else {
                    continue;
                };
                // Drop frame if encoder is still busy -freshness over buffering.
                let _ = encode_tx.try_send((rgba, w, h));
            }
            // Dropping encode_tx signals the encode thread to exit cleanly.
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn stop_screen_capture(state: tauri::State<'_, ScreenCaptureState>) {
    stop_screen_capture_inner(&state);
}

/// Update the capture rate of a running session without stopping it.
/// Takes effect within one frame interval (worst case = 1000/current_fps ms).
#[tauri::command]
pub fn set_screen_capture_fps(fps: u32, state: tauri::State<'_, ScreenCaptureState>) {
    state.fps.store(fps.clamp(1, 60), Ordering::Relaxed);
}

/// Set the maximum output resolution for the encode thread.
/// Takes effect within one frame interval -the encode thread reads these atomics each frame.
#[tauri::command]
pub fn set_screen_capture_resolution(
    width: u32,
    height: u32,
    state: tauri::State<'_, ScreenCaptureState>,
) {
    state.max_w.store(width.clamp(480, 3840), Ordering::Relaxed);
    state
        .max_h
        .store(height.clamp(270, 2160), Ordering::Relaxed);
}

fn stop_screen_capture_inner(state: &ScreenCaptureState) {
    // Dropping the SyncSender disconnects the channel; the capture thread's
    // recv_timeout returns Disconnected and exits cleanly.
    if let Ok(mut guard) = state.stop.lock() {
        guard.take();
    }
}

// ── Capture helpers ───────────────────────────────────────────────────────────

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

fn encode_jpeg(img: &DynamicImage, quality: u8) -> Vec<u8> {
    let mut buf = Vec::new();
    encode_jpeg_into(img, quality, &mut buf);
    buf
}

fn encode_jpeg_into(img: &DynamicImage, quality: u8, buf: &mut Vec<u8>) {
    use jpeg_encoder::ColorType;
    buf.clear();
    let w = img.width() as u16;
    let h = img.height() as u16;
    let enc = jpeg_encoder::Encoder::new(buf, quality);
    let _ = match img {
        DynamicImage::ImageRgba8(rgba) => enc.encode(rgba.as_raw(), w, h, ColorType::Rgba),
        DynamicImage::ImageRgb8(rgb) => enc.encode(rgb.as_raw(), w, h, ColorType::Rgb),
        _ => {
            let rgb = img.to_rgb8();
            enc.encode(rgb.as_raw(), w, h, ColorType::Rgb)
        }
    };
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}
