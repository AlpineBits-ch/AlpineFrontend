use image::RgbaImage;
use openh264::encoder::{
    BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, RateControlMode, UsageType,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::{OpenH264API, Timestamp};

use super::encoder::{EncodedChunk, VideoEncoder};
use super::openh264_blob;

/// openh264 software encoder.
///
/// Used on platforms without a hardware encoder integration, and as the fallback when one fails to
/// initialise. Screen content at 1080p60 is genuinely expensive here, which is why the preset's
/// framerate is passed through to rate control rather than left at the default.
pub struct SoftwareEncoder {
    encoder: Encoder,
    yuv: YUVBuffer,
    width: u32,
    height: u32,
}

impl SoftwareEncoder {
    pub fn new(width: u32, height: u32, fps: u32, kbps: u32) -> Option<Self> {
        // H.264 4:2:0 needs even dimensions. The frontend's geometry solver already guarantees
        // this; rejecting rather than silently rounding keeps that contract honest.
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
            return None;
        }

        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(kbps.saturating_mul(1000)))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            // Screen content, not a camera: this is the closest usage type openh264 offers and it
            // biases toward preserving detail in flat UI regions.
            .usage_type(UsageType::ScreenContentRealTime)
            // Bitrate mode, so the encoder tracks the preset's budget instead of drifting on
            // quality. The transport handles congestion; the preset handles the target.
            .rate_control_mode(RateControlMode::Bitrate)
            // A periodic IDR bounds how long a late joiner waits for a decodable picture.
            .intra_frame_period(IntraFramePeriod::from_num_frames(fps.max(1) * 2))
            // openh264 does not support either of these for screen content and disables them with
            // a warning on every encoder it creates; turning them off here keeps the logs readable.
            .adaptive_quantization(false)
            .background_detection(false);

        // Cisco's precompiled binary, fetched at runtime -never a source build. See
        // openh264_blob for why. `from_blob_path` re-checks the SHA-256 against the crate's
        // baked-in list, so a tampered cache is rejected at load time as well as at download time.
        let path = openh264_blob::ready_path()?;
        let api = OpenH264API::from_blob_path(&path).ok()?;
        let encoder = Encoder::with_api_config(api, config).ok()?;
        Some(Self {
            encoder,
            yuv: YUVBuffer::new(width as usize, height as usize),
            width,
            height,
        })
    }
}

impl VideoEncoder for SoftwareEncoder {
    fn encode(&mut self, frame: &RgbaImage, timestamp_us: u64) -> Option<EncodedChunk> {
        if frame.width() != self.width || frame.height() != self.height {
            // Geometry is fixed for the session; a mismatch means the capture side broke its
            // contract, and encoding it anyway would corrupt the stream.
            return None;
        }

        self.yuv.read_rgb(RgbaSliceU8::new(
            frame.as_raw(),
            (self.width as usize, self.height as usize),
        ));

        let bitstream = self
            .encoder
            .encode_at(&self.yuv, Timestamp::from_millis(timestamp_us / 1000))
            .ok()?;

        let frame_type = bitstream.frame_type();
        if matches!(frame_type, FrameType::Skip | FrameType::Invalid) {
            return None;
        }

        let data = bitstream.to_vec();
        if data.is_empty() {
            return None;
        }

        Some(EncodedChunk {
            data,
            is_keyframe: matches!(frame_type, FrameType::IDR | FrameType::I),
            timestamp_us,
        })
    }

    fn request_keyframe(&mut self) {
        self.encoder.force_intra_frame();
    }

    fn name(&self) -> &'static str {
        "openh264"
    }
}
