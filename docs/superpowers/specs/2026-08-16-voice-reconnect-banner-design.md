# Voice reconnect banner, and the ghost seat that outlives a force quit

Date: 2026-08-16
Repos: `Alpine` (client), `Echo` (backend, `C:\Users\Domin\RiderProjects\Echo`)

## The symptom

Alt-F4 (or a crash) while in a voice channel leaves the user on the channel roster. That much is
expected: the seat is released by the eviction sweep, not by the socket closing. What is not
expected is that reopening the app leaves the user visibly "shadow connected" for minutes, and that
only a reload clears it.

## Two independent causes

### 1. The client receives the eviction event and discards it

`VoiceHeartbeatCleanupService.EvictStaleParticipantsAsync` announces an eviction three ways: a
`roomGone` resync addressed to the evicted user, a `Resync{participantsEvicted}` to the survivors,
and `guild.voice.UserLeftVoice` to every member of the guild - the evicted user included.

That last one arrives. `voice-channel.service.ts` throws it away:

```ts
private applyUserLeftVoice(e: WsUserLeftVoice): void {
    const ownId = this.profileService.ownProfile()?.userId ?? '';
    if (e.userId === ownId) return;
```

The guard is correct while the client is genuinely in the channel: the local row is rebuilt from
`localState()` on every snapshot, because mute, camera and screen share are decided here and the
server's copy lags a round trip. It is wrong for the one case where the event is not about a room
this client is in.

Nothing else corrects it. The sidebar roster's only other writer is `loadVoiceStatesForGuild`,
which is gated on `lastLoadedGuildId` and therefore runs once per guild switch. So the ghost row
survives until the user reloads or leaves the guild and comes back. That is the "five minutes".

### 2. Reconnecting rescues the seat the disconnect was about to release

`GuildLifecycleHandler.RestoreVoiceLivenessAsync` re-arms `VoiceReconciler.LivenessKey(userId)` to a
full `LivenessTtl` (90s) on `UserConnected`, on the strength of two facts: a channel pointer that
survives four hours, and a device id that matches because it is the same machine.

The intent is sound - a transport blip must not cost a seat - but the premise fails after a force
quit. The new process has no voice session, is not posting `/alive`, and has no intention of
resuming. It still rescues the ghost for another full TTL, so eviction lands up to 90s + 60s of
sweep *after* the app reopened, and any further hub reconnect during startup re-arms it again.

Constants as they actually are today: `LivenessTtl` 90s, `DisconnectGraceTtl` 75s, sweep interval
60s, `IdleRoomGrace` 60s.

## What we are building

A green banner on launch: *"You were connected to a voice channel, do you want to reconnect?"*
Reconnect rejoins through the ordinary authorised path. Dismiss sends a real leave, which releases
the seat immediately instead of waiting out the sweep - so the banner is the fix for the stale
presence, not merely a prompt about it.

## Design

### A. Backend contract

Guild voice and calls live in separate services behind the YARP gateway
(`Echo/Proxy/ProxyConfig.cs`), so one unified route would mean a cross-service call. Two reads
instead, fired in parallel by the client, each answering `204` when there is nothing:

**`GET /api/v1/guild/voice/state`** (service route `api/v1/voice/state`, new
`GuildVoiceStateController` in `Guild.Application`). Reads the `voice:user:{userId}` pointer that
already exists, then re-validates it against the room roster. Returns
`{guildId, channelId, channelName, deviceId, joinedAt}` or `204`.

**`GET /api/v1/messaging/voice/call/active`** (service route `api/v1/voice` + `call/active`, added
to the existing `VoiceController`). Follows `GetPendingCall` exactly, including its rule that the
index is a hint and the aggregate is the authority. Needs a per-user index - `ActiveCallKey(userId)`
- written where a participant becomes connected, since the ring index only covers `Pending`.
Returns `{callId, conversationId}` or `204`.

Both are pure reads. Neither touches liveness, and neither re-admits anybody.

**The pointer must be validated, not trusted.** `voice:user:{userId}` outlives the roster by design
(four-hour sliding expiry against a room that may have been reaped), so returning it unchecked would
offer a banner for a seat that does not exist. The check is "is this user actually on the roster of
that room right now", and a miss answers `204`.

### B. Backend behaviour fix

`RestoreVoiceLivenessAsync` stops writing a full `LivenessTtl` and restores only the remaining
grace. A client that really is resuming re-arms the full TTL through the path that already does
that - its next `/alive` assertion, or the hub heartbeat - so nothing is lost for a genuine blip,
and a reconnect that is not resuming can no longer extend the ghost past the window the disconnect
opened.

Because the grace is a TTL rather than a timestamp, "remaining" is not directly readable from the
key once it has expired. The restore therefore writes `DisconnectGraceTtl` only when the liveness
key is still present, and writes nothing when it is already gone - an absent key means the grace has
run out and the sweep is entitled to take the seat.

### C. Client startup and the banner

`VoiceResumeService` performs both reads once the session is ready and exposes the result as a
signal. It runs once per app start, not per reconnect: this is a launch question, and re-asking it
on every transport blip would offer to rejoin a room the user is already in.

`VoiceResumeBannerComponent` renders in `main-page`, beside the existing
`account-deletion-banner`. Two actions:

- **Reconnect** goes through `VoiceChannelService.joinChannel` / `VoiceService.acceptCall` - the
  ordinary authorised path. Never a silent re-admit: re-admitting on the strength of the client's
  own claim is exactly what the server refuses to do, and would readmit someone since kicked,
  banned, or denied Connect.
- **Dismiss** POSTs the real `leave` (`guildVoice.leave` or `voice.leaveCall`), releasing the seat
  now.

The banner is suppressed when the client is already in a voice channel, which covers the case where
a second window or another device is live.

### D. The self-event fix

`applyUserLeftVoice` honours a self-addressed leave only when the channel is not the one this client
is joined to:

```ts
if (e.userId === ownId && e.channelId === this.joinedChannelId()) return;
```

While genuinely joined, the existing guard stands: `roomGone` owns that teardown, and a sweep race
must not strip the local row out from under live media. The same reasoning does not apply to
`applyUserJoinedVoice`, which is left alone - a self-join for a channel we are not in would paint a
row for a session we do not have.

### E. Testing

Backend:
- A non-resuming reconnect does not extend eviction past the disconnect grace.
- A reconnect while the grace key is still present keeps the seat.
- Both new endpoints answer `204` for a stale pointer with no roster entry, rather than a phantom
  banner.
- The active-call index is written on connect and re-validated against the aggregate on read.

Client:
- A self-addressed `UserLeftVoice` clears the sidebar row when not joined, and does not when joined.
- Dismiss sends the leave request for both room kinds.
- The banner stays hidden when the startup reads answer `204`.

Locale strings go in the locales submodule as their own commit.

## Known limitation

If the sweep has already run by the time the app relaunches, the server correctly reports no seat
and no banner appears. That is the right answer - there is nothing to offer back - but it means the
feature is invisible on slow restarts, which is also the case where the user is least likely to want
it. We are not faking a banner from local state to cover it: a banner offering a room the server has
no record of would be an offer the rejoin path then refuses.
