//! The capture signal path, from device samples to Opus packets.
//!
//! Deliberately free of both hardware and network: it takes a slice of mono `f32` at whatever rate
//! the device runs at and calls back with finished packets. That makes the whole path drivable with
//! synthetic audio, which is where the previous implementation's defects hid - a comb filter and an
//! unstable de-emphasis, neither of them visible without being able to drive the chain directly.

use super::codec::{VoiceEncoder, MAX_PACKET, PACKET_SAMPLES};
use super::denoise::Denoiser;
use super::gate::{Gate, GateConfig};
use super::process::{self, AudioProcessor, NoiseSuppression, ProcessConfig};
use super::resample::Resampler;
use super::{FRAME, SAMPLE_RATE};

/// Opus packets this size or smaller carry no audio - they are DTX's way of saying "still silent".
/// Sending them spends a packet header every 20 ms for nothing.
const DTX_MAX_LEN: usize = 2;

#[derive(Clone, Copy, Debug)]
pub struct ChainConfig {
    pub processing: ProcessConfig,
    pub gate: GateConfig,
    pub bitrate_bps: i32,
    /// What the microphone slider is worth, 0.0-1.0. Applied to what is sent, not to what is
    /// measured: see `process_frame`.
    pub input_gain: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ChainStatus {
    /// Whether the user should be shown as speaking.
    ///
    /// The only speaking signal in the system. It replaces the two independent JavaScript VAD
    /// `AudioContext`s, which disagreed with each other and with the gate that actually decided
    /// what was transmitted.
    pub speaking: bool,
    /// RMS of the most recent frame, 0.0-1.0, for the input meter.
    pub level: f32,
}

pub struct CaptureChain {
    resampler: Option<Resampler>,
    processor: Box<dyn AudioProcessor>,
    denoiser: Denoiser,
    gate: Gate,
    encoder: VoiceEncoder,
    config: ChainConfig,

    /// 48 kHz mono, awaiting 10 ms alignment.
    pending: Vec<f32>,
    /// Whole 10 ms frames, awaiting the 20 ms the encoder wants.
    packet_buffer: Vec<f32>,
    /// One frame of scratch, reused so the audio path allocates nothing per frame.
    frame: Vec<f32>,
    encoded: Vec<u8>,
    last_status: ChainStatus,
}

impl CaptureChain {
    pub fn new(input_hz: u32, config: ChainConfig) -> Result<Self, String> {
        // Skip the resampler entirely at 48 kHz. It is band-limited and therefore not free, and a
        // device already at the pipeline rate is the common case.
        let resampler = if input_hz == SAMPLE_RATE {
            None
        } else {
            Some(Resampler::new(input_hz)?)
        };

        Ok(Self {
            resampler,
            processor: process::create(config.processing),
            denoiser: Denoiser::new(),
            gate: Gate::new(config.gate),
            encoder: VoiceEncoder::new(config.bitrate_bps)?,
            config,
            pending: Vec::with_capacity(SAMPLE_RATE as usize / 10),
            packet_buffer: Vec::with_capacity(PACKET_SAMPLES),
            frame: vec![0.0; FRAME],
            encoded: vec![0; MAX_PACKET],
            last_status: ChainStatus::default(),
        })
    }

    pub fn set_config(&mut self, config: ChainConfig) {
        if config.processing != self.config.processing {
            self.processor.set_config(config.processing);
        }
        self.gate.set_config(config.gate);
        if config.bitrate_bps != self.config.bitrate_bps {
            let _ = self.encoder.set_bitrate(config.bitrate_bps);
        }
        self.config = config;
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.gate.set_muted(muted);
    }

    pub fn set_ptt_down(&mut self, down: bool) {
        self.gate.set_ptt_down(down);
    }

    /// Feed the echo canceller a frame of what is about to be played.
    pub fn render_reference(&mut self, frame: &[f32]) {
        self.processor.process_render(frame);
    }

    /// Push device samples through the chain, calling `on_packet` for each finished Opus packet.
    pub fn push(&mut self, input: &[f32], on_packet: &mut dyn FnMut(&[u8])) -> ChainStatus {
        if input.is_empty() {
            return self.last_status;
        }

        match self.resampler.as_mut() {
            Some(resampler) => resampler.push(input, &mut self.pending),
            None => self.pending.extend_from_slice(input),
        }

        while self.pending.len() >= FRAME {
            self.frame.copy_from_slice(&self.pending[..FRAME]);
            self.pending.drain(..FRAME);
            self.process_frame(on_packet);
        }

        self.last_status
    }

    fn process_frame(&mut self, on_packet: &mut dyn FnMut(&[u8])) {
        // High-pass, echo cancellation, noise suppression, gain control.
        self.processor.process_capture(&mut self.frame);

        // RNNoise on top, only for the aggressive setting. It is a different kind of suppressor -
        // trained on speech, good at irregular noise like keyboards - so it complements the APM's
        // stationary-noise estimate rather than duplicating it.
        if self.config.processing.noise_suppression == NoiseSuppression::Enhanced {
            self.denoiser.process(&mut self.frame);
        }

        // Last line of defence before the encoder. Every upstream stage sanitises its own output,
        // but a single NaN reaching libopus corrupts the packet rather than just sounding wrong.
        for sample in self.frame.iter_mut() {
            if !sample.is_finite() {
                *sample = 0.0;
            }
        }

        let rms = rms(&self.frame);
        let decision = self.gate.step(rms);

        // Silence rather than skip: Opus DTX collapses this to near nothing on its own, the far
        // end's decoder state stays continuous, and speech resumes without a click.
        if !decision.transmit {
            self.frame.iter_mut().for_each(|s| *s = 0.0);
        }

        self.last_status = ChainStatus {
            speaking: decision.speaking,
            level: rms,
        };

        // Applied here, after the gate and after the meter reads `rms`, so the slider changes only
        // how loud everyone else hears you.
        //
        // Ahead of the processor it would fight AGC, which measures the signal and undoes exactly
        // this kind of gain. Ahead of the gate it would double as a second sensitivity control -
        // turning yourself down would stop the gate opening and cut you off entirely - and it would
        // move the input meter, which is the thing people watch while setting the sensitivity
        // slider next to it.
        if self.config.input_gain != 1.0 {
            let gain = self.config.input_gain;
            self.frame.iter_mut().for_each(|s| *s *= gain);
        }

        self.packet_buffer.extend_from_slice(&self.frame);
        if self.packet_buffer.len() < PACKET_SAMPLES {
            return;
        }

        match self
            .encoder
            .encode(&self.packet_buffer[..PACKET_SAMPLES], &mut self.encoded)
        {
            Ok(len) if len > DTX_MAX_LEN => on_packet(&self.encoded[..len]),
            Ok(_) => {}
            Err(e) => eprintln!("[voice] opus encode failed: {e}"),
        }
        self.packet_buffer.clear();
    }
}

/// Root-mean-square of a frame, guarded so a non-finite sample cannot reach the gate.
fn rms(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum: f32 = frame
        .iter()
        .map(|s| if s.is_finite() { s * s } else { 0.0 })
        .sum();
    (sum / frame.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::voice::gate::InputMode;

    fn config() -> ChainConfig {
        ChainConfig {
            processing: ProcessConfig {
                echo_cancellation: false,
                noise_suppression: NoiseSuppression::Off,
                auto_gain: false,
            },
            gate: GateConfig {
                mode: InputMode::VoiceActivity,
                sensitivity: 0.5,
                release_ms: 200,
            },
            bitrate_bps: 64_000,
            input_gain: 1.0,
        }
    }

    /// A loud 440 Hz tone, comfortably above any gate threshold.
    fn tone(samples: usize, start: usize) -> Vec<f32> {
        (0..samples)
            .map(|i| {
                let t = (start + i) as f32 / SAMPLE_RATE as f32;
                (t * 440.0 * std::f32::consts::TAU).sin() * 0.5
            })
            .collect()
    }

    fn collect(chain: &mut CaptureChain, input: &[f32]) -> (Vec<Vec<u8>>, ChainStatus) {
        let mut packets = Vec::new();
        let status = chain.push(input, &mut |p: &[u8]| packets.push(p.to_vec()));
        (packets, status)
    }

    /// Peak amplitude of everything `chain` emits for `input`, decoded back to PCM.
    ///
    /// Round-tripped through Opus rather than inspecting the frame directly, because the gain has
    /// to survive the encoder to be worth anything - the slider's job is what the far end hears.
    fn decoded_peak(chain: &mut CaptureChain, input: &[f32]) -> f32 {
        use super::super::codec::VoiceDecoder;
        let (packets, _) = collect(chain, input);
        let mut decoder = VoiceDecoder::new().unwrap();
        let mut pcm = vec![0.0f32; PACKET_SAMPLES];
        let mut peak = 0.0f32;
        for packet in &packets {
            let n = decoder.decode(packet, &mut pcm).unwrap();
            for s in &pcm[..n] {
                peak = peak.max(s.abs());
            }
        }
        peak
    }

    #[test]
    fn the_input_slider_scales_what_is_sent() {
        let full = decoded_peak(
            &mut CaptureChain::new(SAMPLE_RATE, config()).unwrap(),
            &tone(SAMPLE_RATE as usize / 10, 0),
        );

        let half = decoded_peak(
            &mut CaptureChain::new(
                SAMPLE_RATE,
                ChainConfig {
                    input_gain: 0.5,
                    ..config()
                },
            )
            .unwrap(),
            &tone(SAMPLE_RATE as usize / 10, 0),
        );

        // Opus is lossy, so this is a ratio check with room, not an equality.
        assert!(
            half < full * 0.65 && half > full * 0.35,
            "half gain should roughly halve the peak: full {full}, half {half}"
        );
    }

    #[test]
    fn the_input_slider_does_not_move_the_meter() {
        // The meter sits directly above the sensitivity slider in the UI. If turning the microphone
        // down also moved the meter, the two controls would chase each other: you would lower the
        // volume, watch the bar shrink, and raise the sensitivity to compensate.
        let mut loud = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let mut quiet = CaptureChain::new(
            SAMPLE_RATE,
            ChainConfig {
                input_gain: 0.1,
                ..config()
            },
        )
        .unwrap();

        let input = tone(PACKET_SAMPLES, 0);
        let (_, loud_status) = collect(&mut loud, &input);
        let (_, quiet_status) = collect(&mut quiet, &input);

        assert!(
            (loud_status.level - quiet_status.level).abs() < 1e-6,
            "the meter reads the microphone, not the slider: {} vs {}",
            loud_status.level,
            quiet_status.level
        );
    }

    #[test]
    fn the_input_slider_does_not_double_as_a_gate() {
        // Applied before the gate, a low setting would read as silence and cut transmission
        // entirely - the slider would stop being a volume control and start being a mute.
        let mut chain = CaptureChain::new(
            SAMPLE_RATE,
            ChainConfig {
                input_gain: 0.05,
                ..config()
            },
        )
        .unwrap();

        let (packets, status) = collect(&mut chain, &tone(PACKET_SAMPLES, 0));
        assert!(status.speaking, "a quiet slider is not a closed gate");
        assert_eq!(packets.len(), 1, "and it still transmits");
    }

    #[test]
    fn a_matched_input_rate_needs_no_resampling() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let (packets, _) = collect(&mut chain, &tone(PACKET_SAMPLES, 0));
        assert_eq!(packets.len(), 1, "20 ms of input is exactly one packet");
    }

    #[test]
    fn packets_arrive_once_every_twenty_milliseconds() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        // One second of audio is fifty 20 ms packets.
        let (packets, _) = collect(&mut chain, &tone(SAMPLE_RATE as usize, 0));
        assert_eq!(packets.len(), 50);
    }

    #[test]
    fn a_partial_packet_is_held_until_it_is_complete() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let (packets, _) = collect(&mut chain, &tone(FRAME, 0));
        assert!(packets.is_empty(), "10 ms is half a packet");

        let (packets, _) = collect(&mut chain, &tone(FRAME, FRAME));
        assert_eq!(packets.len(), 1, "the second half completes it");
    }

    #[test]
    fn a_device_at_44100_is_resampled_to_the_pipeline_rate() {
        let mut chain = CaptureChain::new(44_100, config()).unwrap();
        // One second at 44.1 kHz is still one second of audio, so still ~50 packets. The resampler
        // has warm-up latency, so allow a packet or two of slack.
        let (packets, _) = collect(&mut chain, &tone(44_100, 0));
        assert!(
            (48..=50).contains(&packets.len()),
            "expected roughly 50 packets, got {}",
            packets.len()
        );
    }

    #[test]
    fn a_loud_talker_is_reported_as_speaking() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let (_, status) = collect(&mut chain, &tone(PACKET_SAMPLES, 0));
        assert!(status.speaking);
        assert!(status.level > 0.1, "level was {}", status.level);
    }

    #[test]
    fn silence_is_not_reported_as_speaking() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let (_, status) = collect(&mut chain, &vec![0.0f32; SAMPLE_RATE as usize / 2]);
        assert!(!status.speaking);
        assert!(status.level < 0.01);
    }

    #[test]
    fn muting_stops_both_speaking_and_audible_output() {
        // Two seconds, not a fraction of one. DTX needs a few frames to recognise silence, so a
        // short sample is dominated by that convergence and says nothing about the steady state -
        // which is the thing that matters, since a mute may last hours.
        let speech = tone(SAMPLE_RATE as usize * 2, 0);

        let mut open = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let (unmuted, _) = collect(&mut open, &speech);

        let mut muted_chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        muted_chain.set_muted(true);
        let (muted, status) = collect(&mut muted_chain, &speech);

        assert!(!status.speaking, "a muted microphone never shows as speaking");

        // Compared against the same audio unmuted rather than against a fixed byte count. Opus DTX
        // takes a few frames to recognise silence, so the first packets after muting are still full
        // size - what matters is that the stream then collapses, not that every packet is tiny.
        //
        // Measured: 628 bytes muted against 16192 unmuted over two seconds. Most of the muted total
        // is the first half second; after that it settles to roughly 1 kbps of DTX keepalive.
        let muted_bytes: usize = muted.iter().map(|p| p.len()).sum();
        let unmuted_bytes: usize = unmuted.iter().map(|p| p.len()).sum();
        assert!(
            muted_bytes * 10 < unmuted_bytes,
            "muted audio is still being encoded: {muted_bytes} bytes muted vs {unmuted_bytes} unmuted"
        );
    }

    #[test]
    fn push_to_talk_is_closed_until_the_key_is_down() {
        let mut cfg = config();
        cfg.gate.mode = InputMode::PushToTalk;
        let mut chain = CaptureChain::new(SAMPLE_RATE, cfg).unwrap();

        let (_, status) = collect(&mut chain, &tone(PACKET_SAMPLES, 0));
        assert!(!status.speaking, "loud audio alone must not open a PTT gate");

        chain.set_ptt_down(true);
        let (_, status) = collect(&mut chain, &tone(PACKET_SAMPLES, PACKET_SAMPLES));
        assert!(status.speaking);
    }

    #[test]
    fn the_gate_can_be_reconfigured_mid_call() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let mut cfg = config();
        cfg.gate.mode = InputMode::PushToTalk;
        chain.set_config(cfg);

        let (_, status) = collect(&mut chain, &tone(PACKET_SAMPLES, 0));
        assert!(
            !status.speaking,
            "switching to push-to-talk must take effect immediately"
        );
    }

    #[test]
    fn every_packet_fits_the_codec_limit() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let (packets, _) = collect(&mut chain, &tone(SAMPLE_RATE as usize, 0));
        assert!(packets.iter().all(|p| p.len() <= MAX_PACKET));
        assert!(packets.iter().all(|p| !p.is_empty()));
    }

    #[test]
    fn non_finite_input_does_not_break_encoding() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let mut input = tone(PACKET_SAMPLES, 0);
        input[10] = f32::NAN;
        input[11] = f32::INFINITY;

        let (packets, status) = collect(&mut chain, &input);
        assert_eq!(packets.len(), 1, "a poisoned sample must not lose the packet");
        assert!(!packets[0].is_empty());
        assert!(packets[0].len() <= MAX_PACKET);
        assert!(status.level.is_finite(), "level was {}", status.level);
    }

    #[test]
    fn an_empty_push_is_harmless() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let (packets, status) = collect(&mut chain, &[]);
        assert!(packets.is_empty());
        assert!(!status.speaking);
    }

    #[test]
    fn enhanced_noise_suppression_still_produces_packets() {
        let mut cfg = config();
        cfg.processing.noise_suppression = NoiseSuppression::Enhanced;
        let mut chain = CaptureChain::new(SAMPLE_RATE, cfg).unwrap();
        let (packets, _) = collect(&mut chain, &tone(SAMPLE_RATE as usize / 2, 0));
        assert!(
            !packets.is_empty(),
            "the RNNoise stage must not swallow the stream"
        );
    }

    /// A tone with a speech-like envelope: two 250 ms bursts a second, not a continuous sine.
    ///
    /// Continuous anything is what a noise suppressor is built to remove - it estimates the
    /// *stationary* part of the spectrum and subtracts it - so a steady tone through the real APM
    /// would fade out on its own and say nothing about whether speech survives.
    fn speech_like(samples: usize) -> Vec<f32> {
        (0..samples)
            .map(|i| {
                let t = i as f32 / SAMPLE_RATE as f32;
                let speaking = (t * 2.0).fract() < 0.5;
                if speaking {
                    (t * 440.0 * std::f32::consts::TAU).sin() * 0.5
                } else {
                    0.0
                }
            })
            .collect()
    }

    /// The chain configured the way the client actually ships it.
    ///
    /// Every other test in this module runs with echo cancellation, noise suppression and gain
    /// control all switched *off*, which means they run against `process::Passthrough` whether or
    /// not the `aec` feature is compiled in. The shipped default is the opposite of that on all
    /// three counts, so the one configuration users actually run was the one configuration nothing
    /// covered - and with `aec` on, `process_capture` is the first stage the signal meets.
    ///
    /// Gated on the feature because that is precisely the difference under test: a build without it
    /// gets the passthrough and cannot say anything about the build that does not.
    #[cfg(feature = "aec")]
    #[test]
    fn the_shipped_processing_defaults_still_let_speech_through() {
        let mut chain = CaptureChain::new(
            SAMPLE_RATE,
            ChainConfig {
                processing: ProcessConfig::default(),
                ..config()
            },
        )
        .unwrap();

        // Two seconds, so the APM's adaptive stages have converged before the measurement matters.
        let peak = decoded_peak(&mut chain, &speech_like(SAMPLE_RATE as usize * 2));
        assert!(
            peak > 0.05,
            "with the shipped processing defaults the far end receives a peak of {peak}, which is \
             silence - the capture chain is being emptied before it reaches the encoder"
        );
    }

    #[test]
    fn input_arriving_in_ragged_chunks_still_packetises_cleanly() {
        // A device buffer is not a multiple of anything in particular, so the chain must not assume
        // it lines up with either the 10 ms frame or the 20 ms packet.
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let mut packets = Vec::new();
        let mut offset = 0;
        for chunk in [173usize, 401, 97, 1024, 55].iter().cycle().take(40) {
            let input = tone(*chunk, offset);
            offset += chunk;
            chain.push(&input, &mut |p: &[u8]| packets.push(p.to_vec()));
        }
        // Whatever the chunking, the packet count must track the total duration.
        let expected = offset / PACKET_SAMPLES;
        assert!(
            packets.len() == expected || packets.len() + 1 == expected,
            "fed {offset} samples, expected about {expected} packets, got {}",
            packets.len()
        );
    }
}
