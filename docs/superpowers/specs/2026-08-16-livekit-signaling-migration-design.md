# LiveKit signalling migration

**Status:** Phase 0 complete and green (§7). Contract questions resolved with the backend
(§6). Phases 1 to 4 not yet implemented.

Echo replaced the SDP relay behind guild voice and DM calls with LiveKit. The room model did not
change: join/leave/snapshot, `instanceId` + `version`, the heartbeat, share viewer counts,
entitlements and subscriber reports are all exactly as they were. Only the negotiation is gone.

Contract: Echo `docs/specs/voice-frontend-guide.md`. Client notes: `docs/contracts/voice-client-notes.md`.

---

## 1. The decision

**We keep our media pipeline and adopt only LiveKit's signalling protocol.**

The `livekit` Rust crate cannot give us that. `rtc_engine` exports `RtcEngine` and `EngineOptions`
and nothing below them; `SignalClient` is private, and the crate pulls `libwebrtc`/`webrtc-sys`
unconditionally. Using it would mean feeding `NativeAudioSource`/`NativeVideoSource` with raw frames
and surrendering the capture chain, the codecs, the jitter buffer, the mixer and the Media
Foundation encoder to libwebrtc - including hardware H.264, which libwebrtc does not have on
Windows.

What we use instead:

- **`livekit-api` 0.6.3** with `default-features = false, features = ["signal-client-tokio",
  "native-tls"]`. Its `signal_client` module is public and the feature is documented upstream as
  *"Signalling client, blind to the transport backend"* - it pulls `livekit-net`,
  `livekit-protocol`, `livekit-runtime` and tokio, and **no libwebrtc**. `default-features = false`
  drops `services-tokio`/`access-token`/`webhooks` (reqwest, jsonwebtoken) which we do not want;
  `native-tls` matches the TLS backend `reqwest` already links in `src-tauri`, so we do not end up
  with two.
- **`livekit-protocol`**, pinned to whatever `livekit-api` 0.6.3 resolves (read it out of
  `cargo tree`, do not guess). Two incompatible copies of the generated types would not be a
  compile error at the boundary we care about.
- **`webrtc-rs` 0.14, unchanged**, as the media transport it already is.

**Nothing is vendored.** An earlier draft of this document proposed copying
`rtc_engine::signal_client` out of the LiveKit repo under attribution, on the belief that it lived
in the `livekit` crate and came with libwebrtc attached. It does not - it lives in `livekit-api`,
behind a feature that exists precisely so the signalling half can be used without the media half.
Taking the crate means upstream maintains the protocol version, the reconnect ladder and the request
queue for us.

What we still own is the RTC engine: two peer connections on `webrtc-rs`, track publication
bookkeeping, subscription handling, and the reconnect *policy* on top of `SignalClient::restart()`.

So this is LiveKit's protocol, not LiveKit's SDK. Everything in `media/voice/` and
`media/publisher/` above the transport survives untouched: capture, AEC, denoise, gate, Opus, jitter,
receive, mixer, playout, `encoder_mf`, `simulcast`, and the encoded-frame tap that feeds the sharer's
own preview.

The webview and the browser build use **`livekit-client`** (the JS SDK), which has no such
limitation and replaces every hand-rolled offer/answer on that side.

**Isle is out of scope.** Proximity voice drives `CloudflareService` directly, has no room model and
stays on the Cloudflare surface. It keeps `webrtc-rs` and the `cf/*` routes, so both stacks coexist
in the binary and nothing is removed from `Cargo.toml`.

---

## 2. Architecture after the change

### 2.1 Connections and identities

Identity is the **bare user id** on a primary connection, and `{userId}#{tag}` on a secondary. The
`#` is guaranteed safe to split on: user ids are Sqids and never contain one, and the tag is
stripped before it is appended. So a remote LiveKit participant maps to a user without consulting
the snapshot - split on the first `#`.

Desktop goes from three SFU connections to two. The browser build has one.

| Host | Connection | Identity | Does |
|---|---|---|---|
| Desktop | Rust room, `primary=true` | `{userId}` | publishes mic + screen video + screen audio; subscribes audio only |
| Desktop | Webview room, `primary=false&tag=view` | `{userId}#view` | publishes camera; subscribes video only |
| Browser | one room, `primary=true` | `{userId}` | everything |

Merging the two Rust connections is possible because LiveKit publishes many tracks on one
participant, and the two live in the same process. It removes the case
`VoiceShareSnapshot.mediaSessionId` exists for: a share published on a session that is not the
participant's microphone session. That field stays on the wire and stays handled - other clients may
still split - but desktop stops producing it, because its shares now sit on the primary identity.

One tag per connection per user. Two connections sharing a tag share an identity, and the second
evicts the first, so `view` must never be reused for a second webview room.

Audio and video split across the two desktop transports, as they do today:

- **Rust subscribes to audio only** - microphones and `screen-audio-{shareId}`, both of which feed
  the mixer. This is what AEC and per-source volume need.
- **The webview subscribes to video only** - cameras and `screen-{shareId}`.
- The webview's room must never subscribe an audio track. Two transports playing the same
  participant is double playout, and `autoSubscribe: false` is what prevents it.

### 2.2 The control plane moves to the webview

Rust stops making HTTP calls for guild and call rooms. The webview fetches
`POST .../voice/connection` on Rust's behalf and passes `{url, token, identity}` down through the
existing `VoicePublisher` / `ScreenPublisher` ports, and it makes the `publish` / `unpublish` /
`video` declarations for tracks Rust published.

Why: the webview has the interceptor chain, so it refreshes an expired bearer and replays; a token
string captured at join time cannot. It also puts entitlement degradation handling in one place
rather than two. `publisher/signalling.rs` shrinks to its Isle half.

The port surfaces do not change shape. `VoiceStartOptions` already carries `apiBase`, `token` and
`deviceId`; those are replaced by the connection fields.

### 2.3 What LiveKit requires that Cloudflare did not

Three things change in `media/voice/rtc.rs` and `media/publisher/rtc.rs`, and nowhere else:

1. **Two peer connections.** LiveKit is subscriber-primary: the subscriber PC is what "connected"
   means, and the publisher PC is negotiated only when something is published. Today each
   publication is one bidirectional PC.
2. **Publish is request-then-negotiate.** `AddTrackRequest` carries our track `name` - which is
   where the `audio` / `screen-{shareId}` / `screen-audio-{shareId}` convention lands - plus
   `source` and the simulcast `layers`. The server answers `TrackPublishedResponse` with a SID
   before the track is added and the offer sent.
3. **Two data channels are mandatory.** The publisher PC must open `_lossy` (unordered, zero
   retransmits) and `_reliable`. LiveKit gates publisher readiness on them.

Subscribing becomes `UpdateSubscription{track_sids, subscribe}`; the server adds to the subscriber
PC and offers. Incoming tracks are mapped to participants through `ParticipantInfo` / `TrackInfo`
from `JoinResponse` and `ParticipantUpdate`, not by SDP mid.

### 2.4 Reconnect

**Cache the URL and the token, and resume with both.** A room is placed on a node once and never
moved while it exists; the registry row is dropped only for a room the SFU no longer has, and that
is a room there is nothing to resume into. So a resume to the same URL cannot be wrong.

The token is the only expiring part - 10 minutes by default
(`LIVEKIT_JOIN_TOKEN_TTL_SECONDS`), well past any reconnect ladder. Re-fetch
`POST .../voice/connection` **only** on an auth refusal or after a gap longer than the TTL. Not per
attempt: that mints tokens at the SFU's retry rate. Re-fetching is otherwise free - no roster write,
no re-announce - so an unsure client should re-fetch once rather than loop.

`SignalClient` holds its token behind a mutex and documents it as refreshable, and `restart()`
returns a `ReconnectResponse`, so the resume path exists upstream. What is ours is the *policy*
above it: when to call `restart()`, when to re-fetch a connection instead, and the rule against
doing the latter per attempt.

### 2.5 Simulcast layer vocabulary

Two vocabularies, and they are not the same one.

- **What we publish**: rid names `f` (full), `h` (half), `q` (quarter). LiveKit's convention. The
  server never sees a rid and never matches one - it maps rid to quality through the `layers` list
  in `AddTrackRequest`.
- **What the server sends us**: `layer` in the subscription set, and `maxLayer` on the publish
  reply, both spelled `a` (top), `b` (middle), `c` (bottom). This is a **ranking vocabulary**, not a
  rid. Map it onto `VideoQuality.HIGH` / `MEDIUM` / `LOW` for `setVideoQuality`, and onto
  `UpdateTrackSettings` on the Rust side.

`LAYER_RIDS` in `publisher/simulcast.rs` and `VIDEO_LAYER_RIDS` in `webrtc-encoding.ts` are both
`a`/`b`/`c` today, and both carry a long comment explaining Cloudflare's `ridNotAvailable:
asciibetical` ordering. That rationale is dead: rename the rids, delete the reasoning, and do not
carry it into the new layer mapping, which keeps the letters for an unrelated reason.

---

## 3. Phases

Ordered so the thing that can invalidate the design fails first.

### Phase 0 - prove webrtc-rs against LiveKit's server

A throwaway example binary, not shipped code. It must, against a real LiveKit server:

- connect, join, and stay joined through one ping cycle
- publish Opus from `voice::codec` and have it audible in a `livekit-client` browser tab
- publish H.264 from `encoder_mf` with three simulcast layers named `f`/`h`/`q`, and have a viewer
  served the layer their tile size asks for
- subscribe to one remote audio track and pull PCM through `jitter` into the mixer

**Three compatibility questions this answers**, all cheaper to fail now than in Phase 2:

| Question | Why it is in doubt |
|---|---|
| Does LiveKit accept our Opus offer? | `opus_capability()` is mono with `minptime=10;useinbandfec=1`. Expected fine. |
| Does it accept our H.264? | Our encoders emit Constrained Baseline 3.1 (see `project_h264_level_ceiling`). Needs `packetization-mode=1` to match. |
| Does congestion control close the loop? | TWCC/`transport-cc` and NACK/RTX interceptors must be registered on both PCs, or the sender never adapts. |

**Also worth answering while the probe is up:** `SignalOptions.single_peer_connection` exists, and
`SignalClient::is_single_pc_mode_active()` reports whether the server accepted it. If our server
does, the whole publisher/subscriber split in §2.3 collapses to one peer connection and Phase 1 gets
materially smaller. Try it; do not depend on it.

**Exit:** all three green, or the design falls back to the LiveKit Rust SDK and this document is
rewritten.

### Phase 1 - the Rust room

New `src-tauri/src/media/livekit/`:

| File | Holds |
|---|---|
| `signal.rs` | a thin adapter over `livekit_api::signal_client`: our connect options, and the §2.4 resume policy |
| `room.rs` | one room: two PCs, participant/track registry, reconnect, ping |
| `publish.rs` | `AddTrackRequest` through to a live sender |
| `subscribe.rs` | `UpdateSubscription`, and incoming track to `RemoteSource` |

Then:

- `voice/rtc.rs` and `publisher/rtc.rs` publish into a shared room instead of owning a PC. Their
  packet-writing halves are unchanged; what goes is `Signalling`, the offer/answer dance and the ICE
  gather timeout.
- `voice/session.rs` holds one room per `VoiceTarget` for guild and call, shared by voice and
  screen. Isle keeps its own `webrtc-rs` publication exactly as it is.
- `publisher/simulcast.rs`: `LAYER_RIDS` becomes `f`/`h`/`q`, and the asciibetical rationale goes.
- `publisher/signalling.rs` loses the neutral dialect. `Dialect` collapses, since Isle is the only
  caller left.
- `media/voice/e2e_tests.rs` and `media/publisher/e2e_tests.rs` currently mock HTTP routes
  (`/voice/session`, `/voice/tracks`). They are rewritten against a fake signal server speaking
  protobuf over a WebSocket. Per `project_media_e2e_test_traps`: mutate what each test guards and
  watch it fail before trusting it.

### Phase 2 - the webview and the browser build

- Add `livekit-client`.
- New room wrapper service, one per target, owning connect / reconnect / track events, and mapping
  a remote participant to a user by splitting identity on the first `#`.
- `voice-rtc.service.ts` (1627 lines) and `call-webrtc.service.ts` (1322) keep roster state, gating,
  backfill and heartbeat; their negotiation halves go, along with `webrtc-encoding.ts` - though its
  rid ladder moves rather than dies, renamed to `f`/`h`/`q`.
- `voice-publisher.web.ts` (1014) and `screen-publisher.web.ts` (595) are reimplemented on the SDK
  behind the same ports. The browser build becomes a single room publishing and receiving
  everything.
- `environment.iceServers` and `iceServers()` in `screen-publish.ts` are deleted - the SDK
  negotiates TURN with the node.

### Phase 3 - the new contract surface

`guild-voice.service.ts` and `voice.service.ts`:

| Gone | Replaced by |
|---|---|
| `createSession` | `POST .../voice/connection?primary=&tag=` |
| `negotiateTracks` | `POST .../voice/publish` |
| `renegotiate` | `PUT .../voice/video` |
| `closeTracks` | `POST .../voice/unpublish` |

`models/voice-room.ts`:

- **Delete** `isStaleSubscription`, `isDeadMediaSession`, `STALE_SUBSCRIPTION`, `SESSION_GONE`,
  `DEAD_MEDIA_SESSION`. Guide §8: neither condition exists. With them go
  `SUBSCRIBE_RETRY_DELAYS_MS`, `MAX_PUBLICATION_REBUILDS` and the rebuild path at
  `voice-rtc.service.ts:547-590`. This is the whole VNT-GE21R3P7 apparatus.
- **Add** `subscriptions` to `VoiceRoomSnapshot`, and the set type with its `revision`.
- **Add** `SubscriptionsChanged` to the relay classification. It is a relay: it carries the current
  version without representing a change to it, and the set moves at conversational frequency.
  Advancing on it would let it stand in for a state event we missed.
- **Add** `participantsEvicted` to `VoiceResyncReason`.

Elsewhere:

- `voice-limits.service.ts:189` reads `degradations` from the publish reply rather than the
  negotiate reply. A `403` on publish stops the local track: the token does not permit it either, so
  nobody receives it whatever the client does.
- **`maxLayer`** on the publish and `PUT .../video` replies: the best layer of our video the room
  will distribute to anyone. `null` is the ordinary case and means uncapped; non-null means we
  declared above our rung and no viewer is served above it whatever their tile size. Same `a`/`b`/`c`
  spelling as `layer` - it used to emit the enum name (`"Medium"`) against `layer`'s `"b"`, which is
  fixed server-side, but the client should still compare on the wire spelling only.
- `canPublishAudio` / `canPublishVideo` from the connection reply drive the microphone and camera
  buttons, replacing locally computed permission.
- `503 voiceNotConfigured` hides voice rather than erroring. A self-hosted install with no SFU is a
  supported state, not a fault. **There is no capability read today** - probe once on first join
  attempt and cache the answer for the session. A gateway-level capability endpoint is possible and
  is the better answer; see §6.7 for why it is not a dependency of this work.
- Guide §4.3: a SignalR blip must not tear down media, and a heartbeat goes out on reconnect rather
  than at the next 30s tick. Audit this against `project_voice_liveness_backgrounded`, where the hub
  ping was the first domino.

### Phase 4 - subscription sets (§6)

- `autoSubscribe: false` on both transports.
- Consume the reply from `POST .../voice/subscriptions`, currently typed `unknown` and discarded in
  both HTTP services.
- **Split `tracks[]` by kind ourselves.** Sets are keyed by user id, not by identity - there is no
  way to address one connection and no need for one. `audio` and `screenAudio` go to the Rust room,
  `video` and `screen` to the webview.
- Apply a set by diffing, never by rebuilding: subscribe what is new, close what is gone.
- Map `layer` to quality per §2.5.
- Ignore any payload whose `revision` is below one already applied.
- Report the rest of §6.4, which is declared but unwired today: `paused` on `visibilitychange`,
  `pausedPublishers` for collapsed tiles, `screenAudioShares` when a user unmutes a share, `pinned`.
  `tileHeights` already works.
- §6.5: confirm voice-activity hysteresis before `SpeakingChanged` leaves the client. It is the sole
  input to ranking, and an undebounced cough costs every subscriber a resubscription. Check
  `voice/gate.rs` and `voice-activity.service.ts`.

**Reporting tile state from the webview is safe even though it also governs audio**, and structurally
so rather than by convention: audio entries are constructed with `layer: null` unconditionally, and
every tile-derived input (`tileHeights`, `pausedPublishers`, `paused`) is read only on the video
path. A collapsed tile stops paying for pixels, not sound; a backgrounded client keeps hearing the
room. Guide §6.2a.

---

## 4. What does not change

Listed because the temptation during a migration is to touch it.

- `VoiceRoomTracker` and the three version subtleties. Correct as written; only the relay list grows.
- `voice.Heartbeat(roomKind, roomId, state)` and `VoiceHeartbeatState`.
- Snapshot DTOs, `describeTrack`, and the screen-audio-before-screen prefix ordering.
- join / leave / snapshot / watch / unwatch / viewers routes.
- `TILE_REPORT_DEBOUNCE_MS` and the tile measurement logic.
- The self-preview path: `FramePump::emit_local_stream`, the 9-byte header, `local-stream-framing.ts`.
  It taps the encoder, not the transport.
- Every Isle service and the Cloudflare dialect they speak.

---

## 5. Risks

| Risk | Handling |
|---|---|
| webrtc-rs and LiveKit disagree on SDP | Phase 0 exists for this and gates everything after it |
| Signal protocol version drift | We pin `protocol=N` and own the tail. Vendoring makes the surface visible rather than hidden |
| Rewritten e2e tests pass without proving anything | `project_media_e2e_test_traps`: mutate the guard first |
| Both stacks in one binary | Deliberate. Isle keeps webrtc-rs; nothing is removed from Cargo.toml |
| No pre-join signal for `voiceNotConfigured` | Probe once and cache. A capability read may land later and is additive |

---

## 6. Resolved with the backend, 2026-08-16

Recorded because several of these contradict what the guide said when this design was written, and
the guide has since been corrected.

1. **Rid vocabulary.** §6.7's `a`/`b`/`c` instruction was pure Cloudflare - the same string went on
   the wire as `preferredRid` and asciibetical was their only ordering vocabulary, so the alphabet
   had to run best-to-worst. Publish `f`/`h`/`q`. `layer` is a ranking vocabulary of the server's,
   not a rid; the letters were kept rather than renamed to high/medium/low because renaming costs
   every client at once and an unrecognised spelling already falls back to the server's choice.
2. **Subscription sets are keyed by user id**, not identity. `SetSubscriberAsync` takes the
   authenticated user. Split by kind client-side. Tile inputs cannot reach audio (§6.2a).
3. **Resume with the cached URL and token.** Rooms never move nodes. Token TTL is 10 minutes; refetch
   only on auth refusal or a gap past it.
4. **Identity is the bare user id**, `{userId}#{tag}` for secondary. Split on the first `#`.
5. **`tag` is free-form**, stripped to letters and digits, truncated to 32, falling back to `alt`.
6. **`maxLayer`** was emitting the enum name against `layer`'s wire spelling; fixed server-side.
7. **No capability read for `voiceNotConfigured`.** The natural home is the gateway, which already
   carries `LiveKitOptions` - but whether the gateway pod receives the `LIVEKIT_*` env vars is
   confirmed only for `deploy/compose.yaml`, not the k8s manifests. Until that is checked, a missing
   var would have the endpoint report "not configured" while voice works, which is worse than
   probing. Probe-and-cache now; adopt the endpoint if it lands.

---

## 7. Phase 0 findings, 2026-08-16

**Every exit criterion is green. The design stands and Phase 1 proceeds as written.**

Measured against `livekit-server 1.13.5 --dev` on Windows, with `webrtc-rs` 0.14 driving both peer
connections. Reproduce with `cargo test --manifest-path src-tauri/Cargo.toml --lib media::livekit
-- --ignored --nocapture`, having started the server per `docker/livekit-dev/compose.yaml`.

| Question | Answer | Evidence |
|---|---|---|
| Opus negotiated? | **Yes** | Publish accepted (`TR_AM…`), 65 packets written in 2 s, publisher `connected`, and a second client pulled 156 RTP packets off it |
| H.264 negotiated? | **Yes** | Answer carries `packetization-mode=1;profile-level-id=42e01f` - Constrained Baseline 3.1, exactly what `encoder_mf` emits. `42001f` and `640032` also offered |
| Three simulcast layers? | **Yes** | 3 `a=rid:` in the offer, 3 in the answer, and `a=simulcast:recv f;h;q` |
| Congestion control? | **Yes** | 10 `transport-cc` and 20 `nack` lines in the answer |

Two things worth carrying forward:

- **`single_peer_connection` is available**: `is_single_pc_mode_active()` returns **true** when
  asked for, on 1.13.5. The reading of `false` in the join test only means `connect_options()` does
  not ask. This would collapse §2.3's publisher/subscriber split to one connection, but **Phase 1
  should not assume it** until the production SFU's version is known - the two-connection path works
  on every version. Confirm against `sfu-fsn1.venta.gg` before taking it.
- **`TrackPublishedResponse` can arrive before the `Answer`.** A caller that reads the remote
  description straight after publishing finds nothing there. `Probe::wait_until_connected` exists
  for this, and Phase 1's engine needs the same explicit wait - it is not a probe artefact.

`subscriber_primary` is **true** and `JoinResponse.ice_servers` carries **1** entry, so the ICE
configuration genuinely comes from the join rather than from us.

Not covered, deliberately: reconnect and resume (§2.4), and whether a served layer follows a
viewer's reported tile size. The first is Phase 1 work; the second needs a real viewer and is a
server behaviour rather than a compatibility question.

---
