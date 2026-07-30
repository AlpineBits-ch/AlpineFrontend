# Identity: MFA (TOTP) and Password Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticator-app two-factor auth (enroll / enable / disable / recovery codes / login challenge) and a forgot-password flow to the Alpine client.

**Architecture:** Two new root-provided services (`MfaService`, `PasswordResetService`) wrapping the Identity gateway endpoints. MFA settings live on a new "Security" page inside the existing user settings modal. The login challenge and the forgot-password flow are new dialogs mounted alongside the existing `app-email-verification-dialog`, driven by signal-based visibility services — the exact pattern `EmailVerificationService` already uses. `AuthService.login` gains an optional `mfaCode` parameter.

**Tech Stack:** Angular 21 signals, PrimeNG 21 (`Dialog`, `Button`, `InputText`, `InputOtp`, `Password`), Tailwind v4 theme tokens, `qrcode` npm package, `@ngx-translate/core`.

## Global Constraints

- **Never invent colors.** Use the project's Tailwind theme tokens (`bg-card`, `bg-sidebar`, `bg-hover`, `border-border`, `text-text-primary`, `text-text-secondary`, `text-text-muted`) or CSS vars (`var(--color-brand)`, `var(--color-brand-dim)`, `color-mix(in srgb, var(--color-brand) 15%, transparent)`). No `bg-[#hex]`.
- **Font sizes use rem-based Tailwind classes** (`text-[0.625rem]`, not `text-[10px]`) so they scale with `--base-font-size`.
- **Scrollable areas use the `thin-scrollbar` class** from `styles.css`. Never inline scrollbar styles.
- **PrimeNG buttons:** `<p-button>` with `(onClick)`, never `(click)`. Icon-only toolbar buttons use `icon="pi pi-..." [text]="true" severity="secondary" size="small"`.
- **All URLs go through the gateway** `this.apiConfig.baseUrl()` — never `environment.apiUrl` in new services (existing files that use it are not in scope to change). Identity endpoints are under `/api/v1/identity`.
- **All user-facing strings must be i18n keys** added to `src/assets/i18n/locales/en.json`, `de.json`, and `fr.json`. That directory is a git submodule (`venta-i18n`) — commit there separately. Keys are flat dotted strings (e.g. `"SETTINGS.SECURITY.TITLE": "Security"`), matching the existing file layout.
- **Visual target is Discord**, adapted to the existing Alpine look. Match the layout/spacing conventions of the sibling settings pages already in the repo.
- Use `ChangeDetectionStrategy.OnPush` on all new components.
- Do not modify `src-tauri/Cargo.lock` (a pre-existing local modification exists).

---

### Task 1: MFA and password-reset services + DTOs

**Files:**
- Create: `src/app/dtos/response/mfa.dto.ts`
- Create: `src/app/services/mfa.service.ts`
- Create: `src/app/services/password-reset.service.ts`
- Test: `src/app/services/mfa.service.spec.ts`

**Interfaces:**
- Consumes: `ApiConfigService.baseUrl()` (signal getter, call as a function).
- Produces: `MfaEnrollResponse`, `MfaRecoveryCodesResponse`, `MfaService.{enroll,enable,disable,regenerateRecoveryCodes}`, `PasswordResetService.{requestReset,resetPassword}` — used by Tasks 3, 4, 5.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/mfa.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {MfaService} from './mfa.service';
import {ApiConfigService} from './api-config.service';

describe('MfaService', () => {
    let service: MfaService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        });
        service = TestBed.inject(MfaService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('posts an empty body to the enroll endpoint', () => {
        service.enroll().subscribe();
        const req = http.expectOne('https://api.test.example/api/v1/identity/user/mfa/enroll');
        expect(req.request.method).toBe('POST');
        req.flush({secret: 'S', otpAuthUri: 'otpauth://totp/x'});
    });

    it('sends the code when enabling', () => {
        service.enable('123456').subscribe();
        const req = http.expectOne('https://api.test.example/api/v1/identity/user/mfa/enable');
        expect(req.request.body).toEqual({code: '123456'});
        req.flush({recoveryCodes: []});
    });

    it('sends the password when disabling', () => {
        service.disable('pw').subscribe();
        const req = http.expectOne('https://api.test.example/api/v1/identity/user/mfa/disable');
        expect(req.request.body).toEqual({password: 'pw'});
        req.flush({});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ng test --watch=false --include='**/mfa.service.spec.ts'`
Expected: FAIL — cannot resolve `./mfa.service`.

- [ ] **Step 3: Write the DTOs**

Create `src/app/dtos/response/mfa.dto.ts`:

```ts
export interface MfaEnrollResponse {
    /** Base32 authenticator secret, shown as selectable text for manual entry. */
    secret: string;
    /** Full `otpauth://totp/...` URI — render this as the QR code. */
    otpAuthUri: string;
}

export interface MfaRecoveryCodesResponse {
    /** Eight single-use codes. Shown exactly once; there is no "view codes" endpoint. */
    recoveryCodes: string[];
}
```

- [ ] **Step 4: Write the services**

Create `src/app/services/mfa.service.ts`:

```ts
import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {MfaEnrollResponse, MfaRecoveryCodesResponse} from '../dtos/response/mfa.dto';

@Injectable({providedIn: 'root'})
export class MfaService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/identity/user/mfa';
    }

    /**
     * Step 1 of enrollment. Safe to call repeatedly before `enable` - the server
     * re-returns the same pending secret rather than minting a new one.
     */
    enroll(): Observable<MfaEnrollResponse> {
        return this.http.post<MfaEnrollResponse>(`${this.base}/enroll`, {});
    }

    /** Step 2 - proves the authenticator works. 400 means the code did not verify. */
    enable(code: string): Observable<MfaRecoveryCodesResponse> {
        return this.http.post<MfaRecoveryCodesResponse>(`${this.base}/enable`, {code});
    }

    /** Password-gated rather than code-gated: someone disabling MFA may have lost their device. */
    disable(password: string): Observable<void> {
        return this.http.post<void>(`${this.base}/disable`, {password});
    }

    /** Invalidates every previously issued recovery code. */
    regenerateRecoveryCodes(password: string): Observable<MfaRecoveryCodesResponse> {
        return this.http.post<MfaRecoveryCodesResponse>(`${this.base}/recovery-codes`, {password});
    }
}
```

Create `src/app/services/password-reset.service.ts`:

```ts
import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpParams} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';

@Injectable({providedIn: 'root'})
export class PasswordResetService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/identity/user';
    }

    /**
     * Always 202, whether or not the account exists - deliberate, so the response
     * can't be used to probe which emails are registered. Never branch on it.
     */
    requestReset(email: string): Observable<void> {
        return this.http.get<void>(`${this.base}/request-password-reset`, {
            params: new HttpParams().set('email', email),
        });
    }

    resetPassword(email: string, code: string, newPassword: string): Observable<void> {
        return this.http.post<void>(`${this.base}/reset-password`, {email, code, newPassword});
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `ng test --watch=false --include='**/mfa.service.spec.ts'`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/app/dtos/response/mfa.dto.ts src/app/services/mfa.service.ts src/app/services/password-reset.service.ts src/app/services/mfa.service.spec.ts
git commit -m "feat: add MFA and password-reset API services"
```

---

### Task 2: QR code component

**Files:**
- Modify: `package.json` (add `qrcode` + `@types/qrcode`)
- Create: `src/app/components/qr-code/qr-code.component.ts`

**Interfaces:**
- Produces: `<app-qr-code [data]="uri()" />` — a self-contained canvas renderer used by Task 3.

- [ ] **Step 1: Install the dependency**

```bash
bun add qrcode
bun add -d @types/qrcode
```

If `bun` is unavailable, use `npm install qrcode && npm install -D @types/qrcode`. Verify `package.json` gained both entries and that the lockfile updated.

- [ ] **Step 2: Write the component**

Create `src/app/components/qr-code/qr-code.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, effect, ElementRef, input, viewChild} from '@angular/core';
import QRCode from 'qrcode';

/**
 * Renders arbitrary text as a QR code onto a canvas. Colors are fixed light-on-dark
 * rather than themed: scanners need a high, predictable contrast ratio, and a brand-tinted
 * code risks failing to scan on some phones.
 */
@Component({
    selector: 'app-qr-code',
    template: `
        <canvas #canvas class="rounded-lg bg-white p-2" [attr.aria-label]="ariaLabel()"></canvas>`,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QrCodeComponent {
    data = input.required<string>();
    size = input(192);
    ariaLabel = input('QR code');

    private canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

    constructor() {
        effect(() => {
            const data = this.data();
            const el = this.canvas().nativeElement;
            if (!data) return;
            void QRCode.toCanvas(el, data, {
                width: this.size(),
                margin: 1,
                color: {dark: '#000000', light: '#ffffff'},
            }).catch(() => {
                // A failed render leaves the canvas blank; the enrollment screen always
                // shows the secret as selectable text too, so manual entry still works.
            });
        });
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `ng build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock package-lock.json src/app/components/qr-code/qr-code.component.ts
git commit -m "feat: add QR code component for MFA enrollment"
```

(Only add the lockfile that actually exists in the repo.)

---

### Task 3: Security settings page (MFA enroll / disable / recovery codes)

**Files:**
- Create: `src/app/features/settings/settings-modal/pages/security-settings/security-settings.component.ts`
- Create: `src/app/features/settings/settings-modal/pages/security-settings/security-settings.component.html`
- Modify: `src/app/features/settings/settings-modal/settings-modal.component.ts`
- Modify: `src/app/features/settings/settings-modal/settings-modal.component.html`

**Interfaces:**
- Consumes: `MfaService` (Task 1), `QrCodeComponent` (Task 2), `ToastService.{success,error,httpError}`.
- Produces: nothing consumed by later tasks.

**Read first:** `src/app/features/settings/settings-modal/pages/privacy-settings/privacy-settings.component.html` for the section/heading markup this page must match, and `settings-modal.component.html` for how pages are switched with `@case`.

- [ ] **Step 1: Write the component class**

Create `security-settings.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, inject, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {InputOtp} from 'primeng/inputotp';
import {Dialog} from 'primeng/dialog';
import {TranslateModule} from '@ngx-translate/core';
import {MfaService} from '../../../../../services/mfa.service';
import {ToastService} from '../../../../../services/toast.service';
import {QrCodeComponent} from '../../../../../components/qr-code/qr-code.component';

type Stage = 'idle' | 'enrolling' | 'enabled';

@Component({
    selector: 'app-security-settings',
    imports: [FormsModule, Button, InputText, InputOtp, Dialog, TranslateModule, QrCodeComponent],
    templateUrl: './security-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SecuritySettingsComponent {
    protected stage = signal<Stage>('idle');
    protected secret = signal('');
    protected otpAuthUri = signal('');
    protected code = signal('');
    protected busy = signal(false);

    /** Shown exactly once, right after enable or regenerate - there is no way to re-read them. */
    protected recoveryCodes = signal<string[] | null>(null);

    protected showDisableDialog = signal(false);
    protected showRegenerateDialog = signal(false);
    protected password = signal('');

    private mfa = inject(MfaService);
    private toast = inject(ToastService);

    protected beginEnroll(): void {
        if (this.busy()) return;
        this.busy.set(true);
        this.mfa.enroll().subscribe({
            next: res => {
                this.secret.set(res.secret);
                this.otpAuthUri.set(res.otpAuthUri);
                this.stage.set('enrolling');
                this.busy.set(false);
            },
            error: err => {
                this.busy.set(false);
                this.toast.httpError('Could not start setup', err);
            },
        });
    }

    protected cancelEnroll(): void {
        this.stage.set('idle');
        this.code.set('');
    }

    protected confirmEnable(): void {
        const code = this.code();
        if (this.busy() || code.length < 6) return;
        this.busy.set(true);
        this.mfa.enable(code).subscribe({
            next: res => {
                this.recoveryCodes.set(res.recoveryCodes);
                this.stage.set('enabled');
                this.code.set('');
                this.busy.set(false);
                this.toast.success('Two-factor authentication enabled');
            },
            error: err => {
                this.busy.set(false);
                // The pending secret stays valid, so let them retype rather than restarting.
                if (err?.status === 400) this.toast.error('That code did not match. Try the current one.');
                else this.toast.httpError('Could not enable two-factor', err);
            },
        });
    }

    protected confirmDisable(): void {
        if (this.busy() || !this.password()) return;
        this.busy.set(true);
        this.mfa.disable(this.password()).subscribe({
            next: () => {
                this.busy.set(false);
                this.showDisableDialog.set(false);
                this.password.set('');
                this.recoveryCodes.set(null);
                this.stage.set('idle');
                this.toast.success('Two-factor authentication disabled');
            },
            error: err => {
                this.busy.set(false);
                if (err?.status === 400) this.toast.error('Incorrect password');
                else this.toast.httpError('Could not disable two-factor', err);
            },
        });
    }

    protected confirmRegenerate(): void {
        if (this.busy() || !this.password()) return;
        this.busy.set(true);
        this.mfa.regenerateRecoveryCodes(this.password()).subscribe({
            next: res => {
                this.busy.set(false);
                this.showRegenerateDialog.set(false);
                this.password.set('');
                this.recoveryCodes.set(res.recoveryCodes);
                this.toast.success('New recovery codes generated');
            },
            error: err => {
                this.busy.set(false);
                if (err?.status === 400) this.toast.error('Incorrect password');
                else this.toast.httpError('Could not regenerate codes', err);
            },
        });
    }

    protected copyCodes(): void {
        const codes = this.recoveryCodes();
        if (!codes) return;
        void navigator.clipboard.writeText(codes.join('\n'));
        this.toast.success('Recovery codes copied');
    }

    protected downloadCodes(): void {
        const codes = this.recoveryCodes();
        if (!codes) return;
        const blob = new Blob([codes.join('\n')], {type: 'text/plain'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'venta-recovery-codes.txt';
        a.click();
        URL.revokeObjectURL(url);
    }

    protected dismissCodes(): void {
        this.recoveryCodes.set(null);
    }

    protected copySecret(): void {
        void navigator.clipboard.writeText(this.secret());
        this.toast.success('Secret copied');
    }
}
```

- [ ] **Step 2: Write the template**

Create `security-settings.component.html`. Match the sibling settings pages' structure: a `<h3>` section heading, a muted description paragraph, then the control. Requirements:

- **Section heading** `{{ 'SETTINGS.SECURITY.SECTION_2FA' | translate }}`.
- **`@if (stage() === 'idle')`** — description text plus a `<p-button [label]="'SETTINGS.SECURITY.ENABLE' | translate" severity="primary" size="small" (onClick)="beginEnroll()" [loading]="busy()" />`.
- **`@if (stage() === 'enrolling')`** — a `bg-card border border-border rounded-lg p-4` panel containing: `<app-qr-code [data]="otpAuthUri()" />`, the secret in a `font-mono select-all text-text-secondary` block with a copy icon-button, a `<p-inputotp [(ngModel)]="code" [length]="6" [integerOnly]="true" />`, and Confirm / Cancel buttons side by side using `styleClass="flex-1 justify-center"`.
- **`@if (stage() === 'enabled')`** — a status row with `pi pi-check-circle` in `text-online`, plus "Disable" (`severity="danger"`) and "Generate new recovery codes" (`severity="secondary"`) buttons.
- **`@if (recoveryCodes(); as codes)`** — a `<p-dialog>` (not dismissable by backdrop click: `[closable]="false"`) with a `grid grid-cols-2 gap-2 font-mono text-[0.8125rem]` list of `@for (c of codes; track c)`, plus Copy / Download / "I've saved them" buttons. Copy the warning copy: these are shown once and cannot be viewed again.
- **Two confirmation `<p-dialog>`s** for disable and regenerate, each with a `<input pInputText type="password" [(ngModel)]="password">` and a confirm button. The regenerate dialog must warn that existing codes stop working immediately.

Use `thin-scrollbar` on the recovery-code list container. All strings via `| translate`.

- [ ] **Step 3: Register the page in the settings modal**

In `settings-modal.component.ts`: import `SecuritySettingsComponent`, add it to `imports`, and add to the **`My Account`** nav group, immediately after `privacy`:

```ts
{id: 'security', label: 'Security', icon: 'pi pi-lock'},
```

In `settings-modal.component.html`, add a `@case ('security') { <app-security-settings /> }` alongside the existing page cases.

- [ ] **Step 4: Verify**

Run: `ng build`
Expected: succeeds. Then run the full suite: `ng test --watch=false` — expected: still green (no new tests here).

- [ ] **Step 5: Commit**

```bash
git add src/app/features/settings/settings-modal
git commit -m "feat: add MFA security settings page"
```

---

### Task 4: MFA login challenge

**Files:**
- Modify: `src/app/services/auth.service.ts`
- Create: `src/app/services/mfa-challenge.service.ts`
- Create: `src/app/features/mfa-challenge/mfa-challenge-dialog.component.ts`
- Create: `src/app/features/mfa-challenge/mfa-challenge-dialog.component.html`
- Modify: `src/app/features/login/login.component.ts`
- Modify: wherever `<app-email-verification-dialog>` is mounted (find it with `grep -rn "app-email-verification-dialog" src/`)
- Test: `src/app/services/mfa-challenge.service.spec.ts`

**Interfaces:**
- Consumes: `AuthService.login(input, password, mfaCode?)`.
- Produces: `MfaChallengeService.{visible, show, dismiss}` signals; `mfaErrorKind(err)` helper.

- [ ] **Step 1: Extend AuthService**

In `src/app/services/auth.service.ts`, replace the `login` method with:

```ts
    /** Accepts `username` or `user@server.com`, resolves the server, then logs in. */
    public login(input: string, password: string, mfaCode?: string): Observable<TokenResponse> {
        const username = this.apiConfig.applyLoginInput(input);
        // fetchTokenUsingPasswordFlow is exactly fetchTokenUsingGrant('password', {username, password});
        // going through the grant call directly is the only way to add the mfa_code field the
        // backend reads off the token request.
        const parameters: Record<string, string> = {username, password};
        if (mfaCode) parameters['mfa_code'] = mfaCode;

        return from(this.oauthService.fetchTokenUsingGrant('password', parameters)).pipe(
            tap({
                error: (err) => console.error('Login failed', err)
            }),
            catchError((err) => throwError(() => err))
        );
    }
```

- [ ] **Step 2: Write the failing test for the error classifier**

Create `src/app/services/mfa-challenge.service.spec.ts`:

```ts
import {mfaErrorKind} from './mfa-challenge.service';

describe('mfaErrorKind', () => {
    // The backend returns these as a bare string body via StatusCode(401, "mfa_required"),
    // which Angular's JSON-by-default HttpClient fails to parse - so the marker can arrive
    // either as `error` (string) or nested under `error.text` after the parse failure.
    it('detects mfa_required from a plain string body', () => {
        expect(mfaErrorKind({status: 401, error: 'mfa_required'})).toBe('required');
    });

    it('detects mfa_required from a failed-JSON-parse body', () => {
        expect(mfaErrorKind({status: 401, error: {text: 'mfa_required'}})).toBe('required');
    });

    it('detects a quoted JSON string body', () => {
        expect(mfaErrorKind({status: 401, error: '"mfa_invalid"'})).toBe('invalid');
    });

    it('returns null for a plain 401 with no marker', () => {
        expect(mfaErrorKind({status: 401, error: null})).toBeNull();
    });

    it('returns null for non-401 statuses', () => {
        expect(mfaErrorKind({status: 403, error: 'mfa_required'})).toBeNull();
    });

    it('unwraps the OAuth library reason wrapper', () => {
        expect(mfaErrorKind({reason: {status: 401, error: 'mfa_required'}})).toBe('required');
    });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `ng test --watch=false --include='**/mfa-challenge.service.spec.ts'`
Expected: FAIL — cannot resolve `./mfa-challenge.service`.

- [ ] **Step 4: Write the service**

Create `src/app/services/mfa-challenge.service.ts`:

```ts
import {Injectable, signal} from '@angular/core';

export type MfaErrorKind = 'required' | 'invalid';

interface MaybeHttpError {
    status?: number;
    error?: unknown;
    reason?: { status?: number; error?: unknown };
}

/**
 * Classifies a failed token request as an MFA challenge.
 *
 * The backend answers with `StatusCode(401, "mfa_required")`, i.e. a bare string body.
 * Angular's HttpClient parses responses as JSON by default, so an unquoted string body
 * fails to parse and surfaces as `{error: SyntaxError, text: 'mfa_required'}`. Depending on
 * content negotiation the same marker can also arrive as a plain string or a quoted JSON
 * string, so all three shapes are accepted here. A 401 without a marker is an ordinary
 * bad-credentials failure and must NOT show a code prompt.
 */
export function mfaErrorKind(err: unknown): MfaErrorKind | null {
    const e = (err ?? {}) as MaybeHttpError;
    const status = e.status ?? e.reason?.status;
    if (status !== 401) return null;

    const body = e.error ?? e.reason?.error;
    let text: string | null = null;
    if (typeof body === 'string') text = body;
    else if (body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string') {
        text = (body as { text: string }).text;
    }
    if (!text) return null;

    const normalized = text.trim().replace(/^"|"$/g, '');
    if (normalized === 'mfa_required') return 'required';
    if (normalized === 'mfa_invalid') return 'invalid';
    return null;
}

@Injectable({providedIn: 'root'})
export class MfaChallengeService {
    readonly visible = signal(false);
    readonly username = signal('');
    readonly password = signal('');

    show(username: string, password: string): void {
        this.username.set(username);
        this.password.set(password);
        this.visible.set(true);
    }

    dismiss(): void {
        this.visible.set(false);
        this.password.set('');
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `ng test --watch=false --include='**/mfa-challenge.service.spec.ts'`
Expected: PASS (6 tests).

- [ ] **Step 6: Write the challenge dialog**

Create `mfa-challenge-dialog.component.ts` modeled directly on `src/app/features/email-verification/email-verification-dialog.component.ts` (read it first). Requirements:

- `imports: [Dialog, Button, InputOtp, FormsModule, PrimeTemplate, TranslateModule]`, `ChangeDetectionStrategy.OnPush`.
- Bind `[(visible)]` to `MfaChallengeService.visible`.
- A 6-digit `<p-inputotp [(ngModel)]="code" [length]="6" [integerOnly]="true" />` plus a secondary "Use a recovery code instead" toggle that swaps it for a plain `<input pInputText>` (recovery codes are 8 characters and contain letters, so they cannot go through the integer-only OTP input).
- Submit calls `authService.login(username, password, code)`. On success: `userSettings.load()`, `router.navigate(['/overview'])`, dismiss.
- On error, call `mfaErrorKind(err)`: `'invalid'` → inline "That code isn't right — try again" and clear the field; anything else → `toast.httpError` and dismiss.

- [ ] **Step 7: Wire the login page**

In `login.component.ts`, inject `MfaChallengeService` and extend the existing `catchError` in `login()`. The current block starts with `const status = err?.status ?? err?.reason?.status;` — insert the MFA branch **before** the existing `if (status === 403)` check:

```ts
                if (mfaErrorKind(err) === 'required') {
                    const {username, password} = this.loginModel();
                    this.mfaChallenge.show(username, password);
                    return EMPTY;
                }
```

Add the import: `import {mfaErrorKind} from '../../services/mfa-challenge.service';` and `import {MfaChallengeService} from '../../services/mfa-challenge.service';` (combine into one import statement).

- [ ] **Step 8: Mount the dialog**

Find the template that mounts `<app-email-verification-dialog>` and add `<app-mfa-challenge-dialog />` directly beside it, importing the component in that host component's `imports` array.

- [ ] **Step 9: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; full suite green.

- [ ] **Step 10: Commit**

```bash
git add src/app/services/auth.service.ts src/app/services/mfa-challenge.service.ts src/app/services/mfa-challenge.service.spec.ts src/app/features/mfa-challenge src/app/features/login
git commit -m "feat: add MFA login challenge"
```

---

### Task 5: Forgot-password flow

**Files:**
- Create: `src/app/features/password-reset/password-reset-dialog.component.ts`
- Create: `src/app/features/password-reset/password-reset-dialog.component.html`
- Create: `src/app/features/password-reset/password-reset.service.ts` (visibility state only)
- Modify: `src/app/features/login/login.component.html`
- Modify: `src/app/features/login/login.component.ts`
- Modify: the same host template that mounts `<app-email-verification-dialog>`

**Interfaces:**
- Consumes: `PasswordResetService` from Task 1 (the HTTP one). Name the new state service `PasswordResetDialogService` to avoid a collision.

- [ ] **Step 1: Write the dialog state service**

Create `src/app/features/password-reset/password-reset.service.ts`:

```ts
import {Injectable, signal} from '@angular/core';

@Injectable({providedIn: 'root'})
export class PasswordResetDialogService {
    readonly visible = signal(false);
    /** Pre-filled from whatever the user already typed into the login username field. */
    readonly prefillEmail = signal('');

    show(prefill = ''): void {
        this.prefillEmail.set(prefill);
        this.visible.set(true);
    }

    dismiss(): void {
        this.visible.set(false);
    }
}
```

- [ ] **Step 2: Write the dialog component**

Create `password-reset-dialog.component.ts` with two stages in one dialog, driven by a `stage` signal (`'request' | 'reset'`):

- **`request` stage:** an email `<input pInputText>` and a submit button calling `PasswordResetService.requestReset(email)`. On **any** response (including errors) advance to `'reset'` and show the same neutral copy — the endpoint deliberately returns 202 regardless of whether the account exists, so branching on it would leak account existence. Do not show a success toast implying an email was definitely sent.
- **`reset` stage:** a 6-character code input (plain `<input pInputText>`, **not** `p-inputotp` — the code is alphanumeric, e.g. `a1b2c3`), a new-password field, a confirm-password field, and a submit calling `resetPassword(email, code, newPassword)`.
  - `200` → toast success, dismiss, stay on the login screen so they can sign in with the new password.
  - `400` with a plain string body → inline "That code is invalid or has expired."
  - `400` ValidationProblem → read `err.error.errors.newPassword` (a `string[]`) and render those messages verbatim under the password field; they are already user-facing.
  - Client-side: block submit when the two password fields differ, mirroring the register form's `passwordMismatch` signal pattern.
- A "Resend code" button calling `requestReset` again. The server returns the *same* code while one is still valid, so no client-side dedupe is needed; reuse the 60-second cooldown pattern from `email-verification-dialog.component.ts`.

Use `ChangeDetectionStrategy.OnPush`, PrimeNG `Dialog`/`Button`/`InputText`, and `| translate` for every string.

- [ ] **Step 3: Add the login entry point**

In `login.component.html`, inside the login form, add a "Forgot password?" text button underneath the password field, right-aligned:

```html
<button type="button"
        class="text-[0.8125rem] text-text-muted hover:text-[var(--color-brand-dim)] transition-colors self-end"
        (click)="openPasswordReset()">
    {{ 'LOGIN.LOGIN.FORGOT_PASSWORD' | translate }}
</button>
```

In `login.component.ts` add:

```ts
    protected openPasswordReset(): void {
        this.passwordResetDialog.show(this.loginModel().username);
    }
```

injecting `private passwordResetDialog = inject(PasswordResetDialogService);`.

- [ ] **Step 4: Mount the dialog**

Add `<app-password-reset-dialog />` next to `<app-mfa-challenge-dialog />` in the same host template.

- [ ] **Step 5: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; suite green.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/password-reset src/app/features/login
git commit -m "feat: add forgot-password flow"
```

---

### Task 6: i18n keys

**Files:**
- Modify: `src/assets/i18n/locales/en.json`
- Modify: `src/assets/i18n/locales/de.json`
- Modify: `src/assets/i18n/locales/fr.json`

**Interfaces:**
- Consumes: every `| translate` key introduced in Tasks 3-5.

- [ ] **Step 1: Collect the keys**

Run: `grep -rhoP "(?<=')[A-Z_]+\.[A-Z_.]+(?=' \| translate)" src/app/features/settings/settings-modal/pages/security-settings src/app/features/mfa-challenge src/app/features/password-reset src/app/features/login | sort -u`

Also grep the `.html` files for `{{ 'X.Y' | translate }}` occurrences the above misses.

- [ ] **Step 2: Add every key to all three locale files**

The files are **flat** — each key is a full dotted string at the top level, e.g.:

```json
"SETTINGS.NAV.SECURITY": "Security",
"SETTINGS.SECURITY.SECTION_2FA": "Two-Factor Authentication",
"SETTINGS.SECURITY.ENABLE": "Enable 2FA",
"LOGIN.LOGIN.FORGOT_PASSWORD": "Forgot password?"
```

Insert new keys next to their topical neighbours (all `SETTINGS.SECURITY.*` together, after the existing `SETTINGS.PRIVACY.*` block). Provide real German and French translations — do not copy the English string into `de.json`/`fr.json`.

- [ ] **Step 3: Verify the JSON parses and keys match across locales**

```bash
node -e "const a=require('./src/assets/i18n/locales/en.json'),b=require('./src/assets/i18n/locales/de.json'),c=require('./src/assets/i18n/locales/fr.json');const ka=Object.keys(a).sort(),kb=Object.keys(b).sort(),kc=Object.keys(c).sort();const miss=(x,y,n)=>x.filter(k=>!y.includes(k)).forEach(k=>console.log('missing in '+n+':',k));miss(ka,kb,'de');miss(ka,kc,'fr');console.log('en',ka.length,'de',kb.length,'fr',kc.length)"
```

Expected: no "missing in" lines; all three counts equal.

- [ ] **Step 4: Commit the submodule, then the pointer**

`src/assets/i18n/locales` is a git submodule (`venta-i18n`). Commit and push **inside** it first, otherwise the parent commit records a gitlink nobody else can resolve:

```bash
cd src/assets/i18n/locales
git add en.json de.json fr.json
git commit -m "feat: add MFA and password-reset strings"
git push
cd ../../../..
git add src/assets/i18n/locales
git commit -m "chore: bump i18n submodule for MFA and password-reset strings"
```

---

## Notes for the controller

- Task 2 changes `package.json`; no other plan in this batch touches it.
- Task 4 and Task 5 both modify `login.component.ts` and the same dialog host template — they are sequential tasks in this plan, so no conflict, but a merge against other plans is not expected to touch these files.
- Only Task 6 touches the i18n submodule. **Every other plan in this batch also has an i18n task** — conflicts in `en.json`/`de.json`/`fr.json` are expected at integration and should be resolved by taking the union of added keys.
