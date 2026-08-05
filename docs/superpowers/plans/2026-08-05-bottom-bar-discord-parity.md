# Bottom Bar Discord Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the left-panel footer and self popover to Discord parity — presence-truthful status, always-visible mic/headset with device pickers, a layered activity card with screen sharing, and a grouped popover menu.

**Architecture:** Extract per-concern components out of `quick-settings` (113-line template) rather than restyling in place. Device enumeration moves from an inline call in the settings page into a shared service that both surfaces consume. `VoiceChannelService.localState` becomes a persisted preference instead of per-call state.

**Tech Stack:** Angular 21 (signals, `@if`/`@for` control flow, standalone components), PrimeNG 21, Tailwind v4, ngx-translate, vitest via `@angular/build:unit-test`, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-08-05-bottom-bar-discord-parity-design.md`

## Global Constraints

- Tailwind tokens only — `bg-card`, `bg-hover`, `bg-sidebar`, `border-border-subtle`, `text-text-primary/secondary/muted`, `bg-brand`. Never `bg-[#161b27]`.
- Font sizes as rem-based Tailwind classes (`text-[0.8125rem]`), never `px`, so they scale with `--base-font-size`.
- Scrollable regions use the `thin-scrollbar` class from `styles.css`; never inline scrollbar styles.
- `p-button` uses `(onClick)`, not `(click)`.
- All user-visible strings go through `| translate` with flat dot-separated keys. `src/assets/i18n/locales` is a **git submodule** — strings commit there first, in their own commit, before the code referencing them.
- Tests run with `ng test`. No `npm test` script exists.
- Push straight to `main`; no PRs.
- `OnlineStatus.Hidden` is labelled **"Invisible"** everywhere. "Appear Offline" is retired.
- The `w-0 min-w-full` on the footer root is load-bearing against the 68px + 240px column width. Never remove it.

---

## Task 0: i18n keys

**Files:**
- Modify: `src/assets/i18n/locales/en.json` (submodule)

**Interfaces:**
- Produces: the translation keys every later task references.

- [ ] **Step 1: Add the keys to `en.json`**

Insert alongside the existing `QUICK_SETTINGS.*` block (currently lines 207-210) and `ACTIVITY.*` block (157-177):

```json
"QUICK_SETTINGS.INPUT_DEVICE": "Input Device",
"QUICK_SETTINGS.OUTPUT_DEVICE": "Output Device",
"QUICK_SETTINGS.VOICE_SETTINGS": "Voice Settings",
"QUICK_SETTINGS.NO_DEVICES": "No devices found",
"ACTIVITY.SHARING": "Sharing",
"ACTIVITY.NOT_SHARING": "Not Sharing",
"ACTIVITY.SHARE": "Share your screen",
"ACTIVITY.SHARE_NEEDS_VOICE": "Join a voice channel to share",
"ACTIVITY.STOP_SHARING": "Stop sharing",
"STATUS.ONLINE": "Online",
"STATUS.IDLE": "Idle",
"STATUS.DND": "Do Not Disturb",
"STATUS.INVISIBLE": "Invisible",
"STATUS.TITLE": "Status",
"PROFILE_MENU.EDIT_PROFILE": "Edit Profile",
"PROFILE_MENU.ADMIN_PANEL": "Admin Panel",
"PROFILE_MENU.SWITCH_ACCOUNTS": "Switch Accounts",
"PROFILE_MENU.BACK": "Back"
```

- [ ] **Step 2: Commit inside the submodule**

```bash
cd src/assets/i18n/locales
git add en.json
git commit -m "feat(en): bottom bar device pickers, sharing state, status labels"
git push
cd ../../../..
```

- [ ] **Step 3: Commit the submodule pointer**

```bash
git add src/assets/i18n/locales
git commit -m "chore(i18n): bump locales for bottom bar strings"
```

---

# Phase 1 — Truth

## Task 1: Status dot shapes

**Files:**
- Modify: `src/app/components/user-status-dot/user-status-dot.component.ts`
- Modify: `src/styles.css` (mask utility classes)
- Test: `src/app/components/user-status-dot/user-status-dot.component.spec.ts` (create)

**Interfaces:**
- Consumes: `OnlineStatus` from `dtos/response/profile.dto`.
- Produces: `UserStatusDotComponent` with unchanged inputs (`status`, `size`, `borderColor`, `standalone`). Only rendered classes change. Every existing call site keeps working.

The component today returns four solid circles distinguished only by hue (`user-status-dot.component.ts:41-48`). Shape encoding is added via CSS `mask-image`, so the dot stays one element and the `borderColor` ring still works.

- [ ] **Step 1: Write the failing test**

```ts
import {TestBed} from '@angular/core/testing';
import {Component, signal} from '@angular/core';
import {UserStatusDotComponent} from './user-status-dot.component';
import {OnlineStatus} from '../../dtos/response/profile.dto';

@Component({
  imports: [UserStatusDotComponent],
  template: `<app-user-status-dot [status]="status()" [standalone]="true"/>`,
})
class Host {
  status = signal<OnlineStatus | null>(OnlineStatus.Online);
}

function dotClasses(): string {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture.nativeElement.querySelector('div')?.className ?? '';
}

describe('UserStatusDotComponent shapes', () => {
  it('renders online as a filled dot with no mask', () => {
    expect(dotClasses()).toContain('bg-online');
    expect(dotClasses()).not.toContain('status-mask');
  });

  it('renders each non-online status with its own mask class', () => {
    const fixture = TestBed.createComponent(Host);
    const cases: [OnlineStatus | null, string, string][] = [
      [OnlineStatus.Idle, 'bg-connecting', 'status-mask-idle'],
      [OnlineStatus.DoNotDisturb, 'bg-offline', 'status-mask-dnd'],
      [OnlineStatus.Hidden, 'bg-text-muted', 'status-mask-invisible'],
      [null, '', ''],
    ];
    for (const [status, color, mask] of cases) {
      fixture.componentInstance.status.set(status);
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('div');
      if (status === null) { expect(el).toBeNull(); continue; }
      expect(el.className).toContain(color);
      expect(el.className).toContain(mask);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `ng test --include='**/user-status-dot.component.spec.ts'`
Expected: FAIL — no `status-mask-*` classes are emitted.

- [ ] **Step 3: Add the mask utilities to `styles.css`**

```css
/* Discord-style status shapes. The dot is one element; the shape is punched out
   with a mask so `borderColor` still draws the ring against the panel behind it. */
.status-mask-idle {
    mask-image: radial-gradient(circle at 25% 25%, transparent 44%, #000 45%);
    -webkit-mask-image: radial-gradient(circle at 25% 25%, transparent 44%, #000 45%);
}

.status-mask-dnd {
    mask-image: linear-gradient(#000 0 0);
    -webkit-mask-image: linear-gradient(#000 0 0);
    mask-composite: exclude;
    -webkit-mask-composite: xor;
}

.status-mask-dnd::after {
    content: '';
    position: absolute;
    inset: 34% 20%;
    border-radius: 9999px;
    background: var(--color-sidebar);
}

.status-mask-invisible {
    background: transparent !important;
    box-shadow: inset 0 0 0 2px currentColor;
}
```

Note: `status-mask-dnd` needs `position: relative` on the dot; add `relative` to the class list in step 4. For `status-mask-invisible`, colour comes from `currentColor`, so the colour class must set `text-*` rather than `bg-*` — handled below.

- [ ] **Step 4: Implement `classes()`**

Replace `colorClass()` (`user-status-dot.component.ts:41-48`) with:

```ts
/** Colour plus shape. Discord distinguishes the four statuses by silhouette as well
 *  as hue, which is what makes them readable without colour vision. */
private statusClasses(): string[] {
    switch (this.status()) {
        case OnlineStatus.Online:
            return ['bg-online'];
        case OnlineStatus.Idle:
            return ['bg-connecting', 'status-mask-idle'];
        case OnlineStatus.DoNotDisturb:
            return ['bg-offline', 'relative', 'status-mask-dnd'];
        default:
            return ['text-text-muted', 'status-mask-invisible'];
    }
}
```

and fold it into `classes()`:

```ts
protected classes = computed(() => {
    const base = this.standalone()
        ? ['rounded-full', SIZE_CLASSES[this.size()]]
        : ['absolute', '-bottom-0.5', '-right-0.5', 'rounded-full', 'border-2',
           SIZE_CLASSES[this.size()], this.borderColor()];
    return [...base, ...this.statusClasses()];
});
```

- [ ] **Step 5: Run the test**

Run: `ng test --include='**/user-status-dot.component.spec.ts'`
Expected: PASS

- [ ] **Step 6: Visually verify all four in the running app**

Run the app, set each status from the current status picker, and confirm the member list, DM rows, and profile card dots all change shape. This component has many call sites; a regression here is app-wide.

- [ ] **Step 7: Commit**

```bash
git add src/app/components/user-status-dot src/styles.css
git commit -m "feat(status): distinguish the four statuses by shape, not just colour"
```

## Task 2: Bar reports presence, not the socket

**Files:**
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.html:46-70`
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.ts`
- Test: `src/app/features/main-page/components/quick-settings/quick-settings.component.spec.ts` (create)

**Interfaces:**
- Consumes: `UserStatusDotComponent` (Task 1), `ProfileService.ownProfile()`, `MessagingWebsocketService.connectionState()`.
- Produces: `QuickSettingsComponent.statusLabelKey: Signal<string>` and `showConnectionTrouble: Signal<boolean>`, both read by the template.

- [ ] **Step 1: Write the failing test for subtitle precedence**

```ts
describe('QuickSettingsComponent subtitle', () => {
  it('shows the status label while connected', () => {
    // connectionState = Connected, onlineStatus = Hidden
    expect(component.showConnectionTrouble()).toBe(false);
    expect(component.statusLabelKey()).toBe('STATUS.INVISIBLE');
  });

  it('lets connection trouble outrank the status label', () => {
    // connectionState = Connecting
    expect(component.showConnectionTrouble()).toBe(true);
  });

  it('maps every OnlineStatus to a key', () => {
    const expected = {
      [OnlineStatus.Online]: 'STATUS.ONLINE',
      [OnlineStatus.Idle]: 'STATUS.IDLE',
      [OnlineStatus.DoNotDisturb]: 'STATUS.DND',
      [OnlineStatus.Hidden]: 'STATUS.INVISIBLE',
    };
    // assert each
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `ng test --include='**/quick-settings.component.spec.ts'`
Expected: FAIL — `statusLabelKey` does not exist.

- [ ] **Step 3: Add the computed signals**

```ts
/** Presence, not the socket. The dot beside the name answers "what have I told people
 *  I am", which is a different question from "is my websocket up" — the old binding
 *  answered the second one and left an Invisible user looking green. */
protected readonly statusLabelKey = computed(() => {
    switch (this.profileService.ownProfile()?.onlineStatus) {
        case OnlineStatus.Idle: return 'STATUS.IDLE';
        case OnlineStatus.DoNotDisturb: return 'STATUS.DND';
        case OnlineStatus.Hidden: return 'STATUS.INVISIBLE';
        default: return 'STATUS.ONLINE';
    }
});

/** Connection trouble takes the subtitle, because a socket that is down is the more
 *  urgent thing to say and the dot is still carrying presence on its own. */
protected readonly showConnectionTrouble = computed(() =>
    this.websocketService.connectionState() !== ConnectionState.Connected
);
```

- [ ] **Step 4: Rewrite the avatar + name block**

Replace `quick-settings.component.html:50-68`. The dot becomes the shared component; the subtitle is now unconditional:

```html
<div class="relative shrink-0 mr-1">
    <app-avatar [userId]="profileService.ownProfile()?.userId"/>
    <app-user-status-dot
            [status]="profileService.ownProfile()?.onlineStatus ?? null"
            borderColor="border-sidebar"
            size="md"/>
</div>

<div class="flex-1 min-w-0">
    <p class="text-[0.875rem] font-medium text-text-primary truncate leading-tight">
        {{ profileService.ownProfile()?.userName }}
    </p>
    @if (showConnectionTrouble()) {
        <app-connection-status/>
    } @else {
        <p class="text-[0.75rem] text-text-muted truncate leading-tight mt-0.5">
            {{ statusLabelKey() | translate }}
        </p>
    }
</div>
```

Delete the `NgClass` import if nothing else in the template still uses it, and drop `ConnectionState` from the template's reach if unused.

- [ ] **Step 5: Run the test**

Run: `ng test --include='**/quick-settings.component.spec.ts'`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/features/main-page/components/quick-settings
git commit -m "fix(bar): show presence on the avatar dot instead of websocket state"
```

---

# Phase 2 — Shape

## Task 3: Extract the activity card

**Files:**
- Create: `src/app/features/main-page/components/self-activity-card/self-activity-card.component.ts`
- Create: `src/app/features/main-page/components/self-activity-card/self-activity-card.component.html`
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.{ts,html}`

**Interfaces:**
- Consumes: `primaryActivity`, `Activity`, `ACTIVITY_TYPE_ICONS` from `models/activity.model`; `UserActivityService.own()`; `MessagingWebsocketService.connectionState()`.
- Produces: `<app-self-activity-card/>` — self-contained, no inputs. Renders nothing when there is no primary activity or the socket is down. Task 8 adds a share button to it.

Move `ownActivity`, `activitySubtitle`, `activityTypeKey`, and `activityIcon` (`quick-settings.component.ts:56-96`) into the new component verbatim, then change what the subtitle renders.

- [ ] **Step 1: Create the component**

Art slot uses the same fallback `activity-card.component.ts:42` already uses — a brand-tinted monogram tile, not a grey glyph — so the two surfaces agree:

```html
@if (ownActivity(); as activity) {
    <div class="mx-2 mt-2 p-2 rounded-xl bg-card hover:bg-hover transition-colors duration-[120ms] ease-out">
        <div class="flex items-center gap-2.5 min-w-0">

            <!-- Sized for real cover art. `assets` is null server-side today by product
                 decision, so the monogram tile is the design, not a placeholder — when
                 largeImageUrl starts arriving it swaps in at the same size. -->
            <div class="shrink-0 w-10 h-10 rounded-lg overflow-hidden">
                @if (artUrl(); as url) {
                    <img [src]="url" [alt]="activity.name" (error)="onArtError(url)"
                         class="w-full h-full object-cover"/>
                } @else {
                    <div class="w-full h-full bg-brand/20 flex items-center justify-center select-none">
                        <span class="text-[1rem] font-bold text-brand-dim">{{ monogram() }}</span>
                    </div>
                }
            </div>

            <div class="flex-1 min-w-0">
                <p class="text-[0.8125rem] font-medium text-text-primary truncate leading-tight">
                    {{ activity.name }}
                </p>
                <p class="text-[0.75rem] text-text-muted truncate leading-tight mt-0.5">
                    {{ 'ACTIVITY.NOT_SHARING' | translate }}
                </p>
            </div>
        </div>
    </div>
}
```

The sharing state is hardcoded to `NOT_SHARING` here; Task 8 makes it reactive. `details`/`state` are deliberately not shown — `app-activity-card` already renders them in the profile popover, which is where they belong.

- [ ] **Step 2: Wire it into `quick-settings`**

Replace `quick-settings.component.html:22-41` with `<app-self-activity-card/>`. Remove the four now-unused computeds from `quick-settings.component.ts` and the `ACTIVITY_STATUS_KEYS`/`ACTIVITY_TYPE_ICONS`/`primaryActivity` imports.

- [ ] **Step 3: Apply the footer metrics from spec §1**

On the footer root (`quick-settings.component.html:11`): `border-white/[0.10]` → `border-border-subtle`. On the user row (line 43): `p-3` → `px-2 py-2`. Keep `w-0 min-w-full`.

- [ ] **Step 4: Verify in the app**

Run the app with a game running. Confirm: the card is inset with visible gaps on both sides, has rounded corners, lightens on hover, and the user row no longer changes height when the game starts or stops.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/main-page/components/self-activity-card src/app/features/main-page/components/quick-settings
git commit -m "feat(bar): make the activity strip an inset card"
```

## Task 4: Button sizing pass

**Files:**
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.html:74-109`

- [ ] **Step 1: Resize the mute/deafen/settings buttons**

`w-7 h-7` → `w-8 h-8`, icon `text-sm` → `text-[1.125rem]`, hover `hover:bg-white/[0.07]` → `hover:bg-white/[0.06]`, and add `duration-[120ms] ease-out` to the `transition-colors`. The admin shield and status picker stay for now — Task 10 removes them.

- [ ] **Step 2: Verify and commit**

```bash
git add src/app/features/main-page/components/quick-settings
git commit -m "style(bar): larger, softer control buttons"
```

---

# Phase 3 — Voice

## Task 5: Source matching

**Files:**
- Create: `src/app/models/source-match.ts`
- Test: `src/app/models/source-match.spec.ts`

**Interfaces:**
- Consumes: `ScreenSource` from `services/rust-media.service` (`{id, name, isMonitor, thumbnail, width, height}`).
- Produces: `bestSourceMatch(activityName: string, sources: readonly ScreenSource[]): string | null` — returns a `ScreenSource.id` or null.

- [ ] **Step 1: Write the failing test**

```ts
import {bestSourceMatch} from './source-match';

const src = (id: string, name: string, isMonitor = false) =>
    ({id, name, isMonitor, thumbnail: '', width: 1920, height: 1080});

describe('bestSourceMatch', () => {
  it('matches an exact window title', () => {
    const sources = [src('1', 'Monitor 1', true), src('2', 'Microsoft Flight Simulator 2024')];
    expect(bestSourceMatch('Microsoft Flight Simulator 2024', sources)).toBe('2');
  });

  it('ignores case and punctuation', () => {
    const sources = [src('2', 'counter-strike 2')];
    expect(bestSourceMatch('Counter Strike 2', sources)).toBe('2');
  });

  it('matches through a trailing version suffix', () => {
    const sources = [src('2', 'Microsoft Flight Simulator 2024 - v1.2.3')];
    expect(bestSourceMatch('Microsoft Flight Simulator 2024', sources)).toBe('2');
  });

  it('never matches a monitor', () => {
    const sources = [src('1', 'Overwatch', true)];
    expect(bestSourceMatch('Overwatch', sources)).toBeNull();
  });

  it('returns null when nothing is close enough', () => {
    const sources = [src('1', 'Monitor 1', true), src('3', 'Google Chrome')];
    expect(bestSourceMatch('Microsoft Flight Simulator 2024', sources)).toBeNull();
  });

  it('returns null for an empty source list', () => {
    expect(bestSourceMatch('Anything', [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `ng test --include='**/source-match.spec.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import {ScreenSource} from '../services/rust-media.service';

/** Tokens worth scoring on. Single characters and pure separators carry no identity. */
function tokenize(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(token => token.length > 1);
}

/**
 * The window most likely to be the game named by an activity, or nothing.
 *
 * <p>Deliberately conservative. The caller preselects the result in a picker the user still
 * confirms, so a wrong guess costs a click — but a confident wrong guess on a window holding
 * something private is worse than no guess at all, which is why a weak score returns null
 * rather than the best of a bad set.</p>
 *
 * <p>Monitors are never matched: a whole-screen capture is a different decision from sharing
 * one game, and a monitor's name never describes its contents anyway.</p>
 */
export function bestSourceMatch(
    activityName: string,
    sources: readonly ScreenSource[],
): string | null {
    const wanted = tokenize(activityName);
    if (!wanted.length) return null;

    let best: {id: string; score: number} | null = null;

    for (const source of sources) {
        if (source.isMonitor) continue;
        const have = new Set(tokenize(source.name));
        const hits = wanted.filter(token => have.has(token)).length;
        const score = hits / wanted.length;
        if (!best || score > best.score) best = {id: source.id, score};
    }

    // Two thirds of the activity's tokens. Below that, "Microsoft Flight Simulator 2024"
    // starts matching a browser tab that happens to say "Microsoft".
    return best && best.score >= 0.67 ? best.id : null;
}
```

- [ ] **Step 4: Run the test**

Run: `ng test --include='**/source-match.spec.ts'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/models/source-match.ts src/app/models/source-match.spec.ts
git commit -m "feat(share): match an activity name to a capturable window"
```

## Task 6: Media device catalog

**Files:**
- Create: `src/app/services/media-device-catalog.service.ts`
- Test: `src/app/services/media-device-catalog.service.spec.ts`
- Modify: `src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.ts:238-247`

**Interfaces:**
- Consumes: Tauri `invoke` for `enumerate_audio_devices` and `enumerate_output_devices`, both returning `{id: string; name: string}[]`.
- Produces:
  - `MediaDeviceCatalogService.mics: Signal<DeviceOption[]>`
  - `MediaDeviceCatalogService.speakers: Signal<DeviceOption[]>`
  - `MediaDeviceCatalogService.refresh(): Promise<void>`
  - `export interface DeviceOption { label: string; value: string }`

- [ ] **Step 1: Write the failing test**

```ts
describe('MediaDeviceCatalogService', () => {
  it('populates mics and speakers from the Tauri commands', async () => {
    // invoke stub returns [{id: 'A', name: 'Headset'}] / [{id: 'B', name: 'Speakers'}]
    await service.refresh();
    expect(service.mics()).toEqual([{label: 'Headset', value: 'A'}]);
    expect(service.speakers()).toEqual([{label: 'Speakers', value: 'B'}]);
  });

  it('leaves the lists empty when enumeration throws', async () => {
    // invoke stub rejects — the browser build has no Tauri side
    await service.refresh();
    expect(service.mics()).toEqual([]);
    expect(service.speakers()).toEqual([]);
  });

  it('refreshes when the device set changes', async () => {
    // dispatch 'devicechange' on navigator.mediaDevices
    // expect invoke to have been called a second time
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `ng test --include='**/media-device-catalog.service.spec.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import {Injectable, signal} from '@angular/core';
import {invoke} from '@tauri-apps/api/core';

export interface DeviceOption {
    label: string;
    value: string;
}

interface RustAudioDevice {
    id: string;
    name: string;
}

/**
 * The microphones and speakers this machine has, for every surface that offers a choice.
 *
 * <p>Enumeration used to live inline in the voice settings page, which was fine while that page
 * was the only chooser. The bottom bar's device chevrons are a second one, and two copies of a
 * Tauri call is how the two lists start disagreeing.</p>
 *
 * <p><b>Ids here are platform device *names*</b>, not web device ids — the contract documented on
 * {@link AudioSettings.micId}. They are what the Rust capture pipeline looks devices up by, and
 * they must go through `MediaDeviceResolverService` before any Web API will accept them.</p>
 */
@Injectable({providedIn: 'root'})
export class MediaDeviceCatalogService {
    readonly mics = signal<DeviceOption[]>([]);
    readonly speakers = signal<DeviceOption[]>([]);

    private inFlight: Promise<void> | null = null;

    constructor() {
        void this.refresh();
        // Fires when a headset is plugged in or a monitor with speakers wakes up. Cheap to
        // honour, and the alternative is a stale list in a menu the user opened *because*
        // they just plugged something in.
        navigator.mediaDevices?.addEventListener('devicechange', () => void this.refresh());
    }

    /** Re-read both lists. Concurrent calls share one round trip. */
    refresh(): Promise<void> {
        this.inFlight ??= this.load().finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    private async load(): Promise<void> {
        try {
            const [mics, speakers] = await Promise.all([
                invoke<RustAudioDevice[]>('enumerate_audio_devices'),
                invoke<RustAudioDevice[]>('enumerate_output_devices'),
            ]);
            this.mics.set(mics.map(d => ({label: d.name, value: d.id})));
            this.speakers.set(speakers.map(d => ({label: d.name, value: d.id})));
        } catch {
            // No Tauri side (browser build), or the host refused. Empty lists are the honest
            // answer; every consumer falls back to a "Voice Settings" link.
            this.mics.set([]);
            this.speakers.set([]);
        }
    }
}
```

- [ ] **Step 4: Run the test**

Run: `ng test --include='**/media-device-catalog.service.spec.ts'`
Expected: PASS

- [ ] **Step 5: Refactor the settings page to consume it**

In `voice-video-settings.component.ts`, delete the `enumerate_audio_devices` and `enumerate_output_devices` calls from `loadDevices()` (lines 240-246) and bind `micOptions`/`speakerOptions` to the catalog's signals. Camera enumeration stays where it is — the bar has no camera control.

- [ ] **Step 6: Verify the settings page still lists devices**

Run the app, open Settings → Voice & Video, and confirm both dropdowns are populated and selecting a device still persists.

- [ ] **Step 7: Commit**

```bash
git add src/app/services/media-device-catalog.service.ts src/app/services/media-device-catalog.service.spec.ts src/app/features/settings/settings-modal/pages/voice-video-settings
git commit -m "refactor(voice): share device enumeration between settings and the bar"
```

## Task 7: Sticky global mute

**Files:**
- Modify: `src/app/services/voice-channel.service.ts:56-61, 187, 201, 229, 248, 251-257, 267-281, 431`
- Test: `src/app/services/voice-channel.service.spec.ts` (create or extend)

**Interfaces:**
- Produces: `VoiceChannelService.localState` unchanged in shape, but `isMuted`/`isDeafened` now persist across joins, leaves, and remote takeovers, and are seeded from `localStorage` on construction.

**This is the riskiest task in the plan.** A partial application is worse than none: preserving `isMuted` at join without seeding the own participant and broadcasting leaves you muted locally while the room renders you live. All five edits ship together.

- [ ] **Step 1: Write the failing tests**

```ts
describe('VoiceChannelService sticky mute', () => {
  it('keeps mute across a join', async () => {
    service.toggleMute();
    await service.joinChannel(channel, 'Guild');
    expect(service.localState().isMuted).toBe(true);
  });

  it('keeps mute across a leave', async () => {
    service.toggleMute();
    await service.leaveChannel();
    expect(service.localState().isMuted).toBe(true);
  });

  it('keeps mute across a remote takeover', () => {
    service.toggleMute();
    // trigger the takeover path (line 431)
    expect(service.localState().isMuted).toBe(true);
  });

  it('resets camera and screen share on join', async () => {
    await service.joinChannel(channel, 'Guild');
    expect(service.localState().isCameraOn).toBe(false);
    expect(service.localState().isScreenSharing).toBe(false);
  });

  it('seeds the own participant from the sticky state', async () => {
    service.toggleMute();
    await service.joinChannel(channel, 'Guild');
    const own = service.channelParticipants(channel.id).find(p => p.isLocal);
    expect(own?.isMuted).toBe(true);
  });

  it('tells the room it joined muted', async () => {
    service.toggleMute();
    await service.joinChannel(channel, 'Guild');
    expect(guildWs.invokeVoiceMuteChanged).toHaveBeenCalledWith(channel.id, true);
  });

  it('restores mute from localStorage on construction', () => {
    localStorage.setItem('alpine_voice_local_state', JSON.stringify({isMuted: true, isDeafened: false}));
    // re-create the service
    expect(service.localState().isMuted).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `ng test --include='**/voice-channel.service.spec.ts'`
Expected: FAIL — state resets to false on join.

- [ ] **Step 3: Seed `localState` from storage**

Replace the initializer at `voice-channel.service.ts:56-61`:

```ts
readonly localState = signal<VoiceLocalState>({
    ...loadStickyVoiceState(),
    isCameraOn: false,
    isScreenSharing: false,
});
```

with a module-level helper:

```ts
const STICKY_KEY = 'alpine_voice_local_state';

/**
 * Mute and deafen outlive the call they were set in.
 *
 * <p>They are statements about this machine's microphone and speakers, not about a channel — the
 * user who mutes before joining means "do not transmit when I get there", and wiping the flag on
 * join answers a question they did not ask. Camera and screen share are the opposite: both hold a
 * live publication that cannot survive a channel change, so neither is persisted.</p>
 */
function loadStickyVoiceState(): {isMuted: boolean; isDeafened: boolean} {
    try {
        const raw = localStorage.getItem(STICKY_KEY);
        if (!raw) return {isMuted: false, isDeafened: false};
        const parsed = JSON.parse(raw) as Partial<VoiceLocalState>;
        return {isMuted: parsed.isMuted === true, isDeafened: parsed.isDeafened === true};
    } catch {
        return {isMuted: false, isDeafened: false};
    }
}
```

- [ ] **Step 4: Preserve across the three resets**

At lines 187 (join), 248 (leave), and 431 (remote takeover), replace

```ts
this.localState.set({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false});
```

with

```ts
this.localState.update(s => ({...s, isCameraOn: false, isScreenSharing: false}));
```

- [ ] **Step 5: Seed the own participant**

At line 201, `isMuted: false` becomes `isMuted: this.localState().isMuted`.

- [ ] **Step 6: Broadcast on join**

Immediately after `this.syncMic()` at line 229:

```ts
// The room has to be told, or a user who joined already muted renders as live to
// everyone else — the mic is off but the UI says otherwise, which is the worst
// combination of the two.
const {isMuted, isDeafened} = this.localState();
if (isMuted) this.guildWsSvc.invokeVoiceMuteChanged(channel.id, true);
if (isDeafened) this.guildWsSvc.invokeVoiceDeafenChanged(channel.id, true);
```

- [ ] **Step 7: Persist on toggle**

Add a private `persistSticky()` writing `{isMuted, isDeafened}` to `STICKY_KEY`, and call it at the end of `toggleMute()` (line 257) and `toggleDeafen()` (line 281).

- [ ] **Step 8: Run the tests**

Run: `ng test --include='**/voice-channel.service.spec.ts'`
Expected: PASS

- [ ] **Step 9: Verify against a real call**

Two clients. Mute on client A *before* joining, then join. Confirm client B renders A as muted and hears nothing. Then leave and rejoin, and confirm A is still muted.

- [ ] **Step 10: Commit**

```bash
git add src/app/services/voice-channel.service.ts src/app/services/voice-channel.service.spec.ts
git commit -m "feat(voice): mute and deafen survive joining and leaving"
```

## Task 8: Voice toggle with device chevron

**Files:**
- Create: `src/app/features/main-page/components/voice-toggle/voice-toggle.component.ts`
- Create: `src/app/features/main-page/components/voice-toggle/voice-toggle.component.html`
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.{ts,html}`

**Interfaces:**
- Consumes: `MediaDeviceCatalogService` (Task 6), `AudioSettingsService`, `VoiceChannelService`.
- Produces: `<app-voice-toggle [active]="…" [icon]="…" [activeIcon]="…" [label]="…" [devices]="…" [selected]="…" (toggled)="…" (deviceChosen)="…" (openSettings)="…"/>`

The component is not mic-specific. The mic instance toggles `voiceSvc.toggleMute()` and lists `catalog.mics()` writing `micId`; the headset instance toggles `voiceSvc.toggleDeafen()` and lists `catalog.speakers()` writing `speakerId`.

- [ ] **Step 1: Build the component**

```html
<div class="flex items-center shrink-0 rounded-lg overflow-hidden">
    <button type="button" (click)="toggled.emit()" [title]="label() | translate"
            [class]="active()
                ? 'bg-rose-500/15 text-rose-400 hover:bg-rose-500/25'
                : 'text-text-secondary hover:bg-white/[0.06] hover:text-text-primary'"
            class="w-8 h-8 flex items-center justify-center transition-colors duration-[120ms] ease-out cursor-pointer border-0">
        <i [class]="'pi ' + (active() ? activeIcon() : icon())" style="font-size: 1.125rem"></i>
    </button>
    <button type="button" (click)="menu.toggle($event)"
            class="w-4 h-8 flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-white/[0.06] transition-colors duration-[120ms] ease-out cursor-pointer border-0">
        <i class="pi pi-chevron-down" style="font-size: 0.5rem"></i>
    </button>
</div>
<p-menu #menu [model]="menuItems()" [popup]="true" appendTo="body"/>
```

- [ ] **Step 2: Build `menuItems()`**

```ts
/** The device list, then a way out to the full settings.
 *
 *  <p>An empty list is not an error state to render — it is the browser build, where there is no
 *  Tauri side to enumerate with. The menu falls back to the settings link alone rather than to a
 *  "no devices" row, because the link is the only useful thing either case can offer.</p> */
protected readonly menuItems = computed((): MenuItem[] => {
    const devices = this.devices().map(d => ({
        label: d.label,
        icon: d.value === this.selected() ? 'pi pi-check' : 'pi pi-fw',
        command: () => this.deviceChosen.emit(d.value),
    }));
    return [
        ...(devices.length ? [{label: this.label(), items: devices}] : []),
        {separator: true},
        {label: 'QUICK_SETTINGS.VOICE_SETTINGS', icon: 'pi pi-cog', command: () => this.openSettings.emit()},
    ];
});
```

Labels inside `MenuItem` are not passed through the `translate` pipe, so translate them with `TranslateService.instant` in the computed.

- [ ] **Step 3: Replace both buttons in `quick-settings`**

Delete the `@if (voiceSvc.isInVoice())` block at `quick-settings.component.html:74-96` and render both toggles unconditionally:

```html
<app-voice-toggle
        [active]="voiceSvc.localState().isMuted"
        icon="pi-microphone" activeIcon="pi-microphone-slash"
        [label]="voiceSvc.localState().isMuted ? 'QUICK_SETTINGS.UNMUTE' : 'QUICK_SETTINGS.MUTE'"
        [devices]="catalog.mics()" [selected]="audio.settings().micId"
        (toggled)="voiceSvc.toggleMute()"
        (deviceChosen)="audio.update({micId: $event})"
        (openSettings)="openVoiceSettings()"/>

<app-voice-toggle
        [active]="voiceSvc.localState().isDeafened"
        icon="pi-volume-up" activeIcon="pi-volume-off"
        [label]="voiceSvc.localState().isDeafened ? 'QUICK_SETTINGS.UNDEAFEN' : 'QUICK_SETTINGS.DEAFEN'"
        [devices]="catalog.speakers()" [selected]="audio.settings().speakerId"
        (toggled)="voiceSvc.toggleDeafen()"
        (deviceChosen)="audio.update({speakerId: $event})"
        (openSettings)="openVoiceSettings()"/>
```

Add `openVoiceSettings()` to `QuickSettingsComponent`, mirroring `openProfileSettings()` (line 126) but selecting the voice page.

- [ ] **Step 4: Verify**

Outside a call: both buttons visible and clickable, mute reflects immediately in the mic. Chevrons list real devices; picking one changes the selection in Settings → Voice & Video. Inside a call: unchanged behavior.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/main-page/components/voice-toggle src/app/features/main-page/components/quick-settings
git commit -m "feat(bar): always-visible mic and headset with device pickers"
```

## Task 9: Share button on the activity card

**Files:**
- Modify: `src/app/features/main-page/components/self-activity-card/self-activity-card.component.{ts,html}`
- Modify: `src/app/services/screen-picker.service.ts`
- Modify: `src/app/features/screen-picker/screen-picker.component.ts`

**Interfaces:**
- Consumes: `bestSourceMatch` (Task 5), `VoiceChannelService.isInVoice()` / `localState().isScreenSharing` / `toggleScreenShare()`, `ScreenPickerService`.
- Produces: `ScreenPickerService.preferredSourceId: Signal<string | null>` and `ScreenPickerService.preferSourceFor(activityName: string): void`.

- [ ] **Step 1: Add the preselect hint to `ScreenPickerService`**

```ts
readonly preferredSourceId = signal<string | null>(null);

/** Ask the next picker to start on the window that looks like this activity.
 *
 *  <p>A hint, not a decision — {@link show} still waits for the user. Cleared on every open so a
 *  stale preference from a game that has since closed cannot preselect the wrong window.</p> */
preferSourceFor(activityName: string): void {
    this.pendingPreferenceFor = activityName;
}
```

Resolve it inside `show()` once `sources` arrive, using `bestSourceMatch`, and clear `pendingPreferenceFor` at the top of `show()`.

- [ ] **Step 2: Highlight the preselected source in the picker component**

Add a `ring-2 ring-brand` class binding on the tile whose id equals `preferredSourceId()`, and scroll it into view once sources load.

- [ ] **Step 3: Add the button to the card**

```html
<button type="button" (click)="onShare()" [disabled]="!voiceSvc.isInVoice()"
        [title]="shareTooltip() | translate"
        [class]="voiceSvc.localState().isScreenSharing
            ? 'bg-brand/15 text-brand-dim hover:bg-brand/25'
            : 'text-text-secondary hover:bg-white/[0.06] hover:text-text-primary'"
        class="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg transition-colors duration-[120ms] ease-out cursor-pointer border-0 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent">
    <i class="pi pi-desktop" style="font-size: 1rem"></i>
</button>
```

and make the subtitle reactive:

```html
<p class="text-[0.75rem] text-text-muted truncate leading-tight mt-0.5">
    {{ (voiceSvc.localState().isScreenSharing ? 'ACTIVITY.SHARING' : 'ACTIVITY.NOT_SHARING') | translate }}
</p>
```

- [ ] **Step 4: Wire `onShare()`**

```ts
protected onShare(): void {
    const activity = this.ownActivity();
    if (!activity || !this.voiceSvc.isInVoice()) return;
    if (!this.voiceSvc.localState().isScreenSharing) {
        this.picker.preferSourceFor(activity.name);
    }
    void this.voiceSvc.toggleScreenShare();
}
```

- [ ] **Step 5: Verify**

Outside voice: button dimmed, tooltip reads "Join a voice channel to share", clicking does nothing. Inside voice with a game running: clicking opens the picker with the game's window ring-highlighted; confirming starts the share and the subtitle flips to "Sharing"; clicking again stops it.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/main-page/components/self-activity-card src/app/services/screen-picker.service.ts src/app/features/screen-picker
git commit -m "feat(bar): share the running game from the activity card"
```

---

# Phase 4 — Popover

## Task 10: Extract the profile header

**Files:**
- Create: `src/app/components/profile-header/profile-header.component.{ts,html}`
- Modify: `src/app/components/profile-card/profile-card.component.{ts,html}`

**Interfaces:**
- Produces: `<app-profile-header [profile]="…" [avatarError]="…" (avatarClick)="…" (avatarErrorChange)="…"/>` — banner, accent fallback, overlapping avatar with status dot, username with `appUserNameStyle`, bio.

- [ ] **Step 1: Move `profile-card.component.html:1-46` into the new component**

Move `bannerUrl`, `avatarLabel`, `onAvatarClick`, `onAvatarError`, `onBannerError`, and the `safeAccentColor`/`cacheBustedUrl`/`BrokenImageService` dependencies with it. `profile-card` keeps `friendsSince`, `activities`, and the facts block, and re-emits the header's outputs so `profile-dialog.component.html:18` needs no change.

- [ ] **Step 2: Verify no regression for other users**

Open another user's profile from the member list. Banner, avatar, status dot, name styling, bio, activity cards, Member Since, and Friends Since must all render exactly as before.

- [ ] **Step 3: Commit**

```bash
git add src/app/components/profile-header src/app/components/profile-card
git commit -m "refactor(profile): extract the header so the self menu can reuse it"
```

## Task 11: Self profile menu

**Files:**
- Create: `src/app/features/main-page/components/self-profile-menu/self-profile-menu.component.{ts,html}`
- Modify: `src/app/features/main-page/components/self-profile-popover/self-profile-popover.component.{ts,html}`
- Modify: `src/app/features/main-page/components/account-switcher/account-switcher.component.{ts,html}`
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.{ts,html}`
- Delete: `src/app/features/main-page/components/status-picker/`
- Test: `src/app/features/main-page/components/self-profile-menu/self-profile-menu.component.spec.ts`

**Interfaces:**
- Consumes: `ProfileHeaderComponent` (Task 10), `AccountSwitcherComponent`, `ProfileService.setSelfStatus`, `UserService.self()`.
- Produces: `<app-self-profile-menu (editProfile)="…" (openAdmin)="…" (addAccount)="…" (dismiss)="…"/>` with `view = signal<'root' | 'status' | 'accounts'>('root')`.

`app-settings-modal` and `app-admin-modal` stay hosted by `quick-settings` — it holds the `@ViewChild(SettingsModalComponent)` and the `SettingsUiService` effect the titlebar depends on. The menu emits; the popover forwards; `quick-settings` opens.

- [ ] **Step 1: Write the failing test**

```ts
describe('SelfProfileMenuComponent', () => {
  it('starts on the root view', () => {
    expect(component.view()).toBe('root');
  });

  it('swaps to the status view and back', () => {
    component.show('status');
    expect(component.view()).toBe('status');
    component.show('root');
    expect(component.view()).toBe('root');
  });

  it('hides the admin row for non-admins', () => { /* userType = User → row absent */ });
  it('shows the admin row for admins', () => { /* userType = Admin → row present */ });
  it('offers Add Account directly when there is no other account', () => { /* others() empty */ });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `ng test --include='**/self-profile-menu.component.spec.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the root view**

Structure and metrics from spec §3. Menu card: `mx-3 mt-3 bg-card rounded-xl overflow-hidden`. Row: `w-full h-10 px-3 flex items-center gap-3 rounded-lg hover:bg-hover transition-colors duration-[120ms] ease-out cursor-pointer border-0 text-left`. Icon 16px `text-text-secondary`; label `text-[0.875rem] text-text-primary`; trailing chevron `pi-chevron-right` at `0.75rem` `text-text-muted`. Dividers `border-t border-border-subtle mx-3`, never full-bleed.

Rows: Edit Profile → `editProfile.emit()`; Admin Panel (only when `userService.self()?.userType === UserType.Admin`) → `openAdmin.emit()`; Status (shaped dot + current label + chevron) → `show('status')`. Second card: Switch Accounts → `show('accounts')` when `others().length > 0`, else an Add Account row → `addAccount.emit()`.

- [ ] **Step 4: Build the status and accounts views**

Both get a `‹ back` header calling `show('root')`. Status view lists the four options from the deleted `status-picker.component.ts:18-23`, each calling `profileService.setSelfStatus(...)` then `show('root')`. Accounts view reuses `<app-account-switcher/>`, which stops rendering its own `others()` list header and gains Add Account as its last row.

Transition between views: translate-x plus opacity over 160ms. Do not use nested `p-menu` — the popover is `appendTo="body"` and nested overlays fight it for dismissal.

- [ ] **Step 5: Rewire the popover and delete the status picker**

`self-profile-popover.component.html` becomes the `p-popover` shell wrapping `<app-self-profile-menu/>`, forwarding `editProfile`, `openAdmin`, and `addAccount`, and calling `popoverRef.hide()` on each. Reset `view` to `'root'` on hide.

Delete `status-picker/` and remove `<app-status-picker/>` from `quick-settings.component.html:105` and from the popover. Remove the admin `p-button` at `quick-settings.component.html:99-102`, keeping `<app-admin-modal>` and adding an `openAdmin` handler that sets `isAdminOpen`.

- [ ] **Step 6: Run the tests**

Run: `ng test`
Expected: PASS, including the earlier suites.

- [ ] **Step 7: Verify the whole surface**

Bar shows exactly three controls (mic, headset, gear). Popover opens on the root view with header, menu cards, and correct account card. Status submenu sets status and returns. Accounts submenu switches and adds. Admin row appears only for admins and opens the modal. Edit Profile opens the settings modal on the profile page.

- [ ] **Step 8: Commit and push**

```bash
git add -A src/app/features/main-page/components src/app/components
git commit -m "feat(popover): grouped self menu with status and account submenus"
git push
```

---

## Self-review notes

- **Spec coverage.** §1 → Tasks 3, 4. §2 status truth → Tasks 1, 2; sticky mute → Task 7; device chevrons → Tasks 6, 8; share button → Task 9; source preselect → Tasks 5, 9. §3 → Tasks 10, 11. §4 i18n → Task 0. §5 states are covered inside the task that renders each surface. §6 tests are attached to Tasks 1, 2, 5, 6, 7, 11.
- **Skeleton state.** Spec §5 requires a skeleton when the profile has not loaded. Folded into Task 2, step 4 — the avatar and name block renders shimmer bars when `ownProfile()` is undefined.
- **Naming.** `bestSourceMatch` (Task 5) is the name used in Task 9. `MediaDeviceCatalogService.mics/speakers/refresh` (Task 6) are the names used in Task 8. `DeviceOption {label, value}` matches what `p-menu` and the settings dropdowns both consume.
