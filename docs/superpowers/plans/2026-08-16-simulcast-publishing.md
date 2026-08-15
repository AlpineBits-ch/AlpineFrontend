# Simulcast Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop screen-share publisher send three rid-tagged H.264 encodings (`a`/`b`/`c` at full/half/quarter height) on one track, so the SFU can serve a small tile a cheap layer instead of handing every viewer the top one.

**Architecture:** One capture thread and one `FramePump` drive N encoders from a single fitted frame, so all layers share a clock and a keyframe policy. Each layer owns an mpsc channel and a writer task, and all three feed one `TrackLocalStaticSample` per rid attached to a single RTP sender via `add_encoding`. The signalling layer does not change: simulcast is three encodings on one m-line with one track name, which is exactly what Cloudflare's `preferredRid` selects between. Everything degrades to today's single-encoding behaviour if fewer than two encoders can be built.

**Tech Stack:** Rust, `webrtc` crate 0.14 (send-side simulcast via `TrackLocalStaticSample::new_with_rid` + `RTCRtpSender::add_encoding`), Media Foundation (Windows hardware H.264) with OpenH264 software fallback, Tokio.

**Spec:** No separate spec document. The authority is the server contract in the Echo backend (`Echo.Voice/Rooms/VoiceSubscriptionPlan.cs`) plus the cost model in `Echo/docs/specs/monetization-pricing-model.md` section 1. The findings that produced this plan are recorded in the "Background" section below, which travels with it.

## Global Constraints

- **Rid names are fixed by the server and are not a choice.** `VoiceVideoLayers` in `Echo.Voice/Rooms/VoiceSubscriptionPlan.cs` declares `High = "a"`, `Medium = "b"`, `Low = "c"`. A publisher using any other name produces layers the server's `preferredRid` can never select.
- **The ladder is full / half / quarter height (1:2:4).** `VoiceVideoLayers.CeilingFor` and the tile thresholds `LowLayerMaxHeight = 180` / `MediumLayerMaxHeight = 360` in `VoiceSubscriptionOptions.cs` are already measured against that ladder.
- **H.264 4:2:0 cannot represent an odd edge.** `MediaFoundationEncoder::new` and `retype` reject odd or zero width/height outright (`encoder_mf.rs:140` and `:305`). Every derived layer size must be even.
- **A Media Foundation encoder must never be dropped.** Destroying a used one crashes inside the driver (Mozilla bug 1754511). `PARKED` exists solely to avoid it; anything that cannot be parked is `std::mem::forget`-ed deliberately.
- **One encoding must stay byte-identical to today.** When only one layer is built, the track is created with `TrackLocalStaticSample::new` (no rid) and gets the full session bitrate. This is the rollback path and must not drift.
- **Do not change `Signalling`, `LocalTrack`, or `tracks_new`.** Simulcast rides one m-line with one track name.

---

## Background: what was established before this plan

Verified by reading the crate source at `~/.cargo/registry/src/index.crates.io-*/webrtc-0.14.0/`:

- `TrackLocalStaticSample::new_with_rid(codec, id, rid, stream_id)` exists (`track_local_static_sample.rs:43`).
- `RTCRtpSender::add_encoding(track)` exists (`rtp_sender/mod.rs:184`) and enforces: the track must carry a rid; the **base** track must also carry a rid (`ErrRTPSenderNoBaseEncoding`); `id`, `stream_id` and `kind` must match the base; rids must be unique; and it must be called before the first send (`ErrRTPSenderSendAlreadyCalled`).
- SDP generation emits `a=rid:<id> send` per encoding and `a=simulcast:send a;b;c` only when `send_parameters.encodings.len() > 1` (`peer_connection/sdp/mod.rs:617-637`). One encoding therefore produces exactly today's SDP.

The blocker this plan clears: `PARKED` in `encoder_mf.rs:711` is a `Mutex<Option<MediaFoundationEncoder>>` — a single slot. Three concurrent encoders would leak two per share into NVIDIA's ~12-session limit, after which `SetOutputType` fails with `0xC00D6D76` and enumeration silently falls through to another vendor's encoder.

---

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/media/publisher/simulcast.rs` | **New.** The ladder: rid names, per-layer geometry, per-layer bitrate split. Pure functions, no hardware, fully unit-testable. |
| `src-tauri/src/media/publisher/encoder_mf.rs` | Modify `PARKED`, `PooledEncoder::acquire`, `Drop` — single slot becomes a bounded pool. |
| `src-tauri/src/media/publisher/pump.rs` | Modify `FramePump` to drive N encoders from one fitted frame. |
| `src-tauri/src/media/publisher/rtc.rs` | Modify `Publication` to hold N rid-tagged tracks on one sender; add a per-layer write path. |
| `src-tauri/src/media/publisher/session.rs` | Modify `start` to build N encoders, N channels, N writer tasks. Add `run_layer_writer`. |
| `src-tauri/src/media/publisher/mod.rs` | Register the new `simulcast` module. |

---

### Task 1: The layer ladder

Pure arithmetic, no hardware, no async. This is the only part of the feature that can be proved correct in CI, so it carries the rules the rest of the tasks merely apply.

**Files:**
- Create: `src-tauri/src/media/publisher/simulcast.rs`
- Modify: `src-tauri/src/media/publisher/mod.rs` (add `pub mod simulcast;` beside the existing module declarations)
- Test: inline `#[cfg(test)] mod tests` in `simulcast.rs`, matching the convention in `fit.rs` and `encoder_mf.rs`

**Interfaces:**
- Consumes: `EncoderSpec` from `super::encoder`.
- Produces: `pub const LAYER_RIDS: [&str; 3]`, `pub struct Layer { pub rid: &'static str, pub spec: EncoderSpec }`, `pub fn layers_for(base: EncoderSpec, max_layers: usize) -> Vec<Layer>`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::publisher::encoder::EncoderContent;

    fn spec(width: u32, height: u32, kbps: u32) -> EncoderSpec {
        EncoderSpec { width, height, fps: 60, kbps, content: EncoderContent::Games }
    }

    #[test]
    fn builds_a_full_half_quarter_ladder() {
        let layers = layers_for(spec(3840, 2160, 16000), 3);
        let sizes: Vec<(u32, u32)> = layers.iter().map(|l| (l.spec.width, l.spec.height)).collect();
        assert_eq!(sizes, vec![(3840, 2160), (1920, 1080), (960, 540)]);
    }

    #[test]
    fn names_the_layers_as_the_server_does() {
        // Not cosmetic: the server selects by these exact names, so a rename here is a layer
        // nothing can ever ask for. Echo.Voice VoiceVideoLayers: High="a", Medium="b", Low="c".
        let layers = layers_for(spec(1280, 720, 4000), 3);
        assert_eq!(layers.iter().map(|l| l.rid).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    }

    #[test]
    fn never_spends_more_than_the_session_budget() {
        // The preset's kbps is the sharer's uplink budget, not the top layer's allowance. Sending
        // the full rate on `a` plus extra for `b` and `c` would raise every sharer's upload by
        // about a third for a feature meant to cut cost.
        let layers = layers_for(spec(3840, 2160, 16000), 3);
        let total: u32 = layers.iter().map(|l| l.spec.kbps).sum();
        assert!(total <= 16000, "ladder spent {total} of a 16000 budget");
    }

    #[test]
    fn gives_the_top_layer_most_of_the_budget() {
        let layers = layers_for(spec(3840, 2160, 16000), 3);
        assert!(layers[0].spec.kbps > layers[1].spec.kbps);
        assert!(layers[1].spec.kbps > layers[2].spec.kbps);
        assert!(layers[0].spec.kbps > 16000 / 2);
    }

    #[test]
    fn a_single_layer_keeps_the_whole_budget_and_the_full_size() {
        // The rollback path. One layer must be exactly what shipped before simulcast existed:
        // full geometry, full bitrate, nothing split off for layers that do not exist.
        let layers = layers_for(spec(1920, 1080, 8000), 1);
        assert_eq!(layers.len(), 1);
        assert_eq!((layers[0].spec.width, layers[0].spec.height), (1920, 1080));
        assert_eq!(layers[0].spec.kbps, 8000);
    }

    #[test]
    fn rounds_every_derived_edge_down_to_even() {
        // The encoder rejects an odd edge outright, and a rejected retype is a dead layer.
        for (w, h) in [(1286u32, 862u32), (1281, 721), (3441, 1441)] {
            for layer in layers_for(spec(w, h, 8000), 3) {
                assert_eq!(layer.spec.width % 2, 0, "{}x{} width", w, h);
                assert_eq!(layer.spec.height % 2, 0, "{}x{} height", w, h);
                assert!(layer.spec.width >= 2 && layer.spec.height >= 2);
            }
        }
    }

    #[test]
    fn drops_layers_too_small_to_be_worth_an_encoder() {
        // 320x180 quarters to 80x45, below the floor, so the ladder stops at two.
        let layers = layers_for(spec(320, 180, 1500), 3);
        assert_eq!(layers.len(), 2);
        assert_eq!((layers[1].spec.width, layers[1].spec.height), (160, 90));
    }

    #[test]
    fn collapses_to_one_layer_when_even_the_half_is_too_small() {
        let layers = layers_for(spec(160, 90, 600), 3);
        assert_eq!(layers.len(), 1);
        // ...and having collapsed, it is the single-layer case: full budget, not a split.
        assert_eq!(layers[0].spec.kbps, 600);
    }

    #[test]
    fn carries_framerate_and_content_onto_every_layer() {
        // Both are session properties, not per-layer ones. A layer encoded at a different rate
        // would drift out of step with the others frame by frame.
        let base = spec(1920, 1080, 8000);
        for layer in layers_for(base, 3) {
            assert_eq!(layer.spec.fps, base.fps);
            assert_eq!(layer.spec.content, base.content);
        }
    }

    #[test]
    fn zero_layers_is_treated_as_one() {
        // Defensive: a caller that computed a count of zero must still get a publishable share.
        assert_eq!(layers_for(spec(1920, 1080, 8000), 0).len(), 1);
    }

    #[test]
    fn every_layer_gets_a_usable_bitrate() {
        // Integer division on a small budget must not produce a 0 kbps layer, which some encoders
        // accept and then emit nothing for.
        for layer in layers_for(spec(1920, 1080, 300), 3) {
            assert!(layer.spec.kbps >= MIN_LAYER_KBPS);
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --lib media::publisher::simulcast`
Expected: FAIL to compile — `simulcast.rs` does not exist yet, and `layers_for` / `LAYER_RIDS` / `MIN_LAYER_KBPS` are undefined.

- [ ] **Step 3: Write the implementation**

Create `src-tauri/src/media/publisher/simulcast.rs`:

```rust
//! The simulcast ladder: how one session's geometry and bitrate become N encodings.
//!
//! Kept apart from the pump and the peer connection because it is the only part of simulcast that
//! can be proved without a GPU, a network or a second machine. Everything downstream applies these
//! numbers; nothing downstream decides them.

use super::encoder::EncoderSpec;

/// The rid names, highest layer first.
///
/// **Fixed by the server, not chosen here.** `Echo.Voice/Rooms/VoiceSubscriptionPlan.cs` declares
/// `VoiceVideoLayers` as `High = "a"`, `Medium = "b"`, `Low = "c"`, and the subscribe carries one of
/// those names as `preferredRid`. A layer published under any other name is one the SFU can never be
/// asked for, so it costs uplink and serves nobody.
pub const LAYER_RIDS: [&str; 3] = ["a", "b", "c"];

/// The shortest layer worth an encoder, in lines.
///
/// Below this the layer costs a Media Foundation session and a per-frame scale to save a viewer
/// almost nothing - the SFU's own floor for choosing the cheapest layer is 180 lines
/// (`VoiceSubscriptionOptions.LowLayerMaxHeight`), so 90 is already half of the smallest tile the
/// server will ever ask for.
const MIN_LAYER_HEIGHT: u32 = 90;

/// The floor on a layer's bitrate. Integer division of a small session budget would otherwise hand
/// the quarter layer 0 kbps, which some encoders accept and then produce nothing for.
pub const MIN_LAYER_KBPS: u32 = 100;

/// Share of the session's budget per layer, in percent, highest layer first.
///
/// <p>H.264's rate need scales roughly with the square root of the pixel count rather than with the
/// pixels themselves, so a half-height layer is worth far more than a quarter of the top layer's
/// bitrate and a quarter-height layer far more than a sixteenth. 68/24/8 is that curve rounded to
/// something a human can check adds to 100.</p>
///
/// <p><b>The session budget is the total, not the top layer's allowance.</b> The alternative - full
/// rate on `a` and extra for the rest - raises every sharer's upload by about a third, which is a
/// regression on the exact connection simulcast is supposed to be considerate of. The cost is that
/// a fullscreen viewer sees the top layer at 68% of the old rate; the benefit is that the other
/// thirteen stop pulling it at all.</p>
const LAYER_BUDGET_PERCENT: [u32; 3] = [68, 24, 8];

/// One encoding: what to call it on the wire, and what to build an encoder for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layer {
    pub rid: &'static str,
    pub spec: EncoderSpec,
}

/// Round down to an even edge, with a floor of 2. H.264 4:2:0 cannot represent an odd one, and
/// `MediaFoundationEncoder::new` rejects it rather than degrading.
fn even(value: u32) -> u32 {
    let floored = value & !1;
    if floored < 2 { 2 } else { floored }
}

/// The ladder for one session, highest layer first.
///
/// <p>Never empty: a caller asking for zero layers still gets one, because the alternative is a
/// share that publishes nothing. A ladder that comes out one layer long is the pre-simulcast case
/// exactly - full geometry, full budget, and (in `Publication::start`) a track with no rid at all,
/// so the SDP is byte-identical to what shipped before this feature.</p>
pub fn layers_for(base: EncoderSpec, max_layers: usize) -> Vec<Layer> {
    let wanted = max_layers.clamp(1, LAYER_RIDS.len());
    let mut layers = Vec::with_capacity(wanted);

    for index in 0..wanted {
        let width = even(base.width >> index);
        let height = even(base.height >> index);
        // Stop at the first layer too small to be worth encoding rather than skipping it: the rids
        // are ordered, and a ladder of a and c with no b would have the SFU's middle choice fall
        // back to the top layer, which is the cost this whole feature exists to avoid.
        if index > 0 && (height < MIN_LAYER_HEIGHT || width < MIN_LAYER_HEIGHT) {
            break;
        }
        layers.push(Layer {
            rid: LAYER_RIDS[index],
            spec: EncoderSpec { width, height, ..base },
        });
    }

    // The budget is only split once there is something to split it with. One layer is the rollback
    // path and must keep the whole allowance.
    if layers.len() == 1 {
        layers[0].spec.kbps = base.kbps;
        return layers;
    }

    for (index, layer) in layers.iter_mut().enumerate() {
        let share = base.kbps.saturating_mul(LAYER_BUDGET_PERCENT[index]) / 100;
        layer.spec.kbps = share.max(MIN_LAYER_KBPS);
    }
    layers
}
```

Add to `src-tauri/src/media/publisher/mod.rs`, beside the existing `mod` declarations:

```rust
pub mod simulcast;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib media::publisher::simulcast`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/publisher/simulcast.rs src-tauri/src/media/publisher/mod.rs
git commit -m "feat(publisher): the simulcast layer ladder"
```

---

### Task 2: A bounded encoder pool

`PARKED` holds one encoder. Three concurrent layers need three, and the two that cannot park today are leaked on every share.

**Files:**
- Modify: `src-tauri/src/media/publisher/encoder_mf.rs:711-787` (`PARKED`, `parked`, `PooledEncoder::acquire`, `impl Drop for PooledEncoder`)
- Test: inline `#[cfg(test)] mod tests` in `encoder_mf.rs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: no signature change. `PooledEncoder::acquire(spec) -> Option<Self>` behaves as before; it can now be called three times concurrently without leaking.

- [ ] **Step 1: Write the failing test**

Add to the existing `mod tests` in `encoder_mf.rs`:

```rust
    /// Three encoders at once, which is what a full simulcast ladder holds.
    ///
    /// Hardware-dependent like every other test in this file: CI containers and VMs have no encoder
    /// and skip. Where one exists, three must coexist - a single-slot pool would hand back the same
    /// object or force two of them to be leaked on drop.
    #[test]
    fn holds_a_whole_ladder_at_once() {
        let Some(top) = PooledEncoder::acquire(spec(1920, 1080)) else {
            eprintln!("no hardware H.264 encoder on this machine; skipping");
            return;
        };
        let middle = PooledEncoder::acquire(spec(960, 540));
        let bottom = PooledEncoder::acquire(spec(480, 270));

        assert!(middle.is_some(), "the pool refused a second encoder");
        assert!(bottom.is_some(), "the pool refused a third encoder");

        drop(top);
        drop(middle);
        drop(bottom);

        // All three parked rather than leaked, so the next share reuses them instead of opening
        // three more sessions against the driver's limit.
        assert_eq!(parked().lock().map(|s| s.len()).unwrap_or(0), 3);
    }

    /// Parking is bounded. A fourth encoder must not grow the pool without limit.
    #[test]
    fn parks_no_more_than_a_ladder_of_encoders() {
        let Some(first) = PooledEncoder::acquire(spec(640, 360)) else {
            eprintln!("no hardware H.264 encoder on this machine; skipping");
            return;
        };
        let held: Vec<_> = (0..PARK_CAPACITY)
            .filter_map(|_| PooledEncoder::acquire(spec(640, 360)))
            .collect();
        drop(first);
        drop(held);

        assert!(parked().lock().map(|s| s.len()).unwrap_or(0) <= PARK_CAPACITY);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib media::publisher::encoder_mf`
Expected: FAIL to compile — `parked()` returns `&Mutex<Option<_>>`, which has no `.len()`, and `PARK_CAPACITY` is undefined. On a machine with no hardware encoder the tests will skip once compiling, which is expected; the compile failure is the red state that matters.

- [ ] **Step 3: Write the implementation**

Replace `encoder_mf.rs:711-715`:

```rust
/// How many encoders may sit parked between shares.
///
/// One per rid of a full simulcast ladder. Parking the whole ladder is what turns the second share
/// of a session into three retypes instead of three fresh Media Foundation sessions, which matters
/// because the driver's session count is the scarce resource here - this machine reports twelve.
pub(crate) const PARK_CAPACITY: usize = super::simulcast::LAYER_RIDS.len();

static PARKED: OnceLock<Mutex<Vec<MediaFoundationEncoder>>> = OnceLock::new();

pub(crate) fn parked() -> &'static Mutex<Vec<MediaFoundationEncoder>> {
    PARKED.get_or_init(|| Mutex::new(Vec::new()))
}
```

Replace `PooledEncoder::acquire` (`encoder_mf.rs:725-741`):

```rust
    /// A parked encoder retyped for `spec`, or a fresh one when none can be reused.
    pub fn acquire(spec: EncoderSpec) -> Option<Self> {
        if let Ok(mut slots) = parked().lock() {
            while let Some(mut encoder) = slots.pop() {
                match encoder.retype(spec) {
                    Ok(()) => return Some(Self(Some(encoder))),
                    Err(e) => {
                        // A transform that refused a retype is in an unknown state, and destroying
                        // it is the one outcome known to crash - so it is dropped from the pool
                        // without being dropped in the Rust sense, and the next parked one is
                        // tried. It used to be parked again, which left a permanently poisoned
                        // slot that every later acquire tried first and failed on.
                        eprintln!("[publisher] a parked encoder refused a retype ({e}); retiring it");
                        std::mem::forget(encoder);
                    }
                }
            }
        }
        MediaFoundationEncoder::new(spec).map(|e| Self(Some(e)))
    }
```

Replace `impl Drop for PooledEncoder` (`encoder_mf.rs:772-787`):

```rust
impl Drop for PooledEncoder {
    fn drop(&mut self) {
        let Some(encoder) = self.0.take() else { return };
        match parked().lock() {
            // Parked, not destroyed. This is the whole point of the type.
            Ok(mut slots) if slots.len() < PARK_CAPACITY => slots.push(encoder),
            // The pool is full, or its lock is poisoned. Letting this one drop would run exactly
            // the teardown that crashes inside the driver, so it is leaked deliberately. Bounded by
            // how often more than a ladder's worth of encoders exist at once, which is ~never.
            _ => {
                eprintln!("[publisher] a spare hardware encoder is being retained rather than destroyed");
                std::mem::forget(encoder);
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib media::publisher::encoder_mf`
Expected: PASS. On a machine with no hardware encoder the two new tests print "skipping" and return; that is a legitimate configuration, not a pass to celebrate. On a Windows machine with a GPU, both must genuinely run.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/publisher/encoder_mf.rs
git commit -m "feat(publisher): park a whole ladder of hardware encoders"
```

---

### Task 3: Pump fanout

One captured frame becomes N encoded frames. The pump keeps one clock, one keyframe policy and one preview so the layers cannot drift apart.

**Files:**
- Modify: `src-tauri/src/media/publisher/pump.rs` (`FramePump` fields, `new`, `apply_spec`, `on_frame`, `stats`)
- Test: the existing `#[cfg(test)] mod tests` in `pump.rs`

**Interfaces:**
- Consumes: `Layer` and `layers_for` from Task 1.
- Produces: `FramePump::new(layers: Vec<PumpLayer>, fps, keyframe_wanted, preview)` and `pub struct PumpLayer { pub encoder: Box<dyn VideoEncoder>, pub frame_tx: Sender<(Vec<u8>, Duration)>, pub width: u32, pub height: u32 }`. `FramePump::stats()` keeps returning `PumpStats` for the top layer, so existing readers are unaffected.

- [ ] **Step 1: Write the failing tests**

Add to `pump.rs`'s `mod tests`, reusing the file's existing `RecordingEncoder`/`EncoderLog` helpers:

```rust
    /// Every layer sees every frame, and each at its own size.
    #[test]
    fn feeds_one_captured_frame_to_every_layer() {
        let (top_log, top) = recording_encoder();
        let (mid_log, mid) = recording_encoder();
        let (top_tx, mut top_rx) = tokio::sync::mpsc::channel(8);
        let (mid_tx, mut mid_rx) = tokio::sync::mpsc::channel(8);

        let mut pump = FramePump::new(
            vec![
                PumpLayer { encoder: top, frame_tx: top_tx, width: 1920, height: 1080 },
                PumpLayer { encoder: mid, frame_tx: mid_tx, width: 960, height: 540 },
            ],
            Arc::new(AtomicU32::new(30)),
            Arc::new(AtomicBool::new(false)),
            (),
        );

        pump.on_frame(&RgbaImage::new(1920, 1080));

        assert_eq!(top_log.lock().unwrap().sizes, vec![(1920, 1080)]);
        assert_eq!(mid_log.lock().unwrap().sizes, vec![(960, 540)]);
        assert!(top_rx.try_recv().is_ok());
        assert!(mid_rx.try_recv().is_ok());
    }

    /// Layers key together or a viewer switching between them waits for the next IDR on the new
    /// one - which on a static screen is the whole keyframe interval of nothing decodable.
    #[test]
    fn asks_every_layer_for_a_keyframe_at_the_same_moment() {
        let (top_log, top) = recording_encoder();
        let (mid_log, mid) = recording_encoder();
        let wanted = Arc::new(AtomicBool::new(true));
        let mut pump = two_layer_pump(top, mid, Arc::clone(&wanted));

        pump.on_frame(&RgbaImage::new(1920, 1080));

        assert_eq!(top_log.lock().unwrap().keyframe_requests, 1);
        assert_eq!(mid_log.lock().unwrap().keyframe_requests, 1);
    }

    /// The sharer's own tile and thumbnail come from the top layer only. Sending one per layer
    /// would triple the IPC cost of a preview nobody asked to see three times.
    #[test]
    fn previews_only_the_top_layer() {
        let previews = Arc::new(Mutex::new(Vec::new()));
        let mut pump = pump_with_preview_sink(CountingPreview(Arc::clone(&previews)));

        pump.on_frame(&RgbaImage::new(1920, 1080));

        assert_eq!(previews.lock().unwrap().len(), 1);
    }

    /// A lower layer whose writer is full must not cost the top layer its frame.
    #[test]
    fn a_backed_up_lower_layer_does_not_stall_the_top_one() {
        let (top_log, top) = recording_encoder();
        let (_mid_log, mid) = recording_encoder();
        let (top_tx, mut top_rx) = tokio::sync::mpsc::channel(8);
        // Capacity 1, filled before the pump runs, so every send to it fails.
        let (mid_tx, _mid_rx_held) = tokio::sync::mpsc::channel(1);
        mid_tx.try_send((vec![0u8], Duration::from_millis(1))).unwrap();

        let mut pump = FramePump::new(
            vec![
                PumpLayer { encoder: top, frame_tx: top_tx, width: 1920, height: 1080 },
                PumpLayer { encoder: mid, frame_tx: mid_tx, width: 960, height: 540 },
            ],
            Arc::new(AtomicU32::new(30)),
            Arc::new(AtomicBool::new(false)),
            (),
        );

        pump.on_frame(&RgbaImage::new(1920, 1080));

        assert_eq!(top_log.lock().unwrap().sizes.len(), 1);
        assert!(top_rx.try_recv().is_ok(), "the top layer lost a frame to a full lower one");
        assert_eq!(pump.stats().dropped_frames, 0, "a lower layer's drop counted against the top");
    }

    /// A resolution change moves every layer in one step, each to its own size.
    #[test]
    fn retypes_every_layer_together() {
        let (top_log, top) = recording_encoder();
        let (mid_log, mid) = recording_encoder();
        let mut pump = two_layer_pump(top, mid, Arc::new(AtomicBool::new(false)));

        *pump.pending_spec().lock().unwrap() = Some(EncoderSpec {
            width: 1280, height: 720, fps: 30, kbps: 4000, content: EncoderContent::Text,
        });
        pump.on_frame(&RgbaImage::new(1920, 1080));

        assert_eq!(top_log.lock().unwrap().sizes, vec![(1280, 720)]);
        assert_eq!(mid_log.lock().unwrap().sizes, vec![(640, 360)]);
    }
```

Add the two helpers the tests above share, next to the existing ones:

```rust
    fn two_layer_pump(
        top: Box<dyn VideoEncoder>,
        mid: Box<dyn VideoEncoder>,
        keyframe_wanted: Arc<AtomicBool>,
    ) -> FramePump<()> {
        let (top_tx, _t) = tokio::sync::mpsc::channel(8);
        let (mid_tx, _m) = tokio::sync::mpsc::channel(8);
        std::mem::forget((_t, _m));
        FramePump::new(
            vec![
                PumpLayer { encoder: top, frame_tx: top_tx, width: 1920, height: 1080 },
                PumpLayer { encoder: mid, frame_tx: mid_tx, width: 960, height: 540 },
            ],
            Arc::new(AtomicU32::new(30)),
            keyframe_wanted,
            (),
        )
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --lib media::publisher::pump`
Expected: FAIL to compile — `FramePump::new` still takes a single encoder and a single `frame_tx`, and `PumpLayer` does not exist.

- [ ] **Step 3: Write the implementation**

In `pump.rs`, replace the `encoder` and `frame_tx` fields of `FramePump` with a layer vector, and add the layer type:

```rust
/// One encoding the pump drives: an encoder, the size it was built for, and where its output goes.
///
/// <p>The sizes live here rather than being derived per frame because a layer's geometry and its
/// encoder's geometry must move as one step - `SoftwareEncoder::encode` rejects any frame whose
/// dimensions differ from the spec it was built for, and that rejection ends the capture loop.</p>
pub struct PumpLayer {
    pub encoder: Box<dyn VideoEncoder>,
    pub frame_tx: tokio::sync::mpsc::Sender<(Vec<u8>, Duration)>,
    pub width: u32,
    pub height: u32,
}
```

`FramePump`'s fields become `layers: Vec<PumpLayer>` in place of `encoder` and `frame_tx`; `width`/`height` stay and continue to mean the **top** layer's geometry, which is what the frame is fitted to before anything is scaled down.

`new` takes `layers: Vec<PumpLayer>` as its first parameter and reads `width`/`height` from `layers[0]`.

`apply_spec` retypes every layer, each at its own step of the ladder:

```rust
    fn apply_spec(&mut self, spec: EncoderSpec) {
        // Recomputed from the incoming top-layer spec rather than scaled from the current sizes, so
        // repeated changes cannot ratchet the ladder down a step at a time.
        let ladder = super::simulcast::layers_for(spec, self.layers.len());

        for (layer, rung) in self.layers.iter_mut().zip(ladder.iter()) {
            if let Err(e) = layer.encoder.reconfigure(rung.spec) {
                // The share carries on at the size this layer already had. A mismatched ladder
                // costs the SFU a good choice between layers; tearing the share down over it would
                // turn a cosmetic fault into the outage this whole path exists to avoid.
                eprintln!(
                    "[publisher] layer {} refused {}x{} ({e}); staying at {}x{}",
                    rung.rid, rung.spec.width, rung.spec.height, layer.width, layer.height
                );
                continue;
            }
            layer.width = rung.spec.width;
            layer.height = rung.spec.height;
        }

        self.width = self.layers[0].width;
        self.height = self.layers[0].height;
        self.fps.store(spec.fps.clamp(1, 60), Ordering::Relaxed);
        for layer in self.layers.iter_mut() {
            layer.encoder.request_keyframe();
        }
        eprintln!("[publisher] now encoding at {}x{} ({} kbps)", spec.width, spec.height, spec.kbps);
    }
```

In `on_frame`, the keyframe decision is made once and applied to every layer:

```rust
        if self.keyframe_wanted.swap(false, Ordering::Relaxed)
            || now.duration_since(self.last_keyframe) >= self.keyframe_interval
        {
            for layer in self.layers.iter_mut() {
                layer.encoder.request_keyframe();
            }
        }
```

and the encode becomes a loop over the layers, fitting once and scaling down from the fitted frame:

```rust
        // Fitted once, to the top layer. Every lower layer is scaled from this rather than from the
        // raw capture: it is smaller work, and it guarantees all three layers show identical
        // framing including the letterbox bars.
        let frame = fit_into(rgba, self.width, self.height);

        // ... preview and keyframe policy, unchanged, both driven from `frame` ...

        for index in 0..self.layers.len() {
            let (width, height) = (self.layers[index].width, self.layers[index].height);
            let scaled;
            let source = if width == self.width && height == self.height {
                &frame
            } else {
                scaled = fit_into(&frame, width, height);
                &scaled
            };

            let outcome = self.layers[index].encoder.encode(source, timestamp_us);
            let chunk = match outcome {
                EncodeOutcome::Chunk(chunk) => chunk,
                EncodeOutcome::Skipped => continue,
                EncodeOutcome::Failed => {
                    eprintln!(
                        "[publisher] layer {} failed with no fallback left",
                        super::simulcast::LAYER_RIDS.get(index).copied().unwrap_or("?")
                    );
                    continue;
                }
            };

            // The top layer alone owns the stats, the sharer's own tile and the keyframe clock.
            // A lower layer's dropped frame is not the share stuttering, and counting it as one
            // would make the diagnostics read as three times worse than the picture actually is.
            if index == 0 {
                self.stats.encoded_frames += 1;
                if chunk.is_keyframe {
                    self.stats.keyframes += 1;
                    self.last_keyframe = now;
                }
                if self.stats.encoded_frames % STATS_EVERY_FRAMES == 0 {
                    eprintln!(
                        "[publisher] {} frames encoded, {} keyframes, {} dropped at the writer",
                        self.stats.encoded_frames, self.stats.keyframes, self.stats.dropped_frames
                    );
                }
                self.emit_local_stream(&chunk.data, chunk.is_keyframe, timestamp_us);
            }

            if self.layers[index].frame_tx.try_send((chunk.data, frame_duration)).is_err() && index == 0 {
                self.stats.dropped_frames += 1;
            }
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib media::publisher::pump`
Expected: PASS, including the file's pre-existing pump tests, which must be updated to the new `FramePump::new` signature by wrapping their single encoder in a one-element `vec![PumpLayer { .. }]`. A single-layer pump must behave exactly as before — that is what those existing tests are now proving.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/publisher/pump.rs
git commit -m "feat(publisher): drive N encoders from one captured frame"
```

---

### Task 4: Rid-tagged tracks on one sender

**Files:**
- Modify: `src-tauri/src/media/publisher/rtc.rs:106-125` (`Publication` fields), `:154-343` (`start`), `:380-392` (`FrameSink`)
- Test: `src-tauri/src/media/publisher/e2e_tests.rs`

**Interfaces:**
- Consumes: `LAYER_RIDS` from Task 1.
- Produces: `Publication::layer_tracks() -> Vec<Arc<TrackLocalStaticSample>>` (index 0 = rid `a`), and `Publication::start(signalling, share_id, ice_servers, with_audio, video, layer_count: usize)`.

- [ ] **Step 1: Write the failing test**

In `e2e_tests.rs`, beside the existing publish tests:

```rust
    /// Three encodings on one m-line, under the names the server selects by.
    ///
    /// Asserted on the offer SDP rather than on our own structs, because the SDP is the only thing
    /// the SFU actually reads - webrtc-rs writes `a=rid:<id> send` and `a=simulcast:send a;b;c`
    /// only when a sender holds more than one encoding, so a wiring mistake that left two of the
    /// three unattached would still produce three tracks here and one on the wire.
    #[tokio::test]
    async fn offers_three_rid_tagged_encodings_on_one_track() {
        let (signalling, captured) = capturing_signalling();
        let publication = Publication::start(
            signalling, "share-1", vec![], false, Some(VideoIntent::new(1080, 60)), 3,
        )
        .await
        .expect("publish");

        let sdp = captured.lock().unwrap().offer_sdp.clone();
        assert!(sdp.contains("a=simulcast:send a;b;c"), "no simulcast attribute in:\n{sdp}");
        for rid in ["a", "b", "c"] {
            assert!(sdp.contains(&format!("a=rid:{rid} send")), "no rid {rid} in:\n{sdp}");
        }
        // One video m-line, not three: simulcast is encodings within a track, not tracks.
        assert_eq!(sdp.matches("m=video").count(), 1);
        assert_eq!(publication.layer_tracks().len(), 3);
    }

    /// The rollback path. One layer must produce exactly the SDP that shipped before simulcast.
    #[tokio::test]
    async fn a_single_layer_offers_no_simulcast_attributes_at_all() {
        let (signalling, captured) = capturing_signalling();
        let publication = Publication::start(
            signalling, "share-1", vec![], false, Some(VideoIntent::new(1080, 60)), 1,
        )
        .await
        .expect("publish");

        let sdp = captured.lock().unwrap().offer_sdp.clone();
        assert!(!sdp.contains("a=simulcast:"), "a one-layer share advertised simulcast:\n{sdp}");
        assert!(!sdp.contains("a=rid:"), "a one-layer share advertised a rid:\n{sdp}");
        assert_eq!(publication.layer_tracks().len(), 1);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib media::publisher::e2e_tests`
Expected: FAIL to compile — `Publication::start` takes five arguments, and `layer_tracks` does not exist.

- [ ] **Step 3: Write the implementation**

In `rtc.rs`, replace the `track` field with `tracks: Vec<Arc<TrackLocalStaticSample>>` and add:

```rust
    /// The layer tracks, highest first. Index 0 is rid `a` and is the one every non-simulcast path
    /// means when it says "the track".
    pub fn layer_tracks(&self) -> Vec<Arc<TrackLocalStaticSample>> {
        self.tracks.clone()
    }
```

In `start`, replace the single-track creation (`rtc.rs:182-192`) with:

```rust
        let track_name = format!("screen-{share_id}");
        let layer_count = layer_count.clamp(1, LAYER_RIDS.len());

        // One layer keeps the pre-simulcast constructor. A rid on a lone encoding writes no rid or
        // simulcast attribute into the SDP either way, but going through the same call the previous
        // release did is what makes "drop to one layer" a true rollback rather than a similar path.
        let mut tracks: Vec<Arc<TrackLocalStaticSample>> = Vec::with_capacity(layer_count);
        if layer_count == 1 {
            tracks.push(Arc::new(TrackLocalStaticSample::new(
                h264_capability(),
                "video".to_owned(),
                track_name.clone(),
            )));
        } else {
            // Every layer shares `id` and `stream_id` and differs only by rid: `add_encoding`
            // rejects any other combination, and the base track must itself carry a rid or it
            // refuses with ErrRTPSenderNoBaseEncoding.
            for rid in LAYER_RIDS.iter().take(layer_count) {
                tracks.push(Arc::new(TrackLocalStaticSample::new_with_rid(
                    h264_capability(),
                    "video".to_owned(),
                    (*rid).to_owned(),
                    track_name.clone(),
                )));
            }
        }

        let rtp_sender = peer_connection
            .add_track(Arc::clone(&tracks[0]) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| e.to_string())?;

        // Every encoding has to be attached before the offer is created and before anything is
        // written: the sender refuses one afterwards (ErrRTPSenderSendAlreadyCalled), and the SDP
        // is generated from whatever is attached at that moment.
        for track in tracks.iter().skip(1) {
            rtp_sender
                .add_encoding(Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .map_err(|e| format!("could not attach a simulcast layer: {e}"))?;
        }
```

`FrameSink::write_frame` keeps writing to `self.tracks[0]`, so the existing writer is untouched. Add a sibling for the lower layers:

```rust
impl Publication {
    /// Hand one encoded access unit to a specific layer's packetiser.
    ///
    /// Free-standing rather than part of [`FrameSink`] because the lower layers have no say in the
    /// publication's lifetime - only the top layer's writer may end the share.
    pub async fn write_layer(
        track: &Arc<TrackLocalStaticSample>,
        data: Vec<u8>,
        duration: Duration,
    ) -> Result<(), String> {
        track
            .write_sample(&Sample {
                data: data.into(),
                timestamp: SystemTime::now(),
                duration,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())
    }
}
```

`stop()` still closes `self.track_name` once: the layers share one track name, so closing it closes all three.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib media::publisher::e2e_tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/publisher/rtc.rs src-tauri/src/media/publisher/e2e_tests.rs
git commit -m "feat(publisher): attach rid-tagged simulcast encodings to the sender"
```

---

### Task 5: Session wiring and the kill switch

Builds the ladder, the encoders, the channels and the writers, and decides how many layers this machine and this share actually get.

**Files:**
- Modify: `src-tauri/src/media/publisher/session.rs:292-390` (`start`), and add `run_layer_writer` beside `run_audio_writer`
- Test: inline `#[cfg(test)] mod tests` in `session.rs`

**Interfaces:**
- Consumes: `layers_for` (Task 1), `PumpLayer` (Task 3), `Publication::start(.., layer_count)` and `Publication::write_layer` (Task 4).
- Produces: `fn desired_layer_count(spec: EncoderSpec) -> usize`.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn a_full_size_share_asks_for_a_whole_ladder() {
        assert_eq!(desired_layer_count(spec(1920, 1080)), 3);
    }

    #[test]
    fn a_share_too_small_to_ladder_asks_for_one_layer() {
        assert_eq!(desired_layer_count(spec(160, 90)), 1);
    }

    /// The kill switch. Simulcast is new, cannot be proved without two machines and a live SFU, and
    /// triples the encode cost on the sharer - so there has to be a way back that is not a release.
    #[test]
    fn the_env_var_forces_a_single_layer() {
        std::env::set_var("VENTA_DISABLE_SIMULCAST", "1");
        let count = desired_layer_count(spec(1920, 1080));
        std::env::remove_var("VENTA_DISABLE_SIMULCAST");
        assert_eq!(count, 1);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test --lib media::publisher::session`
Expected: FAIL to compile — `desired_layer_count` does not exist.

- [ ] **Step 3: Write the implementation**

In `session.rs`:

```rust
/// How many layers to attempt for this share.
///
/// <p>The ladder decides the ceiling - a source too small to halve twice gets fewer rungs - and the
/// environment variable can take it to one. Deliberately an environment variable and not a setting,
/// for the same reason `VENTA_FORCE_SOFTWARE_ENCODER` is one: it is a way out of a fault, not a
/// choice a user should be asked to make.</p>
pub(crate) fn desired_layer_count(spec: EncoderSpec) -> usize {
    if std::env::var_os("VENTA_DISABLE_SIMULCAST").is_some() {
        return 1;
    }
    super::simulcast::layers_for(spec, super::simulcast::LAYER_RIDS.len()).len()
}
```

In `start`, replace the single `new_encoder` call with the ladder. **Every encoder must be built before the publication is started**, because the number that actually materialised decides how many rids are offered:

```rust
    let ladder = simulcast::layers_for(spec, desired_layer_count(spec));

    // Built before the publication, because how many succeeded decides how many rids are offered -
    // and a rid advertised with no encoder behind it is a layer the SFU will select and then find
    // empty. A layer that cannot be built is dropped rather than fatal: one encoder is the
    // pre-simulcast share, which is a working share.
    let mut encoders: Vec<Box<dyn VideoEncoder>> = Vec::with_capacity(ladder.len());
    for rung in &ladder {
        match new_encoder(rung.spec) {
            Some(encoder) => encoders.push(encoder),
            None => {
                eprintln!(
                    "[publisher] no encoder for layer {} at {}x{}; publishing {} layer(s)",
                    rung.rid, rung.spec.width, rung.spec.height, encoders.len()
                );
                break;
            }
        }
    }
    if encoders.is_empty() {
        return Err("no H.264 encoder available (OpenH264 not provisioned?)".to_string());
    }
    let encoder_name = encoders[0].name();
    let layer_count = encoders.len();

    let publication = Publication::start(
        signalling, &share_id, ice_servers, screen_audio.is_some(),
        VideoIntent::new(height, fps), layer_count,
    )
    .await?;
    let layer_tracks = publication.layer_tracks();
```

Then one channel and one writer per layer, with the top layer keeping `run_writer` and the rest taking the non-fatal writer:

```rust
    let mut pump_layers = Vec::with_capacity(layer_count);
    let mut lower_writers = Vec::with_capacity(layer_count.saturating_sub(1));

    for (index, (encoder, rung)) in encoders.into_iter().zip(ladder.iter()).enumerate() {
        let (frame_tx, frame_rx) = tokio::sync::mpsc::channel::<(Vec<u8>, Duration)>(FRAME_QUEUE);
        pump_layers.push(PumpLayer {
            encoder,
            frame_tx,
            width: rung.spec.width,
            height: rung.spec.height,
        });
        if index > 0 {
            lower_writers.push((Arc::clone(&layer_tracks[index]), frame_rx));
        } else {
            top_frame_rx = Some(frame_rx);
        }
    }

    // The top layer owns the publication and therefore the share's lifetime.
    tokio::spawn(run_writer(publication, top_frame_rx.expect("a top layer")));
    for (track, frame_rx) in lower_writers {
        tokio::spawn(run_layer_writer(track, frame_rx));
    }
```

and the writer itself, beside `run_audio_writer`:

```rust
/// Feed one lower simulcast layer until its channel closes.
///
/// <p>No failure counting, unlike [`run_writer`], and deliberately so: this task must never end the
/// publication. A run of failed writes on the top layer means the connection is gone and the share
/// is over; the same run on a lower layer means one rid is not getting through, and taking the
/// picture away from every viewer over a layer most of them are not watching would be a far worse
/// answer than serving them the layer that works.</p>
pub async fn run_layer_writer(
    track: Arc<webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample>,
    mut frame_rx: tokio::sync::mpsc::Receiver<(Vec<u8>, Duration)>,
) {
    while let Some((data, duration)) = frame_rx.recv().await {
        if let Err(e) = Publication::write_layer(&track, data, duration).await {
            eprintln!("[publisher] dropped a frame on a lower layer: {e}");
        }
    }
}
```

Finally, `FramePump::new` is handed `pump_layers` instead of a single encoder, and the `eprintln!` announcing the share reports the ladder:

```rust
    eprintln!(
        "[publisher] publishing {} layer(s) with {}: {}",
        layer_count,
        encoder_name,
        ladder.iter().take(layer_count)
            .map(|l| format!("{}={}x{}@{}k", l.rid, l.spec.width, l.spec.height, l.spec.kbps))
            .collect::<Vec<_>>()
            .join(" "),
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib media::publisher`
Expected: PASS across `simulcast`, `encoder_mf`, `pump`, `session` and `e2e_tests`.

- [ ] **Step 5: Verify the whole crate still builds**

Run: `cd src-tauri && cargo build`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/media/publisher/session.rs
git commit -m "feat(publisher): publish a simulcast ladder, with a way back to one layer"
```

---

## Manual verification (required — no automated test covers this)

Nothing above proves a viewer sees a picture. These steps are the acceptance criteria, and the feature is not done until they pass on real hardware.

- [ ] **A two-machine share.** Sharer on Windows with a GPU, viewer on a second machine, in a guild whose rung reaches the resolution being shared. Confirm the viewer sees the picture at all — a broken simulcast offer typically shows as a permanently black tile, not an error.
- [ ] **Check the offer.** In the sharer's log, confirm the `publishing 3 layer(s)` line and the per-rid sizes. If it says 1, simulcast silently did not engage.
- [ ] **Confirm layer selection actually saves bytes.** With the viewer's tile small (grid, not fullscreen), watch the sharer's upload. Then fullscreen the tile. The point of the feature is that the first case costs less than the second; if they are identical, `preferredRid` is not selecting and the ladder is not being used.
- [ ] **Roll back cleanly.** Set `VENTA_DISABLE_SIMULCAST=1`, restart, share again, confirm the log says `1 layer(s)` and the viewer still sees the picture.
- [ ] **Six consecutive shares.** Start and stop a share six times in one run, confirming the log never reports building fresh encoders after the first share and never prints the "retained rather than destroyed" line. This is what proves the pool fix; the old single-slot pool would have leaked two sessions per share and hit the driver's limit around here.

---

## Self-review notes

- **Spec coverage.** The server contract is covered by Task 1 (rid names, ladder shape) and Task 4 (one m-line, rids in the SDP). The pool blocker is Task 2. The pricing model's requirement — that small tiles get a cheap layer — is only actually verified by the manual bandwidth check, which is why it is listed as an acceptance criterion rather than assumed.
- **The riskiest task is 3, not 4.** `on_frame` is on the capture thread and every existing pump test guards a rule written for a viewer-visible failure. Those tests must keep passing unchanged apart from the constructor, and a single-layer pump must be indistinguishable from today's.
- **Known gap:** if a lower layer's encoder dies mid-share (`EncodeOutcome::Failed`), this plan logs and continues with that rid going silent rather than renegotiating it away. A viewer already pinned to that layer would freeze. Renegotiating a layer out mid-share is a larger change and is deliberately not in scope; the mitigation is that `ResilientEncoder` already falls back to software before reporting `Failed`.
