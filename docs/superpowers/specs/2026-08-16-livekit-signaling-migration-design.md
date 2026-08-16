# LiveKit signalling migration

**Status:** design, approved 2026-08-16. Not implemented.

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

- **`livekit-protocol`** (crates.io, Apache-2.0, 0.7.12): every signalling message as a generated
  Rust type - `SignalRequest`, `SignalResponse`, `JoinResponse`, `AddTrackRequest`,
  `TrickleRequest`, `UpdateSubscription`, `SessionDescription`. No libwebrtc dependency.
- **`rtc_engine::signal_client` from livekit/rust-sdks**, vendored under attribution: the WebSocket
  loop, the request queue, ping/pong, and the resume-versus-reconnect state machine. It depends on
  the protocol types and tokio-tungstenite, not on libwebrtc.
- **`webrtc-rs` 0.14, unchanged**, as the media transport it already is.

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

### 2.1 Connections

Desktop goes from three SFU connections to two.

| | Today | After |
|---|---|---|
| Rust voice | primary session: publishes mic, receives + mixes all audio | one LiveKit participant, `primary=true` |
| Rust screen | secondary session: screen video + loopback audio | **same participant as above** |
| Webview | secondary session: receives video, publishes camera | one LiveKit participant, `primary=false&tag=view` |

Merging the two Rust connections is possible because LiveKit publishes many tracks on one
participant, and the two live in the same process. It removes the case
`VoiceShareSnapshot.mediaSessionId` exists for: a share published on a session that is not the
participant's microphone session. That field stays on the wire and stays handled - other clients may
still split - but desktop stops producing it.

Audio and video are split across the two transports, as they are today:

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

---

## 3. Phases

Ordered so the thing that can invalidate the design fails first.

### Phase 0 - prove webrtc-rs against LiveKit's server

A throwaway example binary, not shipped code. It must, against a real LiveKit server:

- connect, join, and stay joined through one ping cycle
- publish Opus from `voice::codec` and have it audible in a `livekit-client` browser tab
- publish H.264 from `encoder_mf` with three simulcast layers and have it render
- subscribe to one remote audio track and pull PCM through `jitter` into the mixer

**Four compatibility questions this answers**, all of which are cheaper to fail now than in Phase 2:

| Question | Why it is in doubt |
|---|---|
| Does LiveKit accept our Opus offer? | `opus_capability()` is mono with `minptime=10;useinbandfec=1`. Expected fine. |
| Does it accept our H.264? | Our encoders emit Constrained Baseline 3.1 (see `project_h264_level_ceiling`). Needs `packetization-mode=1` to match. |
| **Do the rid names work?** | They do not, as written. See below. |
| Does congestion control close the loop? | TWCC/`transport-cc` and NACK/RTX interceptors must be registered on both PCs, or the sender never adapts. |

The rid question is a real finding, not a risk. `LAYER_RIDS` in `publisher/simulcast.rs` and
`VIDEO_LAYER_RIDS` in `webrtc-encoding.ts` are both `a`/`b`/`c`, chosen because Cloudflare's only
rid-ordering vocabulary is `ridNotAvailable: asciibetical`. **LiveKit does not sort rids** - it maps
each rid to a `VideoQuality` through the `layers` list in `AddTrackRequest`, and its own convention
is `f`/`h`/`q`. So the naming loses its reason and needs to follow LiveKit's.

This contradicts guide §6.7, which still tells clients to publish `a`/`b`/`c` and explains the
asciibetical sort. That paragraph describes the old SFU. **Raise it with the backend author before
Phase 1** - if the server is genuinely reading rid names rather than the layer list, the answer
changes.

**Exit:** all four green, or the design falls back to the LiveKit Rust SDK and this document is
rewritten.

### Phase 1 - the Rust room

New `src-tauri/src/media/livekit/`:

| File | Holds |
|---|---|
| `signal.rs` | the vendored signal client, with its Apache-2.0 attribution header |
| `room.rs` | one room: two PCs, participant/track registry, reconnect, ping |
| `publish.rs` | `AddTrackRequest` through to a live sender |
| `subscribe.rs` | `UpdateSubscription`, and incoming track to `RemoteSource` |

Then:

- `voice/rtc.rs` and `publisher/rtc.rs` publish into a shared room instead of owning a PC. Their
  packet-writing halves are unchanged; what goes is `Signalling`, the offer/answer dance and the ICE
  gather timeout.
- `voice/session.rs` holds one room per `VoiceTarget` for guild and call, shared by voice and
  screen. Isle keeps its own `webrtc-rs` publication exactly as it is.
- `publisher/signalling.rs` loses the neutral dialect. `Dialect` collapses, since Isle is the only
  caller left.
- `media/voice/e2e_tests.rs` and `media/publisher/e2e_tests.rs` currently mock HTTP routes
  (`/voice/session`, `/voice/tracks`). They are rewritten against a fake signal server speaking
  protobuf over a WebSocket. Per `project_media_e2e_test_traps`: mutate what each test guards and
  watch it fail before trusting it.

### Phase 2 - the webview and the browser build

- Add `livekit-client`.
- New room wrapper service, one per target, owning connect / reconnect / track events.
- `voice-rtc.service.ts` (1627 lines) and `call-webrtc.service.ts` (1322) keep roster state, gating,
  backfill and heartbeat; their negotiation halves go, along with `webrtc-encoding.ts`.
- `voice-publisher.web.ts` (1014) and `screen-publisher.web.ts` (595) are reimplemented on the SDK
  behind the same ports. The web build gets the SDK for publish and receive both.
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
- `canPublishAudio` / `canPublishVideo` from the connection reply drive the microphone and camera
  buttons, replacing locally computed permission.
- `503 voiceNotConfigured` hides voice rather than erroring. A self-hosted install with no SFU is a
  supported state, not a fault.
- Guide §4.3: a SignalR blip must not tear down media, and a heartbeat goes out on reconnect rather
  than at the next 30s tick. Audit this against `project_voice_liveness_backgrounded`, where the hub
  ping was the first domino.

### Phase 4 - subscription sets (§6)

- `autoSubscribe: false` on both transports.
- Consume the reply from `POST .../voice/subscriptions`, currently typed `unknown` and discarded in
  both HTTP services.
- Apply a set by diffing, never by rebuilding: subscribe what is new, close what is gone. Route
  entries by kind - `audio` and `screenAudio` to the Rust room, `video` and `screen` to the webview.
- Map `layer` to quality: `a`/`b`/`c` in the payload are the server's ranking, so
  `a -> HIGH, b -> MEDIUM, c -> LOW` via `setVideoQuality` on the JS side and `UpdateTrackSettings`
  on the Rust side.
- Ignore any payload whose `revision` is below one already applied.
- Report the rest of §6.4, which is declared but unwired today: `paused` on `visibilitychange`,
  `pausedPublishers` for collapsed tiles, `screenAudioShares` when a user unmutes a share, `pinned`.
  `tileHeights` already works.
- §6.5: confirm voice-activity hysteresis before `SpeakingChanged` leaves the client. It is the sole
  input to ranking, and an undebounced cough costs every subscriber a resubscription. Check
  `voice/gate.rs` and `voice-activity.service.ts`.

**Open question for the backend author:** the set is computed per recipient, but this client
receives over two connections with two identities. Does the server's plan account for both, or does
it assume one? If it assumes one, we either merge the receive transports or tell it which identity
is which.

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
| rid naming contradicts guide §6.7 | Resolve with the backend author before Phase 1 |
| Two receive transports against one subscription plan | Open question above; worst case, one transport |
| Signal protocol version drift | We pin `protocol=N` and own the tail. Vendored client makes the surface visible rather than hidden |
| Rewritten e2e tests pass without proving anything | `project_media_e2e_test_traps`: mutate the guard first |
| Both stacks in one binary | Deliberate. Isle keeps webrtc-rs; nothing is removed from Cargo.toml |
