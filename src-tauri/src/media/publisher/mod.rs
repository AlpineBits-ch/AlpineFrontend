//! Rust-native screen-share publishing.
//!
//! The existing capture path encodes each frame to JPEG, base64s it across the Tauri IPC boundary,
//! decodes it in JS, draws it to a canvas and lets the browser re-encode the canvas for WebRTC.
//! That is two lossy encodes and a full round trip per frame. This module is the replacement:
//! captured frames go straight into a real video encoder in Rust.
//!
//! Discord does the equivalent natively - OS capture into a hardware encoder, with frames never
//! leaving the process - which is why their streams stay sharp on text.

//! The publish rides on the **shared** LiveKit room - the same connection, and therefore the same
//! participant, the microphone is on. It used to open a session of its own with `primary=false`,
//! because Cloudflare keyed participants by session and a second one was the only way to publish
//! twice; LiveKit puts many tracks on one participant, so the second identity is gone and with it
//! the case `VoiceShareSnapshot.mediaSessionId` exists to disambiguate. See the migration spec
//! §2.1 and [`crate::media::livekit::registry`].

// A handful of accessors exist for diagnostics and for the paths not yet exercised (geometry
// readback, encoder naming). Suppressed module-wide rather than annotated item by item.
#![allow(dead_code)]

pub mod audio;
pub mod encoder;
pub mod fit;
pub mod encoder_sw;
#[cfg(target_os = "windows")]
pub mod encoder_mf;
pub mod nv12;
pub mod openh264_blob;
pub mod pump;
pub mod rtc;
pub mod session;
pub mod simulcast;
pub mod signalling;

/// Frames in one end, RTP out the other, against a real LiveKit server.
///
/// Screen sharing has broken twice with the whole suite green - a keyframe interval counted in
/// frames on a screen that produces almost none, and one full UDP send queue ending a publication
/// outright. Neither is visible to a unit test, and neither is visible from the sharing side at
/// all: the share reports "running" everywhere except on the wire, and the sharer's own preview is
/// drawn from the capture source and looks perfect either way.
#[cfg(test)]
mod e2e_tests;

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tauri::Manager;

use crate::media::livekit;
use session::PublishHandle;
use signalling::VoiceTarget;

/// The one running publish, if any. Screen sharing is single-session by design: the UI offers no
/// way to share two sources at once, and a second capture would contend for the same encoder.
static ACTIVE: OnceLock<Mutex<Option<PublishHandle>>> = OnceLock::new();

fn active() -> &'static Mutex<Option<PublishHandle>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// Everything other clients need in order to subscribe to the new track.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    /// **Always empty on desktop now**, and kept only because the webview still reads the key.
    ///
    /// A media session was Cloudflare's answer to "which of this participant's connections is the
    /// track on". The share is on the participant's one connection, so there is no second session
    /// to name - migration spec §2.1. Empty rather than removed so that a webview built against the
    /// old shape fails to *find* anything rather than failing to parse; it goes when the webview
    /// stops asking for it.
    pub media_session_id: String,
    pub track_name: String,
    /// The share's audio track, or `None` when it has none.
    ///
    /// Answers what was *published*, not what was asked for: a machine with no usable loopback
    /// device shares video only, and the caller has to announce the tracks that actually exist.
    pub audio_track_name: Option<String>,
    /// Which encoder was selected, so the UI can show whether hardware encoding is in use.
    pub encoder: String,
}

/// Capture, encode and publish a screen source straight from Rust.
///
/// The connection is passed in rather than fetched here. Under §2.2 of the migration the webview
/// owns every control-plane call, because it has the interceptor chain that refreshes an expired
/// bearer and replays - a token string this process captured at publish time cannot. So this takes
/// `{url, token}` and makes no HTTP request at all.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_screen_publish(
    source_id: String,
    share_id: String,
    width: u32,
    height: u32,
    fps: u32,
    kbps: u32,
    // What is being shared. Decides what the encoder gives up under pressure, not how much it
    // spends - see `EncoderContent`.
    content: encoder::EncoderContent,
    // Where the room lives, and what lets us in. Consulted only when this is the first holder of
    // the room - see `livekit::registry::acquire`. There is no ICE server list any more: the node
    // states what it is reachable on in its `JoinResponse`, and a room lives on exactly one node.
    livekit_url: String,
    livekit_token: String,
    // Guild voice supplies guild_id + channel_id; a DM call supplies call_id instead.
    guild_id: Option<String>,
    channel_id: Option<String>,
    call_id: Option<String>,
    on_preview: tauri::ipc::Channel<session::PreviewFrame>,
    // A copy of the encoded stream, for the sharer's own tile to decode.
    //
    // Always supplied and only sometimes used: `Channel` is not `Deserialize`, so it cannot be an
    // `Option` argument. `local_stream` is the actual request, and it is the webview's answer to
    // "can this host decode H.264 with `VideoDecoder`" - false on a webview that cannot, which then
    // keeps the `on_preview` thumbnail as before.
    on_local_stream: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    local_stream: bool,
    // Whether to capture and publish the system's audio alongside the picture.
    share_audio: bool,
) -> Result<PublishResult, String> {
    // Awaited, not fired off. This is the resolution-change path: the encoder built below and the
    // capture session opened for it must not overlap with the ones being torn down here.
    let _ = tauri::async_runtime::spawn_blocking(stop_active_publish).await;

    let target = match (guild_id, channel_id, call_id) {
        (Some(guild_id), Some(channel_id), _) => VoiceTarget::GuildChannel {
            guild_id,
            channel_id,
        },
        (_, _, Some(call_id)) => VoiceTarget::Call { call_id },
        _ => return Err("publish needs either guildId+channelId or callId".into()),
    };

    // The §2.1 merge. The microphone almost always already holds this room, so `acquire` hands back
    // the live connection and the share is published on the *same participant* rather than opening a
    // second one. That is what stops desktop producing a second identity - and therefore what stops
    // it producing `VoiceShareSnapshot.mediaSessionId` - and it is the whole point of the change.
    //
    // `key_for` answers `None` only for Isle, which never screen shares and has no room model; the
    // match above has already refused everything else.
    let key = livekit::registry::key_for(&target).ok_or("screen share needs a room target")?;
    let room = livekit::registry::acquire(&key, &livekit_url, &livekit_token).await?;

    let handle = match session::start(
        source_id,
        share_id,
        width,
        height,
        fps,
        kbps,
        content,
        room,
        key.clone(),
        on_preview,
        local_stream.then_some(on_local_stream),
        share_audio,
    )
    .await
    {
        Ok(handle) => handle,
        Err(e) => {
            // Acquired above and never handed to a `Publication` that could release it. Leaving the
            // holder behind would keep the room open past the last real user of it, and the next
            // failed publish would add another - a call that can never be left.
            rtc::release_room(&key).await;
            return Err(e);
        }
    };

    let result = PublishResult {
        // See the field: desktop no longer has a media session to name.
        media_session_id: String::new(),
        track_name: handle.track_name.clone(),
        audio_track_name: handle.audio_track_name.clone(),
        encoder: handle.encoder_name.to_string(),
    };

    if let Ok(mut guard) = active().lock() {
        *guard = Some(handle);
    }
    Ok(result)
}

/// Change the capture rate of the running publish. Lands within one frame.
#[tauri::command]
pub fn set_publish_fps(fps: u32) {
    if let Ok(guard) = active().lock() {
        if let Some(handle) = guard.as_ref() {
            handle.set_fps(fps);
        }
    }
}

/// Retype the running publish - resolution, bitrate and content mode - without ending it.
///
/// <p>The encoder is retyped in place at the next frame boundary - see
/// [`session::PublishHandle::set_spec`]. The session, the track and the share id all survive, so
/// this announces nothing and viewers see only a picture that changed size.</p>
///
/// <p>This used to be a stop followed by a start, which cost a new share id and left every viewer's
/// tile out of the grid for as long as the new publish took to negotiate.</p>
///
/// <p>One command rather than one per field, because these are applied as a single spec at a single
/// frame boundary. A mode moving in one call and a geometry in another would leave the share
/// mismatched for however long the second took to arrive.</p>
#[tauri::command]
pub fn set_publish_spec(width: u32, height: u32, kbps: u32, content: encoder::EncoderContent) {
    if let Ok(guard) = active().lock() {
        if let Some(handle) = guard.as_ref() {
            handle.set_spec(width, height, kbps, content);
        }
    }
}

/// Start or stop the copy of the encoded stream that feeds the sharer's own tile.
///
/// Called whenever the webview's answer to "is anyone looking at the local picture" changes - the
/// window going behind another one, or the preview sitting idle. See
/// [`session::PublishHandle::set_local_stream_enabled`] for why this is stopped at the source
/// rather than ignored on arrival, and why turning it back on costs a keyframe.
#[tauri::command]
pub fn set_local_stream_enabled(enabled: bool) {
    if let Ok(guard) = active().lock() {
        if let Some(handle) = guard.as_ref() {
            handle.set_local_stream_enabled(enabled);
        }
    }
}

/// Mute or unmute the running share's own sound, without dropping the capture device.
///
/// A no-op for a share that has no audio half, which is the honest answer - the UI reads
/// `localScreenHasAudio` to decide whether to offer the control at all.
#[tauri::command]
pub fn set_screen_audio_muted(muted: bool) {
    if let Ok(guard) = active().lock() {
        if let Some(handle) = guard.as_ref() {
            handle.set_screen_audio_muted(muted);
        }
    }
}

/// Stop the running publish and wait for its capture thread to exit.
///
/// Blocking, because [`PublishHandle::stop`] is - see the note there on why the wait is
/// load-bearing. Every caller runs it somewhere a pause is affordable.
fn stop_active_publish() {
    // Taken out from under the lock before the wait begins. Holding it across the wait would make
    // a capture thread that is slow to exit block every other command that touches the publish -
    // the framerate and share-audio controls among them.
    let handle = active().lock().ok().and_then(|mut guard| guard.take());
    if let Some(handle) = handle {
        handle.stop();
    }
}

#[tauri::command]
pub async fn stop_screen_publish() {
    // Off the runtime: this waits for an OS thread that is mid-frame, and an async command that
    // blocks its worker stalls every other command sharing it.
    let _ = tauri::async_runtime::spawn_blocking(stop_active_publish).await;
}

/// Reported to the frontend so a failure to provision the codec is diagnosable rather than
/// mysterious. Screen sharing still works without it, at the old pipeline's quality.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Openh264Status {
    pub ready: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

/// Kick off codec provisioning in the background.
///
/// Called once at startup. Deliberately unattended and non-blocking: nothing the user does should
/// wait on it, and if it fails the app degrades to the webview's own encoder rather than breaking.
pub fn spawn_provisioning(app: &tauri::AppHandle) {
    let Ok(data_dir) = app.path().app_local_data_dir() else {
        eprintln!("[openh264] no app data directory; skipping codec provisioning");
        return;
    };

    tauri::async_runtime::spawn(async move {
        match openh264_blob::ensure(data_dir).await {
            Ok(path) => eprintln!("[openh264] ready at {}", path.display()),
            Err(e) => eprintln!("[openh264] unavailable, falling back to the webview encoder: {e}"),
        }
    });
}

#[tauri::command]
pub async fn openh264_status(app: tauri::AppHandle) -> Openh264Status {
    if let Some(path) = openh264_blob::ready_path() {
        return Openh264Status {
            ready: true,
            path: Some(path.to_string_lossy().into_owned()),
            error: None,
        };
    }

    // Not ready yet: retry rather than just reporting failure, so a transient network outage at
    // startup resolves itself the next time anything asks.
    let data_dir: PathBuf = match app.path().app_local_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            return Openh264Status {
                ready: false,
                path: None,
                error: Some(e.to_string()),
            }
        }
    };

    match openh264_blob::ensure(data_dir).await {
        Ok(path) => Openh264Status {
            ready: true,
            path: Some(path.to_string_lossy().into_owned()),
            error: None,
        },
        Err(e) => Openh264Status {
            ready: false,
            path: None,
            error: Some(e),
        },
    }
}

// ── Stats for nerds ────────────────────────────────────────────────────────────────────────

/// One outgoing stream as the transport reports it, before the encoder half is merged in.
///
/// <p>A struct of its own rather than the webrtc-rs type, so the merge below is testable without
/// standing up a peer connection - `merge_layers` never has to construct an `OutboundRTPStats`,
/// which carries a private-ish shape and an `Instant` field that a unit test has no honest value
/// for.</p>
#[derive(Debug, Clone)]
pub struct WireLayer {
    pub rid: Option<String>,
    pub ssrc: Option<u32>,
    pub mid: Option<String>,
    pub bytes_sent: u64,
    pub packets_sent: u64,
    pub nack_count: u64,
    pub pli_count: Option<u64>,
    pub fir_count: Option<u64>,
    pub packets_lost: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishLayerStats {
    pub rid: Option<String>,
    pub ssrc: Option<u32>,
    pub mid: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub target_kbps: u32,
    /// Cumulative. The webview differentiates successive samples into a rate.
    pub bytes_sent: u64,
    pub packets_sent: u64,
    pub packets_lost: Option<i64>,
    pub nack_count: u64,
    pub pli_count: Option<u64>,
    pub fir_count: Option<u64>,
    pub frames_encoded: u64,
    pub keyframes: u64,
    pub frames_dropped: u64,
    pub encoder: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishAudioStats {
    pub packets_encoded: u64,
    pub packets_dropped: u64,
}

/// One ICE candidate pair as the transport reports it, and the two candidates it names.
///
/// <p>Structs of their own rather than the webrtc-rs types, for the same reason as
/// {@link WireLayer}: `pick_transport` below must be testable without standing up a peer
/// connection, and `ICECandidatePairStats` carries four `Instant` fields a unit test has no honest
/// value for.</p>
#[derive(Debug, Clone)]
pub struct WirePair {
    pub local_candidate_id: String,
    pub remote_candidate_id: String,
    pub succeeded: bool,
    pub nominated: bool,
    /// Seconds. Zero means "not measured yet" in webrtc-rs, which reports an `f64` and not an
    /// `Option`, so it is treated as absent rather than as a 0 ms round trip.
    pub current_round_trip_time: f64,
    /// Bits per second. Zero is "not estimated", read the same way and for the same reason.
    pub available_outgoing_bitrate: f64,
}

#[derive(Debug, Clone)]
pub struct WireCandidate {
    pub id: String,
    pub candidate_type: String,
    pub protocol: String,
}

/// The ICE path this publication is taking, as the panel's header block renders it.
///
/// <p>Shaped field for field like the webview's `StreamTransportStats`, because the panel draws
/// both from one template. Before this existed the native payload carried a bare round-trip time
/// and nothing else, so a desktop sharer relayed through TURN saw no Path row while a viewer of
/// that very stream saw one - the two directions disagreeing about what is knowable over a
/// difference that was only ever in the plumbing. Telling a relayed connection from a direct one is
/// one of the four failures this whole readout exists to distinguish.</p>
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishTransportStats {
    pub rtt_ms: Option<u32>,
    pub local_candidate_type: Option<String>,
    pub remote_candidate_type: Option<String>,
    pub protocol: Option<String>,
    pub available_outgoing_kbps: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishStats {
    pub codec: Option<String>,
    pub profile_level_id: Option<String>,
    pub transport: Option<PublishTransportStats>,
    pub layers: Vec<PublishLayerStats>,
    pub audio: Option<PublishAudioStats>,
}

/// The one candidate pair actually carrying media, resolved to the path it describes.
///
/// <p><b>Not any pair.</b> A connection keeps every failed and in-progress pair in its report for
/// its whole life, and the first one in an unordered map is as likely to be a dead host-to-host
/// candidate as the relay actually in use - which would report the exact opposite of the finding.
/// The nominated succeeded pair wins, then any succeeded pair; that is the same rule `transportOf`
/// applies on the webview side, tightened by the nomination check because webrtc-rs exposes it and
/// the browser stats do not.</p>
///
/// <p>With no succeeded pair at all - ICE still gathering, or already gone - the RTCP round trip is
/// still worth reporting on its own, so it survives as a transport block with only that field set.
/// Zeroes are read as "not measured" rather than as measurements, because webrtc-rs types these as
/// plain `f64` with no way to say "absent", and a 0 ms round trip rendered as fact would be a
/// stronger and quite different claim from saying nothing.</p>
pub fn pick_transport(
    pairs: &[WirePair],
    candidates: &std::collections::HashMap<String, WireCandidate>,
    rtcp_rtt_ms: Option<u32>,
) -> Option<PublishTransportStats> {
    let chosen = pairs
        .iter()
        .find(|p| p.succeeded && p.nominated)
        .or_else(|| pairs.iter().find(|p| p.succeeded));

    let Some(pair) = chosen else {
        return rtcp_rtt_ms.map(|rtt| PublishTransportStats {
            rtt_ms: Some(rtt),
            ..PublishTransportStats::default()
        });
    };

    let local = candidates.get(&pair.local_candidate_id);
    let remote = candidates.get(&pair.remote_candidate_id);

    // The pair's own measurement beats the one the receiver reports back over RTCP: it is this
    // connection's, measured on the path in use, rather than an end-to-end figure for a stream.
    let rtt_ms = if pair.current_round_trip_time > 0.0 {
        Some((pair.current_round_trip_time * 1000.0).round() as u32)
    } else {
        rtcp_rtt_ms
    };

    Some(PublishTransportStats {
        rtt_ms,
        local_candidate_type: local.map(|c| c.candidate_type.clone()),
        remote_candidate_type: remote.map(|c| c.candidate_type.clone()),
        protocol: local.map(|c| c.protocol.clone()),
        available_outgoing_kbps: if pair.available_outgoing_bitrate > 0.0 {
            Some((pair.available_outgoing_bitrate / 1000.0).round() as u32)
        } else {
            None
        },
    })
}

/// Pair the ladder against what the wire and the pump each report.
///
/// <p><b>The ladder drives the result, not the wire.</b> A rung the ladder built and the wire never
/// carried still produces a row, showing its target against zero bytes: that combination is exactly
/// what a simulcast ladder failing to publish looks like, and dropping the row would render it as
/// "not configured" instead - the opposite of the finding.</p>
///
/// <p>A wire row with no rid pairs with the only rung, which is the pre-simulcast case: a
/// single-encoding publication has a track with no rid at all (see `Publication::start`).</p>
pub fn merge_layers(
    ladder: &[simulcast::Layer],
    wire: &[WireLayer],
    pump: &[pump::PumpStats],
    encoder: &str,
) -> Vec<PublishLayerStats> {
    ladder
        .iter()
        .enumerate()
        .map(|(index, rung)| {
            let found = wire.iter().find(|w| match (&w.rid, ladder.len()) {
                (Some(rid), _) => rid == rung.rid,
                // No rid on the wire: only meaningful when there is one rung to pair it with.
                (None, 1) => true,
                (None, _) => false,
            });
            let counts = pump.get(index);

            PublishLayerStats {
                rid: Some(rung.rid.to_string()),
                ssrc: found.and_then(|w| w.ssrc),
                mid: found.and_then(|w| w.mid.clone()),
                width: rung.spec.width,
                height: rung.spec.height,
                fps: rung.spec.fps,
                target_kbps: rung.spec.kbps,
                bytes_sent: found.map_or(0, |w| w.bytes_sent),
                packets_sent: found.map_or(0, |w| w.packets_sent),
                packets_lost: found.and_then(|w| w.packets_lost),
                nack_count: found.map_or(0, |w| w.nack_count),
                pli_count: found.and_then(|w| w.pli_count),
                fir_count: found.and_then(|w| w.fir_count),
                frames_encoded: counts.map_or(0, |c| c.encoded_frames),
                keyframes: counts.map_or(0, |c| c.keyframes),
                frames_dropped: counts.map_or(0, |c| c.dropped_frames),
                encoder: encoder.to_string(),
            }
        })
        .collect()
}

/// Live statistics for the running publish, merged from the transport and the encoder.
///
/// <p><b>Two sources, because one is not enough.</b> webrtc-rs deliberately omits every encoder
/// field from `OutboundRTPStats` - geometry, frame rate, frames encoded, keyframes, target bitrate,
/// quantiser, encoder name - on the grounds that it is not the encoder. Its own source comments say
/// so: `frameWidth`, `frameHeight`, `framesPerSecond`, `framesEncoded`, `keyFramesEncoded`, `qpSum`,
/// `targetBitrate`, `qualityLimitationReason` and `encoderImplementation` are all listed as "encoder
/// specific and can't be produced since we aren't encoding". Our frame pump is the encoder, so the
/// transport half of this command comes from `get_stats()` and the encoder half from the pump's
/// counters and the simulcast ladder. Neither source alone can answer "is this rung actually
/// publishing" - the wire can say bytes moved without saying what they were, and the pump can say
/// frames were encoded without saying whether any of them left the machine.</p>
///
/// <p><b>Counters come back cumulative.</b> The webview differentiates successive samples into
/// rates, which keeps this command stateless and pollable at whatever interval the panel wants.</p>
#[tauri::command]
pub async fn publish_stats() -> Option<PublishStats> {
    // Cloned out from under the lock before anything is awaited. Holding it across `get_stats()`
    // would make a stats poll block the framerate and share-audio controls, which is the same
    // discipline `stop_active_publish` follows for a different reason.
    let sources = {
        let guard = active().lock().ok()?;
        let handle = guard.as_ref()?;
        let (pc, counters, ladder, encoder, profile) = handle.stats_sources();
        (pc, counters, ladder, encoder, profile, handle.screen_audio_stats())
    };
    let (pc, counters, ladder, encoder, profile, audio) = sources;

    let report = pc.get_stats().await;

    let mut wire: Vec<WireLayer> = Vec::new();
    let mut lost_by_ssrc: std::collections::HashMap<u32, i64> = std::collections::HashMap::new();
    let mut rtt_ms: Option<u32> = None;
    let mut pairs: Vec<WirePair> = Vec::new();
    let mut candidates: std::collections::HashMap<String, WireCandidate> =
        std::collections::HashMap::new();

    for value in report.reports.values() {
        match value {
            webrtc::stats::StatsReportType::OutboundRTP(s) if s.kind == "video" => {
                wire.push(WireLayer {
                    rid: s.rid.as_ref().map(|r| r.to_string()),
                    ssrc: Some(s.ssrc),
                    mid: Some(s.mid.to_string()),
                    bytes_sent: s.bytes_sent,
                    packets_sent: s.packets_sent,
                    nack_count: s.nack_count,
                    pli_count: s.pli_count,
                    fir_count: s.fir_count,
                    packets_lost: None,
                });
            }
            webrtc::stats::StatsReportType::RemoteInboundRTP(s) => {
                lost_by_ssrc.insert(s.ssrc, s.packets_lost);
                if rtt_ms.is_none() {
                    rtt_ms = s.round_trip_time.map(|t| (t * 1000.0).round() as u32);
                }
            }
            // The ICE half. Both candidate variants are collected into one map keyed by id,
            // because a pair names its two ends by id and does not care which side they came from.
            webrtc::stats::StatsReportType::CandidatePair(s) => {
                pairs.push(WirePair {
                    local_candidate_id: s.local_candidate_id.clone(),
                    remote_candidate_id: s.remote_candidate_id.clone(),
                    succeeded: s.state == webrtc::ice::candidate::CandidatePairState::Succeeded,
                    nominated: s.nominated,
                    current_round_trip_time: s.current_round_trip_time,
                    available_outgoing_bitrate: s.available_outgoing_bitrate,
                });
            }
            webrtc::stats::StatsReportType::LocalCandidate(s)
            | webrtc::stats::StatsReportType::RemoteCandidate(s) => {
                candidates.insert(
                    s.id.clone(),
                    WireCandidate {
                        id: s.id.clone(),
                        candidate_type: s.candidate_type.to_string(),
                        // webrtc-rs has no `protocol` on a candidate; the network type is where udp
                        // and tcp are distinguished, and `network_short` is exactly the "udp"/"tcp"
                        // vocabulary the browser's `protocol` field uses.
                        protocol: s.network_type.network_short(),
                    },
                );
            }
            _ => {}
        }
    }

    for layer in &mut wire {
        if let Some(ssrc) = layer.ssrc {
            layer.packets_lost = lost_by_ssrc.get(&ssrc).copied();
        }
    }

    Some(PublishStats {
        // The codec is fixed for this pipeline: `h264_capability()` is the only one registered.
        codec: Some("video/H264".to_string()),
        profile_level_id: profile,
        transport: pick_transport(&pairs, &candidates, rtt_ms),
        layers: merge_layers(&ladder, &wire, &counters, encoder),
        audio: audio.map(|a| PublishAudioStats {
            packets_encoded: a.packets_encoded,
            packets_dropped: a.packets_dropped,
        }),
    })
}

#[cfg(test)]
mod stats_tests {
    use super::*;
    use crate::media::publisher::encoder::{EncoderContent, EncoderSpec};
    use crate::media::publisher::pump::PumpStats;
    use crate::media::publisher::simulcast::Layer;

    fn ladder() -> Vec<Layer> {
        vec![
            Layer {rid: "a", spec: EncoderSpec {width: 1920, height: 1080, fps: 30, kbps: 2600, content: EncoderContent::Text}},
            Layer {rid: "b", spec: EncoderSpec {width: 960, height: 540, fps: 30, kbps: 900, content: EncoderContent::Text}},
        ]
    }

    fn pump(encoded: u64, keyframes: u64, dropped: u64) -> PumpStats {
        PumpStats {encoded_frames: encoded, keyframes, dropped_frames: dropped}
    }

    #[test]
    fn merges_the_transport_and_encoder_halves_per_rid() {
        let wire = vec![
            WireLayer {rid: Some("a".into()), ssrc: Some(1), mid: Some("0".into()),
                       bytes_sent: 1_000, packets_sent: 10, nack_count: 2,
                       pli_count: Some(1), fir_count: None, packets_lost: Some(3)},
        ];

        let layers = merge_layers(&ladder(), &wire, &[pump(900, 4, 2), pump(880, 4, 1)], "openh264");

        assert_eq!(layers.len(), 2);
        assert_eq!(layers[0].rid.as_deref(), Some("a"));
        assert_eq!(layers[0].width, 1920);
        assert_eq!(layers[0].target_kbps, 2600);
        assert_eq!(layers[0].bytes_sent, 1_000);
        assert_eq!(layers[0].frames_encoded, 900);
        assert_eq!(layers[0].encoder, "openh264");
    }

    /// The simulcast failure signature: a rung the ladder built and the wire never carried. It
    /// must still produce a row, showing its target against zero bytes, rather than vanishing -
    /// a missing row reads as "not configured", which is the opposite of the finding.
    #[test]
    fn a_rung_absent_from_the_wire_still_produces_a_row_with_its_target() {
        let wire = vec![
            WireLayer {rid: Some("a".into()), ssrc: Some(1), mid: Some("0".into()),
                       bytes_sent: 1_000, packets_sent: 10, nack_count: 0,
                       pli_count: None, fir_count: None, packets_lost: None},
        ];

        let layers = merge_layers(&ladder(), &wire, &[pump(900, 4, 0), pump(880, 4, 0)], "openh264");

        assert_eq!(layers[1].rid.as_deref(), Some("b"));
        assert_eq!(layers[1].target_kbps, 900);
        assert_eq!(layers[1].bytes_sent, 0);
        assert_eq!(layers[1].ssrc, None);
    }

    /// A single-encoding publication is the pre-simulcast case: one rung, and the wire carries no
    /// rid at all, so the two must still pair up.
    #[test]
    fn a_single_encoding_publication_pairs_a_ridless_wire_row_with_the_only_rung() {
        let one = vec![ladder()[0].clone()];
        let wire = vec![
            WireLayer {rid: None, ssrc: Some(1), mid: Some("0".into()),
                       bytes_sent: 5_000, packets_sent: 50, nack_count: 0,
                       pli_count: None, fir_count: None, packets_lost: None},
        ];

        let layers = merge_layers(&one, &wire, &[pump(900, 4, 0)], "MediaFoundation");

        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].bytes_sent, 5_000);
        assert_eq!(layers[0].frames_encoded, 900);
    }

    // ── The ICE path ──────────────────────────────────────────────────────

    fn candidate(id: &str, kind: &str, protocol: &str) -> WireCandidate {
        WireCandidate {
            id: id.to_string(),
            candidate_type: kind.to_string(),
            protocol: protocol.to_string(),
        }
    }

    fn candidates(list: &[WireCandidate]) -> std::collections::HashMap<String, WireCandidate> {
        list.iter().map(|c| (c.id.clone(), c.clone())).collect()
    }

    fn pair(local: &str, remote: &str, succeeded: bool, nominated: bool, rtt: f64) -> WirePair {
        WirePair {
            local_candidate_id: local.to_string(),
            remote_candidate_id: remote.to_string(),
            succeeded,
            nominated,
            current_round_trip_time: rtt,
            available_outgoing_bitrate: 0.0,
        }
    }

    #[test]
    fn reports_the_path_of_the_succeeded_pair() {
        let map = candidates(&[candidate("L", "relay", "udp"), candidate("R", "srflx", "udp")]);
        let mut chosen = pair("L", "R", true, true, 0.084);
        chosen.available_outgoing_bitrate = 2_400_000.0;

        let t = pick_transport(&[chosen], &map, None).expect("a succeeded pair yields a path");

        assert_eq!(t.local_candidate_type.as_deref(), Some("relay"));
        assert_eq!(t.remote_candidate_type.as_deref(), Some("srflx"));
        assert_eq!(t.protocol.as_deref(), Some("udp"));
        assert_eq!(t.rtt_ms, Some(84));
        assert_eq!(t.available_outgoing_kbps, Some(2_400));
    }

    /// The finding this exists for: a sharer relaying through TURN. Picking any pair rather than
    /// the succeeded one would report the dead direct candidate that is still in the report, which
    /// is the exact opposite of the truth the reader needs.
    #[test]
    fn ignores_failed_and_in_progress_pairs_and_prefers_the_nominated_one() {
        let map = candidates(&[
            candidate("HOST", "host", "udp"),
            candidate("RELAY", "relay", "tcp"),
            candidate("PEER", "prflx", "udp"),
        ]);
        let pairs = vec![
            // A dead direct pair, still in the report for the connection's whole life.
            pair("HOST", "PEER", false, false, 0.005),
            // A succeeded but un-nominated pair, which is not the one carrying media.
            pair("HOST", "PEER", true, false, 0.006),
            pair("RELAY", "PEER", true, true, 0.19),
        ];

        let t = pick_transport(&pairs, &map, None).expect("a succeeded pair yields a path");

        assert_eq!(t.local_candidate_type.as_deref(), Some("relay"));
        assert_eq!(t.protocol.as_deref(), Some("tcp"));
        assert_eq!(t.rtt_ms, Some(190));
    }

    /// webrtc-rs types these counters as plain `f64` with no way to say "absent", so an unmeasured
    /// round trip arrives as `0.0`. Rendering that as a 0 ms path would be a measurement claim, and
    /// the whole model's rule is that a number nobody produced must read as absent instead.
    #[test]
    fn treats_an_unmeasured_zero_as_absent_and_falls_back_to_the_rtcp_round_trip() {
        let map = candidates(&[candidate("L", "host", "udp"), candidate("R", "host", "udp")]);

        let t = pick_transport(&[pair("L", "R", true, true, 0.0)], &map, Some(31))
            .expect("a succeeded pair yields a path");

        assert_eq!(t.rtt_ms, Some(31));
        assert_eq!(t.available_outgoing_kbps, None);
    }

    /// ICE still gathering, or already gone. The RTCP round trip is real and still worth showing;
    /// the path fields are the ones that must stay absent.
    #[test]
    fn keeps_the_rtcp_round_trip_when_no_pair_has_succeeded() {
        let t = pick_transport(&[pair("L", "R", false, false, 0.0)], &candidates(&[]), Some(42))
            .expect("an rtcp round trip is still a transport block");

        assert_eq!(t.rtt_ms, Some(42));
        assert_eq!(t.local_candidate_type, None);
        assert_eq!(t.protocol, None);
    }

    #[test]
    fn reports_nothing_at_all_when_there_is_nothing_to_report() {
        assert!(pick_transport(&[], &candidates(&[]), None).is_none());
    }
}
