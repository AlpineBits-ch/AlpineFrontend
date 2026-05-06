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
const BATCH_SAMPLES: usize = RNNOISE_FRAME * BATCH_FRAMES;

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
pub async fn start_audio_capture(
    settings: AudioCaptureSettings,
    on_chunk: Channel<AudioChunk>,
    state: tauri::State<'_, AudioCaptureState>,
) -> Result<(), String> {
    // Stop any existing capture
    stop_audio_capture_inner(&state);

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    *state.0.lock().unwrap() = Some(stop_tx);

    let host = cpal::default_host();

    let device = if let Some(ref id) = settings.device_id {
        if id == "default" {
            host.default_input_device()
        } else {
            host.input_devices()
                .ok()
                .and_then(|mut iter| iter.find(|d| d.name().ok().as_deref() == Some(id.as_str())))
                .or_else(|| host.default_input_device())
        }
    } else {
        host.default_input_device()
    }
    .ok_or("No input device available")?;

    // Prefer 48 kHz mono; fall back to device config
    let config = pick_config(&device)?;
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
                eprintln!("[audio] cpal error: {err}");
                drop(tx_err.clone());
            },
            None,
        )
        .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    let stream = SendStream(stream);

    // Spawn processing task
    tauri::async_runtime::spawn(async move {
        let _stream = stream; // keep alive

        let mut denoiser = DenoiseState::new();
        let mut agc_gain: f32 = 1.0;
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
                    chunk.chunks(channels).map(|ch| ch.iter().sum::<f32>() / channels as f32).collect()
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
                    // RNNoise expects 16-bit range
                    let scaled: Vec<f32> = frame.iter().map(|&s| s * 32768.0).collect();
                    let mut rnn_out = vec![0.0f32; RNNOISE_FRAME];
                    let vad = denoiser.process_frame(&mut rnn_out, &scaled);

                    // Gate below VAD threshold (suppress non-speech)
                    if settings.vad_threshold > 0.0 && vad < settings.vad_threshold {
                        vec![0.0f32; RNNOISE_FRAME]
                    } else {
                        rnn_out.iter_mut().for_each(|s| *s /= 32768.0);
                        rnn_out
                    }
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
            c.any(|sc| {
                sc.min_sample_rate().0 <= 48_000 && sc.max_sample_rate().0 >= 48_000
            })
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
fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
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

/// Simple levelling AGC — keeps RMS around -18 dBFS.
fn apply_agc(mut samples: Vec<f32>, gain: &mut f32) -> Vec<f32> {
    const TARGET_RMS: f32 = 0.125; // ~-18 dBFS
    const MAX_GAIN: f32 = 8.0;
    const ATTACK: f32 = 0.01;
    const RELEASE: f32 = 0.001;

    let rms = {
        let sum: f32 = samples.iter().map(|&s| s * s).sum();
        (sum / samples.len() as f32).sqrt()
    };

    if rms > 0.0001 {
        let desired = TARGET_RMS / rms;
        let alpha = if desired < *gain { ATTACK } else { RELEASE };
        *gain = (*gain * (1.0 - alpha) + desired * alpha).min(MAX_GAIN);
    }

    samples.iter_mut().for_each(|s| *s = (*s * *gain).clamp(-1.0, 1.0));
    samples
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}
