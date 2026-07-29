# Account Deletion Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the frontend for the new account-deletion backend contract: request deletion, cancel deletion, and surface pending-deletion state in the UI without disrupting the user's existing session.

**Architecture:** Extend `UserDto` with the new status fields, extend `UserService` with a `cancelDeletion()` call and a fixed `deleteAccount()` (both refetch `getSelf()` afterward so the `self` signal stays the single source of truth), rework the existing "Danger Zone" delete flow in Profile Settings to stop force-logging-out and add a cancel-deletion path, and add a small app-wide banner component (modeled on the existing `IsleProximityBarComponent` idiom) that surfaces the pending-deletion state from anywhere in the app and links back to Profile Settings to actually cancel.

**Tech Stack:** Angular 21 (standalone components, signals), PrimeNG 21 (`p-dialog`, `p-button`), RxJS, `HttpClient` via `UserService`/`ApiConfigService`, Angular's `@angular/build:unit-test` runner (Vitest-based, run via `npx ng test`).

## Global Constraints

- All three endpoints go through the gateway at `/api/v1/identity/*` with Bearer auth — auth is already handled transparently by the existing `token-interceptor.ts`; no manual token handling in any new code.
- Requesting deletion must NOT end the current session — never call `authService.logout()` / navigate to `/authentication` on a successful `deleteAccount()` call. The session naturally stays valid until it expires or a 401 hits the interceptor.
- No new "read state" endpoint exists — current `status`/`deletionRequestedAt`/`purgeScheduledAt` always come from the existing `GET /api/v1/identity/users/self` (`UserService.getSelf()`), which already populates the `self` signal.
- A 409 from `cancel-deletion` (plain-text body) must be shown as a specific "too late to cancel" message, not the generic HTTP-error toast.
- Once `status` is `PurgeInProgress` or `Deleted`, the cancel button must not be shown at all (not just disabled).

---

### Task 1: Add `AccountStatus` enum and new fields to `UserDto`

**Files:**
- Modify: `src/app/dtos/response/UserDto.ts`

**Interfaces:**
- Produces: `export enum AccountStatus { Active, PendingDeletion, PurgeInProgress, Deleted, Inactive, Banned }` and three new `UserDto` fields — `status: AccountStatus`, `deletionRequestedAt: Date | undefined`, `purgeScheduledAt: Date | undefined` — consumed by Task 2 (service), Task 3 (Profile Settings), Task 4 (banner).

There is no test file for this pure type file, and no existing precedent of testing DTOs in isolation in this codebase (checked: no `*.dto.spec.ts` files exist). Verification is via the TypeScript compiler plus the tests in later tasks that construct `UserDto` values.

- [ ] **Step 1: Add the enum and fields**

Edit `src/app/dtos/response/UserDto.ts` — insert the new enum directly after the existing `UserType` enum (before the `EncryptedMasterKey` interface), and add the three new fields to `UserDto`:

```ts
export enum UserType {
    Standard = 'Standard',
    Admin = 'Admin',
}

export enum AccountStatus {
    Active = 'Active',
    PendingDeletion = 'PendingDeletion',
    PurgeInProgress = 'PurgeInProgress',
    Deleted = 'Deleted',
    Inactive = 'Inactive',
    Banned = 'Banned',
}
```

And in the `UserDto` interface, add after `steamId`:

```ts
    steamId: string | undefined;
    status: AccountStatus;
    deletionRequestedAt: Date | undefined;
    purgeScheduledAt: Date | undefined;
}
```

(Named `AccountStatus`, not `UserStatus`/`Status`, to avoid colliding with the unrelated presence `OnlineStatus` enum in `src/app/dtos/response/profile.dto.ts`.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: This will now FAIL — every place that constructs a `UserDto` object literal (currently none in production code; only in the specs we're about to add) will need these fields. At this point in the plan it should still pass since no code constructs a `UserDto` literal yet (`UserService.getSelf()` just deserializes JSON from `HttpClient`, no literal construction). Confirm it passes.

- [ ] **Step 3: Commit**

```bash
git add src/app/dtos/response/UserDto.ts
git commit -m "feat: add AccountStatus enum and deletion fields to UserDto"
```

---

### Task 2: Add `cancelDeletion()` and fix `deleteAccount()` in `UserService`

**Files:**
- Modify: `src/app/services/user.service.ts:74-76`
- Test: Create `src/app/services/user.service.spec.ts`

**Interfaces:**
- Consumes: `AccountStatus`, `UserDto` from Task 1.
- Produces: `UserService.deleteAccount(): Observable<UserDto>` and `UserService.cancelDeletion(): Observable<UserDto>` — both refetch and return the refreshed `self` user, consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `src/app/services/user.service.spec.ts` (follows the same `HttpTestingController` + refetch-after-mutation pattern already used in `src/app/services/profile.service.spec.ts`'s `uploadBanner` tests):

```ts
import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {UserService} from './user.service';
import {ApiConfigService} from './api-config.service';
import {AccountStatus, UserDto, UserType} from '../dtos/response/UserDto';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(UserService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

function makeUser(overrides: Partial<UserDto> = {}): UserDto {
    return {
        id: 'u1',
        email: 'me@example.com',
        userType: UserType.Standard,
        createdAt: new Date(),
        updatedAt: new Date(),
        birthDate: new Date(),
        phoneVerifiedAt: undefined,
        emailVerifiedAt: new Date(),
        ageVerification: undefined,
        encryptedMasterKey: undefined,
        steamId: undefined,
        status: AccountStatus.Active,
        deletionRequestedAt: undefined,
        purgeScheduledAt: undefined,
        ...overrides,
    };
}

describe('UserService.deleteAccount', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('DELETEs /api/v1/identity/users/self, then refetches self since the mutation response has no user body', () => {
        const {service, ctrl} = setup();
        service.deleteAccount().subscribe();

        const delReq = ctrl.expectOne('https://api.test.example/api/v1/identity/users/self');
        expect(delReq.request.method).toBe('DELETE');
        delReq.flush({purgeScheduledAt: '2026-08-29T21:56:14.821Z'});

        const getReq = ctrl.expectOne('https://api.test.example/api/v1/identity/users/self');
        expect(getReq.request.method).toBe('GET');
        getReq.flush(makeUser({status: AccountStatus.PendingDeletion}));
    });

    it('updates the self signal with the refreshed status', () => {
        const {service, ctrl} = setup();
        service.deleteAccount().subscribe();

        ctrl.expectOne(req => req.method === 'DELETE').flush({purgeScheduledAt: '2026-08-29T21:56:14.821Z'});
        ctrl.expectOne(req => req.method === 'GET').flush(makeUser({status: AccountStatus.PendingDeletion}));

        expect(service.self()?.status).toBe(AccountStatus.PendingDeletion);
    });
});

describe('UserService.cancelDeletion', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('POSTs /api/v1/identity/users/self/cancel-deletion, then refetches self', () => {
        const {service, ctrl} = setup();
        service.cancelDeletion().subscribe();

        const postReq = ctrl.expectOne('https://api.test.example/api/v1/identity/users/self/cancel-deletion');
        expect(postReq.request.method).toBe('POST');
        postReq.flush(null);

        const getReq = ctrl.expectOne('https://api.test.example/api/v1/identity/users/self');
        expect(getReq.request.method).toBe('GET');
        getReq.flush(makeUser({status: AccountStatus.Active}));
    });

    it('updates the self signal back to Active', () => {
        const {service, ctrl} = setup();
        service.cancelDeletion().subscribe();

        ctrl.expectOne(req => req.method === 'POST').flush(null);
        ctrl.expectOne(req => req.method === 'GET').flush(makeUser({status: AccountStatus.Active}));

        expect(service.self()?.status).toBe(AccountStatus.Active);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx ng test`
Expected: FAIL — `user.service.spec.ts` fails because `deleteAccount()` doesn't refetch (only one HTTP request is made, so `ctrl.expectOne` for the GET throws) and `cancelDeletion` doesn't exist on `UserService` (TS compile error).

- [ ] **Step 3: Implement `cancelDeletion()` and fix `deleteAccount()`**

Edit `src/app/services/user.service.ts`, replacing the existing `deleteAccount()` method (lines 74-76):

```ts
    deleteAccount(): Observable<UserDto> {
        return this.httpClient.delete<{ purgeScheduledAt: string }>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/users/self`
        ).pipe(
            switchMap(() => this.getSelf())
        );
    }

    cancelDeletion(): Observable<UserDto> {
        return this.httpClient.post<void>(
            `${this.apiConfig.baseUrl()}/api/v1/identity/users/self/cancel-deletion`,
            {}
        ).pipe(
            switchMap(() => this.getSelf())
        );
    }
```

(`switchMap` is already imported at the top of the file; no import changes needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx ng test`
Expected: PASS for all `user.service.spec.ts` tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/user.service.ts src/app/services/user.service.spec.ts
git commit -m "feat: add UserService.cancelDeletion and refetch self after deleteAccount"
```

---

### Task 3: Rework the Profile Settings delete/cancel flow

**Files:**
- Modify: `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.ts`
- Modify: `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html`

**Interfaces:**
- Consumes: `AccountStatus` (Task 1), `UserService.deleteAccount()` / `UserService.cancelDeletion()` returning `Observable<UserDto>` (Task 2).
- Produces: `ProfileSettingsComponent.accountStatus` (computed signal used by the template's `@switch`), `confirmCancelDeletion()`, `cancelDeleteVisible`/`cancellingDeletion` signals — nothing outside this component depends on these.

There is no existing spec file for `ProfileSettingsComponent` (or any PrimeNG-dialog-heavy settings page in this codebase), so this task is verified manually via the running app rather than a new unit test, matching the codebase's existing convention for this component.

- [ ] **Step 1: Remove the now-dead force-logout code path**

The current `confirmDeleteAccount()` (ts, lines 290-296) calls `clearMlsAndLogout()` (lines 306-327) on success, which wipes MLS state and force-logs-out. Per the new contract, requesting deletion must NOT do this — the session stays valid. Since `clearMlsAndLogout()` will have no other callers after this change, remove it along with the imports/fields it was the sole user of.

Edit `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.ts`:

Replace the import block (lines 1-22) — remove `Router` (line 6), remove `from`, `of`, `switchMap` from the rxjs import (line 7), remove `AuthService` (line 12), remove `MlsService` (line 13), and change the `UserDto` import (line 19) to also bring in `AccountStatus`:

```ts
import {Component, computed, effect, ElementRef, inject, OnInit, signal, ViewChild} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {Select} from 'primeng/select';
import {finalize, take} from 'rxjs';
import {FormsModule} from '@angular/forms';
import {DatePipe} from '@angular/common';
import {ProfileService} from '../../../../../services/profile.service';
import {UserService} from '../../../../../services/user.service';
import {SteamService} from '../../../../../services/steam.service';
import {ExternalLinkService} from '../../../../../services/external-link.service';
import {ToastService} from '../../../../../services/toast.service';
import {ImageCropperComponent} from '../../../../../components/image-cropper/image-cropper.component';
import {TranslateModule} from '@ngx-translate/core';
import {AccountStatus, UserDto} from '../../../../../dtos/response/UserDto';
import {FONT_LABELS, FONT_STACKS, safeAccentColor} from '../../../../../models/profile-font.model';
import {cacheBustedUrl} from '../../../../../models/profile-image.model';
import {ProfileFont} from '../../../../../dtos/response/profile.dto';
import {HttpErrorResponse} from '@angular/common/http';
```

Remove the now-unused private fields (previously lines 77-78, 82):

```ts
    private authService = inject(AuthService);
    private mlsService = inject(MlsService);
```

and

```ts
    private router = inject(Router);
```

should no longer appear anywhere in the class.

Remove the `clearMlsAndLogout()` method entirely (previously lines 306-327, the last method in the class before the closing brace).

- [ ] **Step 2: Add the status-driven state and cancel-deletion signals**

Add these two signals near the existing `confirmDeleteVisible`/`deleting` signals (previously lines 50-51):

```ts
    protected confirmDeleteVisible = signal(false);
    protected deleting = signal(false);
    protected cancelDeleteVisible = signal(false);
    protected cancellingDeletion = signal(false);
```

Add a computed and an enum re-export near the other `computed(...)` declarations (e.g. right after `protected steamId = computed(() => this.user()?.steamId);`):

```ts
    protected readonly AccountStatus = AccountStatus;
    protected accountStatus = computed(() => this.user()?.status ?? AccountStatus.Active);
```

- [ ] **Step 3: Rewrite `confirmDeleteAccount()` and add `confirmCancelDeletion()`**

Replace the existing `confirmDeleteAccount()` method with:

```ts
    protected confirmDeleteAccount(): void {
        this.deleting.set(true);
        this.userService.deleteAccount().pipe(take(1)).subscribe({
            next: user => {
                this.deleting.set(false);
                this.confirmDeleteVisible.set(false);
                this.user.set(user);
                this.toast.success('Account deletion scheduled');
            },
            error: (err: HttpErrorResponse) => {
                this.deleting.set(false);
                this.toast.httpError('Could not delete account', err);
            },
        });
    }

    protected confirmCancelDeletion(): void {
        this.cancellingDeletion.set(true);
        this.userService.cancelDeletion().pipe(take(1)).subscribe({
            next: user => {
                this.cancellingDeletion.set(false);
                this.cancelDeleteVisible.set(false);
                this.user.set(user);
                this.toast.success('Account deletion cancelled');
            },
            error: (err: HttpErrorResponse) => {
                this.cancellingDeletion.set(false);
                if (err.status === 409) {
                    this.toast.error('Too late to cancel — the deletion has already started.');
                } else {
                    this.toast.httpError('Could not cancel account deletion', err);
                }
            },
        });
    }
```

(This is where the `HttpErrorResponse` import from Step 1 is used, and where the contract's 409 → "too late to cancel" requirement is honored.)

- [ ] **Step 4: Update the Danger Zone template to be status-driven**

Edit `src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html`, replacing the "Danger Zone" section (lines 370-385):

```html
    <!-- ── Danger Zone ─────────────────────────────────────────────────────── -->
    <section class="flex flex-col gap-4">
        <h2 class="text-[0.625rem] font-semibold text-rose-400/60 uppercase tracking-widest border-b border-rose-500/20 pb-3">
            Danger Zone
        </h2>
        @switch (accountStatus()) {
            @case (AccountStatus.PendingDeletion) {
                <div class="flex items-start gap-3 bg-rose-500/[0.08] border border-rose-500/25 rounded-xl px-4 py-3">
                    <i class="pi pi-exclamation-triangle text-rose-400 shrink-0 mt-0.5"></i>
                    <div class="flex-1 min-w-0">
                        <p class="text-sm text-white/75">
                            Your account is scheduled for deletion on
                            <strong class="text-white/90">{{ user()?.purgeScheduledAt | date:'MMM d, y' }}</strong>.
                        </p>
                        <p class="text-xs text-white/35 mt-0.5">You can cancel this at any time before then.</p>
                    </div>
                    <p-button (onClick)="cancelDeleteVisible.set(true)" label="Cancel Deletion" severity="secondary"
                              size="small" styleClass="shrink-0 ml-4"/>
                </div>
            }
            @case (AccountStatus.PurgeInProgress) {
                <div class="flex items-start gap-3 bg-rose-500/[0.08] border border-rose-500/25 rounded-xl px-4 py-3">
                    <i class="pi pi-exclamation-triangle text-rose-400 shrink-0 mt-0.5"></i>
                    <p class="text-sm text-white/75">Your account deletion is being processed and can no longer be cancelled.</p>
                </div>
            }
            @case (AccountStatus.Deleted) {
                <div class="flex items-start gap-3 bg-rose-500/[0.08] border border-rose-500/25 rounded-xl px-4 py-3">
                    <i class="pi pi-exclamation-triangle text-rose-400 shrink-0 mt-0.5"></i>
                    <p class="text-sm text-white/75">This account has been deleted.</p>
                </div>
            }
            @default {
                <div class="flex items-center justify-between bg-rose-500/[0.04] border border-rose-500/20 rounded-xl px-4 py-3">
                    <div>
                        <p class="text-sm text-white/75">Delete Account</p>
                        <p class="text-xs text-white/35 mt-0.5">Permanently delete your account and all associated data. This
                            cannot be undone.</p>
                    </div>
                    <p-button (onClick)="confirmDeleteVisible.set(true)" label="Delete Account" severity="danger"
                              size="small"
                              styleClass="shrink-0 ml-4"/>
                </div>
            }
        }
    </section>
```

- [ ] **Step 5: Add the Cancel Deletion confirm dialog**

In the same HTML file, insert a new dialog right after the existing "Delete account confirm dialog" block (after line 513, before the "Avatar lightbox" dialog at line 515):

```html
<!-- ── Cancel deletion confirm dialog ────────────────────────────────────── -->
<p-dialog
        [(visible)]="cancelDeleteVisible"
        [closable]="!cancellingDeletion()"
        [draggable]="false"
        [modal]="true"
        [resizable]="false"
        [style]="{width: '420px'}"
        appendTo="body"
        header="Cancel Account Deletion">
    <div class="flex flex-col gap-4 pt-1">
        <div class="flex items-start gap-3 bg-amber-500/[0.08] border border-amber-500/25 rounded-xl px-4 py-3">
            <i class="pi pi-info-circle text-amber-400 shrink-0 mt-0.5"></i>
            <p class="text-sm text-white/70">
                Your account will be restored to normal and no longer scheduled for deletion.
            </p>
        </div>
        <div class="flex gap-3 justify-end">
            <p-button (onClick)="cancelDeleteVisible.set(false)" [disabled]="cancellingDeletion()" label="Keep Deletion"
                      severity="secondary"
                      size="small"/>
            <p-button (onClick)="confirmCancelDeletion()" [loading]="cancellingDeletion()" label="Yes, Cancel Deletion"
                      severity="primary"
                      size="small"/>
        </div>
    </div>
</p-dialog>
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS — no references to the removed `AuthService`/`MlsService`/`Router`/`clearMlsAndLogout` remain.

- [ ] **Step 7: Manual verification**

Run: `npx ng serve` and open the app.
- Navigate to Settings → Profile → Danger Zone. Confirm the "Delete Account" button and dialog still work visually.
- Since there's no test backend easy to flip into `PendingDeletion` from the UI, verify at minimum: `accountStatus()` computed correctly defaults to `AccountStatus.Active` when `user()` has no `status` field mocked (i.e. current default backend response shape, if the backend hasn't shipped the new fields yet) — confirms the `@default` branch renders and nothing throws.
- Confirm no compile/runtime errors appear in the console when opening Profile Settings.

- [ ] **Step 8: Commit**

```bash
git add src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.ts src/app/features/settings/settings-modal/pages/profile-settings/profile-settings.component.html
git commit -m "feat: rework account deletion flow to stay session-valid and add cancel-deletion UI"
```

---

### Task 4: Add the app-wide pending-deletion banner component

**Files:**
- Create: `src/app/features/main-page/components/account-deletion-banner/account-deletion-banner.component.ts`
- Create: `src/app/features/main-page/components/account-deletion-banner/account-deletion-banner.component.html`

**Interfaces:**
- Consumes: `UserService.self` signal (Task 2/existing), `AccountStatus` (Task 1).
- Produces: `AccountDeletionBannerComponent` with an `@Output() manage: EventEmitter<void>`, consumed by Task 5 (`main-page.component.html`).

No test file — matches the existing convention for this exact style of component (`IsleProximityBarComponent`/`VoiceStatusBarComponent` have no specs either). Verified manually in Task 5's step.

- [ ] **Step 1: Create the component class**

Create `src/app/features/main-page/components/account-deletion-banner/account-deletion-banner.component.ts`:

```ts
import {Component, computed, EventEmitter, inject, Output} from '@angular/core';
import {DatePipe} from '@angular/common';
import {UserService} from '../../../../services/user.service';
import {AccountStatus} from '../../../../dtos/response/UserDto';

@Component({
    selector: 'app-account-deletion-banner',
    imports: [DatePipe],
    templateUrl: './account-deletion-banner.component.html',
})
export class AccountDeletionBannerComponent {
    protected userService = inject(UserService);
    @Output() manage = new EventEmitter<void>();

    protected visible = computed(() => this.userService.self()?.status === AccountStatus.PendingDeletion);
    protected purgeScheduledAt = computed(() => this.userService.self()?.purgeScheduledAt);
}
```

- [ ] **Step 2: Create the template**

Create `src/app/features/main-page/components/account-deletion-banner/account-deletion-banner.component.html`, following the same `shrink-0 border-b` full-width-bar idiom as `IsleProximityBarComponent`:

```html
@if (visible()) {
    <div class="shrink-0 bg-sidebar border-b border-rose-500/25 px-3 py-2 select-none">
        <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full shrink-0 bg-rose-500"></div>
            <p class="flex-1 min-w-0 text-xs font-semibold text-white/80 truncate">
                Your account is scheduled for deletion on {{ purgeScheduledAt() | date:'MMM d, y' }}.
            </p>
            <button
                (click)="manage.emit()"
                class="h-7 px-3 flex items-center gap-1.5 rounded-lg text-xs font-semibold text-white transition-colors cursor-pointer border-0 shrink-0"
                style="background: #f43f5e">
                Manage
            </button>
        </div>
    </div>
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/main-page/components/account-deletion-banner/
git commit -m "feat: add app-wide account-deletion-pending banner component"
```

---

### Task 5: Wire the banner into the main app shell

**Files:**
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.ts:58`
- Modify: `src/app/features/main-page/main-page.component.ts`
- Modify: `src/app/features/main-page/main-page.component.html`

**Interfaces:**
- Consumes: `AccountDeletionBannerComponent` (Task 4), `QuickSettingsComponent.openProfileSettings()` (made public in this task).
- Produces: nothing consumed by later tasks — this is the last task.

No test file — `MainPageComponent`/`QuickSettingsComponent` have no specs today either. Verified manually.

- [ ] **Step 1: Make `openProfileSettings()` callable from outside `QuickSettingsComponent`**

Edit `src/app/features/main-page/components/quick-settings/quick-settings.component.ts:58`, changing:

```ts
    protected openProfileSettings(): void {
```

to:

```ts
    public openProfileSettings(): void {
```

(The internal template binding at `quick-settings.component.html:29` — `(editProfile)="openProfileSettings()"` — keeps working unchanged; `public` is a superset of `protected` visibility for template bindings.)

- [ ] **Step 2: Add a `ViewChild` reference and forwarding method to `MainPageComponent`**

Edit `src/app/features/main-page/main-page.component.ts`:

Add `AccountDeletionBannerComponent` to the imports at the top:

```ts
import {QuickSettingsComponent} from './components/quick-settings/quick-settings.component';
import {AccountDeletionBannerComponent} from './components/account-deletion-banner/account-deletion-banner.component';
```

Add `ViewChild` to the `@angular/core` import (line 1):

```ts
import {Component, effect, HostListener, inject, OnDestroy, signal, ViewChild} from '@angular/core';
```

Add `AccountDeletionBannerComponent` to the `@Component` decorator's `imports` array (alongside `QuickSettingsComponent`):

```ts
        QuickSettingsComponent,
        AccountDeletionBannerComponent,
```

Add a `ViewChild` field and forwarding method to the class body (e.g. near `protected showKeySetup = signal(false);`):

```ts
    @ViewChild(QuickSettingsComponent) private quickSettings!: QuickSettingsComponent;
```

and add this method (e.g. near `public logout(): void`):

```ts
    protected openAccountSettings(): void {
        this.quickSettings.openProfileSettings();
    }
```

- [ ] **Step 3: Insert the banner and re-nest the shell into a column layout**

Overwrite `src/app/features/main-page/main-page.component.html` with (the only changes from the current file: the root `<div>` becomes `flex flex-col`, `<app-account-deletion-banner>` is inserted as its first child, and everything that was directly inside the root `<div>` is now nested one level deeper inside a new `flex flex-1 min-h-0 overflow-hidden` row):

```html
<div class="flex flex-col w-full overflow-hidden bg-app-bg h-full">
    <app-account-deletion-banner (manage)="openAccountSettings()"/>

    <div class="flex flex-1 min-h-0 overflow-hidden">

        <!-- Mobile drawer backdrop -->
        @if (navService.mobileNavOpen()) {
            <div (click)="navService.mobileNavOpen.set(false)" class="fixed inset-0 z-40 bg-black/60 lg:hidden"></div>
        }

        <!-- Left panel: [server rail | sidebar] with profile spanning bottom -->
        <div [class.-translate-x-full]="!navService.mobileNavOpen()"
             [class.translate-x-0]="navService.mobileNavOpen()"
             class="fixed top-0 bottom-0 left-0 z-50 flex flex-col transition-transform duration-base ease-brand
                  lg:relative lg:top-auto lg:bottom-auto lg:z-auto lg:![translate:none]">

            <!-- Server rail + sidebar side by side -->
            <div class="flex flex-1 min-h-0">
                <app-server-taskbar/>
                <app-action-sidepanel/>
            </div>

            <!-- Voice connected status bar (shown above profile when in a voice channel) -->
            <app-voice-status-bar/>
            <!-- Profile spans both columns -->
            <app-quick-settings/>
        </div>

        @let view = navService.mainView();

        <!-- Wiki panel (second sidebar, slides in to the right of channels) -->
        @if (navService.wikiPanelGuildId()) {
            <app-wiki-panel/>
        }

        <!-- Main content -->
        <div class="flex-1 min-w-0 overflow-hidden">
            @switch (view.type) {
                @case ('home') {
                    @if (navService.mobileSection() === 'conversations') {
                        <app-mobile-conversations-page class="lg:hidden"/>
                    }
                    <app-home [class.hidden]="navService.mobileSection() === 'conversations'"
                              class="lg:!block"/>
                }
                @case ('conversation') {
                    <app-conversation (back)="navService.showHome()" [conversation]="view.conversation"/>
                }
                @case ('channel') {
                    @if (view.channel.type === ChannelType.Voice) {
                        <app-voice-channel [channel]="view.channel"/>
                    } @else {
                        <app-channel (back)="navService.showHome()" [channel]="view.channel"/>
                    }
                }
                @case ('wiki') {
                    <app-wiki [guildId]="view.guildId"/>
                }
            }
        </div>

        <!-- Right sidebar: activity feed on home, conversation info on conversation, member list on channel -->
        @if (view.type === 'home') {
            <div class="hidden xl:flex shrink-0 h-full">
                <app-activity-feed/>
            </div>
        } @else if (view.type === 'conversation') {
            <div class="hidden xl:flex shrink-0 h-full">
                <app-conversation-info-panel [conversation]="view.conversation"/>
            </div>
        } @else if (view.type === 'channel') {
            @let ws = navService.workspace();
            @if (ws.type === 'server') {
                <div class="hidden xl:flex shrink-0 h-full">
                    <app-guild-member-list [guild]="ws.guild"/>
                </div>
            }
        }

        <app-profile-dialog
                (visibleChange)="profileDialogSvc.close()"
                [userId]="profileDialogSvc.selectedUserId()"/>

        <app-device-registration-modal
                (registered)="onDeviceRegistered($event)"
                [visible]="showDeviceRegistration()"/>

        <app-key-setup-dialog
                (setupComplete)="showKeySetup.set(false)"
                [visible]="showKeySetup()"/>
    </div>
</div>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS.

- [ ] **Step 5: Manual verification**

Run: `npx ng serve` and open the app while logged in.
- Confirm the main app layout (server rail, sidebars, main pane, right panel) looks and behaves exactly as before — no visual regression from the flex-col re-nesting.
- Confirm no banner appears (since `status` isn't `PendingDeletion` for a normal account).
- If the backend is available and supports it, actually call `DELETE /api/v1/identity/users/self` for a disposable test account, confirm: the app does NOT log you out, the banner appears at the top of the main shell with the correct formatted date, clicking "Manage" opens Settings on the Profile page, and the Danger Zone there shows the "Cancel Deletion" flow; confirm cancelling makes the banner disappear and restores the normal "Delete Account" button.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/main-page/components/quick-settings/quick-settings.component.ts src/app/features/main-page/main-page.component.ts src/app/features/main-page/main-page.component.html
git commit -m "feat: surface pending account deletion as an app-wide banner"
```
