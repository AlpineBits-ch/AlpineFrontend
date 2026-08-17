//! The zero-copy capture loop: one persistent session, one blit per rung, no pixels on the CPU.
//!
//! This is the GPU half of [`crate::media::publisher::pump::LayerFrames`]. The pump's policy is
//! unchanged and unduplicated - timestamps from the clock, the wall-clock keyframe floor, per-layer
//! counters, the local-stream copy, the preview interval - because every one of those rules exists
//! for a failure a viewer suffers, and a second copy of them would be a second thing to get wrong.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use image::RgbaImage;

use super::capture::{GpuCapture, GpuFrame};
use super::convert::{GpuScaler, PreviewTap, Rung};
use super::device::GpuDevice;
use crate::media::publisher::encoder::CapturedFrame;
use crate::media::publisher::pump::{FramePump, LayerFrames, PreviewSink};

/// Width of the readback for the sharer's thumbnail. Matches the pump's own preview box, so
/// nothing downstream has to resize it again.
const PREVIEW_WIDTH: u32 = 480;
const PREVIEW_HEIGHT: u32 = 270;

/// Everything one share needs on the GPU, and the frame currently in flight.
pub struct GpuPipeline {
    capture: GpuCapture,
    scaler: GpuScaler,
    rungs: Vec<Rung>,
    /// Absent when the sharer's tile decodes the encoded stream, which is every webview with a
    /// `VideoDecoder` and therefore almost all of them. Building it costs two small textures.
    preview: Option<PreviewTap>,
    /// The frame being encoded. Held across the pump's layer loop, and held *between* frames: a
    /// screen nobody is touching presents nothing at all, and re-encoding what we already have is
    /// what keeps the keyframe clock running rather than leaving a viewer on a placeholder.
    current: Option<GpuFrame>,
    /// Whether [`Self::advance`] took a genuinely new frame since the last encode.
    ///
    /// Windows Graphics Capture is change-driven, so this is false exactly when the source has not
    /// presented - a desktop nobody is touching, or a window that is not redrawing.
    fresh: bool,
    thumbnail: Option<RgbaImage>,
}

impl GpuPipeline {
    /// Open a session and build the scaler for it.
    ///
    /// Every failure here is a reason to run the portable pipeline instead, so they are all
    /// `Err(String)` rather than anything fatal. See `session::start`.
    pub fn open(source_id: &str, device: Arc<GpuDevice>, wants_preview: bool) -> Result<Self, String> {
        let capture = GpuCapture::open(source_id, Arc::clone(&device))?;
        let scaler = GpuScaler::new(device, capture.source_size())?;
        let preview = if wants_preview {
            Some(scaler.new_preview(PREVIEW_WIDTH, PREVIEW_HEIGHT)?)
        } else {
            None
        };
        Ok(Self {
            capture,
            scaler,
            rungs: Vec::new(),
            preview,
            current: None,
            fresh: false,
            thumbnail: None,
        })
    }

    /// Take the newest frame if there is one, keeping the last otherwise.
    ///
    /// Returns false when there has never been a frame at all, which is the opening moments of a
    /// share on a screen that has not changed since.
    fn advance(&mut self) -> bool {
        if let Some(frame) = self.capture.take_latest() {
            if let Some(previous) = self.current.replace(frame) {
                self.capture.recycle(previous);
            }
            self.fresh = true;
        }
        let Some(current) = self.current.as_ref() else {
            return false;
        };

        // A shared window being resized changes the capture geometry under us. The processor is
        // built for a fixed input size, so it and every rung have to move with it.
        let size = (current.width, current.height);
        if self.scaler.source() != size {
            if let Err(e) = self.scaler.retarget(size) {
                eprintln!("[publisher] the scaler refused {}x{}: {e}", size.0, size.1);
                return false;
            }
            self.rungs.clear();
            if self.preview.is_some() {
                self.preview = self.scaler.new_preview(PREVIEW_WIDTH, PREVIEW_HEIGHT).ok();
            }
        }
        true
    }

    /// Whether the frame now held is one the source presented since the last call, clearing the
    /// flag as it answers.
    fn take_fresh(&mut self) -> bool {
        std::mem::take(&mut self.fresh)
    }

    /// Make sure this rung's NV12 targets exist and are the size the layer expects.
    ///
    /// Separate from the blit below so the borrow of `self` it needs is over before that one
    /// starts. A rung whose geometry has moved is rebuilt rather than resized: the targets, their
    /// output views and the encoder's own retype all have to agree, and rebuilding is the only
    /// version of that with no intermediate state.
    fn ensure_rung(&mut self, index: usize, width: u32, height: u32) -> bool {
        while self.rungs.len() <= index {
            let next = self.rungs.len();
            match self.scaler.new_rung(width, height) {
                Ok(rung) => self.rungs.push(rung),
                Err(e) => {
                    eprintln!("[publisher] no GPU target for layer {next}: {e}");
                    return false;
                }
            }
        }
        if self.rungs[index].width != width || self.rungs[index].height != height {
            match self.scaler.new_rung(width, height) {
                Ok(rung) => self.rungs[index] = rung,
                Err(e) => {
                    eprintln!("[publisher] could not retype layer {index} to {width}x{height}: {e}");
                    return false;
                }
            }
        }
        true
    }
}

impl LayerFrames for GpuPipeline {
    fn layer(&mut self, index: usize, width: u32, height: u32) -> Option<CapturedFrame<'_>> {
        if self.current.is_none() || !self.ensure_rung(index, width, height) {
            return None;
        }

        // Destructured rather than reached through `self`, which is what lets the scaler be
        // borrowed while the rung it writes into is borrowed mutably. The borrow checker cannot
        // see that two fields are disjoint through a method call; it can see it through this.
        let Self {
            scaler,
            rungs,
            current,
            ..
        } = self;
        let frame = &current.as_ref()?.texture;
        let rung = rungs.get_mut(index)?;

        match scaler.blit(frame, rung) {
            Ok(texture) => Some(CapturedFrame::Gpu(texture)),
            Err(e) => {
                eprintln!("[publisher] layer {index} blit failed: {e}");
                None
            }
        }
    }

    fn thumbnail(&mut self) -> Option<&RgbaImage> {
        let tap = self.preview.as_ref()?;
        let frame = &self.current.as_ref()?.texture;
        match self.scaler.read_preview(frame, tap) {
            Ok(image) => {
                self.thumbnail = Some(image);
                self.thumbnail.as_ref()
            }
            Err(e) => {
                eprintln!("[publisher] preview readback failed: {e}");
                None
            }
        }
    }
}

/// Drive a pump from a persistent capture session until stopped.
///
/// Paced rather than event-driven. Capture delivers on every present, which on a 240 Hz monitor is
/// four times what any share is configured for, and encoding all of them would spend the game's
/// GPU on frames nobody asked for. The rate is re-read every iteration, so a framerate change
/// lands within one frame exactly as it does on the portable path.
pub fn run_gpu_capture_loop<P: PreviewSink>(
    mut pipeline: GpuPipeline,
    mut pump: FramePump<P>,
    fps: Arc<AtomicU32>,
    stop_rx: std::sync::mpsc::Receiver<()>,
) {
    let mut next_frame = Instant::now();
    let mut last_encode = Instant::now() - IDLE_REPEAT;
    loop {
        let interval = Duration::from_micros(
            1_000_000 / fps.load(Ordering::Relaxed).clamp(1, 240) as u64,
        );
        let now = Instant::now();
        match stop_rx.recv_timeout(next_frame.saturating_duration_since(now)) {
            Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }

        // Clamped to now rather than advanced blindly. A loop that has fallen behind would
        // otherwise accumulate a deficit it later burns off by running flat out for as long as it
        // took to build, which is the opposite of what a share that is struggling should do.
        next_frame = (next_frame + interval).max(Instant::now());

        if !pipeline.advance() {
            continue;
        }

        if !should_encode(pipeline.take_fresh(), last_encode.elapsed()) {
            continue;
        }
        last_encode = Instant::now();
        pump.drive(&mut pipeline);
    }
}

/// Whether this tick is worth handing to the encoder.
///
/// <p>The whole cost of a share is the encoder, and it is charged per frame offered rather than
/// per pixel changed: measured on an RTX 3090, re-encoding a desktop nobody was touching cost the
/// same 47% of the encode block as encoding a moving picture, and skipping those frames took it to
/// 3%. So a frame the source did not present is offered only to keep the stream alive.</p>
///
/// <p>A game presents every frame, so nothing about it is throttled by this. It is desktop and
/// window sharing that stop costing anything while nothing is happening.</p>
fn should_encode(fresh: bool, since_last_encode: Duration) -> bool {
    fresh || since_last_encode >= IDLE_REPEAT
}

/// How often an unchanged screen is re-encoded anyway.
///
/// Not zero. The pump's keyframe floor is wall-clock and only advances on frames it is given, so a
/// source that has stopped presenting still has to reach the encoder often enough to serve a
/// viewer who joins mid-share. Four times a second is far below the rate that costs anything and
/// far above the two-second keyframe interval it has to feed.
const IDLE_REPEAT: Duration = Duration::from_millis(250);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_the_source_presented_is_always_encoded() {
        // The gaming case. Every tick carries a new picture, so nothing here may throttle it.
        assert!(should_encode(true, Duration::ZERO));
        assert!(should_encode(true, IDLE_REPEAT * 10));
    }

    #[test]
    fn an_unchanged_screen_is_skipped_until_the_keepalive_is_due() {
        assert!(!should_encode(false, Duration::ZERO));
        assert!(!should_encode(false, IDLE_REPEAT / 2));
        assert!(should_encode(false, IDLE_REPEAT));
    }

    /// The keepalive has to be well inside the pump's keyframe floor, or a viewer joining a share
    /// of a screen nobody is touching waits on a placeholder for as long as it takes the two
    /// intervals to line up.
    #[test]
    fn the_keepalive_outpaces_the_keyframe_floor() {
        assert!(
            IDLE_REPEAT * 2 < crate::media::publisher::pump::KEYFRAME_INTERVAL,
            "an idle share cannot feed its own keyframe clock"
        );
    }
}
