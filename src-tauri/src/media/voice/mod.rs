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
pub mod codec;
pub mod denoise;
pub mod gate;
pub mod jitter;
pub mod mixer;
pub mod process;
pub mod resample;
pub mod ring;

/// Samples in one frame of mono audio - 10 ms at 48 kHz.
pub const FRAME: usize = 480;

/// The pipeline's only sample rate. Devices running at other rates are converted at the edges
/// (see [`resample`]) so that nothing downstream has to know about it.
pub const SAMPLE_RATE: u32 = 48_000;

/// Duration of one [`FRAME`], in milliseconds.
pub const FRAME_MS: u32 = 10;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_ten_milliseconds_at_the_pipeline_rate() {
        assert_eq!(FRAME as u32 * 1_000 / SAMPLE_RATE, FRAME_MS);
    }
}
