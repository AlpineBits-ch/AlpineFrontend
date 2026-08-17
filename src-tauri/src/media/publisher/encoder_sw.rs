use openh264::encoder::{
    BitRate, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, RateControlMode, UsageType,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::{OpenH264API, Timestamp};

use super::encoder::{
    CapturedFrame, EncodeOutcome, EncodedChunk, EncoderContent, EncoderSpec, VideoEncoder,
};
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

/// The two openh264 settings the content mode decides.
///
/// <p>A function rather than four lines inline so the mapping can be asserted directly. Building an
/// encoder and checking that it produces output cannot tell the modes apart - both encode fine - so
/// without this the branch would be covered by nothing that fails when it is deleted.</p>
fn openh264_mode(content: EncoderContent) -> (UsageType, RateControlMode) {
    match content {
        // A game is video, so the camera path and an even spend are both right.
        EncoderContent::Games => (UsageType::CameraVideoRealTime, RateControlMode::Bitrate),
        // Screen content, and a quantiser target rather than a bitrate target: a still desktop
        // should cost almost nothing so that the frames which do change can be sharp. Bitrate mode
        // keeps paying for the still screen and then clips the scroll that follows.
        EncoderContent::Text => (UsageType::ScreenContentRealTime, RateControlMode::Quality),
    }
}

impl SoftwareEncoder {
    pub fn new(spec: EncoderSpec) -> Option<Self> {
        let EncoderSpec {
            width,
            height,
            fps,
            kbps,
            content,
        } = spec;
        // H.264 4:2:0 needs even dimensions. The frontend's geometry solver already guarantees
        // this; rejecting rather than silently rounding keeps that contract honest.
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
            return None;
        }

        let (usage_type, rate_control_mode) = openh264_mode(content);
        let camera = matches!(content, EncoderContent::Games);

        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(kbps.saturating_mul(1000)))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .usage_type(usage_type)
            .rate_control_mode(rate_control_mode)
            // A periodic IDR bounds how long a late joiner waits for a decodable picture.
            .intra_frame_period(IntraFramePeriod::from_num_frames(fps.max(1) * 2))
            // Both are camera-mode features: openh264 rejects them for screen content and logs a
            // warning on every encoder it builds. So they were never off because they are unwanted,
            // they were off because the text mode cannot have them - and the games mode can.
            .adaptive_quantization(camera)
            .background_detection(camera);

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
    fn encode(&mut self, frame: CapturedFrame<'_>, timestamp_us: u64) -> EncodeOutcome {
        // openh264 takes pixels, not textures. A GPU frame here means the pump paired a zero-copy
        // capture with a software encoder, which `session::start` does not do.
        let Some(frame) = frame.cpu() else {
            return EncodeOutcome::Failed;
        };
        if frame.width() != self.width || frame.height() != self.height {
            // Geometry is fixed for the session; a mismatch means the capture side broke its
            // contract. Encoding it anyway would corrupt the stream, and no retry will fix it.
            return EncodeOutcome::Failed;
        }

        self.yuv.read_rgb(RgbaSliceU8::new(
            frame.as_raw(),
            (self.width as usize, self.height as usize),
        ));

        let Ok(bitstream) = self
            .encoder
            .encode_at(&self.yuv, Timestamp::from_millis(timestamp_us / 1000))
        else {
            return EncodeOutcome::Failed;
        };

        let frame_type = bitstream.frame_type();
        // Skip is rate control doing its job; Invalid means the encoder rejected the input.
        match frame_type {
            FrameType::Skip => return EncodeOutcome::Skipped,
            FrameType::Invalid => return EncodeOutcome::Failed,
            _ => {}
        }

        let data = bitstream.to_vec();
        if data.is_empty() {
            return EncodeOutcome::Skipped;
        }

        EncodeOutcome::Chunk(EncodedChunk {
            data,
            is_keyframe: matches!(frame_type, FrameType::IDR | FrameType::I),
            timestamp_us,
        })
    }

    fn request_keyframe(&mut self) {
        self.encoder.force_intra_frame();
    }

    /// Rebuilt rather than retyped: openh264 fixes geometry at construction and offers no way to
    /// move it.
    ///
    /// <p>Cheap, and safe in a way the hardware path is not - there is no driver object to
    /// destroy, so the crash that forced [`super::encoder_mf`] to park and retype one encoder
    /// forever does not apply here.</p>
    ///
    /// <p>The replacement shares no prediction state with the encoder it replaces, so its first
    /// output must be an IDR or every viewer decodes garbage. openh264 opens on one by itself, and
    /// the pump asks for one as well; between them the SPS/PPS describing the new size reaches the
    /// wire in front of the first frame that needs it.</p>
    fn reconfigure(&mut self, spec: EncoderSpec) -> Result<(), String> {
        // Unconditional, including for a geometry that did not move: bitrate and frame rate are
        // configured at construction here too, so there is no cheaper path to fall into.
        *self = Self::new(spec)
            .ok_or_else(|| format!("could not rebuild openh264 at {}x{}", spec.width, spec.height))?;
        Ok(())
    }

    fn name(&self) -> &'static str {
        "openh264"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mapping the content mode exists to make, asserted directly.
    ///
    /// <p>`matches!` rather than `assert_eq!` because openh264's enums derive neither `PartialEq`
    /// nor `Eq`.</p>
    #[test]
    fn games_encodes_as_camera_video_at_an_even_bitrate() {
        assert!(matches!(
            openh264_mode(EncoderContent::Games),
            (UsageType::CameraVideoRealTime, RateControlMode::Bitrate)
        ));
    }

    /// The half that fixes soft text: screen content, and a quality target rather than a bitrate
    /// one, so a still desktop stops consuming the budget the next scroll needs.
    #[test]
    fn text_encodes_as_screen_content_at_a_quality_target() {
        assert!(matches!(
            openh264_mode(EncoderContent::Text),
            (UsageType::ScreenContentRealTime, RateControlMode::Quality)
        ));
    }
}
