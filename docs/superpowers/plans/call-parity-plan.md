# Call & Stream Parity with Discord

Closes the gaps between Alpine's call surfaces (DM call panel, guild voice channel) and Discord's,
as catalogued on 2026-08-14. The stream tile itself is close to parity already; the work is in
everything around it — staying with a stream, finding one, and knowing you are live.

## Context

Two call surfaces share one set of components:

- **DM calls** — `src/app/features/messaging/components/conversation/call-panel/`, rendered inside
  the conversation view (`conversation.component.html:70`). Backed by `CallSessionService` +
  `CallWebRtcService`.
- **Guild voice** — `src/app/features/guild/components/voice-channel/`, which *is* the channel view.
  Backed by `VoiceChannelService` (aliased `voiceSvc`) + `VoiceRtcService`.

Both project their state into shared types (`src/app/shared/call/call.types.ts`:
`CallParticipant`, `CallScreenShare`) and render through the shared components in
`src/app/shared/call/`: `call-screen-layout`, `call-share-tile`, `call-participant-tile`,
`call-controls-bar`, `call-context-menu`, `call-status-bar`, `call-live-badge`.

Anything added to a shared component must work for **both** surfaces. When a capability only one
surface can supply, take it as an input with a null/false default rather than reaching into a
service from the shared component.

Screen share publishing runs through Rust on desktop (`RustMediaService`), which means **the local
share has no `MediaStream` in the webview** — it renders `previewSrc`, a low-rate data-URL
thumbnail, as an `<img>`. Remote shares and all cameras *do* have real `MediaStream`s. This
asymmetry is deliberate and is not to be "fixed"; code must handle both.

## Global Constraints

1. **Both call surfaces, always.** A change to anything in `src/app/shared/call/` must be wired into
   the DM call panel *and* the guild voice channel. A task that touches a shared component and
   updates only one host is incomplete.
2. **Never assume a local `MediaStream`.** `CallScreenShare.stream` is undefined for the local share
   on desktop. Guard every use. Prefer `previewSrc` for local self-view.
3. **Feature-detect, never assume.** Picture-in-Picture support in WebView2 is **unverified**. Every
   PiP entry point must be gated on a runtime capability check and must render nothing when
   unsupported — never a button that silently does nothing.
4. **All user-facing strings are translated.** Keys are flat and dot-separated, added to **all
   three** of `src/assets/i18n/locales/{en,de,fr}.json` (a git submodule — commit it separately from
   the app repo). Reuse existing `CALL.*` keys where they fit; there are 76 already.
   **No em dashes in UI copy.**
5. **Use the existing design tokens.** `bg-card`, `bg-sidebar`, `border-border-subtle`,
   `text-white/85`, `bg-live`, `bg-online`, `bg-offline`, `text-brand-dim` and friends. No
   hardcoded hex. Font sizes in rem-based Tailwind classes (`text-[0.6875rem]`, never `text-[11px]`).
6. **Reuse `app-call-live-badge`** for every LIVE marker. Do not hand-roll a fifth variant.
7. **Angular style matches the repo**: standalone components, `signal`/`computed`/`input()`/
   `output()`, `ChangeDetectionStrategy.OnPush` on new presentational components, `@if`/`@for`
   control flow, `protected` members for template-only state.
8. **Tests.** Run with `node node_modules/@angular/cli/bin/ng.js test --include="<glob>" --watch=false`
   — **not** bare vitest, which fails every TestBed spec with a null-injector error. `fakeAsync` is
   unusable here (no ProxyZone); use `vi.useFakeTimers()`.
9. **Commit per task**, conventional-commit style, so any single task can be reverted alone.
10. **No new dependencies.**

## Out of scope

- **Text chat beside the voice stage.** Requires a backing text channel per voice channel, which is
  a backend capability Alpine does not have. Client work cannot start until that exists.
- **A second Tauri window hosting its own WebRTC subscription.** Video is received in the webview by
  design; a second webview means a second peer connection and a second signalling client. Task 9
  uses the Document Picture-in-Picture API instead, which moves the *existing* DOM and its live
  `MediaStream` into an OS window with no re-subscribe.

---

## Task 1: Gate every Picture-in-Picture control on real capability

**Problem.** `CallShareTileComponent.togglePip()` (`call-share-tile.component.ts:107-112`) requires a
`<video>` element. On desktop the local share renders `previewSrc` as an `<img>`, so `video()` is
undefined and the click returns silently — a drawn, hoverable, dead button. Separately, all PiP
controls are gated on `document.pictureInPictureEnabled`, which is unverified inside WebView2; if it
is false, every PiP button in the app is decorative and nothing says so.

**Do this.**

1. Create `src/app/shared/call/pip-support.ts` exporting:
   - `videoPipSupported(): boolean` — `'pictureInPictureEnabled' in document && document.pictureInPictureEnabled`.
   - `documentPipSupported(): boolean` — `'documentPictureInPicture' in window`.
   - `anyPipSupported(): boolean`.
   Read these lazily at call time (not at module load) so tests can stub them.
2. In `call-share-tile.component.ts`, add a `protected readonly canPip = computed(...)` that is true
   only when `anyPipSupported()` **and** there is something poppable (`share().stream` present, or
   `documentPipSupported()` which can carry the `<img>` preview too).
3. In `call-share-tile.component.html`, wrap the PiP `app-call-tile-action` in `@if (canPip())`.
4. Do the same in `call-participant-tile.component.ts` / `.html` — the camera tile's PiP button has
   the same gate but always has a stream, so it only needs the capability check.
5. Spec `src/app/shared/call/call-share-tile.pip.spec.ts`: the button is absent when no stream and no
   document-PiP; present when a stream exists and PiP is supported; absent when PiP is unsupported.

**Done when** no PiP button is rendered that cannot do anything, and the specs pass.

---

## Task 2: Make a screen share addressable from outside the stage

**Problem.** `maximizedId` is a private signal on `CallScreenLayoutComponent`
(`call-screen-layout.component.ts:42`) with no input and nothing behind it. Nothing in the app can
say "focus this share", which blocks click-to-watch, notification actions and the mini-player.

**Do this.**

1. Create `src/app/services/call-focus.service.ts` (`providedIn: 'root'`):
   - `private readonly _requested = signal<{scopeKey: string; shareId?: string; userId?: string} | null>(null)`
   - `request(scopeKey: string, target: {shareId?: string; userId?: string}): void`
   - `readonly requested = this._requested.asReadonly()`
   - `consume(scopeKey: string): {shareId?: string; userId?: string} | null` — returns and clears the
     request when the scope matches. One-shot, so a focus request cannot re-fire on every render.
   Use `scopeKey()` from `share-watch.service.ts` for the scope string so both services agree.
2. In `CallScreenLayoutComponent`:
   - Add `watchScope` is already an input; add an `effect` that consumes a matching focus request and
     sets `maximizedId` — resolving `userId` to a share via the existing `getShareForUser`.
   - Keep `maximizedId` private; the service is the only external door.
3. Bind double-click to focus. In `call-share-tile.component.html`, add `(dblclick)="maximizeToggle.emit()"`
   to the tile root. Guard it so a double-click on the zoom buttons or the audio toggle does not
   bubble into a maximize.
4. Add a persistent grid/focus control to `call-screen-layout.component.html`: when more than one
   share is displayed *or* one is maximized, show a small toggle that clears/sets `maximizedId`.
   Place it with the existing controls, using `app-call-tile-action` styling for consistency.
5. Spec `src/app/services/call-focus.service.spec.ts`: a request is consumed once and only by the
   matching scope. Spec the layout: a focus request for a userId maximizes that user's share.

**Strings.** `CALL.SHOW_ALL_STREAMS` (grid view) if the toggle needs its own label; reuse
`CALL.SHOW_OTHER_STREAMS` / `CALL.HIDE_OTHER_STREAMS` where they fit.

**Done when** an external caller can focus a share by user id and double-click focuses a tile.

---

## Task 3: Click LIVE to watch, and show live state before you join

**Problem.** The LIVE pill in the channel list is inert decoration on a row whose only action is
"open the channel" (`voice-participant-row.component.html:3`). You land in the lobby and hunt. The
lobby itself (`voice-channel-lobby.component.html`) shows avatars and mute state only, so you cannot
tell anyone is streaming before joining.

**Do this.**

1. `voice-participant-row.component.ts/.html`: add a `watch = output<void>()`. Make the
   `app-call-live-badge` a `<button>` wrapper that emits `watch` and stops propagation so it does not
   also fire the row's `open`. Give it a title/aria-label from `CALL.WATCH_STREAM`.
2. `voice-channel-item.component.ts/.html`: forward the row's `watch` up as
   `watch = output<{userId: string}>()`.
3. In the channel list host that renders `app-voice-channel-item`, handle `watch`: navigate to the
   channel (the same call `open` makes), then `CallFocusService.request()` with the channel scope and
   that userId. Joining is the user's next action if they are not already in — do **not** auto-join
   voice on a watch click; opening the channel and pre-arming the focus request is enough, and the
   request survives until the stage mounts and consumes it.
4. `voice-channel-lobby.component.html`: render `app-call-live-badge` (size `sm`, variant `soft`) on
   any participant whose `isScreenSharing` is true, and change the join button area to offer a second
   action when at least one participant is live: `CALL.JOIN_AND_WATCH`, which emits a join carrying
   the userId. `voice-channel-lobby.component.ts` gains a `joinAndWatch = output<string>()`.
5. `voice-channel.component.ts`: handle `joinAndWatch` by joining then issuing the focus request.
6. Verify the lobby's `participants()` actually carries `isScreenSharing`. If it does not, wire it
   from `VoiceChannelService` — the roster already tracks streaming state.

**Strings.** `CALL.WATCH_STREAM`, `CALL.JOIN_AND_WATCH`.

**Done when** clicking LIVE in the channel list lands you focused on that stream, and the lobby shows
who is live before you join.

---

## Task 4: Show who is watching, and how the stream is arriving

**Problem.** Two pieces of information the client already holds never reach a template.
`ShareWatchService.viewersOf()` returns the watching user ids (`share-watch.service.ts:66`) but the
tile renders only the count. `CallScreenShare.inboundFps` is declared (`call.types.ts:32`) but is
populated only for the local share and rendered nowhere, so a viewer on a bad connection sees a
stuttering tile with no explanation.

**Do this.**

1. **Viewer list.** Add `viewerNames = input<string[]>([])` to `CallShareTileComponent`. Replace the
   count's plain `title` attribute with a small hover popover listing the names (fall back to the
   count-only tooltip when the list is empty). Keep the count itself as-is — hidden at zero.
2. In `call-screen-layout.component.ts`, add a `viewerNames(shareId)` that maps
   `shareWatch.viewersOf(scope, shareId)` through a display-name lookup, and pass it to the tile.
   Take the name resolver as an `input` (`nameOf = input<(userId: string) => string>()`) with a
   sensible default rather than injecting a guild-specific service into a shared component — the DM
   surface has a different roster source.
3. Wire the resolver from both hosts: `voice-channel.component.ts` (guild members) and
   `call-panel.component.ts` (call participants).
4. **Inbound fps.** Populate `inboundFps` for remote shares. Both RTC services already gather stats
   (`CallWebRtcService.stats`, and the guild equivalent); read `framesPerSecond` from the inbound-rtp
   video stat for each remote share's track and expose it per user id. Render it in the tile's
   existing hover strip next to the local `CALL.FPS_OUT` readout, using a new `CALL.FPS_IN` string.
5. Specs for the name mapping and for the tile rendering names when given them.

**Strings.** `CALL.FPS_IN`, `CALL.WATCHING_NOBODY` if a zero-state label is needed (it should not be —
the count is hidden at zero).

**Done when** hovering the viewer count names the viewers and a remote tile reports its inbound fps.

---

## Task 5: Let a viewer drop a stream they do not want

**Problem.** Watching is inferred from what renders, so the only way to stop pulling a stream is to
maximize a different one. In a channel with three shares you cannot drop the one you do not care
about.

**Do this.**

1. Add `protected readonly hiddenIds = signal<ReadonlySet<string>>(new Set())` to
   `CallScreenLayoutComponent` and filter `displayedShares` by it. Because the watch-claim effect is
   already driven by `displayedShares`, the claim drops on its own — do not touch `ShareWatchService`.
2. Add a hide control to the tile: a new `hide = output<void>()` on `CallShareTileComponent`, rendered
   in the hover cluster beside PiP/fullscreen/maximize, labelled `CALL.STOP_WATCHING`.
3. When shares are hidden, render a compact restore affordance in the layout (a row of chips naming
   the hidden streamers, `CALL.SHOW_STREAM` per chip) so a hidden stream is recoverable without
   leaving the channel.
4. Clear a share's hidden state when it disappears from `screenShares()` so a restarted share is not
   invisible.
5. Spec: hiding a share removes it from the displayed set and shrinks the watch claim; a share that
   stops and restarts is visible again.

**Strings.** `CALL.STOP_WATCHING`, `CALL.SHOW_STREAM`, `CALL.HIDDEN_STREAMS`.

**Done when** a viewer can drop and restore individual streams and the viewer count follows.

---

## Task 6: Stream volume, separate from voice volume

**Problem.** Stream audio is binary — mute or not. A loud game under a quiet voice can only be
silenced. The per-user volume in the context menu controls that person's *voice*, not their stream.

**Do this.**

1. Add per-share gain to both RTC services, alongside the existing per-user voice gain:
   `setScreenVolume(userId: string, volume: number)` and `getScreenVolume(userId: string): number`,
   applied to the screen-audio track's gain node (mirror how the existing voice volume is applied —
   find `setUserVolume`/`getUserVolume` in `call-webrtc.service.ts` and the guild equivalent and
   follow that shape exactly).
2. Keep the existing mute toggle. Mute and volume are independent: muting must not zero the stored
   volume, and unmuting restores it.
3. Surface it in `call-context-menu`: when the participant is sharing, show a second slider labelled
   `CALL.STREAM_VOLUME` under the existing voice one. Extend `CallParticipantMenuData` with
   `streamVolume?: number` and add a `streamVolumeChange` output; wire both hosts.
4. Specs for the gain plumbing in both services and for the menu rendering the second slider only
   when the participant is sharing.

**Strings.** `CALL.STREAM_VOLUME`.

**Done when** a stream's volume can be set independently of its owner's voice, and mute round-trips.

---

## Task 7: A persistent "you're live" control

**Problem.** The self-card lives inside the stage (`call-screen-layout.component.html:21-53`) *and*
only when somebody else is also sharing — `selfCard()` is null when yours is the only share. Navigate
away and nothing in the app says you are broadcasting your screen, and the only stop control is the
controls bar inside the call view. That is a privacy problem, not just a convenience one.

**Do this.**

1. Extend `voice-status-bar.component` (`src/app/features/main-page/components/voice-status-bar/`)
   with a live variant: when this client is screen sharing, show the `previewSrc` thumbnail (or a
   desktop glyph when absent), the `app-call-live-badge`, and a stop-sharing button beside the
   existing disconnect.
2. The bar currently renders only for guild voice (`voiceSvc.isInVoice()`). Make it render for a DM
   call too, reading from `CallSessionService` when there is no guild voice session, so the live
   state is visible on both surfaces. Keep the existing channel/guild labelling for guild voice and
   show the call peer's name for a DM call.
3. Stop-sharing calls the same path the controls bar uses (`toggleScreenShare` on whichever service
   owns the session).
4. Spec: the bar shows the live variant and the stop button while sharing, on both surfaces, and
   stopping calls through.

**Strings.** `VOICE_BAR.STOP_SHARING`, `VOICE_BAR.YOU_ARE_LIVE` (or reuse `CALL.YOU_ARE_LIVE`).

**Done when** you can see and stop your own stream from anywhere in the app.

---

## Task 8: App-level mini-player

**Problem.** The largest gap. `<app-call-panel>` renders inside the conversation and the guild stage
*is* the channel view, so navigating away unmounts the whole stage. The media session survives; the
picture does not. Discord shrinks the stream into a draggable in-app picture-in-picture tile you keep
watching while you read other channels.

**Do this.**

1. Create `src/app/features/call/call-mini-player/` — a standalone `OnPush` component mounted in
   `app.component.html` inside the existing `@if (!isPopup)` block, beside `<app-call-overlay/>`.
2. It renders when **all** of: a session exists (guild voice via `VoiceChannelService.isInVoice()` or
   a DM call via `CallSessionService.session()`), **and** that session's full stage is not currently
   mounted. Determine "stage is mounted" with a small piece of shared state rather than by inspecting
   routes: have `voice-channel.component` and `call-panel.component` register/deregister themselves
   with a `CallStagePresenceService` in their constructor/`ngOnDestroy`. This keeps the mini-player
   from guessing at navigation state.
3. Content: the focused share's `<video>` (or the participant grid in miniature when nothing is
   shared), the streamer's name, and a compact control row — mute, deafen, leave, and a "return to
   call" action that navigates back to the stage.
4. Draggable by its header, position persisted in a signal (session-lifetime only, no storage
   needed), constrained to the viewport on drag and on window resize. Respect
   `prefers-reduced-motion` for any transition.
5. **It must claim its watch.** Because `ShareWatchService` claims are driven by what renders, a
   mini-player showing a stream has to declare it, or the streamer's viewer count drops the moment
   anyone navigates away. Call `setWatching` with the scope and the one share it displays, and clear
   on destroy.
6. Reuse the shared projections rather than re-deriving them: extract the `CallScreenShare[]` /
   `CallParticipant[]` mapping currently duplicated in `voice-channel.component.ts:75-93` and
   `call-panel.component.ts` into something both the stage and the mini-player can call. Do not
   copy-paste the mapping a third time.
7. Specs: the mini-player is hidden while the stage is mounted and shown when it is not; it claims
   and releases a watch; dragging clamps to the viewport.

**Strings.** `CALL.RETURN_TO_CALL`, `CALL.MINI_PLAYER`.

**Done when** navigating away from a call leaves a working, draggable player and the viewer count
does not drop.

---

## Task 9: Pop the stream out of the app window

**Problem.** No pop-out. Element fullscreen is the only escape and it stays inside the one window.
Discord's Pop Out View lifts a stream into its own OS window that can be dragged outside the app,
resized, and pinned on top.

**Do this.**

1. Add `popOut()` to `CallShareTileComponent` using the **Document Picture-in-Picture API**:
   `await window.documentPictureInPicture.requestWindow({width, height})`, then move the tile's video
   wrapper element into the new window's `document.body`. The `MediaStream` keeps playing because the
   element is moved, not recreated — no re-subscribe, no second peer connection.
2. Copy the page's stylesheets into the PiP window (iterate `document.styleSheets`, append cloned
   `<style>` elements) so the tile is not unstyled. Set the PiP document's background from the
   existing tokens.
3. On `pagehide` of the PiP window, move the element back to its original parent. Keep a reference to
   the original parent and next sibling so it returns to the right place; do this even if the
   component is being destroyed.
4. Fall back to the existing `video.requestPictureInPicture()` when Document PiP is unavailable but
   video PiP is not, and render no control when neither. Extend Task 1's `canPip` rather than adding
   a second check — and **widen the gate and the dispatch in lockstep**. Task 1 deliberately narrowed
   `canPip` to claim only what `togglePip()` could actually do at that point (video PiP, requiring a
   real `<video>`), because the first attempt rendered a button that was a silent no-op wherever
   document PiP was supported and video PiP was not. When you add the document-PiP path to
   `togglePip()`, widen `canPip` to match it in the same commit, and add a spec asserting the click
   *does something* in that capability combination — not merely that the button renders.
5. Label the control `CALL.POP_OUT` when Document PiP is the route taken, keeping
   `CALL.PICTURE_IN_PICTURE` for the video-PiP fallback.
6. Spec the element move-and-restore with a stubbed `documentPictureInPicture`, and the fallback
   selection logic.

**Note.** Whether either API is available inside WebView2 is unverified. The feature detection from
Task 1 is what makes this safe to ship either way; do not add a build-time assumption.

**Strings.** `CALL.POP_OUT`.

**Done when** a share can be moved into its own OS window and cleanly returns to the tile.

---

## Task 10: Stop rendering what nobody is looking at

**Problem.** `RustMediaService.onPreviewFrame` pushes base64 data-URL frames into a signal
continuously (`rust-media.service.ts:194`) with no idle throttle and no hidden-window check. Every
frame crosses the IPC boundary whether or not anything renders it. Discord pauses the self-preview
after a short idle period — "we've paused this preview to save your resources" — with a button to
bring it back; the stream itself keeps going.

**Do this.**

1. Add preview pausing to `RustMediaService`: after `PREVIEW_IDLE_MS = 30_000` with the window hidden
   or the preview not being displayed, stop applying incoming frames (set the signal to a paused
   state rather than dropping to null, so consumers can tell "paused" from "no share"). Expose
   `previewPaused` and `resumePreview()`.
2. Drive it from two signals: `document.visibilitychange`, and an explicit "somebody is rendering the
   preview" claim from the components that show it (the self-card, the share tile, the sidebar live
   card from Task 7, the mini-player from Task 8).
3. Where the preview is rendered, show a paused card when `previewPaused()` is true: a short line and
   a resume button. The wording must make clear the **stream is still running** and only the local
   preview stopped. Any interaction with the preview resumes it.
4. Apply the same principle to remote video: when the window is hidden, pause the `<video>` elements
   rendering remote screen shares and cameras, and resume on visibility. Do **not** unsubscribe — the
   watch claim and the subscription stay; only playback pauses.
5. Specs with `vi.useFakeTimers()` (not `fakeAsync` — no ProxyZone in this repo): frames stop being
   applied after the idle window, `resumePreview()` restores them, and the stream state is untouched
   throughout.

**Strings.** `CALL.PREVIEW_PAUSED`, `CALL.PREVIEW_PAUSED_HINT` (make clear the stream is still live),
`CALL.RESUME_PREVIEW`.

**Done when** an idle or hidden window stops burning frames and says so, without touching the stream.

---

## Task 11: Tell people a stream started

**Problem.** Nobody is told. `TrackPublished` is consumed for subscription only — no toast, no OS
notification, no badge outside the channel list. Discord fires "X is live" with a Watch action.

The data is already client-side: `GuildVoiceActivityService` tracks `streamers` per guild **per
channel** from events that reach every guild member whether or not they are looking at that guild
(`guild-voice-activity.service.ts`). It is simply not exposed — only the aggregated per-guild
`presence` is.

**Do this.**

1. **Check `setStreaming` first.** The stop handler calls
   `setStreaming(e.channelId, undefined, false)` with no userId while the start handler passes one.
   Read the implementation and determine whether one person stopping clears the streaming state for
   everyone in that channel. If it does, that is a real bug — fix it, and add a spec covering two
   streamers in one channel where one stops.
2. Expose per-channel streamer state: `streamersIn(guildId, channelId): string[]` and
   `isStreaming(userId): boolean` (or a signal-backed equivalent) on `GuildVoiceActivityService`.
3. **Member list.** Render `app-call-live-badge` (size `sm`, variant `soft`) beside any member who is
   streaming, and make it a watch target using the Task 2 focus service.
4. **Notification.** When a streamer appears in a channel of a guild this user is in, post a
   notification through the `Notifier` port (`src/app/platform/ports/notifier.port.ts`:
   `notify({title, body, tag})`). Encode the target in the `tag` so `onActivated(tag)` can navigate to
   the channel and issue the focus request — `tag` is the only payload both hosts carry through.
5. **It must be muteable.** An unconditional go-live notification is noise. Add a per-guild toggle to
   the existing notification settings, defaulting to **off for guilds, on for friends** if a friend
   concept is reachable; if it is not, default the whole feature to off and let the user opt in. Do
   not ship an always-on notification.
6. Suppress the notification when the user is already in that channel, and when the streamer is this
   user.
7. Specs: the streamer index survives one of two streamers stopping; a notification is posted once
   per go-live and not at all when muted or when already in the channel.

**Strings.** `CALL.WENT_LIVE_TITLE`, `CALL.WENT_LIVE_BODY`, `SETTINGS.NOTIFY_GO_LIVE`.

**Done when** a stream starting is visible outside its channel and can be turned off.

---

## Task 12: Let a DM call fill the window

**Problem.** The DM call panel is a resizable strip clamped to 900px, and "maximize" just means that
clamp (`call-panel.component.ts:20-22`). Watching a 1080p share in a DM means watching it in a
letterbox.

**Do this.**

1. Change maximize to mean the full content area rather than `MAX_HEIGHT`. Add a
   `protected readonly isFullView = signal(false)`; when true the panel fills its container
   (`flex-1`, ignoring `panelHeight`) and the message list below is collapsed.
2. Keep drag-resize working in the non-full state, and keep the 200-900px clamp there.
3. Restoring returns to the previous dragged height, not to `DEFAULT_HEIGHT`.
4. The existing maximize/restore button and its `CALL.MAXIMIZE` / `CALL.RESTORE` labels stay; only
   what they do changes.
5. Spec: toggling full view fills the container and restoring returns the prior height.

**Done when** a DM call can use the whole content area.

---

## Task 13: One stage for cameras and screens

**Problem.** The moment any share exists, the layout switches wholesale: shares get the grid and
every camera collapses to a 32px circle in the participants strip
(`call-screen-layout.component.html:67-74`). A face-cam beside a game stream is not expressible.
Discord tiles them together.

**Do this.**

1. Introduce a unified tile model in `call.types.ts`: a discriminated union over `'share' | 'camera'`,
   derived in `CallScreenLayoutComponent` from the existing `screenShares()` and `participants()`
   inputs. Do **not** change the component's public inputs — both hosts keep passing what they pass.
2. Render shares and cameras as tiles in the one grid, keeping `gridClass()`'s column logic (extend
   its thresholds for the larger counts this produces).
3. Keep the existing rules that already work: the local share is demoted to the self-card when others
   are sharing; maximize shows one tile; the participants strip remains as the overflow for anyone
   with neither a camera nor a share.
4. Cameras in the grid keep the treatment `call-participant-tile` already gives them (speaking ring,
   name pill, mute glyph, hover PiP/fullscreen) — reuse that component rather than duplicating it.
5. Update `call-screen-layout.component.spec.ts` for the combined set, and add cases for
   camera-only, share-only, and mixed.

**Done when** a camera and a screen share can occupy the same grid at comparable size.

---

# Addendum: real-app feedback, 2026-08-14

Added after the human partner ran the build and reported three gaps the code-only analysis missed.
Numbering continues from the original plan.

## Task 14: Hide the in-call controls until the pointer is near them

**Problem.** The floating controls bar is rendered unconditionally in both stages
(`voice-channel.component.html` and `call-panel.component.html`, inside
`<div class="pointer-events-none absolute bottom-8 ...">`). It sits over the stage permanently,
covering the bottom of whatever is being watched. Discord hides its in-call controls and reveals them
when the pointer moves into that region.

**Do this.**

1. Add reveal-on-pointer behaviour to the stage, not to `CallControlsBarComponent` itself — the bar is
   also used in contexts where it should stay put, and a component that hides itself is harder to
   reason about than a container that reveals it.
2. Reveal on `pointermove` anywhere over the stage, and keep the bar up for a short grace period
   (`CONTROLS_IDLE_MS`, 3 seconds is a sensible starting point) after the pointer stops. Cancel the
   hide while the pointer is over the bar itself, and while any control inside it has keyboard focus —
   a bar that vanishes under a focused button is a keyboard trap.
3. **Never hide the bar when there is nothing to watch.** If no share and no camera is on the stage,
   the participant grid is the content and hiding the controls only removes function. Gate the
   auto-hide on the stage actually rendering video.
4. Respect `prefers-reduced-motion`: fade rather than slide, or no transition at all.
5. Keyboard and accessibility: the bar must be reachable by Tab even while hidden, and reaching it by
   Tab must reveal it. Do not use `display: none` or `visibility: hidden` for the hidden state, or it
   leaves the tab order; use opacity plus `pointer-events`.
6. Spec: the bar hides after the idle window with video present; it does not hide with no video; it
   stays while the pointer is over it; it stays while a control inside it has focus; it reveals on
   focus arriving by keyboard.

**Done when** watching a stream leaves the picture unobstructed, and the controls come back the moment
you reach for them.

---

## Task 15: Start and stop a screen share from the sidebar, not only from inside the call

**Problem.** Screen sharing can only be started from the controls bar inside the call view. If you are
reading another channel, there is no way to begin sharing without navigating back. Task 7 added a
*stop* control to the sidebar voice bar, so the asymmetry is now visible: you can stop from anywhere
but only start from inside.

**Do this.**

1. Extend `src/app/features/main-page/components/voice-status-bar/` so that while a session is live and
   this client is **not** sharing, the bar offers a start-sharing control alongside the existing
   disconnect. While sharing, the existing stop control stays exactly as Task 7 built it.
2. Starting must go through the same path the in-call controls bar uses (`toggleScreenShare` on
   whichever service owns the session), so the screen picker opens exactly as it does in-call. Do not
   duplicate the picker flow.
3. Both surfaces: guild voice and DM calls.
4. The bar is narrow and already carries a status dot, two lines of text, the live row from Task 7, the
   mini-player restore from Task 8 and a disconnect button. Adding a fourth control risks a cramped
   row — lay it out so nothing truncates at the sidebar's real width, and say in the report how you
   verified that.
5. Spec: the start control appears only when not sharing, the stop control only when sharing, on both
   surfaces, and starting calls through to the right service.

**Strings.** `VOICE_BAR.START_SHARING`, or reuse `CALL.SHARE_SCREEN` if its wording fits.

**Done when** a share can be started from anywhere in the app.

---

## Task 16: A pop-out that can leave the app window on desktop

**Problem.** The human partner reports the picture-in-picture "only goes in the app itself" and cannot
be dragged onto another monitor, and that while acceptable for the browser build, the Tauri build
should do better.

**Read this before starting: the answer may already exist.** Task 9 implements pop-out via the
**Document Picture-in-Picture API**, which produces a genuine OS-level window that can be dragged
anywhere, including to another monitor. At the time this addendum was written Task 9 was implemented
and reviewed but **not yet merged**, so what the human partner was seeing was Task 8's in-app
mini-player, which is deliberately viewport-clamped.

So the first step is a question, not code:

1. **Verify whether `window.documentPictureInPicture` exists in the Tauri WebView2 runtime.** This has
   been unverified for the whole plan and cannot be settled from a test environment. Run the desktop
   build and check. If it exists, Task 9 already satisfies this requirement and this task reduces to
   confirming it and closing.

2. **Only if Document PiP is unavailable in WebView2**, implement a Tauri-native pop-out. Be aware what
   that costs before starting, because it is not a small feature:
   - A second `WebviewWindow` is a separate JS context. It cannot share a `MediaStream` with the main
     window.
   - Video is received in the webview by design, so the pop-out window would need its own subscription:
     a second peer connection and a second signalling client.
   - That duplicates the RTC layer and doubles the pull from the media server for one viewer.
   - The mechanism itself exists — `src-tauri/src/lib.rs` already builds the splash window with
     `WebviewWindowBuilder` and `.always_on_top(true)` — so the window is easy; the media is not.

   Because of that cost, **do not begin step 2 without confirming the scope with the human partner.**
   Report the finding from step 1 and stop.

**Done when** either Document PiP is confirmed working on desktop and Task 9 covers this, or the
trade-off for a native window has been put to the human partner with a real estimate.

---

## Task 17: Hide the call controls by default, reveal on hover

**Problem.** Real-app feedback: in a guild voice channel the controls bar is visible by default and stays
visible. Two causes, both deliberate decisions from Task 14 that the human partner is now overriding:

1. `AutoHideCallControlsDirective.revealed` is `signal(true)`, so the bar starts visible and only fades
   after an idle period.
2. `hasVideo` gates the entire behaviour (`auto-hide-call-controls.directive.ts:59-66, 108`). With no
   share and no camera on the stage the bar is forced permanently visible. That rule came from the
   Task 14 brief, on the reasoning that the participant grid is the content and hiding controls over it
   removes function for no gain. The human partner wants the bar hidden regardless.

**Do this.**

1. Start hidden: `revealed` becomes `signal(false)`.
2. Remove the `hasVideo` gate entirely — from the constructor effect and from `scheduleHide()`. The bar
   auto-hides on every stage, video or not. Remove the now-unused `hasVideo` input, and update both host
   templates which currently pass `[appAutoHideCallControls]="hasStageVideo()"`. Remove the
   `hasStageVideo` computed from both hosts if nothing else uses it.
3. Reveal on hover, not only on movement. Keep `pointermove`, and add a `pointerenter` host listener so
   entering the stage without moving still reveals. Both should reveal and restart the countdown.
4. Keep everything the reveal/hide mechanism already gets right, all of which was verified in review and
   must not regress:
   - Hidden state stays opacity plus `pointer-events`, never `display`/`visibility` — either would drop
     the bar from the tab order and turn this into an accessibility regression.
   - Tab still reaches the bar while hidden, and arriving by Tab reveals it via `onControlsFocusIn`.
   - Hovering or focusing the bar suspends the countdown outright rather than resetting it.
   - `prefers-reduced-motion` continues to disable the fade.
5. Update the specs. The existing "does not hide with no video" case now asserts the opposite and should
   be renamed to say what it tests. Add a case proving the bar starts hidden on mount with no pointer
   activity, and one proving `pointerenter` alone reveals it.

**One consequence to state rather than discover.** With the bar hidden by default, a user who never moves
the pointer sees no in-stage way to leave the call. That is acceptable because the sidebar voice bar
carries a permanently visible disconnect control, and a mini-player with its own controls appears when the
stage is not mounted. Note this in the report; do not add a second escape hatch.

**Done when** the controls are invisible on entering a voice channel and fade in on hover, on both call
surfaces.

---

## Task 18: Match the reference participant tile, and add an invite card beside it

**Source.** The human partner supplied a reference screenshot at
`C:\Users\Domin\Downloads\how_one_participant_should_look_like.png` showing a voice stage with a single
participant. Two differences from what Venta renders today.

**Difference 1 — the name is a pill at bottom-left, always.**

`call-participant-tile.component.html:65-77` gives the name two different treatments. With a camera on it
is a dark rounded pill at bottom-left (`absolute bottom-2 left-2 … rounded-lg bg-black/50 px-2 py-1
backdrop-blur-sm`). With the camera off it becomes `mt-3` centred text under the avatar, so the avatar and
name form a vertical stack in the middle of the tile.

The reference uses the pill in both cases: the avatar sits centred in the tile, and the name is a pill in
the bottom-left corner regardless of camera state.

Do this:
1. Use the pill treatment unconditionally. Delete the branch, keep the pill classes.
2. Centre the avatar in the tile rather than stacking it with the name. The tile's flex centring already
   does this once the name is absolutely positioned, so this should fall out — verify it rather than
   assume, because the name currently participates in the flex column.
3. The muted glyph stays inside the pill, as it already is in the camera-on case.
4. Do not change the tile's `aspect-video`, its border, the speaking ring, the LIVE badge, the hover
   actions, or the audio-status badge. Only the name's placement changes.

**Difference 2 — an invite card fills the stage beside the participant.**

The reference shows a second card of equal height beside the participant tile, with a decorative
background, an illustration, and an action button. It exists so a one-person channel does not look empty
and so inviting someone is one click from where you already are.

Do this:
1. New standalone `OnPush` component, `src/app/shared/call/call-invite-card/`, rendering a tile the same
   shape as a participant tile: `aspect-video w-full`, the same `rounded-2xl` and border treatment, so it
   sits in the grid as a peer.
2. Give it a decorative background built from **existing tokens** — a subtle gradient using
   `--color-brand` / `--color-brand-dark` via `color-mix`, as `call-overlay.component.html` already does.
   **Do not copy the reference's artwork**; use a large, low-contrast PrimeIcon (`pi-users` or similar) as
   the decorative element.
3. One primary action, labelled from a new `CALL.INVITE_TO_VOICE` string, emitting an `invite` output.
4. **The invite mechanic does not exist yet.** This task is layout only. The host must not fabricate one:
   wire the output to nothing, and do not invent a service, a dialog or a backend call. If the button
   would otherwise do nothing on click, that is correct and intended for this task.
5. **Leave "Choose Activity" out.** The reference shows it, but activities are an entirely separate
   product feature with no counterpart here, and a second dead button implies a roadmap this task has no
   basis for. One affordance, for the mechanic that is actually coming.
6. Render it in `CallScreenLayoutComponent`'s grid **only when the stage would otherwise hold exactly one
   tile**, so it fills the empty half rather than competing for space in a busy channel. It must not enter
   `displayedShares()`, must not affect `gridClass()`'s counting in a way that changes existing thresholds,
   and must never reach the watch claim — it is not a share.
7. Both call surfaces get it, since the layout component is shared.

**Strings.** `CALL.INVITE_TO_VOICE`, and a short line of supporting copy if the card needs one, in all
three locales with real German and French.

**Done when** a one-person voice channel shows the avatar centred with a bottom-left name pill, and an
invite card beside it.
