//! RNNoise denoising, applied the way the model expects.
//!
//! Three things the previous implementation in `media::audio` did are deliberately absent here, and
//! should not come back:
//!
//! 1. **No pre-emphasis / de-emphasis pair.** The old de-emphasis was `y[n] = x[n] + 0.95*y[n-1]`,
//!    a leaky integrator with roughly 26 dB of gain at DC and no bound, so any offset on the
//!    microphone walked the signal off over the course of a call. RNNoise already weights its own
//!    bands; the wrapper bought nothing in exchange for the instability.
//!
//! 2. **No blend with the untouched signal.** RNNoise uses 20 ms windows with 50% overlap-add, so
//!    its output lags its input by one 10 ms frame. The old code mixed 80% denoised with 20% of the
//!    *undelayed* original, summing the signal with a 10 ms-delayed copy of itself: a comb filter
//!    with its first null at 50 Hz and teeth every 100 Hz thereafter. That is what made voices
//!    sound hollow and phasey, and it also put a hard -14 dB ceiling on suppression no matter how
//!    well the model performed.
//!
//! 3. **No gating.** Deciding whether to transmit belongs to [`super::gate`], which owns it alone.

use nnnoiseless::DenoiseState;

use super::FRAME;

pub struct Denoiser {
    state: Box<DenoiseState<'static>>,
    scratch: Vec<f32>,
}

impl Denoiser {
    pub fn new() -> Self {
        Self {
            state: DenoiseState::new(),
            scratch: vec![0.0; FRAME],
        }
    }

    /// Denoise one frame in place, returning RNNoise's voice probability for it.
    ///
    /// A frame of the wrong length passes through untouched: RNNoise's frame size is fixed, and
    /// processing a partial frame would desynchronise its overlap-add state for every frame after.
    pub fn process(&mut self, frame: &mut [f32]) -> f32 {
        if frame.len() != FRAME {
            return 0.0;
        }

        // nnnoiseless works in i16-scaled units rather than normalised floats.
        for (dst, src) in self.scratch.iter_mut().zip(frame.iter()) {
            *dst = src * 32_768.0;
        }

        let mut denoised = [0.0f32; FRAME];
        let probability = self.state.process_frame(&mut denoised, &self.scratch);

        for (dst, src) in frame.iter_mut().zip(denoised.iter()) {
            let value = src / 32_768.0;
            *dst = if value.is_finite() { value } else { 0.0 };
        }

        probability.clamp(0.0, 1.0)
    }
}

impl Default for Denoiser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    /// Deterministic pseudo-random noise generator - no `rand` dependency, and a fixed seed keeps
    /// the assertions reproducible.
    ///
    /// Carries its state across calls on purpose. Re-seeding per frame would emit the *same* 480
    /// samples every time, which is not noise at all but a periodic waveform with harmonics every
    /// 100 Hz - and RNNoise preserves harmonic content, because that is what voice looks like.
    struct Noise(u32);

    impl Noise {
        fn new(seed: u32) -> Self {
            Self(seed)
        }

        fn take(&mut self, len: usize) -> Vec<f32> {
            (0..len)
                .map(|_| {
                    self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (self.0 >> 8) as f32 / 8_388_608.0 - 1.0
                })
                .collect()
        }
    }

    fn noise(len: usize, seed: u32) -> Vec<f32> {
        Noise::new(seed).take(len)
    }

    #[test]
    fn silence_stays_silent() {
        let mut d = Denoiser::new();
        let mut frame = vec![0.0f32; FRAME];
        d.process(&mut frame);
        assert!(frame.iter().all(|s| s.abs() < 1e-3));
    }

    #[test]
    fn output_is_always_finite() {
        let mut d = Denoiser::new();
        let mut frame: Vec<f32> = noise(FRAME, 7).iter().map(|s| s * 0.9).collect();
        d.process(&mut frame);
        assert!(frame.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn the_undelayed_signal_is_never_blended_into_the_output() {
        // The regression test for the 80/20 blend, and the sharpest one available.
        //
        // RNNoise uses 20 ms windows with 50% overlap-add, so its output lags its input by one
        // frame: the very first output frame is essentially empty however loud the input was. The
        // old code mixed 20% of the *undelayed* input back in, which shows up here immediately -
        // and which, frame after frame, summed the signal with a 10 ms-delayed copy of itself.
        //
        // Suppression magnitude deliberately is not asserted. RNNoise is trained on speech plus
        // realistic noise, so a synthetic full-band signal tells you nothing about how well it
        // performs on a real microphone.
        let mut d = Denoiser::new();
        let mut first: Vec<f32> = Noise::new(5).take(FRAME).iter().map(|s| s * 0.8).collect();
        let input_rms = rms(&first);

        d.process(&mut first);
        let leaked = rms(&first);

        assert!(
            leaked < input_rms * 0.1,
            "first frame emitted {leaked:.4} from an input of {input_rms:.4} - that is {:.0}% of \
             the undelayed signal, so it is being blended in",
            100.0 * leaked / input_rms
        );
    }

    #[test]
    fn voice_probability_is_in_range() {
        let mut d = Denoiser::new();
        let mut frame: Vec<f32> = noise(FRAME, 3).iter().map(|s| s * 0.2).collect();
        let p = d.process(&mut frame);
        assert!((0.0..=1.0).contains(&p), "voice probability {p} out of range");
    }

    #[test]
    fn a_wrongly_sized_frame_is_left_alone() {
        let mut d = Denoiser::new();
        let mut frame = vec![0.5f32; 100];
        let p = d.process(&mut frame);
        assert_eq!(p, 0.0);
        assert!(
            frame.iter().all(|&s| s == 0.5),
            "a short frame must pass through untouched"
        );
    }

    #[test]
    fn processing_does_not_introduce_a_dc_offset() {
        // The old de-emphasis filter was a leaky integrator with ~26 dB of DC gain, so any offset
        // on the microphone walked the signal off over time.
        let mut d = Denoiser::new();
        let mut source = Noise::new(11);
        let mut mean = 0.0;
        for _ in 0..100 {
            let mut frame: Vec<f32> = source.take(FRAME).iter().map(|s| s * 0.2 + 0.05).collect();
            d.process(&mut frame);
            mean = frame.iter().sum::<f32>() / frame.len() as f32;
        }
        assert!(mean.abs() < 0.05, "DC offset drifted to {mean}");
    }
}
