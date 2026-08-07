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

## Outstanding on the client

- **Screen-share audio is not published.** `screen-audio-{shareId}` is handled on receive for guild
  channels, but the Rust screen publisher is video-only, so nothing produces the track. The DM
  receive path skips it explicitly rather than mis-subscribing it as video.
- **`call-webrtc.service.ts:subscribeToTrack` drops silently when `voiceSession` is null.** The
  post-connect snapshot refetch narrows the window, but a live announcement arriving inside it is
  still lost until the next snapshot. The guild path solved this with `awaitSession()`; port it.
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
