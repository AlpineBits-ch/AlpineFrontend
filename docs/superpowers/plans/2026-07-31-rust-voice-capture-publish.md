# Rust Voice Capture and Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the microphone in Rust, run it through the DSP foundation, encode it to Opus and publish it to Cloudflare as the participant's audio track — for guild voice and DM calls — with the webview still subscribing and playing.

**Architecture:** A cpal input callback pushes samples into a lock-free ring and does nothing else. A capture thread drains the ring in 10 ms frames and runs the chain built in the DSP foundation plan (resample → APM → RNNoise → gate → Opus), then hands 20 ms packets to a `webrtc-rs` peer connection that mirrors the existing screen publisher. The webview stops acquiring a microphone and flips its own Cloudflare session to `primary=false`, so the backend records the Rust session as the participant's audio.

**Tech Stack:** Rust, cpal 0.15, `ringbuf` 0.4, `webrtc-rs` 0.14, `opus` 0.3, Tauri 2, Angular 21.

## Global Constraints

- **Work on `main`.** No feature branches.
- **Cross-platform.** Windows, macOS and Linux are all first-class. No platform may be left on the old path, and no code may be gated to one OS without an explicit reason in a comment.
- **10 ms frames, 48 kHz, mono** throughout the capture chain. `FRAME = 480`, `SAMPLE_RATE = 48_000`, `FRAME_MS = 10` from `media::voice`.
- **20 ms Opus packets.** `PACKET_SAMPLES = 960` from `media::voice::codec`.
- **The cpal callbacks allocate nothing, lock nothing and block on nothing.** This is the rule the existing `media/audio.rs` states in a comment and then breaks with `data.to_vec()` on line 216. Do not reintroduce it.
- **No sample may leave a module non-finite.** NaN or infinity reaching the device is an audible click.
- **Comments explain why, not what**, matching `media/publisher/`.
- **Tests run with `--no-default-features`** so a machine without the C++ toolchain can still verify everything except the APM itself:
  `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice`
- **Do not touch `media/audio.rs` or `audio-capture-processor.js` in this plan.** They stay until phase 4 removes them, so a rollback is a one-line frontend change rather than a revert.

## Prerequisite

The DSP foundation plan (`2026-07-31-rust-voice-dsp-foundation.md`) must be complete: `resample`, `codec`, `gate`, `jitter`, `mixer`, `denoise` and `process` all exist and pass. This plan consumes them and adds no DSP of its own.

Windows builds of the `aec` feature need the toolchain documented in that plan's prerequisite section. Everything in *this* plan builds and tests without it.

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/media/voice/ring.rs` | **New.** Lock-free SPSC sample ring between a device callback and a worker thread |
| `src-tauri/src/media/voice/capture.rs` | **New.** cpal input device selection, config negotiation, channel downmix |
| `src-tauri/src/media/voice/chain.rs` | **New.** The capture DSP chain as one testable unit: samples in, Opus packets out |
| `src-tauri/src/media/voice/rtc.rs` | **New.** `webrtc-rs` peer connection publishing one Opus track |
| `src-tauri/src/media/voice/session.rs` | **New.** Wires capture thread → chain → transport; owns the live handle |
| `src-tauri/src/media/voice/mod.rs` | Modified. Tauri commands and the single active session |
| `src-tauri/src/media/publisher/signalling.rs` | Modified. `primary` becomes a parameter instead of a hardcoded `false` |
| `src-tauri/src/lib.rs` | Modified. Command registration |
| `src/app/services/voice-engine.service.ts` | **New.** The Angular face of the Rust voice session |
| `src/app/services/voice-rtc.service.ts` | Modified. Guild voice stops acquiring a microphone |
| `src/app/services/call-webrtc.service.ts` | Modified. DM calls stop acquiring a microphone |
| `src/app/services/guild-voice.service.ts` | Modified. `createSession` takes a `primary` flag |

`ring.rs` and `chain.rs` are not in the design spec's module table. They are split out because they are the two pieces worth testing in isolation: the ring is where the real-time discipline lives, and the chain is the whole signal path minus the hardware, so it can be driven with synthetic audio and asserted on precisely.

---

### Task 1: The real-time sample ring

**Files:**
- Create: `src-tauri/src/media/voice/ring.rs`
- Modify: `src-tauri/src/media/voice/mod.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `media::voice::{FRAME, SAMPLE_RATE}`
- Produces:
  - `pub fn channel(capacity_ms: u32) -> (RingWriter, RingReader)`
  - `RingWriter::write(&mut self, samples: &[f32]) -> usize`
  - `RingWriter::overruns(&self) -> u64`
  - `RingReader::read_frame(&mut self, out: &mut [f32]) -> bool`
  - `RingReader::available_frames(&self) -> usize`

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml`, under the existing `# ── Voice pipeline (media::voice) ─` block in the `cfg(not(android/ios))` dependency table:

```toml
# A lock-free single-producer/single-consumer ring, for the hop between the cpal callback and the
# capture thread. Hand-rolling this means hand-rolling the unsafe; this crate is the standard
# choice for exactly this job and is `no_std`, so it allocates only when constructed.
ringbuf = "0.4"
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/media/voice/ring.rs`:

```rust
//! The hop between a device callback and a worker thread.
//!
//! Both cpal callbacks run on an OS audio thread with a hard deadline: miss it and the user hears a
//! dropout. So the callback may not allocate, may not lock, and may not block - which rules out
//! `Vec` growth, mutexes, and channels that park. This is a preallocated lock-free ring, and the
//! only thing the callback does is copy into it.
//!
//! On overrun the *newest* samples are dropped rather than the oldest. For live voice that is the
//! right way round: keeping stale audio and discarding current audio would trade a glitch for
//! permanent added latency.

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use super::{FRAME, SAMPLE_RATE};

/// Write end, owned by the device callback.
pub struct RingWriter {
    producer: HeapProd<f32>,
    overruns: u64,
}

/// Read end, owned by the capture thread.
pub struct RingReader {
    consumer: HeapCons<f32>,
}

/// Create a ring holding `capacity_ms` of 48 kHz mono audio.
pub fn channel(capacity_ms: u32) -> (RingWriter, RingReader) {
    let samples = (SAMPLE_RATE as usize * capacity_ms as usize) / 1000;
    let (producer, consumer) = HeapRb::<f32>::new(samples.max(FRAME)).split();
    (
        RingWriter {
            producer,
            overruns: 0,
        },
        RingReader { consumer },
    )
}

impl RingWriter {
    /// Copy samples in, returning how many were accepted.
    ///
    /// A short return is backpressure, not an error: the reader is behind and the excess is gone.
    pub fn write(&mut self, samples: &[f32]) -> usize {
        let written = self.producer.push_slice(samples);
        self.overruns += (samples.len() - written) as u64;
        written
    }

    /// Total samples dropped for want of space, for diagnostics. A number that climbs during a call
    /// means the capture thread is not keeping up.
    pub fn overruns(&self) -> u64 {
        self.overruns
    }
}

impl RingReader {
    /// Pop exactly one frame, or nothing.
    ///
    /// All-or-nothing on purpose: a partial frame would silently misalign every stage downstream,
    /// and every one of them is defined in terms of whole 10 ms frames.
    pub fn read_frame(&mut self, out: &mut [f32]) -> bool {
        if out.len() != FRAME || self.consumer.occupied_len() < FRAME {
            return false;
        }
        self.consumer.pop_slice(out) == FRAME
    }

    pub fn available_frames(&self) -> usize {
        self.consumer.occupied_len() / FRAME
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_written_is_a_frame_read() {
        let (mut w, mut r) = channel(100);
        let input: Vec<f32> = (0..FRAME).map(|i| i as f32 / FRAME as f32).collect();
        assert_eq!(w.write(&input), FRAME);

        let mut out = vec![0.0f32; FRAME];
        assert!(r.read_frame(&mut out));
        assert_eq!(out, input);
    }

    #[test]
    fn a_partial_frame_is_not_readable() {
        let (mut w, mut r) = channel(100);
        w.write(&vec![0.5f32; FRAME - 1]);

        let mut out = vec![0.0f32; FRAME];
        assert!(!r.read_frame(&mut out), "a partial frame must not be popped");
        assert_eq!(r.available_frames(), 0);

        // One more sample completes it.
        w.write(&[0.5]);
        assert!(r.read_frame(&mut out));
    }

    #[test]
    fn an_empty_ring_reads_nothing() {
        let (_w, mut r) = channel(100);
        let mut out = vec![0.0f32; FRAME];
        assert!(!r.read_frame(&mut out));
    }

    #[test]
    fn overrun_drops_the_newest_and_is_counted() {
        // Two frames of capacity, three frames of input.
        let (mut w, mut r) = channel(20);
        let first = vec![1.0f32; FRAME];
        let second = vec![2.0f32; FRAME];
        let third = vec![3.0f32; FRAME];

        assert_eq!(w.write(&first), FRAME);
        assert_eq!(w.write(&second), FRAME);
        assert_eq!(w.write(&third), 0, "the ring is full, so nothing more fits");
        assert_eq!(w.overruns(), FRAME as u64);

        // The two oldest frames survived; the newest was the one discarded.
        let mut out = vec![0.0f32; FRAME];
        assert!(r.read_frame(&mut out));
        assert_eq!(out[0], 1.0);
        assert!(r.read_frame(&mut out));
        assert_eq!(out[0], 2.0);
    }

    #[test]
    fn reading_frees_space_for_more_writes() {
        let (mut w, mut r) = channel(20);
        w.write(&vec![1.0f32; FRAME]);
        w.write(&vec![2.0f32; FRAME]);

        let mut out = vec![0.0f32; FRAME];
        assert!(r.read_frame(&mut out));
        assert_eq!(w.write(&vec![3.0f32; FRAME]), FRAME);
    }

    #[test]
    fn capacity_is_expressed_in_milliseconds() {
        let (mut w, r) = channel(100);
        // 100 ms at 48 kHz is 4800 samples, which is ten frames.
        assert_eq!(w.write(&vec![0.0f32; 4800]), 4800);
        assert_eq!(r.available_frames(), 10);
    }

    #[test]
    fn a_wrongly_sized_output_buffer_is_refused() {
        let (mut w, mut r) = channel(100);
        w.write(&vec![0.5f32; FRAME]);
        let mut out = vec![0.0f32; FRAME - 1];
        assert!(!r.read_frame(&mut out));
    }
}
```

Add to `src-tauri/src/media/voice/mod.rs`, alongside the existing `pub mod` lines:

```rust
pub mod ring;
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice::ring`
Expected: compile error, `unresolved import ringbuf` — until Step 1's dependency is fetched. Then the tests should pass, because the implementation is written alongside them here. **If any test fails, the implementation is wrong, not the test.**

- [ ] **Step 4: Verify the overrun test is not vacuous**

Temporarily change `channel` to allocate `samples.max(FRAME) * 4` and re-run. `overrun_drops_the_newest_and_is_counted` must now fail, proving it is really exercising the full-ring path. Revert the change.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/ring.rs src-tauri/src/media/voice/mod.rs src-tauri/Cargo.toml
git commit -m "feat: lock-free sample ring for the audio device boundary"
```

---

### Task 2: Make the Cloudflare session role explicit

**Files:**
- Modify: `src-tauri/src/media/publisher/signalling.rs:136-138`
- Modify: `src-tauri/src/media/publisher/mod.rs:90`

**Interfaces:**
- Produces: `pub enum SessionRole { Primary, Secondary }`, and `Signalling::new(base_url, token, target, role)`

The screen publisher hardcodes `?primary=false`. Voice needs `primary=true`, because the backend records the primary session as the participant's audio session. A boolean parameter would be readable at the definition and meaningless at the call site (`Signalling::new(base, token, target, true)`), so this is an enum.

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/media/publisher/signalling.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn signalling(target: VoiceTarget, role: SessionRole) -> Signalling {
        Signalling::new("https://api.example.com/".into(), "token".into(), target, role)
            .expect("client construction cannot fail without a proxy configured")
    }

    #[test]
    fn a_secondary_session_is_marked_non_primary() {
        let s = signalling(
            VoiceTarget::GuildChannel {
                guild_id: "g1".into(),
                channel_id: "c1".into(),
            },
            SessionRole::Secondary,
        );
        assert!(s.session_url().ends_with("/voice/session?primary=false"));
    }

    #[test]
    fn a_primary_session_claims_the_participants_audio() {
        let s = signalling(
            VoiceTarget::GuildChannel {
                guild_id: "g1".into(),
                channel_id: "c1".into(),
            },
            SessionRole::Primary,
        );
        assert!(s.session_url().ends_with("/voice/session?primary=true"));
    }

    #[test]
    fn the_role_applies_to_call_targets_too() {
        let s = signalling(VoiceTarget::Call { call_id: "x".into() }, SessionRole::Primary);
        assert_eq!(
            s.session_url(),
            "https://api.example.com/api/v1/voice/calls/x/session?primary=true"
        );
    }

    #[test]
    fn a_trailing_slash_on_the_base_url_is_not_doubled() {
        let s = signalling(VoiceTarget::Call { call_id: "x".into() }, SessionRole::Secondary);
        assert!(!s.session_url().contains("//api/"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::publisher::signalling`
Expected: FAIL — `cannot find type SessionRole in this scope`.

- [ ] **Step 3: Implement**

In `signalling.rs`, add the enum next to `VoiceTarget`:

```rust
/// Whether this session is the one the backend should record as the participant's audio.
///
/// Exactly one session per participant may be primary. The screen publisher is always secondary:
/// marking it primary leaves later joiners in a guild channel subscribing to a session with no
/// audio, and in a DM call triggers device-takeover and hangs up the call being shared into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRole {
    Primary,
    Secondary,
}

impl SessionRole {
    fn as_query_value(self) -> &'static str {
        match self {
            SessionRole::Primary => "true",
            SessionRole::Secondary => "false",
        }
    }
}
```

Add `role: SessionRole` to the `Signalling` struct, take it in `new`, store it, and replace `session_url`:

```rust
    /// URL for opening this session.
    ///
    /// The `primary` flag is load-bearing in both directions - see [`SessionRole`].
    pub fn session_url(&self) -> String {
        format!(
            "{}/session?primary={}",
            self.voice_base(),
            self.role.as_query_value()
        )
    }
```

In `publisher/mod.rs`, update the one existing call site:

```rust
    let signalling = Signalling::new(api_base, token, target, SessionRole::Secondary)?;
```

and extend its import to `use signalling::{SessionRole, Signalling, VoiceTarget};`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::publisher`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/publisher/signalling.rs src-tauri/src/media/publisher/mod.rs
git commit -m "refactor: make the Cloudflare session role an explicit parameter"
```

---

### Task 3: Input device selection and format negotiation

**Files:**
- Create: `src-tauri/src/media/voice/capture.rs`
- Modify: `src-tauri/src/media/voice/mod.rs`

**Interfaces:**
- Consumes: `ring::{channel, RingWriter, RingReader}`
- Produces:
  - `pub struct InputStream` (holds the live cpal stream; dropping it stops capture)
  - `pub fn open(device_id: Option<&str>) -> Result<(InputStream, RingReader, u32), String>` — the `u32` is the device sample rate
  - `pub fn downmix(input: &[f32], channels: usize, out: &mut Vec<f32>)`

The device-dependent half cannot be unit tested on a build agent with no sound card, so everything decidable without hardware — channel downmixing and sanitising — is a free function tested directly.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/media/voice/capture.rs` with the tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_input_passes_through() {
        let mut out = Vec::new();
        downmix(&[0.1, 0.2, 0.3], 1, &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn stereo_is_averaged_not_summed() {
        let mut out = Vec::new();
        // Summing would clip a loud stereo source the moment both channels are near full scale.
        downmix(&[1.0, 1.0, -1.0, -1.0], 2, &mut out);
        assert_eq!(out, vec![1.0, -1.0]);
    }

    #[test]
    fn a_signal_in_one_channel_only_is_halved() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0], 2, &mut out);
        assert_eq!(out, vec![0.5]);
    }

    #[test]
    fn surround_input_is_averaged_across_every_channel() {
        let mut out = Vec::new();
        downmix(&[1.0, 1.0, 1.0, 1.0, 1.0, 1.0], 6, &mut out);
        assert_eq!(out, vec![1.0]);
    }

    #[test]
    fn a_trailing_partial_frame_is_discarded() {
        let mut out = Vec::new();
        // Five samples across two channels is two whole frames and a stray. Emitting the stray
        // would swap the left and right channels for every subsequent sample.
        downmix(&[1.0, 1.0, 2.0, 2.0, 3.0], 2, &mut out);
        assert_eq!(out, vec![1.0, 2.0]);
    }

    #[test]
    fn non_finite_samples_are_replaced_with_silence() {
        let mut out = Vec::new();
        downmix(&[f32::NAN, 0.0, f32::INFINITY, 1.0], 2, &mut out);
        assert!(out.iter().all(|s| s.is_finite()), "got {out:?}");
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn the_output_buffer_is_reused_not_appended_to() {
        let mut out = vec![9.9; 32];
        downmix(&[0.5, 0.5], 2, &mut out);
        assert_eq!(out, vec![0.5], "stale contents must not survive");
    }

    #[test]
    fn zero_channels_is_treated_as_no_audio() {
        let mut out = Vec::new();
        downmix(&[0.1, 0.2], 0, &mut out);
        assert!(out.is_empty());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice::capture`
Expected: FAIL — `cannot find function downmix`.

- [ ] **Step 3: Implement**

Prepend to `capture.rs`:

```rust
//! cpal input: device selection, format negotiation, and the callback that feeds the ring.
//!
//! Everything here is about getting whatever the hardware offers into one shape - 48 kHz mono f32 -
//! so that no stage downstream has to care what device is in use.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::ring::{self, RingReader};

/// How much audio the ring holds.
///
/// Generous on purpose: the capture thread wakes on a timer and the OS may not schedule it
/// promptly, especially on a loaded machine. 200 ms of slack costs 38 kB and prevents the dropouts
/// that a tight ring would produce under scheduler jitter.
const RING_MS: u32 = 200;

/// A live input stream. Capture stops when this is dropped.
///
/// `cpal::Stream` holds raw pointers and is therefore not `Send`, but it is only ever moved between
/// threads while inert, never used from two at once - the same wrapper the legacy `media::audio`
/// uses for the same reason.
pub struct InputStream(cpal::Stream);

unsafe impl Send for InputStream {}

impl InputStream {
    pub fn pause(&self) {
        let _ = self.0.pause();
    }

    pub fn play(&self) {
        let _ = self.0.play();
    }
}

/// Collapse interleaved multi-channel input to mono, in place of the caller's buffer.
///
/// Averaged rather than summed: summing two correlated channels doubles the amplitude, and a loud
/// stereo microphone would clip before reaching any of the processing meant to prevent that.
pub fn downmix(input: &[f32], channels: usize, out: &mut Vec<f32>) {
    out.clear();
    if channels == 0 {
        return;
    }
    if channels == 1 {
        // Still sanitise: a driver glitch that emits NaN would otherwise poison every filter
        // downstream, and unlike a loud sample it never recovers.
        out.extend(input.iter().map(|s| if s.is_finite() { *s } else { 0.0 }));
        return;
    }

    let scale = 1.0 / channels as f32;
    // `chunks_exact` drops a trailing partial frame. Emitting it would rotate the channel order for
    // everything after it.
    for frame in input.chunks_exact(channels) {
        let sum: f32 = frame
            .iter()
            .map(|s| if s.is_finite() { *s } else { 0.0 })
            .sum();
        out.push(sum * scale);
    }
}

/// Open the requested input device and start streaming into a ring.
///
/// Returns the reader and the device's sample rate; resampling to 48 kHz happens in the chain,
/// because it is the chain that knows what rate it wants.
pub fn open(device_id: Option<&str>) -> Result<(InputStream, RingReader, u32), String> {
    let host = cpal::default_host();

    // Devices are identified by name. cpal exposes no stable id, and the frontend already stores
    // names - so a device that disappears falls back to the default rather than failing the call.
    let device = match device_id {
        Some(id) if id != "default" => host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().ok().as_deref() == Some(id))
            .or_else(|| host.default_input_device()),
        _ => host.default_input_device(),
    }
    .ok_or_else(|| "no input device available".to_string())?;

    let supported = device
        .default_input_config()
        .map_err(|e| format!("no default input config: {e}"))?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;

    let config = cpal::StreamConfig {
        channels: supported.channels(),
        sample_rate: supported.sample_rate(),
        // Let the host pick. Asking for a specific size is how you get a device that refuses to
        // open at all, and the ring already decouples us from whatever it chooses.
        buffer_size: cpal::BufferSize::Default,
    };

    let (mut writer, reader) = ring::channel(RING_MS);
    // Preallocated so the callback never grows it. Sized for a very generous 100 ms burst.
    let mut mono = Vec::with_capacity((sample_rate as usize / 10).max(1024));

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _| {
                // The whole real-time budget: downmix into a buffer that is already big enough,
                // then copy into the ring. No allocation, no lock, no syscall.
                downmix(data, channels, &mut mono);
                writer.write(&mono);
            },
            |err| eprintln!("[voice] input stream error: {err}"),
            None,
        )
        .map_err(|e| format!("could not open the input stream: {e}"))?;

    stream.play().map_err(|e| e.to_string())?;
    Ok((InputStream(stream), reader, sample_rate))
}
```

Add `pub mod capture;` to `mod.rs`.

> **Note on `mono`'s capacity.** `Vec::with_capacity` does not stop `push` from growing it. The capture callback is given at most a few tens of milliseconds by any host, so the reservation covers real buffer sizes with a wide margin — but if a platform is ever seen to exceed it, the fix is to `resize` once and index, not to raise the constant.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice::capture`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/capture.rs src-tauri/src/media/voice/mod.rs
git commit -m "feat: cpal input capture into the sample ring"
```

---

### Task 4: The capture chain

**Files:**
- Create: `src-tauri/src/media/voice/chain.rs`
- Modify: `src-tauri/src/media/voice/mod.rs`

**Interfaces:**
- Consumes: `resample::Resampler`, `process::{self, AudioProcessor, ProcessConfig, NoiseSuppression}`, `denoise::Denoiser`, `gate::{Gate, GateConfig, GateDecision, InputMode}`, `codec::{VoiceEncoder, MAX_PACKET, PACKET_SAMPLES}`, `FRAME`
- Produces:
  - `pub struct ChainConfig { pub processing: ProcessConfig, pub gate: GateConfig, pub bitrate_bps: i32 }`
  - `pub struct ChainStatus { pub speaking: bool, pub level: f32 }`
  - `pub struct CaptureChain`
  - `CaptureChain::new(input_hz: u32, config: ChainConfig) -> Result<Self, String>`
  - `CaptureChain::push(&mut self, input: &[f32], on_packet: &mut dyn FnMut(&[u8])) -> ChainStatus`
  - `CaptureChain::set_config(&mut self, config: ChainConfig)`
  - `CaptureChain::set_muted(&mut self, muted: bool)` / `set_ptt_down(&mut self, down: bool)`
  - `CaptureChain::render_reference(&mut self, frame: &[f32])`

This is the whole signal path with the hardware and the network removed, so it can be driven with synthetic audio and asserted on exactly.

**Design decision — the gate silences, it does not skip.** When the gate is closed the frame is zeroed and still encoded, rather than dropped. Opus DTX then collapses silence to occasional tiny packets on its own, the far end's decoder keeps its state continuous, and there is no click at the moment speech resumes. Packets of two bytes or fewer are DTX's "nothing to send" and are not transmitted.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/media/voice/chain.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::voice::SAMPLE_RATE;

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
        }
    }

    /// A loud 440 Hz tone: comfortably above any gate threshold.
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
        // has latency, so allow the first packet's worth of slack.
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
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        chain.set_muted(true);
        let (packets, status) = collect(&mut chain, &tone(SAMPLE_RATE as usize / 2, 0));

        assert!(!status.speaking, "a muted microphone never shows as speaking");
        // DTX may still emit the occasional tiny keepalive; what must not happen is a stream of
        // full-size packets carrying the audio.
        assert!(
            packets.iter().all(|p| p.len() < 20),
            "muted audio is still being encoded: largest packet was {} bytes",
            packets.iter().map(|p| p.len()).max().unwrap_or(0)
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
        assert!(!status.speaking, "switching to PTT must take effect immediately");
    }

    #[test]
    fn every_packet_fits_the_codec_limit() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let (packets, _) = collect(&mut chain, &tone(SAMPLE_RATE as usize, 0));
        assert!(packets.iter().all(|p| p.len() <= MAX_PACKET));
        assert!(packets.iter().all(|p| !p.is_empty()));
    }

    #[test]
    fn non_finite_input_does_not_reach_the_encoder() {
        let mut chain = CaptureChain::new(SAMPLE_RATE, config()).unwrap();
        let mut input = tone(PACKET_SAMPLES, 0);
        input[10] = f32::NAN;
        input[11] = f32::INFINITY;
        // The contract is simply that this neither panics nor produces a malformed packet.
        let (packets, status) = collect(&mut chain, &input);
        assert!(packets.iter().all(|p| p.len() <= MAX_PACKET));
        assert!(status.level.is_finite());
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
        assert!(!packets.is_empty(), "the RNNoise stage must not swallow the stream");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice::chain`
Expected: FAIL — `cannot find struct CaptureChain`.

- [ ] **Step 3: Implement**

Prepend to `chain.rs`:

```rust
//! The capture signal path, from device samples to Opus packets.
//!
//! Deliberately free of both hardware and network: it takes a slice of mono f32 at whatever rate
//! the device runs at and calls back with finished packets. That makes the entire path testable
//! with synthetic audio, which is where the previous implementation's defects hid - a comb filter
//! and an unstable de-emphasis, neither visible without being able to drive the chain directly.

use super::codec::{VoiceEncoder, MAX_PACKET, PACKET_SAMPLES};
use super::denoise::Denoiser;
use super::gate::{Gate, GateConfig, InputMode};
use super::process::{self, AudioProcessor, NoiseSuppression, ProcessConfig};
use super::resample::Resampler;
use super::{FRAME, SAMPLE_RATE};

/// Opus packets of this size or smaller carry no audio - they are DTX's way of saying "still
/// silent". Sending them wastes a packet header per 20 ms for no benefit.
const DTX_MAX_LEN: usize = 2;

#[derive(Clone, Copy, Debug)]
pub struct ChainConfig {
    pub processing: ProcessConfig,
    pub gate: GateConfig,
    pub bitrate_bps: i32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ChainStatus {
    /// Whether the user should be shown as speaking. This is the only speaking signal in the
    /// system - it replaces the two independent JavaScript VAD `AudioContext`s that used to
    /// disagree with each other and with the gate that actually decided what was transmitted.
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
    /// Scratch for one frame, reused so the audio path allocates nothing per frame.
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

        // RNNoise on top, only when the user asked for the aggressive setting. It is a different
        // kind of suppressor - trained on speech, good at irregular noise like keyboards - so it
        // complements the APM's stationary-noise estimate rather than duplicating it.
        if self.config.processing.noise_suppression == NoiseSuppression::Enhanced {
            self.denoiser.process(&mut self.frame);
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

        self.packet_buffer.extend_from_slice(&self.frame);
        if self.packet_buffer.len() < PACKET_SAMPLES {
            return;
        }

        match self.encoder.encode(&self.packet_buffer, &mut self.encoded) {
            Ok(len) if len > DTX_MAX_LEN => on_packet(&self.encoded[..len]),
            Ok(_) => {}
            Err(e) => eprintln!("[voice] opus encode failed: {e}"),
        }
        self.packet_buffer.clear();
    }
}

/// Root-mean-square of a frame, guarded so a non-finite sample cannot propagate into the gate.
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
```

Add `pub mod chain;` to `mod.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice::chain`
Expected: PASS, 13 tests.

If `a_device_at_44100_is_resampled_to_the_pipeline_rate` fails on packet count, check the resampler's warm-up latency before loosening the bound — the assertion already allows two packets of slack, and a larger discrepancy means samples are being lost, not delayed.

- [ ] **Step 5: Verify the mute test is not vacuous**

Temporarily change `if !decision.transmit` to `if false`. `muting_stops_both_speaking_and_audible_output` must fail with a large packet size in the message. Revert.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/media/voice/chain.rs src-tauri/src/media/voice/mod.rs
git commit -m "feat: capture DSP chain from device samples to Opus packets"
```

---

### Task 5: The Opus publication

**Files:**
- Create: `src-tauri/src/media/voice/rtc.rs`
- Modify: `src-tauri/src/media/voice/mod.rs`

**Interfaces:**
- Consumes: `publisher::rtc::IceServerConfig`, `publisher::signalling::{Signalling, SessionDescription, LocalTrack}`
- Produces:
  - `pub const TRACK_NAME: &str = "audio"`
  - `pub struct VoicePublication { pub cf_session_id: String, pub track_name: String }`
  - `VoicePublication::start(signalling, ice_servers) -> Result<Self, String>`
  - `VoicePublication::write_packet(&self, packet: Vec<u8>) -> Result<(), String>`
  - `VoicePublication::stop(self)`
  - `pub fn opus_capability() -> RTCRtpCodecCapability`

This mirrors `publisher/rtc.rs` closely. The differences are the codec, the track name, and that the session is primary. Reuse `IceServerConfig` rather than defining a second identical type.

- [ ] **Step 1: Write the failing tests**

The handshake needs a live Cloudflare session, so what is tested here is the codec description — the part that decides whether every other client can decode the stream, and the part that is wrong silently rather than loudly.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_codec_is_mono_opus_at_the_pipeline_rate() {
        let cap = opus_capability();
        assert_eq!(cap.mime_type, MIME_TYPE_OPUS);
        assert_eq!(cap.clock_rate, 48_000);
        assert_eq!(cap.channels, 1);
    }

    #[test]
    fn the_fmtp_line_advertises_in_band_fec() {
        // The receiver only asks for FEC if we say we can produce it, and the encoder is configured
        // to produce it - so an fmtp line that omits this quietly wastes the redundancy we pay for.
        assert!(opus_capability().sdp_fmtp_line.contains("useinbandfec=1"));
    }

    #[test]
    fn the_fmtp_line_declares_the_packet_duration() {
        assert!(opus_capability().sdp_fmtp_line.contains("minptime=10"));
    }

    #[test]
    fn the_track_name_matches_what_the_webview_used_to_publish() {
        // Other clients resolve a participant's audio by this name. Changing it orphans everyone
        // still running the previous build.
        assert_eq!(TRACK_NAME, "audio");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice::rtc`
Expected: FAIL — `cannot find function opus_capability`.

- [ ] **Step 3: Implement**

```rust
//! A `webrtc-rs` peer connection publishing one Opus microphone track to Cloudflare Realtime.
//!
//! The transport half of the Rust voice pipeline. Packets arrive already encoded from
//! [`super::chain`]; this module owns the peer connection and the signalling handshake and knows
//! nothing about audio.
//!
//! Shaped after `publisher::rtc`, which does the same job for screen video. The difference that
//! matters is the session role: voice is the *primary* session, because the backend records the
//! primary session as the participant's audio.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::media::publisher::rtc::IceServerConfig;
use crate::media::publisher::signalling::{LocalTrack, SessionDescription, Signalling};

/// The name every other client resolves a participant's microphone by. It matches what the webview
/// published before this pipeline existed, so a mixed-version call still works.
pub const TRACK_NAME: &str = "audio";

/// One packet every 20 ms - the packetisation the encoder is configured for.
const PACKET_DURATION: Duration = Duration::from_millis(20);

/// How the microphone track is described in SDP.
pub fn opus_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_owned(),
        clock_rate: 48_000,
        channels: 1,
        // `useinbandfec=1` is what makes the receiver ask for forward error correction, which the
        // encoder already produces; `minptime=10` states the shortest packet we will send.
        sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
        ..Default::default()
    }
}

pub struct VoicePublication {
    peer_connection: Arc<RTCPeerConnection>,
    track: Arc<TrackLocalStaticSample>,
    signalling: Signalling,
    pub cf_session_id: String,
    pub track_name: String,
}

impl VoicePublication {
    pub async fn start(
        signalling: Signalling,
        ice_servers: Vec<IceServerConfig>,
    ) -> Result<Self, String> {
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_default_codecs()
            .map_err(|e| e.to_string())?;

        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut media_engine)
            .map_err(|e| e.to_string())?;

        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .build();

        let config = RTCConfiguration {
            ice_servers: ice_servers
                .into_iter()
                .map(|server| RTCIceServer {
                    urls: server.urls,
                    username: server.username.unwrap_or_default(),
                    credential: server.credential.unwrap_or_default(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };

        let peer_connection = Arc::new(
            api.new_peer_connection(config)
                .await
                .map_err(|e| e.to_string())?,
        );

        let track = Arc::new(TrackLocalStaticSample::new(
            opus_capability(),
            "audio".to_owned(),
            TRACK_NAME.to_owned(),
        ));

        let rtp_sender = peer_connection
            .add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| e.to_string())?;

        // RTCP must be drained or the sender's buffers fill and stall the track.
        tokio::spawn(async move {
            let mut buf = vec![0u8; 1500];
            while rtp_sender.read(&mut buf).await.is_ok() {}
        });

        let offer = peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;

        // Cloudflare needs a complete SDP and there is no trickle path to the backend here.
        let mut gathering = peer_connection.gathering_complete_promise().await;
        peer_connection
            .set_local_description(offer)
            .await
            .map_err(|e| e.to_string())?;
        let _ = gathering.recv().await;

        let local = peer_connection
            .local_description()
            .await
            .ok_or_else(|| "no local description after gathering".to_string())?;

        let cf_session_id = signalling.create_session().await?;

        let mid = peer_connection
            .get_transceivers()
            .await
            .first()
            .ok_or_else(|| "no transceiver on the voice connection".to_string())?
            .mid()
            .map(|m| m.to_string())
            .unwrap_or_else(|| "0".to_string());

        let response = signalling
            .tracks_new(
                &cf_session_id,
                &SessionDescription {
                    sdp_type: "offer".to_owned(),
                    sdp: local.sdp,
                },
                &[LocalTrack {
                    location: "local",
                    mid,
                    track_name: TRACK_NAME.to_owned(),
                }],
            )
            .await?;

        if let Some(error) = response.tracks.iter().find_map(|t| t.error.as_ref()) {
            return Err(format!("Cloudflare rejected the voice track: {error}"));
        }

        let answer = RTCSessionDescription::answer(response.session_description.sdp)
            .map_err(|e| e.to_string())?;
        peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())?;

        let track_name = response
            .tracks
            .first()
            .and_then(|t| t.track_name.clone())
            .unwrap_or_else(|| TRACK_NAME.to_owned());

        let publication = Self {
            peer_connection,
            track,
            signalling,
            cf_session_id,
            track_name,
        };

        if response.requires_immediate_renegotiation {
            publication.renegotiate().await?;
        }

        Ok(publication)
    }

    pub async fn write_packet(&self, packet: Vec<u8>) -> Result<(), String> {
        self.track
            .write_sample(&Sample {
                data: packet.into(),
                timestamp: SystemTime::now(),
                duration: PACKET_DURATION,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())
    }

    async fn renegotiate(&self) -> Result<(), String> {
        let offer = self
            .peer_connection
            .create_offer(None)
            .await
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_local_description(offer.clone())
            .await
            .map_err(|e| e.to_string())?;

        let response = self
            .signalling
            .renegotiate(
                &self.cf_session_id,
                &SessionDescription {
                    sdp_type: "offer".to_owned(),
                    sdp: offer.sdp,
                },
            )
            .await?;

        let answer = RTCSessionDescription::answer(response.session_description.sdp)
            .map_err(|e| e.to_string())?;
        self.peer_connection
            .set_remote_description(answer)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn stop(self) {
        let _ = self
            .signalling
            .close_tracks(&self.cf_session_id, &[self.track_name.clone()])
            .await;
        let _ = self.peer_connection.close().await;
    }
}
```

`publisher/mod.rs` has `#![allow(dead_code)]` at module level; `voice/rtc.rs` does not, so add `#[allow(dead_code)]` to any accessor the session does not yet call rather than deleting it.

Add `pub mod rtc;` to `mod.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice::rtc`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/rtc.rs src-tauri/src/media/voice/mod.rs
git commit -m "feat: publish the microphone as an Opus track from Rust"
```

---

### Task 6: The session

**Files:**
- Create: `src-tauri/src/media/voice/session.rs`
- Modify: `src-tauri/src/media/voice/mod.rs`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `pub struct VoiceHandle { pub cf_session_id: String, pub track_name: String }`
  - `pub struct VoiceEvent { pub kind: String, pub speaking: bool, pub level: f32, pub message: Option<String> }`
  - `pub async fn start(device_id, ice_servers, signalling, config, on_event) -> Result<VoiceHandle, String>`
  - `VoiceHandle::{set_muted, set_ptt_down, set_config, stop}`

**Threading.** The capture thread is a plain OS thread, not a tokio task: it blocks on a timer and does bounded DSP work, which would occupy a runtime worker for the whole call. Packets cross to the async side over a bounded channel, exactly as the screen publisher does.

- [ ] **Step 1: Write the failing tests**

The session needs a device and a network, so the testable part is the shared control state — the thing that is wrong in a way no manual test reliably catches, because a missed update looks like the user simply not having pressed the key.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_changes_are_visible_to_the_capture_thread() {
        let control = Control::default();
        assert!(!control.muted());
        assert!(!control.ptt_down());

        control.set_muted(true);
        control.set_ptt_down(true);
        assert!(control.muted());
        assert!(control.ptt_down());
    }

    #[test]
    fn a_stopped_session_stays_stopped() {
        let control = Control::default();
        assert!(control.running());
        control.stop();
        assert!(!control.running());
        // Idempotent: a second stop from a different path must not resurrect it.
        control.stop();
        assert!(!control.running());
    }

    #[test]
    fn control_is_shareable_across_threads() {
        let control = std::sync::Arc::new(Control::default());
        let other = std::sync::Arc::clone(&control);
        let handle = std::thread::spawn(move || other.set_muted(true));
        handle.join().unwrap();
        assert!(control.muted());
    }

    #[test]
    fn a_speaking_event_carries_the_level() {
        let event = VoiceEvent::speaking(true, 0.42);
        assert_eq!(event.kind, "speaking");
        assert!(event.speaking);
        assert!((event.level - 0.42).abs() < f32::EPSILON);
        assert!(event.message.is_none());
    }

    #[test]
    fn an_error_event_carries_a_message() {
        let event = VoiceEvent::error("device lost");
        assert_eq!(event.kind, "error");
        assert_eq!(event.message.as_deref(), Some("device lost"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice::session`
Expected: FAIL — `cannot find struct Control`.

- [ ] **Step 3: Implement**

```rust
//! Owns a running voice session: the input device, the capture thread, and the peer connection.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::capture;
use super::chain::{CaptureChain, ChainConfig};
use super::rtc::VoicePublication;
use super::{FRAME, FRAME_MS};
use crate::media::publisher::rtc::IceServerConfig;
use crate::media::publisher::signalling::Signalling;

/// How many encoded packets may queue between the capture thread and the async writer.
///
/// Small on purpose: voice that falls behind should drop rather than accumulate, because a backlog
/// turns into permanent latency that never recovers on its own.
const PACKET_QUEUE: usize = 8;

/// Emitted to the frontend. One channel carries every kind so the webview subscribes once.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceEvent {
    pub kind: String,
    pub speaking: bool,
    pub level: f32,
    pub message: Option<String>,
}

impl VoiceEvent {
    pub fn speaking(speaking: bool, level: f32) -> Self {
        Self {
            kind: "speaking".into(),
            speaking,
            level,
            message: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            kind: "error".into(),
            speaking: false,
            level: 0.0,
            message: Some(message.into()),
        }
    }
}

/// State shared between the Tauri command thread and the capture thread.
///
/// Atomics rather than a mutex: the capture thread reads these every 10 ms on a deadline, and it
/// must never wait on a UI thread that happens to be holding a lock.
#[derive(Default)]
pub struct Control {
    muted: AtomicBool,
    ptt_down: AtomicBool,
    stopped: AtomicBool,
    /// Config changes are rare and larger than a word, so this one is a mutex - but it is only
    /// locked when `dirty` says something changed, so the common path never touches it.
    pending_config: Mutex<Option<ChainConfig>>,
    dirty: AtomicBool,
}

impl Control {
    pub fn muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    pub fn ptt_down(&self) -> bool {
        self.ptt_down.load(Ordering::Relaxed)
    }

    pub fn set_ptt_down(&self, down: bool) {
        self.ptt_down.store(down, Ordering::Relaxed);
    }

    pub fn running(&self) -> bool {
        !self.stopped.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }

    pub fn set_config(&self, config: ChainConfig) {
        if let Ok(mut guard) = self.pending_config.lock() {
            *guard = Some(config);
            self.dirty.store(true, Ordering::Release);
        }
    }

    fn take_config(&self) -> Option<ChainConfig> {
        if !self.dirty.swap(false, Ordering::Acquire) {
            return None;
        }
        self.pending_config.lock().ok().and_then(|mut g| g.take())
    }
}

pub struct VoiceHandle {
    control: Arc<Control>,
    pub cf_session_id: String,
    pub track_name: String,
}

impl VoiceHandle {
    pub fn set_muted(&self, muted: bool) {
        self.control.set_muted(muted);
    }

    pub fn set_ptt_down(&self, down: bool) {
        self.control.set_ptt_down(down);
    }

    pub fn set_config(&self, config: ChainConfig) {
        self.control.set_config(config);
    }

    pub fn stop(&self) {
        self.control.stop();
    }
}

pub async fn start(
    device_id: Option<String>,
    ice_servers: Vec<IceServerConfig>,
    signalling: Signalling,
    config: ChainConfig,
    on_event: tauri::ipc::Channel<VoiceEvent>,
) -> Result<VoiceHandle, String> {
    let (stream, mut reader, input_hz) = capture::open(device_id.as_deref())?;
    let mut chain = CaptureChain::new(input_hz, config)?;

    let publication = VoicePublication::start(signalling, ice_servers).await?;
    let cf_session_id = publication.cf_session_id.clone();
    let track_name = publication.track_name.clone();

    let control = Arc::new(Control::default());
    let (packet_tx, mut packet_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(PACKET_QUEUE);

    // Writer task: the peer connection is async, the capture thread is a blocking OS thread.
    tokio::spawn(async move {
        while let Some(packet) = packet_rx.recv().await {
            if let Err(e) = publication.write_packet(packet).await {
                eprintln!("[voice] write failed, ending publication: {e}");
                break;
            }
        }
        publication.stop().await;
    });

    let thread_control = Arc::clone(&control);
    std::thread::Builder::new()
        .name("voice-capture".into())
        .spawn(move || {
            // Keeps the device open for the life of the thread.
            let _stream = stream;
            let tick = Duration::from_millis(FRAME_MS as u64);
            let mut frame = vec![0.0f32; FRAME];
            let mut last_speaking = false;
            let mut next = Instant::now();

            while thread_control.running() {
                next += tick;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    // Overran the budget. Resync rather than trying to catch up, which would spin
                    // and make the backlog worse.
                    next = now;
                }

                if let Some(config) = thread_control.take_config() {
                    chain.set_config(config);
                }
                chain.set_muted(thread_control.muted());
                chain.set_ptt_down(thread_control.ptt_down());

                // Drain everything the device produced, which may be more or less than one frame.
                while reader.read_frame(&mut frame) {
                    let status = chain.push(&frame, &mut |packet: &[u8]| {
                        // try_send: dropping under backpressure keeps latency bounded, and a closed
                        // channel means the writer task already ended.
                        let _ = packet_tx.try_send(packet.to_vec());
                    });

                    if status.speaking != last_speaking {
                        last_speaking = status.speaking;
                        let _ = on_event.send(VoiceEvent::speaking(status.speaking, status.level));
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(VoiceHandle {
        control,
        cf_session_id,
        track_name,
    })
}
```

Add `pub mod session;` to `mod.rs`.

> **Known limitation, to be removed in phase 2.** `packet_tx.try_send` copies each packet into a fresh `Vec`. It is ~80 bytes every 20 ms, so it is not worth a pool now — but note it, because phase 2 adds a playout path on the same thread where allocation pressure does start to matter.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice::session`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/session.rs src-tauri/src/media/voice/mod.rs
git commit -m "feat: voice session wiring capture, chain and transport"
```

---

### Task 7: Tauri commands

**Files:**
- Modify: `src-tauri/src/media/voice/mod.rs`
- Modify: `src-tauri/src/lib.rs:419-434`

**Interfaces:**
- Produces: `voice_start`, `voice_stop`, `voice_set_mute`, `voice_set_ptt_open`, `voice_set_processing`

- [ ] **Step 1: Implement the command surface**

Append to `src-tauri/src/media/voice/mod.rs`:

```rust
use std::sync::{Mutex, OnceLock};

use crate::media::publisher::rtc::IceServerConfig;
use crate::media::publisher::signalling::{SessionRole, Signalling, VoiceTarget};
use chain::ChainConfig;
use gate::{GateConfig, InputMode};
use process::{NoiseSuppression, ProcessConfig};
use session::{VoiceEvent, VoiceHandle};

/// The one running voice session. A user is in at most one call at a time, and a second capture
/// would contend for the same microphone.
static ACTIVE: OnceLock<Mutex<Option<VoiceHandle>>> = OnceLock::new();

fn active() -> &'static Mutex<Option<VoiceHandle>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// Settings as the frontend states them. Deliberately in the frontend's vocabulary - the mapping to
/// DSP configuration happens here, in one place, rather than being spread across the UI.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSettings {
    pub device_id: Option<String>,
    /// "none" | "standard" | "enhanced"
    pub noise_suppression: String,
    pub echo_cancellation: bool,
    pub auto_gain_control: bool,
    /// "voice" | "ptt"
    pub input_mode: String,
    /// 0.0-1.0, matching the sensitivity slider.
    pub sensitivity: f32,
    pub bitrate_bps: Option<i32>,
}

impl VoiceSettings {
    fn to_chain_config(&self) -> ChainConfig {
        ChainConfig {
            processing: ProcessConfig {
                echo_cancellation: self.echo_cancellation,
                noise_suppression: match self.noise_suppression.as_str() {
                    "none" => NoiseSuppression::Off,
                    "enhanced" => NoiseSuppression::Enhanced,
                    _ => NoiseSuppression::Standard,
                },
                auto_gain: self.auto_gain_control,
            },
            gate: GateConfig {
                mode: if self.input_mode == "ptt" {
                    InputMode::PushToTalk
                } else {
                    InputMode::VoiceActivity
                },
                sensitivity: self.sensitivity.clamp(0.0, 1.0),
                // Long enough to ride over the pauses between words, short enough not to hold the
                // channel open after someone stops talking.
                release_ms: 200,
            },
            // 64 kbps mono Opus is transparent for speech; more buys nothing audible.
            bitrate_bps: self.bitrate_bps.unwrap_or(64_000),
        }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartResult {
    pub cf_session_id: String,
    pub track_name: String,
}

/// Start capturing and publishing the microphone.
///
/// `api_base` and `token` come from the webview for the same reason the screen publisher takes
/// them: the webview owns session lifetime and token refresh, and duplicating that here would mean
/// two things to keep correct.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn voice_start(
    settings: VoiceSettings,
    ice_servers: Vec<IceServerConfig>,
    api_base: String,
    token: String,
    guild_id: Option<String>,
    channel_id: Option<String>,
    call_id: Option<String>,
    on_event: tauri::ipc::Channel<VoiceEvent>,
) -> Result<VoiceStartResult, String> {
    voice_stop();

    let target = match (guild_id, channel_id, call_id) {
        (Some(guild_id), Some(channel_id), _) => VoiceTarget::GuildChannel {
            guild_id,
            channel_id,
        },
        (_, _, Some(call_id)) => VoiceTarget::Call { call_id },
        _ => return Err("voice needs either guildId+channelId or callId".into()),
    };

    // Primary: this is the session the backend records as the participant's audio.
    let signalling = Signalling::new(api_base, token, target, SessionRole::Primary)?;
    let handle = session::start(
        settings.device_id.clone(),
        ice_servers,
        signalling,
        settings.to_chain_config(),
        on_event,
    )
    .await?;

    let result = VoiceStartResult {
        cf_session_id: handle.cf_session_id.clone(),
        track_name: handle.track_name.clone(),
    };

    if let Ok(mut guard) = active().lock() {
        *guard = Some(handle);
    }
    Ok(result)
}

#[tauri::command]
pub fn voice_stop() {
    if let Ok(mut guard) = active().lock() {
        if let Some(handle) = guard.take() {
            handle.stop();
        }
    }
}

#[tauri::command]
pub fn voice_set_mute(muted: bool) {
    with_active(|h| h.set_muted(muted));
}

#[tauri::command]
pub fn voice_set_ptt_open(open: bool) {
    with_active(|h| h.set_ptt_down(open));
}

#[tauri::command]
pub fn voice_set_processing(settings: VoiceSettings) {
    let config = settings.to_chain_config();
    with_active(|h| h.set_config(config));
}

fn with_active(f: impl FnOnce(&VoiceHandle)) {
    if let Ok(guard) = active().lock() {
        if let Some(handle) = guard.as_ref() {
            f(handle);
        }
    }
}
```

- [ ] **Step 2: Write tests for the settings mapping**

This is where a typo becomes a setting that silently does nothing — exactly the class of bug the current implementation already has three of.

```rust
#[cfg(test)]
mod command_tests {
    use super::*;

    fn settings() -> VoiceSettings {
        VoiceSettings {
            device_id: None,
            noise_suppression: "standard".into(),
            echo_cancellation: true,
            auto_gain_control: true,
            input_mode: "voice".into(),
            sensitivity: 0.5,
            bitrate_bps: None,
        }
    }

    #[test]
    fn noise_suppression_names_map_to_the_three_modes() {
        for (name, expected) in [
            ("none", NoiseSuppression::Off),
            ("standard", NoiseSuppression::Standard),
            ("enhanced", NoiseSuppression::Enhanced),
        ] {
            let mut s = settings();
            s.noise_suppression = name.into();
            assert_eq!(s.to_chain_config().processing.noise_suppression, expected);
        }
    }

    #[test]
    fn an_unrecognised_noise_suppression_name_falls_back_to_standard() {
        let mut s = settings();
        s.noise_suppression = "wibble".into();
        assert_eq!(
            s.to_chain_config().processing.noise_suppression,
            NoiseSuppression::Standard
        );
    }

    #[test]
    fn push_to_talk_is_selected_by_name() {
        let mut s = settings();
        s.input_mode = "ptt".into();
        assert_eq!(s.to_chain_config().gate.mode, InputMode::PushToTalk);
        s.input_mode = "voice".into();
        assert_eq!(s.to_chain_config().gate.mode, InputMode::VoiceActivity);
    }

    #[test]
    fn sensitivity_outside_the_slider_range_is_clamped() {
        let mut s = settings();
        s.sensitivity = 4.2;
        assert_eq!(s.to_chain_config().gate.sensitivity, 1.0);
        s.sensitivity = -1.0;
        assert_eq!(s.to_chain_config().gate.sensitivity, 0.0);
    }

    #[test]
    fn echo_cancellation_and_gain_control_reach_the_processor() {
        let mut s = settings();
        s.echo_cancellation = false;
        s.auto_gain_control = false;
        let c = s.to_chain_config();
        assert!(!c.processing.echo_cancellation);
        assert!(!c.processing.auto_gain);
    }

    #[test]
    fn the_default_bitrate_is_transparent_for_speech() {
        assert_eq!(settings().to_chain_config().bitrate_bps, 64_000);
    }
}
```

- [ ] **Step 3: Register the commands**

In `src-tauri/src/lib.rs`, after `media::publisher::set_publish_fps,` (line 434):

```rust
            media::voice::voice_start,
            media::voice::voice_stop,
            media::voice::voice_set_mute,
            media::voice::voice_set_ptt_open,
            media::voice::voice_set_processing,
```

The `voice` module is already gated to `cfg(not(android/ios))` in `media/mod.rs`, and this `invoke_handler` block (line 385) is the desktop one — the mobile block at line 452 must **not** get these entries.

- [ ] **Step 4: Run the tests and build**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib media::voice`
Expected: PASS — everything from Tasks 1-7, 68 pre-existing plus the new ones.

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: clean, with the `aec` feature on.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/mod.rs src-tauri/src/lib.rs
git commit -m "feat: Tauri command surface for the Rust voice session"
```

---

### Task 8: The Angular voice engine

**Files:**
- Create: `src/app/services/voice-engine.service.ts`

**Interfaces:**
- Produces: `VoiceEngineService` with `start(target, settings)`, `stop()`, `setMute(b)`, `setPttOpen(b)`, `applySettings(s)`, and signals `speaking`, `level`, `active`

- [ ] **Step 1: Write the service**

```typescript
import {Injectable, signal} from '@angular/core';
import {Channel, invoke} from '@tauri-apps/api/core';
import {AudioSettingsService} from './audio-settings.service';
import {iceServers} from './screen-publish';
import {isTauri} from './platform';

/** Which call surface the session belongs to. Mirrors the Rust `VoiceTarget`. */
export type VoiceTarget =
    | {kind: 'guild'; guildId: string; channelId: string}
    | {kind: 'call'; callId: string};

interface VoiceEvent {
    kind: 'speaking' | 'error';
    speaking: boolean;
    level: number;
    message?: string;
}

export interface VoiceStartResult {
    cfSessionId: string;
    trackName: string;
}

/**
 * The Angular face of the Rust voice session.
 *
 * Every call service talks to this rather than to `invoke` directly, so the fact that there is
 * exactly one microphone and one session is enforced in one place.
 */
@Injectable({providedIn: 'root'})
export class VoiceEngineService {
    /** Whether the local user is currently transmitting. The only speaking signal in the app. */
    readonly speaking = signal(false);
    /** Input level, 0.0-1.0, for the microphone meter. */
    readonly level = signal(0);
    readonly active = signal(false);

    constructor(private readonly audioSettings: AudioSettingsService) {}

    /** Whether the Rust engine is available at all. */
    available(): boolean {
        return isTauri();
    }

    /**
     * `apiBase` and `token` are passed in rather than read here, matching how the screen publisher
     * is called (`publishOptions(..., this.apiConfig.baseUrl(), this.oauth.getAccessToken(), ...)`).
     * Rust owns neither session lifetime nor token refresh.
     */
    async start(target: VoiceTarget, apiBase: string, token: string): Promise<VoiceStartResult> {
        const channel = new Channel<VoiceEvent>();
        channel.onmessage = event => {
            if (event.kind === 'error') {
                console.error('[voice] engine error:', event.message);
                return;
            }
            this.speaking.set(event.speaking);
            this.level.set(event.level);
        };

        const result = await invoke<VoiceStartResult>('voice_start', {
            settings: this.settingsPayload(),
            // The same helper the screen publisher uses, so both agree on which servers are usable
            // and drop the entries with no URLs.
            iceServers: iceServers(),
            apiBase,
            token,
            guildId: target.kind === 'guild' ? target.guildId : null,
            channelId: target.kind === 'guild' ? target.channelId : null,
            callId: target.kind === 'call' ? target.callId : null,
            onEvent: channel,
        });

        this.active.set(true);
        return result;
    }

    async stop(): Promise<void> {
        this.active.set(false);
        this.speaking.set(false);
        this.level.set(0);
        await invoke('voice_stop');
    }

    async setMute(muted: boolean): Promise<void> {
        await invoke('voice_set_mute', {muted});
    }

    async setPttOpen(open: boolean): Promise<void> {
        await invoke('voice_set_ptt_open', {open});
    }

    /** Push the current settings to a running session. Safe to call when nothing is running. */
    async applySettings(): Promise<void> {
        await invoke('voice_set_processing', {settings: this.settingsPayload()});
    }

    private settingsPayload() {
        const s = this.audioSettings.settings();
        return {
            deviceId: s.micId === 'default' ? null : s.micId,
            noiseSuppression: s.noiseSuppressionMode,
            echoCancellation: s.echoCancellation,
            autoGainControl: s.autoGainControl,
            inputMode: s.inputMode === 'push-to-talk' ? 'ptt' : 'voice',
            // `inputSensitivity` is the slider that decides when the gate opens, stored 0-100.
            // Not `vadStrength`, which is a separate 0-1 control that only applied when enhanced
            // noise suppression was on - sending that one instead would leave the gate at its
            // least sensitive setting by default and cut off anyone speaking quietly.
            sensitivity: Math.min(1, Math.max(0, s.inputSensitivity / 100)),
            bitrateBps: null,
        };
    }
}
```

**Field names are verified against `AudioSettings` as it stands:** `micId`, `noiseSuppressionMode` (`'none' | 'standard' | 'enhanced'`, matching the Rust mapping exactly), `echoCancellation`, `autoGainControl`, `inputMode` (`'voice-activity' | 'push-to-talk'`) and `inputSensitivity` (0-100). Do **not** add or rename fields here — phase 4 owns the settings rework, including collapsing `vadStrength` and `inputSensitivity` into one control.

- [ ] **Step 2: Verify it compiles**

Run: `npx ng build --configuration development`
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/services/voice-engine.service.ts
git commit -m "feat: Angular service for the Rust voice engine"
```

---

### Task 9: Cut guild voice and DM calls over

**Files:**
- Modify: `src/app/services/guild-voice.service.ts:77-79`
- Modify: `src/app/services/voice-rtc.service.ts:137-210, 251-254`
- Modify: `src/app/services/call-webrtc.service.ts` (the equivalent region)

**This is the only task in the plan that can break a working feature.** Everything before it is additive. Do it last, and verify at runtime before committing.

**The change.** The webview stops calling `getUserMedia` for the microphone and stops adding an audio track. Rust publishes the microphone on its own Cloudflare session, opened with `primary=true`. The webview's session becomes `primary=false`. The webview still subscribes to and plays every remote track, exactly as now.

**Ordering is load-bearing.** Start the Rust session *before* the webview creates its own. Two primary sessions at once is the state the backend's device-takeover logic reacts to, and in a DM call that hangs up the call.

- [x] **Step 1: Confirm the backend behaviour before changing anything**

> **Settled from the backend source (`RiderProjects/Echo`), not at runtime. The assumption holds,
> and for a more specific reason than assumed.**
>
> `GuildCloudflareController.TracksNew` (line 95) looks for a track that is exactly
> `{Location: "local", TrackName: "audio"}`. When it finds one it calls
> `ExchangeParticipantJoined(channelId, body.CfSessionId)` (line 134), which sets **both**
> `me.CfSessionId = cfSessionId` and `me.AudioTrackName = "audio"` (232-233) and announces that pair
> to every other participant.
>
> So the participant's audio session is decided by **whichever session publishes a local track named
> `"audio"`** — the `?primary=` flag only writes `CfSessionId` at session-creation time and is then
> overwritten by the publish. Two consequences:
>
> 1. `voice::rtc::TRACK_NAME` **must** stay the literal `"audio"`. The backend keys on it. Its test
>    already pins this, but the reason is stronger than "so old clients can resolve it".
> 2. Ordering is not load-bearing after all. `AudioTrackName` gates the backfill announcement
>    (line 279), so the window where `CfSessionId` points at a session with no audio announces
>    nothing. Starting the Rust session first is still preferable, but it is no longer a correctness
>    requirement.
>
> **The runtime spike could never have answered this**, and that is by design: `VoiceState.cs:42-44`
> says the HTTP response omits both fields *"so clients discover them only via ParticipantJoined
> events (prevents pulling remote tracks before pushing local, which causes Cloudflare 425)"*. The
> spike read `undefined` for both because the backend deliberately leaves them out. Adding them to
> `VoiceStateResponse` to make verification easier would reintroduce that bug class — do not.
>
> **Carry into Step 3:** after the cutover the webview publishes no local track at all, so its first
> `tracks/new` is an all-remote pull on a fresh session — precisely the 425 condition that comment
> describes. The backend already routes all-remote requests through `TracksNewWithRetryAsync`
> (lines 117-119), which is what makes this safe. Verify it in Step 6 rather than assuming it.

<details>
<summary>Original runtime procedure, kept for reference — superseded by the source reading above</summary>

This is the design's stated highest-risk assumption and it has not been tested. Add a temporary log and run a two-client call with the *current* build plus only the Rust session started alongside:

```typescript
// TEMPORARY - remove before committing Step 3.
const rust = await this.voiceEngine.start(
    {kind: 'guild', guildId, channelId},
    this.apiConfig.baseUrl(),
    this.oauth.getAccessToken(),
);
console.log('[voice] rust session', rust.cfSessionId, rust.trackName);
```

Both `apiConfig` and `oauth` are already injected in `voice-rtc.service.ts` — line 625 uses exactly this pair for the screen publisher.

Verify, from the second client:
1. The participant record for the first client reports the **Rust** `cfSessionId`, not the webview's.
2. The second client can subscribe to `{cfSessionId, trackName}` and hear audio.
3. Leaving and rejoining does not leave an orphaned session behind.

**If (1) does not hold, stop.** The backend picks the primary session differently than assumed and this plan's remaining steps are wrong. Report what it actually reports rather than working around it.

</details>

- [x] **Step 1b (unplanned): Fix the DM call endpoint in Rust before relying on it**

> `Signalling::voice_base` built the call route as `/api/v1/voice/calls/{id}` — the DM controller's
> own `[Route]`. But these are *gateway* paths: `Echo/Proxy/ProxyConfig.cs:34` matches
> `/api/v1/messaging/{**rest}` and rewrites it to `/api/v1/{**rest}`, so the segment after `v1`
> names the service and never appears in the controller route. The guild path had it right
> (`/api/v1/guild/guilds/...` against `[Route("api/v1/guilds/...")]`); the call path did not, and
> would have 404'd at the gateway. Pre-existing — it also affects Rust screen publishing in a DM
> call — but load-bearing for Step 4, so fixed first. The test now says why.
>
> Also checked, since Rust now creates the *primary* session: `DeviceIdResolver` treats a missing
> `X-Device-Id` as `WasProvided: false` (not unknown) and buckets it as `"default"`. The frontend
> sends that header nowhere, so Rust sending none is consistent and introduces no split-brain.

- [x] **Step 2: Give `createSession` a role**

In `src/app/services/guild-voice.service.ts`:

```typescript
    /**
     * Open a Cloudflare session.
     *
     * `primary` decides whether the backend records this session as the participant's audio. Since
     * the microphone is published from Rust, the webview's own session is secondary - it exists
     * only to receive.
     */
    createSession(guildId: string, channelId: string, primary = true): Observable<{ cfSessionId: string }> {
        return this.client.post<{ cfSessionId: string }>(
            `${this.base(guildId, channelId)}/session?primary=${primary}`, {});
    }
```

Make the equivalent change to the DM call service used by `call-webrtc.service.ts`.

- [x] **Step 3: Replace the microphone acquisition in `voice-rtc.service.ts`**

> **Two deviations from the code below, both deliberate.**
>
> 1. **No pre-added recvonly transceiver.** `subscribeAudio` already adds one transceiver per
>    target, so a pre-added spare would put an m-line in the offer that Cloudflare was never asked
>    to allocate a track for. Keeping m-lines and requested tracks one-to-one is the shape the
>    Calls API is built around. The connection simply does not negotiate until the first
>    subscription — which is correct, because until then it has nothing to carry.
> 2. **`rtcState` is now a `computed`.** Falling out of (1): alone in a channel the connection sits
>    in `'new'` forever, and the status bar reads `'new'` as "connecting". It now reports
>    `'connected'` when the peer connection has nothing to do *and* the Rust engine is up —
>    which is what the user means by the question. Real connection states, failures included, still
>    win once there is something to negotiate.
>
> Also: `connect()` lost its now-unused `ownUserId` parameter, and `setupVAD` lost its `'local'`
> branch — local speaking now comes from the engine.

Replace lines 137-176 (the whole `let audioTrack` block, including the `useRust` branch and both `getUserMedia` calls) with:

```typescript
        try {
            // The microphone is captured, processed and published entirely in Rust, on its own
            // Cloudflare session. Nothing is added to this peer connection: other clients resolve
            // the track from the participant record, which points at the Rust session.
            //
            // Started before `createSession` below, because only one session per participant may be
            // primary and the backend reacts to a second one.
            await this.voiceEngine.start(
                {kind: 'guild', guildId, channelId},
                this.apiConfig.baseUrl(),
                this.oauth.getAccessToken(),
            );
        } catch (e) {
            console.error('[voice] Rust voice engine failed to start', e);
            this.setupDone = true;
            return false;
        }

        this.pc = new RTCPeerConnection({iceServers: environment.iceServers, bundlePolicy: 'max-bundle'});
        this.pc.ontrack = e => this.handleRemoteTrack(e);
        this.pc.onconnectionstatechange = () => {
            if (this.pc) this.rtcState.set(this.pc.connectionState);
        };

        // Receive-only: this connection publishes no audio, but it still needs an audio m-line in
        // the offer so that subscriptions can be attached to it.
        this.pc.addTransceiver('audio', {direction: 'recvonly'});

        const {cfSessionId} = await firstValueFrom(
            this.guildVoiceSvc.createSession(guildId, channelId, false));
        this.cfSessionId = cfSessionId;
```

Then delete the local publish that followed it — the `tracksNew` call at lines 201-205 published `{location:'local', mid: audioMid, trackName:'audio'}` and there is no longer a local track to publish. The webview's first `tracksNew` is now whatever the first *subscription* issues.

Also remove, in the same file:
- `this.vadProbeTrack` and the `setupVAD('local', ...)` call — speaking state now comes from `VoiceEngineService.speaking`.
- `this.localAudioTrack?.stop()`, `this.vadProbeTrack?.stop()` and `void this.rustMedia.stopMicCapture()` in `teardown()` (lines 251-254), replaced with `void this.voiceEngine.stop()`.
- `this.cfAudioTrackName` from `getActiveTrackNames()` — the Rust session closes its own track, exactly as the screen publisher does.

- [x] **Step 4: Make the same change in `call-webrtc.service.ts`**

The structure differs but the shape of the change is identical: start the engine with `{kind: 'call', callId}`, create the session with `primary=false`, add a recvonly audio transceiver, publish no local audio track, and stop the engine in teardown. Read the file's own setup method rather than pattern-matching this diff onto it.

- [x] **Step 5: Point mute and push-to-talk at the engine**

Find every existing caller that toggled `localAudioTrack.enabled` and route it to `voiceEngine.setMute` / `setPttOpen`. Muting by disabling a track no longer works, because there is no local track — and this fails *silently*, which makes it the most likely thing to be missed.

> Done in `VoiceChannelService.syncMic()` and `CallWebRtcService`'s mute effect. Mute and the talk
> key stay two separate facts rather than being collapsed into one boolean, because the engine's
> voice-activity gate has to tell "muted" apart from "talk key up".
>
> **Three things this step turned up that the plan did not anticipate:**
>
> - **The gate had to be seeded on join.** `Control::default()` leaves `ptt_down` false, and in
>   push-to-talk mode that means shut. Nothing called `syncMic` until the user toggled something, so
>   a push-to-talk user would have joined silent with no indication why. `joinChannel` and
>   `connect()` now push the state once, immediately after the engine starts.
> - **Settings changes had to be pushed live.** The input-mode switch now reads in Rust, so without
>   an effect feeding `voice_set_processing`, changing it mid-call would have silently done nothing
>   until the next join. `VoiceEngineService` now watches the settings signal. The input *device* is
>   still join-time only — it is chosen when the capture stream opens.
> - **Two VAD implementations became one.** `applyVadGate` (both services), `startSpeakingDetection`,
>   `vadProbeTrack` and `setupVAD('local', …)` are gone. The speaking indicator is now the same
>   decision that picks which frames get transmitted, so the two can no longer disagree — which they
>   did, because the analyser judged a *clone* of the track the gate was muting.
>
> `IsleVoiceRtcService.setMicEnabled` is untouched — Isle keeps its own path until phase 3.

- [ ] **Step 6: Verify at runtime, with two clients**

> **Not runnable here — this needs two clients and a live backend.** What is verified: 199 Rust
> tests, `tsc --noEmit`, and a full `ng build` (so templates too). Every item below is unverified.
>
> Watch in particular:
> - **The 425 window.** The webview's first `tracks/new` is now an all-remote pull on a fresh
>   session — exactly the condition `VoiceState.cs:42-44` warns about. `TracksNewWithRetryAsync`
>   (`GuildCloudflareController.cs:117-119`, `CloudflareController.cs:115-117`) should absorb it.
>   If a participant is silently unheard on join, that is where to look.
> - **An offer with no local m-lines.** Nothing negotiates until the first subscription now. If
>   Cloudflare rejects a first offer that carries only recvonly m-lines, this is the step that finds
>   out.

> **Run 2026-07-31. Guild voice confirmed in both join orders, against a peer on the previous
> build. Three bugs found, all in the first two minutes of real use — none of which any test in
> this plan would have caught, because all three are about what happens when something is slow.**
>
> 1. **STUN servers passed to the Rust engine** (`voice-engine.service.ts`), copied from the screen
>    publisher. Cloudflare's SFU is publicly routable and answers to the source address it sees —
>    which is why `call-webrtc.service.ts` has never passed any. Bought nothing, added the one step
>    in ICE gathering that can block on the network. *Found by the user asking why ICE was involved
>    at all.*
> 2. **`rtc::start` awaited `gathering_complete_promise` with no timeout**, so (1) had no upper
>    bound. Now capped at 5s, offering with the candidates gathered so far.
> 3. **`connect()` awaited the engine while holding the negotiation queue blocked** — so a slow
>    engine start stalled subscriptions on a *different* peer connection, permanently. This is what
>    turned a slow start into one-way silence. Sending and receiving are independent here; the
>    engine start now happens outside that block.
>
> Plus a leak: a page reload does not unwind Rust, so a reloaded webview left a session capturing
> and publishing into the channel — audible to everyone else, invisible locally. Now stopped on
> `beforeunload`.
>
> **The debugging lesson worth keeping:** the symptom was silence with an empty console *and* empty
> backend logs, and I spent three rounds theorising about which side dropped the event. The thing
> that actually settled it was adding a log line before the negotiation queue and one after it —
> "never subscribed" and "subscribed and failed" had been indistinguishable from outside. Commit
> `6ed96e8` keeps those permanently.

- [x] Both clients hear each other in a guild channel.
- [ ] Both clients hear each other in a DM call.
- [ ] Mute silences the far end, and the muted user's own speaking indicator goes out.
- [ ] Push-to-talk transmits only while the key is down.
- [ ] The speaking indicator matches who is actually talking.
- [ ] Screen sharing still works, still with its own session, and its audio is unaffected.
- [ ] Leaving and rejoining works, twice in a row — this is where an orphaned session shows up.
- [x] A client on the **previous** build can still hear a client on the new build.

> **Still open.** Guild voice in both orders and old-build interop are confirmed; everything above
> without a tick was not exercised. The DM call path is the one to worry about — it has had zero
> runtime exposure and contains a URL (`/api/v1/messaging/voice/calls/...`) that has never once been
> hit successfully, because it was wrong until this phase.

- [x] **Step 7: Remove the temporary logging from Step 1, then commit**

```bash
git add src/app/services/
git commit -m "feat: publish the microphone from Rust for guild voice and DM calls"
```

- [ ] **Step 8: Push**

```bash
git push origin main
```

---

## Rollback

Steps 1-8 are additive: the Rust engine is dormant until something calls `voice_start`. Only Task 9 changes behaviour, and reverting that one commit restores the previous path in full, because this plan deliberately leaves `media/audio.rs`, `audio-capture-processor.js` and `RustMediaService.startMicCapture` untouched. Phase 4 removes them, once this has held up in use.

## What this phase does not do

- **Playout is still the webview's.** Remote audio still arrives on the webview's peer connection and plays through `<audio>` elements. The jitter buffer and mixer built in the DSP foundation are not yet used by anything.
- **Echo cancellation has no reference signal yet.** `process_render` is never called, because Rust does not render the mix until phase 2. AEC3 will run without a reference and cancel nothing until then — expect echo on speakers to be no better than it is today, and no worse.
- **Isle is untouched.** It keeps its own WebAudio path until phase 3.
- **The dead settings are still dead.** `inputVolume` and `outputVolume` are wired in phase 4.
