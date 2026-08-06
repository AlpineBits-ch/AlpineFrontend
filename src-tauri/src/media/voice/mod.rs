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
/// The gate that proves this pipeline still carries sound. See the module for why it exists.
#[cfg(test)]
mod e2e_tests;
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

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};

use crate::media::publisher::rtc::IceServerConfig;
use crate::media::publisher::signalling::{SessionRole, Signalling, VoiceTarget};
use chain::ChainConfig;
use gate::{GateConfig, InputMode};
use process::{NoiseSuppression, ProcessConfig};
use mixer::{Position, SpatialModel};
use rtc::VoicePublication;
use session::{Control, Engine, VoiceEvent};

/// The client's one audio engine: one microphone, one set of speakers, one mixer.
///
/// Absent until the first call starts and dropped when the last one ends, so nothing holds the
/// devices open while the user is not in a call.
static ENGINE: OnceLock<Mutex<Option<Engine>>> = OnceLock::new();

fn engine() -> &'static Mutex<Option<Engine>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

/// The guild-channel or DM-call publication.
///
/// Those two share a slot because they are mutually exclusive - you cannot be in a voice channel and
/// a DM call at once - so starting either ends the other, exactly as before.
const PRIMARY_SLOT: &str = "primary";

/// Isle proximity voice, which runs *alongside* the primary call rather than replacing it. That is
/// the whole reason slots exist.
const ISLE_SLOT: &str = "isle";

fn slot_for(target: &VoiceTarget) -> &'static str {
    match target {
        VoiceTarget::Isle => ISLE_SLOT,
        _ => PRIMARY_SLOT,
    }
}

/// How often a running call reports every counter in the pipeline to the log.
///
/// Five seconds is short enough to see a call start working (or not) while someone is on the phone
/// about it, and long enough that a two-hour call does not fill a log file.
const STATS_LOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Whether [`spawn_stats_logger`] already has a task running.
static STATS_LOGGER_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Report the whole pipeline to the log, once per [`STATS_LOG_INTERVAL`], while a call is up.
///
/// Every counter this prints already existed and was already exposed by [`voice_stats`] - and was
/// readable only by a developer with the devtools console open, driving a Tauri command by hand. In
/// a shipped build nobody could reach it, which is how "the call connects and nobody can hear
/// anyone" stayed unattributable: the connection reports healthy at every layer that logs, and the
/// layers that know better are silent.
///
/// The most recent case was a client capturing from a headset's loopback line instead of its
/// microphone. It connected, negotiated, sent RTP on schedule and transported pure silence, and
/// nothing in any log distinguished it from a working call. `rms` below is the number that does:
/// a live microphone is never exactly zero, so a capture RMS pinned at 0.0000 with frames climbing
/// means the device is open and mute - the wrong device, a muted input, or a driver problem - and
/// not a fault anywhere else in the pipeline.
///
/// Deltas rather than totals, because the totals only ever say a stage once ran, while the deltas
/// say whether it is running now. Absolute values are kept for the two gauges (`rms`) where the
/// level is the point.
fn spawn_stats_logger() {
    use std::sync::atomic::Ordering as AtomicOrdering;

    // One reporter for the client, however many calls are running - it reports on all of them.
    if STATS_LOGGER_RUNNING.swap(true, AtomicOrdering::SeqCst) {
        return;
    }

    tokio::spawn(async move {
        let mut previous: Option<VoiceStats> = None;
        loop {
            tokio::time::sleep(STATS_LOG_INTERVAL).await;
            let now = voice_stats();

            // The engine is gone, so the call ended. Release the flag so the next call starts a
            // fresh reporter rather than running without one for the rest of the session.
            if !now.running {
                STATS_LOGGER_RUNNING.store(false, AtomicOrdering::SeqCst);
                return;
            }

            let since = |current: u64, field: fn(&VoiceStats) -> u64| {
                current.saturating_sub(previous.as_ref().map_or(0, field))
            };

            eprintln!(
                "[voice] capture: rms {:.4} frames +{} encoded +{} gate {} muted {} deafened {}",
                now.capture_rms,
                since(now.frames_captured, |s| s.frames_captured),
                since(now.packets_encoded, |s| s.packets_encoded),
                if now.gate_open { "open" } else { "closed" },
                now.muted,
                now.deafened,
            );

            for publication in &now.publications {
                // Matched by slot rather than by position: publications come and go, and a
                // positional comparison would silently attribute one call's deltas to another.
                let was = previous.as_ref().and_then(|p| {
                    p.publications
                        .iter()
                        .find(|other| other.slot == publication.slot)
                });
                let delta = |current: u64, field: fn(&PublicationReport) -> u64| {
                    current.saturating_sub(was.map_or(0, field))
                };

                eprintln!(
                    "[voice] {}: {}/{} sent +{} dropped +{} errors +{} | tracks {} rtp +{} routed +{} unmapped +{} | subscribed {:?}",
                    publication.slot,
                    publication.peer_state,
                    publication.ice_state,
                    delta(publication.packets_sent, |p| p.packets_sent),
                    delta(publication.packets_dropped, |p| p.packets_dropped),
                    delta(publication.write_errors, |p| p.write_errors),
                    publication.tracks_opened,
                    delta(publication.rtp_received, |p| p.rtp_received),
                    delta(publication.rtp_routed, |p| p.rtp_routed),
                    delta(publication.rtp_unmapped, |p| p.rtp_unmapped),
                    publication.subscribed,
                );
            }

            previous = Some(now);
        }
    });
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
    /// Microphone slider, 0.0-1.0. How loud everyone else hears you.
    ///
    /// Defaulted, like `output_device_id`, so a frontend that predates it still deserialises - and
    /// it defaults to unity rather than `f32::default()`, which is silence.
    #[serde(default = "unity")]
    pub input_volume: f32,
    /// Output slider, 0.0-1.0. How loud you hear everyone else.
    #[serde(default = "unity")]
    pub output_volume: f32,
    pub bitrate_bps: Option<i32>,
}

fn unity() -> f32 {
    1.0
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
            input_gain: clamp_volume(self.input_volume),
        }
    }

    fn master_gain(&self) -> f32 {
        clamp_volume(self.output_volume)
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartResult {
    pub cf_session_id: String,
    pub track_name: String,
    /// Which publication this call became, to be handed back to every later command.
    ///
    /// Returned rather than derived on both sides: the frontend knows its own target and could work
    /// the slot out itself, but then the mapping would exist in two places and a divergence would
    /// present as commands silently addressing the wrong call.
    pub slot: String,
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
    // The same `X-Device-Id` the webview sends - the *installation*, not the microphone
    // (`settings.device_id` below is the capture device). This session is the primary one, so a
    // mismatch here puts the participant's audio in a different device bucket than the rest of
    // the client and reads as a takeover of their own call.
    device_id: String,
    // Guild voice supplies guild_id + channel_id; a DM call supplies call_id instead.
    guild_id: Option<String>,
    channel_id: Option<String>,
    call_id: Option<String>,
    // Isle proximity voice. Optional rather than a bare `bool` because Tauri deserialises each
    // argument on its own, so an absent one is an error unless the type admits it - and the guild
    // and call callers do not send this.
    isle: Option<bool>,
    on_event: tauri::ipc::Channel<VoiceEvent>,
) -> Result<VoiceStartResult, String> {
    let target = match (guild_id, channel_id, call_id) {
        (Some(guild_id), Some(channel_id), _) => VoiceTarget::GuildChannel {
            guild_id,
            channel_id,
        },
        (_, _, Some(call_id)) => VoiceTarget::Call { call_id },
        // Isle addresses no channel or call - a player has one proximity session - so it is the
        // one target identified by the absence of ids rather than the presence of them.
        _ if isle.unwrap_or(false) => VoiceTarget::Isle,
        _ => return Err("voice needs guildId+channelId, callId, or isle".into()),
    };
    let slot = slot_for(&target).to_owned();

    // The first thing this command does, so that a join which fails before the devices open is
    // still visible. Everything below logs on its own; the stretch above `Engine::start` did not,
    // so a `voice_start` that returned `Err` early was indistinguishable in the log from a join
    // that never happened - the console simply stopped after the openh264 line and the user was
    // dropped back out of the channel with no explanation on either side.
    eprintln!("[voice] joining {target:?} as slot {slot}");

    // Primary: this is the session the backend records as the participant's audio.
    let signalling = Signalling::new(api_base, token, device_id, target, SessionRole::Primary)
        .inspect_err(|e| eprintln!("[voice] could not start signalling: {e}"))?;

    // Start the engine if this is the first call. `started_here` is kept so a connect that fails
    // below can close the devices again rather than leaving the microphone open for a call that
    // never happened.
    let started_here = {
        let mut guard = engine().lock().map_err(|_| "voice state poisoned")?;
        let fresh = guard.is_none();
        if fresh {
            *guard = Some(Engine::start(
                settings.device_id.clone(),
                settings.output_device_id.clone(),
                settings.to_chain_config(),
            )?);
        }
        if let Some(engine) = guard.as_ref() {
            // The chain config carries the input gain into `Engine::start`; the output slider has no
            // such route, so it is applied here. Without this the mixer would sit at unity until the
            // user next touched the slider, and a saved output volume would be ignored on join.
            engine.control().set_master(settings.master_gain());
        }
        fresh
    };

    // Connected outside the lock: this is a full offer/answer round trip, and holding the engine
    // mutex across it would block mute, push-to-talk and every other command for its duration.
    let inner = match VoicePublication::start(signalling, ice_servers).await {
        Ok(inner) => Arc::new(inner),
        Err(e) => {
            eprintln!("[voice] could not connect the publication: {e}");
            if started_here {
                stop_engine_if_idle();
            }
            return Err(e);
        }
    };

    let mut guard = engine().lock().map_err(|_| "voice state poisoned")?;
    let Some(active) = guard.as_mut() else {
        return Err("the voice engine stopped while this call was connecting".into());
    };
    let publication = active.attach(slot.clone(), inner, on_event);

    // After the publication is attached, so the first report already has a call to describe.
    spawn_stats_logger();

    Ok(VoiceStartResult {
        cf_session_id: publication.cf_session_id.clone(),
        track_name: publication.track_name.clone(),
        slot,
    })
}

/// End one call, or - with no slot - every call at once.
///
/// The slotless form is what a page reload uses: the webview that started the calls is gone, so
/// there is nobody left to name them individually.
#[tauri::command]
pub fn voice_stop(slot: Option<String>) {
    if let Ok(mut guard) = engine().lock() {
        if let Some(active) = guard.as_mut() {
            match slot {
                Some(slot) => active.unpublish(&slot),
                None => active.stop(),
            }
        }
    }
    stop_engine_if_idle();
}

/// Close the devices once nothing is using them.
///
/// Separate from `voice_stop` because a failed join has to do the same thing, and because the check
/// has to happen after the engine lock is released and retaken - `unpublish` is what empties it.
fn stop_engine_if_idle() {
    if let Ok(mut guard) = engine().lock() {
        let idle = guard.as_ref().is_some_and(|active| active.is_empty());
        if idle {
            if let Some(mut active) = guard.take() {
                active.stop();
            }
        }
    }
}

/// Mute the microphone itself, for every call at once.
///
/// Engine-wide on purpose, unlike push-to-talk: muting is a statement about the microphone, and a
/// mute that left you audible in another call would be the worst possible way to learn about slots.
#[tauri::command]
pub fn voice_set_mute(muted: bool) {
    with_control(|control| control.set_muted(muted));
}

/// Open or close the microphone *for one call*.
///
/// Per publication, so proximity push-to-talk does not also key the guild channel. The microphone
/// is captured once and stays live while any call wants it; this decides who the audio reaches.
#[tauri::command]
pub fn voice_set_ptt_open(slot: String, open: bool) {
    with_engine(|active| {
        if let Some(publication) = active.publication(&slot) {
            publication.set_open(open);
            active.refresh_gate();
        }
    });
}

#[tauri::command]
pub fn voice_set_processing(settings: VoiceSettings) {
    let config = settings.to_chain_config();
    let master = settings.master_gain();
    with_engine(|active| {
        active.set_config(config);
        // The output slider goes to the mixer, not the capture chain - it is the one setting here
        // that changes what you hear rather than what you send.
        active.control().set_master(master);
    });
}

/// Subscribe to one participant's audio and start mixing them in.
///
/// `id` is the key everything else uses - volume, levels, unsubscribe. For voice it is the user id;
/// for a stream's audio it is `screen-audio-{shareId}`, so that muting someone's stream does not
/// also mute their voice. Ids are unique across calls, which is what lets one mixer serve them all.
#[tauri::command]
pub async fn voice_subscribe(
    slot: String,
    id: String,
    cf_session_id: String,
    track_name: String,
) -> Result<(), String> {
    // Cloned out of the lock rather than held across the await, for the same reason `voice_start`
    // connects outside it.
    let publication = {
        let guard = engine().lock().map_err(|_| "voice state poisoned")?;
        match guard.as_ref().and_then(|active| active.publication(&slot)) {
            Some(publication) => publication,
            None => return Err(format!("no voice session is running for {slot}")),
        }
    };
    publication.subscribe(id, cf_session_id, track_name).await
}

/// One publication's transport counters, for [`voice_stats`].
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublicationReport {
    pub slot: String,
    pub cf_session_id: String,
    pub track_name: String,
    /// Whether captured audio is currently routed to this call.
    pub open: bool,
    pub peer_state: String,
    pub ice_state: String,
    pub packets_sent: u64,
    pub packets_dropped: u64,
    pub write_errors: u64,
    pub tracks_opened: u64,
    pub rtp_received: u64,
    pub rtp_routed: u64,
    pub rtp_unmapped: u64,
    pub subscribed: Vec<String>,
    /// `mid -> source id`, the routing table inbound RTP is matched against.
    pub mid_routes: Vec<(String, String)>,
    /// The `candidate:` lines this side offered.
    pub local_candidates: Vec<String>,
}

/// One remote participant as the mixer currently sees them.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
    pub id: String,
    pub level: f32,
    pub buffered_packets: usize,
}

/// A snapshot of every boundary in the voice pipeline.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStats {
    pub running: bool,
    // Capture half.
    pub frames_captured: u64,
    pub capture_rms: f32,
    pub packets_encoded: u64,
    pub muted: bool,
    /// Whether any publication currently wants the microphone - the engine-wide gate.
    pub gate_open: bool,
    // Playout half.
    pub playout_frames: u64,
    pub mix_rms: f32,
    pub deafened: bool,
    pub master_volume: f32,
    pub sources: Vec<SourceReport>,
    pub publications: Vec<PublicationReport>,
}

/// Read every counter in the pipeline at once.
///
/// Exists because "the call connects and nobody can hear anything" had no observable cause: each
/// stage reported success to the one above it, and the failure was always in the gaps between them.
/// Read two snapshots a second apart - it is the deltas that matter, not the totals. `running:
/// false` means no engine at all, which is a different problem from every counter sitting at zero.
#[tauri::command]
pub fn voice_stats() -> VoiceStats {
    let guard = match engine().lock() {
        Ok(guard) => guard,
        // A poisoned lock means an audio thread panicked. Reported rather than hidden behind a
        // default snapshot, because it is itself the answer.
        Err(_) => {
            return VoiceStats {
                running: false,
                frames_captured: 0,
                capture_rms: 0.0,
                packets_encoded: 0,
                muted: false,
                gate_open: false,
                playout_frames: 0,
                mix_rms: 0.0,
                deafened: false,
                master_volume: 0.0,
                sources: Vec::new(),
                publications: Vec::new(),
            }
        }
    };
    let Some(active) = guard.as_ref() else {
        return VoiceStats {
            running: false,
            frames_captured: 0,
            capture_rms: 0.0,
            packets_encoded: 0,
            muted: false,
            gate_open: false,
            playout_frames: 0,
            mix_rms: 0.0,
            deafened: false,
            master_volume: 0.0,
            sources: Vec::new(),
            publications: Vec::new(),
        };
    };

    let stats = active.stats();
    let control = active.control();
    let publications = active
        .publications()
        .into_iter()
        .map(|(slot, publication)| {
            let counters = publication.stats();
            PublicationReport {
                slot,
                cf_session_id: publication.cf_session_id.clone(),
                track_name: publication.track_name.clone(),
                open: publication.open(),
                peer_state: counters
                    .peer_state
                    .lock()
                    .map(|s| s.clone())
                    .unwrap_or_else(|_| "poisoned".into()),
                ice_state: counters
                    .ice_state
                    .lock()
                    .map(|s| s.clone())
                    .unwrap_or_else(|_| "poisoned".into()),
                packets_sent: counters.packets_sent.load(Ordering::Relaxed),
                packets_dropped: counters.packets_dropped.load(Ordering::Relaxed),
                write_errors: counters.write_errors.load(Ordering::Relaxed),
                tracks_opened: counters.tracks_opened.load(Ordering::Relaxed),
                rtp_received: counters.rtp_received.load(Ordering::Relaxed),
                rtp_routed: counters.rtp_routed.load(Ordering::Relaxed),
                rtp_unmapped: counters.rtp_unmapped.load(Ordering::Relaxed),
                subscribed: publication.subscribed_ids(),
                mid_routes: publication.mid_routes(),
                local_candidates: counters
                    .local_candidates
                    .lock()
                    .map(|c| c.clone())
                    .unwrap_or_default(),
            }
        })
        .collect();

    VoiceStats {
        running: true,
        frames_captured: stats.frames_captured.load(Ordering::Relaxed),
        capture_rms: stats.capture_rms(),
        packets_encoded: stats.packets_encoded.load(Ordering::Relaxed),
        muted: control.muted(),
        gate_open: control.ptt_down(),
        playout_frames: stats.playout_frames.load(Ordering::Relaxed),
        mix_rms: stats.mix_rms(),
        deafened: control.deafened(),
        master_volume: control.master(),
        sources: active
            .source_report()
            .into_iter()
            .map(|(id, level, buffered_packets)| SourceReport {
                id,
                level,
                buffered_packets,
            })
            .collect(),
        publications,
    }
}

#[tauri::command]
pub fn voice_unsubscribe(slot: String, id: String) {
    with_engine(|active| {
        if let Some(publication) = active.publication(&slot) {
            publication.unsubscribe(&id);
        }
    });
}

#[tauri::command]
pub fn voice_set_user_volume(id: String, volume: f32) {
    let gain = clamp_volume(volume);
    with_control(|control| control.set_gain(id.clone(), gain));
}

#[tauri::command]
pub fn voice_set_deafened(deafened: bool) {
    with_control(|control| control.set_deafened(deafened));
}

/// How placed sources fall off with distance, and how hard they are panned.
///
/// `max_distance` comes from the server rather than being assumed here: it has to match the radius
/// the backend uses to decide who is even subscribed, or players fade to nothing before they stop
/// being sent, or - worse - stay audible right up to the moment they vanish.
///
/// The other three are the tuning the WebAudio graph used before mixing moved here, passed through
/// unchanged so proximity voice sounds the same rather than merely working.
#[tauri::command]
pub fn voice_set_spatial_model(
    ref_distance: f32,
    rolloff: f32,
    max_distance: f32,
    intensity: f32,
) -> Result<(), String> {
    let model = SpatialModel {
        ref_distance,
        rolloff,
        max_distance,
        intensity,
    };
    let mut result = Err("no voice session is running".to_owned());
    with_control(|control| result = control.set_spatial_model(model));
    result
}

/// Place a participant relative to the listener, or un-place them by passing no coordinates.
///
/// Listener-relative, not world coordinates: the caller has already applied the listener's own
/// position and facing. `+x` is their right, `+y` up, `+z` forward.
///
/// This is also the only spatial switch there is. Turning proximity audio off means un-placing
/// every peer, not clearing a mode flag - one mixer serves the guild call and Isle at the same time,
/// so a flag would have had to be right for both at once.
#[tauri::command]
pub fn voice_set_position(id: String, x: Option<f32>, y: Option<f32>, z: Option<f32>) {
    let position = match (x, y, z) {
        (Some(x), Some(y), Some(z)) if x.is_finite() && y.is_finite() && z.is_finite() => {
            Some(Position { x, y, z })
        }
        // Either genuinely un-placed, or a garbled update. Both mean "do not pretend to know where
        // this person is" - a NaN would otherwise reach the HRTF sampler.
        _ => None,
    };
    with_control(|control| control.set_position(id.clone(), position));
}

/// A NaN volume reads as "unset" rather than "silent".
///
/// A slider that has never been touched, or a value lost in transit, must not mute someone - that
/// failure is indistinguishable from the other side having gone quiet.
///
/// Used for the per-user volume and for both settings sliders, since all three arrive over IPC as
/// whatever the webview chose to send.
fn clamp_volume(volume: f32) -> f32 {
    if volume.is_nan() {
        return 1.0;
    }
    volume.clamp(0.0, 1.0)
}

/// The source id a stream's audio is mixed under.
///
/// Distinct from the publisher's user id on purpose: voice and stream audio need independent
/// volume, and keying both on the user would make muting one mute the other.
#[allow(dead_code)]
fn screen_audio_id(share_id: &str) -> String {
    format!("screen-audio-{share_id}")
}

fn with_engine(f: impl FnOnce(&mut Engine)) {
    if let Ok(mut guard) = engine().lock() {
        if let Some(active) = guard.as_mut() {
            f(active);
        }
    }
}

/// For the settings that belong to the microphone, the speakers or the mixer rather than to any one
/// call - they need no slot, because there is only ever one of each.
fn with_control(f: impl FnOnce(&Control)) {
    with_engine(|active| f(active.control()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_ten_milliseconds_at_the_pipeline_rate() {
        assert_eq!(FRAME as u32 * 1_000 / SAMPLE_RATE, FRAME_MS);
    }

    #[test]
    fn a_volume_outside_the_slider_range_is_clamped() {
        assert_eq!(clamp_volume(1.7), 1.0);
        assert_eq!(clamp_volume(-0.2), 0.0);
        assert_eq!(clamp_volume(0.5), 0.5);
    }

    #[test]
    fn a_missing_volume_reads_as_full_rather_than_silent() {
        // Muting on a bad value would be indistinguishable from the other side going quiet.
        assert_eq!(clamp_volume(f32::NAN), 1.0);
    }

    #[test]
    fn screen_audio_gets_its_own_source_id() {
        // Voice and stream audio must be separately mutable; keying both on the user id would make
        // muting someone's stream also mute their voice.
        assert_eq!(screen_audio_id("share-1"), "screen-audio-share-1");
        assert_ne!(screen_audio_id("user-1"), "user-1");
    }

    #[test]
    fn settings_without_an_output_device_still_deserialise() {
        // The field was added after the frontend shipped; a missing key must default rather than
        // failing every voice_start with a deserialisation error.
        let parsed: VoiceSettings = serde_json::from_str(
            r#"{"deviceId":null,"noiseSuppression":"standard","echoCancellation":true,
                "autoGainControl":true,"inputMode":"voice","sensitivity":0.5,"bitrateBps":null}"#,
        )
        .unwrap();
        assert!(parsed.output_device_id.is_none());
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
            input_volume: 1.0,
            output_volume: 1.0,
            bitrate_bps: None,
        }
    }

    #[test]
    fn the_volume_sliders_default_to_unity_when_absent() {
        // Same reasoning as outputDeviceId above, with a sharper failure: `f32::default()` is 0.0,
        // so a frontend that predates these fields would deserialise into a muted microphone and a
        // silent mixer rather than a missing setting.
        let parsed: VoiceSettings = serde_json::from_str(
            r#"{"deviceId":null,"noiseSuppression":"standard","echoCancellation":true,
                "autoGainControl":true,"inputMode":"voice","sensitivity":0.5,"bitrateBps":null}"#,
        )
        .unwrap();
        assert_eq!(parsed.input_volume, 1.0);
        assert_eq!(parsed.output_volume, 1.0);
    }

    #[test]
    fn the_input_slider_becomes_the_chain_gain() {
        let mut s = settings();
        s.input_volume = 0.4;
        assert_eq!(s.to_chain_config().input_gain, 0.4);
    }

    #[test]
    fn the_output_slider_becomes_the_master_gain() {
        let mut s = settings();
        s.output_volume = 0.3;
        assert_eq!(s.master_gain(), 0.3);
    }

    #[test]
    fn the_two_sliders_do_not_cross_over() {
        // They are separate paths - one scales what is sent, the other what is heard - and reading
        // the wrong field would be invisible until someone set them differently.
        let mut s = settings();
        s.input_volume = 0.2;
        s.output_volume = 0.8;
        assert_eq!(s.to_chain_config().input_gain, 0.2);
        assert_eq!(s.master_gain(), 0.8);
    }

    #[test]
    fn a_broken_slider_value_does_not_mute_anyone() {
        let mut s = settings();
        s.input_volume = f32::NAN;
        s.output_volume = f32::NAN;
        assert_eq!(s.to_chain_config().input_gain, 1.0);
        assert_eq!(s.master_gain(), 1.0);
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
