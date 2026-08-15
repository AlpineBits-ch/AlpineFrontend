# Simulcast publishing — handover, 2026-08-16

**Status: code complete, fully unit-tested, NOT verified on real hardware against a real SFU, NOT committed.**

Everything below is uncommitted in the working tree of `C:\Users\Domin\WebstormProjects\Alpine`.
The implementation plan this followed is `docs/superpowers/plans/2026-08-16-simulcast-publishing.md`
and it was executed in full — all five tasks. What remains is the manual verification, which needs
two machines and cannot be done from a terminal.

---

## Why this exists (read this first, it is the load-bearing context)

A Pro guild's plan grants `voice.video_ceiling = 2160p60`, and until yesterday members still only got
1080p. The cause was **not** the entitlement system: an *operator ceiling* (`VOICE_VIDEO_CEILING`)
shipped at `1080p60` and clamped every room below what the plan granted. Operator ceilings are
deliberately not an `IEntitlementSource`, so they never appear on the admin provenance screen — which
is why the admin screen and the client disagreed and it looked like a resolution bug.

**That ceiling has since been raised to `2160p60`** in five files across two other repos (see
"Related changes already shipped" below). That raise is live *without* simulcast, which is the
expensive state: with a single encoding every viewer pulls the top layer, so one 4K share to fourteen
people costs ~50 GB/hour against the ~18 GB/hour the pricing model assumes.

**This work is what makes that raise affordable.** From `Echo/docs/specs/monetization-pricing-model.md`
section 1: 4K *with* simulcast (18.2 GB/h) is cheaper than 1080p60 *without* it (25.2 GB/h). So
finishing this does not just enable 4K — it lowers the bill relative to today.

There is therefore real urgency: **every day this sits unverified is a day the egress is running at
the expensive rate.** If verification cannot happen soon, the correct interim action is to set
`VOICE_VIDEO_CEILING` back to `1080p60` (see rollback below), not to leave it as-is.

---

## What was built

| File | Change |
|---|---|
| `src-tauri/src/media/publisher/simulcast.rs` | **New.** The ladder: rid names, per-layer geometry, per-layer bitrate split. Pure functions, 11 tests. |
| `src-tauri/src/media/publisher/encoder_mf.rs` | `PARKED` single slot → bounded `Vec` pool (`PARK_CAPACITY = 3`). 2 tests. |
| `src-tauri/src/media/publisher/pump.rs` | `FramePump` drives N layers from one fitted frame. New `PumpLayer`. 5 tests. |
| `src-tauri/src/media/publisher/rtc.rs` | `Publication` holds N rid-tagged tracks on one sender. New `layer_tracks()`, `write_layer()`. |
| `src-tauri/src/media/publisher/session.rs` | Builds the ladder, N encoders, N channels, N writers. New `desired_layer_count()`, `run_layer_writer()`. 3 tests. |
| `src-tauri/src/media/publisher/e2e_tests.rs` | Captures the offer SDP; 2 tests asserting the simulcast attributes. |
| `src-tauri/src/media/publisher/mod.rs` | Registers `pub mod simulcast;`. |

**Test state: `cargo test --lib` → 604 passed, 0 failed, 5 ignored.** `cargo build` clean.

### The three facts that constrain everything

1. **Rid names are a server contract, not a choice.** `Echo.Voice/Rooms/VoiceSubscriptionPlan.cs`
   declares `VoiceVideoLayers` as `High = "a"`, `Medium = "b"`, `Low = "c"`. A layer published under
   any other name is one `preferredRid` can never select — it costs uplink and serves nobody.
2. **The ladder is full / half / quarter height (1:2:4).** The SFU's tile thresholds
   (`LowLayerMaxHeight = 180`, `MediumLayerMaxHeight = 360`) are already measured against it.
3. **A Media Foundation encoder must never be dropped.** Destroying a used one crashes inside the
   driver (Mozilla bug 1754511). Anything that cannot be parked is `std::mem::forget`-ed on purpose.
   That is not a leak bug; it is the mitigation.

### Two design decisions someone may want to revisit

- **Bitrate split (`LAYER_BUDGET_PERCENT` in `simulcast.rs`, currently `[68, 24, 8]`).** The preset's
  kbps is treated as the *total* uplink budget and split across layers, rather than giving the top
  layer its full rate and adding the others on top. This keeps the sharer's upload exactly where it
  is today, at the cost of a fullscreen viewer seeing the top layer at 68% of the old bitrate. The
  alternative raises every sharer's upload ~35%. One constant to change if that trade is wrong.
- **Kill switch: `VENTA_DISABLE_SIMULCAST=1`** forces one layer. Follows the existing
  `VENTA_FORCE_SOFTWARE_ENCODER` precedent — a diagnostic, not a user setting.

### The safety property everything is built around

**One layer must be byte-identical to the pre-simulcast share.** `layers_for(..)` returning a
single layer gives it the full budget and full geometry, and `Publication::start` with
`layer_count == 1` goes through `TrackLocalStaticSample::new` (no rid), so the SDP carries no `a=rid:`
or `a=simulcast:` at all. There is a test for exactly this
(`a_single_layer_offers_no_simulcast_attributes_at_all`). Every pre-existing pump test still passes
with only its constructor changed — that is the proof the fallback path did not drift.

---

## What is NOT done, and is the whole remaining risk

**No part of this has been observed working against a real SFU with a real viewer.** The unit tests
prove the SDP is shaped correctly and the ladder arithmetic is right. They cannot prove a viewer sees
a picture, and they cannot prove the SFU actually serves a cheaper layer to a small tile — which is
the entire point of the feature.

Run these, in order, before considering this done:

1. **A two-machine share.** Sharer on Windows with a GPU, viewer on a second machine, in a guild
   whose rung reaches the shared resolution. Confirm the viewer sees a picture at all. A broken
   simulcast offer usually shows as a permanently black tile, not an error.
2. **Check the offer engaged.** The sharer's stderr logs `publishing 3 layer(s): a=WxH@Nk b=... c=...`.
   If it says `1 layer(s)`, simulcast silently did not engage — check `VENTA_DISABLE_SIMULCAST` and
   whether the encoders all built (the log says which layer failed).
   Release builds need `attach_parent_console` to show stderr — see
   [Release build diagnostics](../../../../.claude/projects/.../project_release_build_diagnostics.md)
   or just run the dev build.
3. **Confirm layer selection actually saves bytes.** This is the acceptance test that matters. With
   the viewer's tile *small* (grid, not fullscreen), watch the sharer's upload. Then fullscreen the
   tile. The small-tile case must cost measurably less. **If the two are identical, the ladder is
   being published but not selected**, and the feature is doing nothing except tripling the sharer's
   CPU — in which case investigate `preferredRid` on the subscribe (server side,
   `VoiceRoomService.cs:885`, gated by `SendPreferredRid` / `VOICE_PREFERRED_RID`).
4. **Roll back cleanly.** `VENTA_DISABLE_SIMULCAST=1`, restart, share, confirm `1 layer(s)` and that
   the viewer still sees the picture.
5. **Six consecutive shares.** Start and stop a share six times in one process. Confirm the log never
   prints `a spare hardware encoder is being retained rather than destroyed`. This is what proves the
   pool fix — the old single-slot pool would have leaked two sessions per share and hit the driver's
   ~12-session limit right about here.

### Known gaps, deliberately not addressed

- **A lower layer whose encoder dies mid-share goes silent rather than being renegotiated away.** A
  viewer pinned to that layer would freeze. Renegotiating a layer out mid-share is a much larger
  change. Mitigated by `ResilientEncoder` already falling back to software before reporting `Failed`.
- **A partial retype leaves the ladder mismatched.** If layer `b` refuses a reconfigure and `a`
  accepts, the rungs no longer stand in 1:2:4. Not fatal — each rid is an independent encoding and
  the receiver just picks one — but the SFU's choice gets worse. Logged, not corrected.
- **CPU cost is real and unmeasured.** Three simultaneous encodes (4K + 1080p + 540p). On a machine
  with no hardware encoder this falls to openh264 for all three, which will very likely not keep up
  at 4K. Consider whether `desired_layer_count` should return 1 when the encoder is software — that
  check does not exist today and may be the first thing real testing demands.

---

## Related changes already shipped (context, not your work)

Committed by the user earlier today:

- **Alpine `d459e19` "feat: entitlements fixes and simulcast"** — despite the message, this commit
  contains **no simulcast code**. It is the 2160p picker option plus the `solveGeometry` ceiling
  clamp. Worth amending the message; it will mislead archaeology otherwise.
  - Added `2160p` to `StreamResolution` and every table in `src/app/models/stream-preset.ts`.
  - `solveGeometry` now takes a required `ceiling` and caps `source` to the rung's `maxHeight`. This
    closed a real leak: a 4K display shared as `source` used to publish 4K on *any* rung, because
    `clampPreset` never clamps `source` and the client never read back the server's granted height.
  - Direct calls still pass `NO_ROOM_CEILING` (null) — `VoiceLimitsService` is only entered for guild
    channels, so a call has no limits block to read. That path still leaks, knowingly and with a
    comment saying so.
- **alpine-infra `7185c58` "feaT: add 2k limits"** — `VOICE_VIDEO_CEILING: "2160p60"` in both
  `guild/templates/configmap.yaml` and `messaging/templates/configmap.yaml` (messaging owns the
  direct-call side; a ceiling on channels but not calls is the asymmetry Echo.Voice was unified to
  prevent).
- **Echo backend — still uncommitted** in `C:\Users\Domin\RiderProjects\Echo`: `compose.yaml`,
  `deploy/compose.yaml` (both defaults `1080p60` → `2160p60`), plus stale rung lists corrected in
  `AppEnvironment/Env.cs` and `deploy/install.sh`.

### Rollback of the ceiling raise

Set `VOICE_VIDEO_CEILING` back to `1080p60` in those five places. It is the single most expensive
value in those files and the one-line fix if egress spikes.

---

## Also worth knowing

- **`origin/release` is red** and has been since commit `abada51`. Its tip `373fe5b` pins the
  `src/assets/i18n/locales` submodule at `402effb`, which lacks `CALL.STREAM_RESUMING`, so
  `i18n-keys.spec.ts` fails. Fixed on `main` by `e484241`; never merged across.
- **Run Angular tests through the CLI**, not bare vitest: `./node_modules/.bin/ng test` or
  `bun x ng test`. `npx ng test` fails on this machine (`could not determine executable to run`).
- **Rust tests:** `cd src-tauri && cargo test --lib media::publisher`.
- **This machine has a working hardware H.264 encoder**, so the `encoder_mf` pool tests genuinely ran
  rather than skipping. On a machine without one they print "skipping" and return — a pass there
  proves nothing about the pool.
- **The e2e SDP tests were mutation-verified.** Breaking the `add_encoding` loop makes
  `offers_three_rid_tagged_encodings_on_one_track` fail with "no simulcast attribute in the offer".
  This codebase has been bitten twice by WebRTC tests that passed while proving nothing; if you
  change those tests, mutate what they guard before trusting them again.

## Suggested next step

Commit what is here (the tree is green and self-consistent), then do the manual verification. If
verification cannot happen within a day or so, roll `VOICE_VIDEO_CEILING` back to `1080p60` in the
meantime — the raise is only affordable once simulcast is proven to work, and right now it is
neither proven nor cheap.
