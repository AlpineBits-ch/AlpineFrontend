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

pub mod encoder;
pub mod fit;
pub mod encoder_sw;
#[cfg(target_os = "windows")]
pub mod encoder_mf;
pub mod nv12;
pub mod openh264_blob;
pub mod rtc;
pub mod session;
pub mod signalling;

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tauri::Manager;

use session::PublishHandle;
use signalling::{Signalling, VoiceTarget};

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
    pub cf_session_id: String,
    pub track_name: String,
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
    ice_urls: Vec<String>,
    api_base: String,
    token: String,
    // Guild voice supplies guild_id + channel_id; a DM call supplies call_id instead.
    guild_id: Option<String>,
    channel_id: Option<String>,
    call_id: Option<String>,
    on_preview: tauri::ipc::Channel<session::PreviewFrame>,
) -> Result<PublishResult, String> {
    stop_screen_publish();

    let target = match (guild_id, channel_id, call_id) {
        (Some(guild_id), Some(channel_id), _) => VoiceTarget::GuildChannel {
            guild_id,
            channel_id,
        },
        (_, _, Some(call_id)) => VoiceTarget::Call { call_id },
        _ => return Err("publish needs either guildId+channelId or callId".into()),
    };

    let signalling = Signalling::new(api_base, token, target)?;
    let handle = session::start(
        source_id,
        share_id,
        width,
        height,
        fps,
        kbps,
        ice_urls,
        signalling,
        on_preview,
    )
    .await?;

    let result = PublishResult {
        cf_session_id: handle.cf_session_id.clone(),
        track_name: handle.track_name.clone(),
        encoder: handle.encoder_name.to_string(),
    };

    if let Ok(mut guard) = active().lock() {
        *guard = Some(handle);
    }
    Ok(result)
}

/// Change the capture rate of the running publish.
///
/// Framerate is the only part of a preset that can change without rebuilding the encoder, which is
/// fixed to one geometry and bitrate for its lifetime. A resolution change goes through
/// stop-then-start instead.
#[tauri::command]
pub fn set_publish_fps(fps: u32) {
    if let Ok(guard) = active().lock() {
        if let Some(handle) = guard.as_ref() {
            handle.set_fps(fps);
        }
    }
}

#[tauri::command]
pub fn stop_screen_publish() {
    if let Ok(mut guard) = active().lock() {
        if let Some(handle) = guard.take() {
            handle.stop();
        }
    }
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
