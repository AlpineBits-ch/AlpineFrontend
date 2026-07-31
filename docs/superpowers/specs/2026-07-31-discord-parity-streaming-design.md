# Discord-Parity Streaming — Design

**Date:** 2026-07-31
**Status:** Approved

## Problem

Three complaints, one root cause each:

1. **Live streams are unsharp and "slowly catch themselves."** The screen track is published with
   `contentHint = 'motion'` (`rust-media.service.ts:163`), which instructs the encoder to protect
   framerate by shedding *resolution*. On any bandwidth dip VP9 drops to ~360p and climbs back over
   tens of seconds. There is also no start-bitrate floor, so WebRTC's congestion controller ramps
   from ~300 kbps and the first 15–30 s of every stream look bad regardless of the configured cap.

2. **Too many audio/streaming settings.** The Voice & Video page exposes four bitrate dropdowns
   (mic audio, screen audio, camera video, screen video). Discord exposes none — voice bitrate is a
   per-channel server setting, and stream quality is chosen in the Go Live flow as resolution +
   framerate. Our knobs are also *harmful*: framerate is inferred from bitrate
   (`screenVideoBitrate >= 8000 ? 30 : 15`, duplicated in `voice-rtc.service.ts:451` and
   `call-webrtc.service.ts:531`), so picking "Low · 1.5 Mbps" silently halves framerate and 60 fps
   is unreachable.

3. **Aspect ratio frequently breaks the stream.** The capture canvas is created at a hardcoded
   1920×1080 (`rust-media.service.ts:134`) and `captureStream(0)` locks onto that size. The first
   real frame then resizes the canvas mid-capture (`:385-388`), forcing a track resolution change
   and a keyframe. For a **window** that the user resizes while sharing, this fires continuously and
   the stream visibly tears. Separately, `set_screen_capture_resolution` clamps width and height
   independently (`screen.rs:337-340`), so ultrawide sources map to the wrong box, and `'native'` is
   hardcoded to 3840×2160.

Additional defects found while investigating:

- The picker's Share button markup is corrupted (`screen-picker.component.html:124-135`):
  `[class.bg-white` is unterminated and `cursor-pointer/10]=!selectedId()"` has leaked into the
  static `class` attribute.
- The picker has no quality step and no "share system audio" control, though loopback audio is
  captured unconditionally.
- `voice-rtc.publishCamera` (`:401`) calls `getUserMedia({video: true})`, ignoring the camera the
  user selected in settings.
- `call-screen-layout` applies a zoom `scale()` with no `overflow` clipping and no pan, so zooming
  past 100% just overflows the tile.

## Reference: what Discord does

- **Voice & Video settings:** input/output device + volume, mic test, input mode (voice activity /
  push to talk), camera + preview, and an Advanced group (echo cancellation, noise suppression
  None/Standard/Krisp, automatic gain control, attenuation, QoS). **No bitrate controls anywhere.**
- **Stream quality:** chosen in the Go Live flow — resolution (720p / 1080p / 1440p / Source) and
  framerate (15 / 30 / 60), changeable mid-stream via a stream-settings cog without restarting.
- **Capture:** OS-native (DXGI / Windows Graphics Capture, DLL injection for some games) feeding a
  hardware encoder (NVENC/AMF/QuickSync) producing H.264, HEVC or AV1. Frames stay in GPU memory —
  no lossy intermediate format, no canvas.
- **Degradation:** under congestion the encoder **drops frames**; it does not shed resolution.
- **No simulcast.** The streamer sends one stream at the slowest viewer's rate; the viewer-side
  "Stream Quality" menu is a decode-side cap.

Discord is Electron, which exposes `desktopCapturer.getSources()` + `chromeMediaSourceId` — a custom
picker driving Chromium's native capture. WebView2/Tauri has no equivalent (`getDisplayMedia` there
always forces Chromium's own picker), which is why this codebase built the JPEG-over-IPC bridge.

## Decisions

- No artificial quality gating — every resolution and framerate is available to everyone.
- No per-viewer quality, and therefore no simulcast. Discord doesn't simulcast either.
- Camera stays on `getUserMedia` for now; only the ignored-device bug is fixed.
- All quality controls move into the share flow, with the last-used preset remembered.
- Isle Proximity settings are app-specific and stay as they are.
- The Rust encoder is hardware-accelerated on Windows (Media Foundation) and software (openh264)
  everywhere else, so the JPEG frame path can be retired on every platform.

## Architecture

### 1. The preset contract

A `StreamPreset` couples resolution, framerate and bitrate into one unit. Bitrate is **derived**,
never user-set. This is what makes maintain-resolution degradation safe: choosing 60 fps also raises
the bitrate, so the encoder is never asked to hold resolution on a starvation budget.

| Resolution | 15 fps | 30 fps | 60 fps |
|------------|--------|--------|--------|
| 720p       | 1.5 Mbps | 2.5 Mbps | 4 Mbps |
| 1080p      | 2.5 Mbps | 4.5 Mbps | 8 Mbps |
| 1440p      | 4 Mbps | 8 Mbps | 12 Mbps |
| Source     | 6 Mbps | 10 Mbps | 18 Mbps |

New module `src/app/models/stream-preset.ts`:

```ts
export type StreamResolution = '720p' | '1080p' | '1440p' | 'source';
export type StreamFramerate = 15 | 30 | 60;
export interface StreamPreset { resolution: StreamResolution; framerate: StreamFramerate; }

export function bitrateFor(preset: StreamPreset): number;   // kbps
export function boxFor(resolution: StreamResolution): [number, number] | null;  // null = source
```

Audio bitrates become constants (voice 64 kbps, stream audio 128 kbps stereo) rather than settings,
matching Discord's non-configurability. Per-channel voice bitrate is possible future work.

**Removes:** `audioBitrate`, `screenAudioBitrate`, `videoBitrate`, `screenVideoBitrate` from
`AudioSettings`; both copies of the framerate-from-bitrate hack; `StreamResolution` and
`RESOLUTION_DIMS` from `rust-media.service.ts` (superseded by the new model).

### 2. Degradation policy

Applied to every screen sender, in both `voice-rtc.service.ts` and `call-webrtc.service.ts`:

- `contentHint = 'detail'` — screen content is text and UI, not motion.
- `degradationPreference = 'maintain-resolution'` — drop frames, not pixels. This is Discord's
  behaviour and directly addresses the "unsharp, slowly catches itself" symptom.
- `encodings[0].maxBitrate = bitrateFor(preset) * 1000`
- `encodings[0].minBitrate ≈ 60% of maxBitrate` and `x-google-start-bitrate` munged into the SDP
  offer, so the stream opens near its target instead of ramping from ~300 kbps.

The 2 fps regression that originally motivated `'motion'` cannot recur, because framerate and
bitrate are now chosen together.

Both services currently duplicate bitrate/codec-preference logic. This work extracts the shared
parts into `src/app/services/webrtc-encoding.ts` — a small pure module holding `applyEncoding()`,
`preferCodecs()` and the SDP start-bitrate munge — consumed by both. This keeps the change from
being made twice and drifting again.

### 3. Fixed geometry

Output geometry is solved **once** at share start and never changes for the life of the session.

```
solveGeometry(sourceW, sourceH, resolution) -> { width, height }
```

- Fits the source into the preset's box preserving aspect ratio; `source` uses the source's own
  dimensions.
- Rounds both dimensions down to even numbers (H.264 chroma subsampling requires it).
- Rust pads a resized window into that fixed frame (letterbox) instead of changing frame size, so
  window resizing no longer changes track dimensions.
- The canvas is created at exactly that size before `captureStream`, removing both the 1920×1080
  hardcode and the mid-stream resize.
- `set_screen_capture_resolution` is replaced by `set_screen_capture_geometry(width, height)` taking
  the already-solved size, so the independent-clamp bug disappears.

Changing resolution mid-stream becomes an explicit, deliberate renegotiation (one keyframe) rather
than an accident of the first frame's dimensions.

### 4. Rust-native publisher

New `src-tauri/src/media/publisher/`:

| File | Responsibility |
|------|----------------|
| `mod.rs` | Tauri commands: `start_screen_publish`, `stop_screen_publish`, `set_publish_preset` |
| `encoder.rs` | `trait VideoEncoder { fn encode(&mut self, frame: &Frame) -> Option<EncodedChunk>; }` |
| `encoder_mf.rs` | Windows Media Foundation H.264 (hardware) |
| `encoder_sw.rs` | openh264 software fallback (all platforms) |
| `rtc.rs` | `webrtc-rs` PeerConnection publishing one H.264 track (+ optional Opus loopback) |
| `signalling.rs` | Calls the existing backend endpoints with a bearer token passed from JS |

The publisher opens its **own** Cloudflare session via the endpoints that already exist
(`/voice/session`, `/voice/cf/tracks/new`, `/voice/cf/renegotiate`, `/voice/cf/tracks/close` —
`guild-voice.service.ts:74-99`) and publishes `screen-<shareId>`.

The frontend subscribe path is untouched: it already keys purely off `{cfSessionId, trackName}`
(`voice-rtc.service.ts:342-382`), and `VoiceParticipantDto` already carries `cfSessionId` and
`isStreaming`. `publishScreen` becomes an `invoke` returning `{ cfSessionId, trackName }`.

**Self-preview:** Rust emits a separate low-rate preview channel (5 fps, small JPEG). This is the
one place JPEG is genuinely appropriate — it's a thumbnail, not the stream.

Gated behind a `rustPublisher` feature flag with the current pipeline as fallback, so the two can
coexist while the new path is proven.

### 5. Settings page

The "Streaming Quality" section is deleted entirely. Resulting shape:

- **Input Device** + Input Volume slider
- **Output Device** + Output Volume slider
- Mic test (unchanged — it works well)
- **Input Mode** — Voice Activity / Push to Talk (unchanged)
- **Camera** + preview (unchanged)
- **Advanced** (collapsed by default): Echo Cancellation, Noise Suppression
  (**None / Standard / Enhanced (RNNoise)** — one select replacing today's two separate toggles,
  mirroring Discord's None/Standard/Krisp), Automatic Gain Control, Voice Gate Strength
- **Isle Proximity Voice** (unchanged)

Net: four dropdowns and one toggle removed, two volume sliders added.

**Migration.** `AudioSettings` is persisted in `localStorage` under `alpine_audio_settings`. A
migration in `AudioSettingsService.load()` must:

- drop the four removed bitrate keys,
- fold `{noiseSuppression, enhancedNoiseSuppression}` into `noiseSuppressionMode`:
  `enhancedNoiseSuppression → 'enhanced'`, else `noiseSuppression → 'standard'`, else `'none'`,
- default `inputVolume` and `outputVolume` to 100,
- be idempotent, since `load()` runs on every construction.

### 6. Screen picker

Two steps, matching Go Live.

**Step 1 — Source.** Tabs renamed *Screens* / *Applications*. The grid uses each source's real
aspect ratio with `object-contain` rather than cropping everything into a fixed `16/10` box with
`object-cover`, so the thumbnail honestly represents what will be shared. Live preview retained.

**Step 2 — Stream Quality.** A resolution row (720p / 1080p / 1440p / Source), a framerate row
(15 / 30 / 60), and a **Share system audio** toggle — today loopback is captured unconditionally
with no way to decline. Primary action is "Go Live".

`ScreenPickerService.show()` changes its resolved type from `string | null` to
`{ sourceId: string; preset: StreamPreset; shareAudio: boolean } | null`. The last-used preset is
persisted and preselected.

The corrupted Share button markup is rewritten.

### 7. Mid-stream settings and viewer UI

A cog on the local stream tile in `call-screen-layout` opens a popover with the same resolution and
framerate controls plus "Change source", applied live. Framerate changes take effect within a frame
(already supported); resolution changes trigger one deliberate renegotiation.

Viewer-side fixes:

- `overflow-hidden` on the stream tile, and drag-to-pan when zoom exceeds 100%.
- The FPS readout moves behind the cog instead of sitting permanently on the tile.
- `object-contain` is retained — it is correct.

## Testing

**Unit (Angular):**
- `stream-preset.spec.ts` — bitrate table lookup, every resolution/framerate combination resolves,
  `boxFor('source')` returns null.
- `geometry.spec.ts` — aspect preservation, even-dimension rounding, ultrawide (5120×1440),
  portrait (1080×1920), source passthrough, sources smaller than the target box (no upscaling).
- `audio-settings.service.spec.ts` — migration drops removed keys, folds both noise-suppression
  toggles into each of the three modes, defaults new keys, and is idempotent across two loads.
- `screen-picker.service.spec.ts` — the resolved shape carries preset and audio choice; cancel
  resolves null.

**Unit (Rust):**
- Geometry solver mirrors the TypeScript one for the same inputs.
- The encoder produces decodable H.264 from a synthetic frame sequence.

**Manual (stated explicitly as unverified until performed):**
- Resizing a shared window mid-stream must not renegotiate or distort.
- Ultrawide and portrait sources render without cropping in the picker and without letterbox
  artefacts in the stream.
- A stream opens near its target quality rather than ramping for 20 seconds.

## Phasing

| Phase | Content | Fixes |
|-------|---------|-------|
| P0 | Preset contract, degradation policy, fixed geometry | Blur, aspect-ratio breakage |
| P1 | Settings simplification + migration | Too many settings |
| P2 | Two-step picker, mid-stream cog, viewer UI fixes | Picker and stream UI |
| P3 | `webrtc-rs` ↔ Cloudflare H.264 interop spike | — (de-risks P4) |
| P4 | Rust encoder + publisher behind a flag | Root-cause sharpness |
| P5 | Retire the JPEG frame path except for previews | — |

P0–P2 fix every reported complaint using the current pipeline. P3–P5 replace the engine underneath
the same preset contract, so the UI does not change again.

## Out of scope

- Simulcast and per-viewer quality (Discord does not do this either).
- Moving the camera to the Rust capture path.
- Per-channel voice bitrate as a server setting.
- AV1/HEVC encoding — the `VideoEncoder` trait leaves room for it, but H.264 ships first.
