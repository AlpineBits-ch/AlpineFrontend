# Device Identity Consolidation - Client Design

## Background

The backend has collapsed six unrelated notions of "a user's device" into one registered
**device**, keyed by the `ClientDeviceId` this client already generates for MLS. Push tokens
attach to it, login sessions link to it, and `X-Device-Id` is now validated against it instead
of trusted blindly. Full contract: the *Device Identity Consolidation - Client Guide* supplied
by the backend team (§ references below point at it).

**Backend status**: implemented, **not deployed**. The `ConsolidateDeviceConcepts` migration has
not been applied to production. Endpoints will behave as documented only after deploy.

## Current client state (audited 2026-07-31)

| Piece | State |
|---|---|
| Stable client device id | Exists. `MlsService.getOrCreateDeviceIdentifier()` (`src/app/services/mls.service.ts:565`) - UUID in Tauri `LazyStore` `settings.json`, key `mls_device_id`. |
| Device registration | Exists but conditional. `DeviceService.registerDevice()` is called only from `DeviceRegistrationModalComponent`, which appears only when MLS auto-unlock fails at launch (`main-page.component.ts:278-285`). It is an MLS key-setup flow that happens to register a device. |
| Device list / delete | `DeviceService.getMyDevices()` exists, called nowhere. No delete method. |
| Push token | Legacy. `POST /users/self/device-token` with `{token}` only - no `deviceId`, no `kind` (`user-token.service.ts:30`). |
| `/connect/token` | Sends `username`, `password`, optional `mfa_code`. No `device_id`, `device_name`, `device_type` (`auth.service.ts:32`). |
| QR login start | Sends `{deviceName, deviceType}`. No `clientDeviceId` (`qr-login.service.ts:37`). |
| Sessions UI | `devices-settings.component.ts` lists login sessions. `LoginSessionDto` has no `clientDeviceId`. MLS devices never shown. |
| Sign-out | `logout-dialog.component.ts` wipes local MLS state. No push-token delete, no device deregistration. |

### The blocking gap

**The `X-Device-Id` foundation from `docs/superpowers/plans/2026-07-29-multi-device-calls-voice.md`
was never implemented.** Every checkbox in that plan is unticked and the code agrees:

- No `src/app/interceptors/device-id-interceptor.ts`; the string `X-Device-Id` appears nowhere
  under `src/`.
- `RealtimeConnectionService` connects to `/api/v1/ws/hub` with no `?deviceId=`
  (`realtime-connection.service.ts:37`).
- No `leaveCall`; hang-up still calls `PUT /call/{id}/end` (`voice.service.ts:72`,
  `call-session.service.ts:87`).
- No handlers for `call.CallDeviceDismissed`, `call.CallDeviceTakeover`,
  `guild.voice.KickedByOtherDevice`.

Sections §2, §4.4 and §7 of the backend guide all rest on that foundation. Per user decision,
this design covers **both** the consolidation guide and the unimplemented 2026-07-29 plan, as
one change.

### The split-brain trap

`src-tauri/src/media/publisher/signalling.rs` issues its own `reqwest` calls to
`POST .../session?primary=true` - one of the four endpoints that now validates `X-Device-Id` -
carrying a bearer token and nothing else (`signalling.rs:255-277`).

Today that is harmless: neither the webview nor Rust sends the header, so both land in the
implicit `default` bucket and agree. **The moment the interceptor is added to the webview
alone**, the webview joins as device `X` while Rust opens the *primary* Cloudflare session as
`default`. Two device buckets for one user, with the audio-bearing session on the wrong one -
precisely the condition the device-takeover detection is built to punish. Rust must be updated
in the same change, not a follow-up.

## Goals

- One device identity, sent everywhere the backend now validates or attributes it.
- Adopt every client-facing change in the consolidation guide: push-token consolidation and
  deregistration, `device_id` at token exchange, `clientDeviceId` on QR login, `clientDeviceId`
  in the sessions UI, device deregistration.
- Land the 2026-07-29 multi-device call/voice behaviour that the guide presupposes.
- Recover automatically from the new `400 Unknown X-Device-Id` without destroying MLS state.

## Non-goals

- No "End call for everyone" UI action (carried over from the 2026-07-29 design: the app has one
  hang-up affordance and no host concept).
- No per-invitee decline tracking for group DM calls.
- No changes to `CallDto` / `CallParticipant` response shapes.
- No web-build fallback for the device id. `PlatformService` calls `type()` from
  `@tauri-apps/plugin-os` at construction (`platform.service.ts:8`), so the app is Tauri-only in
  practice; a browser build already fails before any of this.
- Not migrating off `POST /users/self/device-token` conditionally - we move straight to
  `push-token`, since the legacy endpoint is documented as writing to the same store.

## 1. `DeviceIdentityService` - new

The device id currently lives inside `MlsService`, a large service that an HTTP interceptor has
no business pulling in. Six new consumers need the id, so it gets its own home:
`src/app/services/device-identity.service.ts`.

```ts
deviceId(): Promise<string>          // cached in-memory for the app session
reset(): Promise<void>               // drops the persisted id (registration retry path)
ensureRegistered(): Promise<boolean> // idempotent POST /identity/devices; false if it could not
unregister(): Observable<void>       // DELETE /identity/devices/client/{id}
```

`deviceId()` reads and writes **the same** `settings.json` / `mls_device_id` key.
`MlsService.getOrCreateDeviceIdentifier()` and `deleteDeviceIdentifier()` become thin delegates
so there is exactly one implementation. The key must not fork: MLS keychain entries are named
`alpine_mls_{deviceId}_{pub|priv|identity}` (`mls.service.ts:602`), so a second id would orphan
every stored signing key.

### `ensureRegistered()` must not rotate the signing key

It re-registers using the **existing** identity public key, read back from secure storage
(`alpine_mls_{id}_pub`), with a name from `describeCurrentDevice()` - already written and
exported from `qr-login.service.ts:94`.

It must **not** call `MlsService.generateKeyPackages()`. That mints a fresh Ed25519 keypair
(`mls.service.ts:211`), which would silently orphan this device from every MLS group it belongs
to. The distinction is the difference between recovering a deleted device row and destroying the
account's message history on this machine.

If no stored public key exists, `ensureRegistered()` returns `false` rather than inventing one -
the interactive `DeviceRegistrationModalComponent` is the only correct path in that case, and it
already runs at launch.

## 2. `deviceIdInterceptor` + `400` recovery

New functional interceptor `src/app/interceptors/device-id-interceptor.ts`, appended to the
chain in `app.config.ts:48` after `tokenInterceptor` so the self-hosted base-URL rewrite has
already happened. Guarded on `req.url.startsWith(apiConfig.baseUrl())`, mirroring
`tokenInterceptor`.

```ts
export const deviceIdInterceptor: HttpInterceptorFn = (req, next) => {
    const apiConfig = inject(ApiConfigService);
    if (!req.url.startsWith(apiConfig.baseUrl())) return next(req);

    const identity = inject(DeviceIdentityService);
    return from(identity.deviceId()).pipe(
        switchMap(deviceId => next(req.clone({setHeaders: {'X-Device-Id': deviceId}})).pipe(
            catchError(err => isUnknownDeviceId(err)
                ? from(identity.ensureRegistered()).pipe(
                    switchMap(ok => ok
                        ? next(req.clone({setHeaders: {'X-Device-Id': deviceId}}))
                        : throwError(() => err)))
                : throwError(() => err)),
        )),
    );
};
```

`isUnknownDeviceId` matches `status === 400` **and** an error body containing
`Unknown X-Device-Id` - status alone is far too broad to hang a retry on. The retry is a single
`next()` call with no recursion, so a persistently-rejected id fails on the second attempt
rather than looping.

Caching lives in `DeviceIdentityService.deviceId()`, not in a module-level variable, so tests
reset it by re-providing the service instead of reaching for an exported cache-buster.

## 3. Rust parity - `signalling.rs`

`Signalling` gains a `device_id: String` field, applied as an `X-Device-Id` header in both
`send()` (`signalling.rs:255`) and `close_tracks()`, which builds its request separately
(`signalling.rs:221`) and would otherwise be missed.

The id reaches Rust through the two existing Tauri commands, both of which already accept
`api_base` and `token`:

- `voice_start` (`src-tauri/src/media/voice/mod.rs:125`) - opens the **primary** session.
- `start_screen_publish` (`src-tauri/src/media/publisher/mod.rs:65`) - secondary.

TS callers: `voice-engine.service.ts` and `rust-media.service.ts:231`; `ScreenPublishOptions`
(`rust-media.service.ts:21`) and `publishOptions()` (`screen-publish.ts:49`) gain a `deviceId`
field alongside the existing `apiBase` / `token`.

## 4. Hub `?deviceId=`

`RealtimeConnectionService` builds its `HubConnection` synchronously in the constructor
(`realtime-connection.service.ts:36`), but the URL now needs an async value. Construction goes
lazy, per the 2026-07-29 design:

- `hubConnection` becomes nullable.
- `.on()` / `.off()` queue `{event, handler}` pairs while it is null - every consumer relies on
  the documented "safe to call before `start()`" contract - and replay on build.
- `.start()` resolves the device id, builds the connection with `?deviceId=...`, wires the
  existing lifecycle handlers, replays the queue, then starts.
- A device-id resolution failure falls back to **no query param** rather than failing the
  connection: the hub applies no validation (guide §6), so degrading to the `default` bucket
  keeps the app usable.
- `.invoke()` null-checks before its existing connected-state guard.

Public API (`on`, `off`, `invoke`, `start`, `connectionState`) is unchanged, so
`MessagingWebsocketService`, `VoiceWebsocketService`, `GuildWebsocketService` and
`IsleVoiceWebsocketService` need no edits.

## 5. Push tokens

`UserTokenService.ensureTokenRegistered()` moves to `POST /users/self/push-token`:

```json
{"token": "...", "kind": "Fcm" | "ApnsVoip", "deviceId": "..."}
```

`kind` is chosen from `type()` (`@tauri-apps/plugin-os`): `ios` → `ApnsVoip`, everything else →
`Fcm`. That matches what the legacy `device-token` endpoint mapped to, so desktop behaviour is
unchanged.

The registered token is persisted to `settings.json` (`push_token`), because
`DELETE /users/self/push-token?token=…&kind=…` needs the token value and the push plugin cannot
be assumed to return it again after sign-out has begun.

New method `deregisterToken(): Promise<void>`, called from the logout dialog.

## 6. Login and QR

`AuthService.login()` (`auth.service.ts:27`) chains off `deviceId()` and adds `device_id`,
`device_name`, `device_type` to the grant parameters. All three are ignored server-side when
unknown (guide §5.1), so no new error handling - a first login on a fresh install necessarily
precedes registration, and the id links from the next login onward.

`QrLoginService.start()` adds `clientDeviceId` to the `StartQrLoginDto`. `describeCurrentDevice()`
stays a pure function; the service supplies the id.

## 7. Sessions UI

`LoginSessionDto` gains `clientDeviceId: string | null`.

`devices-settings.component.ts` gains:
- A **"This device"** marker on the row whose `clientDeviceId` equals our local id. This is
  strictly better than today's `isCurrent`, which only identifies the token that made the
  request.
- A **"Forget this device"** action on rows carrying a `clientDeviceId`, calling
  `DELETE /identity/devices/client/{id}`.

**Decision:** the sessions list is *not* merged with `GET /identity/devices`. Guide §5.3 suggests
reconciling the two, but §3 states `GET /devices` is unchanged and `UserDeviceDto`
(`user-device.dto.ts:12`) carries no `clientDeviceId` - so the join key does not exist on that
side. Building a merge against a field the guide does not promise would be untestable until
deploy. Revisit if the backend confirms the field is returned.

## 8. Sign-out

**Decision:** delete the push token, keep the device row.

`LogoutDialogComponent.clearMlsAndLogout()` (`logout-dialog.component.ts:114`) additionally calls
`UserTokenService.deregisterToken()` before `doLogout()`, so a signed-out machine stops being
rung (guide §4.2). Failures are swallowed - the existing flow already logs out on error, and a
failed cleanup must not strand the user in a session they asked to leave.

The device row is **not** deleted. `DELETE /identity/devices/client/{id}` cascades away the MLS
key packages **and the encrypted backup**; logout already wipes the local signing key
(`clearStoredSigningKey`), so the row is inert either way, and keeping it preserves the
server-side backup for a user who logs back in on this machine. `DeviceIdentityService.unregister()`
is still implemented and wired to the settings "Forget this device" action (§7), where the
destruction is explicit and chosen.

## 9. Multi-device calls and guild voice (from the 2026-07-29 design)

Carried over intact - all referenced call sites were re-verified on 2026-07-31. Full detail in
`docs/superpowers/specs/2026-07-29-multi-device-calls-voice-design.md` §2-3; summarised here.

### Calls

- `VoiceService.leaveCall(callId)` → `PUT /call/{id}/leave`.
- `CallSessionService.end(silent = false)` (`call-session.service.ts:80`): calls `leaveCall`
  instead of `endCall`, skipped when `silent`. Clears the new `aloneDeadline`.
- `CallStateService.cancelOutgoing()` (`call-state.service.ts:115`) switches `endCall` → `leaveCall`.
- `call-panel.component.ts:168` `endCall()` is unchanged in shape - it now means "leave", which
  is the fix for the accept-here/decline-there bug, with no new UI.
- `VoiceWebsocketService` gains `call.CallAccepted`, `call.CallDeviceDismissed`,
  `call.CallDeviceTakeover`, `call.CallParticipantLeft`, `call.CallAlone`; `WsCallEnded` gains
  `reason?: 'Declined' | 'UserEnded' | 'AllParticipantsLeft' | 'AloneTimeout'` plus a pure
  `describeCallEndedReason()` helper.
- `CallStateService` subscribes to the three ring-affecting events, factoring the existing
  `incomingEndedSub` body into a shared `dismissIncomingIfMatches()`.
- `CallWebRtcService` handles `CallParticipantLeft` and `CallAlone`, and its existing
  `callEndedObservable` subscriber (`call-webrtc.service.ts:826`) becomes
  `end(true)` + a reason toast gated on `wasActive`, keeping self-hangup silent.
- `CallSessionService` gains `aloneDeadline` signal, cleared in `end()` and once
  `onParticipantJoined` (`call-session.service.ts:318`) takes participants past 1.
- `call-panel` shows an inline countdown when `aloneDeadline` is set.

### Guild voice

- `GuildWebsocketService` gains `guild.voice.KickedByOtherDevice`.
- `VoiceChannelService` handles it via the existing `doLeave(guildId, channelId, silent: true)`
  primitive (`voice-channel.service.ts:380`), resets joined state, and toasts. `ToastService` is
  newly injected.

### Cancel-push handling (guide §4.4)

The accepting device is now excluded from the cancel push while its siblings receive it. Verify
that nothing in the notification path tears down an **active** call on a cancel - the exclusion
only holds when accept carried a registered `X-Device-Id`, which §2 now guarantees.

## Error handling

| Failure | Behaviour |
|---|---|
| `400 Unknown X-Device-Id` | Interceptor re-registers and retries once (§2). Second failure propagates to the caller as an ordinary error. |
| Identity service unreachable during validation | Backend accepts the header unverified (guide §2). No client handling. |
| Device id unresolvable (store failure) | Hub connects with no `?deviceId=` (§4). HTTP requests propagate the error - the id is required for correctness on the validated endpoints and silently omitting it reintroduces the bugs. |
| `ensureRegistered()` with no stored public key | Returns `false`; the interactive registration modal remains the recovery path. |
| Push register/deregister failure | Logged and swallowed, as today. |
| Unknown `deviceId` on push register | Backend registers the token unattached and warns (guide §4.1). No client handling. |

## Testing

Unit tests (Vitest via `@angular/build:unit-test`, globals enabled):

- `deviceIdInterceptor`: sets the header from the resolved id; leaves non-API URLs alone;
  resolves the id once across multiple requests; on a `400` body matching `Unknown X-Device-Id`
  calls `ensureRegistered()` and retries exactly once; does **not** retry on an unrelated 400.
- `DeviceIdentityService`: `deviceId()` caches; `ensureRegistered()` posts the stored public key
  and never calls `generateKeyPackages`; returns `false` when no key is stored.
- `RealtimeConnectionService`: handlers registered before `start()` are replayed; URL carries
  `?deviceId=`; falls back to no param when resolution rejects.
- `UserTokenService`: posts `kind` + `deviceId` to `push-token`; `deregisterToken()` issues the
  DELETE with the persisted token.
- `AuthService.login()` includes `device_id`; `QrLoginService.start()` includes `clientDeviceId`.
- Carried over from the 2026-07-29 design: `describeCallEndedReason`,
  `CallSessionService.end(silent)`, `aloneDeadline` clearing, the three new `CallStateService`
  subscriptions, `VoiceChannelService.onKickedByOtherDevice`.

Rust: unit tests on `Signalling` asserting `X-Device-Id` is present on both the `send()` path and
`close_tracks()`, following the existing URL-construction test pattern (`signalling.rs:280`).

Manual verification, once the backend is deployed:
- `X-Device-Id` present on call accept/decline/leave, CF session create, guild voice join.
- Hub URL carries `?deviceId=`.
- Rust and webview report the **same** id - the split-brain check. Confirmed by the backend
  recording one device for a guild voice join, not two.
- Accept a call on device A: device B receives the cancel and stops ringing; A keeps its call.
- Sign out: the machine stops receiving push.

## Sequencing constraint

The backend migration is not deployed. Everything here degrades to current behaviour against the
old backend **except** §9's `PUT /call/{id}/leave`, which does not exist server-side yet and will
404 on both hang-up and outgoing-call cancel. That matches the 2026-07-29 decision to implement the contract ahead of the
backend rather than feature-flag it, but it is the one change that regresses against today's
production backend, so it should land close to the deploy window.
