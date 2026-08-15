# Screen Share Content Mode - Design

**Date:** 2026-08-15
**Status:** Approved

## Problem

Every screen share this client publishes is optimised for text, and nothing can change that.

`webrtc-encoding.ts:159-167` pins `contentHint = 'detail'` and
`degradationPreference = 'maintain-resolution'` on every screen sender, and
`encoder_sw.rs:42` builds openh264 with `UsageType::ScreenContentRealTime` unconditionally.
That was the right call for the complaint the 2026-07-31 design was answering - streams that
looked soft because `'motion'` shed resolution on every bandwidth dip - but it is only half a
policy. A game share now degrades by collapsing to a slideshow at full resolution, which is the
opposite of what anyone sharing a game wants.

Two defects surfaced while reading the Rust path, and they are the reason this is not simply a
matter of unpinning the hint:

1. **The hints do not reach the Rust publisher at all.** `screen-publish.ts:89` says so outright.
   The native encoder is built from `EncoderSpec { width, height, fps, kbps }` and there is no
   congestion response anywhere in `src-tauri/src/media/publisher/`. On desktop, "motion versus
   text" cannot be a hint. It has to be encoder configuration.
2. **`encoder_mf.rs:154` forces CBR for every share.** CBR is the wrong rate control for text
   content specifically: it spends its budget on a motionless desktop and then has nothing left
   when a window scrolls. openh264 already avoids this through its screen-content usage type, so
   the hardware path - the one that runs on most desktops - is the weaker of the two.

## Reference: how this is done elsewhere

Chromium exposes two knobs, and an Electron client gets both for free:

- `track.contentHint` (`'motion'` | `'detail'` | `'text'`) flips libwebrtc's
  `VideoEncoderConfig::content_type` between `kRealtimeVideo` and `kScreen`. That is a different
  rate controller, not a cosmetic flag: screen mode tolerates long gaps between frames, spends far
  more on the frames that do change, disables denoising and adaptive quantisation, and enables the
  codec's screen-content tools where the codec has them.
- `sender.degradationPreference` (`'maintain-framerate'` | `'maintain-resolution'`) decides what is
  sacrificed under congestion: pixels or frames.

Game mode is `motion` plus `maintain-framerate`. Text mode is `detail` plus `maintain-resolution`.
That pair is the entire user-visible difference on a WebRTC stack.

What the hints do *not* do is make text sharp. That comes from never resampling, from rate control
that skips static frames so the budget lands on the frames that change, and ultimately from chroma:
4:2:0 subsampling is what smears coloured text on coloured backgrounds, and no bitrate fixes it.
This is why Discord shipped AV1 for screen share. AV1 has screen-content coding tools that H.264
Constrained Baseline does not.

## Decisions

- Content mode is a **third axis** in the quality bar, independent of resolution and framerate.
  Labelled for what users share, not for what the encoder does: **Games** and **Text**.
- **Default is `text`.** It preserves today's behaviour exactly, so nobody's stream changes
  underneath them. `games` is an opt-in that is one tap away in the bar.
- **Static encoder tuning only.** No congestion-adaptation loop on the Rust path. Mode selects
  encoder configuration at start and at change; it does not drive a control loop.
- **The H.264 profile bump is its own phase**, gated separately. See Phasing.
- Mode is not an entitlement axis. Every rung gets both.

## Architecture

### 1. The content axis

`src/app/models/stream-preset.ts`:

```ts
export type StreamContent = 'games' | 'text';

export interface StreamPreset {
    resolution: StreamResolution;
    framerate: StreamFramerate;
    content: StreamContent;
}
```

`DEFAULT_STREAM_PRESET` becomes `{resolution: '1080p', framerate: 30, content: 'text'}`.

**Bitrate is untouched.** `bitrateFor` stays `BITRATES[resolution][framerate]` and
`MIN_BITRATE_RATIO` stays at 0.6 for both modes. The floor is worth stating explicitly because the
temptation to lower it for text is real and wrong: on the web path `minBitrate` constrains what the
bitrate *allocator* hands the encoder, not what the encoder must emit, so a still screen already
costs nothing in text mode. Lowering it would only reintroduce the opening ramp the 2026-07-31 work
removed. Mode is a policy axis, not a budget axis.

**No persistence migration is needed.** `ScreenPickerService.lastPreset()`
(`screen-picker.service.ts:97`) already spreads `DEFAULT_STREAM_PRESET` beneath the parsed value, so
a preset persisted before this change picks up `content: 'text'` automatically. Written down because
it is the kind of thing a later reader adds a migration for on the assumption it was forgotten.

`clampPreset` and the entitlement helpers are unchanged: `content` has no ceiling.

### 2. Web path

`applyScreenEncoding` (`webrtc-encoding.ts:156`) branches on `preset.content`:

| | `games` | `text` |
|---|---|---|
| `contentHint` | `'motion'` | `'detail'` |
| `degradationPreference` | `'maintain-framerate'` | `'maintain-resolution'` |

`'detail'` rather than the spec's `'text'` because Chromium maps both to the same screen-content
path and `'detail'` has the broader support history.

**The simulcast ladder stays at two rungs in both modes.** `screenSendEncodings` currently justifies
dropping rung `c` partly on legibility, which is text-specific reasoning that would suggest
restoring `c` for games. It is not worth doing, for a reason that matters more than the argument:
rids are negotiated in the SDP and fixed at `addTransceiver` time, so a ladder that differed by mode
could not be toggled mid-stream without renegotiating. Keeping it identical is what makes the mode
control in the bar free. The encode-cost half of that docblock's argument holds for games anyway,
and the docblock is updated to say so rather than left implying a mode-dependent ladder.

### 3. Rust path

`EncoderSpec` gains `content: EncoderContent` (`Games | Text`). It stays `Copy + PartialEq + Eq`, so
the existing reconfigure-on-change comparison keeps working and a mode change is naturally treated
as a spec change.

**openh264 (`encoder_sw.rs`).** The current config is hardcoded to screen content, and it forces two
knobs off with a comment recording that openh264 rejects them *for screen content*. Those are
camera-mode features, so games mode gets them back:

| | `games` | `text` |
|---|---|---|
| `usage_type` | `CameraVideoRealTime` | `ScreenContentRealTime` |
| `adaptive_quantization` | `true` | `false` |
| `background_detection` | `true` | `false` |
| `rate_control_mode` | `Bitrate` | `Quality` |

The `text` column is today's configuration in every row but the last. `rate_control_mode` moves from
`Bitrate` to `Quality` so a still screen costs nothing and a scroll burst can spend the budget,
which is the same change the Media Foundation table below makes for the same reason.

`intra_frame_period` is unchanged in both. The pump already bounds keyframes in wall-clock time
(`pump.rs:37`), which is the binding constraint.

**Media Foundation (`encoder_mf.rs`).** `apply_spec` is the one place this lands, since it is already
what a spec change re-runs:

| | `games` | `text` |
|---|---|---|
| `AVEncCommonRateControlMode` | `CBR` (today) | `PeakConstrainedVBR` |
| `AVEncCommonMeanBitRate` | preset kbps | preset kbps |
| `AVEncCommonMaxBitRate` | not set | 2x preset kbps |
| `AVEncCommonQualityVsSpeed` | not set (driver default) | 70 |

`CODECAPI_AVEncVideoContentType` is deliberately not used. Its only non-`Unknown` value is
`FixedCameraAngle`; it is not a screen-content flag and setting it would be cargo cult.

`CODECAPI_AVLowLatencyMode` stays on for both. It caps how many frames the encoder may hold, which
is a live-share requirement independent of content.

### 4. Plumbing

`ScreenPublishOptions` gains `content`, set in `publishOptions` (`screen-publish.ts:76`) from
`choice.preset.content` and carried into `EncoderSpec`. This is the same seam the derived
width/height/fps/kbps already travel, so the "only place a preset becomes pixels" invariant in that
docblock is preserved.

Mid-stream changes reuse the existing `pending_spec` cell (`session.rs:56`), which already applies at
a frame boundary together with the encoder's own geometry. `PublishHandle::set_geometry` is widened to carry content and renamed
`set_spec`, rather than gaining a sibling that writes the same cell: one path that moves a spec is
what makes the ordering rule in `VideoEncoder::reconfigure` enforceable, and a second writer to
`pending_spec` is how that rule gets broken later.

### 5. UI

A third segmented row in `call-controls-bar.component.html`, using the existing `segmentClass`
pattern and rendered under the same `isScreenSharing() && preset()` guard:

```
Resolution    [720p][1080p][1440p][Source]
Framerate     [15][30][60]
Optimize for  [Games][Text]
```

No `disabled` state and no entitlement title text, unlike the two rows above it. The same control is
added to the screen picker's quality step, and selections route through `rememberPreset` exactly as
resolution and framerate do.

New i18n keys for the row label and the two options. `src/assets/i18n/locales` is a submodule, so the
strings land in their own commit there before the commit that uses them.

## Phasing

| Phase | Content |
|-------|---------|
| P0 | The content axis, both publish paths, the bar row and picker control |
| P1 | H.264 profile bump on the Media Foundation path, gated |

**P1 in detail.** `encoder_mf.rs:177` forces `eAVEncH264VProfile_ConstrainedBase`, which costs CABAC
and the 8x8 transform. Both disproportionately help the sharp edges that make UI text legible, and
High profile with `CODECAPI_AVEncMPVDefaultBPictureCount = 0` adds no reordering latency - the
docblock's stated reason for avoiding higher profiles is B-frames, which that setting removes. This
is the largest text-sharpness win available to us inside H.264.

It is separate because its failure mode is different in kind. Everything in P0 makes a picture
better or worse; a profile the negotiated `profile-level-id` does not permit makes it *absent*. So
P1 must confirm what is negotiated with the SFU before sending High, fall back to Constrained
Baseline when it is not permitted, and be verified against a real viewer rather than a local decode.
`VENTA_FORCE_SOFTWARE_ENCODER` already exists as the diagnostic for exactly this class of fault.

## Testing

**Angular:**

- `stream-preset.spec.ts` - `DEFAULT_STREAM_PRESET.content` is `'text'`; a preset persisted without
  `content` reads back as `'text'` through `lastPreset()`; `clampPreset` leaves `content` alone at
  every ceiling.
- `webrtc-encoding.spec.ts` - `games` yields `'motion'` and `'maintain-framerate'`, `text` yields
  `'detail'` and `'maintain-resolution'`, and **`screenSendEncodings` returns identical rids and
  scales for both modes**. That last one is the test that guards mid-stream toggling; without it the
  ladder can drift back to being mode-dependent and the bar control silently starts renegotiating.
- `call-controls-bar` - the row renders while sharing, is never disabled by a ceiling, and a
  selection reaches `rememberPreset`.

**Rust:**

- `encoder_sw` builds and produces decodable output in both modes, at the geometries the existing
  tests already cover.
- Two `EncoderSpec` values differing only in `content` compare unequal, so a mode change is not
  silently absorbed by the reconfigure check.
- `publishOptions` and its Rust counterpart agree on the mode for the same picker choice.

**Before trusting any of the above**, each new encoder test is run against an implementation that
ignores `content`, and must fail. Per `project_media_e2e_test_traps`, a media test that passes
without the thing it guards is worse than no test.

**Manual, stated as unverified until performed:**

- A game share under induced congestion drops resolution and holds framerate; a text share does the
  reverse.
- Whether Media Foundation accepts a rate-control-mode change on a live MFT.
- Side-by-side legibility of a text share before and after, on the MF path.

## Known unknowns

- **Live MF rate-control changes.** If the MFT refuses a mid-session `AVEncCommonRateControlMode`
  change, a mode toggle on the hardware path either goes through `PooledEncoder`'s park-and-retype
  or takes effect only on the next share. This is measured during P0, and whichever it is, it is
  logged rather than failed - a mode change that does not apply until the next share is a limitation,
  not a broken stream.
- **openh264 `RateControlMode` variant names.** The crate exposes the enum; the exact spelling of the
  quality-mode variant is confirmed against the version in `Cargo.lock` at implementation time rather
  than assumed here.

## Out of scope

- Any congestion-adaptation loop on the Rust publisher. It has none today, and adding one is a
  control-loop problem with its own oscillation and testability questions.
- AV1 or HEVC. They are the real answer to chroma-limited text sharpness, and they are a different
  project.
- 4:4:4 chroma. Not reachable in H.264 Constrained Baseline or High.
- Camera video, which has no content axis and does not want one.
- Per-viewer or receive-side quality selection.
