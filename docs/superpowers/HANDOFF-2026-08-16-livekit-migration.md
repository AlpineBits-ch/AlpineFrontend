# Handoff: the LiveKit signalling migration

**State on 2026-08-16.** 30 commits on `main` in Alpine, 2 in `infrastructure`, **nothing pushed**.

Design: `docs/superpowers/specs/2026-08-16-livekit-signaling-migration-design.md`.
Phase 0 plan: `docs/superpowers/plans/2026-08-16-livekit-phase-0-transport-probe.md`.
Phase 1 plan: `docs/superpowers/plans/2026-08-16-livekit-phase-1-rust-room.md`.

---

## 1. The one open bug

**A screen share is a black tile for every viewer.** Reproduced locally with two Rust clients and no
phone involved, so it is not a mobile fault.

```
livekit-server --dev                       # or docker/livekit-dev/compose.yaml
cargo test --manifest-path src-tauri/Cargo.toml \
  --lib media::livekit::room_tests::the_sfu_forwards -- --ignored --nocapture
```

Currently prints `wrote 149 samples, subscriber received 0 RTP packets` and
`subscriber tracks_opened: 0`.

### What it is

The SFU receives our video, accepts the subscription, creates a downtrack, and **never sends a byte
on it**. Its own teardown log says so:

```
rtp stats ... "direction": "downstream", "mime": "video/H264",
             "stats": {}, "statsError": "not initialized"
```

`on_track` therefore never fires on the subscriber, which is why `tracks_opened` is 0 and every
viewer - phone, desktop, anything - sees a tile with no bytes.

### What is ruled out, each by measurement

| Suspect | Evidence against |
|---|---|
| The mobile client | Reproduces with two Rust clients |
| Publishing | Server log: `mime: video/H264, direction: up, packets: 374, bytes: 401231` |
| Room codec allow-list | `JoinResponse.enabled_publish_codecs` contains `video/H264` |
| H.264 profile or level | Identical failure with `42e034` and with stock `42e01f` |
| Simulcast / rid tagging | Identical failure with a plain single track, no rid, no simulcast |
| Publish ordering | Identical with audio published first, as production does |
| Subscribe never issued | Server creates a downtrack (`close downtrack ... kind: VIDEO`) |
| Offer never arriving | Our pump logs three subscriber offers received **and answered** |
| mid/rid mismatch | SDP is internally consistent: `mid:0`, `rid:f`, extmaps present both sides |

### The next thing to try

**Keyframe gating.** An SFU will not start a subscriber mid-stream without an IDR; it sends a PLI
upstream and waits. The test writes encoder output straight to the track and **ignores RTCP**, so no
PLI is ever answered. Production does have that path (`keyframe_wanted`, driven off RTCP in
`media::publisher::rtc`), which makes the test *harsher* than production rather than equivalent -
worth confirming before concluding anything from it.

Concretely: read RTCP on the publisher's sender in the test, call `request_keyframe()` on the
encoder when a PLI or FIR arrives, and see whether the downtrack starts. If it does, the bug is that
`Room` has no keyframe path of its own and every publisher must supply one.

Second candidate if that fails: whether our **answer** to the subscriber offer is being accepted.
The pump logs that it answered, but nothing verifies the server was happy with it.

---

## 2. What landed and works

Measured against `livekit-server` 1.13.5 unless stated.

- **`livekit-api`'s signalling client, not the `livekit` SDK.** `signal_client` is public behind a
  feature that pulls no libwebrtc, so the whole media pipeline - capture, AEC, denoise, gate, Opus,
  jitter, mixer, Media Foundation encoder - is untouched. `cargo tree` confirms zero `webrtc-sys`.
- **`media/livekit/`**: `room.rs` (two peer connections), `registry.rs` (one room shared by voice and
  screen, so desktop publishes on **one** participant), `resume.rs`, `identity.rs`, `signal.rs`.
- **Inbound audio works end to end** - `rtp +105 routed +105`, jitter buffer filling, mixer playing.
- **Trickle ICE.** LiveKit trickles its own candidates rather than putting them in the answer; a
  client that ignores `Trickle` connects and then sits at `connecting` until
  `LeaveRequest { ConnectionTimeout }`. Buffered until the remote description exists.
- **The microphone is now declared** via `POST .../voice/publish`. It never was, so the roster never
  recorded us as `Publishing` and other clients' gating skipped us. Independent of the black tile.
- **H.264 Constrained Baseline at Level 5.2** (`42e034`), one entry per profile, curated codec list.
  Level is what makes 2K legal; profile is what makes it decodable. See §3.
- TypeScript: `livekit-client` wrapper, both HTTP surfaces, both room services rewired. `tsc` clean.

---

## 3. H.264: the conclusions, so they are not re-derived

Three wrong turns were taken here in one day. The rules that came out of it:

- **Level and profile are independent.** Level gates resolution and framerate; profile is only
  quality. 1440p60 needs Level 5.2. This is stated in `project_h264_level_ceiling` and was still
  conflated twice.
- **An SFU does not transcode**, so every subscriber must decode the one profile we send. libwebrtc
  matches by profile *equality*; level never blocks a match.
- **Codec2 Android devices advertise Constrained Baseline only**, as encoder and decoder. Plain High
  matches nothing they offer. `venta-mobile`'s `lib/core/voice/video_layers.dart` audits the shipped
  AAR and is the reference.
- **Constrained High is not the escape.** The MFT accepts `UCConstrainedHigh` and then fails
  mid-encode, silently losing the hardware encoder for the session.
- **Two entries of one profile collide.** The SFU answers both onto a single payload type with two
  conflicting `a=fmtp` lines. `register_codec` also silently ignores an already-taken payload type,
  so a custom entry cannot override a default - the list has to be curated.

The encoder itself is healthy at 2560x1440, three concurrent layers, and retype upward. Diagnostics:
`media::publisher::encoder_mf::{ladder_diagnosis, ladder_concurrency}`, all `#[ignore]`d.

---

## 4. Other open items

1. **Reconnect is built and unwired.** `resume.rs` is tested; `Room`'s pump handles
   `SignalEvent::Close` by logging and breaking. A dropped signal permanently ends voice. Doing it
   properly means resume *and* re-establishing the publish - a partial reconnect that restores
   signalling but not media is worse than none.
2. **`livekit-runtime` panics on teardown** - `JoinError::Cancelled` when a `Room` closes with a
   spawned task in flight. Observed as a test process that would not exit and held the build lock.
   Will surface as a hung process on quit.
3. **A re-offer over a live ladder** duplicated rid/simulcast attributes and made the video track
   invisible in the roster. Mitigated in `Room::negotiate` by `dedupe_simulcast`; the underlying
   webrtc-rs behaviour is still there.
4. **`VOICE_VIDEO_CEILING` ships at 1080p60**, so the entitlement layer clamps 2K regardless.
5. **Browser-build liveness** - see spec §8.2a. `VoiceLivenessService` exists, is wired to nothing,
   and does not solve the backgrounded-tab case anyway.
6. **Two backend questions** are open in spec §8.2 and §8.2a.

---

## 5. Working notes

- Run Rust tests with the app **closed**: a running `Venta.exe` or a stray test binary holds
  `alpine_lib-*.exe` and every `cargo test` fails `LNK1104`. A hung test process did this once and
  cost half an hour - check `Get-Process | ? ProcessName -like "*alpine*"`.
- Live tests need `livekit-server --dev` on `ws://127.0.0.1:7880`. **Prefer the native binary on
  Windows**; the container advertises candidates the host cannot reach.
- **The server's own log is the best evidence in this whole area** and was ignored for far too long.
  It is what proved the SFU receives our video and creates a downtrack.
- Most source files are **CRLF**. Scripted edits with `\n` match nothing and report success. This
  silently no-opped a patch and cost a wrong conclusion; normalise before substituting, or use an
  editor tool.
