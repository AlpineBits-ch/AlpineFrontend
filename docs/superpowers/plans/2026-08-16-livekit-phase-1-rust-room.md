# LiveKit Phase 1: the Rust room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the desktop microphone and screen publisher off the removed SDP-relay surface and onto
LiveKit, as a single participant, keeping every line of the capture, processing, encoding and mixing
pipeline.

**Architecture:** Grow `media::livekit::probe` into a real `Room`. One room per `VoiceTarget`, shared
by the voice engine and the screen publisher. `livekit_api::signal_client` owns the WebSocket;
`webrtc-rs` owns two peer connections; everything above the transport is untouched.

**Tech Stack:** Rust, `livekit-api` 0.6.3 (`signal-client-tokio`), `livekit-protocol` 0.7.12,
`webrtc-rs` 0.14, tokio.

**Spec:** `docs/superpowers/specs/2026-08-16-livekit-signaling-migration-design.md`

## What Phase 0 already established

Do not re-litigate these; they are measured, in `§7` of the spec, and pinned by
`media::livekit::probe_tests`:

- Opus, H.264 (including **High 5.2**), three-rid simulcast and transport-cc all negotiate.
- `subscriber_primary` is true; `single_peer_connection` is *available* but **must not be assumed**
  until the production SFU version is known.
- `TrackPublishedResponse` can arrive **before** the `Answer`. Anything reading the remote
  description after publishing must wait explicitly.
- Candidates ride in the SDP via `gathering_complete_promise()`; no trickle needed.
- The publisher connection must open `_lossy` and `_reliable` data channels or it never connects.
- Build the publisher connection from `publisher_api()`, never `voice_api()` - only the former
  registers High 5.2 on payload type 118.

## Global Constraints

- Publish rids are `f`/`h`/`q`, highest first (`LAYER_RIDS`, already renamed).
- Server-sent `layer`/`maxLayer` are `a`/`b`/`c`, a ranking, not rids.
- `auto_subscribe` is always false.
- Identity is `{userId}` primary, `{userId}#{tag}` secondary; split on the first `#`.
- Track names: `audio`, `screen-{shareId}`, `screen-audio-{shareId}`. Test `screen-audio-` first.
- Resume with the cached URL and token; re-fetch a connection only on auth refusal or a gap past the
  10 minute TTL, never per attempt.
- **Isle is untouched.** It keeps `webrtc-rs` against Cloudflare and the `cf/*` dialect.

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/media/livekit/room.rs` | one room: signal + two peer connections, track registry, reconnect policy |
| `src-tauri/src/media/livekit/publish.rs` | `AddTrackRequest` through to a live sender, audio and simulcast video |
| `src-tauri/src/media/livekit/subscribe.rs` | `UpdateSubscription`, incoming track to `RemoteSource` |
| `src-tauri/src/media/livekit/identity.rs` | `{userId}#{tag}` split, both directions |
| `src-tauri/src/media/livekit/probe.rs` | **deleted** at the end of the phase, once `room.rs` covers it |
| `src-tauri/src/media/voice/rtc.rs` | modified: publishes into a shared room instead of owning a PC |
| `src-tauri/src/media/publisher/rtc.rs` | modified: same, and drops its own signalling |
| `src-tauri/src/media/publisher/signalling.rs` | modified: neutral dialect deleted, Isle half kept |

## Tasks

Written at task granularity with their tests named. Each task's steps are expanded immediately
before it is executed, against the code as it then stands - the probe changed shape twice during
Phase 0 and writing literal code for Task 7 now would be writing fiction.

### Task 1: `identity.rs` - the `#` split

Pure functions, no I/O, so this is the one task with no server dependency.

- `identity_for(user_id, tag: Option<&str>) -> String`
- `user_of(identity: &str) -> &str` - splits on the **first** `#`
- Tests: bare identity round-trips; `user-1#view` yields `user-1`; a Sqid containing no `#` is
  unchanged; an identity with two `#` splits at the first.

### Task 2: `room.rs` - connect, and the reconnect policy

Grown from `Probe::connect`. Adds what the probe deliberately omitted:

- `Room::connect(url, token, tag: Option<&str>)`, holding `url` and `token` for resume.
- On `SignalEvent::Close`, call `SignalClient::restart()` and re-apply state. Re-fetch a connection
  **only** on auth refusal or after a gap longer than the token TTL.
- Tests: a `restart()` path that does not re-fetch; a policy test that a gap past the TTL does.

### Task 3: `publish.rs` - audio and video onto one participant

Both `publish_audio` and `publish_video` move here, unchanged in shape from the probe, plus:

- An `unpublish(track_name)` sending `MuteTrackRequest`/removing the sender.
- Tests: publishing mic and a share on **one** room yields two SIDs on one participant - this is the
  merge in §2.1, and the test that proves desktop stopped producing a second identity.

### Task 4: `subscribe.rs` - audio only, into the mixer

- `subscribe(track_sid)` / `unsubscribe(track_sid)`.
- Incoming track to `RemoteSource`, keyed by the user id from `identity.rs`, feeding `jitter`.
- Tests: an incoming track lands in the right `RemoteSource`; a track for an unknown identity is
  dropped with a counter rather than panicking.

### Task 5: `voice/rtc.rs` onto the room

`VoicePublication` keeps its packet-writing half and loses its peer connection, offer/answer and ICE
gather. `PublicationStats` keeps every counter - they are what tell "signalled but silent" apart from
"never signalled".

### Task 6: `publisher/rtc.rs` onto the same room

The screen publisher stops opening its own session and publishes onto the room `voice/session.rs`
already holds. This is where the three-connections-to-two reduction actually lands.

### Task 7: delete the neutral dialect

`publisher/signalling.rs` loses `Dialect::Neutral` and everything reachable only from it. Isle's
Cloudflare half stays. `media/voice/e2e_tests.rs` and `media/publisher/e2e_tests.rs` are rewritten
against a fake signal server speaking protobuf over a WebSocket instead of mocked HTTP routes.

**Per `project_media_e2e_test_traps`: mutate what each rewritten test guards and watch it fail before
trusting it.** Two of those tests currently pass by asserting on a mock's recorded requests, which a
protobuf rewrite makes trivially satisfiable.

### Task 8: delete `probe.rs` and `probe_tests.rs`

Once `room.rs` covers the same ground with real tests. The Phase 0 findings live in the spec, not in
the code, so nothing is lost. Keep `docker/livekit-dev/compose.yaml` - Phase 1's tests need it too.

## Open, and deliberately not decided here

- **Single-peer-connection mode.** Available on 1.13.5, unknown on production. If confirmed, Tasks 2
  to 6 collapse to one connection and this plan shrinks. Confirm against `sfu-fsn1.venta.gg` before
  Task 2 rather than after Task 6.
- **The High-profile SPS.** `encoder_mf` now sets High; nothing has yet verified the bitstream it
  produces carries a level within what we declare. Needs a real capture and a real viewer, and its
  failure mode is a black tile rather than a soft one.
