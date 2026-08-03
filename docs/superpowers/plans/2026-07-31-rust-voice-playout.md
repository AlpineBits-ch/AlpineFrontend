# Rust Voice Playout Implementation Plan (phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all voice and screen-share audio playout out of the webview and into Rust, so that one mixer owns everything the user hears - which is also what finally gives AEC3 a reference signal.

**Architecture:** The Rust session already opened by phase 1 gains a receive side. It subscribes to remote tracks on its *own* Cloudflare session, decodes each into a per-participant jitter buffer, mixes them at 10 ms, and plays the result through a cpal output stream. The mixed frame is fed back to `CaptureChain::render_reference` before it reaches the speakers - that hook exists and has never been called. The webview keeps its peer connection for video and screen *video* only; it stops creating `<audio>` elements entirely.

**Tech Stack:** webrtc-rs 0.14, cpal 0.15, opus (via the existing `codec.rs`), ringbuf 0.4, Angular 21 / Tauri 2.

## Global Constraints

- **Cross-platform.** Windows, macOS, Linux. No platform-gated playout path.
- **Work on `main`.** No feature branches.
- **`voice::rtc::TRACK_NAME` stays the literal `"audio"`.** The backend keys on it (`GuildCloudflareController.cs:95`).
- **No ICE servers for the Rust engine.** Cloudflare's SFU is publicly routable; passing STUN is what caused the phase 1 stall. See `voice-engine.service.ts`.
- **No unbounded awaits on the join path.** Every network wait in `voice_start`/subscribe gets a timeout. Phase 1's one-way silence was an unbounded `gathering_complete_promise`.
- **The audio callback allocates nothing, locks nothing, blocks nothing.** Same discipline as `capture.rs`.
- **48 kHz mono internally, `FRAME = 480` (10 ms).** Opus packets are 20 ms / 960 samples, so the receive path always splits one packet into two frames.
- **Tests run with `cargo test --no-default-features`** (201 with `--features aec`, which needs the vcvars+meson environment).

---

## File Structure

**New:**
- `src-tauri/src/media/voice/playout.rs` - cpal output stream + ring. The mirror of `capture.rs`.
- `src-tauri/src/media/voice/receive.rs` - one remote source: jitter buffer, decoder, 20→10 ms splitting, level metering.

**Modified:**
- `src-tauri/src/media/publisher/signalling.rs` - remote-track subscribe request shape.
- `src-tauri/src/media/voice/rtc.rs` - recvonly transceivers, `on_track`, RTP → `jitter::Packet`.
- `src-tauri/src/media/voice/session.rs` - the playout thread, mixer ownership, `render_reference` wiring.
- `src-tauri/src/media/voice/mod.rs` - subscribe/unsubscribe/volume/deafen/output-device commands.
- `src-tauri/src/lib.rs` - register the new commands.
- `src/app/services/voice-engine.service.ts` - the Angular face of all of the above.
- `src/app/services/voice-rtc.service.ts` - stop playing audio in the webview.
- `src/app/services/voice-channel.service.ts` - volume/deafen/speaking routed to the engine.
- `src/app/services/call-webrtc.service.ts` - the same for DM calls.

**Deliberately untouched:** `mixer.rs`, `jitter.rs`, `codec.rs`, `gate.rs`, `resample.rs`, `chain.rs`. Everything this phase needs from them already exists and is tested. If you find yourself editing them, stop and re-read - it probably means the new code is in the wrong shape.

---

### Task 1: The output device

**Files:**
- Create: `src-tauri/src/media/voice/playout.rs`
- Modify: `src-tauri/src/media/voice/mod.rs` (add `mod playout;`)

**Interfaces:**
- Consumes: `ring::channel`, `ring::RingWriter` (from phase 1).
- Produces:
  - `pub struct OutputStream(cpal::Stream)` with `unsafe impl Send`
  - `pub fn open(device_id: Option<&str>) -> Result<(OutputStream, PlayoutSink, u32), String>` - stream, the writer half, and the device's sample rate
  - `pub struct PlayoutSink` with `pub fn write_stereo(&mut self, frame: &[f32])` and `pub fn underruns(&self) -> u64`
  - `pub fn upmix(mono_or_stereo: &[f32], src_channels: usize, dst_channels: usize, out: &mut Vec<f32>)`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_to_stereo_is_unchanged() {
        let mut out = Vec::new();
        upmix(&[0.1, -0.2, 0.3, -0.4], 2, 2, &mut out);
        assert_eq!(out, vec![0.1, -0.2, 0.3, -0.4]);
    }

    #[test]
    fn stereo_collapses_to_mono_by_averaging() {
        let mut out = Vec::new();
        upmix(&[1.0, 0.0, 0.5, 0.5], 2, 1, &mut out);
        assert_eq!(out, vec![0.5, 0.5]);
    }

    #[test]
    fn stereo_spreads_across_a_surround_device() {
        // A 6-channel device must not be handed 2-channel data: the host will either refuse the
        // stream or play the mix into the wrong speakers. Extra channels stay silent rather than
        // duplicating the front pair, which would sound like a phasey chorus.
        let mut out = Vec::new();
        upmix(&[0.2, 0.4], 2, 6, &mut out);
        assert_eq!(out, vec![0.2, 0.4, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn a_non_finite_sample_never_reaches_the_device() {
        // A NaN in an output buffer is a click at best and a wedged driver at worst.
        let mut out = Vec::new();
        upmix(&[f32::NAN, f32::INFINITY, 0.5, 0.5], 2, 2, &mut out);
        assert_eq!(out, vec![0.0, 0.0, 0.5, 0.5]);
    }

    #[test]
    fn zero_destination_channels_produces_nothing_rather_than_panicking() {
        let mut out = Vec::new();
        upmix(&[0.1, 0.2], 2, 0, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn an_empty_ring_reads_as_silence_and_counts_an_underrun() {
        let (_stream_side, mut sink) = test_sink();
        assert_eq!(sink.underruns(), 0);
        let mut buf = vec![9.0f32; 8];
        sink.fill_for_test(&mut buf, 2);
        assert!(buf.iter().all(|s| *s == 0.0), "silence, not stale samples");
        assert_eq!(sink.underruns(), 1);
    }

    #[test]
    fn written_frames_come_back_out_in_order() {
        let (_stream_side, mut sink) = test_sink();
        sink.write_stereo(&[0.1, 0.2, 0.3, 0.4]);
        let mut buf = vec![0.0f32; 4];
        sink.fill_for_test(&mut buf, 2);
        assert_eq!(buf, vec![0.1, 0.2, 0.3, 0.4]);
        assert_eq!(sink.underruns(), 0);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --no-default-features playout`
Expected: FAIL - `playout` does not exist.

- [ ] **Step 3: Implement**

```rust
//! The speaker end of the voice pipeline.
//!
//! Deliberately the mirror image of `capture.rs`: same device-by-name lookup, same ring, same
//! real-time discipline in the callback. The ring is what lets the mixer run on its own 10 ms
//! thread while the device asks for whatever buffer size it likes.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::ring::{self, RingReader, RingWriter};

/// Ring depth. Deeper than the capture ring: an output underrun is audible as a gap, where a
/// capture overrun only costs a frame nobody notices.
const RING_MS: u32 = 300;

pub struct OutputStream(cpal::Stream);

// Same reasoning as `capture::InputStream`: cpal's stream handle is not `Send` on every host, but
// it is only ever moved once, onto the thread that owns it for its whole life.
unsafe impl Send for OutputStream {}

impl OutputStream {
    #[allow(dead_code)]
    pub fn pause(&self) {
        let _ = self.0.pause();
    }

    #[allow(dead_code)]
    pub fn play(&self) {
        let _ = self.0.play();
    }
}

/// The write half. Owned by the playout thread; the device callback owns the read half.
pub struct PlayoutSink {
    writer: RingWriter,
    underruns: std::sync::Arc<std::sync::atomic::AtomicU64>,
    #[cfg(test)]
    test_reader: Option<RingReader>,
}

impl PlayoutSink {
    /// Hand the mixer's interleaved stereo frame to the device.
    pub fn write_stereo(&mut self, frame: &[f32]) {
        self.writer.write(frame);
    }

    /// How many times the device asked for samples that were not there. A steadily climbing count
    /// means the mixer thread is not keeping up, which is a bug, not a tuning problem.
    pub fn underruns(&self) -> u64 {
        self.underruns.load(std::sync::atomic::Ordering::Relaxed)
    }
}

pub fn upmix(input: &[f32], src_channels: usize, dst_channels: usize, out: &mut Vec<f32>) {
    out.clear();
    if dst_channels == 0 || src_channels == 0 {
        return;
    }
    let finite = |s: f32| if s.is_finite() { s } else { 0.0 };

    for frame in input.chunks_exact(src_channels) {
        match dst_channels {
            1 => {
                let sum: f32 = frame.iter().copied().map(finite).sum();
                out.push(sum / src_channels as f32);
            }
            _ => {
                for channel in 0..dst_channels {
                    // Beyond the source's channels, stay silent. Duplicating the front pair into
                    // the surrounds sounds like a chorus, and centring it into a subwoofer channel
                    // sounds worse.
                    out.push(frame.get(channel).copied().map(finite).unwrap_or(0.0));
                }
            }
        }
    }
}

/// Open the selected output device.
///
/// Returns the stream (which must be kept alive), the sink to write mixed frames into, and the
/// device's own sample rate.
pub fn open(device_id: Option<&str>) -> Result<(OutputStream, PlayoutSink, u32), String> {
    let host = cpal::default_host();

    // By name, and falling back to the default, for the same reasons as `capture::open`.
    let device = match device_id {
        Some(id) if id != "default" => host
            .output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().ok().as_deref() == Some(id))
            .or_else(|| host.default_output_device()),
        _ => host.default_output_device(),
    }
    .ok_or_else(|| "no output device available".to_string())?;

    let supported = device
        .default_output_config()
        .map_err(|e| format!("no default output config: {e}"))?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;

    let config = cpal::StreamConfig {
        channels: supported.channels(),
        sample_rate: supported.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };

    let (writer, mut reader) = ring::channel(RING_MS);
    let underruns = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let callback_underruns = std::sync::Arc::clone(&underruns);

    // Sized once. The callback never grows it.
    let mut scratch: Vec<f32> = vec![0.0; (sample_rate as usize / 5).max(4096)];

    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _| {
                fill(data, channels, &mut reader, &mut scratch, &callback_underruns);
            },
            |err| eprintln!("[voice] output stream error: {err}"),
            None,
        )
        .map_err(|e| format!("could not open the output stream: {e}"))?;

    stream.play().map_err(|e| e.to_string())?;

    Ok((
        OutputStream(stream),
        PlayoutSink {
            writer,
            underruns,
            #[cfg(test)]
            test_reader: None,
        },
        sample_rate,
    ))
}

/// The whole real-time budget: pull interleaved stereo out of the ring and spread it across the
/// device's channel count. No allocation, no lock, no syscall.
fn fill(
    data: &mut [f32],
    channels: usize,
    reader: &mut RingReader,
    scratch: &mut [f32],
    underruns: &std::sync::atomic::AtomicU64,
) {
    if channels == 0 {
        return;
    }
    let device_frames = data.len() / channels;
    let wanted = device_frames * 2; // the ring holds interleaved stereo
    let take = wanted.min(scratch.len());
    let got = reader.pop_into(&mut scratch[..take]);

    if got < take {
        underruns.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        scratch[got..take].fill(0.0);
    }

    for (i, out_frame) in data.chunks_exact_mut(channels).enumerate() {
        let l = scratch.get(i * 2).copied().unwrap_or(0.0);
        let r = scratch.get(i * 2 + 1).copied().unwrap_or(0.0);
        for (channel, slot) in out_frame.iter_mut().enumerate() {
            *slot = match channel {
                0 => l,
                1 => r,
                _ => 0.0,
            };
            if !slot.is_finite() {
                *slot = 0.0;
            }
        }
    }
}
```

- [ ] **Step 4: Add `pop_into` to `RingReader`**

`read_frame` is fixed at `FRAME` samples, which the device callback cannot use - it asks for whatever size it likes. In `src-tauri/src/media/voice/ring.rs`:

```rust
    /// Pop as many samples as will fit, returning how many were actually available.
    ///
    /// Unlike `read_frame` this is partial-read tolerant, because the output callback must always
    /// produce a full buffer: a short read becomes silence rather than a refused read.
    pub fn pop_into(&mut self, out: &mut [f32]) -> usize {
        self.consumer.pop_slice(out)
    }
```

- [ ] **Step 5: Add the test helper**

Append inside `mod tests`, so the ring behaviour is testable without a device:

```rust
    fn test_sink() -> ((), PlayoutSink) {
        let (writer, reader) = ring::channel(RING_MS);
        (
            (),
            PlayoutSink {
                writer,
                underruns: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
                test_reader: Some(reader),
            },
        )
    }

    impl PlayoutSink {
        fn fill_for_test(&mut self, data: &mut [f32], channels: usize) {
            let mut scratch = vec![0.0f32; data.len().max(8)];
            let reader = self.test_reader.as_mut().expect("test sink");
            super::fill(data, channels, reader, &mut scratch, &self.underruns);
        }
    }
```

- [ ] **Step 6: Register the module**

In `src-tauri/src/media/voice/mod.rs`, add `mod playout;` to the module list (alphabetical, between `mixer` and `process`).

- [ ] **Step 7: Run the tests**

Run: `cargo test --no-default-features playout`
Expected: PASS, 7 tests.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/media/voice/playout.rs src-tauri/src/media/voice/ring.rs src-tauri/src/media/voice/mod.rs
git commit -m "feat: open the voice output device"
```

---

### Task 2: One remote participant's receive path

**Files:**
- Create: `src-tauri/src/media/voice/receive.rs`
- Modify: `src-tauri/src/media/voice/mod.rs` (add `mod receive;`)

**Interfaces:**
- Consumes: `jitter::{JitterBuffer, JitterConfig, Packet, Pop}`, `codec::VoiceDecoder`, `FRAME`.
- Produces:
  - `pub struct RemoteSource`
  - `pub fn new() -> Result<Self, String>`
  - `pub fn push(&mut self, packet: Packet, arrival_ms: u64)`
  - `pub fn next_frame(&mut self) -> &[f32]` - always exactly `FRAME` samples, concealed if nothing arrived
  - `pub fn level(&self) -> f32` - smoothed RMS, for the speaking indicator
  - `pub fn speaking(&self) -> bool`

**Why this is its own file:** the 20 ms packet / 10 ms frame mismatch is the whole content of it. Opus gives 960 samples per packet, the mixer wants 480 per call, and the jitter buffer must only be popped once per *packet*, not once per frame. Getting that wrong pops the buffer twice as fast as packets arrive and drains it into permanent concealment - which sounds like a robot voice that never recovers.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// 20 ms of Opus at 48 kHz mono, encoded from a tone so the decoder has something real.
    fn tone_packet(seq: u16) -> Packet {
        let mut encoder = crate::media::voice::codec::VoiceEncoder::new(64_000).unwrap();
        let pcm: Vec<f32> = (0..960)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.3)
            .collect();
        let mut out = vec![0u8; crate::media::voice::codec::MAX_PACKET];
        let n = encoder.encode(&pcm, &mut out).unwrap();
        out.truncate(n);
        Packet { seq, payload: out }
    }

    #[test]
    fn a_packet_yields_exactly_two_frames() {
        // The 20ms/10ms split, which is the entire reason this type exists.
        let mut source = RemoteSource::new().unwrap();
        for seq in 0..10 {
            source.push(tone_packet(seq), seq as u64 * 20);
        }
        for _ in 0..4 {
            assert_eq!(source.next_frame().len(), FRAME);
        }
        // Four frames consumed two packets, so eight remain of the ten pushed.
        assert!(source.buffered_packets() >= 6, "the buffer was popped too eagerly");
    }

    #[test]
    fn output_is_always_a_full_frame_even_with_nothing_buffered() {
        let mut source = RemoteSource::new().unwrap();
        for _ in 0..5 {
            assert_eq!(source.next_frame().len(), FRAME, "concealment must still fill the frame");
        }
    }

    #[test]
    fn silence_reads_as_not_speaking() {
        let mut source = RemoteSource::new().unwrap();
        for _ in 0..20 {
            source.next_frame();
        }
        assert!(!source.speaking());
        assert!(source.level() < 0.01);
    }

    #[test]
    fn a_tone_reads_as_speaking() {
        let mut source = RemoteSource::new().unwrap();
        for seq in 0..20 {
            source.push(tone_packet(seq), seq as u64 * 20);
        }
        // Past the start delay, then far enough in for the level to settle.
        for _ in 0..20 {
            source.next_frame();
        }
        assert!(source.speaking(), "level was {}", source.level());
    }

    #[test]
    fn output_is_always_finite() {
        // Garbage in must not become NaN out: a NaN here reaches the mixer, and from there every
        // participant's audio at once.
        let mut source = RemoteSource::new().unwrap();
        source.push(Packet { seq: 0, payload: vec![0xff; 40] }, 0);
        for _ in 0..6 {
            assert!(source.next_frame().iter().all(|s| s.is_finite()));
        }
    }

    #[test]
    fn a_late_duplicate_does_not_produce_a_double_frame() {
        let mut source = RemoteSource::new().unwrap();
        source.push(tone_packet(0), 0);
        source.push(tone_packet(0), 5);
        let before = source.buffered_packets();
        assert!(before <= 1, "a duplicate sequence number was buffered twice");
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --no-default-features receive`
Expected: FAIL - no such module.

- [ ] **Step 3: Implement**

```rust
//! One remote participant's audio, from RTP payload to mixable frames.
//!
//! Owns a jitter buffer and a decoder, and resolves the rate mismatch between them: Opus arrives in
//! 20 ms packets, the mixer consumes 10 ms frames. The buffer is popped once per *packet* and the
//! decoded result handed out in halves. Popping per frame would drain the buffer at twice the
//! arrival rate and leave it permanently in concealment.

use super::codec::{VoiceDecoder, PACKET_SAMPLES};
use super::jitter::{JitterBuffer, JitterConfig, Packet, Pop};
use super::FRAME;

/// Level smoothing, and the threshold the speaking indicator trips at.
///
/// Slower to fall than to rise, so the indicator does not flicker between syllables - the same
/// shape as the capture gate's release, for the same reason.
const LEVEL_ATTACK: f32 = 0.4;
const LEVEL_RELEASE: f32 = 0.05;
const SPEAKING_THRESHOLD: f32 = 0.015;

pub struct RemoteSource {
    buffer: JitterBuffer,
    decoder: VoiceDecoder,
    /// The most recently decoded packet, 960 samples. Handed out as two 480-sample halves.
    decoded: Vec<f32>,
    /// Which half of `decoded` goes out next. 0 means "pop a new packet first".
    half: usize,
    frame: Vec<f32>,
    level: f32,
}

impl RemoteSource {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            buffer: JitterBuffer::new(JitterConfig::default()),
            decoder: VoiceDecoder::new()?,
            decoded: vec![0.0; PACKET_SAMPLES],
            half: 0,
            frame: vec![0.0; FRAME],
            level: 0.0,
        })
    }

    pub fn push(&mut self, packet: Packet, arrival_ms: u64) {
        self.buffer.push(packet, arrival_ms);
    }

    #[cfg(test)]
    pub fn buffered_packets(&self) -> usize {
        self.buffer.len()
    }

    /// The next 10 ms of this participant's audio. Always exactly `FRAME` samples.
    pub fn next_frame(&mut self) -> &[f32] {
        if self.half == 0 {
            self.decode_next_packet();
        }

        let start = self.half * FRAME;
        self.frame
            .copy_from_slice(&self.decoded[start..start + FRAME]);
        self.half = (self.half + 1) % 2;

        self.update_level();
        &self.frame
    }

    pub fn level(&self) -> f32 {
        self.level
    }

    pub fn speaking(&self) -> bool {
        self.level > SPEAKING_THRESHOLD
    }

    fn decode_next_packet(&mut self) {
        let decoded = match self.buffer.pop() {
            Pop::Decode(packet) => self.decoder.decode(&packet.payload, &mut self.decoded),
            // In-band FEC: the lost packet's audio is carried inside its successor, so a single
            // drop costs quality rather than a gap. This is why the encoder sets useinbandfec=1.
            Pop::DecodeFec(next) => self.decoder.decode_fec(&next.payload, &mut self.decoded),
            Pop::Conceal => self.decoder.conceal(&mut self.decoded),
        };

        match decoded {
            Ok(n) if n == PACKET_SAMPLES => {}
            // A short or failed decode leaves the tail of the previous packet in the buffer, which
            // is an audible repeat. Silence is the honest answer.
            Ok(n) => self.decoded[n..].fill(0.0),
            Err(e) => {
                eprintln!("[voice] decode failed: {e}");
                self.decoded.fill(0.0);
            }
        }

        for sample in self.decoded.iter_mut() {
            if !sample.is_finite() {
                *sample = 0.0;
            }
        }
    }

    fn update_level(&mut self) {
        let sum: f32 = self.frame.iter().map(|s| s * s).sum();
        let rms = (sum / self.frame.len() as f32).sqrt();
        let coefficient = if rms > self.level { LEVEL_ATTACK } else { LEVEL_RELEASE };
        self.level += (rms - self.level) * coefficient;
    }
}
```

- [ ] **Step 4: Register the module and run the tests**

Add `mod receive;` to `src-tauri/src/media/voice/mod.rs`.

Run: `cargo test --no-default-features receive`
Expected: PASS, 6 tests.

If `a_late_duplicate_does_not_produce_a_double_frame` fails, the dedupe belongs in `jitter.rs` and this plan's "deliberately untouched" note was wrong - fix it there, with its own test, rather than working around it here.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/receive.rs src-tauri/src/media/voice/mod.rs
git commit -m "feat: decode one remote participant into mixable frames"
```

---

### Task 3: Ask Cloudflare for a remote track

**Files:**
- Modify: `src-tauri/src/media/publisher/signalling.rs`

**Interfaces:**
- Produces: `pub struct RemoteTrack { pub location: &'static str, pub track_name: String, pub session_id: String }` and `Signalling::tracks_new_remote(&self, cf_session_id, session_description, tracks: &[RemoteTrack]) -> Result<TracksNewResponse, String>`

The existing `tracks_new` is typed to `&[LocalTrack]`, whose `mid` field a remote pull must not send. Serialising a remote track through it would put a `mid` in the body and Cloudflare would reject it.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn a_remote_track_request_carries_a_session_id_and_no_mid() {
        let sdp = SessionDescription { sdp_type: "offer".into(), sdp: "v=0".into() };
        let tracks = [RemoteTrack {
            location: "remote",
            track_name: "audio".into(),
            session_id: "their-session".into(),
        }];
        let json = serde_json::to_value(TracksNewRemoteRequest {
            cf_session_id: "mine",
            session_description: &sdp,
            tracks: &tracks,
        })
        .unwrap();

        assert_eq!(json["tracks"][0]["location"], "remote");
        assert_eq!(json["tracks"][0]["trackName"], "audio");
        assert_eq!(json["tracks"][0]["sessionId"], "their-session");
        assert!(
            json["tracks"][0].get("mid").is_none(),
            "a remote pull must not claim a mid - Cloudflare allocates it"
        );
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --no-default-features signalling`
Expected: FAIL - `RemoteTrack` not found.

- [ ] **Step 3: Implement**

```rust
/// A track to pull from another participant's session.
///
/// Separate from [`LocalTrack`] rather than sharing it with an `Option<mid>`: a remote pull that
/// sends a mid is rejected, and an optional field is exactly the kind of thing that gets filled in
/// by accident.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrack {
    pub location: &'static str,
    pub track_name: String,
    pub session_id: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct TracksNewRemoteRequest<'a> {
    cf_session_id: &'a str,
    session_description: &'a SessionDescription,
    tracks: &'a [RemoteTrack],
}
```

and on `impl Signalling`:

```rust
    /// Subscribe to tracks on other participants' sessions.
    ///
    /// The backend routes an all-remote request through its retry path (`TracksNewWithRetryAsync`),
    /// which absorbs the window where the publisher's track has not propagated across Cloudflare's
    /// SFU yet. That retry is the reason this is safe to call the instant a ParticipantJoined
    /// arrives.
    pub async fn tracks_new_remote(
        &self,
        cf_session_id: &str,
        session_description: &SessionDescription,
        tracks: &[RemoteTrack],
    ) -> Result<TracksNewResponse, String> {
        self.post(
            &format!("{}/cf/tracks/new", self.voice_base()),
            &TracksNewRemoteRequest {
                cf_session_id,
                session_description,
                tracks,
            },
        )
        .await
    }
```

- [ ] **Step 4: Run the tests, then commit**

Run: `cargo test --no-default-features signalling`
Expected: PASS, 15 tests.

```bash
git add src-tauri/src/media/publisher/signalling.rs
git commit -m "feat: request remote tracks from Rust"
```

---

### Task 4: Subscribe on the Rust session

**Files:**
- Modify: `src-tauri/src/media/voice/rtc.rs`

**Interfaces:**
- Consumes: `signalling::RemoteTrack`, `jitter::Packet`.
- Produces, on `VoicePublication`:
  - `pub async fn subscribe(&self, sources: &[(String, String)]) -> Result<Vec<String>, String>` - takes `(cf_session_id, track_name)` pairs, returns the mids Cloudflare assigned, in the same order
  - `pub fn on_audio(&self, sink: mpsc::Sender<(String, Packet)>)` - every RTP packet on a subscribed track, keyed by mid

**The ordering trap:** `on_track` can fire before `subscribe` returns, because Cloudflare starts sending as soon as it answers. Register the handler *once, at construction*, not per subscription, and key by mid. A handler installed after the answer misses the first packets, and worse, a mid→participant map written after `set_remote_description` misses them permanently - this is the same class of bug as the webview's `pendingTracks` replay queue.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_subscription_asks_for_remote_tracks_only() {
        // The request shape is what Cloudflare validates, and it is easy to get wrong in a way that
        // only fails at runtime against the real SFU.
        let tracks = subscription_tracks(&[
            ("sess-a".to_string(), "audio".to_string()),
            ("sess-b".to_string(), "screen-audio-x".to_string()),
        ]);
        assert_eq!(tracks.len(), 2);
        assert!(tracks.iter().all(|t| t.location == "remote"));
        assert_eq!(tracks[0].session_id, "sess-a");
        assert_eq!(tracks[1].track_name, "screen-audio-x");
    }

    #[test]
    fn an_empty_subscription_asks_for_nothing() {
        assert!(subscription_tracks(&[]).is_empty());
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test --no-default-features rtc`
Expected: FAIL - `subscription_tracks` not found.

- [ ] **Step 3: Implement the pure helper first**

```rust
/// Build the pull request for a set of `(cf_session_id, track_name)` pairs.
///
/// Split out from `subscribe` so the request shape is testable without a peer connection or a
/// network - the part that is easy to get wrong is the shape, not the plumbing.
fn subscription_tracks(sources: &[(String, String)]) -> Vec<RemoteTrack> {
    sources
        .iter()
        .map(|(session_id, track_name)| RemoteTrack {
            location: "remote",
            track_name: track_name.clone(),
            session_id: session_id.clone(),
        })
        .collect()
}
```

- [ ] **Step 4: Add the track handler at construction**

In `VoicePublication::start`, after the peer connection is built and before the offer, install the handler once:

```rust
        // Installed before any subscription exists, because Cloudflare begins sending as soon as it
        // answers - a handler added per-subscription races the first packets of that subscription.
        let packet_sink: Arc<Mutex<Option<mpsc::Sender<(String, Packet)>>>> =
            Arc::new(Mutex::new(None));
        let handler_sink = Arc::clone(&packet_sink);
        peer_connection.on_track(Box::new(move |track, _receiver, transceiver| {
            let sink = Arc::clone(&handler_sink);
            Box::pin(async move {
                let mid = transceiver.mid().await;
                if mid.is_empty() {
                    return;
                }
                loop {
                    match track.read_rtp().await {
                        Ok((rtp, _)) => {
                            let sender = { sink.lock().await.clone() };
                            let Some(sender) = sender else { continue };
                            let packet = Packet {
                                seq: rtp.header.sequence_number,
                                payload: rtp.payload.to_vec(),
                            };
                            // try_send: the playout thread is the consumer and it must never be
                            // waited on from the network task. A full queue means playout has
                            // stalled, and dropping is what keeps latency bounded.
                            if sender.try_send((mid.clone(), packet)).is_err() {
                                continue;
                            }
                        }
                        Err(_) => return, // track ended
                    }
                }
            })
        }));
```

Store `packet_sink` on `VoicePublication` and expose:

```rust
    /// Route every RTP packet on every subscribed track into `sink`, keyed by mid.
    pub async fn on_audio(&self, sink: mpsc::Sender<(String, Packet)>) {
        *self.packet_sink.lock().await = Some(sink);
    }
```

- [ ] **Step 5: Implement `subscribe`**

```rust
    /// Pull a set of remote tracks onto this session, returning Cloudflare's mid for each.
    ///
    /// The returned mids are the *only* way to route incoming packets to a participant. A track
    /// that comes back without one is a failed subscribe wearing an HTTP 200, and is reported as an
    /// error rather than skipped - the guild webview path used to skip it, and the participant was
    /// silently unhearable for the rest of the session.
    pub async fn subscribe(&self, sources: &[(String, String)]) -> Result<Vec<String>, String> {
        if sources.is_empty() {
            return Ok(Vec::new());
        }

        for _ in sources {
            self.peer_connection
                .add_transceiver_from_kind(RTPCodecType::Audio, Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Recvonly,
                    send_encodings: vec![],
                }))
                .await
                .map_err(|e| e.to_string())?;
        }

        let offer = self
            .peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_local_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        let local = self
            .peer_connection
            .local_description()
            .await
            .ok_or_else(|| "no local description for subscribe".to_string())?;

        let response = self
            .signalling
            .tracks_new_remote(
                &self.cf_session_id,
                &SessionDescription { sdp_type: local.sdp_type.to_string(), sdp: local.sdp },
                &subscription_tracks(sources),
            )
            .await?;

        self.peer_connection
            .set_remote_description(to_rtc_description(&response.session_description)?)
            .await
            .map_err(|e| e.to_string())?;

        let mids: Vec<String> = response
            .tracks
            .iter()
            .map(|t| t.mid.clone().unwrap_or_default())
            .collect();
        if mids.len() != sources.len() || mids.iter().any(|m| m.is_empty()) {
            return Err(format!(
                "Cloudflare returned no mid for one or more tracks: {:?}",
                response.tracks
            ));
        }

        if response.requires_immediate_renegotiation {
            self.renegotiate().await?;
        }
        Ok(mids)
    }
```

Note: no ICE gathering wait here - the connection is already established by the publish, and a subscribe is a renegotiation of it. Adding a gathering wait would reintroduce phase 1's stall.

- [ ] **Step 6: Run the tests, then commit**

Run: `cargo test --no-default-features rtc`
Expected: PASS, 7 tests.

```bash
git add src-tauri/src/media/voice/rtc.rs
git commit -m "feat: subscribe to remote audio tracks from Rust"
```

---

### Task 5: The playout thread, and the AEC reference

**Files:**
- Modify: `src-tauri/src/media/voice/session.rs`

**Interfaces:**
- Consumes: `playout::{open, PlayoutSink}`, `receive::RemoteSource`, `mixer::Mixer`, `chain::CaptureChain::render_reference`.
- Produces, on `Control`: `subscribe`/`unsubscribe` request queues, `set_user_gain`, `set_deafened`. On `VoiceHandle`: the same, plus `pub fn levels(&self) -> Vec<(String, f32)>`.

**This is the task that turns echo cancellation on.** Everything before it is plumbing.

- [ ] **Step 1: Add shared receive state to `Control`**

```rust
/// Remote sources, shared between the network task that fills them and the playout thread that
/// drains them.
///
/// One mutex around the whole map rather than one per source: the playout thread takes it once per
/// 10 ms frame and holds it for the length of a mix, and contention is with a task that appends a
/// participant a few times per call. Per-source locks would cost more in bookkeeping than they save.
pub type Sources = Arc<Mutex<HashMap<String, SourceEntry>>>;

pub struct SourceEntry {
    /// Who this is, for the level report and the mixer's gain lookup.
    pub id: String,
    pub source: RemoteSource,
}
```

- [ ] **Step 2: Write the failing tests**

```rust
    #[test]
    fn a_mixed_frame_is_stereo_and_finite() {
        let mut mixer = Mixer::new();
        let mut out = vec![0.0f32; FRAME * 2];
        let left = vec![0.5f32; FRAME];
        let right = vec![-0.5f32; FRAME];
        mixer.mix(&[("a", &left), ("b", &right)], &mut out);
        assert_eq!(out.len(), FRAME * 2);
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn the_echo_reference_is_mono_and_frame_sized() {
        // The APM ignores a frame of the wrong length, silently. That is exactly how echo
        // cancellation ends up doing nothing while every test still passes, so this pins the shape.
        let stereo: Vec<f32> = (0..FRAME * 2).map(|i| i as f32 * 0.001).collect();
        let mono = super::reference_from(&stereo);
        assert_eq!(mono.len(), FRAME);
        // Averaged, not decimated: taking every other sample would halve the reference's energy and
        // leave AEC3 under-cancelling.
        assert!((mono[0] - (stereo[0] + stereo[1]) / 2.0).abs() < 1e-6);
    }

    #[test]
    fn deafened_output_is_silent() {
        let mut mixer = Mixer::new();
        mixer.set_deafened(true);
        let mut out = vec![1.0f32; FRAME * 2];
        let loud = vec![1.0f32; FRAME];
        mixer.mix(&[("a", &loud)], &mut out);
        assert!(out.iter().all(|s| *s == 0.0));
    }
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test --no-default-features session`
Expected: FAIL - `reference_from` not found.

- [ ] **Step 4: Implement the reference downmix**

```rust
/// Collapse the mixer's interleaved stereo frame to the mono frame the echo canceller expects.
///
/// Averaged rather than decimated, because the reference has to match the *energy* the speakers
/// will emit. Taking one channel or every other sample understates it, and AEC3 then under-cancels
/// by exactly that much - which presents as "echo cancellation is on but weak", the hardest
/// version of this bug to notice.
fn reference_from(stereo: &[f32]) -> Vec<f32> {
    stereo
        .chunks_exact(2)
        .map(|pair| (pair[0] + pair[1]) / 2.0)
        .collect()
}
```

- [ ] **Step 5: Spawn the playout thread in `start`**

After the capture thread, and taking the same `Control`:

```rust
    let (output_stream, mut sink, _output_hz) = playout::open(output_device_id.as_deref())?;
    let playout_control = Arc::clone(&control);
    let playout_sources = Arc::clone(&sources);
    let reference_tx = reference_channel.clone();

    std::thread::Builder::new()
        .name("voice-playout".into())
        .spawn(move || {
            let _stream = output_stream;
            let tick = Duration::from_millis(FRAME_MS as u64);
            let mut mixer = Mixer::new();
            let mut mixed = vec![0.0f32; FRAME * 2];
            let mut next = Instant::now();

            while playout_control.running() {
                next += tick;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    next = now;
                }

                for (id, gain) in playout_control.take_gains() {
                    mixer.set_gain(&id, gain);
                }
                mixer.set_deafened(playout_control.deafened());

                // Collected into owned frames rather than borrowed from the map, because `mix`
                // wants a slice of slices and the guard cannot be held across the call while the
                // sources are also being mutated to produce them.
                let frames: Vec<(String, Vec<f32>)> = match playout_sources.lock() {
                    Ok(mut sources) => sources
                        .values_mut()
                        .map(|entry| (entry.id.clone(), entry.source.next_frame().to_vec()))
                        .collect(),
                    Err(_) => Vec::new(),
                };
                let borrowed: Vec<(&str, &[f32])> = frames
                    .iter()
                    .map(|(id, frame)| (id.as_str(), frame.as_slice()))
                    .collect();

                mixer.mix(&borrowed, &mut mixed);

                // The echo reference goes to the capture chain *before* the frame reaches the
                // device, because AEC3 needs to know what is about to come out of the speakers. The
                // capture thread owns the chain, so it crosses over as a message rather than a
                // shared lock on the audio path.
                let _ = reference_tx.try_send(reference_from(&mixed));

                sink.write_stereo(&mixed);
            }
        })
        .map_err(|e| e.to_string())?;
```

- [ ] **Step 6: Consume the reference on the capture thread**

Inside the existing capture loop, immediately before `chain.push(...)`:

```rust
                // Drain every reference frame that has arrived. More than one means playout ran
                // ahead; feeding them all keeps the canceller's notion of "what was played" aligned
                // with real time rather than silently falling behind.
                while let Ok(reference) = reference_rx.try_recv() {
                    chain.render_reference(&reference);
                }
```

Then remove `#[allow(dead_code)]` from `CaptureChain::render_reference` - it now has a caller.

- [ ] **Step 7: Feed subscribed packets into the sources**

```rust
    // Network task: RTP arrives keyed by mid; the map from mid to participant is written by
    // `subscribe` before Cloudflare's answer is applied, so a packet can never arrive for a mid the
    // map has not seen.
    let packet_sources = Arc::clone(&sources);
    let mid_map = Arc::clone(&mids);
    tokio::spawn(async move {
        while let Some((mid, packet)) = audio_rx.recv().await {
            let Some(id) = mid_map.lock().ok().and_then(|m| m.get(&mid).cloned()) else {
                continue;
            };
            let arrival_ms = started.elapsed().as_millis() as u64;
            if let Ok(mut sources) = packet_sources.lock() {
                if let Some(entry) = sources.get_mut(&id) {
                    entry.source.push(packet, arrival_ms);
                }
            }
        }
    });
```

- [ ] **Step 8: Run the tests, then commit**

Run: `cargo test --no-default-features`
Expected: PASS, 199 + the new tests.

```bash
git add src-tauri/src/media/voice/session.rs src-tauri/src/media/voice/chain.rs
git commit -m "feat: mix remote audio in Rust and give AEC3 its reference signal"
```

---

### Task 6: Commands

**Files:**
- Modify: `src-tauri/src/media/voice/mod.rs`, `src-tauri/src/lib.rs`

**Interfaces produced** (all `#[tauri::command]`):

```rust
/// Subscribe to a participant's audio. `id` is the key everything else uses: volume, levels,
/// unsubscribe. For voice it is the user id; for screen audio it is `screen-audio-{shareId}`, so a
/// user's voice and their stream's audio have independent volume.
pub async fn voice_subscribe(id: String, cf_session_id: String, track_name: String) -> Result<(), String>

pub fn voice_unsubscribe(id: String)
pub fn voice_set_user_volume(id: String, volume: f32)
pub fn voice_set_deafened(deafened: bool)
pub fn voice_set_output_device(device_id: Option<String>) -> Result<(), String>
```

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn a_volume_outside_the_slider_range_is_clamped() {
        assert_eq!(clamp_volume(1.7), 1.0);
        assert_eq!(clamp_volume(-0.2), 0.0);
        assert_eq!(clamp_volume(f32::NAN), 1.0);
    }

    #[test]
    fn screen_audio_gets_its_own_source_id() {
        // Voice and stream audio must be separately mutable; keying both on the user id would make
        // muting someone's stream also mute their voice.
        assert_eq!(screen_audio_id("share-1"), "screen-audio-share-1");
        assert_ne!(screen_audio_id("share-1"), "user-1");
    }
```

- [ ] **Step 2: Implement**

```rust
/// A NaN volume reads as "unset" rather than "silent": a slider that has never been touched should
/// not mute someone.
fn clamp_volume(volume: f32) -> f32 {
    if volume.is_nan() {
        return 1.0;
    }
    volume.clamp(0.0, 1.0)
}

fn screen_audio_id(share_id: &str) -> String {
    format!("screen-audio-{share_id}")
}
```

with the commands delegating through `with_active(|h| ...)`, matching the existing `voice_set_mute` shape.

- [ ] **Step 3: Register in `lib.rs`**

Add all five to the **desktop** `invoke_handler` block, immediately after `media::voice::voice_set_processing,`. Not the mobile one - phase 1's commands are in the desktop block only.

- [ ] **Step 4: Run the tests, then commit**

```bash
git add src-tauri/src/media/voice/mod.rs src-tauri/src/lib.rs
git commit -m "feat: expose subscribe, volume, deafen and output device"
```

---

### Task 7: The Angular face

**Files:**
- Modify: `src/app/services/voice-engine.service.ts`

**Interfaces produced:**

```typescript
export interface RemoteLevel { id: string; level: number; speaking: boolean }

async subscribe(id: string, cfSessionId: string, trackName: string): Promise<void>
async unsubscribe(id: string): Promise<void>
async setUserVolume(id: string, volume: number): Promise<void>
async setDeafened(deafened: boolean): Promise<void>
readonly remoteLevels: Signal<ReadonlyMap<string, RemoteLevel>>
```

- [ ] **Step 1: Extend the event channel**

`VoiceEvent` gains a `kind: 'levels'` variant carrying `RemoteLevel[]`, emitted from the playout thread at ~10 Hz (not per frame - 100 events/second through the IPC channel is waste, and the indicator cannot be read faster than a screen refresh anyway).

```typescript
        channel.onmessage = event => {
            if (event.kind === 'error') {
                console.error('[voice] engine error:', event.message);
                return;
            }
            if (event.kind === 'levels') {
                this.remoteLevelsSignal.set(new Map(event.levels.map(l => [l.id, l])));
                return;
            }
            this.speaking.set(event.speaking);
            this.level.set(event.level);
        };
```

- [ ] **Step 2: Add the methods, each guarded by `isTauri()`**, matching the existing `setMute` shape exactly.

- [ ] **Step 3: Commit**

```bash
git add src/app/services/voice-engine.service.ts
git commit -m "feat: expose remote audio control to Angular"
```

---

### Task 8: Cut guild voice playout over

**Files:**
- Modify: `src/app/services/voice-rtc.service.ts`, `src/app/services/voice-channel.service.ts`

**This is the task that can break working audio.** Everything before it is additive.

- [ ] **Step 1: Route subscriptions to Rust**

`subscribeAudio` stops adding transceivers and calling `tracksNew`, and becomes:

```typescript
    async subscribeAudio(targets: {userId: string; cfSessionId: string; trackName: string; kind?: 'audio' | 'screenAudio'}[]): Promise<void> {
        for (const t of targets) {
            const id = t.kind === 'screenAudio' ? t.trackName : t.userId;
            try {
                await this.voiceEngine.subscribe(id, t.cfSessionId, t.trackName);
                if (t.kind !== 'screenAudio') {
                    this.participantsWithAudio.update(s => new Set(s).add(t.userId));
                }
            } catch (e) {
                // Loud, and it stays loud: nothing retries a subscribe, so this participant is
                // unhearable until they republish. Phase 1 shipped with this silent and it cost
                // three rounds of debugging to find.
                console.error('[voice] subscribe failed', {id, ...t}, e);
            }
        }
    }
```

Note the signature loses `guildId`/`channelId` - Rust's session already knows its target. Update both call sites in `voice-channel.service.ts`.

- [ ] **Step 2: Delete the webview playout**

Remove from `voice-rtc.service.ts`: `remoteAudioEls`, `remoteScreenAudioEls`, `routeToSelectedSpeaker`, `setupVAD`, `vadHandles`, `speakingChanges$`, `userVolumes`, `setUserVolume`/`getUserVolume`, `setDeafened`, `toggleScreenAudioMute`, and the `audio`/`screenAudio` branches of `handleRemoteTrack`. `midMeta` keeps only `video` and `screen`.

- [ ] **Step 3: Re-point the callers**

In `voice-channel.service.ts`: `setUserVolume` → `voiceEngine.setUserVolume(userId, volume)`; `toggleDeafen` → `voiceEngine.setDeafened(isDeafened)`; the remote speaking subscription → an effect over `voiceEngine.remoteLevels()`.

- [ ] **Step 4: Verify at runtime before committing.** Two clients, both join orders, per Task 11.

---

### Task 9: Screen-share audio

**Files:** `src/app/services/voice-channel.service.ts`, `voice-rtc.service.ts`

- [ ] **Step 1:** `onTrackPublished` with `kind === 'screenAudio'` routes through the same `subscribeAudio` with `kind: 'screenAudio'`, so it lands on source id `screen-audio-{shareId}`.
- [ ] **Step 2:** `toggleScreenAudioMute(userId)` becomes `voiceEngine.setUserVolume(screenAudioId, muted ? 0 : 1)`.
- [ ] **Step 3:** `onTrackClosed` for a `screen-audio-` track calls `voiceEngine.unsubscribe(trackName)`.

---

### Task 10: DM calls

**Files:** `src/app/services/call-webrtc.service.ts`

- [ ] Same three changes as Tasks 8 and 9, against this file's own `subscribeToTrack`. Its `kind === 'audio'` branch delegates to the engine; `handleRemoteTrack` keeps only video and screen. Its `pendingTracks` replay queue exists for audio mids and can go with them.

---

> **Tasks 1-10 are implemented and pushed.** 229 Rust tests, `ng build` clean. Nothing below has
> been run.

### Blocker found during Task 10: the device id is about to become inconsistent

A concurrent change adds `device-id-interceptor.ts`, which stamps `X-Device-Id` on every API
request, and its own doc comment names **the Cloudflare session create** as one of the endpoints the
backend validates it on.

**The Rust engine sends no such header.** `DeviceIdResolver` treats a missing header as
`WasProvided: false` and buckets it as `"default"` rather than rejecting it - so nothing fails
loudly. But the Rust session is the *primary* one, and for a DM call `CreateSession(primary: true)`
is what runs `Call.ConnectDevice`. So the call would be connected under device `"default"` while
every other request from the same client - accept, decline, leave - carries the real id. That is
precisely the split-brain the device id was introduced to prevent, and device-takeover detection
compares those two values.

**This supersedes the check recorded in phase 1's Step 1b**, which concluded there was no
split-brain risk. That was true when the frontend sent the header nowhere. It no longer is.

The fix is small and belongs on the Rust side: `Signalling` takes an optional device id and sends it
as `X-Device-Id`, `voice_start` gains a parameter, and `VoiceEngineService.start` passes
`await identity.deviceId()`. Not implemented here - the interceptor is still uncommitted work in
someone else's tree, and racing it would produce a conflict rather than a fix. Coordinate first.

### Task 11: Verify at runtime, with two clients

- [ ] Both clients hear each other in a guild channel, in **both** join orders.
- [ ] Both clients hear each other in a DM call.
- [ ] Per-user volume works, and is independent of that user's stream audio.
- [ ] Deafen silences everything and does not stop your own transmission.
- [ ] Speaking indicators match who is talking, for remote participants.
- [ ] Screen-share audio plays, and muting it does not mute that user's voice.
- [ ] **Echo test:** speakers at a normal level, no headphones, both sides talking. This is the phase's actual goal - compare against a recording from before it.
- [ ] A client on the previous build still interoperates.
- [ ] Leaving and rejoining twice leaves no orphaned session and no stuck audio device.

**Watch for:** a climbing `PlayoutSink::underruns` (the mixer thread is not keeping up), robot-voice that never recovers (the jitter buffer is being popped per frame instead of per packet - Task 2's trap), and echo that is *present but weak* (the reference downmix is wrong - Task 5, Step 4).

---

## Rollback

Tasks 1–7 are additive; nothing calls the new path until Task 8. Reverting Tasks 8–10 restores webview playout in full, because this plan does not delete `handleRemoteTrack`'s structure, only its audio branches.

## What this phase does not do

- **Isle keeps its own WebAudio path.** Phase 3.
- **`inputVolume`/`outputVolume` stay dead.** Phase 4, along with removing `media/audio.rs`, `audio-capture-processor.js` and `RustMediaService.startMicCapture`, which phase 1 left in place as the revert target.
- **The mixer's spatial path stays unused for guild voice.** It is built and tested, but positions only come from Isle. Turning it on here would need a source of positions that does not exist yet.
