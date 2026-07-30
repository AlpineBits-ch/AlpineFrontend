# Custom Guild Emoji Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let guild members with `ManageEmojis` upload/delete per-guild custom emoji from a new Guild Settings page, and let any member react to guild-channel messages with those emoji (in addition to today's unicode reactions) — reusing the already-live backend endpoints and realtime events.

**Architecture:** A new `GuildEmojiService` + `GuildEmojiStore` (per-guild cached list, refreshed on `guild.EmojiCreated`/`EmojiDeleted` and revalidated hourly to dodge presigned-URL expiry) back a new `EmojiSettingsComponent` guild-settings page. On the reaction side, `MessageReaction`/`CreateReactionDto`/the realtime `ReactionEvent` all gain an optional `emojiId`. `ReactionPickerComponent` is extended to inject the guild's custom emoji into emoji-mart's `custom` config (guild channels only, never DMs — `guildId` is simply not passed down in DMs), and its output type changes from a plain unicode string to a small `EmojiSelection` union so callers can tell a unicode pick apart from a custom-emoji pick. `MessageReactionBarComponent` renders custom-emoji reactions as an `<img>` (resolved through the same store) with a `:name:` text fallback when the emoji has since been deleted, exactly as the backend guide specifies.

**Tech Stack:** Angular 21 (signals, `input()`, new `@if`/`@for` control flow), `@ngrx/signals` (new `GuildEmojiStore`, mirroring the existing `MessageStore`), Vitest (`*.spec.ts`, run via `ng test`), PrimeNG (`Button`, `Dialog`, `InputText`, `Checkbox`), `emoji-mart` v5.6 (already a dependency — its `custom` prop and `onEmojiSelect` payload shape are confirmed directly against `node_modules/emoji-mart/dist/module.js` in Task 7, not guessed).

## Global Constraints

- `GET https://api.venta.gg/api/v1/guild/guilds/{guildId}/emojis` — list, requires `ViewChannel` (any member).
- `POST https://api.venta.gg/api/v1/guild/guilds/{guildId}/emojis` — upload, multipart (`name`, `animated`, `file`), requires `ManageEmojis`. Duplicate name (case-insensitive) returns `409`.
- `DELETE https://api.venta.gg/api/v1/guild/guilds/{guildId}/emojis/{emojiId}` — delete, requires `ManageEmojis`.
- `ManageEmojis` is a new permission bit with no default grantees — add it to the canonical `Permissions`/`PERM_GROUPS` in `permissions.enum.ts` only. Do **not** add it to the channel-permission-override editor's local group list (`permission-override-editor.component.ts`) — that list is deliberately missing other guild-only permissions too (`ManageGuild`, `KickMembers`, etc.), since per-channel overrides for a guild-wide setting don't make sense.
- `imageUrl` on a `GuildEmoji` is presigned and expires in ~1h — cache the emoji list but refetch (not just the URL) once it's been an hour; never persist `imageUrl` beyond the in-memory cache.
- Reacting: `POST .../messages/{messageId}/reactions` body is `{channelId, emojiId}` (no `reaction` field) for a custom emoji, or the existing `{conversationId, reaction, channelId?}` for unicode. Custom-emoji reactions are guild-channel only — never send `emojiId` alongside `conversationId` (the server 400s this; the client-side fix is simply that `ReactionPickerComponent` never receives a `guildId` in DM contexts, so the custom-emoji section of the picker never renders there).
- Removing a reaction is unchanged regardless of emoji kind — always `{reaction: <name-or-unicode>, contextId, channelId?}`, no `emojiId` involved.
- Every reaction read back from history/realtime carries `emojiId` (`null`/absent for unicode). `emoji` is always populated (unicode char, or the custom emoji's name as text fallback).
- No inline `:name:` autocomplete/rendering in message *content* — reactions only, per the backend guide's "Known limitations."
- No animated-emoji-specific playback handling beyond passing the `animated` flag through — out of scope.
- A deleted emoji's existing reactions keep their `emojiId`/name but won't resolve against the current list — render the `:name:` text fallback in that case, don't hide or error.
- Full spec: see the "Custom guild emoji — frontend integration guide" section of the conversation this plan originated from (not a repo file — inline in the planning session).

---

### Task 1: `ManageEmojis` permission + `GuildEmojiDto` model

**Files:**
- Modify: `src/app/enums/permissions.enum.ts`
- Modify: `src/app/enums/permissions.enum.spec.ts`
- Create: `src/app/dtos/response/guild-emoji.dto.ts`

**Interfaces:**
- Produces: `Permissions.ManageEmojis`, `GuildEmojiDto` — consumed by every later task.

- [ ] **Step 1: Write the failing permission tests**

In `src/app/enums/permissions.enum.spec.ts`, add a new test inside the existing `describe('Permissions moderation bits', ...)` block, right after the `'does not collide with any existing bit (0-31, 63)'` test:

```ts
    it('defines ManageEmojis at bit 37', () => {
        expect(Permissions.ManageEmojis).toBe(1n << 37n);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ng test --include='**/permissions.enum.spec.ts'`
Expected: FAIL — `Permissions.ManageEmojis` is `undefined`. The pre-existing `'places every PermissionKey except None in exactly one group'` test in the same file will also fail once Step 3 adds the bit but before Step 4 adds it to a group — that's expected and is exactly what that test is for.

- [ ] **Step 3: Add the permission bit**

In `src/app/enums/permissions.enum.ts`, add a new section right after the `ViewAuditLog` line and before the `Catch-all` comment:

Before:
```ts
    // ── Guild moderation permissions ─────────────────────────────────────────
    KickMembers: 1n << 32n,
    BanMembers: 1n << 33n,
    ModerateMembers: 1n << 34n,
    ManageGuild: 1n << 35n,
    ViewAuditLog: 1n << 36n,

    // ── Catch-all ────────────────────────────────────────────────────────────
    Superadmin: 1n << 63n,
```

After:
```ts
    // ── Guild moderation permissions ─────────────────────────────────────────
    KickMembers: 1n << 32n,
    BanMembers: 1n << 33n,
    ModerateMembers: 1n << 34n,
    ManageGuild: 1n << 35n,
    ViewAuditLog: 1n << 36n,

    // ── Emoji permissions ─────────────────────────────────────────────────────
    ManageEmojis: 1n << 37n,

    // ── Catch-all ────────────────────────────────────────────────────────────
    Superadmin: 1n << 63n,
```

- [ ] **Step 4: Add it to `PERM_GROUPS`**

In the same file, add a new group right after the `'Moderation'` group and before `'Wiki'`:

Before:
```ts
    {
        label: 'Moderation',
        perms: ['ManageChannel', 'ManagePermissions', 'ManageGuild', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog'],
    },
    {
        label: 'Wiki',
```

After:
```ts
    {
        label: 'Moderation',
        perms: ['ManageChannel', 'ManagePermissions', 'ManageGuild', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog'],
    },
    {
        label: 'Emojis',
        perms: ['ManageEmojis'],
    },
    {
        label: 'Wiki',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx ng test --include='**/permissions.enum.spec.ts'`
Expected: PASS, including the pre-existing group-completeness test (confirms `ManageEmojis` was placed in exactly one group).

- [ ] **Step 6: Add the `GuildEmojiDto` model**

Create `src/app/dtos/response/guild-emoji.dto.ts`:

```ts
export interface GuildEmojiDto {
    id: string;
    guildId: string;
    name: string;
    animated: boolean;
    createdByUserId: string;
    createdAt: string;
    /** Presigned, expires ~1h — refetch the list (not just this URL) once it's been an hour. */
    imageUrl: string;
}
```

- [ ] **Step 7: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 8: Commit**

```bash
git add src/app/enums/permissions.enum.ts src/app/enums/permissions.enum.spec.ts src/app/dtos/response/guild-emoji.dto.ts
git commit -m "feat: add ManageEmojis permission and GuildEmoji model"
```

---

### Task 2: `GuildEmojiService`

**Files:**
- Create: `src/app/services/guild-emoji.service.ts`
- Create: `src/app/services/guild-emoji.service.spec.ts`

**Interfaces:**
- Consumes: `GuildEmojiDto` (Task 1).
- Produces: `GuildEmojiService.getEmojis(guildId)`, `.uploadEmoji(guildId, {name, animated, file})`, `.deleteEmoji(guildId, emojiId)` — consumed by Task 4 (store) and Task 5 (settings page).

- [ ] **Step 1: Write the failing service tests**

Create `src/app/services/guild-emoji.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {GuildEmojiService} from './guild-emoji.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example/api/v1/guild';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(GuildEmojiService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('GuildEmojiService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('getEmojis GETs the guild emoji list', () => {
        const {service, ctrl} = setup();
        service.getEmojis('g1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/emojis`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('uploadEmoji POSTs multipart form data with name, animated, and file', () => {
        const {service, ctrl} = setup();
        const file = new File(['x'], 'pepega.png', {type: 'image/png'});
        service.uploadEmoji('g1', {name: 'pepega', animated: false, file}).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/emojis`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body instanceof FormData).toBe(true);
        const body = req.request.body as FormData;
        expect(body.get('name')).toBe('pepega');
        expect(body.get('animated')).toBe('false');
        expect(body.get('file')).toBe(file);
        req.flush({id: 'e1', guildId: 'g1', name: 'pepega', animated: false, createdByUserId: 'u1', createdAt: '2026-07-30T00:00:00Z', imageUrl: 'https://x'});
    });

    it('deleteEmoji DELETEs the emoji by id', () => {
        const {service, ctrl} = setup();
        service.deleteEmoji('g1', 'e1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/emojis/e1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ng test --include='**/guild-emoji.service.spec.ts'`
Expected: FAIL — `GuildEmojiService` doesn't exist yet.

- [ ] **Step 3: Implement the service**

Create `src/app/services/guild-emoji.service.ts`:

```ts
import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {GuildEmojiDto} from '../dtos/response/guild-emoji.dto';

@Injectable({providedIn: 'root'})
export class GuildEmojiService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);
    private base = this.apiConfig.baseUrl() + '/api/v1/guild';

    getEmojis(guildId: string): Observable<GuildEmojiDto[]> {
        return this.http.get<GuildEmojiDto[]>(`${this.base}/guilds/${guildId}/emojis`);
    }

    uploadEmoji(guildId: string, params: { name: string; animated: boolean; file: File }): Observable<GuildEmojiDto> {
        const fd = new FormData();
        fd.append('name', params.name);
        fd.append('animated', String(params.animated));
        fd.append('file', params.file);
        return this.http.post<GuildEmojiDto>(`${this.base}/guilds/${guildId}/emojis`, fd);
    }

    deleteEmoji(guildId: string, emojiId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/emojis/${emojiId}`);
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ng test --include='**/guild-emoji.service.spec.ts'`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/guild-emoji.service.ts src/app/services/guild-emoji.service.spec.ts
git commit -m "feat: add GuildEmojiService"
```

---

### Task 3: Realtime `guild.EmojiCreated`/`EmojiDeleted` events

**Files:**
- Modify: `src/app/services/guild-websocket.service.ts`

**Interfaces:**
- Produces: `WsEmojiCreated`, `WsEmojiDeleted` interfaces, `GuildWebsocketService.emojiCreatedObservable`/`emojiDeletedObservable` — consumed by Task 4 (store).

- [ ] **Step 1: Add the event interfaces**

In `src/app/services/guild-websocket.service.ts`, add next to the existing `WsThreadCreated` interface:

```ts
export interface WsEmojiCreated {
    guildId: string;
    emojiId: string;
    name: string;
    animated: boolean;
}

export interface WsEmojiDeleted {
    guildId: string;
    emojiId: string;
}
```

- [ ] **Step 2: Add the observables and listeners**

Add to the class body, next to `threadCreatedObservable`:

```ts
    public emojiCreatedObservable = new Subject<WsEmojiCreated>();
    public emojiDeletedObservable = new Subject<WsEmojiDeleted>();
```

In `setupListeners()`, next to the existing `guild.ThreadCreated` handler:

```ts
        this.realtime.on('guild.EmojiCreated', (d: WsEmojiCreated) => this.emojiCreatedObservable.next(d));
        this.realtime.on('guild.EmojiDeleted', (d: WsEmojiDeleted) => this.emojiDeletedObservable.next(d));
```

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 4: Commit**

```bash
git add src/app/services/guild-websocket.service.ts
git commit -m "feat: listen for guild.EmojiCreated/EmojiDeleted realtime events"
```

---

### Task 4: `GuildEmojiStore` (per-guild cache)

**Files:**
- Create: `src/app/stores/guild-emoji.store.ts`

**Interfaces:**
- Consumes: `GuildEmojiService` (Task 2), `GuildWebsocketService.emojiCreatedObservable`/`emojiDeletedObservable` (Task 3).
- Produces: `GuildEmojiStore.ensureLoaded(guildId)`, `.getEmojis(guildId): GuildEmojiDto[]` — consumed by Task 5 (settings page) and Task 7 (reaction picker).

- [ ] **Step 1: Implement the store**

Create `src/app/stores/guild-emoji.store.ts`:

```ts
import {inject} from '@angular/core';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {GuildEmojiService} from '../services/guild-emoji.service';
import {GuildEmojiDto} from '../dtos/response/guild-emoji.dto';
import {GuildWebsocketService, WsEmojiCreated, WsEmojiDeleted} from '../services/guild-websocket.service';

// Presigned imageUrl expires ~1h server-side - revalidate a bit before that so a stale
// URL is never handed to the UI.
const STALE_MS = 55 * 60 * 1000;

interface GuildEmojiEntry {
    emojis: GuildEmojiDto[];
    fetchedAt: number;
    loading: boolean;
}

interface GuildEmojiState {
    byGuild: Record<string, GuildEmojiEntry>;
}

export const GuildEmojiStore = signalStore(
    {providedIn: 'root'},
    withState<GuildEmojiState>({byGuild: {}}),

    withMethods((store, guildEmojiService = inject(GuildEmojiService)) => ({
        getEmojis(guildId: string): GuildEmojiDto[] {
            return store.byGuild()[guildId]?.emojis ?? [];
        },

        ensureLoaded(guildId: string): void {
            const entry = store.byGuild()[guildId];
            const isStale = !entry || (Date.now() - entry.fetchedAt) > STALE_MS;
            if (!isStale || entry?.loading) return;

            patchState(store, {
                byGuild: {
                    ...store.byGuild(),
                    [guildId]: {emojis: entry?.emojis ?? [], fetchedAt: entry?.fetchedAt ?? 0, loading: true},
                },
            });

            guildEmojiService.getEmojis(guildId).subscribe({
                next: emojis => patchState(store, {
                    byGuild: {...store.byGuild(), [guildId]: {emojis, fetchedAt: Date.now(), loading: false}},
                }),
                error: () => patchState(store, {
                    byGuild: {
                        ...store.byGuild(),
                        [guildId]: {emojis: entry?.emojis ?? [], fetchedAt: entry?.fetchedAt ?? 0, loading: false},
                    },
                }),
            });
        },

        addEmoji(guildId: string, emoji: GuildEmojiDto): void {
            const entry = store.byGuild()[guildId];
            if (!entry) return;
            patchState(store, {byGuild: {...store.byGuild(), [guildId]: {...entry, emojis: [...entry.emojis, emoji]}}});
        },

        removeEmoji(guildId: string, emojiId: string): void {
            const entry = store.byGuild()[guildId];
            if (!entry) return;
            patchState(store, {
                byGuild: {...store.byGuild(), [guildId]: {...entry, emojis: entry.emojis.filter(e => e.id !== emojiId)}},
            });
        },

        invalidate(guildId: string): void {
            const entry = store.byGuild()[guildId];
            if (!entry) return;
            patchState(store, {byGuild: {...store.byGuild(), [guildId]: {...entry, fetchedAt: 0}}});
        },
    })),

    withHooks({
        onInit(store) {
            const guildWs = inject(GuildWebsocketService);

            // The realtime payload doesn't carry a presigned imageUrl, so a straight
            // addEmoji() isn't enough - invalidate and let ensureLoaded() pull the
            // full record (with a usable imageUrl) on next read.
            guildWs.emojiCreatedObservable.subscribe((e: WsEmojiCreated) => {
                store.invalidate(e.guildId);
                store.ensureLoaded(e.guildId);
            });

            guildWs.emojiDeletedObservable.subscribe((e: WsEmojiDeleted) => {
                store.removeEmoji(e.guildId, e.emojiId);
            });
        },
    }),
);
```

- [ ] **Step 2: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully (store isn't injected anywhere yet — this only confirms it compiles standalone).

- [ ] **Step 3: Commit**

```bash
git add src/app/stores/guild-emoji.store.ts
git commit -m "feat: add GuildEmojiStore with realtime sync"
```

---

### Task 5: `EmojiSettingsComponent` guild-settings page

**Files:**
- Create: `src/app/features/guild/components/guild-settings-modal/pages/emoji-settings/emoji-settings.component.ts`
- Create: `src/app/features/guild/components/guild-settings-modal/pages/emoji-settings/emoji-settings.component.html`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html`

**Interfaces:**
- Consumes: `GuildEmojiService` (Task 2), `GuildEmojiStore` (Task 4), `Permissions.ManageEmojis` (Task 1).
- Produces: `EmojiSettingsComponent` with `guild = input.required<GuildDto>()` — wired into the settings modal's page switch, no other task depends on it.

- [ ] **Step 1: Implement the component**

Create `src/app/features/guild/components/guild-settings-modal/pages/emoji-settings/emoji-settings.component.ts`:

```ts
import {Component, computed, ElementRef, inject, input, OnInit, signal, ViewChild} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {Checkbox} from 'primeng/checkbox';
import {PrimeTemplate} from 'primeng/api';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildEmojiDto} from '../../../../../../dtos/response/guild-emoji.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {GuildEmojiService} from '../../../../../../services/guild-emoji.service';
import {GuildEmojiStore} from '../../../../../../stores/guild-emoji.store';
import {ToastService} from '../../../../../../services/toast.service';
import {hasPermission, parsePermissions, Permissions} from '../../../../../../enums/permissions.enum';

@Component({
    selector: 'app-emoji-settings',
    imports: [FormsModule, Button, InputText, Dialog, Checkbox, PrimeTemplate],
    templateUrl: './emoji-settings.component.html',
})
export class EmojiSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();

    emojis = computed(() => this.guildEmojiStore.getEmojis(this.guild().id));
    loading = signal(true);
    deletingId = signal<string | null>(null);

    showUploadDialog = signal(false);
    pendingFile = signal<File | null>(null);
    pendingPreviewUrl = signal<string | null>(null);
    uploadName = signal('');
    uploadAnimated = signal(false);
    uploading = signal(false);

    @ViewChild('fileInput') private fileInputRef?: ElementRef<HTMLInputElement>;

    private guildService = inject(GuildService);
    private guildEmojiService = inject(GuildEmojiService);
    private guildEmojiStore = inject(GuildEmojiStore);
    private toastService = inject(ToastService);
    private ownMember = signal<SelfGuildMemberDto | null>(null);
    private previewObjectUrl: string | null = null;

    canManageEmojis = computed(() => {
        const member = this.ownMember();
        if (!member) return false;
        const permissionString = member.roleMembers.reduce((curr, m) => {
            if (!m.role.permissions) return curr;
            return curr === '' ? m.role.permissions : `${curr},${m.role.permissions}`;
        }, member.permissions ?? '');
        const perms = parsePermissions(permissionString);
        return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.ManageEmojis);
    });

    ngOnInit(): void {
        this.guildService.getOwnMember(this.guild().id).subscribe(m => this.ownMember.set(m));
        this.loading.set(true);
        this.guildEmojiStore.ensureLoaded(this.guild().id);
        this.guildEmojiService.getEmojis(this.guild().id).subscribe({
            next: () => this.loading.set(false),
            error: () => this.loading.set(false),
        });
    }

    openFilePicker(): void {
        this.fileInputRef?.nativeElement.click();
    }

    onFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
        this.previewObjectUrl = URL.createObjectURL(file);
        this.pendingFile.set(file);
        this.pendingPreviewUrl.set(this.previewObjectUrl);

        const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
        this.uploadName.set(baseName);
        this.uploadAnimated.set(file.type === 'image/gif');
        this.showUploadDialog.set(true);
    }

    confirmUpload(): void {
        const file = this.pendingFile();
        const name = this.uploadName().trim();
        if (!file || !name || this.uploading()) return;
        this.uploading.set(true);
        this.guildEmojiService.uploadEmoji(this.guild().id, {name, animated: this.uploadAnimated(), file}).subscribe({
            next: created => {
                this.guildEmojiStore.addEmoji(this.guild().id, created);
                this.closeUploadDialog();
                this.uploading.set(false);
            },
            error: err => {
                this.uploading.set(false);
                this.toastService.httpError(err?.status === 409 ? 'An emoji with that name already exists' : 'Failed to upload emoji', err);
            },
        });
    }

    closeUploadDialog(): void {
        this.showUploadDialog.set(false);
        if (this.previewObjectUrl) {
            URL.revokeObjectURL(this.previewObjectUrl);
            this.previewObjectUrl = null;
        }
        this.pendingFile.set(null);
        this.pendingPreviewUrl.set(null);
    }

    deleteEmoji(emoji: GuildEmojiDto): void {
        if (this.deletingId()) return;
        this.deletingId.set(emoji.id);
        this.guildEmojiService.deleteEmoji(this.guild().id, emoji.id).subscribe({
            next: () => {
                this.guildEmojiStore.removeEmoji(this.guild().id, emoji.id);
                this.deletingId.set(null);
            },
            error: err => {
                this.deletingId.set(null);
                this.toastService.httpError('Failed to delete emoji', err);
            },
        });
    }
}
```

- [ ] **Step 2: Implement the template**

Create `src/app/features/guild/components/guild-settings-modal/pages/emoji-settings/emoji-settings.component.html`:

```html
<div class="flex flex-col gap-4">
    <div class="flex items-center justify-between">
        <p class="text-xs text-white/40 m-0 max-w-md leading-relaxed">
            Custom emoji can be used as message reactions in this server's channels.
        </p>
        @if (canManageEmojis()) {
            <p-button (onClick)="openFilePicker()" icon="pi pi-upload" label="Upload Emoji" severity="primary" size="small"/>
        }
    </div>

    <input #fileInput (change)="onFileSelected($event)" accept="image/png,image/jpeg,image/gif,image/webp"
           class="hidden" type="file"/>

    @if (loading()) {
        <p class="text-xs text-white/25 text-center py-8">Loading…</p>
    } @else if (emojis().length === 0) {
        <div class="flex flex-col items-center justify-center py-14 gap-3">
            <i class="pi pi-face-smile text-3xl text-white/10"></i>
            <p class="text-sm text-white/25 m-0">No custom emoji yet.</p>
        </div>
    } @else {
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            @for (emoji of emojis(); track emoji.id) {
                <div class="flex items-center gap-2.5 bg-card/60 border border-white/[0.06] rounded-xl px-3 py-2.5">
                    <img [alt]="emoji.name" [src]="emoji.imageUrl" class="w-7 h-7 rounded object-contain shrink-0"/>
                    <span class="text-xs text-white/70 truncate flex-1">:{{ emoji.name }}:</span>
                    @if (canManageEmojis()) {
                        <p-button (onClick)="deleteEmoji(emoji)" [loading]="deletingId() === emoji.id" [text]="true"
                                  icon="pi pi-trash" severity="danger" size="small"/>
                    }
                </div>
            }
        </div>
    }
</div>

<!-- Upload dialog -->
<p-dialog (visibleChange)="closeUploadDialog()" [draggable]="false" [modal]="true" [resizable]="false"
          [style]="{width: '380px'}" [visible]="showUploadDialog()" appendTo="body">
    <ng-template pTemplate="header">
        <span class="text-sm font-semibold text-white/85">Upload Emoji</span>
    </ng-template>
    <div class="flex flex-col gap-3">
        @if (pendingPreviewUrl(); as preview) {
            <img [src]="preview" alt="Preview" class="w-16 h-16 rounded-lg object-contain mx-auto"/>
        }
        <input (ngModelChange)="uploadName.set($event)" [ngModel]="uploadName()" pInputText placeholder="Emoji name"
               type="text"/>
        <div class="flex items-center gap-2">
            <p-checkbox (ngModelChange)="uploadAnimated.set($event)" [binary]="true" [ngModel]="uploadAnimated()"
                        inputId="animated-check"/>
            <label class="text-xs text-white/60" for="animated-check">Animated</label>
        </div>
    </div>
    <ng-template pTemplate="footer">
        <p-button (onClick)="closeUploadDialog()" [text]="true" label="Cancel"/>
        <p-button (onClick)="confirmUpload()" [disabled]="!uploadName().trim()" [loading]="uploading()" label="Upload"/>
    </ng-template>
</p-dialog>
```

- [ ] **Step 3: Wire the new page into `GuildSettingsModalComponent`**

In `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts`, add the import:

```ts
import {EmojiSettingsComponent} from './pages/emoji-settings/emoji-settings.component';
```

Add `EmojiSettingsComponent` to the `imports` array in the `@Component` decorator.

Add a nav entry to the `'Community'` group (currently `invites`/`discord-sync`):

Before:
```ts
        {
            title: 'Community',
            items: [
                {id: 'invites', label: 'Invites', icon: 'pi pi-link'},
                {id: 'discord-sync', label: 'Discord Sync', icon: 'pi pi-discord'},
            ],
        },
```

After:
```ts
        {
            title: 'Community',
            items: [
                {id: 'invites', label: 'Invites', icon: 'pi pi-link'},
                {id: 'emojis', label: 'Emojis', icon: 'pi pi-face-smile'},
                {id: 'discord-sync', label: 'Discord Sync', icon: 'pi pi-discord'},
            ],
        },
```

In `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html`, add a case to the page switch, right after `'invites'`:

Before:
```html
                    @case ('invites') {
                        <app-invites-settings [guild]="guild()"/>
                    }
                    @case ('discord-sync') {
```

After:
```html
                    @case ('invites') {
                        <app-invites-settings [guild]="guild()"/>
                    }
                    @case ('emojis') {
                        <app-emoji-settings [guild]="guild()"/>
                    }
                    @case ('discord-sync') {
```

- [ ] **Step 4: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 5: Manual verification**

Run the app:
1. Open Guild Settings → Emojis as a member without `ManageEmojis` — confirm the list renders (possibly empty) but there's no "Upload Emoji" button and no per-row delete button.
2. Grant yourself `ManageEmojis` (via the Roles page), reopen Emojis — confirm "Upload Emoji" now appears.
3. Click it, pick a small PNG — confirm a dialog opens with a preview, a name pre-filled from the filename, and an Animated checkbox; submit.
4. Confirm the new emoji appears in the grid immediately (via `GuildEmojiStore.addEmoji`), and again after a full page reload (confirms the upload persisted).
5. Try uploading a second emoji with the exact same name — confirm a "already exists" toast appears (409 handling).
6. Delete an emoji — confirm it disappears from the grid.
7. From a second account/session, upload an emoji — confirm the first account's list updates live via `guild.EmojiCreated` (Task 3/4's realtime wiring) without a manual refresh.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/
git commit -m "feat: add Emoji Settings page to guild settings"
```

---

### Task 6: Reaction model plumbing (`emojiId` on `MessageReaction`/`CreateReactionDto`/`ReactionEvent`)

**Files:**
- Modify: `src/app/dtos/response/message.dto.ts`
- Modify: `src/app/dtos/request/create-reaction.dto.ts`
- Modify: `src/app/services/messaging-websocket.service.ts`
- Modify: `src/app/stores/message.store.ts`

**Interfaces:**
- Produces: `MessageReaction.emojiId?: string | null`, `CreateReactionDto.emojiId?: string` (and `reaction` becomes optional), `ReactionEvent.emojiId?: string` — consumed by Task 7 and Task 8.
- Produces: updated `MessageStore.applyReactionAdded`/`applyReactionRemoved` that match by `emojiId` when present, else by `emoji` text — no interface change, same method names/signatures, just corrected matching logic.

- [ ] **Step 1: Add `emojiId` to `MessageReaction`**

In `src/app/dtos/response/message.dto.ts`, change:

Before:
```ts
export interface MessageReaction {
    contextId: string;
    messageId: string;
    emoji: string;
    userId: string;
    createdAt: string;
    conversationId: string | null;
    channelId: string | null;
}
```

After:
```ts
export interface MessageReaction {
    contextId: string;
    messageId: string;
    emoji: string;
    emojiId?: string | null;
    userId: string;
    createdAt: string;
    conversationId: string | null;
    channelId: string | null;
}
```

- [ ] **Step 2: Make `reaction` optional and add `emojiId` to `CreateReactionDto`**

In `src/app/dtos/request/create-reaction.dto.ts`, change:

Before:
```ts
export interface CreateReactionDto {
    conversationId: string;
    reaction: string;
    channelId?: string;
}
```

After:
```ts
export interface CreateReactionDto {
    conversationId: string;
    reaction?: string;
    channelId?: string;
    emojiId?: string;
}
```

- [ ] **Step 3: Add `emojiId` to `ReactionEvent`**

In `src/app/services/messaging-websocket.service.ts`, change:

Before:
```ts
export interface ReactionEvent {
    messageId: string;
    emoji: string;
    userId: string;
    channelId?: string;
    conversationId?: string;
}
```

After:
```ts
export interface ReactionEvent {
    messageId: string;
    emoji: string;
    emojiId?: string;
    userId: string;
    channelId?: string;
    conversationId?: string;
}
```

- [ ] **Step 4: Fix the matching logic in `MessageStore`**

In `src/app/stores/message.store.ts`, change `applyReactionAdded`/`applyReactionRemoved`:

Before:
```ts
        applyReactionAdded(event: ReactionEvent): void {
            const msg = store.entityMap()[event.messageId];
            if (!msg) return;
            const reactions = msg.reactions ?? [];
            if (reactions.some(r => r.emoji === event.emoji && r.userId === event.userId)) return;
            const entry: MessageReaction = {
                contextId: event.conversationId ?? event.channelId ?? '',
                messageId: event.messageId,
                emoji: event.emoji,
                userId: event.userId,
                createdAt: new Date().toISOString(),
                conversationId: event.conversationId ?? null,
                channelId: event.channelId ?? null,
            };
            patchState(store, updateEntity({id: event.messageId, changes: {reactions: [...reactions, entry]}}));
        },

        applyReactionRemoved(event: ReactionEvent): void {
            const msg = store.entityMap()[event.messageId];
            if (!msg) return;
            const reactions = (msg.reactions ?? []).filter(
                r => !(r.emoji === event.emoji && r.userId === event.userId)
            );
            patchState(store, updateEntity({id: event.messageId, changes: {reactions}}));
        },
```

After:
```ts
        applyReactionAdded(event: ReactionEvent): void {
            const msg = store.entityMap()[event.messageId];
            if (!msg) return;
            const reactions = msg.reactions ?? [];
            const matches = (r: MessageReaction) => event.emojiId
                ? r.emojiId === event.emojiId && r.userId === event.userId
                : r.emoji === event.emoji && !r.emojiId && r.userId === event.userId;
            if (reactions.some(matches)) return;
            const entry: MessageReaction = {
                contextId: event.conversationId ?? event.channelId ?? '',
                messageId: event.messageId,
                emoji: event.emoji,
                emojiId: event.emojiId ?? null,
                userId: event.userId,
                createdAt: new Date().toISOString(),
                conversationId: event.conversationId ?? null,
                channelId: event.channelId ?? null,
            };
            patchState(store, updateEntity({id: event.messageId, changes: {reactions: [...reactions, entry]}}));
        },

        applyReactionRemoved(event: ReactionEvent): void {
            const msg = store.entityMap()[event.messageId];
            if (!msg) return;
            const matches = (r: MessageReaction) => event.emojiId
                ? r.emojiId === event.emojiId && r.userId === event.userId
                : r.emoji === event.emoji && !r.emojiId && r.userId === event.userId;
            const reactions = (msg.reactions ?? []).filter(r => !matches(r));
            patchState(store, updateEntity({id: event.messageId, changes: {reactions}}));
        },
```

- [ ] **Step 5: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully.

- [ ] **Step 6: Commit**

```bash
git add src/app/dtos/response/message.dto.ts src/app/dtos/request/create-reaction.dto.ts src/app/services/messaging-websocket.service.ts src/app/stores/message.store.ts
git commit -m "feat: add emojiId to reaction model and fix store matching for custom emoji"
```

---

### Task 7: `EmojiSelection` type + custom emoji in `ReactionPickerComponent`

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message/reaction-picker/reaction-picker.component.ts`

**Interfaces:**
- Consumes: `GuildEmojiStore` (Task 4).
- Produces: `EmojiSelection` interface (`{native?: string; customEmojiId?: string; customEmojiName?: string}`), `ReactionPickerComponent.guildId: InputSignal<string | undefined>`, `emojiSelected: OutputEmitterRef<EmojiSelection>` (type change from `string`) — consumed by Task 8.

Before writing code, this task rests on emoji-mart's exact runtime contract for `custom` and the `onEmojiSelect` payload. That contract has already been verified against the installed package for this plan (not guessed) — see `node_modules/emoji-mart/README.md`'s "Custom emojis" section for the `custom` prop shape (`[{id, name, emojis: [{id, name, keywords, skins: [{src}]}]}]`), and `node_modules/emoji-mart/dist/module.js` (search for `d10ac59fbe52a745`, the internal function that builds the `onEmojiSelect` payload) confirming the emitted object always has `.id`/`.name`, has `.native` set only for standard unicode emoji (undefined for custom), and has `.src` set only for custom emoji (copied from `skin.src`). If the installed `emoji-mart` version has since changed, re-check that function before trusting the `emoji.src` discriminator below.

- [ ] **Step 1: Add the `EmojiSelection` type and `guildId` input**

In `src/app/features/messaging/components/conversation/message/reaction-picker/reaction-picker.component.ts`, add at the top of the file:

```ts
import {Component, computed, effect, input, OnDestroy, output, signal} from '@angular/core';
import {inject} from '@angular/core';
import {GuildEmojiStore} from '../../../../../../stores/guild-emoji.store';

export interface EmojiSelection {
    native?: string;
    customEmojiId?: string;
    customEmojiName?: string;
}
```

(replace the existing `import {Component, input, OnDestroy, output, signal} from '@angular/core';` line with the above two import lines plus the new interface)

- [ ] **Step 2: Wire the guild emoji cache and change the output type**

Change the class:

Before:
```ts
export class ReactionPickerComponent implements OnDestroy {
    emojiSelected = output<string>();
    /** toolbar = opens downward; bar = opens upward */
    mode = input<'toolbar' | 'bar'>('toolbar');

    isOpen = signal(false);

    private bodyContainer: HTMLDivElement | null = null;
    private pickerInstance: HTMLElement | null = null;
    private outsideClickListener: ((e: MouseEvent) => void) | null = null;
    private triggerRef: HTMLElement | null = null;
```

After:
```ts
export class ReactionPickerComponent implements OnDestroy {
    emojiSelected = output<EmojiSelection>();
    /** toolbar = opens downward; bar = opens upward */
    mode = input<'toolbar' | 'bar'>('toolbar');
    /** Set only in guild channels - custom emoji never render in DMs. */
    guildId = input<string | undefined>();

    isOpen = signal(false);

    private guildEmojiStore = inject(GuildEmojiStore);
    private customEmojis = computed(() => {
        const guildId = this.guildId();
        return guildId ? this.guildEmojiStore.getEmojis(guildId) : [];
    });
    private builtCustomEmojiKey = '';
    private bodyContainer: HTMLDivElement | null = null;
    private pickerInstance: HTMLElement | null = null;
    private outsideClickListener: ((e: MouseEvent) => void) | null = null;
    private triggerRef: HTMLElement | null = null;

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            if (guildId) this.guildEmojiStore.ensureLoaded(guildId);
        });
    }
```

- [ ] **Step 3: Rebuild the picker when the custom emoji set changes, and wire `custom`/`onEmojiSelect`**

Change `toggle()`:

Before:
```ts
    async toggle(event: MouseEvent): Promise<void> {
        this.triggerRef = event.currentTarget as HTMLElement;

        if (this.isOpen()) {
            this.close();
            return;
        }

        if (!this.bodyContainer) {
            this.bodyContainer = document.createElement('div');
            this.bodyContainer.style.cssText = 'position:fixed;z-index:9999;display:none';
            document.body.appendChild(this.bodyContainer);
        }

        if (!this.pickerInstance) {
            const [{Picker}, data] = await Promise.all([
                import('emoji-mart'),
                import('@emoji-mart/data/sets/15/twitter.json'),
            ]);
            this.pickerInstance = new Picker({
                data: data.default ?? data,
                set: 'twitter',
                getSpritesheetURL: () => '/emoji-sheets/twitter/64.png',
                theme: 'dark',
                previewPosition: 'none',
                skinTonePosition: 'none',
                onEmojiSelect: (emoji: { native: string }) => {
                    this.emojiSelected.emit(emoji.native);
                    this.close();
                },
            }) as unknown as HTMLElement;
            this.bodyContainer.appendChild(this.pickerInstance);
        }

        this.position(this.triggerRef);
        this.bodyContainer.style.display = 'block';
        this.isOpen.set(true);
```

After:
```ts
    async toggle(event: MouseEvent): Promise<void> {
        this.triggerRef = event.currentTarget as HTMLElement;

        if (this.isOpen()) {
            this.close();
            return;
        }

        if (!this.bodyContainer) {
            this.bodyContainer = document.createElement('div');
            this.bodyContainer.style.cssText = 'position:fixed;z-index:9999;display:none';
            document.body.appendChild(this.bodyContainer);
        }

        const customEmojis = this.customEmojis();
        const customEmojiKey = customEmojis.map(e => e.id).join(',');
        if (this.pickerInstance && customEmojiKey !== this.builtCustomEmojiKey) {
            this.bodyContainer.removeChild(this.pickerInstance);
            this.pickerInstance = null;
        }

        if (!this.pickerInstance) {
            const [{Picker}, data] = await Promise.all([
                import('emoji-mart'),
                import('@emoji-mart/data/sets/15/twitter.json'),
            ]);
            this.builtCustomEmojiKey = customEmojiKey;
            this.pickerInstance = new Picker({
                data: data.default ?? data,
                set: 'twitter',
                getSpritesheetURL: () => '/emoji-sheets/twitter/64.png',
                theme: 'dark',
                previewPosition: 'none',
                skinTonePosition: 'none',
                custom: customEmojis.length ? [{
                    id: 'guild',
                    name: 'This Server',
                    emojis: customEmojis.map(e => ({
                        id: e.id,
                        name: e.name,
                        keywords: [e.name],
                        skins: [{src: e.imageUrl}],
                    })),
                }] : [],
                onEmojiSelect: (emoji: { native?: string; id: string; name: string; src?: string }) => {
                    if (emoji.src) {
                        this.emojiSelected.emit({customEmojiId: emoji.id, customEmojiName: emoji.name});
                    } else {
                        this.emojiSelected.emit({native: emoji.native});
                    }
                    this.close();
                },
            }) as unknown as HTMLElement;
            this.bodyContainer.appendChild(this.pickerInstance);
        }

        this.position(this.triggerRef);
        this.bodyContainer.style.display = 'block';
        this.isOpen.set(true);
```

(The rest of `toggle()` — the `setTimeout`/outside-click-listener block — is unchanged.)

- [ ] **Step 4: Type-check**

Run: `npx ng build --configuration development`
Expected: FAILS at this point — every current consumer of `emojiSelected` (`MessageHoverToolbarComponent`, `MessageReactionBarComponent`) still expects a plain `string`. That's expected; Task 8 fixes every call site. Confirm the errors are exactly the type mismatches you expect (in `message-hover-toolbar.component.html`/`.ts` and `message-reaction-bar.component.html`/`.ts`) before moving on — if anything else fails, stop and investigate before proceeding to Task 8.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/messaging/components/conversation/message/reaction-picker/reaction-picker.component.ts
git commit -m "feat: add custom guild emoji to the reaction picker"
```

---

### Task 8: Propagate `guildId`/`EmojiSelection` through the hover toolbar and reaction bar

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.ts`
- Modify: `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.html`
- Modify: `src/app/features/messaging/components/conversation/message/reaction-bar/message-reaction-bar.component.ts`
- Modify: `src/app/features/messaging/components/conversation/message/reaction-bar/message-reaction-bar.component.html`

**Interfaces:**
- Consumes: `EmojiSelection`, `ReactionPickerComponent.guildId` (Task 7).
- Produces: `MessageHoverToolbarComponent.guildId: InputSignal<string | undefined>`, `.emojiToggled: OutputEmitterRef<EmojiSelection>`; `MessageReactionBarComponent.guildId: InputSignal<string | undefined>`, `.emojiToggled: OutputEmitterRef<EmojiSelection>` — consumed by Task 9 (`MessageComponent`).

- [ ] **Step 1: Update `MessageHoverToolbarComponent`**

In `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';
import {ReactionPickerComponent, EmojiSelection} from '../reaction-picker/reaction-picker.component';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-message-hover-toolbar',
    imports: [ReactionPickerComponent, TranslateModule],
    templateUrl: './message-hover-toolbar.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageHoverToolbarComponent {
    isOwn = input.required<boolean>();
    guildId = input<string | undefined>();

    reply = output<void>();
    edit = output<void>();
    delete = output<void>();
    emojiToggled = output<EmojiSelection>();

    readonly quickReactions = ['👍', '❤️', '😂'];
}
```

In `src/app/features/messaging/components/conversation/message/hover-toolbar/message-hover-toolbar.component.html`, change the quick-reaction buttons and the picker binding:

Before:
```html
    @for (emoji of quickReactions; track emoji) {
        <button (click)="emojiToggled.emit(emoji)"
                [title]="emoji"
                class="w-6 h-6 rounded flex items-center justify-center text-base leading-none
             hover:bg-white/[0.07] cursor-pointer border-0 bg-transparent transition-all
             hover:scale-125">{{ emoji }}
        </button>
    }

    <app-reaction-picker (emojiSelected)="emojiToggled.emit($event)" mode="toolbar"/>
```

After:
```html
    @for (emoji of quickReactions; track emoji) {
        <button (click)="emojiToggled.emit({native: emoji})"
                [title]="emoji"
                class="w-6 h-6 rounded flex items-center justify-center text-base leading-none
             hover:bg-white/[0.07] cursor-pointer border-0 bg-transparent transition-all
             hover:scale-125">{{ emoji }}
        </button>
    }

    <app-reaction-picker (emojiSelected)="emojiToggled.emit($event)" [guildId]="guildId()" mode="toolbar"/>
```

- [ ] **Step 2: Update `MessageReactionBarComponent`**

In `src/app/features/messaging/components/conversation/message/reaction-bar/message-reaction-bar.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, computed, inject, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {MessageReaction} from '../../../../../../dtos/response/message.dto';
import {EmojiSelection, ReactionPickerComponent} from '../reaction-picker/reaction-picker.component';
import {TwemojiComponent} from '../../../../../../components/twemoji/twemoji.component';
import {GuildEmojiStore} from '../../../../../../stores/guild-emoji.store';

interface ReactionGroup {
    key: string;
    emoji: string;
    emojiId?: string | null;
    count: number;
    userIds: string[];
}

@Component({
    selector: 'app-message-reaction-bar',
    imports: [NgClass, ReactionPickerComponent, TwemojiComponent],
    templateUrl: './message-reaction-bar.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageReactionBarComponent {
    reactions = input.required<MessageReaction[]>();
    ownUserId = input<string | undefined>();
    guildId = input<string | undefined>();
    emojiToggled = output<EmojiSelection>();

    private guildEmojiStore = inject(GuildEmojiStore);

    groups = computed<ReactionGroup[]>(() => {
        const map = new Map<string, ReactionGroup>();
        for (const r of this.reactions()) {
            const key = r.emojiId ?? r.emoji;
            const g = map.get(key) ?? {key, emoji: r.emoji, emojiId: r.emojiId, count: 0, userIds: []};
            g.count++;
            g.userIds.push(r.userId);
            map.set(key, g);
        }
        return Array.from(map.values());
    });

    hasOwn(group: ReactionGroup): boolean {
        const own = this.ownUserId() ?? '';
        return this.reactions().some(r => (r.emojiId ?? r.emoji) === group.key && r.userId === own);
    }

    imageUrl(group: ReactionGroup): string | undefined {
        if (!group.emojiId) return undefined;
        const guildId = this.guildId();
        if (!guildId) return undefined;
        return this.guildEmojiStore.getEmojis(guildId).find(e => e.id === group.emojiId)?.imageUrl;
    }

    toggle(group: ReactionGroup): void {
        if (group.emojiId) {
            this.emojiToggled.emit({customEmojiId: group.emojiId, customEmojiName: group.emoji});
        } else {
            this.emojiToggled.emit({native: group.emoji});
        }
    }
}
```

In `src/app/features/messaging/components/conversation/message/reaction-bar/message-reaction-bar.component.html`:

Before:
```html
<div class="flex flex-wrap items-center gap-1 mt-1.5">
    @for (group of groups(); track group.emoji) {
        <button (click)="emojiToggled.emit(group.emoji)"
                [ngClass]="hasOwn(group.emoji)
        ? 'bg-brand-dark border-brand text-brand-dim hover:bg-brand-dark/80'
        : 'bg-white/[0.04] border-white/[0.10] text-white/65 hover:bg-white/[0.08] hover:border-white/20'"
                [title]="group.count + ' reaction' + (group.count !== 1 ? 's' : '')"
                class="flex items-center gap-1 h-8 px-2.5 rounded-full border text-[16px] leading-none transition-colors cursor-pointer">
            <app-twemoji [emoji]="group.emoji" size="1em"/>
            <span class="text-[15px] font-medium">{{ group.count }}</span>
        </button>
    }
    <app-reaction-picker (emojiSelected)="emojiToggled.emit($event)" mode="bar"/>
</div>
```

After:
```html
<div class="flex flex-wrap items-center gap-1 mt-1.5">
    @for (group of groups(); track group.key) {
        <button (click)="toggle(group)"
                [ngClass]="hasOwn(group)
        ? 'bg-brand-dark border-brand text-brand-dim hover:bg-brand-dark/80'
        : 'bg-white/[0.04] border-white/[0.10] text-white/65 hover:bg-white/[0.08] hover:border-white/20'"
                [title]="group.count + ' reaction' + (group.count !== 1 ? 's' : '')"
                class="flex items-center gap-1 h-8 px-2.5 rounded-full border text-[16px] leading-none transition-colors cursor-pointer">
            @if (group.emojiId) {
                @if (imageUrl(group); as url) {
                    <img [alt]="group.emoji" [src]="url" class="w-[1em] h-[1em] object-contain"/>
                } @else {
                    <span class="text-[13px]">:{{ group.emoji }}:</span>
                }
            } @else {
                <app-twemoji [emoji]="group.emoji" size="1em"/>
            }
            <span class="text-[15px] font-medium">{{ group.count }}</span>
        </button>
    }
    <app-reaction-picker (emojiSelected)="emojiToggled.emit($event)" [guildId]="guildId()" mode="bar"/>
</div>
```

- [ ] **Step 3: Type-check**

Run: `npx ng build --configuration development`
Expected: still FAILS — `MessageComponent`'s bindings to `(emojiToggled)="toggleReaction($event)"` now pass an `EmojiSelection` where `toggleReaction` still expects a `string`. Confirm the errors are isolated to `message.component.ts`/`.html` before proceeding to Task 9.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/messaging/components/conversation/message/hover-toolbar/ src/app/features/messaging/components/conversation/message/reaction-bar/
git commit -m "feat: render and toggle custom emoji reactions in the hover toolbar and reaction bar"
```

---

### Task 9: `MessageComponent.toggleReaction` + `guildId` wiring from `ChannelComponent`

**Files:**
- Modify: `src/app/features/messaging/components/conversation/message/message.component.ts`
- Modify: `src/app/features/messaging/components/conversation/message/message.component.html`
- Modify: `src/app/features/guild/components/channel/channel.component.html`

**Interfaces:**
- Consumes: `EmojiSelection` (Task 7), `guildId` inputs on `MessageHoverToolbarComponent`/`MessageReactionBarComponent` (Task 8).
- Produces: `MessageComponent.guildId: InputSignal<string | undefined>` — this closes the loop; no later task depends on it.

- [ ] **Step 1: Add `guildId` input and rewrite `toggleReaction`/`hasOwnReaction`**

In `src/app/features/messaging/components/conversation/message/message.component.ts`, add the import:

```ts
import {EmojiSelection} from './reaction-picker/reaction-picker.component';
```

Add the input next to `guildBots`:

```ts
    public guildBots = input<BotCommandDto[]>([]);
    public guildId = input<string | undefined>();
```

Replace `hasOwnReaction`/`toggleReaction`:

Before:
```ts
    hasOwnReaction(emoji: string): boolean {
        const own = this.profileService.ownProfile()?.userId;
        if (!own) return false;
        return this.message().reactions?.some(r => r.emoji === emoji && r.userId === own) ?? false;
    }

    toggleReaction(emoji: string): void {
        const msg = this.message();
        const own = this.profileService.ownProfile()?.userId;
        if (!own || msg.isPending || msg.isFailed) return;

        const hasReacted = this.hasOwnReaction(emoji);

        if (hasReacted) {
            const contextId = msg.conversationId ?? msg.channelId ?? '';
            const dto: RemoveReactionDto = {reaction: emoji, contextId};
            this.messageStore.applyReactionRemoved({messageId: msg.id, emoji, userId: own});
            this.messagingService.removeReaction(msg.id, dto).subscribe({
                error: () => this.messageStore.applyReactionAdded({messageId: msg.id, emoji, userId: own}),
            });
        } else {
            const dto: CreateReactionDto = {
                conversationId: msg.conversationId ?? '',
                reaction: emoji,
                channelId: msg.channelId,
            };
            this.messageStore.applyReactionAdded({messageId: msg.id, emoji, userId: own});
            this.messagingService.addReaction(msg.id, dto).subscribe({
                error: () => this.messageStore.applyReactionRemoved({messageId: msg.id, emoji, userId: own}),
            });
        }
    }
```

After:
```ts
    hasOwnReaction(emoji: string, emojiId?: string): boolean {
        const own = this.profileService.ownProfile()?.userId;
        if (!own) return false;
        return this.message().reactions?.some(r => emojiId
            ? r.emojiId === emojiId && r.userId === own
            : r.emoji === emoji && !r.emojiId && r.userId === own) ?? false;
    }

    toggleReaction(selection: EmojiSelection): void {
        const msg = this.message();
        const own = this.profileService.ownProfile()?.userId;
        if (!own || msg.isPending || msg.isFailed) return;

        const emoji = selection.customEmojiName ?? selection.native ?? '';
        const emojiId = selection.customEmojiId;
        if (!emoji) return;

        const hasReacted = this.hasOwnReaction(emoji, emojiId);

        if (hasReacted) {
            const contextId = msg.conversationId ?? msg.channelId ?? '';
            const dto: RemoveReactionDto = {reaction: emoji, contextId};
            this.messageStore.applyReactionRemoved({messageId: msg.id, emoji, emojiId, userId: own});
            this.messagingService.removeReaction(msg.id, dto).subscribe({
                error: () => this.messageStore.applyReactionAdded({messageId: msg.id, emoji, emojiId, userId: own}),
            });
        } else {
            const dto: CreateReactionDto = emojiId
                ? {conversationId: msg.conversationId ?? '', channelId: msg.channelId, emojiId}
                : {conversationId: msg.conversationId ?? '', reaction: emoji, channelId: msg.channelId};
            this.messageStore.applyReactionAdded({messageId: msg.id, emoji, emojiId, userId: own});
            this.messagingService.addReaction(msg.id, dto).subscribe({
                error: () => this.messageStore.applyReactionRemoved({messageId: msg.id, emoji, emojiId, userId: own}),
            });
        }
    }
```

- [ ] **Step 2: Pass `guildId` to the hover toolbar and reaction bar**

In `src/app/features/messaging/components/conversation/message/message.component.html`, update both bindings:

Before:
```html
            <app-message-hover-toolbar
                    (delete)="confirmDelete()"
                    (edit)="startEdit()"
                    (emojiToggled)="toggleReaction($event)"
                    (reply)="reply.emit(message())"
                    [isOwn]="isOwn()"/>
```

After:
```html
            <app-message-hover-toolbar
                    (delete)="confirmDelete()"
                    (edit)="startEdit()"
                    (emojiToggled)="toggleReaction($event)"
                    (reply)="reply.emit(message())"
                    [guildId]="guildId()"
                    [isOwn]="isOwn()"/>
```

Before:
```html
            <app-message-reaction-bar
                    (emojiToggled)="toggleReaction($event)"
                    [ownUserId]="profileService.ownProfile()?.userId"
                    [reactions]="message().reactions!"/>
```

After:
```html
            <app-message-reaction-bar
                    (emojiToggled)="toggleReaction($event)"
                    [guildId]="guildId()"
                    [ownUserId]="profileService.ownProfile()?.userId"
                    [reactions]="message().reactions!"/>
```

(Note: the pin plan (`2026-07-30-message-pinning.md`) also adds `[canPinMessages]` to the hover toolbar around this same block — if both plans are implemented, merge the attribute lists rather than letting one overwrite the other.)

- [ ] **Step 3: Bind `guildId` from `ChannelComponent`**

In `src/app/features/guild/components/channel/channel.component.html`, extend the `<app-message>` binding:

Before:
```html
                                <app-message (jumpTo)="jumpToMessage($event)"
                                             (reply)="onReply($event)"
                                             [guildBots]="botCommandService.currentGuildBots()"
                                             [guildChannels]="guildChannels()"
                                             [guildRoles]="guildRoles()"
                                             [isGrouped]="row.isGrouped"
                                             [message]="row.message"></app-message>
```

After:
```html
                                <app-message (jumpTo)="jumpToMessage($event)"
                                             (reply)="onReply($event)"
                                             [guildBots]="botCommandService.currentGuildBots()"
                                             [guildChannels]="guildChannels()"
                                             [guildId]="guildId()"
                                             [guildRoles]="guildRoles()"
                                             [isGrouped]="row.isGrouped"
                                             [message]="row.message"></app-message>
```

`ChannelComponent` already exposes `protected guildId = computed(() => this.channel().guildId);` — no `.ts` change needed here. `ConversationComponent` is intentionally left unchanged: without a `guildId` binding, `MessageComponent.guildId()` stays `undefined` for every DM message, so `ReactionPickerComponent` never receives a `guildId` there and the custom-emoji section of the picker never renders in DMs — exactly the restriction the backend enforces server-side (400 on `emojiId` + `conversationId`).

- [ ] **Step 4: Type-check**

Run: `npx ng build --configuration development`
Expected: builds successfully — this resolves the type errors left open at the end of Task 7 and Task 8.

- [ ] **Step 5: Manual verification (end-to-end)**

Run the app:
1. In a guild channel, open the reaction picker (either the hover toolbar's or the reaction bar's trailing picker) — confirm a "This Server" category appears (only if you've uploaded at least one emoji via Task 5) alongside the standard unicode categories.
2. Pick a custom emoji — confirm it posts a reaction that renders as the emoji's image (not text), and the request sent used `emojiId` with no `reaction` field (check the network tab).
3. Click the same custom-emoji reaction pill again to remove it — confirm the request used `{reaction: <name>, contextId, channelId}` (no `emojiId`), and the pill disappears.
4. In a DM, open the reaction picker — confirm there is no "This Server" category (custom emoji never appear in DMs).
5. From a second account, react to the same message with a unicode emoji and confirm both reaction kinds coexist correctly and update live via the existing realtime path.
6. Delete the custom emoji from Guild Settings → Emojis while it's still attached to an existing reaction — confirm the reaction pill now renders as plain text `:name:` instead of breaking or disappearing (the `imageUrl()` fallback from Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/app/features/messaging/components/conversation/message/message.component.ts src/app/features/messaging/components/conversation/message/message.component.html src/app/features/guild/components/channel/channel.component.html
git commit -m "feat: wire custom emoji reactions end-to-end in MessageComponent"
```
