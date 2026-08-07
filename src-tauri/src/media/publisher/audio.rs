//! The audio half of a screen share: system loopback in, Opus packets out.
//!
//! A share can carry the shared application's own sound, and that is a *separate track* from the
//! publisher's microphone - `screen-audio-{shareId}` alongside `screen-{shareId}`, tied together by
//! the share id. The two halves are published on one session and in one negotiation, so a viewer
//! learns about both at once.
//!
//! This module owns capture and encoding only. The track and the writer task live in
//! [`super::rtc`] and [`super::session`], mirroring how the video half is split.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::media::audio::{spawn_loopback, LoopbackSink, BATCH_SAMPLES};
use crate::media::voice::codec::{VoiceEncoder, MAX_PACKET, PACKET_SAMPLES};

/// Bitrate for a share's own sound.
///
/// Well above the 64 kbps a voice call uses, because this is usually music or game audio rather
/// than speech, and mono Opus at this rate is transparent enough that nobody asks about it.
pub const SCREEN_AUDIO_BPS: i32 = 96_000;

/// How many encoded packets may wait for the writer.
///
/// Eight packets is 160 ms. Same policy as the video pump and for the same reason: a full queue
/// drops rather than blocks, because the producer here is a real-time audio callback and blocking
/// it does not delay one packet, it glitches the capture device.
const PACKET_QUEUE: usize = 8;

/// One encoded Opus packet and the span of audio it represents.
pub type OpusPacket = Vec<u8>;

/// Counters for the audio half, for the same reason the video pump has them: an aggregate "it is
/// running" says nothing about whether anything is arriving.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ScreenAudioStats {
    pub packets_encoded: u64,
    pub packets_dropped: u64,
}

/// Accumulates loopback batches into Opus packets.
///
/// `LoopbackSink::on_batch` takes `&self` because it is called from the capture thread, so the
/// encoder and its leftovers sit behind a mutex. It is never contended in practice - one capture
/// thread is the only caller - and holding it across an encode is cheaper than the channel hop the
/// alternative would need.
struct EncodingSink {
    encoder: Mutex<EncoderState>,
    packets: tokio::sync::mpsc::Sender<OpusPacket>,
    encoded: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    /// The sharer muted their share's sound locally.
    ///
    /// Enforced here rather than by stopping the capture: restarting a WASAPI client is slow enough
    /// to be audible as a gap on unmute, and the device staying open is what makes the toggle feel
    /// instant. Sending nothing is what mute *is* on the wire - DTX is off for shared media, so
    /// silence would otherwise still cost packets.
    muted: Arc<AtomicBool>,
}

struct EncoderState {
    encoder: VoiceEncoder,
    /// Samples left over from the previous batch.
    ///
    /// A batch is 40 ms and a packet is 20 ms, so today this is always empty at the end of a batch.
    /// Carried anyway rather than asserting the ratio: the batch size belongs to the capture path
    /// and changing it there must not silently start dropping the tail of every batch here.
    pending: Vec<f32>,
    out: Vec<u8>,
}

impl LoopbackSink for EncodingSink {
    fn on_batch(&self, pcm: &[f32]) -> bool {
        let Ok(mut state) = self.encoder.lock() else {
            return false;
        };
        if self.muted.load(Ordering::Relaxed) {
            // Dropped rather than buffered. Keeping muted audio would replay it on unmute, seconds
            // late, which is worse than the gap.
            state.pending.clear();
            return !self.packets.is_closed();
        }
        state.pending.extend_from_slice(pcm);

        while state.pending.len() >= PACKET_SAMPLES {
            let frame: Vec<f32> = state.pending.drain(..PACKET_SAMPLES).collect();
            let state = &mut *state;
            let size = match state.encoder.encode(&frame, &mut state.out) {
                Ok(n) => n,
                Err(e) => {
                    // One bad packet is not a reason to tear down a share. The device keeps
                    // producing and the next packet is very likely fine.
                    eprintln!("[publisher] screen audio encode failed: {e}");
                    continue;
                }
            };

            match self.packets.try_send(state.out[..size].to_vec()) {
                Ok(()) => {
                    self.encoded.fetch_add(1, Ordering::Relaxed);
                }
                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                }
                // The writer is gone, so the publication has ended. Stop the device.
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => return false,
            }
        }

        true
    }
}

/// Clonable because the Windows capture path needs a second copy for its cpal fallback.
impl Clone for EncodingSinkHandle {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

/// Shared handle, so the capture backends can hold the sink by value and still share one encoder.
pub struct EncodingSinkHandle(Arc<EncodingSink>);

impl LoopbackSink for EncodingSinkHandle {
    fn on_batch(&self, pcm: &[f32]) -> bool {
        self.0.on_batch(pcm)
    }
}

/// A running screen-audio capture. Dropping it does not stop the device; call [`Self::stop`].
pub struct ScreenAudioCapture {
    stop: Arc<AtomicBool>,
    encoded: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    muted: Arc<AtomicBool>,
}

impl ScreenAudioCapture {
    pub fn stats(&self) -> ScreenAudioStats {
        ScreenAudioStats {
            packets_encoded: self.encoded.load(Ordering::Relaxed),
            packets_dropped: self.dropped.load(Ordering::Relaxed),
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    /// Mute the share's own sound without tearing down the capture device.
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }
}

/// Start capturing system audio and encoding it to Opus.
///
/// Returns the capture handle and the stream of packets for the writer task. Failure to build an
/// encoder is returned rather than logged, because a share that silently loses its audio half looks
/// exactly like one that never had any.
pub fn start() -> Result<(ScreenAudioCapture, tokio::sync::mpsc::Receiver<OpusPacket>), String> {
    let (tx, rx) = tokio::sync::mpsc::channel(PACKET_QUEUE);
    let encoded = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0));
    let muted = Arc::new(AtomicBool::new(false));

    let sink = EncodingSinkHandle(Arc::new(EncodingSink {
        encoder: Mutex::new(EncoderState {
            encoder: VoiceEncoder::for_shared_media(SCREEN_AUDIO_BPS)?,
            pending: Vec::with_capacity(BATCH_SAMPLES + PACKET_SAMPLES),
            out: vec![0u8; MAX_PACKET],
        }),
        packets: tx,
        encoded: Arc::clone(&encoded),
        dropped: Arc::clone(&dropped),
        muted: Arc::clone(&muted),
    }));

    let stop = spawn_loopback(sink);
    Ok((
        ScreenAudioCapture {
            stop,
            encoded,
            dropped,
            muted,
        },
        rx,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sink() -> (
        EncodingSinkHandle,
        tokio::sync::mpsc::Receiver<OpusPacket>,
        Arc<AtomicU64>,
        Arc<AtomicU64>,
        Arc<AtomicBool>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::channel(PACKET_QUEUE);
        let encoded = Arc::new(AtomicU64::new(0));
        let dropped = Arc::new(AtomicU64::new(0));
        let muted = Arc::new(AtomicBool::new(false));
        let handle = EncodingSinkHandle(Arc::new(EncodingSink {
            encoder: Mutex::new(EncoderState {
                encoder: VoiceEncoder::for_shared_media(SCREEN_AUDIO_BPS).unwrap(),
                pending: Vec::new(),
                out: vec![0u8; MAX_PACKET],
            }),
            packets: tx,
            encoded: Arc::clone(&encoded),
            dropped: Arc::clone(&dropped),
            muted: Arc::clone(&muted),
        }));
        (handle, rx, encoded, dropped, muted)
    }

    /// Musical rather than speech-shaped, because `Application::Audio` is what this encoder is for
    /// and a pure tone is what it handles least like VoIP mode would.
    fn tone(samples: usize, phase: usize) -> Vec<f32> {
        (0..samples)
            .map(|i| {
                let t = (i + phase) as f32 / 48_000.0;
                (t * 440.0 * std::f32::consts::TAU).sin() * 0.4
            })
            .collect()
    }

    #[test]
    fn a_batch_becomes_whole_opus_packets() {
        let (sink, mut rx, encoded, _, _) = sink();

        assert!(sink.on_batch(&tone(BATCH_SAMPLES, 0)));

        // 40 ms of audio is two 20 ms packets, and nothing is left over.
        assert_eq!(encoded.load(Ordering::Relaxed), 2);
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err());
    }

    /// The batch size belongs to the capture path, not to this one. A ragged batch must carry its
    /// tail into the next packet rather than losing it, or a change over there silently starts
    /// clipping 20 ms out of every 40.
    #[test]
    fn a_partial_frame_is_carried_into_the_next_batch() {
        let (sink, _rx, encoded, _, _) = sink();

        sink.on_batch(&tone(PACKET_SAMPLES + 100, 0));
        assert_eq!(encoded.load(Ordering::Relaxed), 1);

        // The 100 leftover samples plus 860 more make the second packet.
        sink.on_batch(&tone(860, PACKET_SAMPLES + 100));
        assert_eq!(encoded.load(Ordering::Relaxed), 2);
    }

    /// The producer is a real-time audio callback. Blocking it does not delay one packet, it
    /// glitches the capture device - so a full queue drops and says so.
    #[test]
    fn a_backlog_drops_packets_rather_than_blocking_capture() {
        let (sink, _rx, encoded, dropped, _) = sink();

        for i in 0..PACKET_QUEUE + 6 {
            assert!(
                sink.on_batch(&tone(PACKET_SAMPLES, i * PACKET_SAMPLES)),
                "capture must never be stopped by a full queue"
            );
        }

        assert_eq!(encoded.load(Ordering::Relaxed), PACKET_QUEUE as u64);
        assert_eq!(dropped.load(Ordering::Relaxed), 6);
    }

    /// Mute means nothing on the wire, not silence encoded at 96 kbps. DTX is off for shared media,
    /// so encoded silence would keep paying for a track nobody can hear.
    #[test]
    fn muting_sends_nothing_and_keeps_the_device_open() {
        let (sink, _rx, encoded, _, muted) = sink();
        muted.store(true, Ordering::Relaxed);

        assert!(
            sink.on_batch(&tone(BATCH_SAMPLES, 0)),
            "muting must not stop the capture - unmute has to be instant"
        );
        assert_eq!(encoded.load(Ordering::Relaxed), 0);

        muted.store(false, Ordering::Relaxed);
        sink.on_batch(&tone(BATCH_SAMPLES, BATCH_SAMPLES));
        assert_eq!(encoded.load(Ordering::Relaxed), 2);
    }

    /// Audio captured while muted is dropped, not buffered - replaying it seconds late on unmute is
    /// worse than the gap.
    #[test]
    fn muted_audio_is_not_replayed_on_unmute() {
        let (sink, _rx, encoded, _, muted) = sink();

        // Half a packet in, then mute: the partial frame must not survive to be prepended later.
        sink.on_batch(&tone(PACKET_SAMPLES / 2, 0));
        muted.store(true, Ordering::Relaxed);
        sink.on_batch(&tone(PACKET_SAMPLES / 2, PACKET_SAMPLES / 2));
        muted.store(false, Ordering::Relaxed);

        // A full packet's worth arrives after unmute, and produces exactly one packet - proving
        // nothing was carried across.
        sink.on_batch(&tone(PACKET_SAMPLES, PACKET_SAMPLES));
        assert_eq!(encoded.load(Ordering::Relaxed), 1);
    }

    /// The publication ending is the one thing that *should* stop the device.
    #[test]
    fn a_closed_writer_stops_the_capture() {
        let (sink, rx, _, _, _) = sink();
        drop(rx);

        assert!(!sink.on_batch(&tone(BATCH_SAMPLES, 0)));
    }

    #[test]
    fn shared_media_encoding_produces_decodable_packets() {
        let (sink, mut rx, _, _, _) = sink();
        sink.on_batch(&tone(BATCH_SAMPLES, 0));

        let packet = rx.try_recv().expect("a packet");
        let mut decoder = crate::media::voice::codec::VoiceDecoder::new().unwrap();
        let mut out = vec![0.0f32; PACKET_SAMPLES];
        assert_eq!(decoder.decode(&packet, &mut out).unwrap(), PACKET_SAMPLES);
    }
}
