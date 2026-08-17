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
//!
//! Panning is decided per source rather than by a mode switch: a source with a position is placed,
//! one without is centred. There is one mixer for the whole client, so a guild call and proximity
//! voice can be running at once, and a global "spatial" flag would have had to be right for both at
//! the same time - which it cannot be.

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

/// How placed sources fall off with distance, and how hard they are panned.
///
/// Ported from the WebAudio graph this replaced rather than reinvented, because the numbers are
/// tuned against a specific world: full volume out to `ref_distance`, then an inverse curve of
/// steepness `rolloff`, renormalised to reach exactly zero at `max_distance`.
///
/// The renormalisation is the part worth keeping. The raw inverse curve never reaches zero - at 80 m
/// with a rolloff of 1.6 it is still around -18 dB - and the server hands over peers well past the
/// audible range, so without it a whole neighbourhood stays faintly audible.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpatialModel {
    /// Full volume within this many metres.
    pub ref_distance: f32,
    /// Steepness of the falloff beyond `ref_distance`.
    pub rolloff: f32,
    /// Beyond this many metres a source is silent.
    pub max_distance: f32,
    /// How much of a placed source is panned rather than centred, 0.0-1.0.
    ///
    /// Not always 1.0 on purpose: full HRTF makes a source at 90 degrees almost ear-exclusive, which
    /// in a game turns proximity chat into a direction finder. Blending a centred copy back in keeps
    /// direction legible without making it precise.
    pub intensity: f32,
}

impl Default for SpatialModel {
    fn default() -> Self {
        Self {
            ref_distance: 1.0,
            rolloff: 1.6,
            max_distance: 20.0,
            intensity: 1.0,
        }
    }
}

impl SpatialModel {
    /// The model as given, or `None` if any of it would silence or corrupt the mix.
    ///
    /// Rejected wholesale rather than clamped field by field: these four numbers are tuned together,
    /// and a half-applied model is harder to recognise than one that was ignored. A zero or NaN
    /// `max_distance` in particular silences every placed source at once, which looks exactly like
    /// the game having stopped sending positions.
    pub fn validated(self) -> Option<Self> {
        let finite = self.ref_distance.is_finite()
            && self.rolloff.is_finite()
            && self.max_distance.is_finite()
            && self.intensity.is_finite();
        if !finite || self.max_distance <= 0.0 || self.ref_distance < 0.0 || self.rolloff < 0.0 {
            return None;
        }
        Some(Self {
            // A reference distance at or past the audible edge would make every source either full
            // volume or silent, with nothing in between.
            ref_distance: self.ref_distance.min(self.max_distance * 0.99),
            intensity: self.intensity.clamp(0.0, 1.0),
            ..self
        })
    }

    /// Gain for a source `distance` metres away.
    fn gain(&self, distance: f32) -> f32 {
        if !distance.is_finite() {
            return 0.0;
        }
        if distance <= self.ref_distance {
            return 1.0;
        }
        if distance >= self.max_distance {
            return 0.0;
        }
        let curve = |d: f32| {
            self.ref_distance / (self.ref_distance + self.rolloff * (d - self.ref_distance))
        };
        let raw = curve(distance);
        let edge = curve(self.max_distance);
        // A flat curve (rolloff 0, a dev knob) puts the edge at 1.0 and the shift below undefined.
        if edge >= 1.0 {
            raw
        } else {
            ((raw - edge) / (1.0 - edge)).clamp(0.0, 1.0)
        }
    }
}

/// The HRIR sphere every mixer starts with: SADIE II subject D1, a Neumann KU100 dummy head, at
/// 48 kHz.
///
/// Built from the Apache 2.0 measurements by `tools/hrir_sphere.rs` - see that file for why the
/// conversion is needed and how the mesh is derived. Committed rather than fetched: the data is
/// permissively licensed, so the runtime-download dance that OpenH264 needs for patent reasons
/// buys nothing here except a network dependency in every build.
///
/// Costs about 120 ms to turn into a sphere, once, on whichever thread first enables spatial
/// audio. That is call-setup latency, not per-frame work.
const BUNDLED_HRIR: &[u8] = include_bytes!("../../../assets/hrir/sadie_d1_48k.bin");

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

    positions: HashMap<String, Option<Position>>,
    spatial_state: HashMap<String, Spatial>,
    /// Raw HRIR sphere bytes, when a dataset is available.
    ///
    /// `None` is a supported state: spatial sources are then distance-attenuated but not
    /// directional, so proximity voice keeps working while a licence-compatible dataset is chosen.
    /// The `hrtf` crate ships no data of its own.
    hrir_bytes: Option<&'static [u8]>,
    model: SpatialModel,
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

            positions: HashMap::new(),
            spatial_state: HashMap::new(),
            hrir_bytes: Some(BUNDLED_HRIR),
            model: SpatialModel::default(),
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

    /// Place a source, or centre it by passing `None`.
    ///
    /// This is the only spatial switch there is. Turning proximity audio off is expressed by
    /// un-placing every source, not by a mode flag - see the module note.
    pub fn set_position(&mut self, id: &str, position: Option<Position>) {
        self.positions.insert(id.to_owned(), position);
    }

    /// How placed sources fall off and how hard they are panned. See [`SpatialModel`].
    pub fn set_spatial_model(&mut self, model: SpatialModel) {
        self.model = model;
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
                // A known position: the only path that pans.
                Some(position) => {
                    self.render_spatial(id, samples, gain, position);
                }
                // No position, so centred at full level - a guild or DM participant, or a
                // proximity peer the game has not placed yet. Both may be in this same mix.
                None => {
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

    fn render_spatial(&mut self, id: &str, samples: &[f32], gain: f32, position: Position) {
        let distance_gain = self.model.gain(position.distance());
        if distance_gain <= 0.0 {
            // Out of range. Returning here also avoids building HRTF state for a source that
            // cannot be heard.
            return;
        }

        // The centred share. Panning short of fully keeps direction legible without making it
        // precise enough to aim by - see `SpatialModel::intensity`. At full intensity this is zero
        // and the whole source goes through the HRTF path below.
        let dry = gain * distance_gain * (1.0 - self.model.intensity);
        if dry > 0.0 {
            for (i, &s) in samples.iter().take(FRAME).enumerate() {
                let v = if s.is_finite() { s * dry } else { 0.0 };
                self.accumulator[i * 2] += v;
                self.accumulator[i * 2 + 1] += v;
            }
        }
        let gain = gain * self.model.intensity;
        if gain <= 0.0 {
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

    /// The default model with a given audible radius.
    fn model(max_distance: f32) -> SpatialModel {
        SpatialModel { max_distance, ..SpatialModel::default() }
    }

    #[test]
    fn the_falloff_is_flat_out_to_the_reference_distance() {
        // Isle's tuning gives 15 m of full volume before anything fades. A curve that started
        // attenuating at the listener would put a conversation partner two rooms down at the level
        // the old graph gave someone across a field.
        let m = SpatialModel { ref_distance: 15.0, max_distance: 80.0, ..SpatialModel::default() };
        assert_eq!(m.gain(0.0), 1.0);
        assert_eq!(m.gain(14.9), 1.0);
        assert!(m.gain(20.0) < 1.0, "and it does fade past the reference");
    }

    #[test]
    fn the_falloff_reaches_exactly_silence_at_the_audible_edge() {
        // The renormalisation this model exists for. The raw inverse curve is still around -18 dB
        // at 80 m, and the server sends peers well past that, so without the shift a whole
        // neighbourhood stays faintly audible - and walking out of range would click rather than
        // fade.
        let m = SpatialModel { ref_distance: 15.0, max_distance: 80.0, ..SpatialModel::default() };
        assert_eq!(m.gain(80.0), 0.0);
        assert_eq!(m.gain(1000.0), 0.0);
        assert!(m.gain(79.0) < 0.02, "and it approaches silence rather than jumping: {}", m.gain(79.0));
        assert!(m.gain(79.0) > 0.0);
    }

    #[test]
    fn the_falloff_is_monotonic() {
        let m = SpatialModel { ref_distance: 15.0, max_distance: 80.0, ..SpatialModel::default() };
        let mut last = f32::INFINITY;
        for step in 0..=80 {
            let g = m.gain(step as f32);
            assert!(g <= last + 1e-6, "gain rose from {last} to {g} at {step} m");
            assert!((0.0..=1.0).contains(&g), "gain {g} out of range at {step} m");
            last = g;
        }
    }

    #[test]
    fn a_nonsensical_model_is_rejected_whole() {
        // Zero or NaN would silence every placed source at once, which looks exactly like the game
        // having stopped sending positions. Rejecting the whole model rather than clamping a field
        // keeps a bad one recognisable instead of half-applied.
        for bad in [0.0, -5.0, f32::NAN, f32::INFINITY] {
            assert!(model(bad).validated().is_none(), "accepted max_distance {bad}");
        }
        let nan_rolloff = SpatialModel { rolloff: f32::NAN, ..SpatialModel::default() };
        assert!(nan_rolloff.validated().is_none());
    }

    #[test]
    fn a_reference_distance_past_the_edge_is_pulled_back_inside_it() {
        // Otherwise every source is either full volume or silent, with no fade between - the exact
        // cliff the taper exists to remove.
        let m = SpatialModel { ref_distance: 500.0, max_distance: 80.0, ..SpatialModel::default() }
            .validated()
            .expect("the radius itself is usable");
        assert!(m.ref_distance < m.max_distance);
        assert!(m.gain(m.max_distance * 0.995) > 0.0);
    }

    #[test]
    fn panning_short_of_full_intensity_still_reaches_both_ears() {
        // Full HRTF makes a source at 90 degrees nearly ear-exclusive, which in a game turns
        // proximity chat into a direction finder. The blend has to leave the quiet ear audible
        // while keeping the loud one clearly ahead.
        let mut m = Mixer::new();
        m.set_spatial_model(SpatialModel { intensity: 0.6, ..SpatialModel::default() });
        m.set_position("a", Some(Position { x: -4.0, y: 0.0, z: 0.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        settle(&mut m, "a", &a, &mut out);

        let (left, right) = ear_energy(&out);
        assert!(left > right, "the near ear should still lead: l {left} r {right}");
        assert!(right > left * 0.05, "the far ear must not be cut off: l {left} r {right}");
    }

    #[test]
    fn zero_intensity_centres_a_placed_source_without_losing_its_distance() {
        // How the user's "spatial audio off" setting is honoured for proximity voice: direction
        // goes, distance stays. Turning it off must not make everyone equally loud.
        let mut near = Mixer::new();
        near.set_spatial_model(SpatialModel {
            intensity: 0.0,
            ref_distance: 1.0,
            max_distance: 20.0,
            ..SpatialModel::default()
        });
        near.set_position("a", Some(Position { x: -4.0, y: 0.0, z: 0.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        near.mix(&[("a", &a)], &mut out);

        let (left, right) = ear_energy(&out);
        assert!((left - right).abs() < 1e-3, "no direction at zero intensity: l {left} r {right}");
        assert!(left > 0.0, "but still audible");

        let mut far = Mixer::new();
        far.set_spatial_model(SpatialModel {
            intensity: 0.0,
            ref_distance: 1.0,
            max_distance: 20.0,
            ..SpatialModel::default()
        });
        far.set_position("a", Some(Position { x: -18.0, y: 0.0, z: 0.0 }));
        let mut far_out = vec![0.0f32; FRAME * 2];
        far.mix(&[("a", &a)], &mut far_out);
        let (fl, fr) = ear_energy(&far_out);
        assert!(left + right > (fl + fr) * 2.0, "distance still attenuates when direction does not");
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
        near.set_spatial_model(model(20.0));
        near.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 1.0 }));

        let mut far = Mixer::new();
        far.set_spatial_model(model(20.0));
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
        m.set_spatial_model(model(10.0));
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
    /// Runs against the bundled sphere, so a regenerated or swapped dataset is caught here rather
    /// than by someone noticing their friends are on the wrong side of a call.
    #[test]
    fn hrtf_sphere_places_sources_on_the_correct_side() {
        for (label, x, expect_right) in [("right", 3.0f32, true), ("left", -3.0f32, false)] {
            let mut m = Mixer::new();
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
    fn un_placing_a_source_returns_it_to_the_centre() {
        // How proximity audio is turned off: every source is un-placed, rather than a mode flag
        // being cleared. There is one mixer for the whole client, so a flag would have had to be
        // right for a guild call and for Isle simultaneously.
        let mut m = Mixer::new();
        m.set_position("a", Some(Position { x: -5.0, y: 0.0, z: 0.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        settle(&mut m, "a", &a, &mut out);

        m.set_position("a", None);
        m.mix(&[("a", &a)], &mut out);
        assert!((out[0] - 0.5).abs() < 1e-6, "got {}", out[0]);
        assert!((out[1] - 0.5).abs() < 1e-6, "got {}", out[1]);
    }

    #[test]
    fn a_guild_participant_and_a_placed_peer_share_one_mix() {
        // The capability the per-source decision exists for: one mixer serves a guild call and Isle
        // proximity voice at the same time. The guild participant must stay centred and unattenuated
        // while the proximity peer is panned hard to one side.
        let mut m = Mixer::new();
        m.set_position("guild-user", None);
        m.set_position("isle-peer", Some(Position { x: -4.0, y: 0.0, z: 0.0 }));

        let guild = constant(0.5);
        let isle = constant(0.0);
        let mut out = vec![0.0f32; FRAME * 2];
        for _ in 0..8 {
            m.mix(&[("guild-user", &guild), ("isle-peer", &isle)], &mut out);
        }

        // The silent proximity peer contributes nothing, so the guild participant arrives intact in
        // both ears - a global spatial flag would have panned them too.
        assert!((out[0] - 0.5).abs() < 1e-4, "left {}", out[0]);
        assert!((out[1] - 0.5).abs() < 1e-4, "right {}", out[1]);

        // And the proximity peer is still panned despite sharing the mix with a centred source.
        // Measured by mirroring the placement rather than against a fixed ratio: the guild source
        // contributes equally to both ears either way, so it cancels out of the comparison - where
        // a single-sided ratio would just be measuring how loud the guild participant happens to be.
        let isle = constant(0.4);
        let imbalance = |m: &mut Mixer, out: &mut Vec<f32>| {
            for _ in 0..8 {
                m.mix(&[("guild-user", &guild), ("isle-peer", &isle)], out);
            }
            let (l, r) = ear_energy(out);
            l - r
        };

        let leftward = imbalance(&mut m, &mut out);
        m.set_position("isle-peer", Some(Position { x: 4.0, y: 0.0, z: 0.0 }));
        let rightward = imbalance(&mut m, &mut out);

        assert!(leftward > 0.0, "a peer on the left must favour the left ear: {leftward}");
        assert!(rightward < 0.0, "and mirrored, the right: {rightward}");
    }

    #[test]
    fn a_positionless_source_is_never_panned() {
        let mut m = Mixer::new();
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
