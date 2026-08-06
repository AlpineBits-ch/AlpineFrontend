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

/// Width of the local self-preview, in pixels. It is a thumbnail in a tile, not the stream, so it
/// is small enough that JPEG over IPC costs nothing meaningful next to the encode itself.
const PREVIEW_WIDTH: u32 = 480;

/// Interval between preview frames. Fast enough to read as live, slow enough to stay free.
const PREVIEW_INTERVAL: Duration = Duration::from_millis(200);

/// How often the encode loop reports what it has produced. 150 frames is roughly five seconds at
/// the usual capture rate - often enough to watch a share start, rare enough not to fill a log.
const STATS_EVERY_FRAMES: u64 = 150;

/// The longest a viewer may wait for a decodable picture.
///
/// In wall-clock time on purpose. Both encoders take their keyframe interval as a frame count,
/// which is the wrong unit for a screen share: a static desktop produces only a few frames a
/// second, so a 60-frame interval that was meant to be two seconds becomes twenty. This bounds it
/// regardless of what the screen is doing.
const KEYFRAME_INTERVAL: Duration = Duration::from_secs(2);

/// Consecutive failed writes tolerated before the publication is considered dead.
///
/// More than a handful, because the failure this exists for arrives in bursts: a socket whose send
/// queue is full stays full for as long as it takes to drain, so one oversized frame can fail
/// several writes in a row and then recover completely. Few enough that a connection which has
/// genuinely gone away is torn down within a second rather than encoding into a void.
const WRITE_FAILURES_BEFORE_GIVING_UP: u32 = 30;

/// A downscaled frame for the sharer's own tile.
///
/// The publisher never puts a MediaStream in the webview - that is the point of it - so the local
/// tile has nothing to render without this. JPEG is genuinely the right tool here: it is a
/// thumbnail, decoded once per 200 ms.
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

/// Downscale the already-fitted frame and hand it to the webview for the local tile.
fn emit_preview(frame: &RgbaImage, buf: &mut Vec<u8>, channel: &tauri::ipc::Channel<PreviewFrame>) {
    let scale = PREVIEW_WIDTH as f32 / frame.width() as f32;
    // Never upscale a source that is already smaller than the preview box.
    let (width, height) = if scale >= 1.0 {
        (frame.width(), frame.height())
    } else {
        (PREVIEW_WIDTH, (frame.height() as f32 * scale).round().max(1.0) as u32)
    };

    let thumb = image::DynamicImage::ImageRgba8(frame.clone())
        .resize(width, height, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let out_width = thumb.width();
    let out_height = thumb.height();

    crate::media::screen::encode_jpeg_into(&image::DynamicImage::ImageRgb8(thumb), 70, buf);
    let _ = channel.send(PreviewFrame {
        data: crate::media::screen::base64_encode(buf),
        width: out_width,
        height: out_height,
    });
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
    let mut encoder = new_encoder(spec)
        .ok_or_else(|| "no H.264 encoder available (OpenH264 not provisioned?)".to_string())?;
    let encoder_name = encoder.name();

    let publication = Publication::start(signalling, &share_id, ice_servers).await?;
    let cf_session_id = publication.cf_session_id.clone();
    let track_name = publication.track_name.clone();
    // Taken before the publication is moved into the writer task below.
    let keyframe_requests = publication.keyframe_requests();

    let fps_arc = Arc::new(AtomicU32::new(fps.clamp(1, 60)));
    let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::channel::<(Vec<u8>, Duration)>(FRAME_QUEUE);

    // Writer task: the peer connection is async, the capture loop is a blocking OS thread, so
    // encoded frames cross over here rather than blocking capture on the network.
    tokio::spawn(async move {
        let mut consecutive_failures = 0u32;
        while let Some((data, duration)) = frame_rx.recv().await {
            match publication.write_frame(data, duration).await {
                Ok(()) => consecutive_failures = 0,
                Err(e) => {
                    consecutive_failures += 1;
                    // A failed write used to end the share outright, and the most common failure
                    // here is not fatal at all: Windows answers WSAENOBUFS (os error 10055) when a
                    // UDP socket's send queue is momentarily full, which is exactly what a keyframe
                    // does - one intra frame is hundreds of packets handed to the socket at once.
                    // So the first large frame of a share could kill the publication, and the
                    // viewer would sit on a placeholder forever while this side went on capturing
                    // and encoding perfectly happily. Nothing above reported it, because the share
                    // was still "running" everywhere except on the wire.
                    //
                    // Dropping the frame is the right answer: video is not worth retrying, the next
                    // frame is already on its way, and a keyframe that fails will be reissued by
                    // the wall-clock interval or by a viewer's PLI. Only a run of failures means
                    // the connection itself is gone.
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
            let mut jpeg_buf = Vec::with_capacity(64 * 1024);
            let mut next_preview = std::time::Instant::now();
            let (mut encoded_frames, mut keyframes, mut dropped_frames) = (0u64, 0u64, 0u64);
            // In the past, so the very first frame of a share is a keyframe rather than waiting out
            // an interval before the first viewer can decode anything.
            let mut last_keyframe = std::time::Instant::now() - KEYFRAME_INTERVAL;

            run_capture_loop(source, capture_fps, stop_rx, move |rgba: RgbaImage, _w, _h| {
                let current_fps = fps_arc.load(Ordering::Relaxed).max(1) as u64;
                let frame_interval_us = 1_000_000 / current_fps;

                // Fit before encoding: the source can change size mid-session, the encoder cannot.
                let frame = fit_into(&rgba, width, height);

                let now = std::time::Instant::now();
                if now >= next_preview {
                    next_preview = now + PREVIEW_INTERVAL;
                    emit_preview(&frame, &mut jpeg_buf, &on_preview);
                }
                // A viewer who cannot decode has asked for a keyframe over RTCP. Honoured here
                // because the encoder belongs to this thread and cannot be reached from the network
                // task that received the request.
                //
                // This is what lets someone who joins mid-share, or who loses a burst of packets,
                // recover immediately instead of waiting out the periodic IDR - and it is the
                // difference between a share that takes seconds to appear and one that appears at
                // once. `take_` because the request is cleared as it is served: a second viewer
                // asking while this frame encodes will set it again and get the next one.
                // Keyframes on a wall clock, not a frame count.
                //
                // Both encoders express their keyframe interval in *frames*, and a screen share's
                // frame rate is whatever the screen is doing: a still desktop produces a handful of
                // frames a second, so an interval of `fps * 2` frames - two seconds at the rate the
                // encoder was configured for - can be twenty seconds of real time. What a viewer
                // waits is the wall clock, and until the first keyframe arrives they have nothing
                // to decode and show a placeholder. Measured at roughly 45 seconds to first
                // picture on a mostly-static screen.
                //
                // So the interval configured on the encoder is the ceiling, and this is the floor.
                let since_keyframe = now.duration_since(last_keyframe);
                if keyframe_requests.swap(false, Ordering::Relaxed)
                    || since_keyframe >= KEYFRAME_INTERVAL
                {
                    encoder.request_keyframe();
                }

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

                // Whether this share is producing anything, and whether it contains the keyframes a
                // viewer needs in order to start decoding.
                //
                // Nothing here reported either, which left the two failures a viewer can suffer -
                // "no picture ever arrives" and "a picture arrives that I cannot decode" -
                // indistinguishable from the sharing side. They have completely different causes:
                // one is this pipeline, the other is the subscribe path, and the sharer's own
                // preview is drawn from the capture source and looks perfect in both cases.
                encoded_frames += 1;
                if chunk.is_keyframe {
                    keyframes += 1;
                    last_keyframe = now;
                }
                if encoded_frames % STATS_EVERY_FRAMES == 0 {
                    eprintln!(
                        "[publisher] {encoded_frames} frames encoded, {keyframes} keyframes, \
                         {dropped_frames} dropped at the writer"
                    );
                }

                // try_send, not send: dropping the newest frame when the writer is behind keeps
                // latency bounded, which matters far more than completeness for a live screen.
                // Full is routine backpressure; closed means the writer task already ended and the
                // loop will exit on its next stop check.
                if frame_tx
                    .try_send((chunk.data, Duration::from_micros(frame_interval_us)))
                    .is_err()
                {
                    dropped_frames += 1;
                }
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
