//! Decides, once per frame, whether the microphone should be transmitting.
//!
//! One gate, not two. The previous pipeline gated the same signal twice - an RNNoise VAD threshold
//! inside Rust (`vadStrength`) and a separate RMS threshold in JavaScript on a cloned track
//! (`inputSensitivity`) - which meant two settings sliders, two `AudioContext`s per call, and two
//! different answers to one question.
//!
//! The threshold is relative to the room, not to full scale. An absolute one cannot be right for
//! two rigs at once, and measurably was not: at a single setting the old gate passed 100% of a
//! talker on a hot headset and 0% of the same talker on a rig 20 dB quieter, and its least
//! sensitive third of travel passed nothing quieter than a raised voice on any rig at all.
//!
//! Mute is absolute: it beats push-to-talk, which beats voice activity.

use super::FRAME_MS;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InputMode {
    VoiceActivity,
    PushToTalk,
}

#[derive(Clone, Copy, Debug)]
pub struct GateConfig {
    pub mode: InputMode,
    /// 0.0 (least sensitive) to 1.0 (most sensitive), matching the settings slider.
    pub sensitivity: f32,
    /// How long the gate stays open after the signal falls below the threshold.
    pub release_ms: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct GateDecision {
    /// Whether this frame should be encoded and sent.
    pub transmit: bool,
    /// Whether to show this user as speaking. Never true while muted, even under push-to-talk.
    pub speaking: bool,
}

/// How far above the noise floor the signal has to rise before the gate opens, at the two ends of
/// the slider, in decibels.
///
/// A margin rather than a level. What a gate is asked is "is someone talking", and the answer
/// depends on how far the signal sits above the room - not on how hot the preamp runs. The old
/// ladder ran from -25 dBFS at the bottom of the slider to -60 at the top, which meant the bottom
/// 30% of the travel opened for nothing quieter than a shout into the microphone, and no position
/// on it worked on two different rigs at once.
const LEAST_SENSITIVE_MARGIN_DB: f32 = 18.0;
const MOST_SENSITIVE_MARGIN_DB: f32 = 3.0;

/// How far back below the opening threshold the signal has to fall before an open gate closes.
///
/// One threshold cannot do both jobs. Speech crosses whatever single line you draw, several times a
/// second, and a gate with one line then flaps at syllable rate - which is heard as stuttering
/// rather than as gating. Measured on the old gate: ten state changes across a 3 dB dip that should
/// have produced one.
const HYSTERESIS_DB: f32 = 4.0;

/// The closing threshold never comes closer than this to the noise floor, however wide the
/// hysteresis would otherwise open it. Without it, a gate that had opened once would be propped
/// open by anything a few dB above room tone - a fan, a fridge, a housemate two rooms away.
const MIN_CLOSE_MARGIN_DB: f32 = 4.0;

/// Nothing below this is treated as speech, whatever the floor estimate says.
///
/// A microphone in a treated room can sit near the noise floor of the converter itself, and a
/// purely relative gate would cheerfully promote that to "someone is talking".
const ABSOLUTE_FLOOR_DBFS: f32 = -75.0;

/// The level reported for a frame with no energy at all, so that the logarithm has a value.
const SILENCE_DBFS: f32 = -100.0;

/// How long the gate transmits unconditionally at the start of a call, while it works out what the
/// room sounds like.
///
/// It has to guess, and the two guesses are not equally bad: a moment of room tone reaching the
/// channel is recoverable, and swallowing the first thing somebody says after joining is not.
const PRIME_MS: u32 = 300;

/// Envelope release.
///
/// The gate judges a smoothed level rather than one 10 ms frame, because a single frame is far too
/// short to be a statement about speech - the level inside one word swings more than 20 dB between
/// a stressed vowel and the fricative after it. Attack is instantaneous; only the decision that
/// somebody has *stopped* is worth being slow about.
const ENVELOPE_RELEASE_MS: f32 = 50.0;

/// How fast the floor estimate follows the signal down. Slow enough that the dips between syllables
/// are not mistaken for silence, fast enough that a genuine pause updates it.
const FLOOR_FALL_MS: f32 = 500.0;

/// How fast the floor estimate climbs, with the gate shut and with it open.
///
/// Two rates, because the estimate must not learn from speech: while the gate is open the signal is
/// presumed to be somebody talking, and a floor that chased it would climb into their voice and
/// shut the gate on them mid-sentence. It still climbs, slowly, so that a fan switched on during a
/// call is eventually learned rather than transmitted for the rest of it.
const FLOOR_RISE_DB_PER_SEC_CLOSED: f32 = 3.0;
const FLOOR_RISE_DB_PER_SEC_OPEN: f32 = 0.5;

/// How far above the noise floor the gate opens, for a slider position of 0.0-1.0.
///
/// Spaced in decibels because that is how loudness works. Spread linearly in amplitude - which the
/// original did, as `0.05 * (1 - sensitivity)` - the entire usable range of a gate is crushed into
/// the bottom fifth of the travel.
fn margin_db(sensitivity: f32) -> f32 {
    let sensitivity = sensitivity.clamp(0.0, 1.0);
    LEAST_SENSITIVE_MARGIN_DB
        + (MOST_SENSITIVE_MARGIN_DB - LEAST_SENSITIVE_MARGIN_DB) * sensitivity
}

/// A frame's RMS as dBFS.
///
/// Public so the chain can report the meter on the same scale the gate judges on. Two conversions
/// would be two chances for the bar and the cutoff drawn across it to disagree.
pub fn dbfs(rms: f32) -> f32 {
    if rms > 0.0 {
        (20.0 * rms.log10()).max(SILENCE_DBFS)
    } else {
        SILENCE_DBFS
    }
}

/// One-pole smoothing coefficient for a time constant in milliseconds.
fn coefficient(tau_ms: f32) -> f32 {
    1.0 - (-(FRAME_MS as f32) / tau_ms).exp()
}

pub struct Gate {
    config: GateConfig,
    muted: bool,
    ptt_down: bool,
    hold_frames: u32,
    /// Smoothed level of the signal, in dBFS.
    envelope_db: f32,
    /// Estimated level of the room with nobody talking, in dBFS. Infinite until the first frame.
    floor_db: f32,
    /// Frames left before the estimates above are trusted.
    priming_frames: u32,
    /// Whether the gate was open on the previous frame, which is what selects the hysteresis.
    open: bool,
}

impl Gate {
    pub fn new(config: GateConfig) -> Self {
        Self {
            config,
            muted: false,
            ptt_down: false,
            hold_frames: 0,
            envelope_db: SILENCE_DBFS,
            // Infinite rather than a guess: the first frame sets it, whatever the room turns out
            // to be. A constant here would be a claim about somebody else's microphone.
            floor_db: f32::INFINITY,
            priming_frames: PRIME_MS / FRAME_MS,
            open: false,
        }
    }

    pub fn set_config(&mut self, config: GateConfig) {
        // Drop the hold: one accrued under voice activity means nothing under push-to-talk. The
        // room estimate stays - the room did not change because a setting did.
        self.hold_frames = 0;
        self.config = config;
    }

    pub fn set_muted(&mut self, muted: bool) {
        if muted {
            self.hold_frames = 0;
            self.open = false;
        } else if self.floor_db.is_finite() {
            // Unmuting starts from "nothing heard yet". Without this the envelope is still carrying
            // whatever was said into a muted microphone, and the gate opens on the strength of
            // audio nobody was ever sent.
            self.envelope_db = self.floor_db;
        }
        self.muted = muted;
    }

    pub fn set_ptt_down(&mut self, down: bool) {
        self.ptt_down = down;
    }

    /// The level the gate will open at, in dBFS, given the room as it currently sounds.
    ///
    /// Exposed because the settings page draws it: a cutoff you can see against your own live level
    /// is the only way to set one, and a floor-relative threshold moves as the room does.
    pub fn threshold_db(&self) -> f32 {
        if !self.floor_db.is_finite() {
            return ABSOLUTE_FLOOR_DBFS;
        }
        (self.floor_db + margin_db(self.config.sensitivity)).max(ABSOLUTE_FLOOR_DBFS)
    }

    fn close_threshold_db(&self) -> f32 {
        (self.threshold_db() - HYSTERESIS_DB).max(self.floor_db + MIN_CLOSE_MARGIN_DB)
    }

    /// Update the envelope and the floor estimate from one frame.
    ///
    /// Runs in every mode, including push-to-talk and while muted, so that switching modes does not
    /// throw away what the gate had learned about the room and the meter always has a threshold to
    /// draw against.
    fn track(&mut self, level_db: f32) {
        if level_db > self.envelope_db {
            self.envelope_db = level_db;
        } else {
            self.envelope_db += (level_db - self.envelope_db) * coefficient(ENVELOPE_RELEASE_MS);
        }

        if self.priming_frames > 0 {
            self.priming_frames -= 1;
            // The quietest thing heard while priming is the best guess at the room available.
            self.floor_db = self.floor_db.min(self.envelope_db);
            return;
        }

        if self.envelope_db < self.floor_db {
            self.floor_db += (self.envelope_db - self.floor_db) * coefficient(FLOOR_FALL_MS);
        } else {
            let per_second = if self.open {
                FLOOR_RISE_DB_PER_SEC_OPEN
            } else {
                FLOOR_RISE_DB_PER_SEC_CLOSED
            };
            let rise = per_second * FRAME_MS as f32 / 1_000.0;
            // Capped at the envelope: it is a floor, and it has no business overtaking the signal.
            self.floor_db = (self.floor_db + rise).min(self.envelope_db);
        }
    }

    /// Advance one frame. `rms` is the level of the processed frame.
    pub fn step(&mut self, rms: f32) -> GateDecision {
        self.track(dbfs(rms));

        if self.muted {
            self.hold_frames = 0;
            self.open = false;
            return GateDecision {
                transmit: false,
                speaking: false,
            };
        }

        let open = match self.config.mode {
            InputMode::PushToTalk => {
                self.hold_frames = 0;
                self.ptt_down
            }
            InputMode::VoiceActivity => self.voice_activity(),
        };

        self.open = open;
        GateDecision {
            transmit: open,
            speaking: open,
        }
    }

    fn voice_activity(&mut self) -> bool {
        // The top of the slider is an off switch, not merely a very small margin. It is the only
        // one the UI offers, and somebody who has turned the gate all the way up and is still being
        // cut off has nowhere left to go.
        if self.config.sensitivity >= 1.0 {
            return true;
        }

        // Still learning the room. See PRIME_MS - the hold is set too, so that the end of priming
        // is a release tail rather than a cut.
        if self.priming_frames > 0 {
            self.hold_frames = self.config.release_ms / FRAME_MS;
            return true;
        }

        // Which of the two thresholds applies is decided by the state the gate is already in: it
        // takes more to open than it does to stay open.
        let threshold = if self.open {
            self.close_threshold_db()
        } else {
            self.threshold_db()
        };

        if self.envelope_db >= threshold {
            self.hold_frames = self.config.release_ms / FRAME_MS;
            true
        } else if self.hold_frames > 0 {
            self.hold_frames -= 1;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice_activity(sensitivity: f32) -> GateConfig {
        GateConfig {
            mode: InputMode::VoiceActivity,
            sensitivity,
            release_ms: 200,
        }
    }

    fn push_to_talk() -> GateConfig {
        GateConfig {
            mode: InputMode::PushToTalk,
            sensitivity: 0.6,
            release_ms: 200,
        }
    }

    const LOUD: f32 = 0.04;
    const QUIET: f32 = 0.001;

    /// What `audio-settings.service.ts` ships as `inputSensitivity`, as the engine receives it.
    const SHIPPED_DEFAULT: f32 = 0.6;

    fn from_dbfs(db: f32) -> f32 {
        10f32.powf(db / 20.0)
    }

    /// The level of one 10 ms frame of ordinary conversational speech.
    ///
    /// Speech is not a steady tone: within a single word the level swings 20 dB or more between a
    /// stressed vowel and the fricative after it. A gate set inside that range does not merely
    /// clip the gaps between words, it cuts holes in the middle of them, which is heard as
    /// mumbling rather than as silence. The field report this exists for measured a peak frame of
    /// -22 dBFS, so the quiet end of the same speech sits around -45.
    const SPEECH_PEAK_DBFS: f32 = -22.0;
    const SPEECH_QUIET_DBFS: f32 = -45.0;

    /// Room tone with nobody talking: what the gate is actually for.
    const ROOM_TONE_DBFS: f32 = -65.0;

    /// A gate that has already heard two seconds of the room, which is the state it is in by the
    /// time anybody says anything.
    ///
    /// Tests that talk into a gate on its very first frame are testing the priming window rather
    /// than the gate - see `the_first_words_of_a_call_are_not_swallowed`, which is the one place
    /// that behaviour is the subject.
    fn primed(config: GateConfig, floor_dbfs: f32) -> Gate {
        let mut gate = Gate::new(config);
        for _ in 0..200 {
            gate.step(from_dbfs(floor_dbfs));
        }
        gate
    }

    /// One talker's session: enough room tone for the floor estimate to settle, then bursts of
    /// speech with pauses between them. Returns the fraction of the speech frames that transmitted.
    ///
    /// Levels rather than amplitudes, and a floor as well as a speech level, because the thing
    /// being asked of a gate is "is this person talking" - which is a statement about the distance
    /// between those two numbers, not about either one on its own.
    fn talker(gate: &mut Gate, floor_dbfs: f32, speech_dbfs: f32) -> f32 {
        // 2 s of room tone before anyone says anything.
        for _ in 0..200 {
            gate.step(from_dbfs(floor_dbfs));
        }
        let (mut open, mut total) = (0u32, 0u32);
        for _ in 0..10 {
            // 400 ms of speech...
            for _ in 0..40 {
                total += 1;
                if gate.step(from_dbfs(speech_dbfs)).transmit {
                    open += 1;
                }
            }
            // ...then 300 ms of pause.
            for _ in 0..30 {
                gate.step(from_dbfs(floor_dbfs));
            }
        }
        open as f32 / total as f32
    }

    #[test]
    fn the_shipped_default_passes_the_quiet_part_of_a_word() {
        let mut g = primed(voice_activity(SHIPPED_DEFAULT), ROOM_TONE_DBFS);
        assert!(
            g.step(from_dbfs(SPEECH_QUIET_DBFS)).transmit,
            "at the shipped default the gate opens only above {:.1} dBFS, which is inside the \
             range of ordinary speech - the quiet half of every word is replaced with silence",
            g.threshold_db(),
        );
    }

    #[test]
    fn the_shipped_default_still_rejects_room_tone() {
        // The other half of the same setting. A gate that passes everything is not a fix.
        let mut g = primed(voice_activity(SHIPPED_DEFAULT), ROOM_TONE_DBFS);
        assert!(!g.step(from_dbfs(ROOM_TONE_DBFS)).transmit);
    }

    #[test]
    fn the_first_words_of_a_call_are_not_swallowed() {
        // Joining and talking straight away. The gate has no idea yet what the room sounds like,
        // and while it finds out the only safe answer is to transmit: a moment of room tone on the
        // channel is recoverable, and being inaudible for your first sentence is not.
        //
        // This replaces a test that asserted a bare -35 dBFS frame opens the gate at the bottom of
        // the slider. That was a claim about an absolute threshold, and a gate with no history has
        // no honest answer to it - the property worth keeping is that it errs open rather than shut.
        let mut g = Gate::new(voice_activity(0.0));
        for frame in 0..20 {
            assert!(
                g.step(from_dbfs(-35.0)).transmit,
                "frame {frame} of the call was gated shut before the gate knew what the room \
                 sounded like",
            );
        }
    }

    #[test]
    fn no_slider_position_has_a_dead_zone_for_ordinary_speech() {
        // Replaces a test that pinned the least-sensitive threshold near its historical 0.05 so
        // that "an existing slider position must not change character underneath anyone". That
        // constant is itself the defect: 0.05 is -25 dBFS, and anchoring the ladder to it left the
        // bottom of the slider unusable while looking, from inside the test suite, like
        // compatibility.
        //
        // The invariant worth keeping is not a number. It is that every position the UI offers
        // passes ordinary speech - which is what stops the ladder being re-anchored to some other
        // wrong constant later and the whole failure returning under a different set of numbers.
        //
        // The whole slider is measured before asserting: how far up the travel a dead zone reaches
        // is the number that matters, and stopping at the first bad position would report one at 0%
        // whether it ends there or covers a third of the control.
        let dead: Vec<String> = (0..=20)
            .map(|step| step as f32 / 20.0)
            .map(|sensitivity| {
                let passed = talker(&mut Gate::new(voice_activity(sensitivity)), -60.0, -35.0);
                (sensitivity, passed)
            })
            .filter(|(_, passed)| *passed <= 0.95)
            .map(|(sensitivity, passed)| format!("{sensitivity:.2}={:.0}%", passed * 100.0))
            .collect();

        assert!(
            dead.is_empty(),
            "a talker 25 dB above their own room tone is gated shut at {} of the 21 slider \
             positions: {}",
            dead.len(),
            dead.join(" "),
        );
    }

    #[test]
    fn a_level_sitting_on_the_threshold_does_not_chatter() {
        // With one threshold for both directions, a talker whose level straddles it toggles the
        // gate at syllable rate. No choice of threshold avoids that - speech crosses whatever line
        // you draw. It takes two lines: once open, a clear drop is needed to close it again.
        let mut g = primed(voice_activity(0.5), -60.0);
        let opens_at = g.threshold_db();
        let above = from_dbfs(opens_at + 1.0);
        let dipping = from_dbfs(opens_at - 3.0);

        let mut transitions = 0u32;
        let mut last = false;
        // 50 ms on the loud side, then 400 ms dipping - longer than the release window, so the
        // hold cannot paper over the flapping.
        let session = std::iter::repeat([(above, 5), (dipping, 40)]).take(5).flatten();
        for (level, frames) in session {
            for _ in 0..frames {
                let now = g.step(level).transmit;
                if now != last {
                    transitions += 1;
                    last = now;
                }
            }
        }

        assert_eq!(
            transitions, 1,
            "the gate should open once and stay open through a 3 dB dip; it changed state \
             {transitions} times instead",
        );
    }

    #[test]
    fn the_slider_means_the_same_thing_however_hot_the_microphone_runs() {
        // The same person saying the same thing, 25 dB above their own room tone, on two rigs whose
        // absolute levels differ by 20 dB - a headset with its gain up, against a webcam mic across
        // the desk. One absolute dBFS threshold cannot serve both, which is why no position on the
        // old slider worked for everyone: the number it compared against had nothing to do with the
        // microphone in use.
        let hot = talker(&mut Gate::new(voice_activity(0.5)), -60.0, -35.0);
        let quiet = talker(&mut Gate::new(voice_activity(0.5)), -80.0, -55.0);
        assert!(
            (hot - quiet).abs() < 0.05,
            "one setting, one talker, two rigs: {:.0}% of speech through the hot one against \
             {:.0}% through the quiet one",
            hot * 100.0,
            quiet * 100.0,
        );
    }

    #[test]
    fn a_quiet_rigs_room_tone_still_does_not_open_the_gate() {
        // The other half of the test above, and the one that stops it being satisfied by a gate
        // that has simply been opened for everything.
        let mut g = primed(voice_activity(0.5), -80.0);
        assert!(
            !g.step(from_dbfs(-80.0)).transmit,
            "a quiet rig's room tone must stay gated even once the gate has learned how quiet it is"
        );
    }

    #[test]
    fn a_room_quieter_than_the_converter_still_does_not_open_the_gate() {
        // A purely relative gate promotes the noise floor of the hardware itself to speech. This is
        // the backstop that stops it - see ABSOLUTE_FLOOR_DBFS.
        let mut g = primed(voice_activity(0.9), -95.0);
        assert!(!g.step(from_dbfs(-95.0)).transmit);
        assert!(!g.step(from_dbfs(-85.0)).transmit);
    }

    #[test]
    fn the_most_sensitive_setting_transmits_anything() {
        // The top of the slider is the only "off switch" the UI offers for the gate, and someone
        // reaching for one needs it to actually be off.
        let mut g = Gate::new(voice_activity(1.0));
        assert!(g.step(0.0).transmit, "the top of the slider must not gate at all");
    }

    #[test]
    fn sensitivity_only_ever_opens_the_gate_further() {
        // Monotonic across the whole slider: no setting is more restrictive than a lower one.
        let mut previous = f32::INFINITY;
        for step in 0..=20 {
            let margin = margin_db(step as f32 / 20.0);
            assert!(
                margin <= previous,
                "raising the sensitivity to {} raised the margin from {previous} to {margin}",
                step as f32 / 20.0
            );
            previous = margin;
        }
    }

    #[test]
    fn the_slider_is_spaced_in_decibels_not_in_amplitude() {
        // Loudness is logarithmic. Spaced linearly in amplitude, the whole usable range of a gate
        // is squeezed into the bottom fifth of the slider, so every position above it is far too
        // aggressive and the control is unusable in its middle.
        let quarter = margin_db(0.0) - margin_db(0.25);
        let three_quarters = margin_db(0.5) - margin_db(0.75);
        assert!(
            (quarter - three_quarters).abs() < 1.0,
            "equal slider movements should cost equal decibels: {quarter:.1} dB in the first \
             quarter against {three_quarters:.1} dB in the third"
        );
    }

    #[test]
    fn a_loud_talker_opens_the_gate_at_every_setting() {
        for step in 0..=10 {
            let mut g = primed(voice_activity(step as f32 / 10.0), ROOM_TONE_DBFS);
            assert!(
                g.step(from_dbfs(SPEECH_PEAK_DBFS)).transmit,
                "clearly audible speech was gated shut at sensitivity {}",
                step as f32 / 10.0
            );
        }
    }

    #[test]
    fn voice_activity_opens_above_the_threshold() {
        let mut g = primed(voice_activity(0.6), ROOM_TONE_DBFS);
        assert!(g.step(LOUD).transmit);
        assert!(g.step(LOUD).speaking);
    }

    #[test]
    fn voice_activity_stays_shut_below_the_threshold() {
        let mut g = primed(voice_activity(0.6), ROOM_TONE_DBFS);
        let d = g.step(QUIET);
        assert!(!d.transmit);
        assert!(!d.speaking);
    }

    #[test]
    fn the_gate_stays_open_across_the_pauses_between_words() {
        // Pauses inside a sentence are shorter than this; closing inside them is what clipped words
        // mid-syllable.
        let mut g = primed(voice_activity(0.6), ROOM_TONE_DBFS);
        g.step(from_dbfs(SPEECH_PEAK_DBFS));

        for frame in 0..20 {
            assert!(
                g.step(from_dbfs(ROOM_TONE_DBFS)).transmit,
                "closed after only {frame} frames of pause"
            );
        }
    }

    #[test]
    fn the_gate_closes_once_the_talking_has_actually_stopped() {
        // The exact frame is deliberately not pinned. It falls out of the release window, the
        // envelope's own decay and the hysteresis together, and pinning it would make every future
        // tuning change read as a regression. What matters is the pair of bounds: long enough to
        // ride a pause, short enough not to hold the channel open after someone has finished.
        let mut g = primed(voice_activity(0.6), ROOM_TONE_DBFS);
        g.step(from_dbfs(SPEECH_PEAK_DBFS));

        let closed_at = (0..100)
            .find(|_| !g.step(from_dbfs(ROOM_TONE_DBFS)).transmit)
            .expect("the gate never closed, through a full second of room tone");

        assert!(
            (20..=60).contains(&closed_at),
            "closed {closed_at} frames after the talking stopped"
        );
    }

    #[test]
    fn a_new_burst_restarts_the_release_window() {
        let mut g = primed(voice_activity(0.6), ROOM_TONE_DBFS);
        g.step(from_dbfs(SPEECH_PEAK_DBFS));
        for _ in 0..10 {
            g.step(from_dbfs(ROOM_TONE_DBFS));
        }
        g.step(from_dbfs(SPEECH_PEAK_DBFS));
        for frame in 0..20 {
            assert!(
                g.step(from_dbfs(ROOM_TONE_DBFS)).transmit,
                "closed early at frame {frame}"
            );
        }
    }

    #[test]
    fn higher_sensitivity_opens_on_a_quieter_talker() {
        // Used to assert an absolute pair - 0.0 must reject an RMS of 0.005, 1.0 must accept it -
        // which pinned the same wrong anchor as the dead-zone test above, from the other side. The
        // claim worth keeping is comparative, and it stays true whatever the ladder is built from.
        let (floor, faint) = (-70.0, -52.0);
        let insensitive = talker(&mut Gate::new(voice_activity(0.2)), floor, faint);
        let sensitive = talker(&mut Gate::new(voice_activity(0.8)), floor, faint);
        assert!(
            sensitive >= insensitive,
            "raising the slider passed less speech, not more: {:.0}% against {:.0}%",
            sensitive * 100.0,
            insensitive * 100.0,
        );
        assert!(
            sensitive > 0.95,
            "a talker 18 dB above their room tone must get through near the top of the slider, \
             got {:.0}%",
            sensitive * 100.0,
        );
    }

    #[test]
    fn the_threshold_follows_the_room() {
        // What the settings page draws. A cutoff that did not move with the room would be a lie on
        // the meter as well as in the gate.
        let quiet_room = primed(voice_activity(0.5), -70.0).threshold_db();
        let noisy_room = primed(voice_activity(0.5), -45.0).threshold_db();
        assert!(
            noisy_room > quiet_room + 20.0,
            "the cutoff barely moved between a -70 dBFS room and a -45 dBFS one: \
             {quiet_room:.1} against {noisy_room:.1}"
        );
    }

    #[test]
    fn push_to_talk_ignores_the_signal_level() {
        let mut g = primed(push_to_talk(), ROOM_TONE_DBFS);
        assert!(!g.step(LOUD).transmit, "silent until the key is held");

        g.set_ptt_down(true);
        assert!(g.step(QUIET).transmit, "transmits while held, however quiet");

        g.set_ptt_down(false);
        assert!(!g.step(LOUD).transmit, "stops the moment the key is released");
    }

    #[test]
    fn mute_overrides_push_to_talk() {
        let mut g = primed(push_to_talk(), ROOM_TONE_DBFS);
        g.set_ptt_down(true);
        g.set_muted(true);
        let d = g.step(LOUD);
        assert!(!d.transmit);
        assert!(!d.speaking, "a muted user must never light up as speaking");
    }

    #[test]
    fn mute_overrides_voice_activity() {
        let mut g = Gate::new(voice_activity(1.0));
        g.set_muted(true);
        let d = g.step(LOUD);
        assert!(!d.transmit);
        assert!(!d.speaking);
    }

    #[test]
    fn unmuting_does_not_leak_the_previous_hold() {
        let mut g = primed(voice_activity(0.6), ROOM_TONE_DBFS);
        g.step(LOUD);
        g.set_muted(true);
        g.step(LOUD);
        g.set_muted(false);
        assert!(
            !g.step(QUIET).transmit,
            "neither the hold nor the envelope may survive a mute"
        );
    }

    #[test]
    fn switching_mode_resets_the_gate() {
        let mut g = primed(voice_activity(0.6), ROOM_TONE_DBFS);
        g.step(LOUD);
        g.set_config(push_to_talk());
        assert!(
            !g.step(LOUD).transmit,
            "a voice-activity hold must not carry into push-to-talk"
        );
    }
}
