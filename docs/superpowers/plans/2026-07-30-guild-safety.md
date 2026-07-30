# Guild Safety: Verification Levels, Auto-Moderation, Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Discord-equivalent guild join-gating (verification levels), a blocked-word + rate-limit auto-moderation filter, and a "read the rules before you can post" onboarding gate.

**Architecture:** One new service (`GuildSafetyService`) covering all three feature areas, since they share the same `/api/v1/guild/guilds/{id}/...` base and are all guild-admin config. Two new pages in the existing guild settings modal (Moderation, Onboarding), plus a verification-level `<p-select>` folded into the existing Overview page. Enforcement surfaces at two points: the invite dialog (join rejection) and the channel send path (auto-mod rejection). Onboarding state is held in a small root service so the rules gate can be read from both the guild view and the composer.

**Tech Stack:** Angular 21 signals, PrimeNG 21 (`Select`, `ToggleSwitch`, `InputText`, `InputNumber`, `Textarea`, `Dialog`, `Button`, `Chip`), Tailwind v4 theme tokens, `@ngx-translate/core`.

## Global Constraints

- **Never invent colors.** Use theme tokens (`bg-card`, `bg-sidebar`, `bg-hover`, `border-border`, `text-text-primary`, `text-text-secondary`, `text-text-muted`, `text-online`, `text-offline`) or CSS vars (`var(--color-brand)`, `var(--color-brand-dim)`, `color-mix(in srgb, var(--color-brand) 15%, transparent)`). No `bg-[#hex]`.
- **Font sizes use rem-based Tailwind classes** (`text-[0.625rem]`, not `text-[10px]`).
- **Scrollable areas use the `thin-scrollbar` class** from `styles.css`.
- **PrimeNG buttons:** `<p-button>` with `(onClick)`, never `(click)`.
- **All URLs through `this.apiConfig.baseUrl()`**; guild endpoints under `/api/v1/guild`.
- **Enums are serialized as strings by the backend** (`JsonStringEnumConverter`). `verificationLevel` is `"None" | "Low" | "Medium" | "High"`, never a number.
- **All user-facing strings must be i18n keys** in `en.json`, `de.json`, `fr.json` (flat dotted keys). That directory is the `venta-i18n` git submodule — commit inside it first.
- **Visual target is Discord**, adapted to Alpine's existing settings-page conventions.
- Use `ChangeDetectionStrategy.OnPush` on all new components.
- Permission gating uses the existing helpers in `src/app/enums/permissions.enum.ts`: `parsePermissions`, `hasPermission`, `Permissions.ManageGuild`.
- Do not modify `src-tauri/Cargo.lock`.

---

### Task 1: Safety DTOs and service

**Files:**
- Create: `src/app/dtos/response/guild-safety.dto.ts`
- Create: `src/app/services/guild-safety.service.ts`
- Modify: `src/app/dtos/response/guild.dto.ts`
- Test: `src/app/services/guild-safety.service.spec.ts`

**Interfaces:**
- Produces: `GuildVerificationLevel`, `AutoModConfig`, `OnboardingConfig`, `OnboardingStatus`, `GuildSafetyService.{getAutoModConfig,updateAutoModConfig,getOnboardingConfig,updateOnboardingConfig,getMyOnboarding,acceptOnboarding}` — consumed by Tasks 2-6.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/guild-safety.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {GuildSafetyService} from './guild-safety.service';
import {ApiConfigService} from './api-config.service';

describe('GuildSafetyService', () => {
    let service: GuildSafetyService;
    let http: HttpTestingController;
    const base = 'https://api.test.example/api/v1/guild';

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        });
        service = TestBed.inject(GuildSafetyService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('PUTs the full auto-mod config', () => {
        const cfg = {enabled: true, blockedWords: ['a'], maxMessagesPerInterval: 5, intervalSeconds: 10};
        service.updateAutoModConfig('g1', cfg).subscribe();
        const req = http.expectOne(`${base}/guilds/g1/automod`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual(cfg);
        req.flush(cfg);
    });

    it('reads the current member onboarding status', () => {
        service.getMyOnboarding('g1').subscribe();
        const req = http.expectOne(`${base}/guilds/g1/onboarding/me`);
        expect(req.request.method).toBe('GET');
        req.flush({completed: false, rulesText: 'be nice', defaultChannelIds: []});
    });

    it('posts an empty body when accepting', () => {
        service.acceptOnboarding('g1').subscribe();
        const req = http.expectOne(`${base}/guilds/g1/onboarding/accept`);
        expect(req.request.method).toBe('POST');
        req.flush({});
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ng test --watch=false --include='**/guild-safety.service.spec.ts'`
Expected: FAIL — cannot resolve `./guild-safety.service`.

- [ ] **Step 3: Write the DTOs**

Create `src/app/dtos/response/guild-safety.dto.ts`:

```ts
/**
 * Join-time gating only. A member who met the bar when they joined is never
 * re-checked, and raising the level does not retroactively restrict anyone.
 */
export enum GuildVerificationLevel {
    None = 'None',
    Low = 'Low',
    Medium = 'Medium',
    High = 'High',
}

export interface AutoModConfig {
    enabled: boolean;
    /** Whole-word, case-insensitive matches. No regex or wildcards server-side. */
    blockedWords: string[];
    /** Null means no rate limit. Must be set together with intervalSeconds or the PUT 400s. */
    maxMessagesPerInterval?: number | null;
    intervalSeconds?: number | null;
}

export interface OnboardingConfig {
    enabled: boolean;
    /** Required (400 otherwise) when enabled is true. Rendered as plain text, not markdown. */
    rulesText?: string | null;
    /** Advisory only - highlights channels in the rules screen, grants no visibility. */
    defaultChannelIds: string[];
}

export interface OnboardingStatus {
    completed: boolean;
    rulesText?: string | null;
    defaultChannelIds: string[];
}
```

In `src/app/dtos/response/guild.dto.ts`, add the field to `GuildDto` (after `systemChannelId`) and the import:

```ts
import {GuildVerificationLevel} from './guild-safety.dto';
```

```ts
    verificationLevel: GuildVerificationLevel;
```

- [ ] **Step 4: Write the service**

Create `src/app/services/guild-safety.service.ts`:

```ts
import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {AutoModConfig, OnboardingConfig, OnboardingStatus} from '../dtos/response/guild-safety.dto';

@Injectable({providedIn: 'root'})
export class GuildSafetyService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    // ── Auto-moderation ──────────────────────────────────────────────────────
    getAutoModConfig(guildId: string): Observable<AutoModConfig> {
        return this.http.get<AutoModConfig>(`${this.base}/guilds/${guildId}/automod`);
    }

    /** Full replace, not a patch - always send every field, including unchanged ones. */
    updateAutoModConfig(guildId: string, config: AutoModConfig): Observable<AutoModConfig> {
        return this.http.put<AutoModConfig>(`${this.base}/guilds/${guildId}/automod`, config);
    }

    // ── Onboarding ───────────────────────────────────────────────────────────
    getOnboardingConfig(guildId: string): Observable<OnboardingConfig> {
        return this.http.get<OnboardingConfig>(`${this.base}/guilds/${guildId}/onboarding`);
    }

    updateOnboardingConfig(guildId: string, config: OnboardingConfig): Observable<OnboardingConfig> {
        return this.http.put<OnboardingConfig>(`${this.base}/guilds/${guildId}/onboarding`, config);
    }

    getMyOnboarding(guildId: string): Observable<OnboardingStatus> {
        return this.http.get<OnboardingStatus>(`${this.base}/guilds/${guildId}/onboarding/me`);
    }

    /** Idempotent - accepting twice is a no-op, not an error. */
    acceptOnboarding(guildId: string): Observable<void> {
        return this.http.post<void>(`${this.base}/guilds/${guildId}/onboarding/accept`, {});
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `ng test --watch=false --include='**/guild-safety.service.spec.ts'`
Expected: PASS (3 tests). Then `ng build` — expected: succeeds (adding a required field to `GuildDto` may surface object literals that need updating; fix any that appear).

- [ ] **Step 6: Commit**

```bash
git add src/app/dtos/response/guild-safety.dto.ts src/app/dtos/response/guild.dto.ts src/app/services/guild-safety.service.ts src/app/services/guild-safety.service.spec.ts
git commit -m "feat: add guild safety DTOs and service"
```

---

### Task 2: Verification level in guild overview settings

**Files:**
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/overview-settings/overview-settings.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/overview-settings/overview-settings.component.html`
- Modify: `src/app/services/guild.service.ts` (the `UpdateGuildDto` interface)

**Interfaces:**
- Consumes: `GuildVerificationLevel` (Task 1).

**Read first:** the whole of `overview-settings.component.ts` — it already has the `dirty`/`save()` pattern this task extends, including a `Select` import for the system-channel dropdown.

- [ ] **Step 1: Extend UpdateGuildDto**

In `src/app/services/guild.service.ts`, find the exported `UpdateGuildDto` interface and add:

```ts
    /** Omitted means "leave unchanged" - the backend treats null as no-op, not clear. */
    verificationLevel?: GuildVerificationLevel;
```

with the matching import from `../dtos/response/guild-safety.dto`.

- [ ] **Step 2: Add the signal and options to the component**

In `overview-settings.component.ts`, add:

```ts
    verificationLevel = signal<GuildVerificationLevel>(GuildVerificationLevel.None);

    /** Requirement text is spelled out per option, the way Discord's own picker does. */
    readonly verificationOptions = [
        {label: 'None', value: GuildVerificationLevel.None, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_NONE_HINT'},
        {label: 'Low', value: GuildVerificationLevel.Low, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_LOW_HINT'},
        {label: 'Medium', value: GuildVerificationLevel.Medium, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_MEDIUM_HINT'},
        {label: 'High', value: GuildVerificationLevel.High, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_HIGH_HINT'},
    ];

    protected verificationHint = computed(() =>
        this.verificationOptions.find(o => o.value === this.verificationLevel())?.hint ?? ''
    );
```

In `ngOnInit`, add: `this.verificationLevel.set(this.guild().verificationLevel ?? GuildVerificationLevel.None);`

In `onFieldChange()`, add to the `dirty.set(...)` expression:

```ts
            || this.verificationLevel() !== (this.guild().verificationLevel ?? GuildVerificationLevel.None)
```

In `save()`, inside `doUpdate`, after the `systemChannelId` block:

```ts
            if (this.verificationLevel() !== (g.verificationLevel ?? GuildVerificationLevel.None)) {
                dto.verificationLevel = this.verificationLevel();
            }
```

- [ ] **Step 3: Add the template block**

In `overview-settings.component.html`, after the system-channel `<p-select>` block, add a matching section: a label, a `<p-select [options]="verificationOptions" optionLabel="label" optionValue="value" [(ngModel)]="verificationLevel" (onChange)="onFieldChange()" styleClass="w-full" />`, and below it a `text-[0.8125rem] text-text-muted` paragraph rendering `{{ verificationHint() | translate }}`. Mirror the exact wrapper classes the system-channel block already uses.

- [ ] **Step 4: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; suite green.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/pages/overview-settings src/app/services/guild.service.ts
git commit -m "feat: add guild verification level setting"
```

---

### Task 3: Verification-level rejection in the invite dialog

**Files:**
- Modify: `src/app/features/invite-dialog/invite-dialog.component.ts`
- Modify: `src/app/features/invite-dialog/invite-dialog.component.html`

**Interfaces:**
- Consumes: nothing from earlier tasks beyond the `GuildVerificationLevel` type.

**Read first:** `invite-dialog.component.ts` in full — it uses a `dialogState` signal (`'loading' | 'ready' | 'joining' | 'joined' | 'error'`) and currently swallows every join error back to `'ready'`.

- [ ] **Step 1: Add the rejection state**

In `invite-dialog.component.ts`:

- Widen the state union: `type DialogState = 'loading' | 'ready' | 'joining' | 'joined' | 'error' | 'blocked';`
- Add `protected readonly requiredLevel = signal<string | null>(null);`
- Replace the `join()` error handler:

```ts
                error: (err: HttpErrorResponse) => {
                    // A 403 from redeem is either the verification gate or an ordinary
                    // ban/permission refusal - only the structured body distinguishes them,
                    // so check for the marker rather than treating every 403 the same.
                    const body = err?.error as { error?: string; requiredLevel?: string } | null;
                    if (err?.status === 403 && body?.error === 'verification_level_not_met') {
                        this.requiredLevel.set(body.requiredLevel ?? null);
                        this.dialogState.set('blocked');
                        return;
                    }
                    this.dialogState.set('ready');
                },
```

- Add the explanatory copy as a computed:

```ts
    /** Maps the tier the server reported to the requirement to spell out to the user. */
    protected readonly blockedReasonKey = computed(() => {
        switch (this.requiredLevel()) {
            case 'Low': return 'INVITE.VERIFY_LOW';
            case 'Medium': return 'INVITE.VERIFY_MEDIUM';
            case 'High': return 'INVITE.VERIFY_HIGH';
            default: return 'INVITE.VERIFY_GENERIC';
        }
    });
```

- Reset `requiredLevel` to `null` inside the existing `effect` that resets state when a new invite id arrives.
- Add the `HttpErrorResponse` import from `@angular/common/http`.

- [ ] **Step 2: Add the blocked state to the template**

In `invite-dialog.component.html`, add an `@else if (dialogState() === 'blocked')` branch (or a sibling `@if`, matching the file's existing control flow) showing:

- a `pi pi-shield` icon in `text-offline`,
- a heading `{{ 'INVITE.CANT_JOIN' | translate }}`,
- the requirement text `{{ blockedReasonKey() | translate }}`,
- a `<p-button>` to dismiss.

Keep the existing guild icon/name header visible so the user still knows which server refused them.

- [ ] **Step 3: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; suite green.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/invite-dialog
git commit -m "feat: surface verification-level rejection when redeeming an invite"
```

---

### Task 4: Auto-moderation settings page

**Files:**
- Create: `src/app/features/guild/components/guild-settings-modal/pages/moderation-settings/moderation-settings.component.ts`
- Create: `src/app/features/guild/components/guild-settings-modal/pages/moderation-settings/moderation-settings.component.html`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html`

**Interfaces:**
- Consumes: `GuildSafetyService`, `AutoModConfig` (Task 1).

**Read first:** `pages/emoji-settings/emoji-settings.component.ts` for the load-on-init + `ToastService` conventions used by guild settings pages.

- [ ] **Step 1: Write the component class**

Create `moderation-settings.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, inject, input, OnInit, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {InputNumber} from 'primeng/inputnumber';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {TranslateModule} from '@ngx-translate/core';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {AutoModConfig} from '../../../../../../dtos/response/guild-safety.dto';
import {GuildSafetyService} from '../../../../../../services/guild-safety.service';
import {ToastService} from '../../../../../../services/toast.service';

@Component({
    selector: 'app-moderation-settings',
    imports: [FormsModule, Button, InputText, InputNumber, ToggleSwitch, TranslateModule],
    templateUrl: './moderation-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModerationSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();

    protected loading = signal(true);
    protected saving = signal(false);
    protected enabled = signal(false);
    protected blockedWords = signal<string[]>([]);
    protected wordDraft = signal('');
    protected rateLimitOn = signal(false);
    protected maxMessages = signal<number | null>(null);
    protected intervalSeconds = signal<number | null>(null);

    private safety = inject(GuildSafetyService);
    private toast = inject(ToastService);

    ngOnInit(): void {
        this.safety.getAutoModConfig(this.guild().id).subscribe({
            next: cfg => {
                this.enabled.set(cfg.enabled);
                this.blockedWords.set(cfg.blockedWords ?? []);
                const hasRate = cfg.maxMessagesPerInterval != null && cfg.intervalSeconds != null;
                this.rateLimitOn.set(hasRate);
                this.maxMessages.set(cfg.maxMessagesPerInterval ?? null);
                this.intervalSeconds.set(cfg.intervalSeconds ?? null);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toast.httpError('Could not load auto-moderation settings', err);
            },
        });
    }

    protected addWord(): void {
        const word = this.wordDraft().trim();
        if (!word) return;
        // Matching is case-insensitive server-side, so fold case here too rather than
        // letting "Spam" and "spam" both sit in the list looking like distinct rules.
        if (this.blockedWords().some(w => w.toLowerCase() === word.toLowerCase())) {
            this.wordDraft.set('');
            return;
        }
        this.blockedWords.update(list => [...list, word]);
        this.wordDraft.set('');
    }

    protected removeWord(word: string): void {
        this.blockedWords.update(list => list.filter(w => w !== word));
    }

    protected save(): void {
        if (this.saving()) return;

        // The backend rejects a half-configured rate limit (one field set, the other null),
        // so treat the toggle as authoritative and send both or neither.
        if (this.rateLimitOn() && (!this.maxMessages() || !this.intervalSeconds())) {
            this.toast.error('Set both a message count and an interval, or turn the rate limit off.');
            return;
        }

        const config: AutoModConfig = {
            enabled: this.enabled(),
            blockedWords: this.blockedWords(),
            maxMessagesPerInterval: this.rateLimitOn() ? this.maxMessages() : null,
            intervalSeconds: this.rateLimitOn() ? this.intervalSeconds() : null,
        };

        this.saving.set(true);
        this.safety.updateAutoModConfig(this.guild().id, config).subscribe({
            next: () => {
                this.saving.set(false);
                this.toast.success('Auto-moderation updated');
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError('Could not save auto-moderation settings', err);
            },
        });
    }
}
```

- [ ] **Step 2: Write the template**

Create `moderation-settings.component.html`:

- **Master toggle row:** label + description + `<p-toggleswitch [(ngModel)]="enabled" />`, laid out like the rows in `notification-settings.component.html` (read it for the exact row markup).
- **Blocked words section:** an `<input pInputText [(ngModel)]="wordDraft" (keydown.enter)="addWord()">` with an "Add" `<p-button>`, and below it the current list rendered as removable chips — a `flex flex-wrap gap-2` container with `@for (w of blockedWords(); track w)` producing a `bg-hover border border-border rounded-full px-3 py-1 text-[0.8125rem]` pill with a `pi pi-times` button calling `removeWord(w)`. Show an empty-state line when the list is empty.
- **Rate limit section:** a `<p-toggleswitch [(ngModel)]="rateLimitOn" />`, and `@if (rateLimitOn())` two `<p-inputnumber>` fields (`maxMessages`, `intervalSeconds`) with a sentence-style layout ("Allow **N** messages every **M** seconds"). Per the backend, this is a fixed window, not a sliding one — do not write copy promising precise semantics.
- A note that bots and webhooks are never filtered.
- **Save button** at the bottom: `<p-button [label]="'COMMON.SAVE' | translate" severity="primary" size="small" [loading]="saving()" (onClick)="save()" />`.
- Wrap the whole page in `@if (!loading())` with a simple loading state otherwise.

- [ ] **Step 3: Register the page**

In `guild-settings-modal.component.ts`: import `ModerationSettingsComponent`, add to `imports`, and add to the **`Server Settings`** nav group after `bans`:

```ts
{id: 'moderation', label: 'Moderation', icon: 'pi pi-filter'},
```

In `guild-settings-modal.component.html` add `@case ('moderation') { <app-moderation-settings [guild]="guild()" /> }`.

- [ ] **Step 4: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; suite green.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal
git commit -m "feat: add auto-moderation settings page"
```

---

### Task 5: Auto-moderation rejection in the composer

**Files:**
- Modify: `src/app/features/guild/components/channel/channel.component.ts`
- Modify: `src/app/features/guild/components/channel/channel.component.html`

**Interfaces:**
- Consumes: nothing from earlier tasks.

**Read first:** `channel.component.ts` lines 279-340 — the `createMessage` method with its optimistic-add + `catchError(() => { this.messageStore.failMessage(tempId); return EMPTY; })` path.

- [ ] **Step 1: Add the inline error signal**

In `channel.component.ts` add:

```ts
    /** Set when the server refuses a send via auto-mod, cleared on the next attempt. */
    protected autoModError = signal<'blocked_word' | 'rate_limited' | null>(null);
```

- [ ] **Step 2: Handle the 403 in createMessage**

Replace the `catchError` block inside `createMessage` with:

```ts
            catchError((err: HttpErrorResponse) => {
                this.messageStore.failMessage(tempId);
                // Auto-mod refusals are a 403 with a structured body. They read very
                // differently to a user than a generic send failure, so surface the reason
                // inline by the composer instead of leaving a bare failed-message marker.
                const body = err?.error as { error?: string; reason?: string } | null;
                if (err?.status === 403 && body?.error === 'automod_blocked') {
                    this.autoModError.set(body.reason === 'rate_limited' ? 'rate_limited' : 'blocked_word');
                    this.messageStore.removeMessage(tempId);
                }
                return EMPTY;
            }),
```

Add `import {HttpErrorResponse} from '@angular/common/http';` if absent.

At the top of `createMessage`, before the optimistic add, clear the previous error: `this.autoModError.set(null);`

**Note:** the optimistic message is removed on an auto-mod block rather than left as "failed", because a failed message offers a retry that is guaranteed to fail again for a blocked word. The inline notice replaces it.

- [ ] **Step 3: Render the inline notice**

In `channel.component.html`, immediately above the `<app-composer>` element, add:

```html
@if (autoModError(); as reason) {
    <div class="mx-4 mb-2 flex items-center gap-2 rounded-md border border-offline/40
                bg-[color-mix(in_srgb,var(--color-offline)_12%,transparent)] px-3 py-2">
        <i class="pi pi-ban text-offline text-[0.875rem]"></i>
        <span class="text-[0.8125rem] text-text-secondary">
            {{ (reason === 'rate_limited' ? 'COMPOSER.AUTOMOD_RATE_LIMITED' : 'COMPOSER.AUTOMOD_BLOCKED_WORD') | translate }}
        </span>
        <button type="button" class="ml-auto text-text-muted hover:text-text-primary"
                (click)="autoModError.set(null)">
            <i class="pi pi-times text-[0.75rem]"></i>
        </button>
    </div>
}
```

Verify `border-offline/40` resolves against the theme token; if the Tailwind opacity modifier does not apply to the custom token, use `border-[color-mix(in_srgb,var(--color-offline)_40%,transparent)]` instead.

- [ ] **Step 4: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; suite green.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/channel
git commit -m "feat: surface auto-moderation blocks inline in the composer"
```

---

### Task 6: Onboarding — admin config page and member rules gate

**Files:**
- Create: `src/app/features/guild/components/guild-settings-modal/pages/onboarding-settings/onboarding-settings.component.ts`
- Create: `src/app/features/guild/components/guild-settings-modal/pages/onboarding-settings/onboarding-settings.component.html`
- Create: `src/app/features/guild/components/onboarding-gate/onboarding-gate.component.ts`
- Create: `src/app/features/guild/components/onboarding-gate/onboarding-gate.component.html`
- Create: `src/app/services/guild-onboarding-state.service.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html`
- Modify: `src/app/features/main-page/main-page.component.html` (mount the gate)
- Test: `src/app/services/guild-onboarding-state.service.spec.ts`

**Interfaces:**
- Consumes: `GuildSafetyService`, `OnboardingConfig`, `OnboardingStatus` (Task 1).
- Produces: `GuildOnboardingStateService.{statusFor, loadFor, accept, pendingForGuild}`.

- [ ] **Step 1: Write the failing test for the state service**

Create `src/app/services/guild-onboarding-state.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {GuildOnboardingStateService} from './guild-onboarding-state.service';
import {ApiConfigService} from './api-config.service';

describe('GuildOnboardingStateService', () => {
    let service: GuildOnboardingStateService;
    let http: HttpTestingController;
    const url = 'https://api.test.example/api/v1/guild/guilds/g1/onboarding/me';

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        });
        service = TestBed.inject(GuildOnboardingStateService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('reports a guild as pending when the member has not accepted', () => {
        service.loadFor('g1');
        http.expectOne(url).flush({completed: false, rulesText: 'rules', defaultChannelIds: []});
        expect(service.pendingForGuild('g1')).toBe(true);
    });

    it('does not report a guild as pending once accepted', () => {
        service.loadFor('g1');
        http.expectOne(url).flush({completed: true, rulesText: null, defaultChannelIds: []});
        expect(service.pendingForGuild('g1')).toBe(false);
    });

    it('treats a load failure as not-pending so a transient error cannot lock the UI', () => {
        service.loadFor('g1');
        http.expectOne(url).flush('nope', {status: 500, statusText: 'Server Error'});
        expect(service.pendingForGuild('g1')).toBe(false);
    });

    it('only fetches once per guild', () => {
        service.loadFor('g1');
        http.expectOne(url).flush({completed: false, rulesText: 'r', defaultChannelIds: []});
        service.loadFor('g1');
        http.expectNone(url);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ng test --watch=false --include='**/guild-onboarding-state.service.spec.ts'`
Expected: FAIL — cannot resolve the service.

- [ ] **Step 3: Write the state service**

Create `src/app/services/guild-onboarding-state.service.ts`:

```ts
import {inject, Injectable, signal} from '@angular/core';
import {GuildSafetyService} from './guild-safety.service';
import {OnboardingStatus} from '../dtos/response/guild-safety.dto';

/**
 * Caches each guild's onboarding status for the current member. Onboarding is a
 * one-way gate - once accepted it never re-arms - so a single fetch per guild per
 * session is enough and re-fetching on every guild open would be pure noise.
 */
@Injectable({providedIn: 'root'})
export class GuildOnboardingStateService {
    private readonly statuses = signal<Record<string, OnboardingStatus>>({});
    private readonly requested = new Set<string>();
    private safety = inject(GuildSafetyService);

    statusFor(guildId: string): OnboardingStatus | undefined {
        return this.statuses()[guildId];
    }

    pendingForGuild(guildId: string): boolean {
        return this.statuses()[guildId]?.completed === false;
    }

    loadFor(guildId: string): void {
        if (this.requested.has(guildId)) return;
        this.requested.add(guildId);

        this.safety.getMyOnboarding(guildId).subscribe({
            next: status => this.statuses.update(m => ({...m, [guildId]: status})),
            error: () => {
                // A failed status read must not gate the UI: the server is the real
                // enforcement point, so the worst case of assuming "not pending" is a
                // send that comes back 403, not an unmoderated guild.
                this.statuses.update(m => ({...m, [guildId]: {completed: true, defaultChannelIds: []}}));
            },
        });
    }

    accept(guildId: string): void {
        this.safety.acceptOnboarding(guildId).subscribe({
            next: () => this.statuses.update(m => ({
                ...m,
                [guildId]: {...(m[guildId] ?? {defaultChannelIds: []}), completed: true},
            })),
        });
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `ng test --watch=false --include='**/guild-onboarding-state.service.spec.ts'`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the admin config page**

Create `onboarding-settings.component.ts` + `.html`, following the same shape as Task 4's moderation page:

- Signals: `loading`, `saving`, `enabled`, `rulesText`, `defaultChannelIds`.
- `ngOnInit` loads via `getOnboardingConfig(guildId)`.
- Template: a `<p-toggleswitch>` for `enabled`; a `<textarea pTextarea rows="10">` for `rulesText` (plain text — do not add markdown preview, nothing is parsed server-side); a multi-select of text channels for `defaultChannelIds` built from `guild().channels` filtered to `ChannelType.Text`, using PrimeNG `MultiSelect`; a save button.
- Client-side guard mirroring the server: if `enabled` is true and `rulesText` is blank, show an inline error and do not submit (the server returns 400).
- Add a muted note that enabling onboarding is not retroactive — existing members are never gated.
- Register in the guild settings modal under the **`Community`** nav group as `{id: 'onboarding', label: 'Onboarding', icon: 'pi pi-book'}` plus the matching `@case`.

- [ ] **Step 6: Write the member rules gate**

Create `onboarding-gate.component.ts` + `.html`:

- `guildId = input.required<string>();`
- Injects `GuildOnboardingStateService`; an `effect` calls `loadFor(guildId())` whenever the id changes.
- Renders a PrimeNG `<p-dialog>` when `pendingForGuild(guildId())` is true: `[closable]="false"`, `[modal]="true"`, `[draggable]="false"`, `[dismissableMask]="false"`.
- Contents: the guild name as a heading, the rules text rendered **verbatim with whitespace preserved** — use `class="whitespace-pre-wrap"` and interpolation, never `[innerHTML]`, since the text is unsanitized user input; wrap it in a `max-h-[50vh] overflow-y-auto thin-scrollbar` container; an "I understand and agree" `<p-button severity="primary">` calling `accept(guildId())`; and, if `defaultChannelIds` is non-empty, a short list of those channels as quick links.
- Per the backend guide, restrictions lift immediately on accept — no refetch or reconnect needed.

- [ ] **Step 7: Mount the gate**

In `main-page.component.html`, mount `<app-onboarding-gate [guildId]="..." />` inside the branch that renders a selected guild, using whatever signal already holds the active guild id in that template. Read the file first to find it.

- [ ] **Step 8: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; suite green.

- [ ] **Step 9: Commit**

```bash
git add src/app/services/guild-onboarding-state.service.ts src/app/services/guild-onboarding-state.service.spec.ts src/app/features/guild/components/onboarding-gate src/app/features/guild/components/guild-settings-modal src/app/features/main-page/main-page.component.html
git commit -m "feat: add guild onboarding rules gate and admin config"
```

---

### Task 7: i18n keys

**Files:**
- Modify: `src/assets/i18n/locales/en.json`, `de.json`, `fr.json`

- [ ] **Step 1: Collect every new key**

Grep the files created/modified in Tasks 2-6 for `| translate` usages and build the full list. Include at minimum: `GUILD_SETTINGS.NAV.MODERATION`, `GUILD_SETTINGS.NAV.ONBOARDING`, `GUILD_SETTINGS.OVERVIEW.VERIFICATION_LEVEL`, `GUILD_SETTINGS.OVERVIEW.VERIFY_{NONE,LOW,MEDIUM,HIGH}_HINT`, the whole `GUILD_SETTINGS.MODERATION.*` and `GUILD_SETTINGS.ONBOARDING.*` groups, `ONBOARDING_GATE.*`, `COMPOSER.AUTOMOD_BLOCKED_WORD`, `COMPOSER.AUTOMOD_RATE_LIMITED`, and `INVITE.CANT_JOIN` / `INVITE.VERIFY_{LOW,MEDIUM,HIGH,GENERIC}`.

The verification hints must state the actual requirement, e.g.:

```json
"GUILD_SETTINGS.OVERVIEW.VERIFY_MEDIUM_HINT": "Members must have a verified email and an account at least 5 minutes old."
```

- [ ] **Step 2: Add to all three locales with real translations**

Flat dotted keys, grouped next to their topical neighbours. No English placeholders in `de.json`/`fr.json`.

- [ ] **Step 3: Verify parity**

```bash
node -e "const a=require('./src/assets/i18n/locales/en.json'),b=require('./src/assets/i18n/locales/de.json'),c=require('./src/assets/i18n/locales/fr.json');const ka=Object.keys(a).sort(),kb=Object.keys(b).sort(),kc=Object.keys(c).sort();const miss=(x,y,n)=>x.filter(k=>!y.includes(k)).forEach(k=>console.log('missing in '+n+':',k));miss(ka,kb,'de');miss(ka,kc,'fr');console.log('en',ka.length,'de',kb.length,'fr',kc.length)"
```

Expected: no output lines beginning "missing in"; equal counts.

- [ ] **Step 4: Commit the submodule, then the pointer**

```bash
cd src/assets/i18n/locales
git add en.json de.json fr.json
git commit -m "feat: add guild safety strings"
git push
cd ../../../..
git add src/assets/i18n/locales
git commit -m "chore: bump i18n submodule for guild safety strings"
```

---

## Notes for the controller

**Expected merge conflicts with sibling plans in this batch:**

- `guild-settings-modal.component.ts` (`navGroups` + `imports`) and `.html` (`@case` blocks) — also modified by the events/templates plan. Resolve by union: keep every nav entry and every case.
- `src/app/dtos/response/guild.dto.ts` — this plan adds `verificationLevel` to `GuildDto`; the messaging-parity plan adds `Announcement` to `ChannelType`. Different regions of the same file; resolve by union.
- `src/app/services/guild.service.ts` — this plan extends `UpdateGuildDto`; other plans add methods. Union.
- The three i18n locale files — union of added keys.
