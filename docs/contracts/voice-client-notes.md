# Voice: client-side notes on the unified contract

Companion to Echo's `docs/specs/voice-frontend-guide.md`, from the client that implements it. The
guide is the contract; this records what the client does about the parts that are easy to get wrong,
and what is still outstanding on our side.

**Status as of 2026-08-07:** implemented on both room kinds, guild and DM. Backend at Echo
`075c096`; client in Alpine `95f50a7` and the commit that follows it.

---

## Where the implementation lives

| Concern | File |
|---|---|
| Snapshot DTOs, track naming, `VoiceRoomTracker` | `src/app/models/voice-room.ts` |
| Guild room state, gating, backfill, heartbeat | `src/app/services/voice-channel.service.ts` |
| DM room state, same | `src/app/services/call-webrtc.service.ts` |
| HTTP surfaces | `guild-voice.service.ts`, `voice.service.ts` |
| SignalR surfaces | `guild-websocket.service.ts`, `voice-websocket.service.ts` |
| Rust publisher signalling | `src-tauri/src/media/publisher/signalling.rs` |
| Screen-share audio capture and encode | `src-tauri/src/media/publisher/audio.rs` |

---

## Four things that bite, and what we do

**1. The join snapshot lands before the transport exists.** Its `shares[]` cannot be subscribed to —
there is no peer connection yet — so screen shares in it go on the floor. Both paths refetch
`GET .../snapshot` after connect and subscribe from *that* copy. This is now §3 step 4 in the guide.

**2. Relay events must not advance the version.** `SpeakingChanged` and `CameraChanged` carry the
current version without representing a change to it. Advancing on one lets it stand in for a state
event we actually missed, and the next real event then looks contiguous — the dropped event becomes
permanent, which is precisely what the version mechanism exists to prevent. `VoiceRoomTracker` has a
separate `receiveRelay` that applies without advancing and without gap detection (speaking is
written ten times a second; gap-detecting on it would refetch at that rate).

**3. Equal versions are not duplicates.** One mutation can emit several events — a screen share with
audio is two `TrackPublished` at one version. Treating equality as a duplicate makes every share
arrive silent. Our handlers are idempotent by construction, which is what makes applying equality
safe.

**4. Gateway prefix.** The guide's paths are service-internal. We call
`/api/v1/guild/guilds/…` and `/api/v1/messaging/voice/…`. `signalling.rs` has a test pinning each
root for the same reason.

---

## Stale subscriptions (incident VNT-GE21R3P7)

A publisher that stopped a share without closing its tracks left it on the roster, so watchers did
the right thing — read the snapshot, subscribed to `shares[]` — and got a 502 six seconds later.
Retried every 5–6 seconds, that put voice on the status page.

The server now removes the share on `ScreenShareStopped` and answers
`409 {"error":"staleSubscription","action":"refetchSnapshot"}` immediately. On this client:

- **`isStaleSubscription` (`models/voice-room.ts`) is the only place that decides.** It matches both
  shapes: an `HttpErrorResponse` from the webview's own calls, and the marker string the Rust engine
  returns for subscribes it made on our behalf. Rust tags it via `signalling::STALE_SUBSCRIPTION`
  rather than by message text, so rewording an error cannot quietly turn the stale path back into a
  retry loop.
- **409 never retries.** The track is gone, not late, so the identical body can only fail again.
  Both paths refetch the snapshot and reconcile; the refetch is guarded, so a burst of refusals
  costs one read.
- **Guards are released on failure, always.** Nothing is recorded as subscribed until the round trip
  succeeds. A guard left consumed by a failure is the single most common way a transient error
  becomes permanent silence.
- **`SUBSCRIBE_RETRY_DELAYS_MS` is exponential from 1s**, for genuine transport failures only.

## Isle is the one place still speaking Cloudflare

Isle proximity voice drives `CloudflareService` directly, has no room model, and was deliberately
left on the old surface. So the Rust `Signalling` type speaks **two dialects**, and the difference is
not incidental:

| | Guild / call | Isle |
|---|---|---|
| Session field | `mediaSessionId` | `cfSessionId` |
| Track direction | `direction: publish\|subscribe` | `location: local\|remote` |
| Source of a pulled track | `mediaSessionId` | `sessionId` |
| Publish / subscribe | `POST .../tracks` | `POST .../cf/tracks/new` |
| Renegotiate | `PUT .../negotiate` | `PUT .../cf/renegotiate` |
| Close | `POST .../tracks/close` | `PUT .../cf/tracks/close` |

Note the close changes **verb** as well as path. `Dialect` in `signalling.rs` is the only thing that
knows which, and both are pinned by tests.

On the TypeScript side the three `isle-*.service.ts` files keep the Cloudflare shape for the same
reason; nothing else does.

---

## Screen-share audio

Published from Rust since `7317490`. `media/audio.rs` exposes a `LoopbackSink` so captured system
audio reaches Rust as PCM instead of only the webview as base64; `publisher/audio.rs` frames it at
20 ms and Opus-encodes it; `publisher/rtc.rs` publishes it as a second track in the **same**
`tracks/new` as the video.

Things worth knowing before changing it:

- **Capture starts before the publication.** A machine with no usable loopback device publishes a
  video-only share rather than announcing a track that will never carry anything — viewers read
  `shares[].trackNames`, and a silent announced track is worse than none. `PublishResult` reports
  what was published, not what was asked for; drive the UI from that.
- **`VoiceEncoder::for_shared_media`**, not the voice configuration. `Application::Audio` because
  VoIP mode sounds hollow on anything that is not a voice; DTX off because it decides "silence" from
  a speech model and clips quiet passages; FEC off because those bits are better spent on the band.
- **Mute stops packets, not the device.** Restarting a WASAPI client is audible as a gap on unmute.
  Audio captured while muted is dropped rather than buffered — replaying it seconds late is worse.
- **DM screen share is still the webview path**, which has always published its own audio via
  `getDisplayMedia`. Only the guild path uses the Rust publisher today.

## Outstanding on the client

- **DM receive skips `screenAudio`.** `call-webrtc.service.ts` explicitly ignores that kind rather
  than mis-subscribing it as video, because the call UI has no per-stream audio control and the
  mixer source would have nothing driving it. Guild receive handles it.
- **Isle is not on the room contract** and will stay a third implementation until someone decides
  otherwise.

---

## Feedback that was raised and resolved

Recorded because the reasoning is worth keeping, not because anything is outstanding. All of this
landed in the guide or the backend on 2026-08-07:

- §4.2's rule discarded batched and relay events; it now spells out all three subtleties.
- `Resync` was not documented as ungated, though `roomGone` carries `instanceId: ""` and `version: 0`.
- §9's paths omitted the gateway prefix; there is now a note.
- The join-snapshot ordering trap was undocumented; it is now §3 step 4.
- `Snapshot`'s payload shape exception (bare snapshot, `roomId`, no room-id field) is now called out.
- `ScreenShareStarted` accepted a `trackName` it discarded; the argument is gone from both the hub
  command and our invocations.
- The liveness sweep now covers calls as well as channels, so our DM heartbeat is load-bearing.
