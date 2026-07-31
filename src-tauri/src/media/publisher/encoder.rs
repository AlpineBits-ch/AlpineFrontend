use image::RgbaImage;

/// One encoded H.264 access unit, in Annex-B byte-stream form.
#[derive(Debug, Clone)]
pub struct EncodedChunk {
    pub data: Vec<u8>,
    pub is_keyframe: bool,
    pub timestamp_us: u64,
}

/// A video encoder fed raw captured frames.
///
/// Implementations are expected to be stateful (inter-frame prediction), so a single instance
/// belongs to a single capture session and is not shareable across threads without ownership.
pub trait VideoEncoder: Send {
    /// Encode one frame. Returns `None` when the encoder deliberately skipped it (rate control) or
    /// produced no output for this input.
    fn encode(&mut self, frame: &RgbaImage, timestamp_us: u64) -> Option<EncodedChunk>;

    /// Ask for the next frame to be an IDR, e.g. when a new viewer joins.
    fn request_keyframe(&mut self);

    /// Human-readable name of the backing implementation.
    ///
    /// Which encoder was selected is the first thing worth knowing when a stream looks wrong, so
    /// the publishing layer logs this on session start.
    #[allow(dead_code, reason = "consumed by the publishing layer, which is not built yet")]
    fn name(&self) -> &'static str;
}

/// Build the best available encoder for the given output geometry and target rate.
///
/// Windows gets the Media Foundation hardware encoder when it initialises; every other platform,
/// and Windows machines without a usable hardware encoder, fall back to openh264 in software.
pub fn new_encoder(width: u32, height: u32, fps: u32, kbps: u32) -> Option<Box<dyn VideoEncoder>> {
    super::encoder_sw::SoftwareEncoder::new(width, height, fps, kbps)
        .map(|e| Box::new(e) as Box<dyn VideoEncoder>)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame with structure, not a flat colour: a flat frame compresses to almost nothing and
    /// makes the keyframe/delta size comparison meaningless.
    fn frame(width: u32, height: u32, shift: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let v = (((x + shift) / 8 + y / 8) % 2) as u8;
            image::Rgba([v * 255, (x % 256) as u8, (y % 256) as u8, 255])
        })
    }

    #[test]
    fn emits_a_keyframe_first() {
        let mut enc = new_encoder(320, 240, 30, 1000).expect("software encoder must be available");
        let chunk = enc.encode(&frame(320, 240, 0), 0).expect("first frame must encode");

        assert!(chunk.is_keyframe, "the first encoded frame must be a keyframe");
        assert!(chunk.data.len() > 4);
        assert_eq!(&chunk.data[0..4], &[0, 0, 0, 1], "expected an Annex-B start code");
    }

    #[test]
    fn preserves_the_frame_timestamp() {
        let mut enc = new_encoder(320, 240, 30, 1000).unwrap();
        let chunk = enc.encode(&frame(320, 240, 0), 123_456).unwrap();
        assert_eq!(chunk.timestamp_us, 123_456);
    }

    #[test]
    fn a_static_scene_costs_less_after_the_keyframe() {
        let mut enc = new_encoder(320, 240, 30, 1000).unwrap();
        let still = frame(320, 240, 0);
        let key = enc.encode(&still, 0).unwrap();
        let delta = enc.encode(&still, 33_333).unwrap();

        assert!(!delta.is_keyframe, "an unchanged frame should not force a new keyframe");
        assert!(
            delta.data.len() < key.data.len(),
            "delta ({}) should be smaller than the keyframe ({})",
            delta.data.len(),
            key.data.len()
        );
    }

    #[test]
    fn request_keyframe_forces_an_idr() {
        let mut enc = new_encoder(320, 240, 30, 1000).unwrap();
        let still = frame(320, 240, 0);
        enc.encode(&still, 0).unwrap();
        enc.encode(&still, 33_333).unwrap();

        enc.request_keyframe();
        let forced = enc.encode(&still, 66_666).expect("forced frame must encode");
        assert!(forced.is_keyframe, "request_keyframe must produce an IDR");
    }

    #[test]
    fn encodes_odd_looking_but_even_geometries() {
        // Ultrawide and portrait shapes, the ones the old capture path used to distort.
        for (w, h) in [(1920u32, 540u32), (606, 1080)] {
            let mut enc = new_encoder(w, h, 30, 4000).unwrap();
            let chunk = enc.encode(&frame(w, h, 0), 0);
            assert!(chunk.is_some(), "{w}x{h} should encode");
        }
    }
}
