# Multi-Device Calls & Voice Channels - Design

## Background

The backend has published a client spec (see conversation / `Multi-Device Calls & Voice
Channels — Client Spec`) introducing a per-device identifier so the server can tell which
device a user is acting from for calls and guild voice channels. This fixes two bugs:

1. **Calls**: accepting on one device and declining on another (both ringing) currently ends
   the whole call instead of just dismissing the stale ring.
2. **Guild voice**: joining the same channel from a second device doesn't kick the first -
   both fight over the same media session and the first device's audio silently breaks.

It also changes call-leave semantics: leaving a group call no longer ends it for everyone -
only `end` does that. Dropping to one connected participant starts a 5-minute grace period
before the server force-ends the call.

**Status of the backend**: not yet implemented. Endpoints/events described here don't exist
server-side yet. Per user decision, the client implements the full contract now (new calls
will fail/new events simply won't fire until the backend ships) rather than gating behind a
feature flag - client and backend are expected to ship in the same window regardless, since
the bugs only reproduce cross-version.

## Current architecture (relevant pieces)

- **Realtime hub**: `RealtimeConnectionService` (`src/app/services/realtime-connection.service.ts`)
  owns the single SignalR connection (`/api/v1/ws/hub`), built synchronously in its
  constructor. Per-domain wrapper services (`VoiceWebsocketService`, `GuildWebsocketService`,
  `MessagingWebsocketService`) call `.on()`/`.invoke()` on it and re-expose typed RxJS Subjects.
- **Device identity**: `MlsService.getOrCreateDeviceIdentifier()`
  (`src/app/services/mls.service.ts:565`) already generates/persists a stable UUID (Tauri
  `LazyStore`) for MLS/E2E purposes. The spec requires reusing this exact ID for calls/voice -
  no new identifier.
- **HTTP requests**: no shared wrapper; every service injects `HttpClient` directly. Centralized
  header injection happens via the functional interceptor chain in `app.config.ts:48`
  (`tokenInterceptor`, `timeoutInterceptor`).
- **Calls**: `VoiceService` (HTTP: create/accept/decline/end/get), `VoiceWebsocketService`
  (SignalR events), `CallStateService` (ringing state machine: incoming/outgoing),
  `CallSessionService` (active-session UI state), `CallWebRtcService` (WebRTC plumbing, also
  subscribes to WS events and calls back into `CallSessionService`). `call.CallAccepted` and
  `call.CallDeclined` are not currently subscribed to anywhere client-side - today's client
  relies entirely on `call.CallEnded` for all termination cases.
- **Guild voice**: `GuildVoiceService` (HTTP), `GuildWebsocketService` (SignalR events),
  `VoiceChannelService` (orchestrator, owns join/leave). `VoiceChannelService.doLeave(guildId,
  channelId, silent)` already has exactly the primitive needed for a server-driven teardown:
  `silent: true` skips calling the leave HTTP endpoint.

## Goals

- Reuse the existing MLS device ID as the call/voice device identifier everywhere the spec
  requires it.
- Fix the two multi-device bugs described above, matching the documented event contract
  exactly (event names, payload shapes, endpoint paths).
- Change the call hang-up action to "leave" semantics (removes only the local user) instead of
  "end for everyone", matching the spec's new leave/end split.
- Surface the new device-takeover and alone-timeout states with minimal, appropriately-scoped
  UI (toasts + an inline countdown), reusing existing UI surfaces rather than building new ones.

## Non-goals

- No new "End call for everyone" UI action. The app has exactly one hang-up button today and no
  concept of a call host/owner action; the spec explicitly says `end` is only needed "if your
  UI has one". Out of scope.
- No per-invitee decline tracking for group DM calls (`call.CallDeclined` granularity, i.e.
  showing "Alice declined, still waiting on Bob"). `call.CallDeclined` is marked "unchanged" in
  the spec (not new), the current client already doesn't handle it, and it's not on the
  checklist in section 6 of the spec. Pre-existing gap, unrelated to the device-id fix.
- No changes to `CallDto`/`CallParticipant` response shapes - the spec states accept/decline/
  leave/end response shapes are unchanged.
- No change to the cross-guild voice cleanup behavior in section 5.1 (leaving a stale channel in
  another guild) - that's a backend-only generalization; the client already only tracks one
  joined channel at a time.

## 1. Device ID plumbing

### HTTP header (`X-Device-Id`)

New functional interceptor `src/app/interceptors/device-id-interceptor.ts`, registered in
`app.config.ts` alongside `tokenInterceptor`/`timeoutInterceptor`. It adds `X-Device-Id` to
every request bound for the configured API base (mirrors `tokenInterceptor`'s
`request.url.startsWith(currentBase)` guard, placed after `tokenInterceptor` in the chain so
the self-hosted base-URL rewrite has already happened).

```ts
let deviceIdPromise: Promise<string> | null = null;

export const deviceIdInterceptor: HttpInterceptorFn = (req, next) => {
    const apiConfig = inject(ApiConfigService);
    if (!req.url.startsWith(apiConfig.baseUrl())) return next(req);

    const mlsService = inject(MlsService);
    if (!deviceIdPromise) deviceIdPromise = mlsService.getOrCreateDeviceIdentifier();

    return from(deviceIdPromise).pipe(
        switchMap(deviceId => next(req.clone({setHeaders: {'X-Device-Id': deviceId}}))),
    );
};
```

The module-level cache (same pattern as `isRefreshing`/`refreshPromise` in
`token-interceptor.ts`) avoids hitting the Tauri store on every request - the device id is
resolved once per app session. Sending the header on endpoints that don't strictly need it yet
is harmless (the spec says the server treats a missing header as an implicit `default` device;
an unrecognized-but-present header on other endpoints is likewise ignored).

### Hub connection query param

`RealtimeConnectionService` currently builds its `HubConnection` synchronously in the
constructor, but the URL must now include an async-resolved `deviceId`. Since `.on()` is
documented and relied upon as "safe to call before `start()`" by every consuming service,
construction becomes lazy:

- `hubConnection` becomes `private hubConnection: signalR.HubConnection | null = null`.
- `.on()`/`.off()` queue `{event, handler}` pairs in a local array when `hubConnection` is null,
  and call directly once it exists.
- `.start()` resolves the device id (`MlsService.getOrCreateDeviceIdentifier()`, falling back to
  no query param if it throws, so a resolution failure can't break connectivity entirely),
  builds the `HubConnection` with `.../ws/hub?deviceId=...`, wires the existing
  `onreconnecting`/`onreconnected`/`onclose` lifecycle handlers, replays any queued `.on()`
  registrations, then calls `hubConnection.start()`.
- `.invoke()` no-ops if `hubConnection` is null or not connected (same guard as today, just
  null-checked first).

Public API (`on`, `off`, `invoke`, `start`, `connectionState`) is unchanged, so
`MessagingWebsocketService`, `VoiceWebsocketService`, `GuildWebsocketService`,
`IsleVoiceWebsocketService` need no changes.

## 2. Calls

### New endpoint

`VoiceService` gains:

```ts
leaveCall(callId: string): Observable<CallDto> {
    return this.client.put<CallDto>(`${this.base}/call/${callId}/leave`, {});
}
```

### Leave vs. end

`CallSessionService.end()` gains a `silent` parameter:

```ts
end(silent = false): void {
    const s = this.session();
    if (!s) return;
    s.participants.find(p => p.isLocal)?.videoStream?.getTracks().forEach(t => t.stop());
    s.screenShares.find(sh => sh.isLocal)?.stream?.getTracks().forEach(t => t.stop());
    if (!silent) this.voiceService.leaveCall(s.callId).subscribe();
    this.session.set(null);
    this.aloneDeadline.set(null);
}
```

`silent: true` is used when the server has already torn down the call/session on its own
(device takeover, or we're reacting to an already-delivered `CallEnded`) - calling `leave`
again in that case would be a pointless, possibly-erroring network call.

Call sites:
- `call-panel.component.ts`'s `endCall()` keeps calling `this.callSession.end()` (default
  `silent = false`) - this is the only hang-up affordance in the UI today, so it now correctly
  means "leave" rather than "end for everyone", fixing bug #1 without any new UI.
- `CallStateService.cancelOutgoing()` switches its direct `this.voiceService.endCall(...)` call
  to `this.voiceService.leaveCall(...)` - canceling your own outgoing call before anyone
  answers is "the only connected participant leaves", which the new contract models as `leave`
  (dropping to zero connected participants ends the call immediately with
  `AllParticipantsLeft`), not an explicit `end`.
- `VoiceService.endCall()` (existing) is left in place, unused by any UI action for now, per
  the non-goal above.

### New WS events

`VoiceWebsocketService` (`src/app/services/voice-websocket.service.ts`) gains:

```ts
export interface WsCallAccepted { callId: string; deviceId: string; }
export interface WsCallDeviceDismissed { callId: string; deviceId: string; }
export interface WsCallDeviceTakeover { callId: string; oldDeviceId: string; newDeviceId: string; }
export interface WsCallParticipantLeft { callId: string; userId: string; }
export interface WsCallAlone { callId: string; userId: string; deadline: string; }
```

`WsCallEnded` gains `reason?: 'Declined' | 'UserEnded' | 'AllParticipantsLeft' | 'AloneTimeout'`.

New observables + `realtime.on(...)` registrations, following the existing pattern exactly:
`callAcceptedObservable` (`call.CallAccepted`), `callDeviceDismissedObservable`
(`call.CallDeviceDismissed`), `callDeviceTakeoverObservable` (`call.CallDeviceTakeover`),
`callParticipantLeftObservable` (`call.CallParticipantLeft`), `callAloneObservable`
(`call.CallAlone`).

A small pure helper is added next to `WsCallEnded` for reason → copy:

```ts
export function describeCallEndedReason(reason?: string): string {
    switch (reason) {
        case 'Declined': return 'Call declined';
        case 'AloneTimeout': return 'Call ended - no one rejoined';
        default: return 'Call ended';
    }
}
```

### Wiring - `CallStateService` (owns ringing UI)

Three new subscriptions, following the existing `incomingEndedSub` pattern:

```ts
// Another of my devices accepted -dismiss this device's ring, same as a cancelled ring.
this.ws.callAcceptedObservable.subscribe(({callId}) => this.dismissIncomingIfMatches(callId));

// I declined here after already accepting elsewhere -dismiss silently, not "call ended".
this.ws.callDeviceDismissedObservable.subscribe(({callId}) => this.dismissIncomingIfMatches(callId));

// I accepted on another device while connected here -tear down, don't call leave myself.
this.ws.callDeviceTakeoverObservable.subscribe(({callId}) => {
    if (this.callSession.session()?.callId !== callId) return;
    this.callSession.end(true);
    this.toast.info('You joined this call on another device');
});
```

`dismissIncomingIfMatches` factors out the existing body of `incomingEndedSub`'s callback
(guard on `incomingCall()?.call.id`, `stopRingtone()`, `incomingCall.set(null)`) since it's now
shared by three subscriptions instead of one.

### Wiring - `CallWebRtcService` (owns the active session)

```ts
// New: application-level participant-left, alongside the existing WebRTC-level ParticipantLeft.
this.voiceWs.callParticipantLeftObservable.subscribe(e => {
    this.callSession.onParticipantLeft(e.userId);
    this.subscribedAudioUserIds.delete(e.userId);
    this.participantsWithAudio.update(s => { const n = new Set(s); n.delete(e.userId); return n; }),
}),

this.voiceWs.callAloneObservable.subscribe(e => {
    if (e.callId !== this.callId) return;
    this.callSession.setAloneDeadline(new Date(e.deadline));
}),
```

The existing `callEndedObservable` subscriber (line 932) changes from an unconditional
`this.callSession.end()` to:

```ts
this.voiceWs.callEndedObservable.subscribe(e => {
    const wasActive = !!this.callSession.session();
    this.callSession.end(true); // server has already ended it -no need to call leave
    if (wasActive) this.toast.info(describeCallEndedReason(e.reason));
}),
```

`wasActive` is what keeps this silent for a self-initiated hangup: clicking the hang-up button
already calls `callSession.end()` synchronously, nulling `session()` before any `CallEnded`
broadcast can arrive, so this toast only fires when the call ended for a reason the local user
didn't just cause (someone else left/declined, `end` was called elsewhere, or the alone-timeout
fired) - matching today's silent self-hangup UX exactly.

`call.CallParticipantLeft` is handled identically to (and independently of) the existing
`call.ParticipantLeft` rather than replacing it - `onParticipantLeft` is idempotent (array
filter), so both firing for the same departure is harmless, and there's no way to know from the
client side whether the backend will keep both events or only the new one once implemented.

### `CallSessionService` additions

```ts
readonly aloneDeadline = signal<Date | null>(null);

setAloneDeadline(deadline: Date | null): void {
    this.aloneDeadline.set(deadline);
}
```

Cleared in `end()` (above) and whenever the participant list grows back past 1 in
`onParticipantJoined`:

```ts
onParticipantJoined(userId: string): void {
    // ...existing body...
    this.session.update(st => st ? {...st, participants: [...st.participants, participant]} : st);
    if ((this.session()?.participants.length ?? 0) > 1) this.aloneDeadline.set(null);
}
```

### UI

`call-panel.component.ts`/`.html` reads `callSession.aloneDeadline` and, when set, shows a
small inline countdown notice next to the existing call controls (e.g. "Waiting for others to
rejoin - call ends at HH:MM"), per your earlier decision to reuse the existing panel rather than
build a new banner component. No changes to `call-overlay.component` needed - device
dismiss/takeover only affect ringing/active state that overlay/panel already react to via
existing signals.

## 3. Guild voice channels

### New WS event

`GuildWebsocketService` (`src/app/services/guild-websocket.service.ts`) gains:

```ts
export interface WsKickedByOtherDevice { channelId: string; guildId: string; }
public kickedByOtherDeviceObservable = new Subject<WsKickedByOtherDevice>();
// in setupListeners():
this.realtime.on('guild.voice.KickedByOtherDevice', (d: WsKickedByOtherDevice) => this.kickedByOtherDeviceObservable.next(d));
```

### Wiring - `VoiceChannelService`

```ts
this.guildWsSvc.kickedByOtherDeviceObservable.subscribe(e => void this.onKickedByOtherDevice(e));
```

```ts
private async onKickedByOtherDevice(e: WsKickedByOtherDevice): Promise<void> {
    if (e.channelId !== this.joinedChannelId()) return;
    const guildId = this.joinedGuildId();
    if (!guildId) return;
    await this.doLeave(guildId, e.channelId, true); // silent: server already removed us
    this.joinedChannelId.set(null);
    this.joinedGuildId.set(null);
    this.joinedChannelName.set(null);
    this.joinedGuildName.set(null);
    this.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false});
    this.toast.info('You joined this channel from another device');
}
```

This mirrors the body of the existing `leaveChannel()` almost exactly, with `silent: true`
(skips the HTTP leave call - the server already removed this device) in place of `false`, plus
the toast. `ToastService` is newly injected into `VoiceChannelService`.

No join-flow changes are needed beyond the automatic `X-Device-Id` header - the "kick the old
device" and "cross-guild/cross-channel cleanup" behaviors are entirely server-driven; the
client's role is only to react to the resulting event.

## Testing

- Unit tests for `describeCallEndedReason` (pure function, all four reason values + undefined).
- Unit tests for `CallSessionService.end(silent)` - verifies `leaveCall` is/isn't called, and
  that `aloneDeadline` is cleared.
- Unit tests for `CallSessionService.onParticipantJoined` clearing `aloneDeadline` once
  participants exceed 1.
- Unit tests for the new `CallStateService` subscriptions (`CallAccepted`,
  `CallDeviceDismissed`, `CallDeviceTakeover`) using a mock `VoiceWebsocketService`.
- Unit tests for `VoiceChannelService.onKickedByOtherDevice` - verifies `doLeave` is called with
  `silent: true`, state is reset, and it no-ops when the event doesn't match the joined channel.
- Unit test for `deviceIdInterceptor` - verifies the header is set from the (mocked) resolved
  device id and that the module-level cache means `getOrCreateDeviceIdentifier` is only called
  once across multiple requests.
- Manual verification: since the backend doesn't exist yet, these events can't be triggered
  end-to-end. Verification is via unit tests plus manually confirming (a) the hub connects with
  `?deviceId=...` in the URL (dev tools network tab), and (b) `X-Device-Id` appears on the
  relevant REST calls.
