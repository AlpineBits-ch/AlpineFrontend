//! Rust-native screen-share publishing.
//!
//! The existing capture path encodes each frame to JPEG, base64s it across the Tauri IPC boundary,
//! decodes it in JS, draws it to a canvas and lets the browser re-encode the canvas for WebRTC.
//! That is two lossy encodes and a full round trip per frame. This module is the replacement:
//! captured frames go straight into a real video encoder in Rust.
//!
//! Discord does the equivalent natively - OS capture into a hardware encoder, with frames never
//! leaving the process - which is why their streams stay sharp on text.

//! The publish opens its own Cloudflare session, separate from the webview's, and asks the backend
//! for it with `primary=false` so it is not recorded as the participant's audio session. Other
//! clients subscribe through the TrackPublished event, which carries the publishing session's id,
//! so they cannot tell which process produced the track.

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
pub mod signalling;

/// Frames in one end, RTP out the other, with the backend mocked over real HTTP.
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

use session::PublishHandle;
use signalling::{SessionRole, Signalling, VoiceTarget};

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
/// The auth token and API base are passed in rather than read here: the webview owns session
/// lifetime and token refresh, and duplicating that in Rust would mean two things to keep correct.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_screen_publish(
    source_id: String,
    share_id: String,
    width: u32,
    height: u32,
    fps: u32,
    kbps: u32,
    ice_servers: Vec<rtc::IceServerConfig>,
    api_base: String,
    token: String,
    // The same `X-Device-Id` the webview sends. Lower stakes than the voice engine's primary
    // session, but this path hits CreateSession too, so leaving it unstamped would move the
    // split rather than close it.
    device_id: String,
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

    // Secondary: the screen share must never be recorded as the participant's audio session.
    let signalling = Signalling::new(api_base, token, device_id, target, SessionRole::Secondary)?;
    let handle = session::start(
        source_id,
        share_id,
        width,
        height,
        fps,
        kbps,
        ice_servers,
        signalling,
        on_preview,
        local_stream.then_some(on_local_stream),
        share_audio,
    )
    .await?;

    let result = PublishResult {
        media_session_id: handle.media_session_id.clone(),
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

/// Change the resolution and bitrate of the running publish, without ending it.
///
/// <p>The encoder is retyped in place at the next frame boundary - see
/// [`session::PublishHandle::set_geometry`]. The session, the track and the share id all survive,
/// so this announces nothing and viewers see only a picture that changed size.</p>
///
/// <p>This used to be a stop followed by a start, which cost a new share id and left every viewer's
/// tile out of the grid for as long as the new publish took to negotiate.</p>
#[tauri::command]
pub fn set_publish_geometry(width: u32, height: u32, kbps: u32) {
    if let Ok(guard) = active().lock() {
        if let Some(handle) = guard.as_ref() {
            handle.set_geometry(width, height, kbps);
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
