//! Decides, once per frame, whether the microphone should be transmitting.
//!
//! One gate, not two. The previous pipeline gated the same signal twice - an RNNoise VAD threshold
//! inside Rust (`vadStrength`) and a separate RMS threshold in JavaScript on a cloned track
//! (`inputSensitivity`) - which meant two settings sliders, two `AudioContext`s per call, and two
//! different answers to one question.
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

/// The level the gate opens at with the slider all the way down, in dBFS.
///
/// -25 dBFS is an RMS of about 0.056, which is within rounding of the 0.05 this used to use at the
/// same position - so a slider left at the bottom keeps the meaning it had.
const LEAST_SENSITIVE_DBFS: f32 = -25.0;

/// The level the gate opens at with the slider almost all the way up, in dBFS.
///
/// Quiet enough to catch a whisper and still sit below room tone, which measures around -65 dBFS
/// on a headset microphone. The very top of the slider is handled separately, below.
const MOST_SENSITIVE_DBFS: f32 = -60.0;

/// The RMS at which the gate opens, for a sensitivity slider position of 0.0-1.0.
///
/// Spaced in decibels, because that is how loudness works and how the level it is compared against
/// behaves. Spread linearly in amplitude - which is what this did, as `0.05 * (1 - sensitivity)` -
/// the entire usable range of a voice gate is crushed into the bottom fifth of the travel, and
/// every position above it opens only above -34 dBFS or louder. Ordinary speech swings more than
/// 20 dB inside a single word, between a stressed vowel and the consonant after it, so a threshold
/// sitting in the middle of that range does not gate the pauses between words: it cuts holes
/// through the words themselves. Heard as mumbling, and measured in the field as 27-58% of frames
/// during active speech reaching the encoder at all.
fn threshold_for(sensitivity: f32) -> f32 {
    let sensitivity = sensitivity.clamp(0.0, 1.0);
    // The top of the slider is an off switch, not merely a very low threshold. It is the only one
    // the UI offers, and someone who has turned the gate all the way up and is still being cut off
    // has nowhere left to go.
    if sensitivity >= 1.0 {
        return 0.0;
    }
    let db = LEAST_SENSITIVE_DBFS + (MOST_SENSITIVE_DBFS - LEAST_SENSITIVE_DBFS) * sensitivity;
    10f32.powf(db / 20.0)
}

pub struct Gate {
    config: GateConfig,
    muted: bool,
    ptt_down: bool,
    hold_frames: u32,
}

impl Gate {
    pub fn new(config: GateConfig) -> Self {
        Self {
            config,
            muted: false,
            ptt_down: false,
            hold_frames: 0,
        }
    }

    pub fn set_config(&mut self, config: GateConfig) {
        // Drop the hold: one accrued under voice activity means nothing under push-to-talk.
        self.hold_frames = 0;
        self.config = config;
    }

    pub fn set_muted(&mut self, muted: bool) {
        if muted {
            self.hold_frames = 0;
        }
        self.muted = muted;
    }

    pub fn set_ptt_down(&mut self, down: bool) {
        self.ptt_down = down;
    }

    /// Advance one frame. `rms` is the level of the processed frame.
    pub fn step(&mut self, rms: f32) -> GateDecision {
        if self.muted {
            self.hold_frames = 0;
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
            InputMode::VoiceActivity => {
                let threshold = threshold_for(self.config.sensitivity);
                // Inclusive, so that the zero threshold at the top of the slider is genuinely an
                // open gate rather than one that still shuts on digital silence. Everywhere else
                // the distinction is below the resolution of anything being compared.
                if rms >= threshold {
                    self.hold_frames = self.config.release_ms / FRAME_MS;
                    true
                } else if self.hold_frames > 0 {
                    self.hold_frames -= 1;
                    true
                } else {
                    false
                }
            }
        };

        GateDecision {
            transmit: open,
            speaking: open,
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

    fn dbfs(rms: f32) -> f32 {
        20.0 * rms.log10()
    }

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

    #[test]
    fn the_shipped_default_passes_the_quiet_part_of_a_word() {
        let mut g = Gate::new(voice_activity(SHIPPED_DEFAULT));
        let quiet_speech = from_dbfs(SPEECH_QUIET_DBFS);
        assert!(
            g.step(quiet_speech).transmit,
            "at the shipped default the gate opens only above {:.1} dBFS, which is inside the \
             range of ordinary speech - the quiet half of every word is replaced with silence",
            dbfs(threshold_for(SHIPPED_DEFAULT)),
        );
    }

    #[test]
    fn the_shipped_default_still_rejects_room_tone() {
        // The other half of the same setting. A gate that passes everything is not a fix.
        let mut g = Gate::new(voice_activity(SHIPPED_DEFAULT));
        assert!(!g.step(from_dbfs(ROOM_TONE_DBFS)).transmit);
    }

    #[test]
    fn the_least_sensitive_setting_keeps_the_meaning_it_had() {
        // Slider at zero has always meant "only something clearly loud opens this". It stays put:
        // an existing slider position must not change character underneath anyone.
        let threshold = threshold_for(0.0);
        assert!(
            (0.04..=0.07).contains(&threshold),
            "expected the least-sensitive end to stay near its historical 0.05, got {threshold}"
        );
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
            let threshold = threshold_for(step as f32 / 20.0);
            assert!(
                threshold <= previous,
                "raising the sensitivity to {} raised the threshold from {previous} to {threshold}",
                step as f32 / 20.0
            );
            previous = threshold;
        }
    }

    #[test]
    fn the_slider_is_spaced_in_decibels_not_in_amplitude() {
        // Loudness is logarithmic. Spaced linearly in amplitude, the whole usable range of a gate
        // - roughly -60 to -25 dBFS - is squeezed into the bottom fifth of the slider, so every
        // position above it is far too aggressive and the control is unusable in its middle.
        let quarter = dbfs(threshold_for(0.25)) - dbfs(threshold_for(0.0));
        let three_quarters = dbfs(threshold_for(0.75)) - dbfs(threshold_for(0.5));
        assert!(
            (quarter - three_quarters).abs() < 1.0,
            "equal slider movements should cost equal decibels: {quarter:.1} dB in the first \
             quarter against {three_quarters:.1} dB in the third"
        );
    }

    #[test]
    fn a_loud_talker_opens_the_gate_at_every_setting() {
        for step in 0..=10 {
            let mut g = Gate::new(voice_activity(step as f32 / 10.0));
            assert!(
                g.step(from_dbfs(SPEECH_PEAK_DBFS)).transmit,
                "clearly audible speech was gated shut at sensitivity {}",
                step as f32 / 10.0
            );
        }
    }

    #[test]
    fn voice_activity_opens_above_the_threshold() {
        let mut g = Gate::new(voice_activity(0.6));
        assert!(g.step(LOUD).transmit);
        assert!(g.step(LOUD).speaking);
    }

    #[test]
    fn voice_activity_stays_shut_below_the_threshold() {
        let mut g = Gate::new(voice_activity(0.6));
        let d = g.step(QUIET);
        assert!(!d.transmit);
        assert!(!d.speaking);
    }

    #[test]
    fn the_gate_holds_open_for_the_release_window() {
        let mut g = Gate::new(voice_activity(0.6));
        g.step(LOUD);

        // 200 ms of release at 10 ms a frame is 20 quiet frames held open. Pauses between words
        // are shorter than this; closing inside them is what clipped words mid-syllable before.
        for frame in 0..20 {
            assert!(g.step(QUIET).transmit, "closed early at frame {frame}");
        }
        assert!(!g.step(QUIET).transmit, "should close after the release window");
    }

    #[test]
    fn a_new_burst_restarts_the_release_window() {
        let mut g = Gate::new(voice_activity(0.6));
        g.step(LOUD);
        for _ in 0..10 {
            g.step(QUIET);
        }
        g.step(LOUD);
        for frame in 0..20 {
            assert!(g.step(QUIET).transmit, "closed early at frame {frame}");
        }
        assert!(!g.step(QUIET).transmit, "the restarted window must also end");
    }

    #[test]
    fn higher_sensitivity_opens_on_quieter_speech() {
        let mut insensitive = Gate::new(voice_activity(0.0));
        let mut sensitive = Gate::new(voice_activity(1.0));
        let faint = 0.005;
        assert!(!insensitive.step(faint).transmit);
        assert!(sensitive.step(faint).transmit);
    }

    #[test]
    fn push_to_talk_ignores_the_signal_level() {
        let mut g = Gate::new(push_to_talk());
        assert!(!g.step(LOUD).transmit, "silent until the key is held");

        g.set_ptt_down(true);
        assert!(g.step(QUIET).transmit, "transmits while held, however quiet");

        g.set_ptt_down(false);
        assert!(!g.step(LOUD).transmit, "stops the moment the key is released");
    }

    #[test]
    fn mute_overrides_push_to_talk() {
        let mut g = Gate::new(push_to_talk());
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
        let mut g = Gate::new(voice_activity(0.6));
        g.step(LOUD);
        g.set_muted(true);
        g.step(LOUD);
        g.set_muted(false);
        assert!(!g.step(QUIET).transmit, "the hold must not survive a mute");
    }

    #[test]
    fn switching_mode_resets_the_gate() {
        let mut g = Gate::new(voice_activity(0.6));
        g.step(LOUD);
        g.set_config(push_to_talk());
        assert!(
            !g.step(LOUD).transmit,
            "a voice-activity hold must not carry into push-to-talk"
        );
    }
}
