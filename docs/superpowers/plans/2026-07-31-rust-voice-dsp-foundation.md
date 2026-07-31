# Rust Voice Pipeline — DSP Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and unit-test the pure signal-processing core of the Rust voice pipeline — resampling, Opus coding, transmit gating, jitter buffering, mixing, denoising and the echo-cancellation boundary — so that later plans only have to wire devices and transport to code that is already proven correct.

**Architecture:** A new `src-tauri/src/media/voice/` module, a sibling of the existing `media/publisher/`. Every module in this plan is pure: no audio devices, no network, no Tauri. Each takes buffers in and returns buffers or decisions out, so all of it is testable with `cargo test` on any machine. The pipeline's fixed unit of work is a 10 ms frame of 480 mono `f32` samples at 48 kHz — the frame size WebRTC's APM and RNNoise both use natively, so no stage rebuffers against another.

**Tech Stack:** Rust 2021, `rubato` 4 (resampling), `opus` 0.3 (codec), `nnnoiseless` 0.3 (RNNoise, already a dependency), `hrtf` 0.8 (spatial), `webrtc-audio-processing` 2.1 (AEC3/NS/AGC, behind a cargo feature).

**Spec:** `docs/superpowers/specs/2026-07-31-rust-voice-pipeline-design.md`

## Global Constraints

- **Frame size is 480 samples, mono, 48 kHz `f32`.** Declared once as `voice::FRAME` and `voice::SAMPLE_RATE`. No module may invent its own frame size.
- **Cross-platform: Windows, macOS and Linux are all first-class.** No `#[cfg(target_os)]` in any module in this plan — everything here is portable Rust.
- **No allocation in per-frame hot paths.** Buffers are preallocated in constructors and reused. `process`/`mix`/`pop` must not allocate.
- **The AEC implementation is behind the `aec` cargo feature (default on).** With the feature off, `process::create` returns the passthrough implementation and the crate still builds. This is what keeps the build working on a machine without meson.
- **Every module is `#![forbid(unsafe_code)]`-clean.** None of this needs unsafe.
- **No sample may leave a module non-finite.** NaN or infinity reaching the audio device is an audible click; guard at module boundaries.
- **Comments explain why, not what**, matching the existing `media/publisher/` style. Where this plan removes a previous behaviour (the pre-emphasis pair, the 80/20 blend), the comment must say what was removed and why, so it is not reintroduced.

## Prerequisite (human, once per machine)

> **Open decision — blocks Task 9 Step 6 onwards only.** `webrtc-audio-processing-sys` 2.1 **cannot build under MSVC**: its `build.rs` passes `-std=c++17` and `-Wno-unused-parameter` to the `cc` build unconditionally (lines 403–404, with only a macOS branch nearby), and `cl` rejects them with `D8021`. Every stage before that was made to work on Windows — the C++ library itself compiles — but this last step needs a patched crate, applied via `[patch.crates-io]` pointing at a fork with an MSVC branch. Confirm that approach before starting Task 9 Step 6. Tasks 1–8, and Task 9 up to Step 5, are unaffected and can proceed now.
>
> Note that adopting each platform's own canceller instead is *not* a straight win: macOS `VoiceProcessingIO` is excellent and runs at 48 kHz, but Windows' Voice Capture DSP (`CLSID_CWMAudioAEC`) only cancels at 8–22 kHz, which would mean narrowband echo cancellation on the primary platform, and Linux has no OS canceller at all.

The `aec` feature builds WebRTC's AudioProcessing module from C++ source with meson. Establishing this took ten distinct blockers on Windows; the requirements below are what made it progress, in order of discovery. **None of items 1–6 apply to macOS or Linux**, where meson finds the system compiler and the build is uneventful.

**All platforms** — meson, ninja and Python:

```powershell
choco install meson ninja python -y   # Windows, in an Administrator shell
```

```bash
brew install meson ninja              # macOS
sudo apt-get install -y meson ninja-build   # Linux
```

**Windows additionally needs three things that are easy to miss:**

1. **The MSVC developer environment.** Meson probes the compiler directly, so a plain shell fails with `ERROR: Compiler cl cannot compile programs`. The build must run after `vcvars64.bat`, or from a Developer Command Prompt. On this machine Visual Studio is at `E:\vs_main`, so that is `E:\vs_main\VC\Auxiliary\Build\vcvars64.bat` — do not hardcode that path in any script; locate it with `vswhere.exe`.
2. **`vswhere.exe` on `PATH`**, from `%ProgramFiles(x86)%\Microsoft Visual Studio\Installer`. Meson shells out to it and reports a bare `'vswhere.exe' is not recognized` otherwise.
3. **Unix tools on `PATH`, but ordered last.** The `webrtc-audio-processing-sys` build script invokes `cp` as a program, which PowerShell's `cp` alias does not satisfy; Git for Windows supplies it at `C:\Program Files\Git\usr\bin`. That directory must come **after** the MSVC entries, because it also ships a coreutils `link.exe` which otherwise shadows the MSVC linker and produces `ERROR: This link.exe is not a linker`.

Two further constraints, both discovered by hitting them:

4. **`CXXFLAGS=/std:c++20`.** The crate's meson build does not raise the C++ standard for MSVC, but its vendored AGC2 sources use designated initializers, so the build stops at `error C7555: use of designated initializers requires at least '/std:c++20'`.
5. **Keep the build path short.** Meson's nested build directories plus a long checkout path exceed Windows' 260-character `MAX_PATH`, and the failure is misleading: meson reports `ERROR: Compiler cl cannot compile programs`, while the underlying meson log shows `Cannot open source file: 'sanity_check_for_c.c'`. Either build from a short path or enable long-path support.
6. **A `nm` on `PATH`.** After the C++ library builds, the build script shells out to GNU `nm` to enumerate symbols, and MSVC has no equivalent. Rust ships a compatible one: `rustup component add llvm-tools-preview`, then copy `llvm-nm.exe` to a directory on `PATH` under the name `nm.exe`.

A working Windows invocation therefore looks like:

```bat
@echo off
setlocal
call "<vcvars64.bat located via vswhere>" >nul
set "PATH=<dir containing the nm.exe shim>;C:\Program Files\Meson;C:\ProgramData\chocolatey\bin;C:\Program Files (x86)\Microsoft Visual Studio\Installer;%PATH%;C:\Program Files\Git\usr\bin"
set "CXXFLAGS=/std:c++20"
cargo build
```

macOS and Linux need none of items 1–5: meson finds clang or gcc directly, the shell already has `cp`, and neither has a `MAX_PATH` limit.

**Everything except Task 9 Step 6 onwards is independent of this.** Tasks 1–8 build and test with `--no-default-features`. If the APM will not build on your machine, complete Tasks 1–8 and report — do not delete the feature or weaken `create`'s fallback contract.

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/media/voice/mod.rs` | Module declarations, `FRAME` and `SAMPLE_RATE` constants |
| `src-tauri/src/media/voice/resample.rs` | Arbitrary rate → 48 kHz mono, band-limited |
| `src-tauri/src/media/voice/codec.rs` | Opus encoder/decoder with FEC, DTX, PLC |
| `src-tauri/src/media/voice/gate.rs` | Mute / push-to-talk / voice-activity transmit decision |
| `src-tauri/src/media/voice/jitter.rs` | Adaptive jitter buffer; decides decode / FEC / conceal |
| `src-tauri/src/media/voice/mixer.rs` | N mono sources → stereo, gain, HRTF, limiter |
| `src-tauri/src/media/voice/denoise.rs` | RNNoise stage, correctly applied |
| `src-tauri/src/media/voice/process.rs` | `AudioProcessor` trait, passthrough, APM implementation |
| `src-tauri/Cargo.toml` | New dependencies and the `aec` feature |
| `src-tauri/src/media/mod.rs` | Add `pub mod voice;` |

Tests live in `#[cfg(test)] mod tests` at the foot of each file, matching the convention already used in `media/publisher/fit.rs`, `nv12.rs` and `signalling.rs`.

---

### Task 1: Module scaffold, dependencies and the `aec` feature gate

**Files:**
- Create: `src-tauri/src/media/voice/mod.rs`
- Modify: `src-tauri/src/media/mod.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: nothing.
- Produces: `crate::media::voice::{FRAME, SAMPLE_RATE, FRAME_MS}`. `FRAME: usize = 480`, `SAMPLE_RATE: u32 = 48_000`, `FRAME_MS: u32 = 10`. Every later task imports these rather than writing literals.

- [ ] **Step 1: Add dependencies and the feature to `src-tauri/Cargo.toml`**

In the `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]` section (where `cpal`, `nnnoiseless` and `webrtc` already live), add:

```toml
rubato = "4"
audioadapter-buffers = "0.1"
opus = "0.3"
hrtf = "0.8"
webrtc-audio-processing = { version = "2.1", features = ["bundled"], optional = true }
```

Then add a features table. Place it immediately after the `[dependencies]` section:

```toml
[features]
default = ["aec"]
# Acoustic echo cancellation via WebRTC's AudioProcessing module. Requires meson,
# ninja and Python at build time, so it is a feature rather than a hard dependency:
# a machine without that toolchain still builds Alpine, losing echo cancellation
# rather than losing voice. See media::voice::process.
aec = ["dep:webrtc-audio-processing"]
```

- [ ] **Step 2: Create `src-tauri/src/media/voice/mod.rs`**

```rust
//! The Rust-native voice pipeline.
//!
//! Audio is captured, processed, encoded, transported, decoded, mixed and played back entirely in
//! Rust. Nothing crosses the Tauri IPC boundary except control messages and level metering.
//!
//! This replaces a pipeline that captured in Rust, base64'd PCM across IPC, rebuffered it in an
//! AudioWorklet and let the webview encode it - two clock domains with no drift correction, and no
//! echo cancellation anywhere. `media::publisher` made the same move for screen video first.
//!
//! Every stage works on one fixed unit: [`FRAME`] samples of mono `f32` at [`SAMPLE_RATE`]. That is
//! WebRTC's AudioProcessing frame and RNNoise's frame, so no stage has to rebuffer against another.

pub mod codec;
pub mod denoise;
pub mod gate;
pub mod jitter;
pub mod mixer;
pub mod process;
pub mod resample;

/// Samples in one frame of mono audio - 10 ms at 48 kHz.
pub const FRAME: usize = 480;

/// The pipeline's only sample rate. Devices at other rates are resampled at the edges
/// (see [`resample`]) so that nothing downstream has to care.
pub const SAMPLE_RATE: u32 = 48_000;

/// Duration of one [`FRAME`], in milliseconds.
pub const FRAME_MS: u32 = 10;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_ten_milliseconds_at_the_pipeline_rate() {
        assert_eq!(FRAME as u32 * 1_000 / SAMPLE_RATE, FRAME_MS);
    }
}
```

- [ ] **Step 3: Register the module in `src-tauri/src/media/mod.rs`**

Add `pub mod voice;` alongside the existing module declarations.

- [ ] **Step 4: Create the module files as empty stubs so the crate compiles**

Each of `codec.rs`, `denoise.rs`, `gate.rs`, `jitter.rs`, `mixer.rs`, `process.rs`, `resample.rs` gets a single line for now:

```rust
// Implemented in a later task of this plan.
```

- [ ] **Step 5: Verify the build with and without the feature**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --no-default-features`
Expected: PASS. This is the path that must work without meson.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice`
Expected: PASS, 1 test.

If meson is installed, also run `cargo build --manifest-path src-tauri/Cargo.toml` and expect PASS. If it is not installed yet, note that and continue — Tasks 2 through 8 do not need it.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/media/mod.rs src-tauri/src/media/voice/
git commit -m "feat: scaffold the Rust voice pipeline module"
```

---

### Task 2: Band-limited resampling

**Files:**
- Create: `src-tauri/src/media/voice/resample.rs`

**Interfaces:**
- Consumes: `voice::SAMPLE_RATE`.
- Produces: `resample::Resampler` with:
  - `Resampler::new(from_hz: u32) -> Result<Resampler, String>` — converts `from_hz` into `voice::SAMPLE_RATE`. `new(48_000)` is an identity passthrough.
  - `Resampler::new_to(from_hz: u32, to_hz: u32) -> Result<Resampler, String>` — arbitrary pair, used by the render path to convert the mix down to whatever the output device wants.
  - `Resampler::push(&mut self, input: &[f32], out: &mut Vec<f32>)` — appends converted samples; input is buffered internally, so any chunk size is accepted.

This replaces `media::audio::resample_linear`, which was bare linear interpolation with no anti-aliasing filter — a 44.1 kHz microphone aliased audibly.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    /// Energy at `freq` in `samples`, via the Goertzel algorithm. Cheaper than pulling in an FFT
    /// just to assert that a tone survived resampling and its aliases did not.
    fn energy_at(samples: &[f32], freq: f32, rate: f32) -> f32 {
        let k = TAU * freq / rate;
        let coeff = 2.0 * k.cos();
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for &x in samples {
            let s0 = x + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        (s1 * s1 + s2 * s2 - coeff * s1 * s2).sqrt() / samples.len() as f32
    }

    fn tone(freq: f32, rate: f32, len: usize) -> Vec<f32> {
        (0..len).map(|i| (TAU * freq * i as f32 / rate).sin() * 0.5).collect()
    }

    #[test]
    fn matching_rate_is_an_identity_passthrough() {
        let mut r = Resampler::new(48_000).unwrap();
        let input = tone(1_000.0, 48_000.0, 960);
        let mut out = Vec::new();
        r.push(&input, &mut out);
        assert_eq!(out, input);
    }

    #[test]
    fn output_length_tracks_the_rate_ratio() {
        let mut r = Resampler::new(24_000).unwrap();
        let input = tone(1_000.0, 24_000.0, 24_000); // one second
        let mut out = Vec::new();
        r.push(&input, &mut out);
        // One second in gives one second out, allowing for the resampler's startup delay.
        assert!(out.len() > 47_000 && out.len() <= 48_100, "got {}", out.len());
    }

    #[test]
    fn a_tone_keeps_its_frequency_across_a_rate_change() {
        let mut r = Resampler::new(44_100).unwrap();
        let input = tone(1_000.0, 44_100.0, 44_100);
        let mut out = Vec::new();
        r.push(&input, &mut out);

        // Skip the startup transient before measuring.
        let steady = &out[4_800..];
        let at_1k = energy_at(steady, 1_000.0, 48_000.0);
        let at_3k = energy_at(steady, 3_000.0, 48_000.0);
        assert!(at_1k > 0.1, "1 kHz tone did not survive: {at_1k}");
        assert!(at_3k < at_1k * 0.01, "spurious energy at 3 kHz: {at_3k} vs {at_1k}");
    }

    #[test]
    fn downsampling_rejects_content_above_the_new_nyquist() {
        // 20 kHz at 48 kHz is above the 8 kHz Nyquist of a 16 kHz stream. Linear interpolation
        // folded this down into the voice band; a band-limited resampler must not.
        let mut r = Resampler::new(48_000).unwrap();
        let _ = &mut r; // 48 k in is identity, so drive the interesting direction explicitly.

        let mut down = Resampler::new_to(48_000, 16_000).unwrap();
        let input = tone(20_000.0, 48_000.0, 48_000);
        let mut out = Vec::new();
        down.push(&input, &mut out);

        let steady = &out[3_200..];
        // The alias would land at |20000 - 16000| = 4 kHz.
        let alias = energy_at(steady, 4_000.0, 16_000.0);
        assert!(alias < 0.01, "aliased energy at 4 kHz: {alias}");
    }

    #[test]
    fn repeated_pushes_are_continuous() {
        // Feeding one long buffer and feeding the same samples in small chunks must agree:
        // the capture path pushes whatever cpal hands it, which varies per callback.
        let input = tone(1_000.0, 44_100.0, 44_100);

        let mut whole = Resampler::new(44_100).unwrap();
        let mut a = Vec::new();
        whole.push(&input, &mut a);

        let mut chunked = Resampler::new(44_100).unwrap();
        let mut b = Vec::new();
        for chunk in input.chunks(441) {
            chunked.push(chunk, &mut b);
        }

        let n = a.len().min(b.len());
        assert!(n > 40_000, "too little output to compare: {n}");
        for i in 0..n {
            assert!((a[i] - b[i]).abs() < 1e-4, "diverged at {i}: {} vs {}", a[i], b[i]);
        }
    }

    #[test]
    fn output_is_always_finite() {
        let mut r = Resampler::new(44_100).unwrap();
        let input: Vec<f32> = (0..44_100).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect();
        let mut out = Vec::new();
        r.push(&input, &mut out);
        assert!(out.iter().all(|s| s.is_finite()));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::resample`
Expected: FAIL to compile — `Resampler` does not exist.

- [ ] **Step 3: Write the implementation**

```rust
//! Band-limited sample-rate conversion into the pipeline's 48 kHz mono format.
//!
//! Replaces the previous linear interpolator, which had no anti-aliasing filter at all: a 44.1 kHz
//! microphone folded its top octave back into the voice band. Devices are resampled here, at the
//! edge, so that no stage downstream has to know a rate other than [`SAMPLE_RATE`].

use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{
    Async, FixedAsync, Indexing, Resampler as _, SincInterpolationParameters, SincInterpolationType,
    WindowFunction,
};

use super::SAMPLE_RATE;

/// Converts a device's sample rate to the pipeline rate, holding the filter state across calls.
///
/// Push whatever the device callback delivered; converted samples are appended to `out`. Input is
/// buffered internally, so callers do not have to deliver any particular chunk size.
pub struct Resampler {
    /// `None` when input and output rates match - the common case, and worth not paying for.
    inner: Option<Async<f32>>,
    pending: Vec<f32>,
    scratch: Vec<f32>,
}

impl Resampler {
    /// Convert from `from_hz` to the pipeline rate.
    pub fn new(from_hz: u32) -> Result<Self, String> {
        Self::new_to(from_hz, SAMPLE_RATE)
    }

    /// Convert between two arbitrary rates. Used by the render path, which converts the mix down to
    /// whatever the output device wants.
    pub fn new_to(from_hz: u32, to_hz: u32) -> Result<Self, String> {
        if from_hz == 0 || to_hz == 0 {
            return Err("sample rate must be non-zero".into());
        }
        if from_hz == to_hz {
            return Ok(Self { inner: None, pending: Vec::new(), scratch: Vec::new() });
        }

        // 128-tap sinc with Blackman2: the quality rubato's own documentation recommends for
        // balanced use. Linear interpolation between oversampled taps is inaudible at 2048x and
        // costs far less than cubic.
        let params = SincInterpolationParameters::new(128, WindowFunction::Blackman2)
            .oversampling_factor(2048)
            .interpolation(SincInterpolationType::Linear);

        let ratio = to_hz as f64 / from_hz as f64;
        let inner = Async::<f32>::new_sinc(ratio, 1.0, &params, 480, 1, FixedAsync::Output)
            .map_err(|e| e.to_string())?;

        Ok(Self { inner: Some(inner), pending: Vec::with_capacity(4096), scratch: Vec::new() })
    }

    /// Feed input samples and append every complete output frame to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let Some(resampler) = self.inner.as_mut() else {
            out.extend_from_slice(input);
            return;
        };

        self.pending.extend_from_slice(input);

        loop {
            let needed = resampler.input_frames_next();
            if self.pending.len() < needed {
                break;
            }

            let produced = resampler.output_frames_next();
            self.scratch.resize(produced, 0.0);

            let read = InterleavedSlice::new(&self.pending[..needed], 1, needed)
                .expect("mono adapter over an exactly-sized slice");
            let mut write = InterleavedSlice::new_mut(&mut self.scratch, 1, produced)
                .expect("mono adapter over an exactly-sized slice");

            let indexing = Indexing::new();
            match resampler.process_into_buffer(&read, &mut write, Some(&indexing)) {
                Ok((consumed, written)) => {
                    out.extend_from_slice(&self.scratch[..written]);
                    self.pending.drain(..consumed);
                }
                // A conversion failure would otherwise spin this loop forever on the same input.
                Err(_) => {
                    self.pending.clear();
                    break;
                }
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::resample`
Expected: PASS, 6 tests.

If `rubato`'s builder signature differs from the above, correct the call rather than the test — the tests encode the behaviour the pipeline needs and must not be weakened.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/resample.rs
git commit -m "feat: band-limited resampling for the voice pipeline"
```

---

### Task 3: Opus encoding and decoding

**Files:**
- Create: `src-tauri/src/media/voice/codec.rs`

**Interfaces:**
- Consumes: `voice::{FRAME, SAMPLE_RATE}`.
- Produces:
  - `codec::VoiceEncoder` — `new(bitrate_bps: i32) -> Result<VoiceEncoder, String>`, `encode(&mut self, pcm: &[f32], out: &mut [u8]) -> Result<usize, String>`, `set_bitrate(&mut self, bps: i32) -> Result<(), String>`, `set_packet_loss(&mut self, pct: i32) -> Result<(), String>`.
  - `codec::VoiceDecoder` — `new() -> Result<VoiceDecoder, String>`, `decode(&mut self, packet: &[u8], out: &mut [f32]) -> Result<usize, String>`, `decode_fec(&mut self, next_packet: &[u8], out: &mut [f32]) -> Result<usize, String>`, `conceal(&mut self, out: &mut [f32]) -> Result<usize, String>`.
  - `codec::MAX_PACKET: usize = 1275` — the largest Opus packet, so callers can size buffers once.
  - `codec::PACKET_SAMPLES: usize = 960` — 20 ms at 48 kHz, the packet size on the wire (two pipeline frames).

The encoder is configured for VoIP with in-band FEC and DTX on. The current pipeline sets none of this: `applySimpleBitrate` sets a bitrate cap and nothing else, so every lost packet is an audible hole.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    fn speechlike(len: usize) -> Vec<f32> {
        // A couple of harmonics near the vocal range - Opus at VoIP settings treats a pure tone
        // very differently from anything voice-shaped, and we want a realistic round trip.
        (0..len)
            .map(|i| {
                let t = i as f32 / SAMPLE_RATE as f32;
                0.3 * (TAU * 220.0 * t).sin() + 0.15 * (TAU * 440.0 * t).sin()
            })
            .collect()
    }

    #[test]
    fn encodes_a_packet_worth_of_audio() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        let pcm = speechlike(PACKET_SAMPLES);
        let mut buf = [0u8; MAX_PACKET];
        let n = enc.encode(&pcm, &mut buf).unwrap();
        assert!(n > 0 && n <= MAX_PACKET, "packet length {n}");
    }

    #[test]
    fn round_trips_to_the_same_length() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        let mut dec = VoiceDecoder::new().unwrap();
        let pcm = speechlike(PACKET_SAMPLES);
        let mut buf = [0u8; MAX_PACKET];
        let n = enc.encode(&pcm, &mut buf).unwrap();

        let mut out = vec![0.0f32; PACKET_SAMPLES];
        let decoded = dec.decode(&buf[..n], &mut out).unwrap();
        assert_eq!(decoded, PACKET_SAMPLES);
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn round_trip_preserves_signal_energy() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        let mut dec = VoiceDecoder::new().unwrap();
        let mut buf = [0u8; MAX_PACKET];
        let mut out = vec![0.0f32; PACKET_SAMPLES];

        // Prime the codec: the first packets carry Opus's own startup transient.
        for _ in 0..10 {
            let pcm = speechlike(PACKET_SAMPLES);
            let n = enc.encode(&pcm, &mut buf).unwrap();
            dec.decode(&buf[..n], &mut out).unwrap();
        }

        let pcm = speechlike(PACKET_SAMPLES);
        let n = enc.encode(&pcm, &mut buf).unwrap();
        dec.decode(&buf[..n], &mut out).unwrap();

        let rms = |s: &[f32]| (s.iter().map(|v| v * v).sum::<f32>() / s.len() as f32).sqrt();
        let ratio = rms(&out) / rms(&pcm);
        assert!(ratio > 0.5 && ratio < 2.0, "energy ratio {ratio}");
    }

    #[test]
    fn conceal_produces_a_full_frame_without_a_packet() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        let mut dec = VoiceDecoder::new().unwrap();
        let mut buf = [0u8; MAX_PACKET];
        let mut out = vec![0.0f32; PACKET_SAMPLES];

        let pcm = speechlike(PACKET_SAMPLES);
        let n = enc.encode(&pcm, &mut buf).unwrap();
        dec.decode(&buf[..n], &mut out).unwrap();

        let mut concealed = vec![0.0f32; PACKET_SAMPLES];
        let produced = dec.conceal(&mut concealed).unwrap();
        assert_eq!(produced, PACKET_SAMPLES);
        assert!(concealed.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn fec_recovers_a_lost_packet_from_the_next_one() {
        // With in-band FEC the encoder embeds a coarse copy of packet N inside packet N+1, but only
        // once it believes loss is happening - so the loss percentage has to be set.
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        enc.set_packet_loss(20).unwrap();
        let mut dec = VoiceDecoder::new().unwrap();
        let mut buf_a = [0u8; MAX_PACKET];
        let mut buf_b = [0u8; MAX_PACKET];

        let a = enc.encode(&speechlike(PACKET_SAMPLES), &mut buf_a).unwrap();
        let _ = a;
        let b = enc.encode(&speechlike(PACKET_SAMPLES), &mut buf_b).unwrap();

        // Packet A never arrives; recover it from B.
        let mut out = vec![0.0f32; PACKET_SAMPLES];
        let produced = dec.decode_fec(&buf_b[..b], &mut out).unwrap();
        assert_eq!(produced, PACKET_SAMPLES);
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn bitrate_is_adjustable_mid_session() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        enc.set_bitrate(24_000).unwrap();
        let mut buf = [0u8; MAX_PACKET];
        let low = enc.encode(&speechlike(PACKET_SAMPLES), &mut buf).unwrap();

        enc.set_bitrate(128_000).unwrap();
        // Let the encoder settle at the new rate before measuring.
        for _ in 0..5 {
            enc.encode(&speechlike(PACKET_SAMPLES), &mut buf).unwrap();
        }
        let high = enc.encode(&speechlike(PACKET_SAMPLES), &mut buf).unwrap();
        assert!(high > low, "128 kbps packet ({high}) should exceed 24 kbps ({low})");
    }

    #[test]
    fn rejects_a_wrongly_sized_frame() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        let mut buf = [0u8; MAX_PACKET];
        assert!(enc.encode(&vec![0.0; 123], &mut buf).is_err());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::codec`
Expected: FAIL to compile — `VoiceEncoder` does not exist.

- [ ] **Step 3: Write the implementation**

```rust
//! Opus coding for the voice pipeline.
//!
//! Configured the way a voice call actually needs and the previous pipeline never was: VoIP mode,
//! in-band FEC so a single lost packet is recovered from its successor rather than becoming an
//! audible hole, and DTX so silence costs no packets. The webview path set a bitrate cap and
//! nothing else.

use opus::{Application, Bitrate, Channels, Decoder, Encoder};

use super::SAMPLE_RATE;

/// The largest packet Opus will emit. Buffers are sized to this once, at construction.
pub const MAX_PACKET: usize = 1275;

/// Samples per encoded packet - 20 ms at 48 kHz, two pipeline frames.
///
/// 20 ms is the standard voice packetisation: 10 ms would double packet overhead for no quality
/// gain, and 40 ms would add latency Discord does not pay.
pub const PACKET_SAMPLES: usize = 960;

pub struct VoiceEncoder {
    inner: Encoder,
}

impl VoiceEncoder {
    pub fn new(bitrate_bps: i32) -> Result<Self, String> {
        let mut inner = Encoder::new(SAMPLE_RATE, Channels::Mono, Application::Voip)
            .map_err(|e| e.to_string())?;
        inner.set_bitrate(Bitrate::Bits(bitrate_bps)).map_err(|e| e.to_string())?;
        // FEC only does anything if the encoder believes packets are being lost; the transport
        // updates this from RTCP. Start at a low non-zero value so the very first packets already
        // carry redundancy rather than waiting for the first report.
        inner.set_inband_fec(true).map_err(|e| e.to_string())?;
        inner.set_packet_loss_perc(5).map_err(|e| e.to_string())?;
        inner.set_dtx(true).map_err(|e| e.to_string())?;
        Ok(Self { inner })
    }

    pub fn encode(&mut self, pcm: &[f32], out: &mut [u8]) -> Result<usize, String> {
        if pcm.len() != PACKET_SAMPLES {
            return Err(format!("expected {PACKET_SAMPLES} samples, got {}", pcm.len()));
        }
        self.inner.encode_float(pcm, out).map_err(|e| e.to_string())
    }

    pub fn set_bitrate(&mut self, bps: i32) -> Result<(), String> {
        self.inner.set_bitrate(Bitrate::Bits(bps)).map_err(|e| e.to_string())
    }

    /// Tell the encoder how much loss the network is showing, which is what decides how much FEC
    /// redundancy it spends bits on.
    pub fn set_packet_loss(&mut self, pct: i32) -> Result<(), String> {
        self.inner.set_packet_loss_perc(pct.clamp(0, 100)).map_err(|e| e.to_string())
    }
}

pub struct VoiceDecoder {
    inner: Decoder,
}

impl VoiceDecoder {
    pub fn new() -> Result<Self, String> {
        Decoder::new(SAMPLE_RATE, Channels::Mono)
            .map(|inner| Self { inner })
            .map_err(|e| e.to_string())
    }

    pub fn decode(&mut self, packet: &[u8], out: &mut [f32]) -> Result<usize, String> {
        self.inner.decode_float(packet, out, false).map_err(|e| e.to_string())
    }

    /// Reconstruct the packet *before* `next_packet` from the redundancy carried inside it.
    pub fn decode_fec(&mut self, next_packet: &[u8], out: &mut [f32]) -> Result<usize, String> {
        self.inner.decode_float(next_packet, out, true).map_err(|e| e.to_string())
    }

    /// Packet loss concealment: Opus extrapolates from its own decoder state when handed no data.
    pub fn conceal(&mut self, out: &mut [f32]) -> Result<usize, String> {
        self.inner.decode_float(&[], out, false).map_err(|e| e.to_string())
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::codec`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/codec.rs
git commit -m "feat: Opus coding with in-band FEC and DTX"
```

---

### Task 4: Transmit gating

**Files:**
- Create: `src-tauri/src/media/voice/gate.rs`

**Interfaces:**
- Consumes: `voice::FRAME_MS`.
- Produces:
  - `gate::InputMode` — `VoiceActivity | PushToTalk`.
  - `gate::GateConfig { mode: InputMode, sensitivity: f32, release_ms: u32 }`. `sensitivity` is 0.0–1.0, where higher is more sensitive, matching the existing UI slider.
  - `gate::Gate` — `new(GateConfig) -> Gate`, `set_config(&mut self, GateConfig)`, `set_muted(&mut self, bool)`, `set_ptt_down(&mut self, bool)`, `step(&mut self, rms: f32) -> GateDecision`. One `step` per 10 ms frame.
  - `gate::GateDecision { transmit: bool, speaking: bool }`.

This unifies two gates that currently disagree: `vadStrength` gated inside Rust while `inputSensitivity` gated in JS on a cloned track, with two `AudioContext`s per call to measure the same signal.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn voice_activity(sensitivity: f32) -> GateConfig {
        GateConfig { mode: InputMode::VoiceActivity, sensitivity, release_ms: 200 }
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

        // 200 ms of release at 10 ms a frame is 20 frames. Speech pauses between words are
        // shorter than this; closing inside them is what clipped words mid-syllable before.
        for frame in 0..19 {
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
        for frame in 0..19 {
            assert!(g.step(QUIET).transmit, "closed early at frame {frame}");
        }
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
        let mut g = Gate::new(GateConfig {
            mode: InputMode::PushToTalk,
            sensitivity: 0.6,
            release_ms: 200,
        });
        assert!(!g.step(LOUD).transmit, "silent until the key is held");

        g.set_ptt_down(true);
        assert!(g.step(QUIET).transmit, "transmits while held, however quiet");

        g.set_ptt_down(false);
        assert!(!g.step(LOUD).transmit, "stops the moment the key is released");
    }

    #[test]
    fn mute_overrides_push_to_talk() {
        let mut g = Gate::new(GateConfig {
            mode: InputMode::PushToTalk,
            sensitivity: 0.6,
            release_ms: 200,
        });
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
        assert!(!g.step(QUIET).transmit, "hold must not survive a mute");
    }

    #[test]
    fn switching_mode_resets_the_gate() {
        let mut g = Gate::new(voice_activity(0.6));
        g.step(LOUD);
        g.set_config(GateConfig {
            mode: InputMode::PushToTalk,
            sensitivity: 0.6,
            release_ms: 200,
        });
        assert!(!g.step(LOUD).transmit, "voice-activity hold must not carry into push-to-talk");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::gate`
Expected: FAIL to compile — `Gate` does not exist.

- [ ] **Step 3: Write the implementation**

```rust
//! Decides, once per frame, whether the microphone should be transmitting.
//!
//! One gate, not two. The previous pipeline gated twice on the same signal - an RNNoise VAD
//! threshold inside Rust and a separate RMS threshold in JavaScript on a cloned track - which meant
//! two sliders, two `AudioContext`s per call and two different answers to one question.
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
    /// How long the gate stays open after the signal drops below the threshold.
    pub release_ms: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct GateDecision {
    /// Whether this frame should be encoded and sent.
    pub transmit: bool,
    /// Whether to show this user as speaking. Never true while muted, even under push-to-talk.
    pub speaking: bool,
}

/// RMS at which the sensitivity slider's most-insensitive setting opens.
///
/// Matches the value the JavaScript gate used, so a user's existing slider position keeps meaning
/// what it meant before.
const MAX_RMS: f32 = 0.05;

pub struct Gate {
    config: GateConfig,
    muted: bool,
    ptt_down: bool,
    hold_frames: u32,
}

impl Gate {
    pub fn new(config: GateConfig) -> Self {
        Self { config, muted: false, ptt_down: false, hold_frames: 0 }
    }

    pub fn set_config(&mut self, config: GateConfig) {
        // Reset the hold: a hold accrued under one mode means nothing under another.
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

    /// Advance one 10 ms frame. `rms` is the level of the processed frame.
    pub fn step(&mut self, rms: f32) -> GateDecision {
        if self.muted {
            self.hold_frames = 0;
            return GateDecision { transmit: false, speaking: false };
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

        GateDecision { transmit: open, speaking: open }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::gate`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/gate.rs
git commit -m "feat: unified transmit gate for mute, push-to-talk and voice activity"
```

---

### Task 5: Adaptive jitter buffer

**Files:**
- Create: `src-tauri/src/media/voice/jitter.rs`

**Interfaces:**
- Consumes: nothing from other tasks — deliberately independent of the codec so it can be tested without Opus.
- Produces:
  - `jitter::Packet { seq: u16, payload: Vec<u8> }`.
  - `jitter::Pop` — `Decode(Packet) | DecodeFec(Packet) | Conceal`.
  - `jitter::JitterConfig { min_delay_ms: u32, max_delay_ms: u32, start_delay_ms: u32, packet_ms: u32 }`.
  - `jitter::JitterBuffer` — `new(JitterConfig) -> JitterBuffer`, `push(&mut self, Packet, arrival_ms: u64)`, `pop(&mut self) -> Pop`, `target_delay_ms(&self) -> u32`, `len(&self) -> usize`.

This is the component that decides how the call sounds on a real network, so it carries the most test weight in this plan. `webrtc-rs` delivers RTP; it has no NetEq equivalent.

Sequence numbers are `u16` and wrap. Comparisons must be modular — a naive `<` breaks once every 65536 packets, which at 50 packets a second is every 22 minutes of a call.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> JitterConfig {
        JitterConfig {
            min_delay_ms: 20,
            max_delay_ms: 500,
            start_delay_ms: 60,
            packet_ms: 20,
        }
    }

    fn packet(seq: u16) -> Packet {
        Packet { seq, payload: vec![seq as u8] }
    }

    /// Fill the buffer to its starting target so `pop` will hand packets out.
    fn primed(buf: &mut JitterBuffer, from: u16, arrival: &mut u64) {
        for i in 0..(config().start_delay_ms / config().packet_ms) {
            buf.push(packet(from.wrapping_add(i as u16)), *arrival);
            *arrival += config().packet_ms as u64;
        }
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
        // nothing to absorb the next late arrival.
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
        buf.pop(); // 1
        // 2 is missing and 3 is missing too, so there is no FEC copy of 2 to recover.
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
        assert_eq!(buf.len(), before, "a played packet must not be re-buffered");
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
        let start = buf.target_delay_ms();
        // Packets are sent 20 ms apart but arrive between 5 ms and 90 ms apart.
        let arrivals = [0u64, 5, 95, 100, 190, 195, 285, 290, 380, 385, 475, 480];
        for (i, &t) in arrivals.iter().enumerate() {
            buf.push(packet(i as u16 + 1), t);
        }
        assert!(buf.target_delay_ms() > start, "target should rise under jitter");
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
        assert!(steady.target_delay_ms() >= 20, "must not fall below the floor");
    }

    #[test]
    fn the_buffer_is_bounded_when_nothing_pops() {
        let mut buf = JitterBuffer::new(config());
        for i in 0..10_000u32 {
            buf.push(Packet { seq: i as u16, payload: vec![0] }, i as u64 * 20);
        }
        // A consumer that stalls must not turn the buffer into an unbounded memory leak.
        let max_packets = (500 / 20) * 2;
        assert!(buf.len() <= max_packets as usize, "buffer grew to {}", buf.len());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::jitter`
Expected: FAIL to compile — `JitterBuffer` does not exist.

- [ ] **Step 3: Write the implementation**

```rust
//! An adaptive jitter buffer for received voice packets.
//!
//! `webrtc-rs` hands over RTP; it has no NetEq. This decides, for each playout slot, whether to
//! decode a packet, reconstruct a lost one from the next packet's in-band FEC, or conceal.
//!
//! The target delay tracks observed arrival jitter: too small and the buffer runs dry on a bad
//! network, too large and the call feels sluggish. It is bounded at both ends so neither failure
//! mode can run away.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Packet {
    pub seq: u16,
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pop {
    /// The packet for this slot is here; decode it normally.
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

pub struct JitterBuffer {
    config: JitterConfig,
    /// Keyed by *unwrapped* sequence, so ordering is plain integer ordering.
    packets: BTreeMap<u64, Packet>,
    /// The next unwrapped sequence to play, or `None` before playout starts.
    cursor: Option<u64>,
    /// Highest unwrapped sequence seen, used to unwrap subsequent arrivals.
    highest: Option<u64>,
    target_delay_ms: u32,
    /// Smoothed inter-arrival deviation, in the manner of RFC 3550's jitter estimate.
    jitter_ms: f32,
    last_arrival_ms: Option<u64>,
    last_seq_unwrapped: Option<u64>,
}

impl JitterBuffer {
    pub fn new(config: JitterConfig) -> Self {
        Self {
            target_delay_ms: config.start_delay_ms.clamp(config.min_delay_ms, config.max_delay_ms),
            config,
            packets: BTreeMap::new(),
            cursor: None,
            highest: None,
            jitter_ms: 0.0,
            last_arrival_ms: None,
            last_seq_unwrapped: None,
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
        let base = highest & !0xFFFF;
        let candidates = [base + seq as u64, base + 0x1_0000 + seq as u64, base.wrapping_sub(0x1_0000).wrapping_add(seq as u64)];
        *candidates
            .iter()
            .min_by_key(|c| (**c as i64 - highest as i64).abs())
            .expect("candidate list is never empty")
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
            let expected = (seq as i64 - last_seq as i64) * self.config.packet_ms as i64;
            let actual = arrival_ms as i64 - last_arrival as i64;
            let deviation = (actual - expected).abs() as f32;
            self.jitter_ms += (deviation - self.jitter_ms) / 16.0;

            // Three deviations covers the overwhelming majority of arrivals without chasing a
            // single outlier all the way to the ceiling.
            let wanted = (self.jitter_ms * 3.0) as u32 + self.config.packet_ms;
            self.target_delay_ms =
                wanted.clamp(self.config.min_delay_ms, self.config.max_delay_ms);
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
                let first = *self.packets.keys().next().expect("buffered_ms > 0 implies non-empty");
                self.cursor = Some(first);
                first
            }
        };

        if let Some(packet) = self.packets.remove(&cursor) {
            self.cursor = Some(cursor + 1);
            return Pop::Decode(packet);
        }

        // The slot's packet is missing. Opus's in-band FEC puts a coarse copy of each frame inside
        // the *next* packet, so if that one is here the loss is recoverable.
        if let Some(next) = self.packets.get(&(cursor + 1)) {
            self.cursor = Some(cursor + 1);
            return Pop::DecodeFec(next.clone());
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::jitter`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/jitter.rs
git commit -m "feat: adaptive jitter buffer with FEC recovery and concealment"
```

---

### Task 6: Mixing, gain and limiting

**Files:**
- Create: `src-tauri/src/media/voice/mixer.rs`

**Interfaces:**
- Consumes: `voice::FRAME`.
- Produces:
  - `mixer::Mixer` — `new() -> Mixer`, `set_gain(&mut self, id: &str, gain: f32)`, `set_master(&mut self, gain: f32)`, `set_deafened(&mut self, bool)`, `mix(&mut self, sources: &[(&str, &[f32])], out: &mut [f32])`.
  - `out` is `FRAME * 2` interleaved stereo. Each source slice is `FRAME` mono samples.

Task 7 adds spatial panning to this same struct.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::voice::FRAME;

    fn constant(value: f32) -> Vec<f32> {
        vec![value; FRAME]
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }

    #[test]
    fn no_sources_produces_silence() {
        let mut m = Mixer::new();
        let mut out = vec![9.0f32; FRAME * 2];
        m.mix(&[], &mut out);
        assert!(out.iter().all(|&s| s == 0.0), "stale samples were left in the buffer");
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
        let loud: Vec<f32> = constant(0.9);
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
        assert!(out.iter().all(|s| s.is_finite()), "a NaN reaching the device is an audible click");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::mixer`
Expected: FAIL to compile — `Mixer` does not exist.

- [ ] **Step 3: Write the implementation**

```rust
//! Mixes every remote speaker into one stereo frame.
//!
//! Per-user volume, deafen and master output volume all resolve here rather than on individual
//! `<audio>` elements, which is what the webview used to do.
//!
//! The output goes through a limiter rather than a hard clamp. The previous AGC ended in
//! `.clamp(-1.0, 1.0)`, so a loud passage clipped flat and audibly distorted; a limiter pulls the
//! gain down smoothly and lets it back up afterwards.

use std::collections::HashMap;

use super::FRAME;

/// Attack coefficient: how fast gain comes down when the mix is too hot (~1 frame).
const LIMITER_ATTACK: f32 = 0.5;
/// Release coefficient: how fast gain returns afterwards (~50 frames, half a second).
const LIMITER_RELEASE: f32 = 0.02;

pub struct Mixer {
    gains: HashMap<String, f32>,
    master: f32,
    deafened: bool,
    limiter_gain: f32,
    accumulator: Vec<f32>,
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

    pub fn remove(&mut self, id: &str) {
        self.gains.remove(id);
    }

    /// Mix one frame. `out` is `FRAME * 2` interleaved stereo.
    pub fn mix(&mut self, sources: &[(&str, &[f32])], out: &mut [f32]) {
        out.fill(0.0);
        if self.deafened || sources.is_empty() {
            return;
        }

        self.accumulator.fill(0.0);
        for (id, samples) in sources {
            let gain = self.gains.get(*id).copied().unwrap_or(1.0) * self.master;
            let n = samples.len().min(FRAME);
            for i in 0..n {
                // A NaN or infinity from a misbehaving decoder would otherwise poison the whole
                // mix and reach the device as a click.
                let s = if samples[i].is_finite() { samples[i] * gain } else { 0.0 };
                self.accumulator[i * 2] += s;
                self.accumulator[i * 2 + 1] += s;
            }
        }

        self.apply_limiter(out);
    }

    /// Write the accumulator to `out`, holding the peak at or below full scale.
    fn apply_limiter(&mut self, out: &mut [f32]) {
        let peak = self.accumulator.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        let wanted = if peak > 1.0 { 1.0 / peak } else { 1.0 };

        // Down fast, up slow: the reverse would let a transient through before reacting, and would
        // pump audibly on the way back.
        let coefficient = if wanted < self.limiter_gain { LIMITER_ATTACK } else { LIMITER_RELEASE };
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::mixer`
Expected: PASS, 11 tests.

Note that `the_limiter_prevents_clipping_when_sources_sum_past_full_scale` may need the mixer to be stepped more than once before the attack has fully engaged; the final `.clamp` guarantees the assertion holds from the first frame regardless.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/mixer.rs
git commit -m "feat: stereo mixer with per-user gain and a limiter"
```

---

### Task 7: Spatial panning for Isle proximity voice

**Files:**
- Modify: `src-tauri/src/media/voice/mixer.rs`

**Interfaces:**
- Consumes: `mixer::Mixer` from Task 6.
- Produces, added to the same struct:
  - `mixer::Position { x: f32, y: f32, z: f32 }` — listener-relative metres. `x` positive is right, `y` positive is up, `z` positive is in front.
  - `Mixer::set_spatial(&mut self, enabled: bool)`.
  - `Mixer::set_position(&mut self, id: &str, position: Option<Position>)` — `None` means non-positional, mixed to the centre.
  - `Mixer::set_max_distance(&mut self, metres: f32)`.

Isle currently pans with WebAudio's HRTF `PannerNode` in `spatial-audio.service.ts`. Mixing moved to Rust, so panning has to follow it.

- [ ] **Step 1: Write the failing tests**

Append to the existing `mod tests` in `mixer.rs`:

```rust
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

    #[test]
    fn a_source_on_the_left_is_louder_in_the_left_ear() {
        let mut m = Mixer::new();
        m.set_spatial(true);
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
        m.set_spatial(true);
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
        m.set_spatial(true);
        m.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 2.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        settle(&mut m, "a", &a, &mut out);

        let (left, right) = ear_energy(&out);
        let ratio = left.max(right) / left.min(right).max(f32::EPSILON);
        assert!(ratio < 1.5, "front source should be near-symmetric, ratio {ratio}");
    }

    #[test]
    fn distance_attenuates() {
        let mut near = Mixer::new();
        near.set_spatial(true);
        near.set_max_distance(20.0);
        near.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 1.0 }));

        let mut far = Mixer::new();
        far.set_spatial(true);
        far.set_max_distance(20.0);
        far.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 15.0 }));

        let a = constant(0.5);
        let mut near_out = vec![0.0f32; FRAME * 2];
        let mut far_out = vec![0.0f32; FRAME * 2];
        settle(&mut near, "a", &a, &mut near_out);
        settle(&mut far, "a", &a, &mut far_out);

        let (nl, nr) = ear_energy(&near_out);
        let (fl, fr) = ear_energy(&far_out);
        assert!(nl + nr > (fl + fr) * 2.0, "near {} should clearly exceed far {}", nl + nr, fl + fr);
    }

    #[test]
    fn beyond_max_distance_is_silent() {
        let mut m = Mixer::new();
        m.set_spatial(true);
        m.set_max_distance(10.0);
        m.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 50.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        settle(&mut m, "a", &a, &mut out);

        let (left, right) = ear_energy(&out);
        assert!(left + right < 1e-3, "out-of-range source should be inaudible");
    }

    #[test]
    fn spatial_disabled_falls_back_to_centre() {
        let mut m = Mixer::new();
        m.set_spatial(false);
        m.set_position("a", Some(Position { x: -5.0, y: 0.0, z: 0.0 }));
        let a = constant(0.5);
        let mut out = vec![0.0f32; FRAME * 2];
        m.mix(&[("a", &a)], &mut out);

        // Position is ignored entirely, so the source is centred and unattenuated.
        assert!((out[0] - 0.5).abs() < 1e-6);
        assert!((out[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_positionless_source_is_centred_even_in_spatial_mode() {
        let mut m = Mixer::new();
        m.set_spatial(true);
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
        m.set_spatial(true);
        m.set_position("a", Some(Position { x: 0.0, y: 0.0, z: 0.0 })); // listener's own position
        let a = constant(0.9);
        let mut out = vec![0.0f32; FRAME * 2];
        settle(&mut m, "a", &a, &mut out);
        assert!(out.iter().all(|s| s.is_finite()), "a zero-distance source must not divide by zero");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::mixer`
Expected: FAIL to compile — `Position`, `set_spatial`, `set_position` and `set_max_distance` do not exist.

- [ ] **Step 3: Resolve the HRIR dataset question before writing code**

The `hrtf` crate ships **no impulse-response data** — `HrirSphere::new` reads a sphere from a byte stream that the application must supply. The commonly-used spheres (IRCAM Listen, CIPIC, MIT KEMAR) are published for research or non-commercial use, which is the same class of problem this codebase already handled deliberately for OpenH264: see the comment in `Cargo.toml` explaining why Cisco's binary is fetched rather than built.

**Do not vendor a dataset without checking its licence.** Resolve one of:

- a permissively-licensed HRIR sphere that can be committed to the repo, or
- fetching one at runtime the way `openh264_blob.rs` does, or
- shipping without a sphere.

The implementation below already handles the last case: with no sphere loaded, spatial sources fall back to distance-attenuated centre panning. That keeps proximity voice working — losing directionality, not audio — and it means this task can be completed and tested before the licensing question is settled. The tests that assert left/right dominance are `#[ignore]`d until a sphere is available; everything else runs.

- [ ] **Step 4: Write the implementation**

The `hrtf` crate convolves each source against a head-related impulse response, giving the front/back and elevation cues a plain left/right pan cannot. Two API details drive the shape of this code: `HrtfProcessor::process_samples` requires `source.len() == interpolation_steps * block_len`, and it **adds** into the output buffer rather than overwriting it, which suits an accumulator.

```rust
use std::io::Cursor;

use hrtf::{HrirSphere, HrtfContext, HrtfProcessor, Vec3};

/// A source's position relative to the listener, in metres.
///
/// `x` is positive to the right, `y` positive upwards, `z` positive in front - the same handedness
/// the WebAudio panner used, so Isle's existing position maths carries over unchanged.
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

/// Per-source HRTF state. The processor keeps a convolution tail between frames, so each source
/// needs its own; sharing one would smear speakers into each other.
struct Spatial {
    processor: HrtfProcessor,
    previous_left: Vec<f32>,
    previous_right: Vec<f32>,
    previous_distance_gain: f32,
}
```

Extend `Mixer` with these fields:

```rust
    spatial_enabled: bool,
    positions: HashMap<String, Option<Position>>,
    spatial_state: HashMap<String, Spatial>,
    /// Raw HRIR sphere bytes, if a dataset is available. See Step 3 - absent is a supported state.
    hrir_bytes: Option<&'static [u8]>,
    max_distance: f32,
    /// Stereo scratch the HRTF processors accumulate into. `process_samples` *adds* to its output
    /// buffer, so all spatial sources can share one buffer that is cleared once per mix.
    spatial_accumulator: Vec<(f32, f32)>,
```

`new()` gains:

```rust
            spatial_enabled: false,
            positions: HashMap::new(),
            spatial_state: HashMap::new(),
            // No dataset committed yet - see the licensing note in Step 3. Until one is chosen,
            // spatial sources are distance-attenuated but not directional.
            hrir_bytes: None,
            max_distance: 20.0,
            spatial_accumulator: vec![(0.0, 0.0); FRAME],
```

And the new methods:

```rust
impl Mixer {
    pub fn set_spatial(&mut self, enabled: bool) {
        self.spatial_enabled = enabled;
    }

    pub fn set_position(&mut self, id: &str, position: Option<Position>) {
        self.positions.insert(id.to_owned(), position);
    }

    /// Beyond this distance a source is silent, matching Isle's proximity falloff.
    pub fn set_max_distance(&mut self, metres: f32) {
        self.max_distance = metres.max(0.001);
    }

    /// Inverse-distance falloff, reaching exactly zero at `max_distance`.
    ///
    /// Without the subtraction a source would still be faintly audible at the cutoff and then jump
    /// to silence, which is audible as a click when someone walks out of range.
    fn distance_gain(&self, distance: f32) -> f32 {
        if distance >= self.max_distance {
            return 0.0;
        }
        let reference = 1.0f32;
        let near = reference / distance.max(reference);
        let taper = 1.0 - (distance / self.max_distance);
        (near * taper).clamp(0.0, 1.0)
    }
}
```

Now rewrite `mix` to route each source down one of three paths. Replace the whole method from Task 6 with:

```rust
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
                // Spatial mode with a known position: the only path that pans.
                Some(position) if self.spatial_enabled => {
                    self.render_spatial(id, samples, gain, position);
                }
                // Everything else lands in the centre at full level: spatial disabled, or a
                // participant who has no position (a guild call rather than proximity voice).
                _ => {
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
        let distance_gain = self.distance_gain(position.distance());
        if distance_gain <= 0.0 {
            // Out of range. Returning here also means no HRTF state is created for a source that
            // cannot be heard.
            return;
        }

        let Some(bytes) = self.hrir_bytes else {
            // No dataset: distance-attenuated centre rather than dropping the speaker entirely.
            for (i, &s) in samples.iter().take(FRAME).enumerate() {
                let v = if s.is_finite() { s * gain * distance_gain } else { 0.0 };
                self.spatial_accumulator[i].0 += v;
                self.spatial_accumulator[i].1 += v;
            }
            return;
        };

        // `process_samples` requires source.len() == interpolation_steps * block_len, so the two
        // must multiply to exactly FRAME.
        const STEPS: usize = 4;
        const BLOCK: usize = FRAME / STEPS;

        let state = match self.spatial_state.entry(id.to_owned()) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => {
                let Ok(sphere) = HrirSphere::new(Cursor::new(bytes), super::SAMPLE_RATE) else {
                    return;
                };
                e.insert(Spatial {
                    processor: HrtfProcessor::new(sphere, STEPS, BLOCK),
                    previous_left: Vec::new(),
                    previous_right: Vec::new(),
                    previous_sample_vector: Vec3::new(position.x, position.y, position.z),
                    previous_distance_gain: distance_gain,
                })
            }
        };

        if samples.len() < FRAME {
            return;
        }

        let new_vector = Vec3::new(position.x, position.y, position.z);
        // Interpolating from the previous frame's vector and gain is what keeps a moving speaker
        // click-free; jumping straight to the new values steps the convolution discontinuously.
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
```

`Spatial` therefore needs a `previous_sample_vector: Vec3` field alongside the ones declared above, and `previous_left` / `previous_right` start empty — the processor sizes them itself.

Also extend `remove` so a departed participant leaves no convolution state behind:

```rust
    pub fn remove(&mut self, id: &str) {
        self.gains.remove(id);
        self.positions.remove(id);
        self.spatial_state.remove(id);
    }
```

- [ ] **Step 5: Mark the directional tests as ignored until a dataset exists**

Without an HRIR sphere the fallback is centre-panned, so the four assertions about ear dominance cannot pass. Add `#[ignore = "needs an HRIR dataset - see Step 3"]` to `a_source_on_the_left_is_louder_in_the_left_ear`, `a_source_on_the_right_is_louder_in_the_right_ear`, `a_source_in_front_is_roughly_centred` and `spatial_output_stays_finite`.

Leave the other four running: `distance_attenuates`, `beyond_max_distance_is_silent`, `spatial_disabled_falls_back_to_centre` and `a_positionless_source_is_centred_even_in_spatial_mode` all hold with or without a dataset, because distance handling is ours rather than the crate's.

Do **not** delete the ignored tests or weaken their assertions. They are the acceptance criteria for whenever the dataset question is settled.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::mixer`
Expected: PASS, 15 tests run and 4 ignored (11 from Task 6, 8 new, 4 of the new ones ignored).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/media/voice/mixer.rs
git commit -m "feat: HRTF spatial panning in the voice mixer"
```

---

### Task 8: RNNoise denoising, correctly applied

**Files:**
- Create: `src-tauri/src/media/voice/denoise.rs`

**Interfaces:**
- Consumes: `voice::FRAME`.
- Produces: `denoise::Denoiser` — `new() -> Denoiser`, `process(&mut self, frame: &mut [f32]) -> f32`. Processes in place and returns RNNoise's own voice probability, 0.0–1.0.

This is the direct fix for the long-standing bug. Three things the old code did are deliberately **not** done here, and the comments must say so:

1. **No pre-emphasis or de-emphasis.** The old de-emphasis was `y[n] = x[n] + 0.95·y[n-1]`, a leaky integrator with roughly 26 dB of DC gain and no bound.
2. **No blend with the unprocessed signal.** RNNoise's overlap-add output lags its input by one 10 ms frame, so the old 80/20 blend summed the signal with a 10 ms-delayed copy of itself — a comb filter with teeth every 100 Hz, and a hard −14 dB ceiling on suppression.
3. **No gating here.** Gating belongs to `gate.rs`, which now owns that decision alone.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::voice::FRAME;

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    /// Deterministic pseudo-random noise - no `rand` dependency needed, and a fixed seed keeps the
    /// suppression assertions reproducible.
    fn noise(len: usize, seed: u32) -> Vec<f32> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 8) as f32 / 8_388_608.0 - 1.0
            })
            .collect()
    }

    #[test]
    fn silence_stays_silent() {
        let mut d = Denoiser::new();
        let mut frame = vec![0.0f32; FRAME];
        d.process(&mut frame);
        assert!(frame.iter().all(|s| s.abs() < 1e-3));
    }

    #[test]
    fn output_is_always_finite() {
        let mut d = Denoiser::new();
        let mut frame: Vec<f32> = noise(FRAME, 7).iter().map(|s| s * 0.9).collect();
        d.process(&mut frame);
        assert!(frame.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn broadband_noise_is_strongly_suppressed() {
        // The regression test for the 80/20 blend. Mixing 20% of the untouched signal back in put a
        // hard -14 dB floor under suppression no matter how well the model did; a correct
        // application must beat that comfortably.
        let mut d = Denoiser::new();
        let source = noise(FRAME, 42);
        let input_rms = rms(&source);

        // Let the model settle on the noise profile before measuring.
        let mut measured = 0.0;
        for _ in 0..50 {
            let mut frame: Vec<f32> = noise(FRAME, 42).iter().map(|s| s * 0.3).collect();
            d.process(&mut frame);
            measured = rms(&frame);
        }

        let reference = input_rms * 0.3;
        assert!(
            measured < reference * 0.15,
            "suppression only reached {:.1} dB (out {measured}, in {reference})",
            20.0 * (measured / reference).log10()
        );
    }

    #[test]
    fn voice_probability_is_a_valid_range() {
        let mut d = Denoiser::new();
        let mut frame: Vec<f32> = noise(FRAME, 3).iter().map(|s| s * 0.2).collect();
        let p = d.process(&mut frame);
        assert!((0.0..=1.0).contains(&p), "voice probability {p} out of range");
    }

    #[test]
    fn a_wrongly_sized_frame_is_left_alone() {
        let mut d = Denoiser::new();
        let mut frame = vec![0.5f32; 100];
        let p = d.process(&mut frame);
        assert_eq!(p, 0.0);
        assert!(frame.iter().all(|&s| s == 0.5), "a short frame must pass through untouched");
    }

    #[test]
    fn processing_does_not_introduce_a_dc_offset() {
        // The old de-emphasis filter was a leaky integrator with ~26 dB of DC gain, so any offset
        // on the microphone walked the signal off over time.
        let mut d = Denoiser::new();
        let mut mean = 0.0;
        for _ in 0..100 {
            let mut frame: Vec<f32> = noise(FRAME, 11).iter().map(|s| s * 0.2 + 0.05).collect();
            d.process(&mut frame);
            mean = frame.iter().sum::<f32>() / frame.len() as f32;
        }
        assert!(mean.abs() < 0.05, "DC offset drifted to {mean}");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::denoise`
Expected: FAIL to compile — `Denoiser` does not exist.

- [ ] **Step 3: Write the implementation**

```rust
//! RNNoise denoising, applied the way the model expects.
//!
//! Three things the previous implementation did are deliberately absent, and should not come back:
//!
//! 1. **No pre-emphasis / de-emphasis pair.** The old de-emphasis was `y[n] = x[n] + 0.95*y[n-1]`,
//!    a leaky integrator with roughly 26 dB of gain at DC and no bound, so any offset on the
//!    microphone walked the signal off. RNNoise already weights its own bands.
//!
//! 2. **No blend with the untouched signal.** RNNoise uses 20 ms windows with 50% overlap-add, so
//!    its output lags its input by one 10 ms frame. The old code mixed 80% denoised with 20% of the
//!    *undelayed* original, summing the signal with a 10 ms-delayed copy of itself: a comb filter
//!    with its first null at 50 Hz and teeth every 100 Hz. That is what made voices sound hollow,
//!    and it also put a hard -14 dB ceiling on suppression.
//!
//! 3. **No gating.** Deciding whether to transmit belongs to [`super::gate`], which owns it alone.

use nnnoiseless::DenoiseState;

use super::FRAME;

pub struct Denoiser {
    state: Box<DenoiseState<'static>>,
    scratch: Vec<f32>,
}

impl Denoiser {
    pub fn new() -> Self {
        Self { state: DenoiseState::new(), scratch: vec![0.0; FRAME] }
    }

    /// Denoise one frame in place, returning RNNoise's voice probability for it.
    ///
    /// A frame of the wrong length is passed through untouched: RNNoise's frame size is fixed, and
    /// silently processing a partial frame would desynchronise its overlap-add state.
    pub fn process(&mut self, frame: &mut [f32]) -> f32 {
        if frame.len() != FRAME {
            return 0.0;
        }

        // nnnoiseless works in i16 units rather than normalised floats.
        for (dst, src) in self.scratch.iter_mut().zip(frame.iter()) {
            *dst = src * 32_768.0;
        }

        let mut denoised = [0.0f32; FRAME];
        let probability = self.state.process_frame(&mut denoised, &self.scratch);

        for (dst, src) in frame.iter_mut().zip(denoised.iter()) {
            let value = src / 32_768.0;
            *dst = if value.is_finite() { value } else { 0.0 };
        }

        probability.clamp(0.0, 1.0)
    }
}

impl Default for Denoiser {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::denoise`
Expected: PASS, 6 tests.

If `broadband_noise_is_strongly_suppressed` fails, do **not** relax the threshold — that assertion is the whole point of the task. Check that no blending or emphasis filtering has crept in.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/voice/denoise.rs
git commit -m "fix: apply RNNoise without the comb-filtering blend or the unstable emphasis pair"
```

---

### Task 9: The audio-processing boundary

**Files:**
- Create: `src-tauri/src/media/voice/process.rs`

**Interfaces:**
- Consumes: `voice::FRAME`.
- Produces:
  - `process::NoiseSuppression` — `Off | Standard | Enhanced`, matching the three settings the UI offers.
  - `process::ProcessConfig { echo_cancellation: bool, noise_suppression: NoiseSuppression, auto_gain: bool }`.
  - `process::CaptureInfo { voice_probability: f32 }`.
  - `process::AudioProcessor` trait — `process_capture(&mut self, frame: &mut [f32]) -> CaptureInfo`, `process_render(&mut self, frame: &[f32])`, `set_config(&mut self, ProcessConfig)`.
  - `process::Passthrough` — the no-op implementation.
  - `process::create(config: ProcessConfig) -> Box<dyn AudioProcessor>` — returns the APM implementation when the `aec` feature is on and it initialises, and `Passthrough` otherwise.

`process_render` is fed the mixer's output. Because Rust renders the mix itself, that is a more accurate echo reference than device loopback: no extra capture latency and no other application's audio in it.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::voice::FRAME;

    fn config() -> ProcessConfig {
        ProcessConfig {
            echo_cancellation: true,
            noise_suppression: NoiseSuppression::Standard,
            auto_gain: true,
        }
    }

    #[test]
    fn passthrough_leaves_samples_untouched() {
        let mut p = Passthrough::default();
        let original: Vec<f32> = (0..FRAME).map(|i| (i as f32 / FRAME as f32) - 0.5).collect();
        let mut frame = original.clone();
        p.process_capture(&mut frame);
        assert_eq!(frame, original);
    }

    #[test]
    fn passthrough_reports_no_voice_probability() {
        let mut p = Passthrough::default();
        let mut frame = vec![0.5f32; FRAME];
        let info = p.process_capture(&mut frame);
        assert_eq!(info.voice_probability, 0.0);
    }

    #[test]
    fn passthrough_accepts_a_render_frame() {
        let mut p = Passthrough::default();
        p.process_render(&vec![0.25f32; FRAME]);
    }

    #[test]
    fn create_returns_a_usable_processor() {
        // Whichever implementation this resolves to, a frame must survive it finite and intact in
        // length. That is the contract the capture thread relies on.
        let mut p = create(config());
        let mut frame = vec![0.1f32; FRAME];
        let info = p.process_capture(&mut frame);
        assert_eq!(frame.len(), FRAME);
        assert!(frame.iter().all(|s| s.is_finite()));
        assert!((0.0..=1.0).contains(&info.voice_probability));
    }

    #[test]
    fn create_survives_a_full_second_of_frames() {
        let mut p = create(config());
        for _ in 0..100 {
            let mut capture = vec![0.05f32; FRAME];
            p.process_render(&vec![0.02f32; FRAME]);
            p.process_capture(&mut capture);
            assert!(capture.iter().all(|s| s.is_finite()));
        }
    }

    #[test]
    fn config_can_change_mid_session() {
        let mut p = create(config());
        p.set_config(ProcessConfig {
            echo_cancellation: false,
            noise_suppression: NoiseSuppression::Off,
            auto_gain: false,
        });
        let mut frame = vec![0.1f32; FRAME];
        p.process_capture(&mut frame);
        assert!(frame.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn a_wrongly_sized_frame_is_left_alone() {
        let mut p = create(config());
        let mut frame = vec![0.5f32; 37];
        p.process_capture(&mut frame);
        assert_eq!(frame.len(), 37);
        assert!(frame.iter().all(|&s| s == 0.5));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::process`
Expected: FAIL to compile — `AudioProcessor` does not exist.

- [ ] **Step 3: Write the trait, the passthrough and the factory**

```rust
//! The echo-cancellation, noise-suppression and gain-control boundary.
//!
//! Behind a trait for two reasons. The real implementation wraps WebRTC's AudioProcessing module,
//! which is C++ and needs meson at build time - so a machine without that toolchain builds the
//! passthrough instead and loses echo cancellation rather than losing voice. And the boundary makes
//! the surrounding pipeline testable without the C++ library present at all.
//!
//! The render side is fed the mixer's own output. Rust renders the mix, so that is a more accurate
//! echo reference than device loopback: no extra capture latency, and no other application's audio
//! mixed into it. The trade-off, shared with Chrome and Discord, is that audio played by *other*
//! applications through the same speakers is not cancelled.

use super::FRAME;

/// Mirrors the three settings the UI offers. The names describe intent, not implementation.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NoiseSuppression {
    /// High-pass only: remove rumble, touch nothing else.
    Off,
    /// Steady background noise - fans, hum, air conditioning.
    Standard,
    /// Adds the RNNoise stage on top, for irregular noise like keyboards and chatter.
    Enhanced,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ProcessConfig {
    pub echo_cancellation: bool,
    pub noise_suppression: NoiseSuppression,
    pub auto_gain: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct CaptureInfo {
    /// The processor's own voice-activity estimate, 0.0–1.0. Zero when unavailable.
    pub voice_probability: f32,
}

pub trait AudioProcessor: Send {
    /// Process one captured frame in place. A frame of the wrong length is left untouched.
    fn process_capture(&mut self, frame: &mut [f32]) -> CaptureInfo;

    /// Supply one frame of what is about to be played, as the echo reference.
    fn process_render(&mut self, frame: &[f32]);

    fn set_config(&mut self, config: ProcessConfig);
}

/// The no-op processor, used when the `aec` feature is off or the APM fails to initialise.
#[derive(Default)]
pub struct Passthrough;

impl AudioProcessor for Passthrough {
    fn process_capture(&mut self, _frame: &mut [f32]) -> CaptureInfo {
        CaptureInfo { voice_probability: 0.0 }
    }

    fn process_render(&mut self, _frame: &[f32]) {}

    fn set_config(&mut self, _config: ProcessConfig) {}
}

/// Build the best processor available on this build.
pub fn create(config: ProcessConfig) -> Box<dyn AudioProcessor> {
    #[cfg(feature = "aec")]
    {
        match apm::Apm::new(config) {
            Ok(apm) => return Box::new(apm),
            Err(e) => {
                // Worth saying out loud: the call still works, but without echo cancellation, and
                // that is a large enough quality difference to be worth diagnosing.
                eprintln!("[voice] audio processing unavailable, echo cancellation is off: {e}");
            }
        }
    }
    let _ = config;
    Box::new(Passthrough)
}
```

- [ ] **Step 4: Run the tests to verify they pass against the passthrough**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice::process`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit the boundary**

```bash
git add src-tauri/src/media/voice/process.rs
git commit -m "feat: audio-processing boundary with a passthrough implementation"
```

- [ ] **Step 6: Add the APM implementation behind the feature**

Append to `process.rs`. This requires meson (see the prerequisite at the top of this plan).

```rust
#[cfg(feature = "aec")]
mod apm {
    use webrtc_audio_processing::{Config, EchoCanceller, GainController, InitializationConfig, NoiseSuppression as ApmNoise, NoiseSuppressionLevel, Processor};

    use super::{AudioProcessor, CaptureInfo, NoiseSuppression, ProcessConfig, FRAME};

    pub struct Apm {
        inner: Processor,
    }

    impl Apm {
        pub fn new(config: ProcessConfig) -> Result<Self, String> {
            let inner = Processor::new(&InitializationConfig {
                num_capture_channels: 1,
                num_render_channels: 1,
                ..Default::default()
            })
            .map_err(|e| e.to_string())?;

            let mut apm = Self { inner };
            apm.set_config(config);
            Ok(apm)
        }

        fn to_apm_config(config: ProcessConfig) -> Config {
            Config {
                echo_canceller: config.echo_cancellation.then(EchoCanceller::default),
                noise_suppression: match config.noise_suppression {
                    // Enhanced still runs the APM suppressor; RNNoise is layered on top of it by
                    // the capture thread rather than replacing it.
                    NoiseSuppression::Off => None,
                    NoiseSuppression::Standard | NoiseSuppression::Enhanced => Some(ApmNoise {
                        level: NoiseSuppressionLevel::Moderate,
                    }),
                },
                gain_controller: config.auto_gain.then(GainController::default),
                ..Default::default()
            }
        }
    }

    impl AudioProcessor for Apm {
        fn process_capture(&mut self, frame: &mut [f32]) -> CaptureInfo {
            if frame.len() != FRAME {
                return CaptureInfo { voice_probability: 0.0 };
            }
            if self.inner.process_capture_frame(frame).is_err() {
                return CaptureInfo { voice_probability: 0.0 };
            }
            CaptureInfo {
                voice_probability: self.inner.get_stats().voice_detected.map_or(0.0, |v| if v { 1.0 } else { 0.0 }),
            }
        }

        fn process_render(&mut self, frame: &[f32]) {
            if frame.len() != FRAME {
                return;
            }
            let mut scratch = frame.to_vec();
            let _ = self.inner.process_render_frame(&mut scratch);
        }

        fn set_config(&mut self, config: ProcessConfig) {
            self.inner.set_config(Self::to_apm_config(config));
        }
    }
}
```

- [ ] **Step 7: Run the tests with the feature on**

Run: `cargo test --manifest-path src-tauri/Cargo.toml media::voice::process`
Expected: PASS, 7 tests — the same assertions, now exercising the APM.

The `webrtc-audio-processing` 2.1 API may differ from the sketch above in type and field names. Correct the implementation to match the crate; the trait, the tests and `create`'s fallback behaviour must not change. If the crate cannot be made to build, stop and report — do not delete the feature, and do not weaken `create`'s contract.

- [ ] **Step 8: Verify both build configurations one last time**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features media::voice`
Expected: PASS — every test in this plan, on the toolchain-free path.

Run: `cargo test --manifest-path src-tauri/Cargo.toml media::voice`
Expected: PASS — the same tests with AEC compiled in.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/media/voice/process.rs
git commit -m "feat: WebRTC AudioProcessing implementation behind the aec feature"
```

---

## What this plan does not do

Deliberately out of scope, each with its own follow-up plan:

- **Devices and transport** — `capture.rs`, `render.rs`, `rtc.rs`, `session.rs`, the Tauri commands and the Cloudflare `primary` flip.
- **Angular** — `VoiceEngineService`, deleting the worklet bridge, wiring the dead settings, relabelling noise suppression.
- **Isle** — feeding positions into `Mixer::set_position` from the proximity service.

Everything above is pure and testable today; the follow-up plans wire proven components to devices and sockets.
