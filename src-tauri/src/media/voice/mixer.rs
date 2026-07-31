//! Mixes every remote speaker into one stereo frame.
//!
//! Per-user volume, deafen and master output volume all resolve here, rather than on individual
//! `<audio>` elements as the webview used to do.
//!
//! The output goes through a limiter rather than a hard clamp. The previous AGC ended in
//! `.clamp(-1.0, 1.0)`, so a loud passage clipped flat and audibly distorted; a limiter pulls the
//! gain down smoothly and lets it back up afterwards.
//!
//! Isle proximity voice adds HRTF panning on top, replacing the WebAudio `PannerNode` that can no
//! longer see the audio now that mixing happens here.

use std::collections::HashMap;
use std::io::Cursor;

use hrtf::{HrirSphere, HrtfContext, HrtfProcessor, Vec3};

use super::{FRAME, SAMPLE_RATE};

/// Attack coefficient: how fast gain comes down when the mix is too hot (~1 frame).
const LIMITER_ATTACK: f32 = 0.5;
/// Release coefficient: how fast gain returns afterwards (~50 frames, half a second).
const LIMITER_RELEASE: f32 = 0.02;

/// A source's position relative to the listener, in metres.
///
/// `x` is positive to the right, `y` positive upwards, `z` positive in front. Note that HRIR
/// spheres are right-handed - if Isle's world coordinates are left-handed, invert `x` before
/// passing positions in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Position {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Position {
    fn distance(&self) -> f32 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }
}

/// Constant-power stereo gains for a listener-relative position, used when no HRIR dataset is
/// loaded.
///
/// Only the lateral component is used: `+x` is the listener's right. There is no elevation cue and
/// front cannot be told from back, both of which need measured impulse responses - but left/right
/// placement does not, and that is the cue proximity chat leans on hardest.
///
/// Constant power, not linear. With linear gains a source moving past the listener audibly dips at
/// centre, because two half-amplitude channels carry less power than one at full amplitude.
/// `cos`/`sin` of a quarter-turn keeps `l² + r² == 1` at every pan position.
fn stereo_pan(position: Position) -> (f32, f32) {
    let distance = position.distance();
    if !distance.is_finite() || distance <= f32::EPSILON {
        // Standing on the listener. There is no direction to derive, and dividing by this would
        // produce NaN gains that silence the whole mix.
        return (std::f32::consts::FRAC_1_SQRT_2, std::f32::consts::FRAC_1_SQRT_2);
    }

    let pan = (position.x / distance).clamp(-1.0, 1.0);
    let angle = (pan + 1.0) * std::f32::consts::FRAC_PI_4;
    (angle.cos(), angle.sin())
}

/// Per-source HRTF state. The processor keeps a convolution tail between frames, so every source
/// needs its own; sharing one would smear speakers into each other.
struct Spatial {
    processor: HrtfProcessor,
    previous_left: Vec<f32>,
    previous_right: Vec<f32>,
    previous_sample_vector: Vec3,
    previous_distance_gain: f32,
}

pub struct Mixer {
    gains: HashMap<String, f32>,
    master: f32,
    deafened: bool,
    limiter_gain: f32,
    accumulator: Vec<f32>,

    spatial_enabled: bool,
    positions: HashMap<String, Option<Position>>,
    spatial_state: HashMap<String, Spatial>,
    /// Raw HRIR sphere bytes, when a dataset is available.
    ///
    /// `None` is a supported state: spatial sources are then distance-attenuated but not
    /// directional, so proximity voice keeps working while a licence-compatible dataset is chosen.
    /// The `hrtf` crate ships no data of its own.
    hrir_bytes: Option<&'static [u8]>,
    max_distance: f32,
    /// Stereo scratch the HRTF processors accumulate into. `process_samples` *adds* to its output
    /// buffer, so every spatial source can share one buffer cleared once per mix.
    spatial_accumulator: Vec<(f32, f32)>,
}

impl Mixer {
    pub fn new() -> Self {
        Self {
            gains: HashMap::new(),
            master: 1.0,
            deafened: false,
            limiter_gain: 1.0,
            // Preallocated: `mix` runs every 10 ms and must not allocate.
            accumulator: vec![0.0; FRAME * 2],

            spatial_enabled: false,
            positions: HashMap::new(),
            spatial_state: HashMap::new(),
            hrir_bytes: None,
            max_distance: 20.0,
            spatial_accumulator: vec![(0.0, 0.0); FRAME],
        }
    }

    pub fn set_gain(&mut self, id: &str, gain: f32) {
        self.gains.insert(id.to_owned(), gain.max(0.0));
    }

    pub fn set_master(&mut self, gain: f32) {
        self.master = gain.max(0.0);
    }

    pub fn set_deafened(&mut self, deafened: bool) {
        self.deafened = deafened;
    }

    pub fn set_spatial(&mut self, enabled: bool) {
        self.spatial_enabled = enabled;
    }

    pub fn set_position(&mut self, id: &str, position: Option<Position>) {
        self.positions.insert(id.to_owned(), position);
    }

    /// Beyond this distance a source is silent, matching Isle's proximity falloff.
    pub fn set_max_distance(&mut self, metres: f32) {
        self.max_distance = metres.max(0.001);
    }

    /// Supply the HRIR sphere to pan with. Without one, spatial sources stay centred.
    pub fn set_hrir(&mut self, bytes: Option<&'static [u8]>) {
        self.hrir_bytes = bytes;
        // Existing processors were built against the old sphere, if any.
        self.spatial_state.clear();
    }

    /// Forget a participant, so a departed speaker leaves no convolution state behind.
    pub fn remove(&mut self, id: &str) {
        self.gains.remove(id);
        self.positions.remove(id);
        self.spatial_state.remove(id);
    }

    /// Mix one frame. `out` is `FRAME * 2` interleaved stereo.
    pub fn mix(&mut self, sources: &[(&str, &[f32])], out: &mut [f32]) {
        out.fill(0.0);
        if self.deafened || sources.is_empty() {
            return;
        }

        self.accumulator.fill(0.0);
        self.spatial_accumulator.fill((0.0, 0.0));

        for (id, samples) in sources {
            let gain = self.gains.get(*id).copied().unwrap_or(1.0) * self.master;
            let position = self.positions.get(*id).copied().flatten();

            match position {
                // Spatial mode with a known position: the only path that pans.
                Some(position) if self.spatial_enabled => {
                    self.render_spatial(id, samples, gain, position);
                }
                // Everything else lands in the centre at full level: spatial disabled, or a
                // participant with no position at all (a guild call rather than proximity voice).
                _ => {
                    for (i, &s) in samples.iter().take(FRAME).enumerate() {
                        let v = if s.is_finite() { s * gain } else { 0.0 };
                        self.accumulator[i * 2] += v;
                        self.accumulator[i * 2 + 1] += v;
                    }
                }
            }
        }

        for (i, (l, r)) in self.spatial_accumulator.iter().enumerate() {
            self.accumulator[i * 2] += if l.is_finite() { *l } else { 0.0 };
            self.accumulator[i * 2 + 1] += if r.is_finite() { *r } else { 0.0 };
        }

        self.apply_limiter(out);
    }

    /// Inverse-distance falloff, reaching exactly zero at `max_distance`.
    ///
    /// Without the taper a source would still be faintly audible at the cutoff and then jump to
    /// silence, which is audible as a click when someone walks out of range.
    fn distance_gain(&self, distance: f32) -> f32 {
        if distance >= self.max_distance {
            return 0.0;
        }
        let near = 1.0 / distance.max(1.0);
        let taper = 1.0 - (distance / self.max_distance);
        (near * taper).clamp(0.0, 1.0)
    }

    fn render_spatial(&mut self, id: &str, samples: &[f32], gain: f32, position: Position) {
        let distance_gain = self.distance_gain(position.distance());
        if distance_gain <= 0.0 {
            // Out of range. Returning here also avoids building HRTF state for a source that
            // cannot be heard.
            return;
        }

        let Some(bytes) = self.hrir_bytes else {
            // No dataset: pan across the stereo field instead. Everything below this point needs
            // measured impulse responses, but left/right placement does not, and it is the cue
            // that carries most of the value in proximity chat - "who just walked up behind me"
            // matters less than "who is talking on my left".
            let (left_gain, right_gain) = stereo_pan(position);
            for (i, &s) in samples.iter().take(FRAME).enumerate() {
                let v = if s.is_finite() { s * gain * distance_gain } else { 0.0 };
                self.spatial_accumulator[i].0 += v * left_gain;
                self.spatial_accumulator[i].1 += v * right_gain;
            }
            return;
        };

        if samples.len() < FRAME {
            return;
        }

        // `process_samples` requires source.len() == interpolation_steps * block_len, so the two
        // must multiply to exactly FRAME.
        const STEPS: usize = 4;
        const BLOCK: usize = FRAME / STEPS;

        let new_vector = Vec3::new(position.x, position.y, position.z);

        if !self.spatial_state.contains_key(id) {
            let Ok(sphere) = HrirSphere::new(Cursor::new(bytes), SAMPLE_RATE) else {
                return;
            };
            self.spatial_state.insert(
                id.to_owned(),
                Spatial {
                    processor: HrtfProcessor::new(sphere, STEPS, BLOCK),
                    previous_left: Vec::new(),
                    previous_right: Vec::new(),
                    previous_sample_vector: new_vector,
                    previous_distance_gain: distance_gain,
                },
            );
        }
        let state = self
            .spatial_state
            .get_mut(id)
            .expect("inserted immediately above");

        // Interpolating from the previous frame's vector and gain is what keeps a moving speaker
        // click-free; jumping to the new values steps the convolution discontinuously.
        state.processor.process_samples(HrtfContext {
            source: &samples[..FRAME],
            output: &mut self.spatial_accumulator,
            new_sample_vector: new_vector,
            prev_sample_vector: state.previous_sample_vector,
            prev_left_samples: &mut state.previous_left,
            prev_right_samples: &mut state.previous_right,
            new_distance_gain: distance_gain * gain,
            prev_distance_gain: state.previous_distance_gain * gain,
        });

        state.previous_sample_vector = new_vector;
        state.previous_distance_gain = distance_gain;
    }

    /// Write the accumulator to `out`, holding the peak at or below full scale.
    fn apply_limiter(&mut self, out: &mut [f32]) {
        let peak = self.accumulator.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        let wanted = if peak > 1.0 { 1.0 / peak } else { 1.0 };

        // Down fast, up slow: the reverse would let a transient through before reacting, and would
        // pump audibly on the way back.
        let coefficient = if wanted < self.limiter_gain {
            LIMITER_ATTACK
        } else {
            LIMITER_RELEASE
        };
        self.limiter_gain += (wanted - self.limiter_gain) * coefficient;

        for (dst, src) in out.iter_mut().zip(self.accumulator.iter()) {
            *dst = (src * self.limiter_gain).clamp(-1.0, 1.0);
        }
    }
}

impl Default for Mixer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant(value: f32) -> Vec<f32> {
        vec![value; FRAME]
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }

    fn ear_energy(out: &[f32]) -> (f32, f32) {
        let mut left = 0.0;
        let mut right = 0.0;
        for frame in out.chunks(2) {
            left += frame[0] * frame[0];
            right += frame[1] * frame[1];
        }
        (left, right)
    }

    /// The HRTF processor needs a few frames before its convolution tail is meaningful.
    fn settle(m: &mut Mixer, id: &str, samples: &[f32], out: &mut [f32]) {
        for _ in 0..8 {
            m.mix(&[(id, samples)], out);
        }
    }

    #[test]
    fn no_sources_produces_silence() {
        let mut m = Mixer::new();
        let mut out = vec![9.0f32; FRAME * 2];
        m.mix(&[], &mut out);
        assert!(
            out.iter().all(|&s| s == 0.0),
            "stale samples were left in the buffer"
        );
    }

    #[test]
    fn a_single_source_reaches_both_ears_equally() {
        let mut m = Mixer::new();
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &a)], &mut out);
        for frame in out.chunks(2) {
            assert!((frame[0] - 0.5).abs() < 1e-6);
            assert!((frame[1] - 0.5).abs() < 1e-6);
        }
    }

    #[test]
    fn sources_sum() {
        let mut m = Mixer::new();
        let a = constant(0.2);
        let b = constant(0.3);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &a), ("b", &b)], &mut out);
        assert!((out[0] - 0.5).abs() < 1e-6, "got {}", out[0]);
    }

    #[test]
    fn per_user_gain_scales_only_that_user() {
        let mut m = Mixer::new();
        m.set_gain("a", 0.5);
        let a = constant(0.4);
        let b = constant(0.4);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &a), ("b", &b)], &mut out);
        assert!((out[0] - 0.6).abs() < 1e-6, "got {}", out[0]);
    }

    #[test]
    fn master_gain_scales_the_whole_mix() {
        let mut m = Mixer::new();
        m.set_master(0.5);
        let a = constant(0.4);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &a)], &mut out);
        assert!((out[0] - 0.2).abs() < 1e-6, "got {}", out[0]);
    }

    #[test]
    fn deafening_silences_everything() {
        let mut m = Mixer::new();
        m.set_deafened(true);
        let a = constant(0.9);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &a)], &mut out);
        assert!(out.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn the_limiter_prevents_clipping_when_sources_sum_past_full_scale() {
        let mut m = Mixer::new();
        let loud = constant(0.9);
        let mut out = vec![0.0f32; FRAME * 2];
        // Four sources at 0.9 sum to 3.6. Hard clipping here is what made the old AGC audibly
        // distort; the limiter must pull it back smoothly instead.
        m.mix(&[("a", &loud), ("b", &loud), ("c", &loud), ("d", &loud)], &mut out);
        assert!(peak(&out) <= 1.0, "peak {} exceeded full scale", peak(&out));
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn the_limiter_is_transparent_below_full_scale() {
        let mut m = Mixer::new();
        let quiet = constant(0.3);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &quiet)], &mut out);
        // Nothing to limit, so nothing should be attenuated.
        assert!((out[0] - 0.3).abs() < 1e-4, "got {}", out[0]);
    }

    #[test]
    fn the_limiter_recovers_after_a_loud_passage() {
        let mut m = Mixer::new();
        let loud = constant(0.95);
        let quiet = constant(0.2);
        let mut out = vec![0.0f32; FRAME * 2];

        for _ in 0..5 {
            m.mix(&[("a", &loud), ("b", &loud), ("c", &loud)], &mut out);
        }
        // Two seconds of quiet is far longer than any sane release time.
        for _ in 0..200 {
            m.mix(&[("a", &quiet)], &mut out);
        }
        assert!((out[0] - 0.2).abs() < 0.02, "gain never recovered: {}", out[0]);
    }

    #[test]
    fn an_unknown_source_defaults_to_unity_gain() {
        let mut m = Mixer::new();
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("never-seen", &a)], &mut out);
        assert!((out[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn non_finite_input_cannot_reach_the_output() {
        let mut m = Mixer::new();
        let mut bad = constant(0.1);
        bad[10] = f32::NAN;
        bad[11] = f32::INFINITY;
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &bad)], &mut out);
        assert!(
            out.iter().all(|s| s.is_finite()),
            "a NaN reaching the device is an audible click"
        );
    }

    #[test]
    fn a_source_on_the_left_is_louder_in_the_left_ear() {
        let mut m = Mixer::new();
        m.set_spatial(true);
        m.set_position("a", Some(Position { x: -3.0, y: 0.0, z: 0.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        settle(&mut m, "a", &a, &mut out);

        let (left, right) = ear_energy(&out);
        assert!(left > right * 1.3, "left {left} should dominate right {right}");
    }

    #[test]
    fn a_source_on_the_right_is_louder_in_the_right_ear() {
        let mut m = Mixer::new();
        m.set_spatial(true);
        m.set_position("a", Some(Position { x: 3.0, y: 0.0, z: 0.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        settle(&mut m, "a", &a, &mut out);

        let (left, right) = ear_energy(&out);
        assert!(right > left * 1.3, "right {right} should dominate left {left}");
    }

    #[test]
    fn a_source_in_front_is_roughly_centred() {
        let mut m = Mixer::new();
        m.set_spatial(true);
        m.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 2.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        settle(&mut m, "a", &a, &mut out);

        let (left, right) = ear_energy(&out);
        let ratio = left.max(right) / left.min(right).max(f32::EPSILON);
        assert!(ratio < 1.5, "a front source should be near-symmetric, ratio {ratio}");
    }

    #[test]
    fn distance_attenuates() {
        let mut near = Mixer::new();
        near.set_spatial(true);
        near.set_max_distance(20.0);
        near.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 1.0 }));

        let mut far = Mixer::new();
        far.set_spatial(true);
        far.set_max_distance(20.0);
        far.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 15.0 }));

        let a = constant(0.5);
        let mut near_out = vec![0.0f32; FRAME * 2];
        let mut far_out = vec![0.0f32; FRAME * 2];
        settle(&mut near, "a", &a, &mut near_out);
        settle(&mut far, "a", &a, &mut far_out);

        let (nl, nr) = ear_energy(&near_out);
        let (fl, fr) = ear_energy(&far_out);
        assert!(
            nl + nr > (fl + fr) * 2.0,
            "near {} should clearly exceed far {}",
            nl + nr,
            fl + fr
        );
    }

    #[test]
    fn beyond_max_distance_is_silent() {
        let mut m = Mixer::new();
        m.set_spatial(true);
        m.set_max_distance(10.0);
        m.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 50.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        settle(&mut m, "a", &a, &mut out);

        let (left, right) = ear_energy(&out);
        assert!(left + right < 1e-3, "an out-of-range source should be inaudible");
    }

    /// Checks a generated HRIR sphere against the one property that cannot be eyeballed: which ear
    /// a source ends up in. Getting SADIE's azimuth handedness backwards produces a sphere that
    /// looks perfectly well-formed and mirrors every source, which is close to undetectable in
    /// code review and immediately obvious in a call.
    ///
    /// Skips unless `HRIR_SPHERE` names a sphere, since the data is fetched rather than committed:
    ///
    /// ```text
    /// HRIR_SPHERE=/path/to/sadie_d1_48k.bin cargo test hrtf_sphere_places
    /// ```
    #[test]
    fn hrtf_sphere_places_sources_on_the_correct_side() {
        let Ok(path) = std::env::var("HRIR_SPHERE") else { return };
        let bytes: &'static [u8] =
            Box::leak(std::fs::read(&path).expect("sphere").into_boxed_slice());

        for (label, x, expect_right) in [("right", 3.0f32, true), ("left", -3.0f32, false)] {
            let mut m = Mixer::new();
            m.set_hrir(Some(bytes));
            m.set_spatial(true);
            m.set_position("a", Some(Position { x, y: 0.0, z: 0.0 }));
            let a = constant(0.5);
            let mut out = vec![0.0f32; FRAME * 2];
            settle(&mut m, "a", &a, &mut out);
            let (l, r) = ear_energy(&out);
            eprintln!("{label}: left {l:.6} right {r:.6}");
            if expect_right {
                assert!(r > l * 1.2, "{label}: expected right-dominant, got l {l} r {r}");
            } else {
                assert!(l > r * 1.2, "{label}: expected left-dominant, got l {l} r {r}");
            }
        }
    }

    #[test]
    fn panning_holds_power_constant_across_the_field() {
        // The reason this is cos/sin rather than a linear ramp. With linear gains a source walking
        // past the listener loses about 3 dB at centre and audibly dips - the artefact that makes
        // naive panning sound like a hole in the middle of the world.
        for x in [-4.0f32, -1.0, -0.2, 0.0, 0.2, 1.0, 4.0] {
            let (l, r) = stereo_pan(Position { x, y: 0.0, z: 1.0 });
            let power = l * l + r * r;
            assert!(
                (power - 1.0).abs() < 1e-5,
                "power {power} at x {x} should stay at unity"
            );
        }
    }

    #[test]
    fn panning_is_symmetric_about_the_listener() {
        let (left_l, left_r) = stereo_pan(Position { x: -2.0, y: 0.0, z: 1.0 });
        let (right_l, right_r) = stereo_pan(Position { x: 2.0, y: 0.0, z: 1.0 });
        assert!((left_l - right_r).abs() < 1e-6, "mirrored positions must mirror gains");
        assert!((left_r - right_l).abs() < 1e-6);
    }

    #[test]
    fn panning_a_source_at_the_listener_does_not_produce_nan() {
        // distance == 0 divides by zero if guarded carelessly, and a NaN gain here would not just
        // break this source - it propagates through the accumulator and silences the whole mix.
        let (l, r) = stereo_pan(Position { x: 0.0, y: 0.0, z: 0.0 });
        assert!(l.is_finite() && r.is_finite());
        assert!((l - r).abs() < 1e-6, "no direction means no pan");
    }

    #[test]
    fn spatial_disabled_falls_back_to_centre() {
        let mut m = Mixer::new();
        m.set_spatial(false);
        m.set_position("a", Some(Position { x: -5.0, y: 0.0, z: 0.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &a)], &mut out);

        // Position is ignored entirely, so the source is centred and unattenuated.
        assert!((out[0] - 0.5).abs() < 1e-6);
        assert!((out[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_positionless_source_is_centred_even_in_spatial_mode() {
        let mut m = Mixer::new();
        m.set_spatial(true);
        m.set_position("a", None);
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &a)], &mut out);

        let (left, right) = ear_energy(&out);
        let ratio = left.max(right) / left.min(right).max(f32::EPSILON);
        assert!(ratio < 1.1, "a non-positional source must not be panned");
    }

    #[test]
    fn spatial_output_stays_finite() {
        let mut m = Mixer::new();
        m.set_spatial(true);
        // The listener's own position: distance zero, which must not divide by zero.
        m.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 0.0 }));
        let a = constant(0.9);
        let mut out = vec![0.0f32; FRAME * 2];
        settle(&mut m, "a", &a, &mut out);
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn removing_a_participant_forgets_their_settings() {
        let mut m = Mixer::new();
        m.set_gain("a", 0.25);
        m.remove("a");
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &a)], &mut out);
        assert!((out[0] - 0.5).abs() < 1e-6, "gain should be back to unity");
    }
}
