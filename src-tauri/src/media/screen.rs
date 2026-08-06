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
// WGC is not safe to initialise concurrently -even on separate threads -
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
    /// Always empty from enumeration - see `capture_source_thumbnails`. Kept on the struct so the
    /// wire shape is one type either way.
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
pub enum CaptureHandle {
    Monitor(Monitor),
    Window(Window),
}

impl CaptureHandle {
    pub fn capture(&self) -> Option<(RgbaImage, u32, u32)> {
        let img = match self {
            CaptureHandle::Monitor(m) => m.capture_image().ok()?,
            CaptureHandle::Window(w) => w.capture_image().ok()?,
        };
        let (w, h) = (img.width(), img.height());
        Some((img, w, h))
    }
}

pub fn find_capture_source(source_id: &str) -> Option<CaptureHandle> {
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
                    // Minimised windows are dropped outright. There is nothing to capture (the
                    // grab comes back blank or stale) and nothing to watch if one were shared, so
                    // offering it costs a capture to produce a tile nobody can use.
                    if w.is_minimized().unwrap_or(false) {
                        return None;
                    }

                    let title = w.title().ok().filter(|t| !t.is_empty())?;
                    if !is_shareable_window(&title) {
                        return None;
                    }

                    let width = w.width().unwrap_or(0);
                    let height = w.height().unwrap_or(0);
                    // Raised from 50: nothing that small is a window somebody means to stream, and
                    // the list is easier to read without a dozen invisible helper windows in it.
                    if width < 160 || height < 120 {
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

    // Phase 2 used to capture a thumbnail for every source. There is no phase 2 now.
    //
    // Every capture is a fresh WGC session over a full-resolution surface - on a 4K desktop with a
    // dozen windows open that is tens of seconds of work, all of it holding this lock, all of it
    // before the dialog can show anything. And almost all of it is wasted: the picker shows two
    // tiles per row and the user picks from the first handful.
    //
    // So enumeration is metadata only, which is Win32 calls and returns immediately, and the tiles
    // ask for their own image as they scroll into view - see capture_source_thumbnails.
    let mut sources: Vec<ScreenSource> = monitor_meta
        .into_iter()
        .map(|(idx, name, w, h)| ScreenSource {
            id: format!("monitor:{idx}"),
            name,
            is_monitor: true,
            thumbnail: String::new(),
            width: w,
            height: h,
        })
        .collect();

    sources.extend(window_meta.into_iter().map(|(hwnd_id, title, w, h)| ScreenSource {
        id: format!("window:{hwnd_id}"),
        name: title,
        is_monitor: false,
        thumbnail: String::new(),
        width: w,
        height: h,
    }));

    Ok(sources)
}

/// Widest a batch may be. A caller asking for everything at once would put us straight back to the
/// stall this exists to avoid; four is about a screenful of a two-column grid, so the work arrives
/// in visible chunks instead of one spike.
const MAX_THUMBNAIL_BATCH: usize = 4;

/// One source's thumbnail, keyed by the id it was requested under.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceThumbnail {
    pub id: String,
    /// base64-encoded JPEG, or empty when the source could not be captured (minimised, on another
    /// desktop, capture-protected). The picker falls back to an icon for all three.
    pub thumbnail: String,
}

/// Captures thumbnails for the named sources, and nothing else.
///
/// <p>The lazy half of the picker: tiles request their own image when they scroll into view, so a
/// desktop with forty windows open costs the same as one with four.</p>
#[tauri::command]
pub async fn capture_source_thumbnails(
    source_ids: Vec<String>,
) -> Result<Vec<SourceThumbnail>, String> {
    let wanted: Vec<String> = source_ids.into_iter().take(MAX_THUMBNAIL_BATCH).collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }

    tokio::task::spawn_blocking(move || {
        // The fast path first, for everything. It is GDI: no COM, no D3D, no capture session, and
        // crucially no WGC lock - so it neither waits on a live stream's capture nor makes one wait
        // on the picker. Only the sources it cannot draw fall through to the capture API below.
        let mut results: Vec<SourceThumbnail> = Vec::with_capacity(wanted.len());
        let mut needs_capture_api: Vec<String> = Vec::new();

        for id in wanted {
            match fast_thumbnail(&id) {
                Some(image) => results.push(SourceThumbnail { id, thumbnail: thumbnail_of(Some(image)) }),
                None => needs_capture_api.push(id),
            }
        }

        if !needs_capture_api.is_empty() {
            let _guard = wgc_lock().lock().unwrap();

            // One enumeration for the whole batch, and only of the kinds actually left. A WGC
            // session opened per iteration is what corrupts the COM heap - see wgc_lock.
            let wants_monitor = needs_capture_api.iter().any(|id| id.starts_with("monitor:"));
            let wants_window = needs_capture_api.iter().any(|id| id.starts_with("window:"));
            let monitors = if wants_monitor { Monitor::all().unwrap_or_default() } else { Vec::new() };
            let windows = if wants_window { Window::all().unwrap_or_default() } else { Vec::new() };

            for id in needs_capture_api {
                let thumbnail = if let Some(idx) = id.strip_prefix("monitor:") {
                    idx.parse::<usize>()
                        .ok()
                        .and_then(|i| monitors.get(i))
                        .map(|m| thumbnail_of(m.capture_image().ok()))
                        .unwrap_or_default()
                } else if let Some(hwnd) = id.strip_prefix("window:") {
                    hwnd.parse::<u32>()
                        .ok()
                        .and_then(|target| windows.iter().find(|w| w.id().ok() == Some(target)))
                        .map(|w| thumbnail_of(w.capture_image().ok()))
                        .unwrap_or_default()
                } else {
                    String::new()
                };

                results.push(SourceThumbnail { id, thumbnail });
            }
            // _guard dropped here
        }

        results
    })
    .await
    .map_err(|e| e.to_string())
}

/// The GDI thumbnail for a source, or `None` to fall back to the capture API.
///
/// Windows only. Everywhere else there is no fast path and every source takes the capture route.
#[cfg(target_os = "windows")]
fn fast_thumbnail(source_id: &str) -> Option<RgbaImage> {
    if let Some(hwnd) = source_id.strip_prefix("window:") {
        return super::screen_thumb::window_thumbnail(hwnd.parse().ok()?, THUMBNAIL_MAX);
    }

    if let Some(index) = source_id.strip_prefix("monitor:") {
        // Monitors are read out of the composited desktop by their virtual-screen rectangle, which
        // is metadata rather than capture - no session, and no full-resolution surface to copy.
        let index: usize = index.parse().ok()?;
        let _guard = wgc_lock().lock().unwrap();
        let monitor = Monitor::all().ok()?.into_iter().nth(index)?;
        let (x, y) = (monitor.x().ok()?, monitor.y().ok()?);
        let (w, h) = (monitor.width().ok()? as i32, monitor.height().ok()? as i32);
        drop(_guard);
        return super::screen_thumb::screen_region_thumbnail(x, y, w, h, THUMBNAIL_MAX);
    }

    None
}

#[cfg(not(target_os = "windows"))]
fn fast_thumbnail(_source_id: &str) -> Option<RgbaImage> {
    None
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

            run_capture_loop(source, fps_arc, stop_rx, |rgba, w, h| {
                // Drop frame if encoder is still busy -freshness over buffering.
                let _ = encode_tx.try_send((rgba, w, h));
            });
            // Dropping encode_tx signals the encode thread to exit cleanly.
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Drive a capture source at the requested rate until stopped, handing each frame to `on_frame`.
///
/// Shared by the JPEG preview path and the Rust publisher so both get identical pacing: the rate is
/// re-read every iteration, which is what makes a mid-stream framerate change take effect within
/// one frame instead of requiring a restart.
pub fn run_capture_loop(
    source: CaptureHandle,
    fps: Arc<AtomicU32>,
    stop_rx: std::sync::mpsc::Receiver<()>,
    mut on_frame: impl FnMut(RgbaImage, u32, u32),
) {
    let mut next_frame = std::time::Instant::now();
    loop {
        let current_fps = fps.load(Ordering::Relaxed).clamp(1, 60);
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
        on_frame(rgba, w, h);
    }
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

/// Set the fixed output size for the encode thread.
///
/// The frontend solves this once per session from the source dimensions and the chosen resolution
/// preset, so the value already preserves the source's aspect ratio. The previous command clamped
/// each axis independently against a 480x270 floor and a 3840x2160 ceiling, which silently changed
/// the aspect ratio of ultrawide and portrait sources. Only a sanity range is enforced here.
///
/// Takes effect within one frame interval -the encode thread reads these atomics each frame.
#[tauri::command]
pub fn set_screen_capture_geometry(
    width: u32,
    height: u32,
    state: tauri::State<'_, ScreenCaptureState>,
) {
    state.max_w.store(width.clamp(2, 7680), Ordering::Relaxed);
    state.max_h.store(height.clamp(2, 4320), Ordering::Relaxed);
}

fn stop_screen_capture_inner(state: &ScreenCaptureState) {
    // Dropping the SyncSender disconnects the channel; the capture thread's
    // recv_timeout returns Disconnected and exits cleanly.
    if let Ok(mut guard) = state.stop.lock() {
        guard.take();
    }
}

// ── Capture helpers ───────────────────────────────────────────────────────────

/// Longest edge of a picker thumbnail. The tiles are around 350 device pixels wide in a two-column
/// grid, and this is a picture to recognise a window by, not to read it.
const THUMBNAIL_MAX: u32 = 224;

/// Titles that are never worth offering as a share source.
///
/// <p>Game and app overlays (`RSI Launcher Overlay`, the Steam, Discord and GeForce ones) are real,
/// titled, correctly-sized windows that happen to be transparent chrome drawn over something else -
/// sharing one streams a rectangle of nothing. The rest are system furniture that exists on every
/// Windows desktop.</p>
///
/// <p>Matched case-insensitively, as a whole word for `overlay` so a document called "Overlays.docx"
/// survives.</p>
const JUNK_TITLE_EXACT: &[&str] = &[
    "program manager",
    "windows input experience",
    "windows shell experience host",
    "microsoft text input application",
    "default ime",
    "msctfime ui",
    "gdi+ window",
    "settings ui",
    "task switching",
    "search",
    "start",
];

/// Whether a window is worth listing as a share source.
fn is_shareable_window(title: &str) -> bool {
    let lowered = title.trim().to_ascii_lowercase();
    if lowered.is_empty() || JUNK_TITLE_EXACT.contains(&lowered.as_str()) {
        return false;
    }

    // Whole-word "overlay" anywhere in the title. Every overlay this has been seen to catch is
    // something that cannot be usefully streamed, and a real window whose name contains the word is
    // still shareable by sharing the screen it is on.
    !lowered
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| word == "overlay")
}

/// Shrinks and encodes a captured frame, or gives back an empty string when there was none.
///
/// <p>A failed capture is not worth reporting: a window can be on another desktop or protected from
/// capture, and the picker falls back to an icon for both.</p>
fn thumbnail_of(image: Option<RgbaImage>) -> String {
    let Some(img) = image else { return String::new() };
    let thumb = downscale(&img, THUMBNAIL_MAX);
    base64_encode(&encode_jpeg(&DynamicImage::ImageRgba8(thumb), 55))
}

/// Downscales by sampling the destination rather than filtering the source.
///
/// <p>The cost of a thumbnail is not the capture alone - `image`'s own `thumbnail`/`resize` touch
/// every pixel of the input, which for a 4K window is eight million of them, per window, on a
/// dialog somebody is waiting on. This reads four samples per *output* pixel instead: a couple of
/// hundred thousand reads whatever the source resolution, so a 4K monitor costs the same as a small
/// window.</p>
///
/// <p>Four samples rather than one because pure nearest-neighbour aliases text into noise at this
/// reduction; two-by-two is enough to settle it and is still a fixed, tiny cost.</p>
fn downscale(src: &RgbaImage, max_edge: u32) -> RgbaImage {
    let (sw, sh) = src.dimensions();
    if sw == 0 || sh == 0 {
        return RgbaImage::new(1, 1);
    }

    let longest = sw.max(sh);
    if longest <= max_edge {
        return src.clone();
    }

    let scale = max_edge as f64 / longest as f64;
    let dw = ((sw as f64 * scale).round() as u32).max(1);
    let dh = ((sh as f64 * scale).round() as u32).max(1);

    let mut out = RgbaImage::new(dw, dh);
    for y in 0..dh {
        // The source rows this output row covers, sampled at a quarter and three quarters through.
        let y0 = ((y as u64 * 4 + 1) * sh as u64 / (dh as u64 * 4)).min(sh as u64 - 1) as u32;
        let y1 = ((y as u64 * 4 + 3) * sh as u64 / (dh as u64 * 4)).min(sh as u64 - 1) as u32;
        for x in 0..dw {
            let x0 = ((x as u64 * 4 + 1) * sw as u64 / (dw as u64 * 4)).min(sw as u64 - 1) as u32;
            let x1 = ((x as u64 * 4 + 3) * sw as u64 / (dw as u64 * 4)).min(sw as u64 - 1) as u32;

            let samples = [
                src.get_pixel(x0, y0),
                src.get_pixel(x1, y0),
                src.get_pixel(x0, y1),
                src.get_pixel(x1, y1),
            ];

            let mut channels = [0u16; 4];
            for pixel in samples {
                for (slot, value) in channels.iter_mut().zip(pixel.0.iter()) {
                    *slot += *value as u16;
                }
            }

            out.put_pixel(
                x,
                y,
                image::Rgba([
                    (channels[0] / 4) as u8,
                    (channels[1] / 4) as u8,
                    (channels[2] / 4) as u8,
                    (channels[3] / 4) as u8,
                ]),
            );
        }
    }

    out
}

fn encode_jpeg(img: &DynamicImage, quality: u8) -> Vec<u8> {
    let mut buf = Vec::new();
    encode_jpeg_into(img, quality, &mut buf);
    buf
}

pub fn encode_jpeg_into(img: &DynamicImage, quality: u8, buf: &mut Vec<u8>) {
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

pub fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid(w: u32, h: u32, px: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(px))
    }

    // ── Source filtering ─────────────────────────────────────────────────────

    #[test]
    fn ordinary_windows_are_shareable() {
        for title in ["Alpine", "document.txt - Notepad", "Star Citizen", "Overlays.docx"] {
            assert!(is_shareable_window(title), "{title} should be listed");
        }
    }

    #[test]
    fn overlays_are_not_shareable() {
        // These are real, correctly-sized, titled windows - transparent chrome drawn over
        // something else. Sharing one streams a rectangle of nothing.
        for title in [
            "RSI Launcher Overlay",
            "Steam Overlay",
            "NVIDIA GeForce Overlay",
            "Discord Overlay",
            "overlay",
        ] {
            assert!(!is_shareable_window(title), "{title} should be filtered out");
        }
    }

    #[test]
    fn a_document_named_after_an_overlay_survives() {
        // The word has to stand alone: matching it as a substring would take "Overlays.docx" and
        // anything else that merely mentions it.
        assert!(is_shareable_window("Overlays.docx"));
        assert!(is_shareable_window("My overlaying concerns"));
    }

    #[test]
    fn system_furniture_is_not_shareable() {
        for title in ["Program Manager", "Windows Input Experience", "Default IME"] {
            assert!(!is_shareable_window(title));
        }
    }

    #[test]
    fn filtering_ignores_case_and_padding() {
        assert!(!is_shareable_window("  PROGRAM MANAGER  "));
        assert!(!is_shareable_window("RSI Launcher OVERLAY"));
    }

    #[test]
    fn an_empty_title_is_not_shareable() {
        assert!(!is_shareable_window(""));
        assert!(!is_shareable_window("   "));
    }

    // ── Downscaling ──────────────────────────────────────────────────────────

    #[test]
    fn downscale_fits_the_longest_edge() {
        let out = downscale(&solid(3840, 2160, [1, 2, 3, 255]), 224);
        assert_eq!(out.width(), 224);
        assert_eq!(out.height(), 126);
    }

    #[test]
    fn downscale_keeps_a_portrait_window_portrait() {
        let out = downscale(&solid(600, 1800, [1, 2, 3, 255]), 224);
        assert_eq!(out.height(), 224);
        assert!(out.width() < out.height());
    }

    #[test]
    fn downscale_leaves_a_small_source_alone() {
        // Nothing to gain, and upscaling would only make the payload bigger.
        let out = downscale(&solid(200, 120, [4, 5, 6, 255]), 224);
        assert_eq!(out.dimensions(), (200, 120));
    }

    #[test]
    fn downscale_preserves_colour() {
        let out = downscale(&solid(1920, 1080, [10, 20, 30, 255]), 224);
        assert_eq!(out.get_pixel(0, 0), &Rgba([10, 20, 30, 255]));
        assert_eq!(out.get_pixel(out.width() - 1, out.height() - 1), &Rgba([10, 20, 30, 255]));
    }

    #[test]
    fn downscale_never_yields_a_zero_dimension() {
        // An extreme aspect ratio rounds one edge towards nothing; a zero-sized image cannot be
        // encoded and would take the whole picker down with it.
        let out = downscale(&solid(4000, 4, [0, 0, 0, 255]), 224);
        assert!(out.width() >= 1 && out.height() >= 1);
    }

    #[test]
    fn downscale_handles_an_empty_frame() {
        let out = downscale(&RgbaImage::new(0, 0), 224);
        assert!(out.width() >= 1 && out.height() >= 1);
    }

    #[test]
    fn thumbnail_of_nothing_is_empty() {
        assert!(thumbnail_of(None).is_empty());
    }

    #[test]
    fn thumbnail_of_a_frame_is_encoded() {
        assert!(!thumbnail_of(Some(solid(1920, 1080, [9, 9, 9, 255]))).is_empty());
    }
}
