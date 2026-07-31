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

/// RMS at which the sensitivity slider's least-sensitive setting opens.
///
/// Matches the constant the JavaScript gate used, so an existing slider position keeps meaning what
/// it meant before.
const MAX_RMS: f32 = 0.05;

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
                let threshold = MAX_RMS * (1.0 - self.config.sensitivity.clamp(0.0, 1.0));
                if rms > threshold {
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
