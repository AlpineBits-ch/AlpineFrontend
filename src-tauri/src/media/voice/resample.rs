//! Band-limited sample-rate conversion into the pipeline's 48 kHz mono format.
//!
//! Replaces the linear interpolator in `media::audio`, which had no anti-aliasing filter at all: a
//! 44.1 kHz microphone folded its top octave back down into the voice band. Conversion happens
//! here, at the edges, so no stage downstream has to know a rate other than [`SAMPLE_RATE`].

use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{
    Async, FixedAsync, Indexing, Resampler as _, SincInterpolationParameters, SincInterpolationType,
    WindowFunction,
};

use super::SAMPLE_RATE;

/// Converts a device's sample rate to the pipeline rate, holding filter state across calls.
///
/// Push whatever the device callback delivered; converted samples are appended to `out`. Input is
/// buffered internally, so callers need not deliver any particular chunk size.
pub struct Resampler {
    /// `None` when the rates already match - the common case, and worth not paying for.
    inner: Option<Async<f32>>,
    pending: Vec<f32>,
    scratch: Vec<f32>,
}

impl Resampler {
    /// Convert from `from_hz` into the pipeline rate.
    pub fn new(from_hz: u32) -> Result<Self, String> {
        Self::new_to(from_hz, SAMPLE_RATE)
    }

    /// Convert between two arbitrary rates. The render path uses this to convert the mix down to
    /// whatever the output device asked for.
    pub fn new_to(from_hz: u32, to_hz: u32) -> Result<Self, String> {
        if from_hz == 0 || to_hz == 0 {
            return Err("sample rate must be non-zero".into());
        }
        if from_hz == to_hz {
            return Ok(Self {
                inner: None,
                pending: Vec::new(),
                scratch: Vec::new(),
            });
        }

        // 128-tap sinc with a Blackman2 window: the balanced quality rubato's own documentation
        // recommends. Linear interpolation between taps oversampled 256x is inaudible here and
        // costs far less than cubic.
        let params = SincInterpolationParameters::new(128, WindowFunction::Blackman2)
            .oversampling_factor(256)
            .interpolation(SincInterpolationType::Linear);

        let ratio = to_hz as f64 / from_hz as f64;
        let inner = Async::<f32>::new_sinc(ratio, 1.0, &params, 480, 1, FixedAsync::Output)
            .map_err(|e| e.to_string())?;

        Ok(Self {
            inner: Some(inner),
            pending: Vec::with_capacity(4096),
            scratch: Vec::new(),
        })
    }

    /// Feed input samples, appending every complete output frame to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let Some(resampler) = self.inner.as_mut() else {
            out.extend_from_slice(input);
            return;
        };

        self.pending.extend_from_slice(input);

        loop {
            let needed = resampler.input_frames_next();
            if self.pending.len() < needed {
                break;
            }

            let produced = resampler.output_frames_next();
            self.scratch.resize(produced, 0.0);

            let read = match InterleavedSlice::new(&self.pending[..needed], 1, needed) {
                Ok(adapter) => adapter,
                Err(_) => break,
            };
            let mut write = match InterleavedSlice::new_mut(&mut self.scratch, 1, produced) {
                Ok(adapter) => adapter,
                Err(_) => break,
            };

            let indexing = Indexing::new();
            match resampler.process_into_buffer(&read, &mut write, Some(&indexing)) {
                Ok((consumed, written)) => {
                    out.extend(
                        self.scratch[..written]
                            .iter()
                            .map(|s| if s.is_finite() { *s } else { 0.0 }),
                    );
                    self.pending.drain(..consumed);
                }
                // Bail rather than spin: a conversion failure on this input would repeat forever.
                Err(_) => {
                    self.pending.clear();
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    /// Energy at `freq` in `samples`, via the Goertzel algorithm. Cheaper than pulling in an FFT
    /// just to assert that a tone survived resampling and its aliases did not.
    fn energy_at(samples: &[f32], freq: f32, rate: f32) -> f32 {
        let k = TAU * freq / rate;
        let coeff = 2.0 * k.cos();
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for &x in samples {
            let s0 = x + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        (s1 * s1 + s2 * s2 - coeff * s1 * s2).abs().sqrt() / samples.len() as f32
    }

    fn tone(freq: f32, rate: f32, len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| (TAU * freq * i as f32 / rate).sin() * 0.5)
            .collect()
    }

    #[test]
    fn matching_rate_is_an_identity_passthrough() {
        let mut r = Resampler::new(48_000).unwrap();
        let input = tone(1_000.0, 48_000.0, 960);
        let mut out = Vec::new();
        r.push(&input, &mut out);
        assert_eq!(out, input);
    }

    #[test]
    fn output_length_tracks_the_rate_ratio() {
        let mut r = Resampler::new(24_000).unwrap();
        let input = tone(1_000.0, 24_000.0, 24_000); // one second
        let mut out = Vec::new();
        r.push(&input, &mut out);
        // One second in gives one second out, allowing for the resampler's startup delay.
        assert!(out.len() > 47_000 && out.len() <= 48_500, "got {}", out.len());
    }

    #[test]
    fn a_tone_keeps_its_frequency_across_a_rate_change() {
        let mut r = Resampler::new(44_100).unwrap();
        let input = tone(1_000.0, 44_100.0, 44_100);
        let mut out = Vec::new();
        r.push(&input, &mut out);

        // Skip the startup transient before measuring.
        let steady = &out[4_800..];
        let at_1k = energy_at(steady, 1_000.0, 48_000.0);
        let at_3k = energy_at(steady, 3_000.0, 48_000.0);
        assert!(at_1k > 0.1, "1 kHz tone did not survive: {at_1k}");
        assert!(at_3k < at_1k * 0.01, "spurious energy at 3 kHz: {at_3k} vs {at_1k}");
    }

    #[test]
    fn downsampling_rejects_content_above_the_new_nyquist() {
        // 20 kHz at 48 kHz sits above the 8 kHz Nyquist of a 16 kHz stream. Linear interpolation
        // folded such content down into the voice band; a band-limited resampler must not.
        let mut down = Resampler::new_to(48_000, 16_000).unwrap();
        let input = tone(20_000.0, 48_000.0, 48_000);
        let mut out = Vec::new();
        down.push(&input, &mut out);

        let steady = &out[3_200..];
        // The alias would land at |20000 - 16000| = 4 kHz.
        let alias = energy_at(steady, 4_000.0, 16_000.0);
        assert!(alias < 0.01, "aliased energy at 4 kHz: {alias}");
    }

    #[test]
    fn repeated_pushes_are_continuous() {
        // Feeding one long buffer and feeding the same samples in small chunks must agree: the
        // capture path pushes whatever cpal hands it, which varies from callback to callback.
        let input = tone(1_000.0, 44_100.0, 44_100);

        let mut whole = Resampler::new(44_100).unwrap();
        let mut a = Vec::new();
        whole.push(&input, &mut a);

        let mut chunked = Resampler::new(44_100).unwrap();
        let mut b = Vec::new();
        for chunk in input.chunks(441) {
            chunked.push(chunk, &mut b);
        }

        let n = a.len().min(b.len());
        assert!(n > 40_000, "too little output to compare: {n}");
        for i in 0..n {
            assert!((a[i] - b[i]).abs() < 1e-4, "diverged at {i}: {} vs {}", a[i], b[i]);
        }
    }

    #[test]
    fn output_is_always_finite() {
        let mut r = Resampler::new(44_100).unwrap();
        let input: Vec<f32> = (0..44_100)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let mut out = Vec::new();
        r.push(&input, &mut out);
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn a_zero_rate_is_rejected() {
        assert!(Resampler::new(0).is_err());
        assert!(Resampler::new_to(48_000, 0).is_err());
    }
}
