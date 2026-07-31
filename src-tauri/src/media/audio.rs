use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Shared state for the running loopback capture stream.
pub struct LoopbackCaptureState(pub Arc<Mutex<Option<oneshot::Sender<()>>>>);

impl Default for LoopbackCaptureState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

/// PCM audio chunk sent to JS -base64-encoded f32 LE bytes, mono 48 kHz.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunk {
    /// base64-encoded raw f32-le PCM samples (mono, 48 kHz)
    pub data: String,
    pub sample_rate: u32,
    pub channels: u32,
}

const RNNOISE_FRAME: usize = 480; // 10 ms @ 48 kHz -nnnoiseless::FRAME_SIZE
/// Number of RNNoise frames batched per IPC send (4 × 10 ms = 40 ms latency)
const BATCH_FRAMES: usize = 4;
pub(super) const BATCH_SAMPLES: usize = RNNOISE_FRAME * BATCH_FRAMES;

// cpal::Stream contains raw pointers and is not Send, but it is safe to move
// between threads when we only keep it alive (no concurrent method calls).
#[allow(dead_code)]
struct SendStream(cpal::Stream);
unsafe impl Send for SendStream {}

#[tauri::command]
pub fn enumerate_audio_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    let mut devices = vec![AudioDevice {
        id: "default".into(),
        name: "Default".into(),
        is_default: true,
    }];

    if let Ok(inputs) = host.input_devices() {
        for device in inputs {
            let name = device.name().unwrap_or_else(|_| "Unknown".into());
            let is_default = name == default_name;
            devices.push(AudioDevice {
                id: name.clone(),
                name,
                is_default,
            });
        }
    }

    devices
}

#[tauri::command]
pub fn enumerate_output_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    let mut devices = vec![AudioDevice {
        id: "default".into(),
        name: "Default".into(),
        is_default: true,
    }];

    if let Ok(outputs) = host.output_devices() {
        for device in outputs {
            let name = device.name().unwrap_or_else(|_| "Unknown".into());
            let is_default = name == default_name;
            devices.push(AudioDevice {
                id: name.clone(),
                name,
                is_default,
            });
        }
    }

    devices
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Linear resampling -adequate quality for voice.
pub(super) fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let out_len = ((input.len() as f64) / ratio).ceil() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * ratio;
        let lo = pos.floor() as usize;
        let hi = (lo + 1).min(input.len() - 1);
        let frac = (pos - lo as f64) as f32;
        out.push(input[lo] * (1.0 - frac) + input[hi] * frac);
    }
    out
}

pub(super) fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

// ── Loopback (system audio) capture ──────────────────────────────────────────

/// Capture system audio output.
///
/// On Windows 10 2004+: uses process-excluded WASAPI loopback so that Alpine's
/// own WebRTC playback (voices of other call participants) is NOT captured,
/// eliminating the echo heard by the screen-share recipient.
///
/// Falls back to cpal device loopback if process-excluded activation fails
/// (e.g. pre-2004 Windows or unsupported audio format).
#[tauri::command]
pub async fn start_loopback_capture(
    on_chunk: Channel<AudioChunk>,
    state: tauri::State<'_, LoopbackCaptureState>,
) -> Result<(), String> {
    stop_loopback_capture_inner(&state);

    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    *state.0.lock().unwrap() = Some(stop_tx);

    // Convert the async oneshot into an AtomicBool the blocking thread can poll.
    let stop_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag_fwd = stop_flag.clone();
    tauri::async_runtime::spawn(async move {
        let _ = stop_rx.await;
        stop_flag_fwd.store(true, std::sync::atomic::Ordering::Relaxed);
    });

    let on_chunk2 = on_chunk;
    let stop2 = stop_flag;

    #[cfg(target_os = "windows")]
    tokio::task::spawn_blocking(move || {
        match crate::media::loopback_win::capture_excluded(on_chunk2.clone(), stop2.clone()) {
            Ok(_) => {}
            Err(e) => {
                eprintln!("[loopback] Process-excluded loopback failed ({e}), falling back");
                loopback_cpal(on_chunk2, stop2);
            }
        }
    });

    #[cfg(not(target_os = "windows"))]
    tokio::task::spawn_blocking(move || loopback_cpal(on_chunk2, stop2));

    Ok(())
}

/// Device-loopback capture via cpal (fallback / non-Windows path).
fn loopback_cpal(on_chunk: Channel<AudioChunk>, stop: Arc<std::sync::atomic::AtomicBool>) {
    let host = cpal::default_host();
    let device = match host.default_output_device() {
        Some(d) => d,
        None => {
            eprintln!("[loopback] No output device");
            return;
        }
    };

    let out_cfg = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[loopback] Config error: {e}");
            return;
        }
    };
    let sample_rate = out_cfg.sample_rate().0;
    let channels = out_cfg.channels() as usize;
    let config: cpal::StreamConfig = out_cfg.into();

    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(64);
    let stop_err = stop.clone();

    let stream = match device.build_input_stream(
        &config,
        move |data: &[f32], _| {
            // try_send: never block the real-time audio callback thread.
            let _ = tx.try_send(data.to_vec());
        },
        move |err| {
            eprintln!("[loopback] cpal error: {err}");
            // Signal the capture loop below to stop rather than spinning forever
            // with a dead stream and no data.
            stop_err.store(true, std::sync::atomic::Ordering::Relaxed);
        },
        None,
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[loopback] Stream error: {e}");
            return;
        }
    };
    if stream.play().is_err() {
        return;
    }
    let _stream = SendStream(stream);

    let mut input_buf: Vec<f32> = Vec::with_capacity(BATCH_SAMPLES * 2);
    let mut output_batch: Vec<f32> = Vec::with_capacity(BATCH_SAMPLES);

    loop {
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }

        let mut got_data = false;
        while let Ok(chunk) = rx.try_recv() {
            let mono: Vec<f32> = if channels > 1 {
                chunk
                    .chunks(channels)
                    .map(|ch| ch.iter().sum::<f32>() / channels as f32)
                    .collect()
            } else {
                chunk
            };
            let resampled = if sample_rate != 48_000 {
                resample_linear(&mono, sample_rate, 48_000)
            } else {
                mono
            };
            input_buf.extend_from_slice(&resampled);
            got_data = true;
        }

        while input_buf.len() >= BATCH_SAMPLES {
            let samples: Vec<f32> = input_buf.drain(..BATCH_SAMPLES).collect();
            let raw: Vec<u8> = samples.iter().flat_map(|&f| f.to_le_bytes()).collect();
            let encoded = base64_encode(&raw);
            if on_chunk
                .send(AudioChunk {
                    data: encoded,
                    sample_rate: 48_000,
                    channels: 1,
                })
                .is_err()
            {
                return;
            }
            output_batch.clear();
        }

        if !got_data {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}

#[tauri::command]
pub fn stop_loopback_capture(state: tauri::State<'_, LoopbackCaptureState>) {
    stop_loopback_capture_inner(&state);
}

fn stop_loopback_capture_inner(state: &LoopbackCaptureState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
}
