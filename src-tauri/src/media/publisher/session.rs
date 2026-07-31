//! Owns a running publish: capture thread, encoder, and the peer connection feeding Cloudflare.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use image::RgbaImage;

use super::encoder::{new_encoder, EncodeOutcome, EncoderSpec};
use super::fit::fit_into;
use super::rtc::Publication;
use super::signalling::Signalling;
use crate::media::screen::{find_capture_source, run_capture_loop};

/// How many encoded frames may queue between the capture thread and the async writer.
///
/// Small on purpose: a screen share that falls behind should drop frames and stay current rather
/// than build a backlog and drift further behind real time.
const FRAME_QUEUE: usize = 2;

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
    ice_urls: Vec<String>,
    signalling: Signalling,
) -> Result<PublishHandle, String> {
    let spec = EncoderSpec {
        width,
        height,
        fps,
        kbps,
    };
    let mut encoder = new_encoder(spec)
        .ok_or_else(|| "no H.264 encoder available (OpenH264 not provisioned?)".to_string())?;
    let encoder_name = encoder.name();

    let publication = Publication::start(signalling, &share_id, ice_urls).await?;
    let cf_session_id = publication.cf_session_id.clone();
    let track_name = publication.track_name.clone();

    let fps_arc = Arc::new(AtomicU32::new(fps.clamp(1, 60)));
    let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::channel::<(Vec<u8>, Duration)>(FRAME_QUEUE);

    // Writer task: the peer connection is async, the capture loop is a blocking OS thread, so
    // encoded frames cross over here rather than blocking capture on the network.
    tokio::spawn(async move {
        while let Some((data, duration)) = frame_rx.recv().await {
            if let Err(e) = publication.write_frame(data, duration).await {
                eprintln!("[publisher] write failed, ending publication: {e}");
                break;
            }
        }
        publication.stop().await;
    });

    let capture_fps = Arc::clone(&fps_arc);
    std::thread::Builder::new()
        .name("sc-publish".into())
        .spawn(move || {
            let Some(source) = find_capture_source(&source_id) else {
                eprintln!("[publisher] capture source {source_id} not found");
                return;
            };

            let mut timestamp_us: u64 = 0;
            run_capture_loop(source, capture_fps, stop_rx, move |rgba: RgbaImage, _w, _h| {
                let current_fps = fps_arc.load(Ordering::Relaxed).max(1) as u64;
                let frame_interval_us = 1_000_000 / current_fps;

                // Fit before encoding: the source can change size mid-session, the encoder cannot.
                let frame = fit_into(&rgba, width, height);
                let outcome = encoder.encode(&frame, timestamp_us);
                timestamp_us += frame_interval_us;

                let chunk = match outcome {
                    EncodeOutcome::Chunk(chunk) => chunk,
                    // Rate control, or a pipelined encoder still filling up. Normal.
                    EncodeOutcome::Skipped => return,
                    EncodeOutcome::Failed => {
                        // The resilient wrapper already tried to fall back, so reaching here means
                        // there is nothing left to encode with.
                        eprintln!("[publisher] encoding failed with no fallback left; ending capture");
                        return;
                    }
                };

                // try_send, not send: dropping the newest frame when the writer is behind keeps
                // latency bounded, which matters far more than completeness for a live screen.
                // Full is routine backpressure; closed means the writer task already ended and the
                // loop will exit on its next stop check.
                let _ = frame_tx.try_send((chunk.data, Duration::from_micros(frame_interval_us)));
            });
        })
        .map_err(|e| e.to_string())?;

    Ok(PublishHandle {
        stop_tx: Mutex::new(Some(stop_tx)),
        fps: Arc::new(AtomicU32::new(fps.clamp(1, 60))),
        width: AtomicU32::new(width),
        height: AtomicU32::new(height),
        cf_session_id,
        track_name,
        encoder_name,
    })
}
