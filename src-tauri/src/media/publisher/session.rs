//! Owns a running publish: capture thread, encoder, and the peer connection feeding Cloudflare.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use image::RgbaImage;

use super::encoder::{new_encoder, EncoderSpec};
use super::pump::FramePump;
use super::rtc::{FrameSink, Publication};
use super::signalling::Signalling;
use crate::media::screen::{find_capture_source, run_capture_loop};

/// How many encoded frames may queue between the capture thread and the async writer.
///
/// Small on purpose: a screen share that falls behind should drop frames and stay current rather
/// than build a backlog and drift further behind real time.
const FRAME_QUEUE: usize = 2;

/// Consecutive failed writes tolerated before the publication is considered dead.
///
/// More than a handful, because the failure this exists for arrives in bursts: a socket whose send
/// queue is full stays full for as long as it takes to drain, so one oversized frame can fail
/// several writes in a row and then recover completely. Few enough that a connection which has
/// genuinely gone away is torn down within a second rather than encoding into a void.
pub const WRITE_FAILURES_BEFORE_GIVING_UP: u32 = 30;

/// A downscaled frame for the sharer's own tile.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrame {
    /// base64-encoded JPEG.
    pub data: String,
    pub width: u32,
    pub height: u32,
}

pub struct PublishHandle {
    stop_tx: Mutex<Option<std::sync::mpsc::SyncSender<()>>>,
    /// Read every frame by the capture loop, so a framerate change lands within one frame.
    fps: Arc<AtomicU32>,
    /// Fixed output geometry, and the target the encoder was built for.
    width: AtomicU32,
    height: AtomicU32,
    pub cf_session_id: String,
    pub track_name: String,
    pub encoder_name: &'static str,
}

impl PublishHandle {
    pub fn set_fps(&self, fps: u32) {
        self.fps.store(fps.clamp(1, 60), Ordering::Relaxed);
    }

    pub fn geometry(&self) -> (u32, u32) {
        (
            self.width.load(Ordering::Relaxed),
            self.height.load(Ordering::Relaxed),
        )
    }

    pub fn stop(&self) {
        // Dropping the sender disconnects the channel; the capture loop's recv_timeout returns
        // Disconnected and unwinds the whole pipeline.
        if let Ok(mut guard) = self.stop_tx.lock() {
            guard.take();
        }
    }
}

/// Drain encoded frames into the transport until the pump stops or the connection dies.
///
/// The peer connection is async and the capture loop is a blocking OS thread, so encoded frames
/// cross over here rather than blocking capture on the network.
///
/// Generic over the sink so the failure handling below can be exercised: it is the whole reason
/// this is a function rather than an inline `tokio::spawn`.
pub async fn run_writer<S: FrameSink>(
    sink: S,
    mut frame_rx: tokio::sync::mpsc::Receiver<(Vec<u8>, Duration)>,
) {
    let mut consecutive_failures = 0u32;
    while let Some((data, duration)) = frame_rx.recv().await {
        match sink.write_frame(data, duration).await {
            Ok(()) => consecutive_failures = 0,
            Err(e) => {
                consecutive_failures += 1;
                // A failed write used to end the share outright, and the most common failure here
                // is not fatal at all: Windows answers WSAENOBUFS (os error 10055) when a UDP
                // socket's send queue is momentarily full, which is exactly what a keyframe does -
                // one intra frame is hundreds of packets handed to the socket at once. So the first
                // large frame of a share could kill the publication, and the viewer would sit on a
                // placeholder forever while this side went on capturing and encoding perfectly
                // happily. Nothing above reported it, because the share was still "running"
                // everywhere except on the wire.
                //
                // Dropping the frame is the right answer: video is not worth retrying, the next
                // frame is already on its way, and a keyframe that fails will be reissued by the
                // wall-clock interval or by a viewer's PLI. Only a run of failures means the
                // connection itself is gone.
                if consecutive_failures >= WRITE_FAILURES_BEFORE_GIVING_UP {
                    eprintln!(
                        "[publisher] {consecutive_failures} consecutive write failures, \
                         ending publication: {e}"
                    );
                    break;
                }
                eprintln!("[publisher] dropped a frame: {e}");
            }
        }
    }
    sink.stop().await;
}

/// Start capturing, encoding and publishing a source.
///
/// Returns once the track is live on Cloudflare, so the caller can tell other clients to subscribe.
#[allow(clippy::too_many_arguments)]
pub async fn start(
    source_id: String,
    share_id: String,
    width: u32,
    height: u32,
    fps: u32,
    kbps: u32,
    ice_servers: Vec<crate::media::publisher::rtc::IceServerConfig>,
    signalling: Signalling,
    on_preview: tauri::ipc::Channel<PreviewFrame>,
) -> Result<PublishHandle, String> {
    let spec = EncoderSpec {
        width,
        height,
        fps,
        kbps,
    };
    let encoder = new_encoder(spec)
        .ok_or_else(|| "no H.264 encoder available (OpenH264 not provisioned?)".to_string())?;
    let encoder_name = encoder.name();

    let publication = Publication::start(signalling, &share_id, ice_servers).await?;
    let cf_session_id = publication.cf_session_id.clone();
    let track_name = publication.track_name.clone();
    // Taken before the publication is moved into the writer task below.
    let keyframe_requests = publication.keyframe_requests();

    // One AtomicU32, three holders: the capture loop's pacing, the pump's frame-interval maths, and
    // the handle `set_publish_fps` writes through. It used to be two plus a *fourth* freshly
    // allocated for the handle, so every framerate change from the UI was stored somewhere nothing
    // read - `set_publish_fps` has never changed the capture rate of a running share.
    let fps_arc = Arc::new(AtomicU32::new(fps.clamp(1, 60)));
    let capture_fps = Arc::clone(&fps_arc);
    let handle_fps = Arc::clone(&fps_arc);
    let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
    let (frame_tx, frame_rx) = tokio::sync::mpsc::channel::<(Vec<u8>, Duration)>(FRAME_QUEUE);

    tokio::spawn(run_writer(publication, frame_rx));

    let mut pump = FramePump::new(
        width,
        height,
        fps_arc,
        encoder,
        keyframe_requests,
        on_preview,
        frame_tx,
    );

    std::thread::Builder::new()
        .name("sc-publish".into())
        .spawn(move || {
            let Some(source) = find_capture_source(&source_id) else {
                eprintln!("[publisher] capture source {source_id} not found");
                return;
            };

            run_capture_loop(source, capture_fps, stop_rx, move |rgba: RgbaImage, _w, _h| {
                pump.on_frame(&rgba)
            });
        })
        .map_err(|e| e.to_string())?;

    Ok(PublishHandle {
        stop_tx: Mutex::new(Some(stop_tx)),
        fps: handle_fps,
        width: AtomicU32::new(width),
        height: AtomicU32::new(height),
        cf_session_id,
        track_name,
        encoder_name,
    })
}
