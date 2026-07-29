# Discord Community Import — Frontend Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a guild owner kick off a Discord → Echo structure import from inside the Alpine desktop client, watch it complete without leaving the app, and manage the resulting live-sync link (pause/resume/unlink) from guild settings.

**Architecture:** The backend (`Import.*` microservice, out of this repo) is already shipped per the spec: `GET /api/v1/imports/discord/start` returns a Discord OAuth `authorizeUrl`; Discord calls a backend-only callback; polling `GET /api/v1/imports/jobs/{jobId}` reports progress; `GET/PATCH/DELETE /api/v1/imports/links` manages the ongoing link. The spec's frontend section assumes a generic hosted web app and has the backend 302-redirect the browser straight to a frontend route (`{InstanceUrl}/imports/{jobId}`) after Discord approval. **Alpine has no such hosted web route** — it's a Tauri desktop client that bundles its Angular build locally (`frontendDist: ../dist/alpine/browser` in `src-tauri/tauri.conf.json`) and already solves this exact "real external OAuth, then hop back into the running app" problem for Steam linking via a `venta://` deep link (`SteamService` + `app.component.ts`'s `handleDeepLink`). This plan follows that established pattern instead of the spec's literal web-route text (confirmed with the user): the OAuth `authorizeUrl` opens in the system browser via `ExternalLinkService`, and the return trip is a `venta://discord-import?jobId=...` deep link that the desktop app parses and turns into an in-app polling dialog. **This means the backend's callback redirect target must be changed from `{InstanceUrl}/imports/{jobId}` to `venta://discord-import?jobId={jobId}` (or `venta://discord-import?error=...` on failure before a job exists) — that change is in the `Import.Application` repo, outside this plan's scope, and must be coordinated separately.** Everything else (start/poll/links endpoints, request/response shapes) is consumed as specced.

Two entry points are added: (1) a secondary "Import from Discord instead" action inside the existing `CreateGuildModalComponent` (since an import always creates a brand-new guild, exactly like "Create a Server" does), and (2) a new "Discord Sync" page in `GuildSettingsModalComponent` for managing an existing link (visible for every guild; shows "not linked" when the links list is empty).

**Tech Stack:** Angular 21 (standalone components, signals), PrimeNG 21, Tailwind CSS v4, TypeScript, RxJS, `@ngx-translate/core`, Vitest (`ng test`).

## Global Constraints

- **Scope is frontend-only, Alpine repo only.** No backend/`Import.*` code exists here and none is added. Do not invent server-side files.
- **Structure only, matching backend scope**: no member list, no message history UI anywhere in this feature.
- **Only `Active`/`Paused` are settable from the UI** for `GuildLink.status` — `Revoked` is a server-side terminal state reached via the unlink (`DELETE`) endpoint, never PATCHed directly.
- **`SyncDirection` is read-only in the UI** for v1 — `GuildLinkDto.syncDirection` is fetched and typed but intentionally not rendered anywhere in Task 5 (every real link is `DiscordToVenta` today; `VentaToDiscord`/`Bidirectional` are modeled server-side but "not implemented", per the spec, so there is nothing meaningful to show or let the user change yet).
- **Follow existing conventions exactly:**
  - Services use `ApiConfigService.baseUrl()` (a signal, called fresh per request — never cached) for the base URL, per `GuildService`/`BotInstallService`/`SteamService`.
  - Angular DI via `inject()`, not constructor injection.
  - PrimeNG `<p-button (onClick)="...">`, never `(click)` on `p-button`.
  - Dialog services expose a `signal<T | null>` named `request`, plus `close()`, mirroring `BotInstallDialogService`.
  - Deep-link parsing lives in a standalone pure-function util file with its own `.spec.ts`, mirroring `bot-install-link.util.ts`.
  - New user-facing strings go through `TranslateModule` / `{{ 'KEY' | translate }}`, with real keys added to **all three** locale files (`src/assets/i18n/locales/en.json`, `de.json`, `fr.json` — flat dot-path keys, e.g. `"DISCORD_IMPORT.TITLE": "..."`, not nested JSON objects).
  - New services/utils get a `.spec.ts` using Vitest + `TestBed`, following `guild.service.spec.ts` (HTTP) or `bot-install-dialog.service.spec.ts` (signal-based service) patterns as appropriate.
- **Verify each task** with `npx ng test --watch=false` (must pass, zero new failures) and `npx ng build` (must compile with zero new errors).

---

## Task 1: DTOs + `DiscordImportService` (API client)

**Files:**
- Create: `src/app/dtos/response/discord-import.dto.ts`
- Create: `src/app/services/discord-import.service.ts`
- Test: `src/app/services/discord-import.service.spec.ts`

**Interfaces:**
- Produces: `ImportJobStatus`, `ImportJobDto`, `GuildLinkStatus`, `GuildLinkSyncDirection`, `GuildLinkDto`, `StartImportResponseDto` (all exported from `discord-import.dto.ts`).
- Produces: `DiscordImportService` with methods `startImport()`, `getJob(jobId)`, `getLinks(guildId)`, `setLinkStatus(linkId, status)`, `unlink(linkId)` — consumed by Task 3 (progress dialog), Task 4 (create-guild modal), and Task 5 (Discord Sync settings page).

- [ ] **Step 1: Write the DTOs**

```typescript
// src/app/dtos/response/discord-import.dto.ts
export type ImportJobStatus = 'Pending' | 'FetchingFromDiscord' | 'CreatingGuild' | 'Completed' | 'Failed';

export interface ImportJobDto {
    jobId: string;
    status: ImportJobStatus;
    guildId?: string;
    errorMessage?: string;
}

export type GuildLinkStatus = 'Active' | 'Paused' | 'Revoked';
export type GuildLinkSyncDirection = 'DiscordToVenta' | 'VentaToDiscord' | 'Bidirectional';

export interface GuildLinkDto {
    id: string;
    guildId: string;
    discordGuildId: string;
    discordGuildName: string;
    status: GuildLinkStatus;
    syncDirection: GuildLinkSyncDirection;
    createdAt: string;
}

export interface StartImportResponseDto {
    authorizeUrl: string;
}
```

- [ ] **Step 2: Write the service**

```typescript
// src/app/services/discord-import.service.ts
import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    GuildLinkDto,
    GuildLinkStatus,
    ImportJobDto,
    StartImportResponseDto,
} from '../dtos/response/discord-import.dto';

@Injectable({providedIn: 'root'})
export class DiscordImportService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);

    private base(): string {
        return `${this.apiConfig.baseUrl()}/api/v1/imports`;
    }

    startImport(): Observable<StartImportResponseDto> {
        return this.http.get<StartImportResponseDto>(`${this.base()}/discord/start`);
    }

    getJob(jobId: string): Observable<ImportJobDto> {
        return this.http.get<ImportJobDto>(`${this.base()}/jobs/${jobId}`);
    }

    getLinks(guildId: string): Observable<GuildLinkDto[]> {
        return this.http.get<GuildLinkDto[]>(`${this.base()}/links`, {params: {guildId}});
    }

    setLinkStatus(linkId: string, status: Extract<GuildLinkStatus, 'Active' | 'Paused'>): Observable<GuildLinkDto> {
        return this.http.patch<GuildLinkDto>(`${this.base()}/links/${linkId}`, {status});
    }

    unlink(linkId: string): Observable<void> {
        return this.http.delete<void>(`${this.base()}/links/${linkId}`);
    }
}
```

- [ ] **Step 3: Write the spec**

```typescript
// src/app/services/discord-import.service.spec.ts
import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {DiscordImportService} from './discord-import.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example/api/v1/imports';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(DiscordImportService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('DiscordImportService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('startImport GETs /discord/start', () => {
        const {service, ctrl} = setup();
        service.startImport().subscribe();
        const req = ctrl.expectOne(`${BASE}/discord/start`);
        expect(req.request.method).toBe('GET');
        req.flush({authorizeUrl: 'https://discord.com/oauth2/authorize?x=1'});
    });

    it('getJob GETs /jobs/{jobId}', () => {
        const {service, ctrl} = setup();
        service.getJob('job1').subscribe();
        const req = ctrl.expectOne(`${BASE}/jobs/job1`);
        expect(req.request.method).toBe('GET');
        req.flush({jobId: 'job1', status: 'Pending'});
    });

    it('getLinks GETs /links with guildId as a query param', () => {
        const {service, ctrl} = setup();
        service.getLinks('g1').subscribe();
        const req = ctrl.expectOne(r => r.url === `${BASE}/links` && r.params.get('guildId') === 'g1');
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('setLinkStatus PATCHes /links/{linkId} with the new status', () => {
        const {service, ctrl} = setup();
        service.setLinkStatus('link1', 'Paused').subscribe();
        const req = ctrl.expectOne(`${BASE}/links/link1`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({status: 'Paused'});
        req.flush({
            id: 'link1', guildId: 'g1', discordGuildId: 'd1', discordGuildName: 'D',
            status: 'Paused', syncDirection: 'DiscordToVenta', createdAt: '2026-01-01T00:00:00Z',
        });
    });

    it('unlink DELETEs /links/{linkId}', () => {
        const {service, ctrl} = setup();
        service.unlink('link1').subscribe();
        const req = ctrl.expectOne(`${BASE}/links/link1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});
```

- [ ] **Step 4: Run the new spec**

Run: `npx ng test --watch=false --include='**/discord-import.service.spec.ts'`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/dtos/response/discord-import.dto.ts src/app/services/discord-import.service.ts src/app/services/discord-import.service.spec.ts
git commit -m "feat: add Discord import DTOs and API client service"
```

---

## Task 2: Deep-link parser + `DiscordImportProgressService`

**Files:**
- Create: `src/app/features/discord-import/discord-import-link.util.ts`
- Create: `src/app/features/discord-import/discord-import-link.util.spec.ts`
- Create: `src/app/features/discord-import/discord-import-progress.service.ts`
- Create: `src/app/features/discord-import/discord-import-progress.service.spec.ts`

**Interfaces:**
- Consumes: `AuthService.isLoggedIn()` (`src/app/services/auth.service.ts`), `ToastService.error()` (`src/app/services/toast.service.ts`), `Router` (`@angular/router`).
- Produces: `parseDiscordImportLink(url): DiscordImportLinkParams | null` — consumed by Task 3 (`app.component.ts`'s `handleDeepLink`).
- Produces: `DiscordImportProgressService` with `readonly request = signal<{jobId: string} | null>(null)`, `requestOpen(params: DiscordImportLinkParams): Promise<void>`, `resumeIfPending(): void`, `close(): void` — consumed by Task 3 (progress dialog component + `app.component.ts`).

- [ ] **Step 1: Write the deep-link parser**

```typescript
// src/app/features/discord-import/discord-import-link.util.ts
export interface DiscordImportLinkParams {
    jobId?: string;
    error?: string;
}

/** Parses a `venta://discord-import?jobId=...` (or `?error=...`) deep link. Returns null if it
 *  isn't a discord-import link or carries neither a jobId nor an error. */
export function parseDiscordImportLink(url: string): DiscordImportLinkParams | null {
    if (!url.includes('discord-import')) return null;

    const params = extractQueryParams(url);
    const jobId = params.get('jobId') ?? undefined;
    const error = params.get('error') ?? undefined;
    if (!jobId && !error) return null;

    return {jobId, error};
}

function extractQueryParams(url: string): URLSearchParams {
    try {
        return new URL(url).searchParams;
    } catch {
        const queryIndex = url.indexOf('?');
        return new URLSearchParams(queryIndex === -1 ? '' : url.slice(queryIndex + 1));
    }
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/app/features/discord-import/discord-import-link.util.spec.ts
import {describe, expect, it} from 'vitest';
import {parseDiscordImportLink} from './discord-import-link.util';

describe('parseDiscordImportLink', () => {
    it('parses a jobId', () => {
        const result = parseDiscordImportLink('venta://discord-import?jobId=job_123');
        expect(result).toEqual({jobId: 'job_123', error: undefined});
    });

    it('parses an error', () => {
        const result = parseDiscordImportLink('venta://discord-import?error=access_denied');
        expect(result).toEqual({jobId: undefined, error: 'access_denied'});
    });

    it('returns null when neither jobId nor error is present', () => {
        const result = parseDiscordImportLink('venta://discord-import?foo=bar');
        expect(result).toBeNull();
    });

    it('returns null for a non-discord-import venta:// url', () => {
        const result = parseDiscordImportLink('venta://install-bot?client_id=abc');
        expect(result).toBeNull();
    });

    it('decodes a URL-encoded error message', () => {
        const result = parseDiscordImportLink('venta://discord-import?error=user%20denied%20consent');
        expect(result?.error).toBe('user denied consent');
    });
});
```

- [ ] **Step 3: Run the spec**

Run: `npx ng test --watch=false --include='**/discord-import-link.util.spec.ts'`
Expected: 5 tests pass.

- [ ] **Step 4: Write the progress service**

```typescript
// src/app/features/discord-import/discord-import-progress.service.ts
import {inject, Injectable, signal} from '@angular/core';
import {Router} from '@angular/router';
import {AuthService} from '../../services/auth.service';
import {ToastService} from '../../services/toast.service';
import {DiscordImportLinkParams} from './discord-import-link.util';

export interface DiscordImportProgressRequest {
    jobId: string;
}

@Injectable({providedIn: 'root'})
export class DiscordImportProgressService {
    private authService = inject(AuthService);
    private router = inject(Router);
    private toastService = inject(ToastService);

    /** Non-null while the import progress dialog should be visible. */
    readonly request = signal<DiscordImportProgressRequest | null>(null);

    /** Stashed when a link arrives while logged out; drained by resumeIfPending(). */
    private pendingJobId: string | null = null;

    async requestOpen(params: DiscordImportLinkParams): Promise<void> {
        if (params.error) {
            this.toastService.error(`Discord import failed: ${params.error}`);
            return;
        }
        if (!params.jobId) return;

        if (await this.authService.isLoggedIn()) {
            this.request.set({jobId: params.jobId});
        } else {
            this.pendingJobId = params.jobId;
            void this.router.navigate(['/authentication']);
        }
    }

    resumeIfPending(): void {
        if (this.pendingJobId) {
            this.request.set({jobId: this.pendingJobId});
            this.pendingJobId = null;
        }
    }

    close(): void {
        this.request.set(null);
    }
}
```

- [ ] **Step 5: Write its spec**

```typescript
// src/app/features/discord-import/discord-import-progress.service.spec.ts
import {TestBed} from '@angular/core/testing';
import {Router} from '@angular/router';
import {DiscordImportProgressService} from './discord-import-progress.service';
import {AuthService} from '../../services/auth.service';
import {ToastService} from '../../services/toast.service';

function setup(isLoggedIn: boolean) {
    const authService = {isLoggedIn: vi.fn(() => Promise.resolve(isLoggedIn))};
    const router = {navigate: vi.fn()};
    const toastService = {error: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            {provide: AuthService, useValue: authService},
            {provide: Router, useValue: router},
            {provide: ToastService, useValue: toastService},
        ],
    });

    return {
        service: TestBed.inject(DiscordImportProgressService),
        authService,
        router,
        toastService,
    };
}

describe('DiscordImportProgressService.requestOpen', () => {
    it('sets request() directly when the user is logged in', async () => {
        const {service} = setup(true);
        await service.requestOpen({jobId: 'job1'});
        expect(service.request()).toEqual({jobId: 'job1'});
    });

    it('navigates to /authentication and stashes the jobId when logged out', async () => {
        const {service, router} = setup(false);
        await service.requestOpen({jobId: 'job1'});
        expect(router.navigate).toHaveBeenCalledWith(['/authentication']);
        expect(service.request()).toBeNull();
    });

    it('shows a toast and does not set request() when params carry an error', async () => {
        const {service, toastService} = setup(true);
        await service.requestOpen({error: 'access_denied'});
        expect(toastService.error).toHaveBeenCalled();
        expect(service.request()).toBeNull();
    });

    it('is a no-op when params carry neither jobId nor error', async () => {
        const {service} = setup(true);
        await service.requestOpen({});
        expect(service.request()).toBeNull();
    });
});

describe('DiscordImportProgressService.resumeIfPending', () => {
    it('opens the stashed jobId after a logged-out requestOpen', async () => {
        const {service} = setup(false);
        await service.requestOpen({jobId: 'job1'});
        service.resumeIfPending();
        expect(service.request()).toEqual({jobId: 'job1'});
    });

    it('is a no-op the second time (stash drained)', async () => {
        const {service} = setup(false);
        await service.requestOpen({jobId: 'job1'});
        service.resumeIfPending();
        service.close();
        service.resumeIfPending();
        expect(service.request()).toBeNull();
    });
});

describe('DiscordImportProgressService.close', () => {
    it('clears request()', async () => {
        const {service} = setup(true);
        await service.requestOpen({jobId: 'job1'});
        service.close();
        expect(service.request()).toBeNull();
    });
});
```

- [ ] **Step 6: Run the spec**

Run: `npx ng test --watch=false --include='**/discord-import-progress.service.spec.ts'`
Expected: 7 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/discord-import/discord-import-link.util.ts src/app/features/discord-import/discord-import-link.util.spec.ts src/app/features/discord-import/discord-import-progress.service.ts src/app/features/discord-import/discord-import-progress.service.spec.ts
git commit -m "feat: add Discord import deep-link parser and progress dialog service"
```

---

## Task 3: Progress dialog component + app-shell wiring

**Files:**
- Create: `src/app/features/discord-import/discord-import-progress-dialog.component.ts`
- Create: `src/app/features/discord-import/discord-import-progress-dialog.component.html`
- Modify: `src/app/app.component.ts`
- Modify: `src/app/app.component.html`
- Modify: `src/assets/i18n/locales/en.json`, `de.json`, `fr.json`

**Interfaces:**
- Consumes: `DiscordImportProgressService` (Task 2), `DiscordImportService.getJob` / `ImportJobDto` / `ImportJobStatus` (Task 1), `GuildService.getGuild` / `guildJoined$` (`src/app/services/guild.service.ts`), `NavigationService.selectServer` (`src/app/features/main-page/navigation.service.ts`), `ToastService`.
- Produces: `<app-discord-import-progress-dialog>` selector, mounted once in `app.component.html`.

- [ ] **Step 1: Write the dialog component**

```typescript
// src/app/features/discord-import/discord-import-progress-dialog.component.ts
import {ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Subscription, interval, switchMap, takeWhile} from 'rxjs';
import {DiscordImportProgressService} from './discord-import-progress.service';
import {DiscordImportService} from '../../services/discord-import.service';
import {GuildService} from '../../services/guild.service';
import {NavigationService} from '../main-page/navigation.service';
import {ToastService} from '../../services/toast.service';
import {ImportJobDto, ImportJobStatus} from '../../dtos/response/discord-import.dto';

const POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES: ImportJobStatus[] = ['Completed', 'Failed'];

@Component({
    selector: 'app-discord-import-progress-dialog',
    imports: [Dialog, Button, PrimeTemplate, TranslateModule],
    templateUrl: './discord-import-progress-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiscordImportProgressDialogComponent {
    protected readonly dialogService = inject(DiscordImportProgressService);
    private readonly discordImportService = inject(DiscordImportService);
    private readonly guildService = inject(GuildService);
    private readonly navigationService = inject(NavigationService);
    private readonly toastService = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly destroyRef = inject(DestroyRef);

    protected readonly visible = computed(() => this.dialogService.request() !== null);
    protected readonly job = signal<ImportJobDto | null>(null);

    private pollSub: Subscription | null = null;

    protected readonly statusLabel = computed(() => {
        const status = this.job()?.status;
        switch (status) {
            case 'Pending':
                return this.translate.instant('DISCORD_IMPORT.STATUS_PENDING');
            case 'FetchingFromDiscord':
                return this.translate.instant('DISCORD_IMPORT.STATUS_FETCHING');
            case 'CreatingGuild':
                return this.translate.instant('DISCORD_IMPORT.STATUS_CREATING');
            case 'Completed':
                return this.translate.instant('DISCORD_IMPORT.STATUS_COMPLETED');
            case 'Failed':
                return this.translate.instant('DISCORD_IMPORT.STATUS_FAILED');
            default:
                return this.translate.instant('DISCORD_IMPORT.STATUS_PENDING');
        }
    });

    constructor() {
        effect(() => {
            const request = this.dialogService.request();
            this.pollSub?.unsubscribe();
            this.pollSub = null;
            this.job.set(null);
            if (!request) return;

            this.pollSub = interval(POLL_INTERVAL_MS).pipe(
                switchMap(() => this.discordImportService.getJob(request.jobId)),
                takeWhile(job => !TERMINAL_STATUSES.includes(job.status), true),
                takeUntilDestroyed(this.destroyRef),
            ).subscribe({
                next: job => {
                    this.job.set(job);
                    if (job.status === 'Completed' && job.guildId) this.onCompleted(job.guildId);
                },
                error: err => {
                    this.toastService.httpError('Failed to check import status', err);
                    this.dialogService.close();
                },
            });

            // Kick off an immediate check instead of waiting a full interval tick.
            this.discordImportService.getJob(request.jobId).subscribe({
                next: job => {
                    this.job.set(job);
                    if (job.status === 'Completed' && job.guildId) this.onCompleted(job.guildId);
                },
            });
        });
    }

    protected dismiss(): void {
        this.dialogService.close();
    }

    private onCompleted(guildId: string): void {
        this.pollSub?.unsubscribe();
        this.pollSub = null;
        this.guildService.getGuild(guildId).subscribe(guild => {
            this.guildService.guildJoined$.next();
            this.navigationService.selectServer(guild);
            this.toastService.success(this.translate.instant('DISCORD_IMPORT.SUCCESS_TOAST', {name: guild.name}));
            this.dialogService.close();
        });
    }
}
```

- [ ] **Step 2: Write the dialog template**

```html
<!-- src/app/features/discord-import/discord-import-progress-dialog.component.html -->
<p-dialog
        [closable]="job()?.status === 'Failed'"
        [dismissableMask]="false"
        [draggable]="false"
        [modal]="true"
        [resizable]="false"
        [style]="{width: '400px'}"
        [visible]="visible()"
        appendTo="body"
        (visibleChange)="$event === false && dismiss()">

    <ng-template pTemplate="header">
        <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center"
                 style="background: color-mix(in srgb, var(--color-brand) 12%, transparent)">
                <i class="pi pi-discord text-sm" style="color: var(--color-brand-dim)"></i>
            </div>
            <span class="text-base font-semibold" style="color: var(--color-text-primary)">
                {{ 'DISCORD_IMPORT.TITLE' | translate }}
            </span>
        </div>
    </ng-template>

    <div class="py-4 flex flex-col items-center gap-4 text-center">
        @if (job()?.status === 'Failed') {
            <i class="pi pi-times-circle text-3xl text-rose-400"></i>
            <p class="text-sm text-white/70">{{ job()?.errorMessage || statusLabel() }}</p>
        } @else {
            <i class="pi pi-spin pi-spinner text-3xl" style="color: var(--color-brand-dim)"></i>
            <p class="text-sm text-white/70">{{ statusLabel() }}</p>
        }
    </div>

    <ng-template pTemplate="footer">
        @if (job()?.status === 'Failed') {
            <p-button (onClick)="dismiss()" label="{{ 'DISCORD_IMPORT.CLOSE' | translate }}" severity="secondary" size="small"/>
        }
    </ng-template>

</p-dialog>
```

- [ ] **Step 3: Add i18n keys**

Add these flat keys to `src/assets/i18n/locales/en.json` (alongside the existing `CREATE_GUILD.*` keys):

```json
"DISCORD_IMPORT.TITLE": "Importing from Discord",
"DISCORD_IMPORT.STATUS_PENDING": "Starting import…",
"DISCORD_IMPORT.STATUS_FETCHING": "Fetching structure from Discord…",
"DISCORD_IMPORT.STATUS_CREATING": "Creating your server…",
"DISCORD_IMPORT.STATUS_COMPLETED": "Done!",
"DISCORD_IMPORT.STATUS_FAILED": "Import failed",
"DISCORD_IMPORT.SUCCESS_TOAST": "Imported {{ name }} from Discord",
"DISCORD_IMPORT.CLOSE": "Close",
```

Add the equivalent German keys to `de.json`:

```json
"DISCORD_IMPORT.TITLE": "Import von Discord",
"DISCORD_IMPORT.STATUS_PENDING": "Import wird gestartet…",
"DISCORD_IMPORT.STATUS_FETCHING": "Struktur wird von Discord abgerufen…",
"DISCORD_IMPORT.STATUS_CREATING": "Server wird erstellt…",
"DISCORD_IMPORT.STATUS_COMPLETED": "Fertig!",
"DISCORD_IMPORT.STATUS_FAILED": "Import fehlgeschlagen",
"DISCORD_IMPORT.SUCCESS_TOAST": "{{ name }} von Discord importiert",
"DISCORD_IMPORT.CLOSE": "Schließen",
```

Add the equivalent French keys to `fr.json`:

```json
"DISCORD_IMPORT.TITLE": "Importation depuis Discord",
"DISCORD_IMPORT.STATUS_PENDING": "Démarrage de l'importation…",
"DISCORD_IMPORT.STATUS_FETCHING": "Récupération de la structure depuis Discord…",
"DISCORD_IMPORT.STATUS_CREATING": "Création de votre serveur…",
"DISCORD_IMPORT.STATUS_COMPLETED": "Terminé !",
"DISCORD_IMPORT.STATUS_FAILED": "Échec de l'importation",
"DISCORD_IMPORT.SUCCESS_TOAST": "{{ name }} importé depuis Discord",
"DISCORD_IMPORT.CLOSE": "Fermer",
```

Insert each block as additional top-level flat properties in the existing JSON object (match the file's existing formatting — comma-separated `"KEY.PATH": "value"` entries, not nested).

- [ ] **Step 4: Wire the deep link and dialog into `app.component.ts`**

In `src/app/app.component.ts`, add imports and injection:

```typescript
import {DiscordImportProgressDialogComponent} from './features/discord-import/discord-import-progress-dialog.component';
import {DiscordImportProgressService} from './features/discord-import/discord-import-progress.service';
import {parseDiscordImportLink} from './features/discord-import/discord-import-link.util';
```

Add `DiscordImportProgressDialogComponent` to the `@Component({imports: [...]})` array (next to `BotInstallDialogComponent`).

Add the field:

```typescript
private discordImportProgressService = inject(DiscordImportProgressService);
```

In `ngOnInit()`, extend the existing `router.events` subscription that calls `this.botInstallDialogService.resumeIfPending()` (around line 85) to also resume the Discord import dialog:

```typescript
this.router.events.pipe(
    filter(e => e instanceof NavigationEnd),
    filter(() => this.router.url.startsWith('/overview')),
    takeUntilDestroyed(this.destroyRef),
).subscribe(() => {
    this.botInstallDialogService.resumeIfPending();
    this.discordImportProgressService.resumeIfPending();
});
```

In `handleDeepLink(url: string)`, add a branch before the final `install-bot` check (order doesn't matter since the substrings are disjoint, but keep it visually grouped with the other real-OAuth deep link, `steam-auth`):

```typescript
if (url.includes('discord-import')) {
    const params = parseDiscordImportLink(url);
    if (params) void this.discordImportProgressService.requestOpen(params);
    return;
}
```

- [ ] **Step 5: Mount the dialog in `app.component.html`**

`app.component.html:16` currently reads `<app-bot-install-dialog/>`. Add the new dialog as the next sibling:

```html
<app-bot-install-dialog/>
<app-discord-import-progress-dialog/>
```

- [ ] **Step 6: Build to confirm no compile errors**

Run: `npx ng build`
Expected: succeeds with zero new errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/features/discord-import/discord-import-progress-dialog.component.ts src/app/features/discord-import/discord-import-progress-dialog.component.html src/app/app.component.ts src/app/app.component.html src/assets/i18n/locales/en.json src/assets/i18n/locales/de.json src/assets/i18n/locales/fr.json
git commit -m "feat: add Discord import progress dialog and wire deep link into app shell"
```

---

## Task 4: "Import from Discord" entry point in `CreateGuildModalComponent`

**Files:**
- Modify: `src/app/features/guild/components/create-guild-modal/create-guild-modal.component.ts`
- Modify: `src/app/features/guild/components/create-guild-modal/create-guild-modal.component.html`
- Modify: `src/assets/i18n/locales/en.json`, `de.json`, `fr.json`

**Interfaces:**
- Consumes: `DiscordImportService.startImport()` (Task 1), `ExternalLinkService.openExternalLink` (`src/app/services/external-link.service.ts`), `ToastService`.

- [ ] **Step 1: Add the import trigger to the component**

In `create-guild-modal.component.ts`, add imports:

```typescript
import {DiscordImportService} from '../../../../services/discord-import.service';
import {ExternalLinkService} from '../../../../services/external-link.service';
import {ToastService} from '../../../../services/toast.service';
```

Add fields and a method inside the class:

```typescript
readonly importingFromDiscord = signal(false);
private discordImportService = inject(DiscordImportService);
private externalLinkService = inject(ExternalLinkService);
private toastService = inject(ToastService);

startDiscordImport(): void {
    if (this.importingFromDiscord() || this.loading()) return;
    this.importingFromDiscord.set(true);
    this.discordImportService.startImport().subscribe({
        next: res => {
            this.importingFromDiscord.set(false);
            this.close();
            void this.externalLinkService.openExternalLink(res.authorizeUrl);
        },
        error: err => {
            this.importingFromDiscord.set(false);
            this.toastService.httpError('Failed to start Discord import', err);
        },
    });
}
```

- [ ] **Step 2: Add the entry point to the template**

In `create-guild-modal.component.html`, inside the `<ng-template pTemplate="footer">` block, add a left-aligned secondary action alongside the existing Cancel/Create buttons (footer becomes a `justify-between` row: import action on the left, cancel/create on the right):

```html
<ng-template pTemplate="footer">
    <div class="flex items-center justify-between w-full pt-1">
        <p-button (onClick)="startDiscordImport()"
                  [disabled]="loading()"
                  [loading]="importingFromDiscord()"
                  [text]="true"
                  icon="pi pi-discord"
                  [label]="'CREATE_GUILD.IMPORT_FROM_DISCORD' | translate"
                  severity="secondary"
                  size="small"/>
        <div class="flex items-center gap-2">
            <p-button (onClick)="close()" [disabled]="loading()" [label]="'CREATE_GUILD.CANCEL' | translate" [text]="true"
                      severity="secondary" size="small"/>
            <p-button
                    (onClick)="submit()"
                    [disabled]="!name().trim() || loading()"
                    [label]="'CREATE_GUILD.CREATE' | translate"
                    [loading]="loading()"
                    severity="primary"
                    size="small"/>
        </div>
    </div>
</ng-template>
```

- [ ] **Step 3: Add the i18n key**

Add to `en.json`: `"CREATE_GUILD.IMPORT_FROM_DISCORD": "Import from Discord"`
Add to `de.json`: `"CREATE_GUILD.IMPORT_FROM_DISCORD": "Von Discord importieren"`
Add to `fr.json`: `"CREATE_GUILD.IMPORT_FROM_DISCORD": "Importer depuis Discord"`

- [ ] **Step 4: Build to confirm no compile errors**

Run: `npx ng build`
Expected: succeeds with zero new errors.

- [ ] **Step 5: Manual check**

Run the app (`bun run start` + `bun run tauri dev`, or whatever the project's existing dev workflow is), open the "+" add-server button, confirm the new "Import from Discord" button renders in the footer, is disabled while the name field submit is in flight, and (since no real Discord app is registered yet per the spec's "Not yet deployed" note) at minimum confirm clicking it calls the endpoint and surfaces a toast on error (a 404/500 from the not-yet-deployed backend is an acceptable outcome to observe here — the goal is confirming the request fires and errors surface, not a live Discord round-trip).

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/components/create-guild-modal/create-guild-modal.component.ts src/app/features/guild/components/create-guild-modal/create-guild-modal.component.html src/assets/i18n/locales/en.json src/assets/i18n/locales/de.json src/assets/i18n/locales/fr.json
git commit -m "feat: add Import from Discord entry point to the create-guild modal"
```

---

## Task 5: "Discord Sync" guild settings page

**Files:**
- Create: `src/app/features/guild/components/guild-settings-modal/pages/discord-sync-settings/discord-sync-settings.component.ts`
- Create: `src/app/features/guild/components/guild-settings-modal/pages/discord-sync-settings/discord-sync-settings.component.html`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html`
- Modify: `src/assets/i18n/locales/en.json`, `de.json`, `fr.json`

**Interfaces:**
- Consumes: `DiscordImportService.getLinks` / `setLinkStatus` / `unlink` (Task 1), `GuildLinkDto` (Task 1), `ToastService`.

- [ ] **Step 1: Write the settings page component**

```typescript
// src/app/features/guild/components/guild-settings-modal/pages/discord-sync-settings/discord-sync-settings.component.ts
import {Component, inject, input, OnInit, signal} from '@angular/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildLinkDto} from '../../../../../../dtos/response/discord-import.dto';
import {DiscordImportService} from '../../../../../../services/discord-import.service';
import {ToastService} from '../../../../../../services/toast.service';

@Component({
    selector: 'app-discord-sync-settings',
    imports: [Button, Dialog, PrimeTemplate, TranslateModule],
    templateUrl: './discord-sync-settings.component.html',
})
export class DiscordSyncSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();

    links = signal<GuildLinkDto[]>([]);
    loading = signal(false);
    busyLinkId = signal<string | null>(null);
    showUnlinkDialog = signal(false);
    unlinkTarget = signal<GuildLinkDto | null>(null);

    private discordImportService = inject(DiscordImportService);
    private toastService = inject(ToastService);

    ngOnInit(): void {
        this.loadLinks();
    }

    loadLinks(): void {
        this.loading.set(true);
        this.discordImportService.getLinks(this.guild().id).subscribe({
            next: links => {
                this.links.set(links);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError('Failed to load Discord sync status', err);
            },
        });
    }

    togglePause(link: GuildLinkDto): void {
        if (this.busyLinkId()) return;
        const next = link.status === 'Active' ? 'Paused' : 'Active';
        this.busyLinkId.set(link.id);
        this.discordImportService.setLinkStatus(link.id, next).subscribe({
            next: updated => {
                this.links.update(ls => ls.map(l => l.id === updated.id ? updated : l));
                this.busyLinkId.set(null);
            },
            error: err => {
                this.busyLinkId.set(null);
                this.toastService.httpError('Failed to update sync status', err);
            },
        });
    }

    confirmUnlink(link: GuildLinkDto): void {
        this.unlinkTarget.set(link);
        this.showUnlinkDialog.set(true);
    }

    unlink(): void {
        const link = this.unlinkTarget();
        if (!link || this.busyLinkId()) return;
        this.busyLinkId.set(link.id);
        this.discordImportService.unlink(link.id).subscribe({
            next: () => {
                this.links.update(ls => ls.filter(l => l.id !== link.id));
                this.busyLinkId.set(null);
                this.showUnlinkDialog.set(false);
                this.unlinkTarget.set(null);
                this.toastService.success('Discord server unlinked');
            },
            error: err => {
                this.busyLinkId.set(null);
                this.toastService.httpError('Failed to unlink Discord server', err);
            },
        });
    }
}
```

- [ ] **Step 2: Write the settings page template**

```html
<!-- src/app/features/guild/components/guild-settings-modal/pages/discord-sync-settings/discord-sync-settings.component.html -->
<div class="max-w-lg space-y-6">

    <div>
        <p class="text-xs font-semibold text-white/40 uppercase tracking-widest mb-3">
            {{ 'GUILD_SETTINGS.DISCORD_SYNC.TITLE' | translate }}
        </p>
        <p class="text-[11px] text-white/25 mb-4">
            {{ 'GUILD_SETTINGS.DISCORD_SYNC.HINT' | translate }}
        </p>

        @if (loading()) {
            <p class="text-sm text-white/40">{{ 'GUILD_SETTINGS.DISCORD_SYNC.LOADING' | translate }}</p>
        } @else if (links().length === 0) {
            <p class="text-sm text-white/40">{{ 'GUILD_SETTINGS.DISCORD_SYNC.NOT_LINKED' | translate }}</p>
        } @else {
            <div class="space-y-3">
                @for (link of links(); track link.id) {
                    <div class="flex items-center justify-between gap-3 p-3 rounded-xl bg-card border border-white/[0.08]">
                        <div class="min-w-0">
                            <p class="text-sm text-white/85 truncate">{{ link.discordGuildName }}</p>
                            <p class="text-[11px] text-white/40 mt-0.5">
                                @if (link.status === 'Active') {
                                    {{ 'GUILD_SETTINGS.DISCORD_SYNC.STATUS_ACTIVE' | translate }}
                                } @else if (link.status === 'Paused') {
                                    {{ 'GUILD_SETTINGS.DISCORD_SYNC.STATUS_PAUSED' | translate }}
                                } @else {
                                    {{ 'GUILD_SETTINGS.DISCORD_SYNC.STATUS_REVOKED' | translate }}
                                }
                            </p>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                            <p-button (onClick)="togglePause(link)"
                                      [disabled]="busyLinkId() === link.id"
                                      [label]="(link.status === 'Active' ? 'GUILD_SETTINGS.DISCORD_SYNC.PAUSE' : 'GUILD_SETTINGS.DISCORD_SYNC.RESUME') | translate"
                                      [text]="true"
                                      severity="secondary"
                                      size="small"/>
                            <p-button (onClick)="confirmUnlink(link)"
                                      [disabled]="busyLinkId() === link.id"
                                      [label]="'GUILD_SETTINGS.DISCORD_SYNC.UNLINK' | translate"
                                      [text]="true"
                                      severity="danger"
                                      size="small"/>
                        </div>
                    </div>
                }
            </div>
        }
    </div>

</div>

<p-dialog [(visible)]="showUnlinkDialog" [draggable]="false" [modal]="true" [resizable]="false"
          [style]="{width: '420px'}" appendTo="body">
    <ng-template pTemplate="header">
        <span class="text-sm font-semibold text-rose-400">{{ 'GUILD_SETTINGS.DISCORD_SYNC.UNLINK_TITLE' | translate }}</span>
    </ng-template>
    <p class="text-sm text-white/70">
        {{ 'GUILD_SETTINGS.DISCORD_SYNC.UNLINK_CONFIRM' | translate }}
    </p>
    <ng-template pTemplate="footer">
        <p-button (onClick)="showUnlinkDialog.set(false)" [text]="true" [label]="'GUILD_SETTINGS.DISCORD_SYNC.CANCEL' | translate"/>
        <p-button (onClick)="unlink()" [loading]="busyLinkId() === unlinkTarget()?.id"
                  [label]="'GUILD_SETTINGS.DISCORD_SYNC.UNLINK_BTN' | translate" severity="danger"/>
    </ng-template>
</p-dialog>
```

- [ ] **Step 3: Register the page in `guild-settings-modal.component.ts`**

Add the import:

```typescript
import {DiscordSyncSettingsComponent} from './pages/discord-sync-settings/discord-sync-settings.component';
```

Add `DiscordSyncSettingsComponent` to the `@Component({imports: [...]})` array.

Add a new nav item to the `Community` group in `navGroups` (after `invites`):

```typescript
{
    title: 'Community',
    items: [
        {id: 'invites', label: 'Invites', icon: 'pi pi-link'},
        {id: 'discord-sync', label: 'Discord Sync', icon: 'pi pi-discord'},
    ],
},
```

- [ ] **Step 4: Render the page in the modal template**

In `guild-settings-modal.component.html`, the page content area uses an `@switch (activePage())` block (around line 84-103). Add a new `@case` right after the existing `@case ('invites')` block:

```html
                    @case ('invites') {
                        <app-invites-settings [guild]="guild()"/>
                    }
                    @case ('discord-sync') {
                        <app-discord-sync-settings [guild]="guild()"/>
                    }
```

- [ ] **Step 5: Add i18n keys**

Add to `en.json`:

```json
"GUILD_SETTINGS.NAV.DISCORD_SYNC": "Discord Sync",
"GUILD_SETTINGS.DISCORD_SYNC.TITLE": "Discord Sync",
"GUILD_SETTINGS.DISCORD_SYNC.HINT": "Structure changes made on the linked Discord server (categories, channels, roles) are applied here automatically.",
"GUILD_SETTINGS.DISCORD_SYNC.LOADING": "Loading…",
"GUILD_SETTINGS.DISCORD_SYNC.NOT_LINKED": "This server wasn't imported from Discord.",
"GUILD_SETTINGS.DISCORD_SYNC.STATUS_ACTIVE": "Syncing from Discord",
"GUILD_SETTINGS.DISCORD_SYNC.STATUS_PAUSED": "Sync paused",
"GUILD_SETTINGS.DISCORD_SYNC.STATUS_REVOKED": "Unlinked",
"GUILD_SETTINGS.DISCORD_SYNC.PAUSE": "Pause",
"GUILD_SETTINGS.DISCORD_SYNC.RESUME": "Resume",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK": "Unlink",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK_TITLE": "Unlink Discord Server",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK_CONFIRM": "This stops syncing changes from the linked Discord server. The bot will leave the Discord server. This cannot be undone.",
"GUILD_SETTINGS.DISCORD_SYNC.CANCEL": "Cancel",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK_BTN": "Unlink",
```

Add to `de.json`:

```json
"GUILD_SETTINGS.NAV.DISCORD_SYNC": "Discord-Sync",
"GUILD_SETTINGS.DISCORD_SYNC.TITLE": "Discord-Sync",
"GUILD_SETTINGS.DISCORD_SYNC.HINT": "Strukturänderungen auf dem verknüpften Discord-Server (Kategorien, Kanäle, Rollen) werden hier automatisch übernommen.",
"GUILD_SETTINGS.DISCORD_SYNC.LOADING": "Wird geladen…",
"GUILD_SETTINGS.DISCORD_SYNC.NOT_LINKED": "Dieser Server wurde nicht von Discord importiert.",
"GUILD_SETTINGS.DISCORD_SYNC.STATUS_ACTIVE": "Synchronisiert mit Discord",
"GUILD_SETTINGS.DISCORD_SYNC.STATUS_PAUSED": "Sync pausiert",
"GUILD_SETTINGS.DISCORD_SYNC.STATUS_REVOKED": "Nicht mehr verknüpft",
"GUILD_SETTINGS.DISCORD_SYNC.PAUSE": "Pausieren",
"GUILD_SETTINGS.DISCORD_SYNC.RESUME": "Fortsetzen",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK": "Verknüpfung aufheben",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK_TITLE": "Discord-Verknüpfung aufheben",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK_CONFIRM": "Dadurch wird die Synchronisierung mit dem verknüpften Discord-Server beendet. Der Bot verlässt den Discord-Server. Dies kann nicht rückgängig gemacht werden.",
"GUILD_SETTINGS.DISCORD_SYNC.CANCEL": "Abbrechen",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK_BTN": "Verknüpfung aufheben",
```

Add to `fr.json`:

```json
"GUILD_SETTINGS.NAV.DISCORD_SYNC": "Synchro Discord",
"GUILD_SETTINGS.DISCORD_SYNC.TITLE": "Synchro Discord",
"GUILD_SETTINGS.DISCORD_SYNC.HINT": "Les changements de structure sur le serveur Discord lié (catégories, salons, rôles) sont appliqués ici automatiquement.",
"GUILD_SETTINGS.DISCORD_SYNC.LOADING": "Chargement…",
"GUILD_SETTINGS.DISCORD_SYNC.NOT_LINKED": "Ce serveur n'a pas été importé depuis Discord.",
"GUILD_SETTINGS.DISCORD_SYNC.STATUS_ACTIVE": "Synchronisation depuis Discord",
"GUILD_SETTINGS.DISCORD_SYNC.STATUS_PAUSED": "Synchronisation en pause",
"GUILD_SETTINGS.DISCORD_SYNC.STATUS_REVOKED": "Dissocié",
"GUILD_SETTINGS.DISCORD_SYNC.PAUSE": "Suspendre",
"GUILD_SETTINGS.DISCORD_SYNC.RESUME": "Reprendre",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK": "Dissocier",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK_TITLE": "Dissocier le serveur Discord",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK_CONFIRM": "Cela arrête la synchronisation depuis le serveur Discord lié. Le bot quittera le serveur Discord. Cette action est irréversible.",
"GUILD_SETTINGS.DISCORD_SYNC.CANCEL": "Annuler",
"GUILD_SETTINGS.DISCORD_SYNC.UNLINK_BTN": "Dissocier",
```

- [ ] **Step 6: Note on the nav label i18n key (no action needed)**

The template already pipes `{{ item.label | translate }}` for every nav entry (see `guild-settings-modal.component.html:49`), but the `navGroups` array in the `.ts` file populates `label` with a raw English string (`'Discord Sync'`, from Step 3) rather than a translation key path — this matches the existing convention for every other nav item (`'Overview'`, `'Members'`, etc.), which is a pre-existing i18n gap in this modal, not something this task introduces or should fix. The `GUILD_SETTINGS.NAV.DISCORD_SYNC` key added in Step 5 exists only for parity with the other unused `NAV.*` keys already sitting in the locale files; it is not consumed anywhere today.

- [ ] **Step 7: Build to confirm no compile errors**

Run: `npx ng build`
Expected: succeeds with zero new errors.

- [ ] **Step 8: Manual check**

Run the app, open any guild's Server Settings, click "Discord Sync" in the Community nav group, confirm it shows "This server wasn't imported from Discord." (since no real link exists yet without a live backend), and confirm the loading state briefly appears first.

- [ ] **Step 9: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/pages/discord-sync-settings src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html src/assets/i18n/locales/en.json src/assets/i18n/locales/de.json src/assets/i18n/locales/fr.json
git commit -m "feat: add Discord Sync guild settings page (pause/resume/unlink)"
```

---

## Task 6: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx ng test --watch=false`
Expected: all tests pass, including the new specs from Tasks 1 and 2, zero new failures elsewhere.

- [ ] **Step 2: Run a full production build**

Run: `npx ng build`
Expected: succeeds with zero errors.

- [ ] **Step 3: Manual end-to-end smoke check (best-effort, no live Discord app registered yet)**

Run the app via the project's normal dev workflow. Confirm:
- The "+" add-server button opens `CreateGuildModalComponent` and shows the new "Import from Discord" footer button.
- Clicking it calls `GET /api/v1/imports/discord/start` (check network tab / dev console) and attempts to open the returned URL externally, or surfaces a toast if the backend call fails (expected today, since no Discord application is registered per the spec).
- Server Settings → Discord Sync renders the empty state for a guild with no link.
- No console errors on any of these screens.

- [ ] **Step 4: Note the outstanding cross-repo dependency**

Confirm (by re-reading this plan's Architecture section) that the backend's `Import.Application` callback redirect target still needs to change from `{InstanceUrl}/imports/{jobId}` to `venta://discord-import?jobId={jobId}` (success) / `venta://discord-import?error={message}` (failure before a job exists) before this feature can be exercised end-to-end against real Discord. Flag this to whoever owns that repo — it is not fixable from Alpine.
