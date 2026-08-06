//! An adaptive jitter buffer for received voice packets.
//!
//! `webrtc-rs` hands over RTP; it has no NetEq equivalent. This decides, for each playout slot,
//! whether to decode a packet, reconstruct a lost one from the next packet's in-band FEC, or
//! conceal.
//!
//! The target delay tracks observed arrival jitter: too small and the buffer runs dry on a bad
//! network, too large and the call feels sluggish. It is bounded at both ends so that neither
//! failure mode can run away.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Packet {
    pub seq: u16,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pop {
    /// This slot's packet is here; decode it normally.
    Decode(Packet),
    /// This slot's packet is lost, but its successor is here and carries an FEC copy of it.
    DecodeFec(Packet),
    /// Nothing to work with; run packet-loss concealment.
    Conceal,
}

#[derive(Clone, Copy, Debug)]
pub struct JitterConfig {
    pub min_delay_ms: u32,
    pub max_delay_ms: u32,
    pub start_delay_ms: u32,
    pub packet_ms: u32,
}

impl Default for JitterConfig {
    fn default() -> Self {
        Self {
            min_delay_ms: 20,
            max_delay_ms: 500,
            start_delay_ms: 60,
            packet_ms: 20,
        }
    }
}

pub struct JitterBuffer {
    config: JitterConfig,
    /// Keyed by *unwrapped* sequence, so ordering is plain integer ordering.
    packets: BTreeMap<u64, Packet>,
    /// Next unwrapped sequence to play, or `None` before playout starts.
    cursor: Option<u64>,
    /// Highest unwrapped sequence seen, used to unwrap subsequent arrivals.
    highest: Option<u64>,
    target_delay_ms: u32,
    /// Smoothed inter-arrival deviation, after RFC 3550's jitter estimate.
    jitter_ms: f32,
    last_arrival_ms: Option<u64>,
    last_seq_unwrapped: Option<u64>,
    /// Consecutive concealed slots with nothing at all buffered.
    ///
    /// See [`JitterBuffer::pop`]: this is what stops the cursor running away from a sender that has
    /// stopped transmitting.
    starved_slots: u32,
}

/// How long playout may conceal with an empty buffer before it gives up its position in the stream.
///
/// The bug this exists for: the cursor advances one slot per concealed frame, forever, while a
/// sender that is silent consumes **no** sequence numbers at all - `chain::process_frame` drops
/// Opus DTX packets rather than transmitting them. So every second of silence puts the cursor 50
/// sequence numbers ahead of the talker. When they speak again every packet satisfies `seq <
/// cursor`, `push` discards it, and because the cursor only moves forward the gap never closes:
/// that participant is inaudible for the rest of the call, having been perfectly audible for the
/// first sentence.
///
/// It is invisible from every counter above it - the packets arrive, match their mid and are routed
/// to the right participant - which is why this presented as "I could hear them at first, quietly,
/// and then it stopped".
///
/// Only desktop-to-desktop pairs hit it. A client that transmits continuously, comfort noise and
/// all, keeps its sequence numbers in step with the cursor and stays audible, which is exactly why
/// the same receiver could hear a phone throughout and a second desktop only until its first pause.
///
/// 400 ms is comfortably longer than any gap a live sender leaves between packets (the encoder
/// emits one every 20 ms while there is sound) and short enough that resuming costs one re-priming
/// of the start delay rather than a noticeable clip.
const STARVED_SLOTS_BEFORE_RESYNC_MS: u32 = 400;

/// The longest silence between two arrivals still treated as one continuous stream.
///
/// Beyond this the stream stopped and restarted, and the pair of packets either side says nothing
/// about the network. See [`JitterBuffer::update_jitter`].
///
/// Deliberately a *time* threshold rather than a sequence-number one. Silence suppression does not
/// skip sequence numbers - it stops emitting entirely - so the packet that ends a four second pause
/// is the very next number in the stream, and no sequence-based test can tell it apart from a
/// packet that arrived on schedule. Only the clock shows the gap.
///
/// 200 ms is an order of magnitude above the jitter a working connection produces and an order of
/// magnitude below the pause between two sentences.
const CONTINUOUS_ARRIVAL_GAP_MS: i64 = 200;

impl JitterBuffer {
    pub fn new(config: JitterConfig) -> Self {
        Self {
            target_delay_ms: config
                .start_delay_ms
                .clamp(config.min_delay_ms, config.max_delay_ms),
            config,
            packets: BTreeMap::new(),
            cursor: None,
            highest: None,
            jitter_ms: 0.0,
            last_arrival_ms: None,
            last_seq_unwrapped: None,
            starved_slots: 0,
        }
    }

    /// Extend a 16-bit sequence number into a monotonic 64-bit one.
    ///
    /// Without this, ordering breaks every 65536 packets - roughly every 22 minutes at 50 packets a
    /// second, which is well inside the length of a real call.
    fn unwrap_seq(&self, seq: u16) -> u64 {
        let Some(highest) = self.highest else {
            return seq as u64;
        };
        let base = (highest & !0xFFFF) as i64;
        let candidates = [base + seq as i64, base + 0x1_0000 + seq as i64, base - 0x1_0000 + seq as i64];
        let best = candidates
            .iter()
            .copied()
            .filter(|c| *c >= 0)
            .min_by_key(|c| (c - highest as i64).abs())
            .unwrap_or(seq as i64);
        best as u64
    }

    pub fn push(&mut self, packet: Packet, arrival_ms: u64) {
        let seq = self.unwrap_seq(packet.seq);

        // Already played: re-buffering it would rewind playout.
        if let Some(cursor) = self.cursor {
            if seq < cursor {
                return;
            }
        }
        if self.packets.contains_key(&seq) {
            return;
        }

        self.update_jitter(seq, arrival_ms);
        self.highest = Some(self.highest.map_or(seq, |h| h.max(seq)));
        self.packets.insert(seq, packet);
        self.enforce_bound();
    }

    /// RFC 3550's jitter estimate, in milliseconds: the smoothed deviation between how far apart
    /// packets were sent and how far apart they arrived.
    fn update_jitter(&mut self, seq: u64, arrival_ms: u64) {
        if let (Some(last_arrival), Some(last_seq)) = (self.last_arrival_ms, self.last_seq_unwrapped)
        {
            // A talker who stopped is not a jittery network.
            //
            // RFC 3550's estimate assumes packets keep flowing: it compares how far apart two
            // packets were *sent* with how far apart they *arrived*. `chain::process_frame` sends
            // nothing at all while its speaker is silent, so the packet after a pause is `seq + 1` -
            // expected 20 ms later - and turns up whole seconds afterwards. The estimator reads
            // that as several seconds of jitter and pins the target delay to its ceiling, which
            // then demands a full half second of buffered audio before playout will restart. The
            // buffer fills, the level stays at zero, and the participant is inaudible with packets
            // visibly queueing up behind them.
            //
            // A gap this large is a discontinuity, not a measurement. Re-anchor and take no sample.
            let actual = arrival_ms as i64 - last_arrival as i64;
            if actual > CONTINUOUS_ARRIVAL_GAP_MS {
                self.last_arrival_ms = Some(arrival_ms);
                self.last_seq_unwrapped = Some(seq);
                return;
            }

            let expected = (seq as i64 - last_seq as i64) * self.config.packet_ms as i64;
            let deviation = (actual - expected).abs() as f32;
            self.jitter_ms += (deviation - self.jitter_ms) / 16.0;

            // Three deviations covers the overwhelming majority of arrivals without chasing a
            // single outlier all the way to the ceiling.
            let wanted = (self.jitter_ms * 3.0) as u32 + self.config.packet_ms;
            self.target_delay_ms = wanted.clamp(self.config.min_delay_ms, self.config.max_delay_ms);
        }
        self.last_arrival_ms = Some(arrival_ms);
        self.last_seq_unwrapped = Some(seq);
    }

    /// Cap the buffer at twice the maximum delay. A consumer that stalls must not be able to turn
    /// this into an unbounded allocation.
    fn enforce_bound(&mut self) {
        let cap = ((self.config.max_delay_ms / self.config.packet_ms) * 2).max(4) as usize;
        while self.packets.len() > cap {
            let oldest = *self.packets.keys().next().expect("len > cap implies non-empty");
            self.packets.remove(&oldest);
            // Playout has effectively skipped past the dropped packet.
            if self.cursor.is_some_and(|c| c <= oldest) {
                self.cursor = Some(oldest + 1);
            }
        }
    }

    /// Take the next playout slot.
    pub fn pop(&mut self) -> Pop {
        let cursor = match self.cursor {
            Some(cursor) => cursor,
            None => {
                // Playout has not started. Wait until the starting target is buffered, so there is
                // something in hand to absorb the first late arrival.
                let buffered_ms = self.packets.len() as u32 * self.config.packet_ms;
                if buffered_ms < self.target_delay_ms {
                    return Pop::Conceal;
                }
                let first = *self
                    .packets
                    .keys()
                    .next()
                    .expect("buffered_ms > 0 implies non-empty");
                self.cursor = Some(first);
                first
            }
        };

        if let Some(packet) = self.packets.remove(&cursor) {
            self.cursor = Some(cursor + 1);
            self.starved_slots = 0;
            return Pop::Decode(packet);
        }

        // The slot's packet is missing. Opus's in-band FEC puts a coarse copy of each frame inside
        // the *next* packet, so if that one is here the loss is recoverable.
        if let Some(next) = self.packets.get(&(cursor + 1)) {
            self.cursor = Some(cursor + 1);
            return Pop::DecodeFec(next.clone());
        }

        // Nothing to play and nothing waiting. Keep advancing for a while - a packet that is merely
        // late still belongs at its own slot - but do not do it indefinitely. Past the threshold,
        // give the position up entirely: `cursor = None` puts playout back into its pre-roll state,
        // so the next packet to arrive defines a fresh slot instead of being discarded for sitting
        // behind a cursor that walked off on its own. See the constant's note for what that fixes.
        if self.packets.is_empty() {
            self.starved_slots += 1;
            if self.starved_slots * self.config.packet_ms >= STARVED_SLOTS_BEFORE_RESYNC_MS {
                self.cursor = None;
                self.starved_slots = 0;
                // Re-priming reads `target_delay_ms`, so it has to describe the *next* stretch of
                // audio rather than the silence that just ended. Left alone it would still hold
                // whatever the pause inflated it to, and playout would then wait for that much
                // audio to pile up before making a sound - which is the difference between a talker
                // who resumes cleanly and one who resumes half a second late, or not at all.
                self.jitter_ms = 0.0;
                self.target_delay_ms = self
                    .config
                    .start_delay_ms
                    .clamp(self.config.min_delay_ms, self.config.max_delay_ms);
                self.last_arrival_ms = None;
                self.last_seq_unwrapped = None;
                return Pop::Conceal;
            }
        } else {
            // The buffer is not empty, so this slot is a genuine gap in an active stream rather
            // than a talker who has stopped. Concealment is the right answer and the cursor should
            // stay where it is.
            self.starved_slots = 0;
        }

        self.cursor = Some(cursor + 1);
        Pop::Conceal
    }

    pub fn target_delay_ms(&self) -> u32 {
        self.target_delay_ms
    }

    pub fn len(&self) -> usize {
        self.packets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.packets.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> JitterConfig {
        JitterConfig::default()
    }

    fn packet(seq: u16) -> Packet {
        Packet {
            seq,
            payload: vec![seq as u8],
        }
    }

    /// Fill the buffer to its starting target so `pop` will hand packets out.
    fn primed(buf: &mut JitterBuffer, from: u16, arrival: &mut u64) {
        for i in 0..(config().start_delay_ms / config().packet_ms) {
            buf.push(packet(from.wrapping_add(i as u16)), *arrival);
            *arrival += config().packet_ms as u64;
        }
    }

    /// A pause in speech is not evidence about the network.
    ///
    /// RFC 3550's jitter estimate compares send spacing against arrival spacing, which only means
    /// anything while packets keep flowing. Silence suppression breaks that assumption completely:
    /// the packet after a pause is the very next sequence number, "expected" 20 ms later, and turns
    /// up seconds afterwards. Fed to the estimator that reads as seconds of jitter and pins the
    /// target delay to its ceiling - so playout then refuses to start until half a second of audio
    /// has piled up, and a talker who pauses often is heard in bursts or not at all.
    ///
    /// This is the second half of the same fault as
    /// [`a_talker_who_pauses_is_audible_again_when_they_resume`]: that one covers the packets being
    /// discarded, this one covers them arriving and still not being played.
    #[test]
    fn a_pause_does_not_inflate_the_target_delay() {
        let mut buf = JitterBuffer::new(config());
        let mut arrival = 0u64;

        primed(&mut buf, 0, &mut arrival);
        for _ in 0..(config().start_delay_ms / config().packet_ms) {
            buf.pop();
        }
        let settled = buf.target_delay_ms();

        // Four seconds of silence, then the next packet in sequence.
        arrival += 4_000;
        let resume = (config().start_delay_ms / config().packet_ms) as u16;
        buf.push(packet(resume), arrival);

        assert_eq!(
            buf.target_delay_ms(),
            settled,
            "a four second pause was measured as network jitter and inflated the target delay to \
             {}ms - playout will now wait for that much audio before making a sound",
            buf.target_delay_ms()
        );
    }

    /// A talker who pauses is still audible when they resume.
    ///
    /// The regression that made two desktop clients unable to hear each other after the first
    /// sentence. Playout advances the cursor once per concealed slot, but a silent sender consumes
    /// **no** sequence numbers - `chain::process_frame` drops Opus DTX rather than transmitting it -
    /// so a pause walks the cursor past everything the talker will send next. Every packet then
    /// fails `seq < cursor` in `push` and is dropped, permanently, because the cursor only moves
    /// forward.
    ///
    /// Nothing above this could see it: the packets arrived, matched their mid, and were routed to
    /// the right participant. It presented as "I heard them at first, quietly, and then it stopped",
    /// and only against another client that also suppresses silence - a peer transmitting
    /// continuously keeps its sequence numbers in step with the cursor and stays audible.
    #[test]
    fn a_talker_who_pauses_is_audible_again_when_they_resume() {
        let mut buf = JitterBuffer::new(config());
        let mut arrival = 0u64;

        // A first sentence, heard normally.
        primed(&mut buf, 100, &mut arrival);
        assert!(matches!(buf.pop(), Pop::Decode(_)), "the first packet must play");

        // Five seconds of silence. The sender transmits nothing at all, so its sequence numbers
        // stand still while playout keeps asking for the next slot 50 times a second.
        for _ in 0..(5_000 / config().packet_ms) {
            buf.pop();
        }

        // They speak again, resuming from where their sequence numbers left off.
        let resume = 100 + (config().start_delay_ms / config().packet_ms) as u16;
        for i in 0..(config().start_delay_ms / config().packet_ms) {
            buf.push(packet(resume.wrapping_add(i as u16)), arrival);
            arrival += config().packet_ms as u64;
        }

        assert!(
            !buf.is_empty(),
            "the resumed packets were discarded on arrival - the cursor ran away during the pause"
        );

        // And they are actually played, rather than merely buffered.
        let played = (0..10).filter(|_| matches!(buf.pop(), Pop::Decode(_))).count();
        assert!(
            played > 0,
            "the resumed audio never reached the decoder, so this talker is silent for the rest of \
             the call"
        );
    }

    fn payload_of(pop: Pop) -> Option<u8> {
        match pop {
            Pop::Decode(p) => Some(p.payload[0]),
            _ => None,
        }
    }

    #[test]
    fn holds_packets_until_the_start_delay_is_buffered() {
        let mut buf = JitterBuffer::new(config());
        buf.push(packet(1), 0);
        // One packet is less than the 60 ms starting target; playing it immediately would leave
        // nothing in hand to absorb the next late arrival.
        assert_eq!(buf.pop(), Pop::Conceal);
    }

    #[test]
    fn delivers_packets_in_order() {
        let mut buf = JitterBuffer::new(config());
        let mut t = 0;
        primed(&mut buf, 1, &mut t);
        assert_eq!(payload_of(buf.pop()), Some(1));
        assert_eq!(payload_of(buf.pop()), Some(2));
        assert_eq!(payload_of(buf.pop()), Some(3));
    }

    #[test]
    fn reorders_packets_that_arrive_out_of_sequence() {
        let mut buf = JitterBuffer::new(config());
        buf.push(packet(1), 0);
        buf.push(packet(3), 20);
        buf.push(packet(2), 40);
        assert_eq!(payload_of(buf.pop()), Some(1));
        assert_eq!(payload_of(buf.pop()), Some(2));
        assert_eq!(payload_of(buf.pop()), Some(3));
    }

    #[test]
    fn ignores_duplicates() {
        let mut buf = JitterBuffer::new(config());
        buf.push(packet(1), 0);
        buf.push(packet(1), 5);
        buf.push(packet(2), 20);
        assert_eq!(buf.len(), 2);
    }

    #[test]
    fn recovers_a_gap_from_the_following_packet_via_fec() {
        let mut buf = JitterBuffer::new(config());
        // 2 never arrives, but 3 does - and an Opus packet carries an FEC copy of its predecessor,
        // so the gap is recoverable rather than something to conceal.
        buf.push(packet(1), 0);
        buf.push(packet(3), 20);
        buf.push(packet(4), 40);

        assert_eq!(payload_of(buf.pop()), Some(1));
        match buf.pop() {
            Pop::DecodeFec(p) => assert_eq!(p.seq, 3, "seq 2 is recovered from seq 3"),
            other => panic!("expected DecodeFec, got {other:?}"),
        }
    }

    #[test]
    fn conceals_when_neither_the_packet_nor_its_successor_is_available() {
        let mut buf = JitterBuffer::new(config());
        buf.push(packet(1), 0);
        buf.push(packet(4), 20);
        buf.push(packet(5), 40);
        assert_eq!(payload_of(buf.pop()), Some(1));
        // 2 is missing and so is 3, so there is no FEC copy of 2 to recover from.
        assert_eq!(buf.pop(), Pop::Conceal);
    }

    #[test]
    fn drops_a_packet_that_arrives_after_its_slot_has_played() {
        let mut buf = JitterBuffer::new(config());
        let mut t = 0;
        primed(&mut buf, 1, &mut t);
        buf.pop(); // 1
        buf.pop(); // 2

        let before = buf.len();
        buf.push(packet(1), t); // far too late
        assert_eq!(before, buf.len(), "a played packet must not be re-buffered");
    }

    #[test]
    fn handles_sequence_number_wraparound() {
        let mut buf = JitterBuffer::new(config());
        buf.push(packet(65_534), 0);
        buf.push(packet(65_535), 20);
        buf.push(packet(0), 40);
        buf.push(packet(1), 60);

        assert_eq!(payload_of(buf.pop()), Some(65_534u16 as u8));
        assert_eq!(payload_of(buf.pop()), Some(65_535u16 as u8));
        assert_eq!(payload_of(buf.pop()), Some(0));
        assert_eq!(payload_of(buf.pop()), Some(1));
    }

    #[test]
    fn target_delay_starts_at_the_configured_value() {
        let buf = JitterBuffer::new(config());
        assert_eq!(buf.target_delay_ms(), 60);
    }

    #[test]
    fn target_delay_grows_when_arrivals_are_jittery() {
        let mut buf = JitterBuffer::new(config());
        // Packets are sent 20 ms apart but arrive between 5 ms and 90 ms apart.
        let arrivals = [0u64, 5, 95, 100, 190, 195, 285, 290, 380, 385, 475, 480];
        for (i, &t) in arrivals.iter().enumerate() {
            buf.push(packet(i as u16 + 1), t);
        }
        assert!(
            buf.target_delay_ms() > config().packet_ms,
            "target {} should exceed one packet under jitter",
            buf.target_delay_ms()
        );
    }

    #[test]
    fn target_delay_never_leaves_its_bounds() {
        let mut buf = JitterBuffer::new(config());
        // Pathological jitter: seconds apart.
        for i in 0..40u16 {
            buf.push(packet(i + 1), i as u64 * 3_000);
        }
        assert!(buf.target_delay_ms() <= 500);

        let mut steady = JitterBuffer::new(config());
        for i in 0..200u16 {
            steady.push(packet(i + 1), i as u64 * 20);
            steady.pop();
        }
        assert!(
            steady.target_delay_ms() >= 20,
            "must not fall below the floor"
        );
    }

    #[test]
    fn the_buffer_is_bounded_when_nothing_pops() {
        let mut buf = JitterBuffer::new(config());
        for i in 0..10_000u32 {
            buf.push(
                Packet {
                    seq: i as u16,
                    payload: vec![0],
                },
                i as u64 * 20,
            );
        }
        // A consumer that stalls must not turn the buffer into an unbounded memory leak.
        let max_packets = (500 / 20) * 2;
        assert!(
            buf.len() <= max_packets as usize,
            "buffer grew to {}",
            buf.len()
        );
    }
}
