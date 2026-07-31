//! One remote participant's audio, from RTP payload to mixable frames.
//!
//! Owns a jitter buffer and a decoder, and resolves the rate mismatch between them: Opus arrives in
//! 20 ms packets, the mixer consumes 10 ms frames. The buffer is popped once per *packet* and the
//! decoded result handed out in halves. Popping once per frame would drain it at twice the arrival
//! rate and leave it permanently in concealment - which sounds like a robot voice that never
//! recovers, and looks like a network problem rather than a bug.

use super::codec::{VoiceDecoder, PACKET_SAMPLES};
use super::jitter::{JitterBuffer, JitterConfig, Packet, Pop};
use super::FRAME;

/// Level smoothing, and the threshold the speaking indicator trips at.
///
/// Slower to fall than to rise, so the indicator does not flicker between syllables - the same shape
/// as the capture gate's release, for the same reason.
const LEVEL_ATTACK: f32 = 0.4;
const LEVEL_RELEASE: f32 = 0.05;
const SPEAKING_THRESHOLD: f32 = 0.015;

/// How many 10 ms frames one Opus packet yields. Not a tunable: it is `PACKET_SAMPLES / FRAME`, and
/// named only so the halving logic below reads as arithmetic rather than a magic 2.
const FRAMES_PER_PACKET: usize = PACKET_SAMPLES / FRAME;

pub struct RemoteSource {
    buffer: JitterBuffer,
    decoder: VoiceDecoder,
    /// The most recently decoded packet. Handed out `FRAME` samples at a time.
    decoded: Vec<f32>,
    /// Which slice of `decoded` goes out next. Zero means "pop and decode first".
    next_half: usize,
    frame: Vec<f32>,
    level: f32,
}

impl RemoteSource {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            buffer: JitterBuffer::new(JitterConfig::default()),
            decoder: VoiceDecoder::new()?,
            decoded: vec![0.0; PACKET_SAMPLES],
            next_half: 0,
            frame: vec![0.0; FRAME],
            level: 0.0,
        })
    }

    pub fn push(&mut self, packet: Packet, arrival_ms: u64) {
        self.buffer.push(packet, arrival_ms);
    }

    /// The next 10 ms of this participant's audio. Always exactly `FRAME` samples, concealed if
    /// nothing has arrived - the mixer has no way to represent "nothing" and must not be given a
    /// short slice.
    pub fn next_frame(&mut self) -> &[f32] {
        if self.next_half == 0 {
            self.decode_next_packet();
        }

        let start = self.next_half * FRAME;
        self.frame
            .copy_from_slice(&self.decoded[start..start + FRAME]);
        self.next_half = (self.next_half + 1) % FRAMES_PER_PACKET;

        self.update_level();
        &self.frame
    }

    /// Smoothed RMS, for the remote speaking indicator.
    pub fn level(&self) -> f32 {
        self.level
    }

    pub fn speaking(&self) -> bool {
        self.level > SPEAKING_THRESHOLD
    }

    #[cfg(test)]
    pub fn buffered_packets(&self) -> usize {
        self.buffer.len()
    }

    fn decode_next_packet(&mut self) {
        let decoded = match self.buffer.pop() {
            Pop::Decode(packet) => self.decoder.decode(&packet.payload, &mut self.decoded),
            // In-band FEC: the lost packet's audio rides inside its successor, so a single drop
            // costs quality rather than a gap. This is what the encoder's useinbandfec=1 buys.
            Pop::DecodeFec(next) => self.decoder.decode_fec(&next.payload, &mut self.decoded),
            Pop::Conceal => self.decoder.conceal(&mut self.decoded),
        };

        match decoded {
            Ok(n) if n == PACKET_SAMPLES => {}
            // A short decode would otherwise leave the tail of the *previous* packet in place, which
            // is an audible repeat. Silence is the honest answer.
            Ok(n) => self.decoded[n..].fill(0.0),
            Err(e) => {
                eprintln!("[voice] decode failed: {e}");
                self.decoded.fill(0.0);
            }
        }

        // One NaN here reaches the mixer, and from there every participant's audio at once.
        for sample in self.decoded.iter_mut() {
            if !sample.is_finite() {
                *sample = 0.0;
            }
        }
    }

    fn update_level(&mut self) {
        let sum: f32 = self.frame.iter().map(|s| s * s).sum();
        let rms = (sum / self.frame.len() as f32).sqrt();
        let coefficient = if rms > self.level {
            LEVEL_ATTACK
        } else {
            LEVEL_RELEASE
        };
        self.level += (rms - self.level) * coefficient;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::voice::codec::{VoiceEncoder, MAX_PACKET};

    /// 20 ms of real Opus, encoded from a tone so the decoder has something to work with.
    fn tone_packet(seq: u16) -> Packet {
        let mut encoder = VoiceEncoder::new(64_000).unwrap();
        let pcm: Vec<f32> = (0..PACKET_SAMPLES)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.3)
            .collect();
        let mut out = vec![0u8; MAX_PACKET];
        let n = encoder.encode(&pcm, &mut out).unwrap();
        out.truncate(n);
        Packet { seq, payload: out }
    }

    /// Push enough packets to clear the buffer's start delay, then drain past it.
    fn primed() -> RemoteSource {
        let mut source = RemoteSource::new().unwrap();
        for seq in 0..20 {
            source.push(tone_packet(seq), seq as u64 * 20);
        }
        source
    }

    #[test]
    fn one_packet_yields_two_frames() {
        // The 20ms/10ms split, which is the entire reason this type exists. Four frames must consume
        // exactly two packets; consuming four would be the bug this guards.
        let mut source = primed();
        let before = source.buffered_packets();
        for _ in 0..4 {
            assert_eq!(source.next_frame().len(), FRAME);
        }
        let consumed = before - source.buffered_packets();
        assert_eq!(consumed, 2, "four 10ms frames must come from two 20ms packets");
    }

    #[test]
    fn output_is_always_a_full_frame_even_with_nothing_buffered() {
        let mut source = RemoteSource::new().unwrap();
        for _ in 0..5 {
            assert_eq!(
                source.next_frame().len(),
                FRAME,
                "concealment must still fill the frame"
            );
        }
    }

    #[test]
    fn silence_reads_as_not_speaking() {
        let mut source = RemoteSource::new().unwrap();
        for _ in 0..20 {
            source.next_frame();
        }
        assert!(!source.speaking());
        assert!(source.level() < 0.01, "level was {}", source.level());
    }

    #[test]
    fn a_tone_reads_as_speaking() {
        let mut source = primed();
        for _ in 0..20 {
            source.next_frame();
        }
        assert!(source.speaking(), "level was {}", source.level());
    }

    #[test]
    fn output_is_always_finite_even_from_a_corrupt_payload() {
        let mut source = RemoteSource::new().unwrap();
        source.push(
            Packet {
                seq: 0,
                payload: vec![0xff; 40],
            },
            0,
        );
        for _ in 0..6 {
            assert!(source.next_frame().iter().all(|s| s.is_finite()));
        }
    }

    #[test]
    fn a_duplicate_sequence_number_is_not_buffered_twice() {
        let mut source = RemoteSource::new().unwrap();
        source.push(tone_packet(0), 0);
        source.push(tone_packet(0), 5);
        assert_eq!(source.buffered_packets(), 1);
    }

    #[test]
    fn the_level_falls_back_to_silence_after_a_talker_stops() {
        // Guards the release path: an indicator that latches on is worse than none, because it
        // reads as "this person is talking and you cannot hear them".
        let mut source = primed();
        for _ in 0..20 {
            source.next_frame();
        }
        assert!(source.speaking());

        // Nothing more arrives; concealment fades and then silence.
        for _ in 0..200 {
            source.next_frame();
        }
        assert!(!source.speaking(), "level stayed at {}", source.level());
    }
}
