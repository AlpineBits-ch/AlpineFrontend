# Call UX Polish (Discord Parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the visual/functional gap between Alpine's call experience (DM calls + guild voice channels + voice/video settings) and Discord's, based on a prior audit, without touching sound/SFX or anything outside the call surfaces.

**Architecture:** Alpine runs two parallel Cloudflare-Calls-SFU-backed call stacks — DM calls (`CallSessionService` + `CallWebRtcService`) and guild voice channels (`VoiceChannelService` + `VoiceRTCService`) — that share a UI component library under `src/app/shared/call/`. Most fixes are template/CSS polish in that shared library and its two consumers; two fixes (voice-activity gating, DM deafen) require small, symmetric additions to both RTC services, each reusing detection/mute plumbing that already exists in that service.

**Tech Stack:** Angular 21 (standalone components, signals), PrimeNG 21, Tailwind CSS v4, TypeScript, Web Audio API (AnalyserNode-based level detection already in use).

## Global Constraints

- **Scope is call-only.** Touch only: `src/app/features/call/`, `src/app/features/messaging/components/conversation/call-panel/`, `src/app/features/guild/components/voice-channel/`, `src/app/features/guild/components/channel-list/components/voice-channel-item/` and `voice-participant-row/`, `src/app/shared/call/`, `src/app/features/settings/settings-modal/pages/voice-video-settings/`, `src/app/features/main-page/components/voice-status-bar/`, `src/app/services/call-session.service.ts`, `call-webrtc.service.ts`, `call-hotkey.service.ts`, `voice-channel.service.ts`, `voice-rtc.service.ts`, `audio-settings.service.ts`, `src/styles.css` (additive only). A separate agent is reworking the main page and general guild page (member list, invites, navigation) in parallel — do **not** touch `guild-member-list`, guild invite features, or main-page layout, even where a call component has a dead button that looks related.
- **Sound/SFX is explicitly out of scope.** Do not touch `sound-settings.service.ts` or `notification-settings.component.*`.
- **No existing unit tests cover these components** (verified: no `.spec.ts` files exist under `shared/call/`, `features/call/`, or the voice-channel/voice-participant-row directories). Don't introduce a testing pattern the codebase doesn't already use here. Verify each task with `npx ng build` (must compile with zero new errors) plus the manual check described in the task. Only add `.spec.ts` where a task introduces real branching logic with no visual proxy (Task 6, Task 7's settings math) — see those tasks for what to test and how.
- **Follow existing conventions:** Tailwind utility classes directly in templates; a component gets a `.css` file only if it already has one (`call-panel`, `call-context-menu` gets one **new** in Task 1 because it currently has none and needs one — see Task 1); PrimeNG components (`p-select`, `p-toggleswitch`, `p-slider`, `p-radiobutton`, `p-button`) exactly as already used in `voice-video-settings.component.html` / `privacy-settings.component.html`; `var(--color-*)` tokens from `src/styles.css`; shared keyframes that multiple components need go in `src/styles.css` (matching the existing `.typing-dot` / `@keyframes typing-bounce` pattern), not duplicated per-component.
- **Two real functional bugs were found during research** (not just visual polish) and are fixed in this plan because leaving them would undercut the polish work: (1) `vc-rtc-pulse`, the animation name used by the guild voice channel's connecting/failed status dot, is referenced in `voice-channel.component.html` but never defined anywhere — the dot never actually pulses. (2) `.vc-volume-slider`, the class on the per-participant volume `<input type=range>` in `call-context-menu.component.html`, is referenced but never defined anywhere — it renders as a completely unstyled native slider. Both are fixed in Task 1.
- **A third real bug was found:** DM call "Deafen" (`CallSessionService.toggleDeafen`) only flips a local UI flag — it never actually silences incoming remote audio (contrast with the guild voice channel path, where `VoiceRTCService.setDeafened` correctly zeroes each remote `<audio>` element's volume). Fixed in Task 6.
- **Voice-Activity mode is a real, functional feature addition** (Task 7), not cosmetic: today the mic transmits continuously with no gating at all unless the user manually binds a Push-to-Talk key on the Keybinds page. This task adds an actual level-based transmit gate, reusing the AnalyserNode-based speaking-detection loops that already run in both `CallWebRtcService` (DM) and `VoiceRTCService` (guild) for the speaking-indicator ring — no new audio pipeline is introduced. **Behavior change to flag to the user:** after this task, a fresh install defaults to Voice-Activity mode with sensitivity 60 (roughly matching today's fixed internal speaking-detection thresholds), so a mic that was previously always-open will now gate between words. Users can switch to Push-to-Talk or crank sensitivity to 100 (effectively always-open) in Settings.

---

## Task 1: Shared call-status pulse keyframe + fix the two dead style references

**Files:**
- Modify: `src/styles.css` (add a shared keyframe + utility class)
- Modify: `src/app/features/guild/components/voice-channel/voice-channel.component.html:47-48,56-57` (fix `vc-rtc-pulse` reference)
- Create: `src/app/shared/call/call-context-menu/call-context-menu.component.css` (new file — component currently has none)
- Modify: `src/app/shared/call/call-context-menu/call-context-menu.component.ts` (wire up the new `styleUrl`)

**Interfaces:**
- Produces: `@keyframes rtc-status-pulse` and `.rtc-status-dot` utility class in `src/styles.css`, consumed by Task 9 (call-panel unification) and reusable anywhere a connection-state dot is needed.
- Produces: `.vc-volume-slider` CSS rule in the new `call-context-menu.component.css`, consumed only by that component's own template (already references the class name).

- [ ] **Step 1: Add the shared pulse keyframe to `src/styles.css`**

Add after the existing `.search-highlight` block (around line 99), matching the file's 2-space-indent style:

```css
/* ── Call / voice connection-state pulse ─────────────────────────────────── */

@keyframes rtc-status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
```

- [ ] **Step 2: Fix the broken `vc-rtc-pulse` reference in the guild voice channel banner**

In `src/app/features/guild/components/voice-channel/voice-channel.component.html`, the "Connection failed/lost" banner (line 47-48) and "Establishing connection..." banner (line 56-57) both use `style="animation: vc-rtc-pulse ..."`, which has never resolved to anything. Replace both occurrences of `vc-rtc-pulse` with `rtc-status-pulse`:

```html
<!-- line 47-48, was: animation: vc-rtc-pulse 0.8s ease-in-out infinite -->
<div class="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0"
     style="animation: rtc-status-pulse 0.8s ease-in-out infinite"></div>
```

```html
<!-- line 56-57, was: animation: vc-rtc-pulse 1s ease-in-out infinite -->
<div class="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
     style="animation: rtc-status-pulse 1s ease-in-out infinite"></div>
```

- [ ] **Step 3: Verify the guild voice channel dot now pulses**

Run `npm start`, join (or simulate joining) a guild voice channel while the connection is in the `new`/`connecting` state (briefly visible right after clicking "Join Voice"), and confirm the amber dot in the "Establishing connection..." banner visibly pulses instead of sitting static. This was previously silently broken.

- [ ] **Step 4: Create the missing `call-context-menu.component.css`**

`call-context-menu.component.html:28` already has `class="vc-volume-slider w-full"` on the volume `<input type=range>`, but no CSS anywhere defines `.vc-volume-slider`, so it renders as a bare unstyled native slider inside an otherwise fully custom-styled context menu — the single worst "cheap" visual moment in the right-click menu. Reuse the exact thumb-styling pattern already proven in the (soon to be deleted, see Task 10) `call-panel.component.css` `.vol-slider` rules:

```css
.vc-volume-slider {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: var(--color-border);
    outline: none;
    cursor: pointer;
}

.vc-volume-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--color-brand);
    cursor: pointer;
    transition: background 0.12s, transform 0.1s;
}

.vc-volume-slider::-webkit-slider-thumb:hover {
    background: var(--color-brand-hover);
    transform: scale(1.2);
}

.vc-volume-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: none;
    background: var(--color-brand);
    cursor: pointer;
}
```

- [ ] **Step 5: Wire the new stylesheet into the component**

In `src/app/shared/call/call-context-menu/call-context-menu.component.ts`, add `styleUrl: './call-context-menu.component.css',` to the `@Component` decorator (alongside the existing `templateUrl`).

- [ ] **Step 6: Build and visually verify**

Run `npx ng build`. Then `npm start`, right-click a participant in either a DM call or a guild voice channel to open the context menu, and confirm the Volume slider now shows a purple filled thumb with hover-scale feedback instead of the browser's default gray slider.

- [ ] **Step 7: Commit**

```bash
git add src/styles.css src/app/features/guild/components/voice-channel/voice-channel.component.html src/app/shared/call/call-context-menu/call-context-menu.component.css src/app/shared/call/call-context-menu/call-context-menu.component.ts
git commit -m "fix: repair dead vc-rtc-pulse and vc-volume-slider style references in call UI"
```

---

## Task 2: Speaking-ring animation on the sidebar voice participant row

**Files:**
- Modify: `src/app/features/guild/components/channel-list/components/voice-participant-row/voice-participant-row.component.html`

**Interfaces:**
- Consumes: `rtc-status-pulse`-adjacent shared keyframe convention from Task 1 (this task adds its own dedicated `speaking-ring` keyframe to `src/styles.css` in Step 1, since the visual effect — a growing/fading ring shadow, not an opacity pulse — is different from `rtc-status-pulse`).
- Consumes: `VoiceChannelParticipant.isSpeaking` (existing, `voice-channel.service.ts:28`).

This is the single most-visible gap from the audit: the sidebar list under a voice channel (the most-viewed "who's talking" UI in the app) only changes text color when someone speaks — no ring, no glow, no animation — even though the in-call tile already has a ring treatment for the same concept.

- [ ] **Step 1: Add a shared `speaking-ring` keyframe to `src/styles.css`**

Add directly below the `rtc-status-pulse` block added in Task 1:

```css
@keyframes speaking-ring {
  0%, 100% { box-shadow: 0 0 0 2px rgba(52, 211, 153, 0.35); }
  50% { box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.6); }
}
```

- [ ] **Step 2: Apply the ring to the sidebar avatar**

In `voice-participant-row.component.html`, the avatar is currently:

```html
<app-avatar [label]="p.avatarLabel" [userId]="p.userId"
            class="flex shrink-0" styleClass="!w-5 !h-5 !text-[9px]"/>
```

`AppAvatarComponent` renders its own root element sized by `styleClass`, so the ring has to be applied via a wrapper (the avatar component doesn't expose a "speaking" input). Wrap it and add a conditional ring class on the wrapper, using `rounded-full` to match the avatar's circular shape:

```html
<div [ngClass]="p.isSpeaking ? 'rounded-full' : ''"
     [style.animation]="p.isSpeaking ? 'speaking-ring 1.4s ease-in-out infinite' : 'none'"
     class="flex shrink-0 rounded-full">
    <app-avatar [label]="p.avatarLabel" [userId]="p.userId"
                styleClass="!w-5 !h-5 !text-[9px]"/>
</div>
```

- [ ] **Step 3: Build and visually verify**

Run `npx ng build`. Then `npm start`, join a guild voice channel from a second account/session (or use the existing dev call-simulation hotkeys if they cover guild voice — otherwise verify with two real clients), and confirm the sidebar avatar now shows a pulsing green ring while that participant is speaking, matching the in-call tile's visual language.

- [ ] **Step 4: Commit**

```bash
git add src/styles.css src/app/features/guild/components/channel-list/components/voice-participant-row/voice-participant-row.component.html
git commit -m "feat: animate speaking indicator on sidebar voice channel participant rows"
```

---

## Task 3: Press/hover polish on the call controls bar

**Files:**
- Modify: `src/app/shared/call/call-controls-bar/call-controls-bar.component.html`

**Interfaces:**
- No signature changes — pure template/class changes to the existing `CallControlsBarComponent`.

The mute/deafen/camera/share/disconnect buttons — the most-clicked controls in the whole call UI — currently only change background opacity on hover, with zero press feedback. The incoming-call overlay already has the exact pattern to copy (`active:scale-95` + icon `group-hover:scale-110`, `call-overlay.component.html:43-49`).

- [ ] **Step 1: Add press/hover polish to every button in the bar**

Apply `group active:scale-95` to each `<button>` and `group-hover:scale-110 transition-transform duration-150` to each button's inner `<i>` icon. Edit all five/six buttons in `call-controls-bar.component.html` the same way; shown here for Mute and Disconnect (apply the identical pattern to Deafen, Camera, Screen share, and the conditional Mute-stream-audio button):

```html
<!-- Mute -->
<button
        (click)="muteToggle.emit()"
        [ngClass]="isMuted()
  ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30'
  : 'bg-white/[0.07] text-white/60 hover:bg-white/[0.12] hover:text-white/80'"
        [title]="isMuted() ? 'Unmute' : 'Mute'"
        class="group w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-150 active:scale-95 cursor-pointer border-0">
    <i [ngClass]="isMuted() ? 'pi-microphone-slash' : 'pi-microphone'"
       class="pi text-base transition-transform duration-150 group-hover:scale-110"></i>
</button>
```

```html
<!-- Disconnect / End Call -->
<button
        (click)="disconnect.emit()"
        [title]="disconnectLabel()"
        class="group w-12 h-12 rounded-xl flex items-center justify-center bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 hover:text-rose-300 transition-all duration-150 active:scale-95 cursor-pointer border-0">
    <i class="pi pi-phone text-base transition-transform duration-150 group-hover:scale-110" style="transform: rotate(135deg); display: inline-block;"></i>
</button>
```

For the FPS/resolution pill buttons (which already have their own `bg-brand`/transparent active states), only add `active:scale-95 transition-transform` — skip the icon-scale treatment since they're text, not icons:

```html
<button
        (click)="fpsChange.emit(fps)"
        [ngClass]="captureFps() === fps
    ? 'bg-brand text-white'
    : 'bg-transparent text-white/45 hover:text-white/75 hover:bg-white/[0.07]'"
        [title]="fps + ' fps'"
        class="px-2 py-1 rounded text-xs font-mono transition-all border-0 cursor-pointer leading-none active:scale-90">{{ fps }}
</button>
```

(same `active:scale-90` addition on the resolution buttons below it.)

- [ ] **Step 2: Build and visually verify**

Run `npx ng build`. Then `npm start`, join any call, and click each control button — confirm a visible quick scale-down-then-back on press and a slight icon scale-up on hover, in both the DM call panel and the guild voice channel (same shared component, so fixing once covers both).

- [ ] **Step 3: Commit**

```bash
git add src/app/shared/call/call-controls-bar/call-controls-bar.component.html
git commit -m "feat: add press/hover feedback to call controls bar buttons"
```

---

## Task 4: Wire the (currently dead) speaking-ring pulse into the in-call participant tile

**Files:**
- Modify: `src/app/shared/call/call-participant-tile/call-participant-tile.component.html`

**Interfaces:**
- Consumes: `speaking-ring` keyframe added in Task 2, Step 1.

The in-call tile's speaking indicator is currently a **static** ring (`ring-2 ring-online/40`, no animation), even though a more polished animated version of this exact idea (`@keyframes speaking-ring` inside `call-panel.component.css:790-797`) exists in the codebase — just never wired to the current template. Task 10 deletes that dead copy; this task makes the live tile actually use the (now-shared) animated version.

- [ ] **Step 1: Animate the speaking glow ring**

In `call-participant-tile.component.html`, the speaking glow ring is currently:

```html
<!-- Speaking glow ring -->
@if (participant().isSpeaking) {
    <div class="absolute inset-0 rounded-2xl ring-2 ring-online/40 pointer-events-none"></div>
}
```

Change it to also apply the shared pulse keyframe (targeting `box-shadow` instead of the static Tailwind `ring` utility, since `@keyframes` can't animate a Tailwind ring color token directly):

```html
<!-- Speaking glow ring -->
@if (participant().isSpeaking) {
    <div class="absolute inset-0 rounded-2xl pointer-events-none"
         style="animation: speaking-ring 1.4s ease-in-out infinite"></div>
}
```

- [ ] **Step 2: Build and visually verify**

Run `npx ng build`. Then `npm start`, join a call and speak (or trigger the dev call-simulation hotkeys in `call-state.service.ts` if they drive `isSpeaking`), and confirm the tile's border glow now pulses instead of sitting static, in both DM calls and guild voice channels (shared component).

- [ ] **Step 3: Commit**

```bash
git add src/app/shared/call/call-participant-tile/call-participant-tile.component.html
git commit -m "feat: animate the speaking ring on in-call participant tiles"
```

---

## Task 5: Remove the two non-functional header buttons in the guild voice channel view

**Files:**
- Modify: `src/app/features/guild/components/voice-channel/voice-channel.component.html:17-24`

**Interfaces:** None — pure template deletion.

`voice-channel.component.html:18-23` has member-list (`pi-users`) and invite-link (`pi-link`) icon buttons with **no click handler at all** — they look actionable but silently do nothing, which reads as broken. Building real member-list/invite-link functionality here would duplicate guild-page-wide features (member list drawer, invite generation) that are explicitly owned by the other agent working on the main/guild pages in parallel — so the correct in-scope fix is to remove the dead chrome rather than half-build a cross-cutting feature.

- [ ] **Step 1: Delete the two dead buttons**

In `voice-channel.component.html`, remove this whole block (lines 17-24):

```html
<div class="ml-auto flex items-center gap-1 text-white/45">
    <button class="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-white/[0.05] hover:text-white/60 transition-colors cursor-pointer border-0 bg-transparent">
        <i class="pi pi-users text-base"></i>
    </button>
    <button class="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-white/[0.05] hover:text-white/60 transition-colors cursor-pointer border-0 bg-transparent">
        <i class="pi pi-link text-base"></i>
    </button>
</div>
```

Leave the rest of the header (`<header>` element, mobile nav toggle, channel name + connected count on lines 4-16) exactly as-is — just delete the dead trailing block. If a member-list/invite affordance is wanted here later, it should be added once the other agent's member-list/invite work lands, so it can be reused instead of duplicated.

- [ ] **Step 2: Build and visually verify**

Run `npx ng build`. Then `npm start`, open a guild voice channel, and confirm the header no longer shows the two dead icon buttons (header still shows the channel name and connected count correctly).

- [ ] **Step 3: Commit**

```bash
git add src/app/features/guild/components/voice-channel/voice-channel.component.html
git commit -m "fix: remove non-functional member-list/invite-link buttons from voice channel header"
```

---

## Task 6: Fix DM call Deafen — it currently does not mute remote audio

**Files:**
- Modify: `src/app/services/call-webrtc.service.ts`

**Interfaces:**
- Consumes: `CallSessionService.session().local.isDeafened` (existing field, already toggled correctly by `CallSessionService.toggleDeafen()` — only the WebRTC-side effect is missing).
- Produces: no new public API — the fix lives entirely inside `CallWebRtcService`'s existing `remoteAudio` map and `userVolumes` map (both already private fields on this service, used identically to the working guild implementation in `voice-rtc.service.ts:383-388`'s `setDeafened`).

Verified during research: `CallSessionService.toggleDeafen()` (`call-session.service.ts:87-94`) only flips `s.local.isDeafened` in the UI signal — nothing in `CallWebRtcService` ever reads it. Contrast with the guild voice channel path, where `VoiceRTCService.setDeafened()` correctly zeroes every remote `<audio>` element's volume. Today, clicking Deafen on a DM call visually shows the deafened icon state but you keep hearing everyone.

- [ ] **Step 1: Add a deafen-effect to `CallWebRtcService`**

In `call-webrtc.service.ts`, the constructor already has three effects watching `this.callSession.session()` for mute/camera/sharing (lines 114-156, see the file). Add a fourth effect immediately after the mute effect (after line 126, before the camera effect), mirroring `VoiceRTCService.setDeafened`'s logic exactly but driven reactively instead of via an imperative setter:

```ts
// Apply local deafen state to every remote audio element's volume — mirrors
// VoiceRTCService.setDeafened (voice-rtc.service.ts:383-388) for the guild path.
effect(() => {
    const s = this.callSession.session();
    if (!s) return;
    const isDeafened = s.local.isDeafened;
    this.remoteAudio.forEach((audio, userId) => {
        audio.volume = isDeafened ? 0 : (this.userVolumes.get(userId) ?? 1);
    });
});
```

- [ ] **Step 2: Apply the current deafen state to newly-connecting audio elements too**

Remote participants can join *after* Deafen is already on (the effect above only re-applies volume when `isDeafened` itself changes, not when a new `<audio>` element is created). In `handleRemoteTrack` (around line 526-529), the new element's initial volume is set from `this.userVolumes` only:

```ts
const element = new Audio();
element.srcObject = stream;
element.autoplay = true;
element.volume = this.userVolumes.get(info.userId) ?? 1;
```

Change the volume line to also respect the current deafen state:

```ts
const element = new Audio();
element.srcObject = stream;
element.autoplay = true;
const isDeafened = this.callSession.session()?.local.isDeafened ?? false;
element.volume = isDeafened ? 0 : (this.userVolumes.get(info.userId) ?? 1);
```

- [ ] **Step 3: Verify `setUserVolume` still respects deafen (no regression)**

Read `setUserVolume` (`call-webrtc.service.ts:161-166`) — it unconditionally sets `audio.volume = clamped`, so adjusting a per-user volume slider while deafened would currently un-deafen that one user as a side effect. Guard it the same way the guild path implicitly does (guild's `setUserVolume`, `voice-rtc.service.ts:564`, already checks `!this._isDeafened` before applying volume — match that):

```ts
setUserVolume(userId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.userVolumes.set(userId, clamped);
    const audio = this.remoteAudio.get(userId);
    const isDeafened = this.callSession.session()?.local.isDeafened ?? false;
    if (audio && !isDeafened) audio.volume = clamped;
}
```

- [ ] **Step 4: Build and manually verify with two clients**

Run `npx ng build`. Then start two Alpine sessions (or use a second test account), start a DM call between them, and on one side: click Deafen, confirm you stop hearing the other participant; click Undeafen, confirm audio returns; adjust the per-participant volume slider while deafened and confirm it does **not** un-deafen you.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/call-webrtc.service.ts
git commit -m "fix: DM call Deafen now actually mutes remote audio (previously UI-only)"
```

---

## Task 7: Voice-Activity vs Push-to-Talk mode + input sensitivity

**Files:**
- Modify: `src/app/services/audio-settings.service.ts`
- Modify: `src/app/services/call-webrtc.service.ts`
- Modify: `src/app/services/voice-channel.service.ts`
- Modify: `src/app/services/voice-rtc.service.ts`
- Modify: `src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.ts`
- Modify: `src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.html`

**Interfaces:**
- Produces: `AudioSettings.inputMode: 'voice-activity' | 'push-to-talk'` (default `'voice-activity'`) and `AudioSettings.inputSensitivity: number` (0–100, default `60`), both persisted the same way as every other field in `AudioSettingsService` (via `.update()`/`localStorage`).
- Consumes (DM path): the existing local-speaking `tick()` loop in `CallWebRtcService` (`call-webrtc.service.ts:661-686`), which already computes `rms` every animation frame — extended to also gate `this.audioTrack.enabled`.
- Consumes (guild path): the existing `VoiceRTCService.speakingChanges$` stream (already subscribed to in `VoiceChannelService`'s constructor at `voice-channel.service.ts:92`) and `VoiceRTCService.setupVAD` (`voice-rtc.service.ts:730-751`), whose fixed `avg > 20` threshold becomes sensitivity-driven for the local handle only.

Today the mic transmits continuously with no gating — Voice-Activity mode doesn't exist, only an optional manually-bound Push-to-Talk key (which most users won't have set). This task makes "Voice Activity" a real, working default by reusing the AnalyserNode-based level detection both RTC services already run for the speaking-indicator ring, instead of building a new audio pipeline.

- [ ] **Step 1: Add the two settings fields**

In `audio-settings.service.ts`, add to the `AudioSettings` interface (after `proximitySpatialEnabled`):

```ts
/** How the mic decides when to transmit for regular (non-Isle) calls. */
inputMode: 'voice-activity' | 'push-to-talk';
/** Voice-activity threshold, 0 (least sensitive) – 100 (most sensitive). Ignored in push-to-talk mode. */
inputSensitivity: number;
```

And to `DEFAULTS`:

```ts
inputMode: 'voice-activity',
inputSensitivity: 60,
```

- [ ] **Step 2: Gate the DM call audio track by voice level in `CallWebRtcService`**

In `call-webrtc.service.ts`, add a private constant near the existing `SPEAKING_THRESHOLD` field (line 78):

```ts
private readonly SPEAKING_THRESHOLD = 0.02;
private readonly MAX_VAD_RMS = 0.05;
```

In the local speaking-detection `tick()` function (lines 669-682), after the existing speaking-indicator block, add a call to a new gating method, and pass `rms` through:

```ts
const tick = () => {
    analyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length);
    const speaking = rms > this.SPEAKING_THRESHOLD;
    if (speaking !== this.lastSpeaking) {
        this.lastSpeaking = speaking;
        const s = this.callSession.session();
        const localId = s?.participants.find(p => p.isLocal)?.userId;
        if (localId) this.callSession.onSpeakingChanged(localId, speaking);
    }
    this.applyVadGate(rms);
    this.rafHandle = requestAnimationFrame(tick);
};
```

Add the new method near `setUserVolume` (this service already injects `AudioSettingsService` as `this.audioSettings` and `CallSessionService` as `this.callSession`):

```ts
/**
 * Continuously re-applies the voice-activity transmit gate. Runs every
 * animation frame from the local speaking-detection tick() loop above, so it
 * needs no separate polling loop. No-ops outside voice-activity mode or while
 * deliberately muted — the mute effect (below) already forced enabled=false
 * in that case and this must not override it.
 */
private applyVadGate(rms: number): void {
    if (this.audioSettings.settings().inputMode !== 'voice-activity') return;
    if (!this.audioTrack) return;
    const s = this.callSession.session();
    if (!s || s.local.isMuted) return;
    if (!this.callSession.pttGateOpen()) return;
    const sensitivity = this.audioSettings.settings().inputSensitivity;
    const threshold = this.MAX_VAD_RMS * (1 - sensitivity / 100);
    this.audioTrack.enabled = rms > threshold;
}
```

- [ ] **Step 3: Gate the guild voice channel audio track by voice level in `VoiceRTCService`**

In `voice-rtc.service.ts`, `setupVAD` currently hardcodes the threshold at `avg > 20` (line 742) for every handle, local and remote alike. Make the threshold dynamic **only** for the local handle (remote participants' speaking indicators must stay on the fixed threshold — a local sensitivity setting has no bearing on detecting whether someone else is talking):

```ts
private setupVAD(handle: string, userId: string, stream: MediaStream): void {
    try {
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const isLocal = handle === 'local';
        const MAX_VAD_AVG = 60;

        const id = setInterval(() => {
            analyser.getByteFrequencyData(data);
            const avg = data.reduce((a, b) => a + b, 0) / data.length;
            const threshold = isLocal
                ? MAX_VAD_AVG * (1 - this.audioSettings.settings().inputSensitivity / 100)
                : 20;
            const speaking = avg > threshold;
            this.speakingChanges$.next({userId, isSpeaking: speaking});
        }, 100);

        const prev = this.vadHandles.get(handle);
        if (prev) clearInterval(prev);
        this.vadHandles.set(handle, id);
    } catch { /* AudioContext unavailable */
    }
}
```

(`this.audioSettings` is already injected in this service — confirmed via its existing `audioBitrate` usage in the publish path.)

- [ ] **Step 4: Wire the guild path's gate through `VoiceChannelService`**

`VoiceChannelService` already subscribes to `this.rtc.speakingChanges$` in its constructor (`voice-channel.service.ts:92-97`) purely to update the sidebar/tile `isSpeaking` flag. Extend that same subscription to also drive the transmit gate when the event is for the local user. First, inject `AudioSettingsService` (add near the other `inject()` fields, e.g. after `private soundSettings = inject(SoundSettingsService);`):

```ts
private audioSettings = inject(AudioSettingsService);
```

(add the import: `import {AudioSettingsService} from './audio-settings.service';`)

Then change the constructor subscription from:

```ts
this.rtc.speakingChanges$.subscribe(({userId, isSpeaking}) => {
    const channelId = this.joinedChannelId();
    if (channelId) {
        this.patchParticipant(channelId, userId, p => p.isSpeaking === isSpeaking ? p : {...p, isSpeaking});
    }
});
```

to:

```ts
this.rtc.speakingChanges$.subscribe(({userId, isSpeaking}) => {
    const channelId = this.joinedChannelId();
    if (channelId) {
        this.patchParticipant(channelId, userId, p => p.isSpeaking === isSpeaking ? p : {...p, isSpeaking});
    }
    const ownId = this.profileService.ownProfile()?.userId;
    if (channelId && userId === ownId) this.applyVadGate(isSpeaking);
});
```

Add the new method near `toggleDeafen` (this service already exposes `this.pttGateOpen` as a signal and `this.localState()` for `isMuted`):

```ts
/** Re-applies the voice-activity transmit gate. No-op outside voice-activity mode. */
private applyVadGate(isSpeaking: boolean): void {
    if (this.audioSettings.settings().inputMode !== 'voice-activity') return;
    const {isMuted} = this.localState();
    if (isMuted) return;
    if (!this.pttGateOpen()) return;
    this.rtc.setMicEnabled(isSpeaking);
}
```

- [ ] **Step 5: Add the settings UI**

In `voice-video-settings.component.ts`, add two getter/setter pairs next to the existing `noiseSuppression` pair (same pattern as every other field in this file):

```ts
get inputMode(): 'voice-activity' | 'push-to-talk' {
    return this.audioSettings.settings().inputMode;
}

set inputMode(v: 'voice-activity' | 'push-to-talk') {
    this.audioSettings.update({inputMode: v});
}

get inputSensitivity(): number {
    return this.audioSettings.settings().inputSensitivity;
}

set inputSensitivity(v: number) {
    this.audioSettings.update({inputSensitivity: v});
}
```

Add a readonly options array for the radio rows, next to the other readonly option arrays:

```ts
readonly inputModeOptions: {value: 'voice-activity' | 'push-to-talk'; label: string; desc: string}[] = [
    {value: 'voice-activity', label: 'Voice Activity', desc: 'Transmit automatically when your mic level crosses the sensitivity threshold below'},
    {value: 'push-to-talk', label: 'Push to Talk', desc: 'Only transmit while your bound key is held — bind it on the Keybinds page'},
];
```

Add the `RadioButton` import (`import {RadioButton} from 'primeng/radiobutton';`) and add `RadioButton` to the component's `imports` array.

In `voice-video-settings.component.html`, insert a new "Input Mode" section between the "Microphone" section (ends line 70) and the "Speaker" section (starts line 72), using the exact row style already established in `privacy-settings.component.html:11-18` and the exact "Voice Gate Strength" slider pattern already in this same file (lines 148-157):

```html
<!-- ── Input Mode ────────────────────────────────────────────────────── -->
<section class="flex flex-col gap-3">
    <h2 class="text-xs font-semibold text-white/30 uppercase tracking-widest border-b border-white/[0.10] pb-3">
        Input Mode
    </h2>

    <div class="flex flex-col gap-2">
        @for (opt of inputModeOptions; track opt.value) {
            <label class="flex items-center justify-between bg-white/[0.03] border border-white/[0.10] rounded-xl px-4 py-3 cursor-pointer">
                <div>
                    <p class="text-sm text-white/75">{{ opt.label }}</p>
                    <p class="text-xs text-white/35 mt-0.5">{{ opt.desc }}</p>
                </div>
                <p-radiobutton [(ngModel)]="inputMode" [value]="opt.value" name="inputMode"/>
            </label>
        }
    </div>

    @if (inputMode === 'voice-activity') {
        <div class="flex flex-col gap-2 bg-white/[0.03] border border-white/[0.10] rounded-xl px-4 py-3">
            <div class="flex items-center justify-between">
                <p class="text-sm text-white/75">Input Sensitivity</p>
                <span class="text-xs text-white/40 tabular-nums">{{ inputSensitivity }}%</span>
            </div>
            <p class="text-xs text-white/35 -mt-1">Higher = picks up quieter sounds. Lower it if your mic keeps
                transmitting background noise between words.</p>
            <p-slider [(ngModel)]="inputSensitivity" [max]="100" [min]="0" [step]="5" styleClass="w-full mt-1"/>
        </div>
    }
</section>
```

- [ ] **Step 6: Build and manually verify**

Run `npx ng build`. Then `npm start`, open Settings → Voice & Video, confirm the new "Input Mode" section shows between Microphone and Speaker, with Voice Activity selected by default and the sensitivity slider visible; switching to Push to Talk hides the slider. Join a DM call and a guild voice channel in turn with Voice Activity selected: confirm the mic only transmits while talking (test by having the other party watch for the mute icon / speaking ring). Switch to Push to Talk, confirm behavior reverts to today's keybind-gated behavior.

- [ ] **Step 7: Commit**

```bash
git add src/app/services/audio-settings.service.ts src/app/services/call-webrtc.service.ts src/app/services/voice-channel.service.ts src/app/services/voice-rtc.service.ts src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.ts src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.html
git commit -m "feat: add real Voice Activity / Push-to-Talk input mode with sensitivity threshold"
```

---

## Task 8: Camera preview thumbnail in Voice & Video settings

**Files:**
- Modify: `src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.ts`
- Modify: `src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.html`

**Interfaces:**
- No new public API — self-contained addition to `VoiceVideoSettingsComponent`, following the exact same `getUserMedia`/cleanup lifecycle pattern already used by `startMic`/`stopMic` in this same file.

The Camera section currently has only a bare device-picker dropdown with zero visual feedback, unlike the Microphone section right above it (which has a live level meter). Add a live camera preview, gated behind a "Test Camera" toggle exactly like the mic test, so an idle Settings page never silently holds the camera open.

- [ ] **Step 1: Add camera test state and lifecycle methods**

In `voice-video-settings.component.ts`, add near `isMicActive`:

```ts
readonly isCameraActive = signal(false);
private cameraStream: MediaStream | null = null;
```

Add methods near `toggleMicTest`/`startMic`/`stopMic`, using `AudioSettingsService.buildVideoConstraint()` (already exists, `audio-settings.service.ts:92-95`) exactly like `startMic` uses `buildAudioConstraint()`:

```ts
async toggleCameraTest(): Promise<void> {
    if (this.isCameraActive()) {
        this.stopCameraTest();
    } else {
        await this.startCameraTest();
    }
}

private async startCameraTest(): Promise<void> {
    if (!navigator?.mediaDevices) return;
    try {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
            video: await this.audioSettings.buildVideoConstraint(),
        });
        this.isCameraActive.set(true);
    } catch {
        // Denied or unavailable — the existing permissionError banner covers the mic case;
        // camera failures just leave the preview empty, matching the picker's own silent failure mode.
    }
}

private stopCameraTest(): void {
    this.cameraStream?.getTracks().forEach(t => t.stop());
    this.cameraStream = null;
    this.isCameraActive.set(false);
}
```

Call `this.stopCameraTest();` from the existing `ngOnDestroy` (alongside the existing `this.stopMic();`):

```ts
ngOnDestroy(): void {
    this.stopMic();
    this.stopCameraTest();
}
```

Restart the preview when the selected camera changes while the test is active — extend the existing `selectedCameraId` setter:

```ts
set selectedCameraId(v: string) {
    this.audioSettings.update({cameraId: v});
    if (this.isCameraActive()) {
        this.stopCameraTest();
        void this.startCameraTest();
    }
}
```

- [ ] **Step 2: Add the `StreamSrcDirective` import for binding the live stream to a `<video>` element**

Every other place in the call UI binds a `MediaStream` to a `<video>` via `[streamSrc]` (see `call-participant-tile.component.html:35`). Add the import in `voice-video-settings.component.ts`:

```ts
import {StreamSrcDirective} from '../../../../../directives/stream-src.directive';
```

Add `StreamSrcDirective` to the component's `imports` array, and add a signal exposing the stream to the template (template can't read the private `cameraStream` field directly):

```ts
readonly cameraPreviewStream = computed(() => this.isCameraActive() ? this.cameraStream : null);
```

`computed()` re-evaluating a private mutable field isn't reactive on its own — instead, expose it as a signal set alongside `isCameraActive`. Replace the plan above: keep `cameraStream` as a signal, not a plain field:

```ts
readonly cameraStream = signal<MediaStream | null>(null);
```

and update `startCameraTest`/`stopCameraTest` to use `this.cameraStream.set(...)` / read via `this.cameraStream()` instead of the plain field, matching the signal-based style the rest of this component already uses (`micLevel`, `isMicActive`, etc.):

```ts
private async startCameraTest(): Promise<void> {
    if (!navigator?.mediaDevices) return;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: await this.audioSettings.buildVideoConstraint(),
        });
        this.cameraStream.set(stream);
        this.isCameraActive.set(true);
    } catch {
        // See Step 1 note.
    }
}

private stopCameraTest(): void {
    this.cameraStream()?.getTracks().forEach(t => t.stop());
    this.cameraStream.set(null);
    this.isCameraActive.set(false);
}
```

- [ ] **Step 3: Add the preview UI**

In `voice-video-settings.component.html`, the Camera section currently ends at line 99 with just the device picker. Add a preview block after it, matching the visual language of the Microphone test card (lines 17-38) — a bordered card with a Test/Stop button, but showing video instead of a level meter:

```html
<!-- ── Camera ────────────────────────────────────────────────────────── -->
<section class="flex flex-col gap-4">
    <h2 class="text-xs font-semibold text-white/30 uppercase tracking-widest border-b border-white/[0.10] pb-3">
        Camera
    </h2>

    <div class="flex flex-col gap-1.5">
        <label class="text-xs font-medium text-white/45 uppercase tracking-wide">Video Device</label>
        <p-select [(ngModel)]="selectedCameraId" [options]="cameraOptions()" optionLabel="label"
                  optionValue="value" placeholder="Select camera"
                  styleClass="w-full"/>
    </div>

    <!-- Preview card -->
    <div class="flex flex-col gap-3 bg-white/[0.03] border border-white/[0.10] rounded-xl p-4">
        <div class="flex items-center justify-between gap-4">
            <div>
                <p class="text-sm text-white/75">Preview</p>
                <p class="text-xs text-white/35 mt-0.5">
                    @if (isCameraActive()) {
                        Live preview from the selected camera
                    } @else {
                        Start the test to preview your camera
                    }
                </p>
            </div>
            <button (click)="toggleCameraTest()"
                    [ngClass]="isCameraActive()
        ? 'bg-rose-500/15 border-rose-500/30 text-rose-400 hover:bg-rose-500/25'
        : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/25'"
                    class="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
             border cursor-pointer transition-all whitespace-nowrap">
                <i [class]="isCameraActive() ? 'pi pi-stop-circle' : 'pi pi-video'" class="text-[11px]"></i>
                {{ isCameraActive() ? 'Stop' : 'Test Camera' }}
            </button>
        </div>

        @if (isCameraActive() && cameraStream(); as stream) {
            <video [streamSrc]="stream" autoplay class="w-full aspect-video rounded-lg bg-black object-cover"
                   muted playsinline></video>
        }
    </div>
</section>
```

- [ ] **Step 4: Build and manually verify**

Run `npx ng build`. Then `npm start`, open Settings → Voice & Video, click "Test Camera", and confirm a live self-view appears; switch the camera device dropdown while active and confirm the preview restarts against the new device; click "Stop" and confirm the camera light/indicator turns off (stream tracks actually stopped, not just hidden).

- [ ] **Step 5: Commit**

```bash
git add src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.ts src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.html
git commit -m "feat: add live camera preview to Voice & Video settings"
```

---

## Task 9: Unify DM call panel with the guild voice channel's floating-glass visual language + fix context menu viewport clamp

**Files:**
- Modify: `src/app/shared/call/call-controls-bar/call-controls-bar.component.html`
- Modify: `src/app/features/guild/components/voice-channel/voice-channel.component.html`
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.html`
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.css`
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.ts`

**Interfaces:** None — template/CSS restructuring plus one method-body change (context menu clamp).

Two related fixes: (1) the DM call panel is a flat docked bar with a plain top border while the guild voice channel gets a floating glass pill (`backdrop-blur-xl`, drop shadow) for the same "call controls" concept — this task moves that treatment into the shared component itself so both surfaces get it automatically and consistently. (2) Along the way, a layering bug is fixed: `CallControlsBarComponent`'s own template root currently hardcodes an **opaque** `bg-sidebar`, which paints over — and defeats — the translucent `bg-black/60 backdrop-blur-xl` classes the guild voice channel currently (redundantly, and ineffectively) applies from the outside. (3) `call-panel`'s participant context menu doesn't clamp to the viewport (can render off-screen near a window edge) while the guild voice channel's equivalent does — fixed by copying the guild clamp logic.

- [ ] **Step 1: Bake the floating-glass treatment into the shared controls bar itself**

In `call-controls-bar.component.html`, change the root `<div>` (line 1) from:

```html
<div class="shrink-0 border-t border-white/[0.10] bg-sidebar px-4 py-4 flex items-center justify-center gap-3">
```

to:

```html
<div class="shrink-0 bg-black/60 backdrop-blur-xl border border-white/10 rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] px-4 py-4 flex items-center justify-center gap-3">
```

- [ ] **Step 2: Remove the now-redundant classes from the guild voice channel caller**

In `voice-channel.component.html`, the `<app-call-controls-bar>` call (lines 103-121) currently duplicates the styling now baked into the component itself via its outer `class` binding:

```html
class="pointer-events-auto shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-2xl overflow-hidden border border-white/10 bg-black/60 backdrop-blur-xl"
```

Simplify to just the positioning/interaction concern, which is the wrapping `<div>`'s job, not the component's:

```html
class="pointer-events-auto"
```

- [ ] **Step 3: Restructure `call-panel.component.html` to float the controls bar over the content**

Currently the controls bar is a normal bottom-docked flex child (template lines 149-166), directly followed by the resize handle. Wrap the content area (status bar through participants/focused/screen-share, i.e. everything between the top status bar and the controls bar) in a `relative` positioned container, and float the controls bar over it exactly like the guild voice channel does. Change the structure from:

```html
<!-- ── Focused stream view / screen share / participants (unchanged content) ── -->
@if (focusedStream(); as focused) {
    ...
} @else if (callScreenShares().length > 0) {
    ...
} @else {
    <div [attr.data-count]="s.participants.length" class="participants">
        ...
    </div>
}

<!-- ── Controls bar ────────────────────────────────────────────────────── -->
<app-call-controls-bar ... />

<!-- ── Resize handle ───────────────────────────────────────────────────── -->
<div (mousedown)="onResizeStart($event)" class="resize-handle">
```

to:

```html
<!-- ── Content + floating controls ─────────────────────────────────────── -->
<div class="relative flex-1 min-h-0 flex flex-col">
    @if (focusedStream(); as focused) {
        ...
    } @else if (callScreenShares().length > 0) {
        ...
    } @else {
        <div [attr.data-count]="s.participants.length" class="participants">
            ...
        </div>
    }

    <!-- ── Floating controls bar ───────────────────────────────────────── -->
    <div class="absolute bottom-3 left-0 right-0 flex justify-center z-20 pointer-events-none">
        <app-call-controls-bar
                (cameraToggle)="toggleCamera()"
                (deafenToggle)="toggleDeafen()"
                (disconnect)="endCall()"
                (fpsChange)="setCaptureFps($event)"
                (muteToggle)="toggleMute()"
                (resolutionChange)="setScreenResolution($event)"
                (screenShareToggle)="toggleScreenShare()"
                [captureFps]="rustMedia.captureFps()"
                [captureResolution]="rustMedia.captureResolution()"
                [isCameraOn]="s.local.isCameraOn"
                [isDeafened]="s.local.isDeafened"
                [isMuted]="s.local.isMuted"
                [isScreenSharing]="s.local.isSharing"
                [screenHasAudio]="false"
                class="pointer-events-auto"
                disconnectLabel="End Call"
        />
    </div>
</div>

<!-- ── Resize handle ───────────────────────────────────────────────────── -->
<div (mousedown)="onResizeStart($event)" class="resize-handle">
```

(The inner `@if`/`@else if`/`@else` content itself is unchanged — only its wrapping div and what follows it moved. Leave the top status bar, connection banner, and stats bar exactly where they are, above this new wrapper.)

- [ ] **Step 4: Give scrollable content room so it isn't hidden behind the floating pill**

The `.participants` grid (CSS in `call-panel.component.css:146-156`) currently has no bottom padding, since it used to end right above the docked controls bar. Add bottom padding so the last row of tiles isn't visually covered by the new floating pill:

```css
.participants {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 8px;
    padding: 10px 12px 76px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
}
```

(only the `padding` line changes, from `10px 12px` to `10px 12px 76px`.)

Also add bottom padding to `.focused-view`'s margin (`call-panel.component.css:180`) so the floating pill doesn't sit on top of the focused video — change:

```css
.focused-view {
    flex: 1;
    min-height: 0;
    position: relative;
    background: #000;
    margin: 10px 12px 6px;
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
}
```

to add `76px` bottom margin instead of `6px`:

```css
.focused-view {
    flex: 1;
    min-height: 0;
    position: relative;
    background: #000;
    margin: 10px 12px 76px;
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
}
```

- [ ] **Step 5: Fix the missing viewport clamp on the DM call panel's context menu**

In `call-panel.component.ts`, `onParticipantContextMenu` (lines 225-231) sets the menu position directly from the click coordinates with no clamping, unlike the guild voice channel's equivalent (`voice-channel.component.ts:113-121`, which clamps against a `236`×`200` menu footprint). Change:

```ts
protected onParticipantContextMenu(event: MouseEvent, p: CallParticipant): void {
    if (p.isLocal) return;
    event.preventDefault();
    event.stopPropagation();
    const volume = Math.round(this.callWebRtc.getUserVolume(p.userId) * 100);
    this.participantMenu.set({x: event.clientX, y: event.clientY, participant: p, volume});
}
```

to:

```ts
protected onParticipantContextMenu(event: MouseEvent, p: CallParticipant): void {
    if (p.isLocal) return;
    event.preventDefault();
    event.stopPropagation();
    const volume = Math.round(this.callWebRtc.getUserVolume(p.userId) * 100);
    const x = Math.min(event.clientX, window.innerWidth - 236);
    const y = Math.min(event.clientY, window.innerHeight - 200);
    this.participantMenu.set({x: Math.max(0, x), y: Math.max(0, y), participant: p, volume});
}
```

- [ ] **Step 6: Build and visually verify**

Run `npx ng build`. Then `npm start`: open a DM call and confirm the controls bar now floats as a rounded, blurred glass pill over the participant grid (not a flat docked bottom bar), matching the guild voice channel's look; resize the panel via its drag handle and confirm no content is hidden behind the pill at any height; right-click a participant near the right/bottom edge of the window in both a DM call and a guild voice channel and confirm the context menu stays fully on-screen in both cases now.

- [ ] **Step 7: Commit**

```bash
git add src/app/shared/call/call-controls-bar/call-controls-bar.component.html src/app/features/guild/components/voice-channel/voice-channel.component.html src/app/features/messaging/components/conversation/call-panel/call-panel.component.html src/app/features/messaging/components/conversation/call-panel/call-panel.component.css src/app/features/messaging/components/conversation/call-panel/call-panel.component.ts
git commit -m "feat: unify DM call panel and guild voice channel controls into one floating-glass visual language"
```

---

## Task 10: Delete orphaned legacy CSS in `call-panel.component.css`

**Files:**
- Modify: `src/app/features/messaging/components/conversation/call-panel/call-panel.component.css`

**Interfaces:** None — deletion only, verified by the fact that `call-panel.component.html` (after Task 9's edits) references none of the removed class names.

Roughly 500 lines of this 798-line file are dead: `.tile`, `.tile--speaking`, `.avatar-ring`, `.ring--speaking` (+ its own now-superseded copy of the `speaking-ring` keyframe — the shared one now lives in `src/styles.css` per Task 2), `.avatar-img`, `.avatar-video`, `.avatar-fallback`, `.tile-footer`, `.tile-name`, `.tile-icons`, `.icon-badge`, `.icon-badge--muted`, `.tile-overlay-actions`, `.tile-action-btn`, `.tile-expand`, `.shares-row`, `.share-tile`, `.share-preview`, `.share-video`, `.share-expand`, `.share-empty`, `.share-footer`, `.share-label`, `.share-fps`, `.join-btn`, `.controls`, `.ctrl-btn` (+ variants), `.ctrl-divider`, `.fps-selector`, `.fps-btn` (+ variants), `.ctrl-btn--end`, `.vol-menu` (+ its rows/slider — now fully superseded by Task 1's `call-context-menu.component.css`), `.no-audio-badge`, and the `live-pulse` / `rtc-pulse` keyframes (superseded by the shared `rtc-status-pulse` from Task 1, but verify `.live-dot`/`.status-label`/`.stats-*` classes in the *status bar* are still used — they are, that section stays).

- [ ] **Step 1: Confirm which classes are still referenced before deleting anything**

Run this from the repo root to list every class name defined in the CSS file, then check each against the current template:

```bash
grep -oE '^\.[a-zA-Z][a-zA-Z0-9_-]*' src/app/features/messaging/components/conversation/call-panel/call-panel.component.css | sort -u
```

For each name printed, run:

```bash
grep -c '"CLASS_NAME"' src/app/features/messaging/components/conversation/call-panel/call-panel.component.html
```

(replace `CLASS_NAME` with the bare class, e.g. `tile`, `avatar-ring` — the audit already identified the ones below as unused, but re-verify against the *current* template state after Task 9's edits, since Task 9 changed this file too.)

- [ ] **Step 2: Delete the confirmed-dead sections**

Remove these blocks entirely from `call-panel.component.css` (identified by their section comments in the current file): "Participant tile" (`.tile`, `.tile--speaking`), "Avatar ring" (`.avatar-ring` through `.avatar-fallback`), "Tile footer" (`.tile-footer` through `.icon-badge--muted`), "Tile overlay actions" (`.tile-overlay-actions` through `.tile-expand:hover`), "Screen shares" (`.shares-row` through `.join-btn:hover`), "Controls bar" (`.controls` through `.ctrl-btn--end:hover` — note: this is the *old*, pre-Task-9 controls styling; the shared `CallControlsBarComponent` now owns all controls styling), and "Volume context menu" (`.vol-menu` through `.vol-value` — fully superseded by `call-context-menu.component.css` from Task 1). Also delete the `@keyframes speaking-ring` block at the very end (superseded by the shared one in `src/styles.css`, added in Task 2).

Keep: "Panel shell" (`.panel`, `.panel--resizing`), "Resize handle", "Status bar" (`.status-bar`, `.stats-toggle*`, `.live-dot*`, `.status-label*`), "Stats bar" (`.stats-*`), "Focused stream view" (`.focused-view` through `.focused-video--mirror`), "Connection state variants" (`.live-dot--connecting` through `.status-label--failed`), "Connection banners" (`.conn-banner*`), "No-audio badge" (`.no-audio-badge`), and the `@keyframes live-pulse` / `@keyframes rtc-pulse` blocks (still used by `.live-dot` / `.live-dot--connecting` / `.live-dot--failed` in the status bar, which is untouched by Task 9).

- [ ] **Step 3: Build and verify no visual regression**

Run `npx ng build` (a stray reference to a deleted class would only be a silent no-op in CSS, not a build error — so this step is really "Step 1's grep audit was accurate," not a compiler check). Then `npm start`, open a DM call, and visually compare against Task 9's verification screenshot/state: status bar, connection banners, stats toggle, focused view, participant grid, and the floating controls bar should all look identical to right after Task 9 — this task only removes unreferenced CSS, so nothing should visibly change.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/messaging/components/conversation/call-panel/call-panel.component.css
git commit -m "chore: remove ~500 lines of orphaned legacy CSS from call-panel.component.css"
```

---

## Self-Review Notes

- **Spec coverage:** All 8 in-scope items from the audit are covered — sidebar speaking ring (Task 2), controls-bar press feedback (Task 3), dead speaking-ring keyframe wired in (Task 4), dead header buttons removed (Task 5), PTT/VA mode + sensitivity (Task 7), camera preview (Task 8), unified visual language + context-menu clamp (Task 9), and CSS/keyframe/slider cleanup (Task 1 + Task 10). Two real bugs found during research (dead `vc-rtc-pulse`/`.vc-volume-slider` styles, non-functional DM Deafen) are fixed in Tasks 1 and 6 respectively, flagged explicitly in Global Constraints so they're not mistaken for scope creep.
- **Sound explicitly excluded:** confirmed no task touches `sound-settings.service.ts` or `notification-settings.*`.
- **Scope boundary respected:** no task touches `guild-member-list`, invite features, or main-page files — Task 5 explicitly chooses deletion over rebuilding those features for exactly this reason.
- **Task ordering:** Task 1 (shared keyframes) precedes Tasks 2, 4, 9, 10 which consume them. Task 2's `speaking-ring` keyframe precedes Task 4 which consumes it. Task 9 (restructures `call-panel.component.html`/`.css`) precedes Task 10 (deletes now-confirmed-dead CSS in the same file) so the dead-code audit in Task 10 Step 1 runs against the final template state.
