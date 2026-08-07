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
        AdaptiveDigital, Config, EchoCanceller, GainController, GainController2, HighPassFilter,
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
                //
                // `adaptive_digital` spelled out rather than left to `GainController2::default()`,
                // which derives to `None` - an gain controller switched on and configured to apply
                // nothing. That is not a hypothetical: it shipped, and the settings toggle moved a
                // -45 dBFS talker by -0.6 dB. It also made every downstream threshold wrong,
                // because the one stage meant to bring a quiet or distant microphone up to a
                // predictable level was never running.
                //
                // The input volume controller stays off. It drives the OS capture slider, and
                // moving a control the user set by hand - system-wide, outside this app - is a
                // bigger claim than a call needs to make.
                gain_controller: config.auto_gain.then(|| {
                    GainController::GainController2(GainController2 {
                        adaptive_digital: Some(AdaptiveDigital::default()),
                        ..Default::default()
                    })
                }),
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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn gain_control_is_configured_to_actually_apply_gain() {
            // `GainController2::default()` derives to `adaptive_digital: None`,
            // `input_volume_controller_enabled: false` and `fixed_digital: 0 dB` - a gain
            // controller switched on and configured to do nothing. That shipped, and it made the
            // settings toggle a no-op: measured, it moved a -45 dBFS talker by -0.6 dB.
            //
            // Asserted on the configuration rather than only through the processor, because the
            // behavioural measurement is not sharp enough to carry this alone: AGC2's adaptive
            // stage tracks what its own speech detector accepts, and on synthetic audio the gain it
            // settles on is not monotonic in the input level. This assertion cannot be fooled by
            // the choice of test signal.
            let config = Apm::to_apm_config(ProcessConfig {
                auto_gain: true,
                ..ProcessConfig::default()
            });
            let Some(GainController::GainController2(agc)) = config.gain_controller else {
                panic!(
                    "gain control is on but no AGC2 was configured: {:?}",
                    config.gain_controller
                );
            };
            assert!(
                agc.adaptive_digital.is_some(),
                "AGC2 is configured but its adaptive digital stage is off, so it applies no gain"
            );
        }

        #[test]
        fn gain_control_off_configures_no_controller() {
            let config = Apm::to_apm_config(ProcessConfig {
                auto_gain: false,
                ..ProcessConfig::default()
            });
            assert!(config.gain_controller.is_none());
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

        /// Frames of a 300 Hz tone at `db` dBFS RMS, in bursts: 250 ms on, 250 ms off.
        ///
        /// AGC2's adaptive stage estimates a *speech* level and aims that at its headroom target,
        /// so it needs a speech-like envelope to estimate from. A continuous tone tells it nothing
        /// about what to aim at, and a test built on one would measure the wrong thing whichever
        /// way it came out.
        fn bursts_at_dbfs(frames: usize, db: f32) -> Vec<Vec<f32>> {
            // A 110 Hz buzz with twenty harmonics falling at 1/n, which is roughly the spectrum of
            // a voiced vowel. A pure sine is not enough: AGC2's adaptive stage only tracks what its
            // own speech detector accepts as speech, and on a single tone that detector fires
            // erratically - measured across five input levels, a sine produced +12.9, +4.5, -0.6,
            // +12.8 and -0.6 dB, which is noise, not a curve.
            let mut raw: Vec<Vec<f32>> = (0..frames)
                .map(|f| {
                    let speaking = (f / 25) % 2 == 0;
                    (0..FRAME)
                        .map(|i| {
                            if !speaking {
                                return 0.0;
                            }
                            let t = (f * FRAME + i) as f32 / SAMPLE_RATE as f32;
                            (1..=20)
                                .map(|h| {
                                    let hz = 110.0 * h as f32;
                                    (t * hz * std::f32::consts::TAU).sin() / h as f32
                                })
                                .sum()
                        })
                        .collect()
                })
                .collect();

            // Scaled after the fact, because the level of a harmonic stack is not something you can
            // write down in advance - and the level is the whole point of the measurement.
            let speaking: Vec<f32> = raw.iter().flatten().copied().filter(|s| *s != 0.0).collect();
            let scale = 10f32.powf(db / 20.0) / rms(&speaking);
            for frame in raw.iter_mut() {
                for sample in frame.iter_mut() {
                    *sample *= scale;
                }
            }
            raw
        }

        fn rms(frame: &[f32]) -> f32 {
            (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt()
        }

        /// Decibels of gain `config` applied to the speaking frames of the final second.
        ///
        /// Six seconds, and only the tail measured, because the adaptive stage moves at a bounded
        /// rate (6 dB/s by default) - a measurement taken while it is still climbing says more about
        /// the ramp than about where it settles.
        fn gain_applied_db(config: ProcessConfig, level_dbfs: f32) -> f32 {
            let mut p = create(config);
            let input = bursts_at_dbfs(600, level_dbfs);
            let silence = vec![0.0f32; FRAME];
            let (mut input_energy, mut output_energy, mut counted) = (0.0f64, 0.0f64, 0u32);

            for (index, frame) in input.iter().enumerate() {
                let mut captured = frame.clone();
                p.process_render(&silence);
                p.process_capture(&mut captured);

                let level = rms(frame);
                // Speaking frames only: the gaps are digital silence, and a ratio taken over them
                // is either zero or a division by zero.
                if index >= 500 && level > 0.0 {
                    input_energy += (level as f64).powi(2);
                    output_energy += (rms(&captured) as f64).powi(2);
                    counted += 1;
                }
            }

            assert!(counted > 0, "no speaking frames fell inside the measurement window");
            (10.0 * (output_energy / input_energy).log10()) as f32
        }

        #[test]
        fn gain_control_lifts_a_quiet_talker() {
            // -55 dBFS: a quiet talker on a low-gain microphone, and the level at which the effect
            // is unambiguous. It is not a monotonic curve on synthetic audio - measured across the
            // range it produced +15.5, +5.5, -2.1, +4.6 and -2.1 dB at -55, -45, -35, -25 and -12
            // dBFS - because AGC2's adaptive stage only tracks what its own speech detector accepts
            // as speech, and a harmonic stack is not a voice. The deterministic guard against the
            // defect this was written for is `gain_control_is_configured_to_actually_apply_gain`,
            // below; this one is here to show the stage is reached and running at all.
            let gain = gain_applied_db(
                ProcessConfig {
                    // Isolated: noise suppression and echo cancellation both move the level on
                    // their own, and either would muddy what this measures.
                    echo_cancellation: false,
                    noise_suppression: NoiseSuppression::Off,
                    auto_gain: true,
                },
                -55.0,
            );
            assert!(
                gain > 6.0,
                "automatic gain control moved a -55 dBFS talker by {gain:.1} dB. \
                 `GainController2::default()` is `adaptive_digital: None`, \
                 `input_volume_controller_enabled: false` and `fixed_digital: 0 dB` - the settings \
                 toggle is wired to a controller that is switched on and configured to do nothing, \
                 so the one stage that would lift a quiet talker to where the gate's threshold \
                 makes sense never runs",
            );
        }

        #[test]
        fn gain_control_leaves_a_healthy_talker_where_they_are() {
            // The other side of the same fix, and the reason it cannot be satisfied with a fixed
            // gain: lifting the quiet must not also drive an already-healthy talker into the
            // limiter. This one passes today, because today nothing moves at all - it is here to
            // stay passing once something does.
            let gain = gain_applied_db(
                ProcessConfig {
                    echo_cancellation: false,
                    noise_suppression: NoiseSuppression::Off,
                    auto_gain: true,
                },
                -12.0,
            );
            assert!(
                gain.abs() < 6.0,
                "a -12 dBFS talker was moved by {gain:.1} dB - gain control should be leaving them \
                 alone, not compressing them"
            );
        }

        /// The isolated processor, with gain control in the given position.
        fn gain_only(auto_gain: bool) -> ProcessConfig {
            ProcessConfig {
                echo_cancellation: false,
                noise_suppression: NoiseSuppression::Off,
                auto_gain,
            }
        }

        #[test]
        fn gain_control_off_adds_no_gain() {
            // Deliberately one-sided. The high-pass filter runs whatever the gain setting is, and
            // it costs this signal about 2 dB by taking out the fundamental - so a symmetric
            // `abs() < 1` here would be asserting that the high-pass does not work. What must not
            // happen with the toggle off is gain being *added*.
            let gain = gain_applied_db(gain_only(false), -55.0);
            assert!(
                gain < 1.0,
                "gain control is switched off but {gain:+.1} dB was applied anyway"
            );
        }

        #[test]
        fn the_gain_control_toggle_changes_the_signal() {
            // Pins the toggle to something observable in both positions. Without this, the tests
            // above could be satisfied by a processor that applies its gain unconditionally - or,
            // as shipped, by one that applies it in neither position.
            let on = gain_applied_db(gain_only(true), -55.0);
            let off = gain_applied_db(gain_only(false), -55.0);
            assert!(
                on - off > 6.0,
                "gain control on and off are indistinguishable: {on:+.1} dB against {off:+.1} dB"
            );
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

