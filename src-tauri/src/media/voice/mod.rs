//! The Rust-native voice pipeline.
//!
//! Audio is captured, processed, encoded, transported, decoded, mixed and played back entirely in
//! Rust. Nothing crosses the Tauri IPC boundary except control messages and level metering.
//!
//! This replaces a pipeline that captured in Rust, base64'd PCM across IPC, rebuffered it in an
//! AudioWorklet and then let the webview encode it - two independent clock domains with no drift
//! correction between them, and no echo cancellation anywhere. `media::publisher` made the same
//! move for screen video first, for the same reasons.
//!
//! Every stage works on one fixed unit: [`FRAME`] samples of mono `f32` at [`SAMPLE_RATE`]. That is
//! both WebRTC's AudioProcessing frame and RNNoise's frame, so no stage has to rebuffer against
//! another.

pub mod capture;
pub mod chain;
pub mod codec;
pub mod denoise;
pub mod gate;
pub mod jitter;
pub mod mixer;
pub mod playout;
pub mod process;
pub mod receive;
pub mod resample;
pub mod ring;
pub mod rtc;
pub mod session;

/// Samples in one frame of mono audio - 10 ms at 48 kHz.
pub const FRAME: usize = 480;

/// The pipeline's only sample rate. Devices running at other rates are converted at the edges
/// (see [`resample`]) so that nothing downstream has to know about it.
pub const SAMPLE_RATE: u32 = 48_000;

/// Duration of one [`FRAME`], in milliseconds.
pub const FRAME_MS: u32 = 10;

use std::sync::{Mutex, OnceLock};

use crate::media::publisher::rtc::IceServerConfig;
use crate::media::publisher::signalling::{SessionRole, Signalling, VoiceTarget};
use chain::ChainConfig;
use gate::{GateConfig, InputMode};
use process::{NoiseSuppression, ProcessConfig};
use session::{VoiceEvent, VoiceHandle};

/// The one running voice session.
///
/// A user is in at most one call at a time, and a second capture would contend for the same
/// microphone.
static ACTIVE: OnceLock<Mutex<Option<VoiceHandle>>> = OnceLock::new();

fn active() -> &'static Mutex<Option<VoiceHandle>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// How long the gate holds open after the signal drops below the threshold.
///
/// Long enough to ride over the pauses between words, short enough not to hold the channel open
/// after someone has stopped talking.
const GATE_RELEASE_MS: u32 = 200;

/// Settings as the frontend states them.
///
/// Deliberately in the frontend's vocabulary; the mapping to DSP configuration happens here, in one
/// place, rather than being spread across the UI.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    pub device_id: Option<String>,
    /// The speaker to play the mix through. `None` means the system default.
    ///
    /// Optional in the payload so a frontend that has not been updated still deserialises rather
    /// than failing every `voice_start` with a missing-field error.
    #[serde(default)]
    pub output_device_id: Option<String>,
    /// "none" | "standard" | "enhanced"
    pub noise_suppression: String,
    pub echo_cancellation: bool,
    pub auto_gain_control: bool,
    /// "voice" | "ptt"
    pub input_mode: String,
    /// 0.0-1.0, matching the sensitivity slider.
    pub sensitivity: f32,
    pub bitrate_bps: Option<i32>,
}

impl VoiceSettings {
    fn to_chain_config(&self) -> ChainConfig {
        ChainConfig {
            processing: ProcessConfig {
                echo_cancellation: self.echo_cancellation,
                noise_suppression: match self.noise_suppression.as_str() {
                    "none" => NoiseSuppression::Off,
                    "enhanced" => NoiseSuppression::Enhanced,
                    // Anything unrecognised lands on the setting most users want. A typo here
                    // should not silently disable noise suppression.
                    _ => NoiseSuppression::Standard,
                },
                auto_gain: self.auto_gain_control,
            },
            gate: GateConfig {
                mode: if self.input_mode == "ptt" {
                    InputMode::PushToTalk
                } else {
                    InputMode::VoiceActivity
                },
                sensitivity: self.sensitivity.clamp(0.0, 1.0),
                release_ms: GATE_RELEASE_MS,
            },
            // 64 kbps mono Opus is transparent for speech; more buys nothing audible.
            bitrate_bps: self.bitrate_bps.unwrap_or(64_000),
        }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartResult {
    pub cf_session_id: String,
    pub track_name: String,
}

/// Start capturing and publishing the microphone.
///
/// `api_base` and `token` come from the webview for the same reason the screen publisher takes
/// them: the webview owns session lifetime and token refresh, and duplicating that here would mean
/// two things to keep correct.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn voice_start(
    settings: VoiceSettings,
    ice_servers: Vec<IceServerConfig>,
    api_base: String,
    token: String,
    // Guild voice supplies guild_id + channel_id; a DM call supplies call_id instead.
    guild_id: Option<String>,
    channel_id: Option<String>,
    call_id: Option<String>,
    on_event: tauri::ipc::Channel<VoiceEvent>,
) -> Result<VoiceStartResult, String> {
    voice_stop();

    let target = match (guild_id, channel_id, call_id) {
        (Some(guild_id), Some(channel_id), _) => VoiceTarget::GuildChannel {
            guild_id,
            channel_id,
        },
        (_, _, Some(call_id)) => VoiceTarget::Call { call_id },
        _ => return Err("voice needs either guildId+channelId or callId".into()),
    };

    // Primary: this is the session the backend records as the participant's audio.
    let signalling = Signalling::new(api_base, token, target, SessionRole::Primary)?;
    let handle = session::start(
        settings.device_id.clone(),
        settings.output_device_id.clone(),
        ice_servers,
        signalling,
        settings.to_chain_config(),
        on_event,
    )
    .await?;

    let result = VoiceStartResult {
        cf_session_id: handle.cf_session_id.clone(),
        track_name: handle.track_name.clone(),
    };

    if let Ok(mut guard) = active().lock() {
        *guard = Some(handle);
    }
    Ok(result)
}

#[tauri::command]
pub fn voice_stop() {
    if let Ok(mut guard) = active().lock() {
        if let Some(handle) = guard.take() {
            handle.stop();
        }
    }
}

#[tauri::command]
pub fn voice_set_mute(muted: bool) {
    with_active(|h| h.set_muted(muted));
}

#[tauri::command]
pub fn voice_set_ptt_open(open: bool) {
    with_active(|h| h.set_ptt_down(open));
}

#[tauri::command]
pub fn voice_set_processing(settings: VoiceSettings) {
    let config = settings.to_chain_config();
    with_active(|h| h.set_config(config));
}

fn with_active(f: impl FnOnce(&VoiceHandle)) {
    if let Ok(guard) = active().lock() {
        if let Some(handle) = guard.as_ref() {
            f(handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_ten_milliseconds_at_the_pipeline_rate() {
        assert_eq!(FRAME as u32 * 1_000 / SAMPLE_RATE, FRAME_MS);
    }

    fn settings() -> VoiceSettings {
        VoiceSettings {
            device_id: None,
            output_device_id: None,
            noise_suppression: "standard".into(),
            echo_cancellation: true,
            auto_gain_control: true,
            input_mode: "voice".into(),
            sensitivity: 0.5,
            bitrate_bps: None,
        }
    }

    #[test]
    fn noise_suppression_names_map_to_the_three_modes() {
        for (name, expected) in [
            ("none", NoiseSuppression::Off),
            ("standard", NoiseSuppression::Standard),
            ("enhanced", NoiseSuppression::Enhanced),
        ] {
            let mut s = settings();
            s.noise_suppression = name.into();
            assert_eq!(
                s.to_chain_config().processing.noise_suppression,
                expected,
                "mapping {name}"
            );
        }
    }

    #[test]
    fn an_unrecognised_noise_suppression_name_falls_back_to_standard() {
        let mut s = settings();
        s.noise_suppression = "wibble".into();
        assert_eq!(
            s.to_chain_config().processing.noise_suppression,
            NoiseSuppression::Standard
        );
    }

    #[test]
    fn push_to_talk_is_selected_by_name() {
        let mut s = settings();
        s.input_mode = "ptt".into();
        assert_eq!(s.to_chain_config().gate.mode, InputMode::PushToTalk);
        s.input_mode = "voice".into();
        assert_eq!(s.to_chain_config().gate.mode, InputMode::VoiceActivity);
    }

    #[test]
    fn sensitivity_outside_the_slider_range_is_clamped() {
        let mut s = settings();
        s.sensitivity = 4.2;
        assert_eq!(s.to_chain_config().gate.sensitivity, 1.0);
        s.sensitivity = -1.0;
        assert_eq!(s.to_chain_config().gate.sensitivity, 0.0);
    }

    #[test]
    fn echo_cancellation_and_gain_control_reach_the_processor() {
        let mut s = settings();
        s.echo_cancellation = false;
        s.auto_gain_control = false;
        let c = s.to_chain_config();
        assert!(!c.processing.echo_cancellation);
        assert!(!c.processing.auto_gain);
    }

    #[test]
    fn the_default_bitrate_is_transparent_for_speech() {
        assert_eq!(settings().to_chain_config().bitrate_bps, 64_000);
    }

    #[test]
    fn an_explicit_bitrate_overrides_the_default() {
        let mut s = settings();
        s.bitrate_bps = Some(24_000);
        assert_eq!(s.to_chain_config().bitrate_bps, 24_000);
    }

    #[test]
    fn settings_deserialise_from_the_camel_case_the_frontend_sends() {
        // The frontend builds this object by hand, so a renamed field here is a setting that
        // silently stops working rather than an error anyone sees.
        let json = serde_json::json!({
            "deviceId": "Microphone (USB)",
            "noiseSuppression": "enhanced",
            "echoCancellation": false,
            "autoGainControl": true,
            "inputMode": "ptt",
            "sensitivity": 0.75,
            "bitrateBps": null,
        });
        let parsed: VoiceSettings = serde_json::from_value(json).unwrap();

        assert_eq!(parsed.device_id.as_deref(), Some("Microphone (USB)"));
        let config = parsed.to_chain_config();
        assert_eq!(
            config.processing.noise_suppression,
            NoiseSuppression::Enhanced
        );
        assert!(!config.processing.echo_cancellation);
        assert_eq!(config.gate.mode, InputMode::PushToTalk);
        assert_eq!(config.gate.sensitivity, 0.75);
    }
}
