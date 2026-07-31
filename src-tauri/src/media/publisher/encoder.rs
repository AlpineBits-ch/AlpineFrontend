use image::RgbaImage;

/// One encoded H.264 access unit, in Annex-B byte-stream form.
#[derive(Debug, Clone)]
pub struct EncodedChunk {
    pub data: Vec<u8>,
    pub is_keyframe: bool,
    pub timestamp_us: u64,
}

/// Result of offering one frame to an encoder.
///
/// `Skipped` and `Failed` are deliberately distinct. Rate control legitimately drops frames all the
/// time, so treating every empty result as a fault would send us falling back to software on a
/// perfectly healthy stream. Only `Failed` means the encoder itself is no longer usable.
#[derive(Debug)]
pub enum EncodeOutcome {
    Chunk(EncodedChunk),
    /// No output for this frame, by design. The encoder remains healthy.
    Skipped,
    /// The encoder is broken and will not recover. The caller should replace it.
    Failed,
}

/// Geometry and rate an encoder is built for. Fixed for the life of a session.
#[derive(Debug, Clone, Copy)]
pub struct EncoderSpec {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub kbps: u32,
}

/// A video encoder fed raw captured frames.
///
/// Implementations are stateful (inter-frame prediction), so an instance belongs to one capture
/// session.
pub trait VideoEncoder: Send {
    fn encode(&mut self, frame: &RgbaImage, timestamp_us: u64) -> EncodeOutcome;

    /// Ask for the next frame to be an IDR, e.g. when a new viewer joins or after a fallback.
    fn request_keyframe(&mut self);

    /// Human-readable name of the backing implementation, for logging and diagnostics.
    fn name(&self) -> &'static str;
}

/// Build the hardware encoder for this platform, if one initialises.
fn new_hardware_encoder(spec: EncoderSpec) -> Option<Box<dyn VideoEncoder>> {
    #[cfg(target_os = "windows")]
    {
        return super::encoder_mf::MediaFoundationEncoder::new(spec)
            .map(|e| Box::new(e) as Box<dyn VideoEncoder>);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = spec;
        None
    }
}

fn new_software_encoder(spec: EncoderSpec) -> Option<Box<dyn VideoEncoder>> {
    super::encoder_sw::SoftwareEncoder::new(spec).map(|e| Box::new(e) as Box<dyn VideoEncoder>)
}

/// Build the best available encoder, preferring hardware, and keep software in reserve.
///
/// Returns a [`ResilientEncoder`] so a hardware encoder that dies mid-session - a driver reset, a
/// GPU hang, a laptop switching GPUs when unplugged - degrades to software instead of ending the
/// share.
pub fn new_encoder(spec: EncoderSpec) -> Option<Box<dyn VideoEncoder>> {
    if let Some(hardware) = new_hardware_encoder(spec) {
        eprintln!("[publisher] encoding with {}", hardware.name());
        return Some(Box::new(ResilientEncoder::new(hardware, spec)));
    }

    let software = new_software_encoder(spec)?;
    eprintln!("[publisher] encoding with {} (no hardware encoder available)", software.name());
    Some(software)
}

/// Number of consecutive failures tolerated before swapping the encoder out.
///
/// More than one because a single failure can be a transient driver hiccup, and swapping costs a
/// keyframe; few enough that a genuinely dead encoder is replaced within a fraction of a second.
const FAILURES_BEFORE_FALLBACK: u32 = 3;

/// Wraps a primary encoder and falls back to software if it fails during a session.
pub struct ResilientEncoder {
    active: Box<dyn VideoEncoder>,
    spec: EncoderSpec,
    consecutive_failures: u32,
    /// Once software is active there is nothing further to fall back to.
    exhausted: bool,
}

impl ResilientEncoder {
    pub fn new(active: Box<dyn VideoEncoder>, spec: EncoderSpec) -> Self {
        Self {
            active,
            spec,
            consecutive_failures: 0,
            exhausted: false,
        }
    }

    /// Swap in the software encoder. Returns false if no replacement could be built.
    fn fall_back(&mut self) -> bool {
        if self.exhausted {
            return false;
        }
        self.exhausted = true;

        let Some(mut software) = new_software_encoder(self.spec) else {
            eprintln!("[publisher] hardware encoder failed and no software fallback is available");
            return false;
        };

        // The new encoder shares no prediction state with the old one, so the first frame it emits
        // must be a keyframe or every viewer decodes garbage.
        software.request_keyframe();
        eprintln!(
            "[publisher] {} failed mid-session; falling back to {}",
            self.active.name(),
            software.name()
        );
        self.active = software;
        self.consecutive_failures = 0;
        true
    }
}

impl VideoEncoder for ResilientEncoder {
    fn encode(&mut self, frame: &RgbaImage, timestamp_us: u64) -> EncodeOutcome {
        match self.active.encode(frame, timestamp_us) {
            EncodeOutcome::Chunk(chunk) => {
                self.consecutive_failures = 0;
                EncodeOutcome::Chunk(chunk)
            }
            EncodeOutcome::Skipped => EncodeOutcome::Skipped,
            EncodeOutcome::Failed => {
                self.consecutive_failures += 1;
                if self.consecutive_failures < FAILURES_BEFORE_FALLBACK {
                    return EncodeOutcome::Skipped;
                }
                if !self.fall_back() {
                    return EncodeOutcome::Failed;
                }
                // Retry this frame on the replacement so the swap costs no visible stall.
                self.active.encode(frame, timestamp_us)
            }
        }
    }

    fn request_keyframe(&mut self) {
        self.active.request_keyframe();
    }

    fn name(&self) -> &'static str {
        self.active.name()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Provision Cisco's OpenH264 into the build directory so the encoder can be exercised.
    ///
    /// The first run downloads it (~450 KB) and every run afterwards reuses the cache, so this is
    /// network-dependent exactly once per checkout. It deliberately fails loudly rather than
    /// skipping: a silently-skipped codec test is worse than no test.
    fn provision() {
        if super::super::openh264_blob::ready_path().is_some() {
            return;
        }
        let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-openh264");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime
            .block_on(super::super::openh264_blob::ensure(cache))
            .expect("OpenH264 must be provisioned for encoder tests (needs network on first run)");
    }

    fn spec(width: u32, height: u32) -> EncoderSpec {
        EncoderSpec {
            width,
            height,
            fps: 30,
            kbps: 1000,
        }
    }

    /// A frame with structure, not a flat colour: a flat frame compresses to almost nothing and
    /// makes the keyframe/delta size comparison meaningless.
    fn frame(width: u32, height: u32, shift: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let v = (((x + shift) / 8 + y / 8) % 2) as u8;
            image::Rgba([v * 255, (x % 256) as u8, (y % 256) as u8, 255])
        })
    }

    fn chunk_of(outcome: EncodeOutcome) -> EncodedChunk {
        match outcome {
            EncodeOutcome::Chunk(c) => c,
            other => panic!("expected a chunk, got {other:?}"),
        }
    }

    /// Codec-behaviour tests target the software encoder directly rather than going through
    /// [`new_encoder`].
    ///
    /// Hardware encoders are pipelined - they emit nothing for the first few frames - so
    /// one-in-one-out assertions only hold for openh264. The hardware equivalents live in
    /// `encoder_mf`, which feeds a run of frames before asserting. Routing these through
    /// `new_encoder` would make them pass or fail depending on the machine's GPU.
    fn software(spec: EncoderSpec) -> Box<dyn VideoEncoder> {
        provision();
        new_software_encoder(spec).expect("software encoder must be available")
    }

    #[test]
    fn emits_a_keyframe_first() {
        let mut enc = software(spec(320, 240));
        let chunk = chunk_of(enc.encode(&frame(320, 240, 0), 0));

        assert!(chunk.is_keyframe, "the first encoded frame must be a keyframe");
        assert!(chunk.data.len() > 4);
        assert_eq!(&chunk.data[0..4], &[0, 0, 0, 1], "expected an Annex-B start code");
    }

    #[test]
    fn preserves_the_frame_timestamp() {
        let mut enc = software(spec(320, 240));
        assert_eq!(chunk_of(enc.encode(&frame(320, 240, 0), 123_456)).timestamp_us, 123_456);
    }

    #[test]
    fn a_static_scene_costs_less_after_the_keyframe() {
        let mut enc = software(spec(320, 240));
        let still = frame(320, 240, 0);
        let key = chunk_of(enc.encode(&still, 0));
        let delta = chunk_of(enc.encode(&still, 33_333));

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
        let mut enc = software(spec(320, 240));
        let still = frame(320, 240, 0);
        enc.encode(&still, 0);
        enc.encode(&still, 33_333);

        enc.request_keyframe();
        assert!(chunk_of(enc.encode(&still, 66_666)).is_keyframe);
    }

    #[test]
    fn encodes_odd_looking_but_even_geometries() {
        // Ultrawide and portrait shapes, the ones the old capture path used to distort.
        for (w, h) in [(1920u32, 540u32), (606, 1080)] {
            let mut enc = software(spec(w, h));
            assert!(
                matches!(enc.encode(&frame(w, h, 0), 0), EncodeOutcome::Chunk(_)),
                "{w}x{h} should encode"
            );
        }
    }

    #[test]
    fn selects_an_encoder_and_names_it() {
        provision();
        let enc = new_encoder(spec(640, 360)).expect("an encoder must always be available");
        // Whichever rung of the ladder was picked, it must identify itself - the publisher logs
        // this and it is the first thing worth knowing when a stream looks wrong.
        assert!(
            ["media-foundation", "openh264"].contains(&enc.name()),
            "unexpected encoder name {}",
            enc.name()
        );
    }

    #[test]
    fn a_pipelined_encoder_produces_output_within_a_short_run() {
        // Guards the contract session.rs depends on: whatever encoder is selected, feeding frames
        // steadily must yield encoded output rather than skipping forever.
        provision();
        let mut enc = new_encoder(spec(640, 360)).unwrap();
        let produced = (0..30u64)
            .filter(|i| matches!(enc.encode(&frame(640, 360, *i as u32), i * 33_333), EncodeOutcome::Chunk(_)))
            .count();
        assert!(produced > 0, "no output from {} over 30 frames", enc.name());
    }

    // ── Mid-session fallback ──────────────────────────────────────────────────

    /// Fails after `healthy_frames` successful frames, simulating a driver reset mid-stream.
    struct FlakyEncoder {
        healthy_frames: u32,
        encoded: u32,
        keyframe_requested: bool,
    }

    impl VideoEncoder for FlakyEncoder {
        fn encode(&mut self, _frame: &RgbaImage, timestamp_us: u64) -> EncodeOutcome {
            if self.encoded >= self.healthy_frames {
                return EncodeOutcome::Failed;
            }
            self.encoded += 1;
            EncodeOutcome::Chunk(EncodedChunk {
                data: vec![0, 0, 0, 1, 0x65],
                is_keyframe: self.encoded == 1,
                timestamp_us,
            })
        }

        fn request_keyframe(&mut self) {
            self.keyframe_requested = true;
        }

        fn name(&self) -> &'static str {
            "flaky"
        }
    }

    fn flaky(healthy_frames: u32) -> Box<dyn VideoEncoder> {
        Box::new(FlakyEncoder {
            healthy_frames,
            encoded: 0,
            keyframe_requested: false,
        })
    }

    #[test]
    fn tolerates_isolated_failures_without_falling_back() {
        provision();
        let mut enc = ResilientEncoder::new(flaky(1), spec(320, 240));
        let still = frame(320, 240, 0);

        enc.encode(&still, 0);
        // Below the threshold, a failure is reported as a skip and the encoder is kept.
        for i in 1..FAILURES_BEFORE_FALLBACK {
            assert!(matches!(enc.encode(&still, i as u64 * 1000), EncodeOutcome::Skipped));
            assert_eq!(enc.name(), "flaky", "must not swap on a transient failure");
        }
    }

    #[test]
    fn falls_back_to_software_after_repeated_failures() {
        provision();
        let mut enc = ResilientEncoder::new(flaky(1), spec(320, 240));
        let still = frame(320, 240, 0);

        enc.encode(&still, 0);
        for i in 0..FAILURES_BEFORE_FALLBACK {
            enc.encode(&still, (i as u64 + 1) * 1000);
        }

        assert_eq!(enc.name(), "openh264", "must have swapped to the software encoder");
    }

    #[test]
    fn the_first_frame_after_a_fallback_is_a_keyframe() {
        provision();
        let mut enc = ResilientEncoder::new(flaky(1), spec(320, 240));
        let still = frame(320, 240, 0);

        enc.encode(&still, 0);
        let mut outcome = EncodeOutcome::Skipped;
        for i in 0..FAILURES_BEFORE_FALLBACK {
            outcome = enc.encode(&still, (i as u64 + 1) * 1000);
        }

        // The replacement shares no prediction state with the dead encoder, so anything but a
        // keyframe would decode as garbage on every viewer.
        assert!(chunk_of(outcome).is_keyframe);
    }

    #[test]
    fn a_healthy_frame_resets_the_failure_count() {
        provision();
        // Healthy for two frames, so the failures either side never accumulate to the threshold.
        let mut enc = ResilientEncoder::new(flaky(2), spec(320, 240));
        let still = frame(320, 240, 0);

        enc.encode(&still, 0);
        enc.encode(&still, 1000);
        assert_eq!(enc.name(), "flaky");
    }

    #[test]
    fn reports_failure_when_no_fallback_remains() {
        // Software cannot fall back to anything, so a dead software encoder surfaces as Failed
        // rather than silently swallowing frames forever.
        let mut enc = ResilientEncoder::new(flaky(0), spec(320, 240));
        enc.exhausted = true;
        let still = frame(320, 240, 0);

        let mut outcome = EncodeOutcome::Skipped;
        for i in 0..FAILURES_BEFORE_FALLBACK {
            outcome = enc.encode(&still, i as u64 * 1000);
        }
        assert!(matches!(outcome, EncodeOutcome::Failed));
    }
}
