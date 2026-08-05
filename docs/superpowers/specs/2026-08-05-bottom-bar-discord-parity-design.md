# Bottom Bar — Discord Parity

**Date:** 2026-08-05
**Status:** Approved, ready for implementation planning

## Problem

The left panel's footer — the activity strip, the user row, and the self popover it opens — has drifted from the interaction model it was modelled on, in three separate ways.

**It reports the wrong thing.** The status dot at `quick-settings.component.html:52-56` is bound to `MessagingWebsocketService.connectionState()`, not to the user's `onlineStatus`. Setting yourself to Invisible leaves a green dot and the word "Connected" under your name. The app has a `UserStatusDotComponent` that renders presence correctly and is used by every other surface; the bar hand-rolls three background classes instead.

**It hides controls that should be permanent.** Mic and deafen render only inside `@if (voiceSvc.isInVoice())`, so the row changes shape on join, and there is no way to arrive in a channel already muted. There is no device selection anywhere except the settings modal.

**It reads as ruled rather than layered.** The activity strip is a full-bleed row separated by a `border-b` hairline, which makes the footer look like a table. Reference designs separate these regions by elevation — an inset rounded card on a lighter surface — which is what produces the soft appearance being asked for.

Reference screenshots: `discord_presence_ex.png` (the bar), `discord_presence_ex2.png` (the popover).

## Scope

In:

- Visual and interaction parity for the footer and the self popover
- Correcting the status dot and the subtitle to report presence
- Always-visible mic and headset controls with device-selection chevrons
- Sticky global mute that survives joining and leaving a channel
- A share button on the activity card, wired to the existing screen-share path

Out, deliberately:

- **Custom status.** No setter and no display. Nothing can write one today, so a read-only surface for it would always be empty.
- **Clips.** Not a feature this app has.
- **Badges and pronouns** in the popover header. No data source.
- **Cover-art delivery.** `ActivityAssets` documents (`activity.model.ts:38-46`) that the server-side image proxy is Phase 2 and every activity arrives with `assets: null`. The monogram tile is the shipped design for now, not a placeholder — the art slot is already sized so a real `largeImageUrl` is a swap rather than a re-layout.

## Approach

Extract components per concern rather than restyling in place. `quick-settings.component.html` is already 113 lines covering avatar, name, activity, and five buttons; adding two dropdown menus and a share flow to it would push it past 200 lines with three conditional button states. Splitting it also removes a real duplication: device enumeration currently lives inline in `voice-video-settings.component.ts:238-247` and the chevron menus need the same data.

## §1 — Anatomy and visual language

Three stacked regions under the side panel, separated by elevation rather than hairlines:

```
├─ app-voice-status-bar        (existing, unchanged, only while in voice)
│
│  ╭──────────────────────────────╮   ← inset card: mx-2 mt-2, rounded-xl,
│  │ ┌──┐  Microsoft Flight Sim…  │     bg-card, hover bg-hover, no border
│  │ │FS│  Not Sharing       [↗]  │
│  │ └──┘                         │
│  ╰──────────────────────────────╯
│
│  [👤]  fakePilotDominic   [🎤˅] [🎧˅] [⚙]
│    ○   Invisible
└─
```

| | Current | Target |
|---|---|---|
| Footer top border | `border-white/[0.10]` | `border-border-subtle` (0.08) |
| Footer padding | `p-3` | `px-2 py-2` |
| Activity strip | full-bleed, `border-b border-white/[0.06]` | `mx-2 mt-2 p-2 rounded-xl bg-card`, hover `bg-hover`, no border |
| Art tile | 40px, `pi` glyph on `bg-white/[0.06]` | 40px `rounded-lg`; `largeImageUrl` when present, else the brand-tinted monogram tile from `activity-card.component.ts:42` |
| Buttons | 28px box, `text-sm` icon | 32px box, ~18px icon, `rounded-lg`, hover `bg-white/[0.06]` |
| Transition | `transition-colors` (150ms) | 120ms ease-out |

The `w-0 min-w-full` on the footer root is preserved. Its existing comment explains why: the footer is a child of a `flex flex-col` whose width is intrinsic to the 68px server rail plus the 240px side panel, and a normally-sized footer stretches that calculation and overhangs the sidebar. Removing it re-breaks the overhang.

## §2 — Behavior and data

### Status truth

The avatar dot binds `app-user-status-dot` to `profileService.ownProfile()?.onlineStatus`, replacing the three hand-rolled classes. `UserStatusDotComponent.colorClass()` (`user-status-dot.component.ts:41`) currently returns four solid circles distinguished only by hue; it becomes a `classes()` that also applies a CSS mask, so status is distinguishable without colour:

| Status | Shape |
|---|---|
| Online | Filled circle |
| Idle | Crescent (notch top-left) |
| Do Not Disturb | Circle with a horizontal bar |
| Invisible / Offline / null | Hollow ring |

This is a change to the shared component, so it applies app-wide — member list, DM rows, profile cards — which is intended.

`OnlineStatus.Hidden` is labelled **"Invisible"** everywhere — both the subtitle and the status menu row. `status-picker.component.ts:22` currently calls it "Appear Offline"; that wording is retired, and `STATUS.INVISIBLE` is the only key for it.

### Subtitle precedence

One `computed()` drives the line under the name:

| Condition | Renders |
|---|---|
| `connectionState() !== Connected` | `<app-connection-status>` — amber "Connecting…", rose "Disconnected" |
| Otherwise | The status label: Online / Idle / Do Not Disturb / Invisible |

The game name leaves this slot entirely (the card above owns it), so the `@if (!ownActivity())` suppression at `quick-settings.component.html:65` is removed. The subtitle is always present, so the row no longer changes height when a game starts.

### Sticky global mute

`VoiceChannelService.localState` becomes a persisted preference rather than per-call state. All four edits are required together; any subset leaves the button lying about what the room hears.

| Site | Current | Change |
|---|---|---|
| `voice-channel.service.ts:187` (join) | resets all four flags | preserve `isMuted`/`isDeafened`; reset only `isCameraOn`/`isScreenSharing` |
| `:248` (leave) | same reset | same preservation |
| `:431` (remote takeover) | same reset | same preservation |
| `:201` (own participant) | hardcoded `isMuted: false` | seed from `localState()` |
| after `:229` (`syncMic()`) | nothing broadcasts | add `invokeVoiceMuteChanged` and `invokeVoiceDeafenChanged` so the room sees the joined-muted state |

Persisted to `localStorage` under `alpine_voice_local_state`, read in the `localState` signal initializer. Only `isMuted` and `isDeafened` persist; camera and screen-share never do.

`syncMic()` at `:291` already pushes unconditionally to the voice engine, so toggling mute outside a call takes effect on the microphone immediately — which is the behavior being asked for.

### Device chevrons

New `MediaDeviceCatalogService`:

- `mics` and `speakers` signals of `{label, value}`
- Populated by `enumerate_audio_devices` and `enumerate_output_devices`, the Tauri commands currently invoked inline at `voice-video-settings.component.ts:241-242`
- Refreshed on menu open and on `navigator.mediaDevices.devicechange`
- `voice-video-settings.component.ts` is refactored to consume it, so enumeration exists in exactly one place. Camera enumeration stays in the settings page — the bar has no camera control.

Writes go through the existing `AudioSettingsService.update({micId})` / `({speakerId})`. No new persistence is introduced; the stored value remains the platform device *name*, per the contract documented at `audio-settings.service.ts:5-15`.

`VoiceToggleComponent` is instantiated twice and is not mic-specific: the **mic** instance toggles `voiceSvc.toggleMute()` and its chevron lists `catalog.mics()`, writing `micId`; the **headset** instance toggles `voiceSvc.toggleDeafen()` and its chevron lists `catalog.speakers()`, writing `speakerId`. Everything else — icon, active icon, active tint, menu shape — comes in as inputs.

Each chevron opens a `p-menu`: the device list with the current selection check-marked, a divider, then a "Voice Settings" item opening the modal. When enumeration throws — the browser build, where there is no Tauri side — the menu degrades to "Voice Settings" alone.

### Share button

`pi-desktop`, 32px, at the right edge of the activity card.

| State | Render | Click |
|---|---|---|
| Not in voice | 40% opacity, non-interactive, tooltip "Join a voice channel to share" | — |
| In voice, not sharing | `text-white/50`, hover `bg-white/[0.06]` | Set the preselect hint, then `voiceSvc.toggleScreenShare()` |
| Sharing | `bg-brand/15 text-brand-dim` | Stops the share |

Line two of the card becomes **Not Sharing / Sharing**, driven by `voiceSvc.localState().isScreenSharing`. The game's own `details` and `state` are not lost: `app-activity-card` already renders them inside the profile popover (`profile-card.component.html:57`), which is where the reference design puts them too.

The disabled state is a real constraint, not a stylistic choice — `toggleScreenShare()` early-returns at `voice-channel.service.ts:319-321` unless both `joinedGuildId` and `joinedChannelId` are set.

### Source preselect

A pure function in `models/source-match.ts`:

```
bestSourceMatch(activityName: string, sources: ScreenSource[]): string | null
```

Normalizes both sides (lowercase, strip punctuation and trailing version suffixes), scores by shared-token overlap, and requires a minimum score so a weak guess returns `null` rather than preselecting the wrong window. `ScreenPickerService` gains a `preferredSourceId` signal that `screen-picker.component.ts` highlights and scrolls to. The user still confirms; nothing auto-publishes. `ScreenSource.name` is the window title (`rust-media.service.ts:6-13`), which is what makes the match possible at all.

## §3 — The popover

`profile-card` is unchanged for other users; `profile-dialog.component.html:18` keeps passing `friendsSince`. What changes is that the self popover stops borrowing it.

To avoid duplicating the banner and avatar rendering, extract `app-profile-header` — banner, accent-colour fallback, overlapping avatar, status dot, username, bio — out of `profile-card.component.html:1-46`. `profile-card` keeps activities and the Member Since / Friends Since block below it; the self menu uses the header alone.

```
┌─ app-profile-header ─────────────────┐
│  [banner]                            │
│  (avatar)○   fakePilotDominic        │
│              bio…                    │
└──────────────────────────────────────┘
 ╭─ menu card ─────────────────────────╮
 │  ✏   Edit Profile                   │
 │  ───────────────────────────────    │
 │  🛡   Admin Panel                    │   ← admins only
 │  ───────────────────────────────    │
 │  ○   Invisible                   ›  │
 ╰─────────────────────────────────────╯
 ╭─ menu card ─────────────────────────╮
 │  👤  Switch Accounts             ›  │   ← or "＋ Add Account" when
 ╰─────────────────────────────────────╯      others().length === 0
```

Submenus are an **in-popover view swap**, not nested popovers: `view = signal<'root' | 'status' | 'accounts'>('root')` with a slide transition and a `‹ back` header. Nested `p-menu` instances inside a `p-popover` that is `appendTo="body"` create z-index and dismissal problems; a view swap avoids them and matches the reference behavior.

- **Status view** — the four options currently defined at `status-picker.component.ts:18-23`, each rendered as a row with its shaped dot. `StatusPickerComponent` is then deleted; those `menuItems` were its only remaining value.
- **Accounts view** — the rows from `account-switcher.component.html:9-33`, unchanged, with "Add Account" as the final row. `account-switcher` stops rendering its `others()` list inline.
- **Admin row** — gated on `userService.self()?.userType === UserType.Admin`, opening the existing `app-admin-modal` unchanged. This removes the shield from the bar without turning the admin UI into a settings page.

**Modal ownership.** `app-settings-modal` and `app-admin-modal` stay hosted by `quick-settings` (`quick-settings.component.html:1-2`). `quick-settings` already owns an `effect()` that honours `SettingsUiService.requestedPage()` from the titlebar, and it holds the `@ViewChild(SettingsModalComponent)` that `openProfileSettings()` needs. So `self-profile-menu` opens neither modal directly — it emits `editProfile`, `openAdmin`, and `addAccount` outputs, which `self-profile-popover` forwards to `quick-settings`, extending the pattern already used for `editProfile` at `self-profile-popover.component.html:7`.

Menu row spec: 40px tall, `px-3 gap-3 rounded-lg`, 16px icon `text-text-secondary`, 14px label `text-text-primary`, hover `bg-hover`, trailing chevron `pi-chevron-right` 12px `text-text-muted`. Dividers are `border-t border-border-subtle` inset `mx-3` inside the card — never full-bleed.

**Dropped for self:** Member Since and Friends Since. Friends-since on your own profile is meaningless, and member-since is biography that already appears in the full profile view.

## §4 — Files

### New

| Path | Purpose |
|---|---|
| `components/profile-header/` | Banner + avatar + dot + name + bio, extracted from `profile-card` |
| `main-page/components/self-activity-card/` | The inset activity card and its share button |
| `main-page/components/voice-toggle/` | Icon button plus chevron menu; instantiated twice (mic, headset) |
| `main-page/components/self-profile-menu/` | Popover body with the root / status / accounts view swap |
| `services/media-device-catalog.service.ts` | Shared mic and speaker enumeration |
| `models/source-match.ts` | Pure `bestSourceMatch` |

### Modified

- `quick-settings.component.{ts,html}` — reduced to composition
- `self-profile-popover.component.{ts,html}` — `p-popover` shell only
- `account-switcher.component.{ts,html}` — becomes the accounts view body
- `profile-card.component.{ts,html}` — consumes `app-profile-header`
- `user-status-dot.component.ts` — shape masks
- `voice-channel.service.ts` — sticky mute across the four sites in §2
- `voice-video-settings.component.ts` — consumes `MediaDeviceCatalogService`
- `screen-picker.service.ts`, `screen-picker.component.ts` — `preferredSourceId`

### Deleted

- `status-picker.component.{ts,html,css}`

### i18n

New keys: `QUICK_SETTINGS.INPUT_DEVICE`, `QUICK_SETTINGS.OUTPUT_DEVICE`, `QUICK_SETTINGS.VOICE_SETTINGS`; `ACTIVITY.SHARING`, `ACTIVITY.NOT_SHARING`, `ACTIVITY.SHARE_NEEDS_VOICE`; `PROFILE_MENU.EDIT_PROFILE`, `PROFILE_MENU.ADMIN_PANEL`, `PROFILE_MENU.SWITCH_ACCOUNTS`, `PROFILE_MENU.BACK`; `STATUS.ONLINE`, `STATUS.IDLE`, `STATUS.DND`, `STATUS.INVISIBLE`.

`status-picker.component.ts:19-22` hardcodes `'Online'`, `'Idle'`, `'Do Not Disturb'`, and `'Appear Offline'` as untranslated English. Moving those options into the popover is the point at which they get keys.

Locales are a git submodule, so these strings land in their own commit inside the submodule before the code that references them.

## §5 — States and error handling

| Condition | Behavior |
|---|---|
| Profile not loaded | Skeleton: avatar circle plus two shimmer bars. Never an empty bar. |
| No activity | No card rendered; the footer is the user row alone |
| Artwork 404s | Falls back to the monogram tile via the existing `BrokenImageService` path |
| Enumeration unavailable (browser build) | Chevron menu shows "Voice Settings" only |
| Long device or game names | `truncate` with `min-w-0`; footer keeps `w-0 min-w-full` |
| `bestSourceMatch` finds nothing | Plain picker, nothing preselected |
| Screen share fails | Existing `voiceSvc` failure path, unchanged |

## §6 — Testing

Run with `ng test` (`@angular/build:unit-test`, vitest).

- `voice-channel.service.spec.ts` — mute survives join, leave, and remote takeover; join broadcasts both sticky mute and sticky deafen; the own participant is seeded from `localState` rather than `false`
- `media-device-catalog.service.spec.ts` — caches between calls, refreshes on `devicechange`, degrades without Tauri
- `source-match.spec.ts` — exact match; case and punctuation drift; trailing version suffix; no match returns `null`
- `quick-settings.component.spec.ts` — subtitle precedence: connection trouble outranks the status label
- `self-profile-menu.component.spec.ts` — view swap between root, status, and accounts; the admin row appears only for `UserType.Admin`

## Suggested phasing

One spec, but the work splits into four independently shippable slices. Each leaves the app in a working state:

1. **Truth** — status dot shapes, presence binding, subtitle precedence. Touches `user-status-dot` and `quick-settings` only; no new components.
2. **Shape** — the inset activity card, footer metrics, button sizing. `self-activity-card` extracted, share button not yet wired.
3. **Voice** — `MediaDeviceCatalogService`, `voice-toggle` with chevrons, sticky mute in `voice-channel.service.ts`. The riskiest slice; it is the one that changes call behavior.
4. **Popover** — `profile-header` extraction, menu cards, view swap, deleting `status-picker`, and wiring the share button to `toggleScreenShare()` with source preselect.

## Decisions taken

| Question | Decision |
|---|---|
| Mute outside a call | Sticky global preference, persisted |
| Bar controls | Three: mic, headset, gear. Status folds into the popover; admin becomes a popover row |
| Connection trouble | Subtitle takeover; the dot always shows presence |
| Activity strip second line | Not Sharing / Sharing, with the share button wired to screen share |
| Status dot | Discord's four shapes, applied app-wide |
| Share button outside voice | Dimmed with a tooltip, so the card never reflows |
| Source preselect | Highlight the best title match; the user still confirms |
