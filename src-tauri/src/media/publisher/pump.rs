//! What happens to one captured frame: fit, preview, keyframe policy, encode, enqueue.
//!
//! Lifted out of the capture closure in [`super::session`] so it can be driven without a screen.
//! Every rule in here was written for a failure a viewer suffers and the sharer cannot see - the
//! sharer's own preview is drawn from the capture source and looks perfect whether or not a single
//! byte ever reaches the wire - so each one is worth being able to assert on directly.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use image::RgbaImage;

use super::encoder::{EncodeOutcome, VideoEncoder};
use super::fit::fit_into;
use super::session::PreviewFrame;

/// Width of the local self-preview, in pixels. It is a thumbnail in a tile, not the stream, so it
/// is small enough that JPEG over IPC costs nothing meaningful next to the encode itself.
const PREVIEW_WIDTH: u32 = 480;

/// Interval between preview frames. Fast enough to read as live, slow enough to stay free.
pub const PREVIEW_INTERVAL: Duration = Duration::from_millis(200);

/// How often the encode loop reports what it has produced. 150 frames is roughly five seconds at
/// the usual capture rate - often enough to watch a share start, rare enough not to fill a log.
const STATS_EVERY_FRAMES: u64 = 150;

/// The longest a viewer may wait for a decodable picture.
///
/// In wall-clock time on purpose. Both encoders take their keyframe interval as a frame count,
/// which is the wrong unit for a screen share: a static desktop produces only a few frames a
/// second, so a 60-frame interval that was meant to be two seconds becomes twenty. This bounds it
/// regardless of what the screen is doing.
pub const KEYFRAME_INTERVAL: Duration = Duration::from_secs(2);

/// Where the sharer's own thumbnail goes.
///
/// A trait only because `tauri::ipc::Channel` cannot be constructed outside a running app, and the
/// pump would otherwise be untestable for that one reason alone.
pub trait PreviewSink: Send + 'static {
    fn send(&self, frame: PreviewFrame);
}

impl PreviewSink for tauri::ipc::Channel<PreviewFrame> {
    fn send(&self, frame: PreviewFrame) {
        let _ = tauri::ipc::Channel::send(self, frame);
    }
}

/// Discards previews, for the paths that are not about the sharer's own tile.
impl PreviewSink for () {
    fn send(&self, _frame: PreviewFrame) {}
}

/// Counters for one publish, for logging and for tests to assert on.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PumpStats {
    pub encoded_frames: u64,
    pub keyframes: u64,
    /// Frames the writer was too far behind to accept. Routine backpressure, not an error.
    pub dropped_frames: u64,
}

/// Turns captured frames into queued access units.
pub struct FramePump<P: PreviewSink> {
    /// Fixed output geometry. The source can change size mid-session; the encoder cannot.
    width: u32,
    height: u32,
    /// Read every frame, so a framerate change lands within one frame.
    fps: Arc<AtomicU32>,
    encoder: Box<dyn VideoEncoder>,
    /// Set when a viewer asks for a keyframe over RTCP, cleared as it is served.
    keyframe_wanted: Arc<AtomicBool>,
    /// The floor on how long a viewer waits for a decodable picture. A field rather than a constant
    /// read inline so tests can assert the rule in milliseconds instead of seconds.
    keyframe_interval: Duration,
    preview: P,
    frame_tx: tokio::sync::mpsc::Sender<(Vec<u8>, Duration)>,

    timestamp_us: u64,
    jpeg_buf: Vec<u8>,
    next_preview: Instant,
    last_keyframe: Instant,
    stats: PumpStats,
}

impl<P: PreviewSink> FramePump<P> {
    pub fn new(
        width: u32,
        height: u32,
        fps: Arc<AtomicU32>,
        encoder: Box<dyn VideoEncoder>,
        keyframe_wanted: Arc<AtomicBool>,
        preview: P,
        frame_tx: tokio::sync::mpsc::Sender<(Vec<u8>, Duration)>,
    ) -> Self {
        Self {
            width,
            height,
            fps,
            encoder,
            keyframe_wanted,
            keyframe_interval: KEYFRAME_INTERVAL,
            preview,
            frame_tx,
            timestamp_us: 0,
            jpeg_buf: Vec::with_capacity(64 * 1024),
            next_preview: Instant::now(),
            // In the past, so the very first frame of a share is a keyframe rather than waiting out
            // an interval before the first viewer can decode anything.
            last_keyframe: Instant::now() - KEYFRAME_INTERVAL,
            stats: PumpStats::default(),
        }
    }

    /// Shorten the keyframe floor. Tests only: production wants [`KEYFRAME_INTERVAL`].
    #[cfg(test)]
    pub fn with_keyframe_interval(mut self, interval: Duration) -> Self {
        self.keyframe_interval = interval;
        self.last_keyframe = Instant::now() - interval;
        self
    }

    pub fn stats(&self) -> PumpStats {
        self.stats
    }

    /// Fit, preview, encode and enqueue one captured frame.
    ///
    /// Never blocks. A writer that has fallen behind costs a dropped frame, not a stalled capture
    /// thread - for a live screen, bounded latency matters far more than completeness.
    pub fn on_frame(&mut self, rgba: &RgbaImage) {
        let current_fps = self.fps.load(Ordering::Relaxed).max(1) as u64;
        let frame_interval_us = 1_000_000 / current_fps;

        // Fit before encoding: the source can change size mid-session, the encoder cannot.
        let frame = fit_into(rgba, self.width, self.height);

        let now = Instant::now();
        if now >= self.next_preview {
            self.next_preview = now + PREVIEW_INTERVAL;
            emit_preview(&frame, &mut self.jpeg_buf, &self.preview);
        }

        // A viewer who cannot decode has asked for a keyframe over RTCP. Honoured here because the
        // encoder belongs to this thread and cannot be reached from the network task that received
        // the request. This is what lets someone who joins mid-share, or who loses a burst of
        // packets, recover immediately instead of waiting out the periodic IDR. `swap` because the
        // request is cleared as it is served: a second viewer asking while this frame encodes will
        // set it again and get the next one.
        //
        // The wall clock is the other half. Both encoders express their keyframe interval in
        // *frames*, and a screen share's frame rate is whatever the screen is doing: a still
        // desktop produces a handful of frames a second, so an interval of `fps * 2` frames - two
        // seconds at the rate the encoder was configured for - can be twenty seconds of real time.
        // What a viewer waits is the wall clock, and until the first keyframe arrives they have
        // nothing to decode and show a placeholder. Measured at roughly 45 seconds to first picture
        // on a mostly-static screen. So the interval configured on the encoder is the ceiling, and
        // this is the floor.
        if self.keyframe_wanted.swap(false, Ordering::Relaxed)
            || now.duration_since(self.last_keyframe) >= self.keyframe_interval
        {
            self.encoder.request_keyframe();
        }

        let outcome = self.encoder.encode(&frame, self.timestamp_us);
        self.timestamp_us += frame_interval_us;

        let chunk = match outcome {
            EncodeOutcome::Chunk(chunk) => chunk,
            // Rate control, or a pipelined encoder still filling up. Normal.
            EncodeOutcome::Skipped => return,
            EncodeOutcome::Failed => {
                // The resilient wrapper already tried to fall back, so reaching here means there is
                // nothing left to encode with.
                eprintln!("[publisher] encoding failed with no fallback left; ending capture");
                return;
            }
        };

        // Whether this share is producing anything, and whether it contains the keyframes a viewer
        // needs in order to start decoding. Nothing reported either before, which left the two
        // failures a viewer can suffer - "no picture ever arrives" and "a picture arrives that I
        // cannot decode" - indistinguishable from the sharing side.
        self.stats.encoded_frames += 1;
        if chunk.is_keyframe {
            self.stats.keyframes += 1;
            self.last_keyframe = now;
        }
        if self.stats.encoded_frames % STATS_EVERY_FRAMES == 0 {
            eprintln!(
                "[publisher] {} frames encoded, {} keyframes, {} dropped at the writer",
                self.stats.encoded_frames, self.stats.keyframes, self.stats.dropped_frames
            );
        }

        // try_send, not send: dropping the newest frame when the writer is behind keeps latency
        // bounded. Full is routine backpressure; closed means the writer task already ended and the
        // capture loop will exit on its next stop check.
        if self
            .frame_tx
            .try_send((chunk.data, Duration::from_micros(frame_interval_us)))
            .is_err()
        {
            self.stats.dropped_frames += 1;
        }
    }
}

/// Downscale the already-fitted frame and hand it to the webview for the local tile.
///
/// The publisher never puts a MediaStream in the webview - that is the point of it - so the local
/// tile has nothing to render without this. JPEG is genuinely the right tool here: it is a
/// thumbnail, decoded once per 200 ms.
fn emit_preview(frame: &RgbaImage, buf: &mut Vec<u8>, sink: &impl PreviewSink) {
    let scale = PREVIEW_WIDTH as f32 / frame.width() as f32;
    // Never upscale a source that is already smaller than the preview box.
    let (width, height) = if scale >= 1.0 {
        (frame.width(), frame.height())
    } else {
        (
            PREVIEW_WIDTH,
            (frame.height() as f32 * scale).round().max(1.0) as u32,
        )
    };

    let thumb = image::DynamicImage::ImageRgba8(frame.clone())
        .resize(width, height, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let out_width = thumb.width();
    let out_height = thumb.height();

    crate::media::screen::encode_jpeg_into(&image::DynamicImage::ImageRgb8(thumb), 70, buf);
    sink.send(PreviewFrame {
        data: crate::media::screen::base64_encode(buf),
        width: out_width,
        height: out_height,
    });
}
