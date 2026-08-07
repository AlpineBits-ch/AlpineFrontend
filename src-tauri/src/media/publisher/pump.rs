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

    /// When the first frame of this publish was pumped, so timestamps are an offset from it.
    ///
    /// Set on the first frame rather than at construction: `start` builds the pump before the
    /// capture thread has opened the source, and counting the gap in between would open every
    /// share with a lie.
    started: Option<Instant>,
    /// The previous frame's arrival, for the inter-frame duration handed to the writer.
    last_frame_at: Option<Instant>,
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
            started: None,
            last_frame_at: None,
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
        // Read the clock before the work, not after: the timestamp belongs to when the frame was
        // captured, and fitting and encoding it takes long enough at high resolutions to matter.
        let now = Instant::now();
        let started = *self.started.get_or_insert(now);

        // Both derived from the clock rather than from the declared framerate.
        //
        // A share reaches its configured rate only when capture, fit, convert and encode all fit
        // inside one frame interval, and at 1440p in an unoptimised build a single frame costs
        // four times that. Counting frames at the declared rate regardless is wrong twice over.
        // The encoder's rate control divides its bitrate budget by the rate it believes it is
        // being fed, so a 4 fps share timestamped as 30 fps spends an eighth of the bits it should
        // on every frame - which is why a slow share does not merely stutter, it turns to mush.
        // And the writer turns this duration into RTP timestamps, so a nominal value leaves the
        // receiver's clock running at a different rate to the sender's for the whole share.
        let timestamp_us = now.duration_since(started).as_micros() as u64;
        let frame_duration = match self.last_frame_at {
            Some(previous) => now.duration_since(previous),
            // Nothing to measure against yet, so fall back to the declared rate for one frame.
            None => Duration::from_micros(1_000_000 / self.fps.load(Ordering::Relaxed).max(1) as u64),
        };
        self.last_frame_at = Some(now);

        // Fit before encoding: the source can change size mid-session, the encoder cannot.
        let frame = fit_into(rgba, self.width, self.height);

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

        let outcome = self.encoder.encode(&frame, timestamp_us);

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
        if self.frame_tx.try_send((chunk.data, frame_duration)).is_err() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::publisher::encoder::EncodedChunk;

    /// Hands back one chunk per frame and records the timestamp it was given.
    struct RecordingEncoder {
        seen: Arc<std::sync::Mutex<Vec<u64>>>,
    }

    impl VideoEncoder for RecordingEncoder {
        fn encode(&mut self, _frame: &RgbaImage, timestamp_us: u64) -> EncodeOutcome {
            self.seen.lock().unwrap().push(timestamp_us);
            EncodeOutcome::Chunk(EncodedChunk {
                data: vec![0, 0, 0, 1, 0x65],
                is_keyframe: false,
                timestamp_us,
            })
        }

        fn request_keyframe(&mut self) {}

        fn name(&self) -> &'static str {
            "recording"
        }
    }

    struct Harness {
        pump: FramePump<()>,
        seen: Arc<std::sync::Mutex<Vec<u64>>>,
        frames: tokio::sync::mpsc::Receiver<(Vec<u8>, Duration)>,
    }

    /// A pump declaring `fps`, with a queue deep enough that nothing under test is dropped.
    fn harness(fps: u32) -> Harness {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (frame_tx, frames) = tokio::sync::mpsc::channel(64);
        let pump = FramePump::new(
            64,
            64,
            Arc::new(AtomicU32::new(fps)),
            Box::new(RecordingEncoder {
                seen: Arc::clone(&seen),
            }),
            Arc::new(AtomicBool::new(false)),
            (),
            frame_tx,
        );
        Harness { pump, seen, frames }
    }

    fn frame() -> RgbaImage {
        RgbaImage::from_pixel(64, 64, image::Rgba([10, 20, 30, 255]))
    }

    /// Drains whatever the pump has queued so far.
    fn durations(harness: &mut Harness) -> Vec<Duration> {
        let mut out = Vec::new();
        while let Ok((_, duration)) = harness.frames.try_recv() {
            out.push(duration);
        }
        out
    }

    /// The gap the pump is told to expect, against the gap it is actually fed.
    ///
    /// A screen share reaches its declared framerate only if capture, fit, convert and encode all
    /// fit inside one frame interval. When they do not - a debug build, a 4K source, a busy
    /// machine - the frames still arrive, just further apart. What must not happen is the
    /// timestamps carrying on as though nothing had changed.
    const DECLARED_FPS: u32 = 30;
    const REAL_GAP: Duration = Duration::from_millis(100);

    #[test]
    fn timestamps_follow_the_clock_rather_than_the_declared_framerate() {
        let mut h = harness(DECLARED_FPS);
        for _ in 0..5 {
            h.pump.on_frame(&frame());
            std::thread::sleep(REAL_GAP);
        }

        let seen = h.seen.lock().unwrap().clone();
        let span = seen.last().unwrap() - seen.first().unwrap();

        // Four gaps of 100 ms is 400 ms of real time. Counting frames at the declared 30 fps
        // instead gives 4 x 33 ms = 133 ms, and an encoder handed that believes it is being fed
        // three times faster than it is - so its rate control spends a full 30 fps bit budget on
        // frames that actually leave at 10, and every one of them is starved to a third of the
        // bits it needed. That is what turns a slow share into a blocky one.
        assert!(
            span > 300_000,
            "5 frames spanning 400 ms of wall clock were timestamped across only {} us - the pump \
             is counting frames at the declared rate instead of reading the clock",
            span
        );
    }

    #[test]
    fn the_frame_duration_handed_to_the_writer_is_the_real_gap() {
        let mut h = harness(DECLARED_FPS);
        h.pump.on_frame(&frame());
        std::thread::sleep(REAL_GAP);
        h.pump.on_frame(&frame());

        // The writer turns this into the sample duration, which is what the RTP timestamps are
        // built from. A nominal value here makes the receiver's clock run at a different rate to
        // the sender's for the whole share.
        let gaps = durations(&mut h);
        assert_eq!(gaps.len(), 2);
        assert!(
            gaps[1] > Duration::from_millis(70),
            "the second frame arrived 100 ms after the first but was declared {:?} long",
            gaps[1]
        );
    }

    #[test]
    fn the_first_frame_starts_at_zero() {
        let mut h = harness(DECLARED_FPS);
        h.pump.on_frame(&frame());
        assert_eq!(h.seen.lock().unwrap()[0], 0);
    }

    #[test]
    fn a_share_that_keeps_up_is_timestamped_at_about_its_declared_rate() {
        // The other side of the same rule: when capture *does* hold its rate, nothing changes.
        let mut h = harness(DECLARED_FPS);
        for _ in 0..4 {
            h.pump.on_frame(&frame());
            std::thread::sleep(Duration::from_millis(33));
        }

        let seen = h.seen.lock().unwrap().clone();
        let span = seen.last().unwrap() - seen.first().unwrap();
        assert!(
            (70_000..170_000).contains(&span),
            "three 33 ms gaps should span about 100 ms, got {span} us"
        );
    }
}
