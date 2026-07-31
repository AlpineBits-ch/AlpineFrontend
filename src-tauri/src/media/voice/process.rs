//! The echo-cancellation, noise-suppression and gain-control boundary.
//!
//! Behind a trait for two reasons. The real implementation wraps WebRTC's AudioProcessing module,
//! which is C++ and needs meson at build time - so a machine without that toolchain builds the
//! passthrough instead and loses echo cancellation rather than losing voice. And the boundary makes
//! the surrounding pipeline testable without the C++ library present at all.
//!
//! The render side is fed the mixer's own output. Rust renders the mix, so that is a more accurate
//! echo reference than device loopback: no extra capture latency, and no other application's audio
//! mixed into it. The trade-off, shared with Chrome and Discord, is that audio played by *other*
//! applications through the same speakers is not cancelled.

use super::FRAME;
#[cfg(feature = "aec")]
use super::SAMPLE_RATE;

/// Mirrors the three settings the UI offers. The names describe intent, not implementation.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NoiseSuppression {
    /// High-pass only: remove rumble, touch nothing else.
    Off,
    /// Steady background noise - fans, hum, air conditioning.
    Standard,
    /// Adds the RNNoise stage on top, for irregular noise like keyboards and chatter.
    Enhanced,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ProcessConfig {
    pub echo_cancellation: bool,
    pub noise_suppression: NoiseSuppression,
    pub auto_gain: bool,
}

impl Default for ProcessConfig {
    fn default() -> Self {
        Self {
            echo_cancellation: true,
            noise_suppression: NoiseSuppression::Standard,
            auto_gain: true,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CaptureInfo {
    /// The processor's own voice-activity estimate, 0.0-1.0. Zero when unavailable.
    pub voice_probability: f32,
}

pub trait AudioProcessor: Send {
    /// Process one captured frame in place. A frame of the wrong length is left untouched.
    fn process_capture(&mut self, frame: &mut [f32]) -> CaptureInfo;

    /// Supply one frame of what is about to be played, as the echo reference.
    fn process_render(&mut self, frame: &[f32]);

    fn set_config(&mut self, config: ProcessConfig);
}

/// The no-op processor, used when the `aec` feature is off or the APM fails to initialise.
#[derive(Default)]
pub struct Passthrough;

impl AudioProcessor for Passthrough {
    fn process_capture(&mut self, _frame: &mut [f32]) -> CaptureInfo {
        CaptureInfo {
            voice_probability: 0.0,
        }
    }

    fn process_render(&mut self, _frame: &[f32]) {}

    fn set_config(&mut self, _config: ProcessConfig) {}
}

/// Build the best processor available in this build.
pub fn create(config: ProcessConfig) -> Box<dyn AudioProcessor> {
    #[cfg(feature = "aec")]
    {
        match apm::Apm::new(config) {
            Ok(processor) => return Box::new(processor),
            Err(e) => {
                // Worth saying out loud: the call still works, but without echo cancellation, and
                // that is a large enough quality difference to be worth diagnosing.
                eprintln!("[voice] audio processing unavailable, echo cancellation is off: {e}");
            }
        }
    }
    let _ = config;
    let _ = FRAME;
    Box::new(Passthrough)
}

#[cfg(feature = "aec")]
mod apm {
    use webrtc_audio_processing::config::{
        Config, EchoCanceller, GainController, GainController2, HighPassFilter,
        NoiseSuppression as ApmNoiseSuppression, NoiseSuppressionLevel,
    };
    use webrtc_audio_processing::Processor;

    use super::{AudioProcessor, CaptureInfo, NoiseSuppression, ProcessConfig, FRAME, SAMPLE_RATE};

    pub struct Apm {
        inner: Processor,
    }

    impl Apm {
        pub fn new(config: ProcessConfig) -> Result<Self, String> {
            let inner = Processor::new(SAMPLE_RATE).map_err(|e| e.to_string())?;
            let apm = Self { inner };
            apm.inner.set_config(Self::to_apm_config(config));
            Ok(apm)
        }

        fn to_apm_config(config: ProcessConfig) -> Config {
            Config {
                // Rumble and handling noise sit below the voice band and cost bits to encode.
                // Strongly recommended by upstream whenever echo cancellation is on.
                high_pass_filter: Some(HighPassFilter {
                    apply_in_full_band: true,
                }),
                // AEC3, with the delay estimated adaptively - we render the mix ourselves, but the
                // output device's own buffering still sits between us and the speaker.
                echo_canceller: config
                    .echo_cancellation
                    .then_some(EchoCanceller::Full {
                        stream_delay_ms: None,
                    }),
                noise_suppression: match config.noise_suppression {
                    NoiseSuppression::Off => None,
                    // Enhanced layers RNNoise on top of this rather than replacing it; see
                    // `super::super::denoise`.
                    NoiseSuppression::Standard | NoiseSuppression::Enhanced => {
                        Some(ApmNoiseSuppression {
                            level: NoiseSuppressionLevel::Moderate,
                            ..Default::default()
                        })
                    }
                },
                // AGC2 rather than AGC1: adaptive digital gain, which is what a software pipeline
                // with no analogue mixer control should use.
                gain_controller: config
                    .auto_gain
                    .then(|| GainController::GainController2(GainController2::default())),
                ..Default::default()
            }
        }
    }

    impl AudioProcessor for Apm {
        fn process_capture(&mut self, frame: &mut [f32]) -> CaptureInfo {
            // The processor panics rather than erroring on a wrongly sized frame, so the length is
            // checked here instead of relying on it.
            if frame.len() != FRAME {
                return CaptureInfo {
                    voice_probability: 0.0,
                };
            }
            if self.inner.process_capture_frame([&mut frame[..]]).is_err() {
                return CaptureInfo {
                    voice_probability: 0.0,
                };
            }
            CaptureInfo {
                // AEC3 exposes echo metrics rather than a voice flag; voice activity comes from
                // RNNoise and the gate instead.
                voice_probability: 0.0,
            }
        }

        fn process_render(&mut self, frame: &[f32]) {
            if frame.len() != FRAME {
                return;
            }
            let mut scratch = frame.to_vec();
            let _ = self.inner.process_render_frame([&mut scratch[..]]);
        }

        fn set_config(&mut self, config: ProcessConfig) {
            self.inner.set_config(Self::to_apm_config(config));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_leaves_samples_untouched() {
        let mut p = Passthrough;
        let original: Vec<f32> = (0..FRAME)
            .map(|i| (i as f32 / FRAME as f32) - 0.5)
            .collect();
        let mut frame = original.clone();
        p.process_capture(&mut frame);
        assert_eq!(frame, original);
    }

    #[test]
    fn passthrough_reports_no_voice_probability() {
        let mut p = Passthrough;
        let mut frame = vec![0.5f32; FRAME];
        let info = p.process_capture(&mut frame);
        assert_eq!(info.voice_probability, 0.0);
    }

    #[test]
    fn passthrough_accepts_a_render_frame() {
        let mut p = Passthrough;
        p.process_render(&vec![0.25f32; FRAME]);
    }

    #[test]
    fn create_returns_a_usable_processor() {
        // Whichever implementation this resolves to, a frame must survive it finite and intact in
        // length. That is the contract the capture thread relies on.
        let mut p = create(ProcessConfig::default());
        let mut frame = vec![0.1f32; FRAME];
        let info = p.process_capture(&mut frame);
        assert_eq!(frame.len(), FRAME);
        assert!(frame.iter().all(|s| s.is_finite()));
        assert!((0.0..=1.0).contains(&info.voice_probability));
    }

    #[test]
    fn create_survives_a_full_second_of_frames() {
        let mut p = create(ProcessConfig::default());
        for _ in 0..100 {
            let mut capture = vec![0.05f32; FRAME];
            p.process_render(&vec![0.02f32; FRAME]);
            p.process_capture(&mut capture);
            assert!(capture.iter().all(|s| s.is_finite()));
        }
    }

    #[test]
    fn config_can_change_mid_session() {
        let mut p = create(ProcessConfig::default());
        p.set_config(ProcessConfig {
            echo_cancellation: false,
            noise_suppression: NoiseSuppression::Off,
            auto_gain: false,
        });
        let mut frame = vec![0.1f32; FRAME];
        p.process_capture(&mut frame);
        assert!(frame.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn a_wrongly_sized_frame_is_left_alone() {
        let mut p = create(ProcessConfig::default());
        let mut frame = vec![0.5f32; 37];
        p.process_capture(&mut frame);
        assert_eq!(frame.len(), 37);
        assert!(frame.iter().all(|&s| s == 0.5));
    }
}
