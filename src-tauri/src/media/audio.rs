use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use nnnoiseless::DenoiseState;
use serde::{Deserialize, Serialize};
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

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioCaptureSettings {
    pub device_id: Option<String>,
    pub noise_suppression: bool,
    pub auto_gain_control: bool,
    /// VAD probability threshold below which frames are silenced (0.0–1.0)
    pub vad_threshold: f32,
}

impl Default for AudioCaptureSettings {
    fn default() -> Self {
        Self {
            device_id: None,
            noise_suppression: true,
            auto_gain_control: true,
            vad_threshold: 0.0,
        }
    }
}

/// Shared state for the running audio capture stream.
pub struct AudioCaptureState(pub Arc<Mutex<Option<oneshot::Sender<()>>>>);

impl Default for AudioCaptureState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

/// Shared state for the running loopback capture stream.
pub struct LoopbackCaptureState(pub Arc<Mutex<Option<oneshot::Sender<()>>>>);

impl Default for LoopbackCaptureState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

/// PCM audio chunk sent to JS — base64-encoded f32 LE bytes, mono 48 kHz.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunk {
    /// base64-encoded raw f32-le PCM samples (mono, 48 kHz)
    pub data: String,
    pub sample_rate: u32,
    pub channels: u32,
}

const RNNOISE_FRAME: usize = 480; // 10 ms @ 48 kHz — nnnoiseless::FRAME_SIZE
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

#[tauri::command]
pub async fn start_audio_capture(
    settings: AudioCaptureSettings,
    on_chunk: Channel<AudioChunk>,
    state: tauri::State<'_, AudioCaptureState>,
) -> Result<(), String> {
    eprintln!("[audio] start_audio_capture — device_id={:?} noise_suppression={} agc={} vad={}",
        settings.device_id, settings.noise_suppression, settings.auto_gain_control, settings.vad_threshold);

    // Stop any existing capture
    stop_audio_capture_inner(&state);

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    *state.0.lock().unwrap() = Some(stop_tx);

    let host = cpal::default_host();
    eprintln!("[audio] cpal host: {}", host.id().name());

    // Log all available input devices for diagnostics
    match host.input_devices() {
        Ok(devs) => {
            let names: Vec<String> = devs
                .map(|d| d.name().unwrap_or_else(|_| "<err>".into()))
                .collect();
            eprintln!("[audio] available input devices ({}): {:?}", names.len(), names);
        }
        Err(e) => eprintln!("[audio] failed to list input devices: {e}"),
    }

    let default_dev_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());
    eprintln!("[audio] default input device: {:?}", default_dev_name);

    let device = if let Some(ref id) = settings.device_id {
        eprintln!("[audio] looking up device by id={:?}", id);
        if id == "default" {
            host.default_input_device()
        } else {
            let found = host.input_devices()
                .ok()
                .and_then(|mut iter| iter.find(|d| d.name().ok().as_deref() == Some(id.as_str())));
            if found.is_none() {
                eprintln!("[audio] device {:?} not found by name, falling back to default", id);
            }
            found.or_else(|| host.default_input_device())
        }
    } else {
        eprintln!("[audio] no device_id, using default");
        host.default_input_device()
    };

    let device = device.ok_or_else(|| {
        eprintln!("[audio] ERROR: no input device available — check Windows Sound settings");
        "No input device available".to_string()
    })?;

    eprintln!("[audio] selected device: {:?}", device.name());

    // Prefer 48 kHz mono; fall back to device config
    let config = pick_config(&device).map_err(|e| {
        eprintln!("[audio] pick_config failed: {e}");
        e
    })?;
    eprintln!("[audio] stream config: {:?} ch={} rate={}", config.buffer_size, config.channels, config.sample_rate.0);
    let sample_rate = config.sample_rate.0;
    let channels = config.channels as usize;

    // Ring buffer from cpal callback → async task
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(64);
    let tx_err = tx.clone();

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _| {
                let _ = tx.send(data.to_vec());
            },
            move |err| {
                eprintln!("[audio] cpal stream error: {err}");
                drop(tx_err.clone());
            },
            None,
        )
        .map_err(|e| {
            eprintln!("[audio] build_input_stream failed: {e}");
            e.to_string()
        })?;

    stream.play().map_err(|e| {
        eprintln!("[audio] stream.play() failed: {e}");
        e.to_string()
    })?;
    eprintln!("[audio] stream started successfully");
    let stream = SendStream(stream);

    // Spawn processing task
    tauri::async_runtime::spawn(async move {
        let _stream = stream; // keep alive

        let mut denoiser = DenoiseState::new();
        let mut agc_gain: f32 = 1.0;
        let mut gate_gain: f32 = 1.0;
        let mut hold_frames: u32 = 0;
        // Pre/de-emphasis state — last input sample and last output sample.
        let mut pre_emph_prev: f32 = 0.0;
        let mut de_emph_prev: f32 = 0.0;
        let mut input_buf: Vec<f32> = Vec::with_capacity(BATCH_SAMPLES * 2);
        let mut output_batch: Vec<f32> = Vec::with_capacity(BATCH_SAMPLES);

        loop {
            // Check stop signal
            if stop_rx.try_recv().is_ok() {
                break;
            }

            // Drain all pending chunks from cpal
            let mut got_data = false;
            while let Ok(chunk) = rx.try_recv() {
                // Down-mix to mono if stereo
                let mono: Vec<f32> = if channels > 1 {
                    chunk
                        .chunks(channels)
                        .map(|ch| ch.iter().sum::<f32>() / channels as f32)
                        .collect()
                } else {
                    chunk
                };

                // Resample to 48 kHz if device differs
                let resampled = if sample_rate != 48_000 {
                    resample_linear(&mono, sample_rate, 48_000)
                } else {
                    mono
                };

                input_buf.extend_from_slice(&resampled);
                got_data = true;
            }

            // Process complete RNNoise frames
            while input_buf.len() >= RNNOISE_FRAME {
                let frame: Vec<f32> = input_buf.drain(..RNNOISE_FRAME).collect();

                let processed = if settings.noise_suppression {
                    // Pre-emphasis: y[n] = x[n] - 0.95*x[n-1]
                    // Boosts high frequencies before RNNoise so the model has
                    // more signal energy to work with in the upper voice bands,
                    // reducing over-suppression that makes audio sound thin.
                    let mut pre = Vec::with_capacity(frame.len());
                    let mut prev = pre_emph_prev;
                    for &s in &frame {
                        pre.push(s - 0.95 * prev);
                        prev = s;
                    }
                    pre_emph_prev = *frame.last().unwrap_or(&0.0);

                    let scaled: Vec<f32> = pre.iter().map(|&s| s * 32768.0).collect();
                    let mut rnn_out = vec![0.0f32; RNNOISE_FRAME];
                    let vad = denoiser.process_frame(&mut rnn_out, &scaled);

                    // De-emphasis: y[n] = x[n]/32768 + 0.95*y[n-1]
                    // Restores the natural frequency balance after RNNoise.
                    let mut denoised = Vec::with_capacity(rnn_out.len());
                    let mut prev_d = de_emph_prev;
                    for &s in &rnn_out {
                        let y = s / 32768.0 + 0.95 * prev_d;
                        denoised.push(y);
                        prev_d = y;
                    }
                    de_emph_prev = *denoised.last().unwrap_or(&0.0);

                    // 80/20 blend: preserves more natural warmth and prevents
                    // RNNoise from completely suppressing quiet/atypical voices.
                    let mut blended: Vec<f32> = denoised
                        .iter()
                        .zip(frame.iter())
                        .map(|(&d, &o)| d * 0.8 + o * 0.2)
                        .collect();

                    // Smooth VAD gate (attack 50 ms, hold 250 ms, release ~200 ms).
                    if settings.vad_threshold > 0.0 {
                        if vad >= settings.vad_threshold {
                            hold_frames = 25;
                        }
                        if hold_frames > 0 {
                            hold_frames -= 1;
                            gate_gain += (1.0 - gate_gain) * 0.6;
                        } else {
                            gate_gain *= 0.85;
                        }
                        blended.iter_mut().for_each(|s| *s *= gate_gain);
                    }

                    blended
                } else {
                    frame
                };

                let gained = if settings.auto_gain_control {
                    apply_agc(processed, &mut agc_gain)
                } else {
                    processed
                };

                output_batch.extend_from_slice(&gained);
            }

            // Send when we have a full batch
            if output_batch.len() >= BATCH_SAMPLES {
                let samples: Vec<f32> = output_batch.drain(..BATCH_SAMPLES).collect();
                let raw: Vec<u8> = samples.iter().flat_map(|&f| f.to_le_bytes()).collect();
                let encoded = base64_encode(&raw);
                let _ = on_chunk.send(AudioChunk {
                    data: encoded,
                    sample_rate: 48_000,
                    channels: 1,
                });
            }

            if !got_data {
                tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_audio_capture(state: tauri::State<'_, AudioCaptureState>) {
    stop_audio_capture_inner(&state);
}

fn stop_audio_capture_inner(state: &AudioCaptureState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn pick_config(device: &cpal::Device) -> Result<cpal::StreamConfig, String> {
    // Try 48 kHz mono first
    let preferred = cpal::StreamConfig {
        channels: 1,
        sample_rate: cpal::SampleRate(48_000),
        buffer_size: cpal::BufferSize::Default,
    };
    if device
        .supported_input_configs()
        .map(|mut c| {
            c.any(|sc| {
                sc.channels() == 1
                    && sc.min_sample_rate().0 <= 48_000
                    && sc.max_sample_rate().0 >= 48_000
            })
        })
        .unwrap_or(false)
    {
        return Ok(preferred);
    }

    // Try 48 kHz stereo (will down-mix in processing)
    if device
        .supported_input_configs()
        .map(|mut c| {
            c.any(|sc| sc.min_sample_rate().0 <= 48_000 && sc.max_sample_rate().0 >= 48_000)
        })
        .unwrap_or(false)
    {
        return Ok(cpal::StreamConfig {
            channels: device
                .supported_input_configs()
                .ok()
                .and_then(|mut c| {
                    c.find(|sc| {
                        sc.min_sample_rate().0 <= 48_000 && sc.max_sample_rate().0 >= 48_000
                    })
                })
                .map(|sc| sc.channels())
                .unwrap_or(1),
            sample_rate: cpal::SampleRate(48_000),
            buffer_size: cpal::BufferSize::Default,
        });
    }

    // Fall back to device default
    device
        .default_input_config()
        .map(|c| c.into())
        .map_err(|e| e.to_string())
}

/// Linear resampling — adequate quality for voice.
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

/// Levelling AGC — targets −16 dBFS RMS with fast gain reduction and slow
/// gain increase to prevent pumping and overgain bursts.
fn apply_agc(mut samples: Vec<f32>, gain: &mut f32) -> Vec<f32> {
    const TARGET_RMS: f32 = 0.15; // −16 dBFS
    const MAX_GAIN: f32 = 4.0; // +12 dB max boost
                               // Fast attack: reduces gain quickly when signal is loud (~4 frames = 40 ms).
    const ATTACK: f32 = 0.25;
    // Slow release: increases gain gradually when signal drops (~300 frames = 3 s).
    const RELEASE: f32 = 0.003;
    // Below this RMS the signal is silence/noise — freeze gain rather than
    // boosting aggressively, which would cause an overgain burst on re-entry.
    const NOISE_FLOOR: f32 = 0.008; // −42 dBFS

    let rms = (samples.iter().map(|&s| s * s).sum::<f32>() / samples.len() as f32).sqrt();

    if rms > NOISE_FLOOR {
        let desired = (TARGET_RMS / rms).min(MAX_GAIN);
        // Use fast path when gain needs to come down, slow path when going up.
        let alpha = if desired < *gain { ATTACK } else { RELEASE };
        *gain = (*gain * (1.0 - alpha) + desired * alpha).min(MAX_GAIN);
    } else {
        // During silence, bleed accumulated gain back toward 1.0 so that
        // re-entry after a long pause doesn't explode at MAX_GAIN.
        *gain = 1.0 + (*gain - 1.0) * 0.99;
    }

    samples
        .iter_mut()
        .for_each(|s| *s = (*s * *gain).clamp(-1.0, 1.0));
    samples
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
    let tx_err = tx.clone();

    let stream = match device.build_input_stream(
        &config,
        move |data: &[f32], _| {
            let _ = tx.send(data.to_vec());
        },
        move |err| {
            eprintln!("[loopback] cpal error: {err}");
            drop(tx_err.clone());
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
