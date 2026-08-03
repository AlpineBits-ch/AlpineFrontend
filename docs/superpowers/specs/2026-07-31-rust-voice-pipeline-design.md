# Rust-native voice pipeline

**Date:** 2026-07-31
**Status:** approved, not yet implemented

Replace the edge-native WebRTC audio path with a voice pipeline that lives entirely in Rust:
capture, echo cancellation, noise suppression, Opus encode, transport, jitter buffering, decode,
mixing and playout. The target is call quality at or above Discord's.

## Why

Voice today takes one of two paths, and both are wrong.

**The default path is the browser's.** `noiseSuppressionMode` defaults to `'standard'`, and both
`voice-rtc.service.ts:142` and `call-webrtc.service.ts:299` only reach for Rust when the mode is
`'enhanced'` or the platform is Linux. Every other user is on `getUserMedia` and the webview's Opus
encoder. Isle proximity voice (`isle-voice-rtc.service.ts:69`) never touches Rust at all.

**The "Rust" path is a detour, not a pipeline.** Even when it is taken, audio goes:

```
cpal → RNNoise → f32 → base64 → Tauri IPC → atob → AudioWorklet FIFO
     → MediaStreamDestination → webview peer connection → browser Opus → Cloudflare
```

The webview still encodes. This is precisely the shape `media/publisher/mod.rs` was written to get
rid of for screen sharing.

### Defects in the current implementation

**No echo cancellation on the Rust path.** `echoCancellation` is applied only inside
`buildAudioConstraint()`, which is the `getUserMedia` branch. cpal hands back the raw device. Every
user on speakers with "Enhanced" selected is echoing into the call. This is the largest single gap
against Discord.

**The pre/de-emphasis pair is unstable** (`audio.rs:294-319`). De-emphasis is
`y[n] = x[n] + 0.95·y[n-1]` - a leaky integrator with roughly 26 dB of DC gain and no bound. Any DC
offset from the microphone walks the signal off. RNNoise already weights its own bands; the wrapper
buys nothing in exchange for the instability.

**The 80/20 blend comb-filters the voice** (`audio.rs:323-327`). RNNoise uses 20 ms windows with
50 % overlap-add, so its output lags its input by one 10 ms frame. Blending `denoised[i]` with the
undelayed `frame[i]` sums the signal with a 10 ms-delayed copy of itself: a comb filter, first null
at 50 Hz, teeth every 100 Hz. That is the hollow, phasey quality. It also caps suppression at
−14 dB regardless of what the model achieves. This is the long-standing "buggy RNNoise".

**AGC hard-clips.** `apply_agc` ends in `.clamp(-1.0, 1.0)` with no limiter and no lookahead; a
40 ms attack means a loud onset clips flat for four frames. Two of its comments also contradict the
constants they describe.

**Resampling has no anti-aliasing.** `resample_linear` is bare linear interpolation, so a 44.1 kHz
device aliases audibly.

**The worklet FIFO cannot hold sync.** The cpal device clock and the `AudioContext` clock are
independent and will drift. `audio-capture-processor.js` has no drift correction, so the buffer
either grows without bound - latency creeping up for the length of the call - or drains. Once it
underruns, `_ready` stays `true`, so it emits a silence gap every quantum from then on. There is no
resync path.

**Latency is self-inflicted.** 40 ms IPC batching plus an 80 ms pre-buffer is 120 ms before Opus
sees a sample, on top of RNNoise's 10 ms and the network. Discord's mouth-to-ear is roughly
40–60 ms.

**Opus is untuned.** `applySimpleBitrate(sender, 64)` sets `maxBitrate` and nothing else: no
`useinbandfec`, no `usedtx`, no `maxaveragebitrate`, no `ptime`, no `playoutDelayHint` on receivers.
Without in-band FEC every lost packet is an audible hole.

**Settings that do nothing.** `inputVolume` and `outputVolume` are read only by the settings
component - there is no application site anywhere. `echoCancellation` is silently ignored on the
Rust path. `vadStrength` gates inside Rust while `inputSensitivity` gates in JS on a cloned track:
two unrelated VADs on one signal, costing two extra `AudioContext`s per call.

**Three microphone acquisition sites** with three slightly different policies.

Patching these individually would land at "not obviously broken" while leaving no AEC, browser-side
encoding, 120 ms of avoidable latency and the drift bug. The pieces are entangled enough that
fixing them separately costs close to replacing them.

## Architecture

**Rust owns all audio. The webview owns video.**

| | Publishes | Subscribes | Cloudflare session |
|---|---|---|---|
| Rust voice (new) | microphone | all remote voice + screen-audio | `primary=true` |
| Rust screen (exists) | screen H.264 | - | `primary=false` |
| Webview | camera | remote camera + screen video | `primary=false` |

The backend already accepts `?primary=false` - `publisher/signalling.rs:137` relies on it. Moving
audio to Rust is therefore a query-parameter flip on the webview's `createSession`, not a backend
change. The Rust voice session takes `primary=true` because it publishes the track the backend
records as the participant's `audioTrackName`.

The webview keeps the WebSocket, auth and session lifetime, and instructs Rust who to subscribe to
over a Tauri command. This is the division of labour the screen publisher already established:
`start_screen_publish` takes `api_base` and `token` from the webview rather than duplicating token
refresh in Rust.

### Echo cancellation reference

Because Rust renders the mix itself, it feeds that mix directly into APM's `process_reverse_stream`.
That is more accurate than device loopback: no extra capture latency, and no other application's
audio polluting the reference. AEC3's delay estimator absorbs the output device buffer.

The trade-off is the same one Chrome and Discord make - audio played by *other* applications through
the same speakers is not cancelled.

This is a simplification the full-Rust playout decision buys. A capture-only rewrite would have had
to use device loopback as the reference.

### Signal flow

```
CAPTURE   cpal input → rubato → 48 kHz mono
          → APM: high-pass → AEC3 → noise suppression → AGC2 → VAD
          → RNNoise (Enhanced only; no pre-emphasis, no blend)
          → gate (mute / push-to-talk / VAD hysteresis)
          → Opus 48 kHz mono, 20 ms, in-band FEC + DTX, 64 kbps
          → webrtc-rs track → Cloudflare

PLAYOUT   Cloudflare → webrtc-rs on_track (N remote tracks)
          → per track: depacketize → jitter buffer (reorder / PLC / in-band FEC)
          → Opus decode → per-user gain → HRTF pan (Isle only)
          → mixer: sum + soft limiter → cpal output
                 └──────────────────────────────────→ APM reverse stream
```

Every stage operates on 10 ms frames - APM's native size and RNNoise's frame size - so no stage
rebuffers against another.

### Threading and real-time discipline

- The cpal **input callback** does nothing but push into a preallocated SPSC ring. No allocation, no
  locks, no blocking. (The current code's `data.to_vec()` per callback violates the rule its own
  comment states.)
- A **capture thread** wakes on a 10 ms tick: resample, APM, denoise, gate, encode, hand the packet
  to the transport over a channel.
- A **mixer thread** wakes on a 10 ms tick: for each subscribed track, pop the jitter buffer, decode,
  apply gain and panning, sum, limit, push into the output ring.
- The cpal **output callback** drains the output ring. Same discipline as input.
- **webrtc-rs tokio tasks** receive RTP and push into per-track jitter buffers.

## Module layout

`src-tauri/src/media/voice/`, a sibling of `publisher/` and shaped like it. Each file has one job
and is testable on its own:

| File | Responsibility |
|---|---|
| `mod.rs` | Tauri commands, the single active session |
| `session.rs` | Wires capture → publish and subscribe → playout |
| `rtc.rs` | webrtc-rs peer connection: one local Opus track, N remote |
| `capture.rs` | cpal input, device selection, config negotiation |
| `render.rs` | cpal output, playout callback |
| `resample.rs` | rubato wrapper; replaces `resample_linear` |
| `process.rs` | APM behind `trait AudioProcessor` |
| `denoise.rs` | RNNoise stage, correctly aligned |
| `codec.rs` | Opus encoder/decoder configuration |
| `jitter.rs` | Adaptive jitter buffer, PLC and FEC |
| `mixer.rs` | N streams → stereo, gain, HRTF, limiter |
| `gate.rs` | Mute / PTT / VAD gating, speaking events |

Signalling extends `publisher::signalling` rather than forking it: the subscribe path and the
`primary` flag are additions, and the request and response shapes are already correct.

`process.rs` puts the APM behind a trait with a passthrough implementation. This keeps the stage
unit-testable without the C++ library, and means a build failure on some platform degrades the
pipeline rather than breaking it.

## Tauri interface

Commands: `voice_start`, `voice_stop`, `voice_subscribe`, `voice_unsubscribe`, `voice_set_mute`,
`voice_set_ptt_open`, `voice_set_deafen`, `voice_set_user_volume`, `voice_set_input_volume`,
`voice_set_output_volume`, `voice_set_processing`, `voice_set_devices`, `voice_set_positions`
(Isle).

One event channel carries `speaking`, `level`, `stats` and `error` messages back. Speaking state
coming from Rust is what allows both JS VAD `AudioContext`s to be deleted.

## Cross-platform

Windows, macOS and Linux are all first-class. No platform may be left on the old path.

| Dependency | Portability |
|---|---|
| `cpal` 0.15 | WASAPI / CoreAudio / ALSA-PulseAudio - already a dependency |
| `webrtc-audio-processing` 2.1 | C++ build; needs a working toolchain on each platform |
| `opus` 0.3 | Vendored libopus |
| `rubato` 4 | Pure Rust |
| `hrtf` 0.8 | Pure Rust, bundled HRIR dataset |
| `webrtc` 0.14 | Pure Rust - already a dependency |

Only the APM carries real portability risk. It is isolated behind `trait AudioProcessor` and gated
behind a cargo feature, so a platform where it cannot be built falls back to the passthrough
implementation and loses AEC rather than losing voice. Phase 0 verifies the build before any other
code is written; the Windows build is verifiable on the development machine, and macOS and Linux are
verified in CI or on a build host before the phase closes.

The existing Windows-only `loopback_win.rs` is untouched - it serves screen-share system audio, not
the AEC reference, and that role does not change.

## Angular changes

A single `VoiceEngineService` owns the Rust voice session. `VoiceRtcService`, `CallWebrtcService`
and `IsleVoiceRtcService` delegate to it and stop acquiring microphones themselves.

**Deleted:** `audio-capture-processor.js` and the whole base64/worklet bridge; `startMicCapture` and
`startLoopbackCapture` from `RustMediaService` (which keeps screen and camera); both per-call VAD
`AudioContext`s; the WebAudio graph in `spatial-audio.service.ts`; the Rust-versus-getUserMedia
branching in all three services.

**Fallback:** `getUserMedia` survives only as a `!isTauri()` implementation of the same interface, so
no call service branches on platform.

### Settings

Currently-dead settings become real: `inputVolume`, `outputVolume` and `echoCancellation` all push
to Rust, as do per-user volume and deafen. `vadStrength` and `inputSensitivity` collapse into one
control - there is no reason for two VADs on one signal. The migration in
`audio-settings.service.ts` must stay idempotent, as it already documents.

Noise suppression keeps Discord's three-way shape, described by effect rather than implementation.
No option mentions RNNoise, APM or any other internal name:

- **Off** - "No filtering. Best if your microphone or audio interface already cleans up the signal."
- **Standard** - "Removes steady background noise like fans, hum and air conditioning."
- **Enhanced** - "Also removes keyboard clicks, dishes and background chatter. Uses more CPU."

## Testing

Rust unit tests, all pure - no devices, no network:

- **`jitter`** - in-order delivery, reordering, duplicates, gaps invoking PLC, in-band FEC recovery,
  late-arrival drop, target-delay convergence against synthetic jitter traces, buffer bounds under
  sustained early and late arrival.
- **`mixer`** - the limiter never clips, per-user gain, deafen zeroes output, HRTF placement puts
  the expected energy in each ear.
- **`gate`** - mute beats push-to-talk beats VAD, hysteresis hold and release timing.
- **`resample`** - conversion accuracy, and no energy above Nyquist for a swept input.
- **`codec`** - encode/decode roundtrip, FEC and DTX flags reach the encoder.
- **`process`** - settings map to APM config correctly, verified against the fake.

Angular specs: settings migration idempotence with the new fields, settings→Rust config mapping, and
`VoiceEngineService` command and event plumbing against a fake `invoke`.

The jitter buffer carries the most test weight because it is where call quality on a real network
actually lives.

## Phasing

Each phase leaves the application working.

0. **Spike.** Confirm `webrtc-audio-processing` 2.1 builds on Windows, macOS and Linux. This decides
   everything downstream and must settle before other code is written.
1. **Capture and publish.** cpal → APM → RNNoise → gate → Opus → Cloudflare, for guild voice and DM
   calls. The webview still subscribes and plays.
2. **Subscribe and play.** Jitter buffer, decode, mix, cpal output. The `<audio>` elements go.
3. **Isle.** Proximity voice moves onto the same engine, with HRTF in the mixer.
4. **Settings and fallback.** Wire the dead settings, relabel noise suppression, put the
   `!isTauri()` path behind the shared interface.

## Risks

- **APM build portability.** Highest-impact unknown; phase 0 exists to settle it. Mitigated by the
  trait boundary and the cargo feature gate.
- **The `primary` flip.** No backend change is expected, but that the backend records the Rust
  session's `audioTrackName` needs runtime confirmation early in phase 1.
- **Jitter buffer quality.** The hardest component to get right; hence the test weight.
- **Isle HRTF parity.** The `hrtf` crate's dataset differs from WebAudio's; positioning must be
  checked by ear as well as by test.
