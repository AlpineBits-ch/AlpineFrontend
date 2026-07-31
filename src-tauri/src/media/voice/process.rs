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
        /// The processor wants a mutable buffer, but the render frame belongs to the mixer. Kept as
        /// a field rather than allocated per call: this runs on the audio thread every 10 ms, and
        /// an allocator that stalls there is heard as a dropout.
        render_scratch: Vec<f32>,
    }

    impl Apm {
        pub fn new(config: ProcessConfig) -> Result<Self, String> {
            let inner = Processor::new(SAMPLE_RATE).map_err(|e| e.to_string())?;
            let apm = Self {
                inner,
                render_scratch: vec![0.0; FRAME],
            };
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
            self.render_scratch.copy_from_slice(frame);
            let _ = self
                .inner
                .process_render_frame([&mut self.render_scratch[..]]);
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

    /// Everything above passes against `Passthrough`, which is the point of the boundary - but it
    /// also means they would all keep passing if `create` silently fell back after the APM failed
    /// to initialise, leaving echo cancellation dead. These two assert on behaviour only the real
    /// processor can produce.
    #[cfg(feature = "aec")]
    mod live {
        use super::*;
        use std::collections::VecDeque;

        /// A deterministic LCG. Real noise matters here: a repeating buffer is a periodic signal,
        /// which behaves quite differently through an adaptive filter.
        fn noise_source() -> impl FnMut() -> f32 {
            let mut state: u32 = 0x1234_5678;
            move || {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 8) as f32 / 8_388_608.0) - 1.0
            }
        }

        #[test]
        fn the_high_pass_filter_removes_a_dc_offset() {
            let mut p = create(ProcessConfig::default());
            let mut last = vec![0.0f32; FRAME];
            for _ in 0..50 {
                let mut frame = vec![0.5f32; FRAME];
                p.process_render(&vec![0.0f32; FRAME]);
                p.process_capture(&mut frame);
                last = frame;
            }
            let mean = last.iter().sum::<f32>() / FRAME as f32;
            assert!(
                mean.abs() < 0.05,
                "a constant 0.5 input should have its DC removed, but the mean is still {mean:.4} - \
                 `create` is returning the passthrough rather than the real processor"
            );
        }

        #[test]
        fn echo_from_the_render_stream_is_cancelled() {
            let mut p = create(ProcessConfig {
                echo_cancellation: true,
                // Isolate the echo canceller: noise suppression and gain control would both change
                // the level on their own and muddy what this is measuring.
                noise_suppression: NoiseSuppression::Off,
                auto_gain: false,
            });
            let mut noise = noise_source();
            let mut in_flight: VecDeque<Vec<f32>> = VecDeque::new();
            let (mut echo_energy, mut output_energy) = (0.0f64, 0.0f64);

            // Four seconds. AEC3 adapts to the echo path rather than knowing it, so the measurement
            // window is the tail, once it has converged.
            for i in 0..400 {
                let render: Vec<f32> = (0..FRAME).map(|_| noise() * 0.3).collect();
                p.process_render(&render);
                in_flight.push_back(render);

                // Two frames of loudspeaker-to-microphone delay, attenuated by the room. There is
                // no near-end talker at all, so ideally the output is silence.
                let echo: Vec<f32> = if in_flight.len() > 2 {
                    in_flight.pop_front().unwrap().iter().map(|s| s * 0.5).collect()
                } else {
                    vec![0.0; FRAME]
                };

                let mut capture = echo.clone();
                p.process_capture(&mut capture);

                if i >= 350 {
                    echo_energy += echo.iter().map(|s| (*s as f64).powi(2)).sum::<f64>();
                    output_energy += capture.iter().map(|s| (*s as f64).powi(2)).sum::<f64>();
                }
            }

            // Measured at -27 dB on MSVC/x86-64. The bound is deliberately loose: the SIMD path
            // differs per platform, and this is here to catch "AEC is not running at all" (which
            // reads as 0 dB), not to pin down a number.
            let attenuation_db = 10.0 * (output_energy / echo_energy).log10();
            assert!(
                attenuation_db < -10.0,
                "the echo should be well below the level that reached the microphone, but the \
                 output is only {attenuation_db:.1} dB down"
            );
        }
    }
}
