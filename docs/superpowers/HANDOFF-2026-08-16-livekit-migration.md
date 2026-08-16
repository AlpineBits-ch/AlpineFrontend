# Handoff: the LiveKit signalling migration

**State on 2026-08-16.** 30 commits on `main` in Alpine, 2 in `infrastructure`, **nothing pushed**.

Design: `docs/superpowers/specs/2026-08-16-livekit-signaling-migration-design.md`.
Phase 0 plan: `docs/superpowers/plans/2026-08-16-livekit-phase-0-transport-probe.md`.
Phase 1 plan: `docs/superpowers/plans/2026-08-16-livekit-phase-1-rust-room.md`.

---

## 1. The black tile - found and fixed

**We offered four H.264 payload types and transmitted on the fourth.** LiveKit binds an incoming
track to the *first* codec on its m-line and silently discards every packet carrying any other
payload type, so the entire share was dropped at the SFU's forwarder.

The offer read `m=video ... 102 127 108 125`. The SFU bound **102**. `TrackLocalStaticSample` binds
by exact fmtp match, so it transmitted on **125**. Measured against `livekit-server` 1.13.5:

```
dropping packet - payload mismatch   packetPayloadType: 125, payloadType: 102
```

`sfu/receiver_base.go`:

```go
if extPkt.Packet.PayloadType != uint8(r.params.Codec.PayloadType) {
    // drop packets as we don't support codec fallback directly
    continue
}
```

That `continue` sits above both the downtrack broadcast and the stream tracker, which is the whole
reason this looked like anything but what it was:

- The SFU's **upstream** counters climbed normally - the buffer is upstream of the drop.
- It even **detected our keyframes** (`stopping key frame seeder: received key frame`), which is why
  the keyframe theory this document used to recommend was wrong.
- Downstream it reported `PauseReason: FEED_DRY`, every layer bitrate `0`, `TargetLayer {-1,-1}` -
  the reading of a publisher sending nothing, produced by a publisher sending everything.

**The fix** (`media::publisher::rtc::publisher_api`): register exactly one video codec, the one we
transmit. Ordering ours first would have fixed the instance and left the trap armed - it would rest
on the SFU's choice rule staying "the first one". There is now nothing else to choose.

Guarded by `offer_shape::the_video_m_line_offers_only_the_codec_we_transmit` (no server needed) and
by `room_tests::the_sfu_forwards_a_published_screen_to_a_subscriber`, which now reports
`wrote 149 samples, subscriber received 440 RTP packets` where it read `0` before.

### How to see it again

The server's own debug log is the only place this is visible. Nothing on the client says a word.

```
livekit-server --config <a config with logging.level: debug>
cargo test --manifest-path src-tauri/Cargo.toml \
  --lib media::livekit::room_tests::the_sfu_forwards -- --ignored --nocapture
```

Then grep the server log for `payload mismatch` and for `FEED_DRY`. A known-good pair to compare
against costs nothing and settles "is it us or the server" in one step:

```
lk room join --url ws://127.0.0.1:7880 --api-key devkey --api-secret secret \
   --identity cli-pub --publish-demo probe
lk room join --url ... --identity cli-sub --auto-subscribe probe
```

A working forward logs `switching feed` and `forwarded key frame`. Ours logged neither.

---

## 1a. Still open: the phone's camera

A camera published from the handset does not appear on desktop. **Not diagnosed** - the fix above is
a different fault, and nothing here has been measured yet.

The concrete suspicion, from `venta-mobile`'s own `lib/core/voice/video_layers.dart`: that client
publishes **VP8** deliberately, because Android's Codec2 H.264 encoder can only declare Level 3.1
and would send 1080p60 under it. That file also records the way it loses:

> The server can still override it - a codec absent from `enabled_publish_codecs` is replaced by the
> first that is present.

So if the room's `enabled_codecs` omits VP8, the handset is pushed onto H.264 and publishes a stream
that exceeds its own declaration - which the same file says "fails as a black tile rather than a
soft one".

Two greps settle it, in this order:

1. `enabled_publish_codecs` on the phone's `JoinResponse` - does it list `video/VP8`?
2. The server log while the phone publishes - `payload mismatch` and `FEED_DRY` again, or neither.

Ruled out already, by reading: track naming (`camera` classifies as video on both sides), and the
desktop's subscribe path (`voice-rtc.service.subscribeVideo` handles `kind: 'video'`, driven off the
roster announcement, which the handset does send via `_declarePublish`).

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
  Windows**; the container advertises candidates the host cannot reach. Get it from
  `https://github.com/livekit/livekit/releases` - match the version pinned in
  `infrastructure/modules/sfu/variables.tf` (`livekit_version`, 1.13.5) so a local result means
  something about production. Dev mode uses the fixed pair `devkey` / `secret`, which is what
  `room_tests::dev_token` mints against.
- **The server's own log is the best evidence in this whole area** and was ignored for far too long.
  It is what proved the SFU receives our video and creates a downtrack.
- Most source files are **CRLF**. Scripted edits with `\n` match nothing and report success. This
  silently no-opped a patch and cost a wrong conclusion; normalise before substituting, or use an
  editor tool.
