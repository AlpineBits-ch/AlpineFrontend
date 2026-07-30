# Guild Scheduled Events and Server Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Discord-equivalent guild scheduled events (list, create, edit, cancel, mark interested, realtime sync) and server templates (save a guild's structure as a template, preview one, create a guild from it).

**Architecture:** Two new services over the `/api/v1/guild` gateway base. Events get a `signalStore` (`ScheduledEventStore`) because their state is shared between the events panel and realtime SignalR handlers, mirroring the existing `GuildEmojiStore`. Templates need no store — every flow is a one-shot request/response. The events panel is a right-hand side panel modeled on the existing `ThreadPanelComponent`; templates surface as a guild-settings page plus a new tab in the create-guild modal. A new `ManageEvents` permission bit is added to the client permission model.

**Tech Stack:** Angular 21 signals, `@ngrx/signals` (`signalStore`, `withEntities`, `withMethods`, `patchState`), PrimeNG 21 (`Dialog`, `Button`, `InputText`, `Textarea`, `DatePicker`, `Select`), Tailwind v4 theme tokens, `@ngx-translate/core`.

## Global Constraints

- **Never invent colors.** Use theme tokens (`bg-card`, `bg-sidebar`, `bg-hover`, `border-border`, `text-text-primary`, `text-text-secondary`, `text-text-muted`, `text-online`, `text-connecting`) or CSS vars (`var(--color-brand)`, `var(--color-brand-dim)`, `color-mix(in srgb, var(--color-brand) 15%, transparent)`). No `bg-[#hex]`.
- **Font sizes use rem-based Tailwind classes** (`text-[0.625rem]`, not `text-[10px]`).
- **Scrollable areas use the `thin-scrollbar` class** from `styles.css`.
- **PrimeNG buttons:** `<p-button>` with `(onClick)`, never `(click)`.
- **All URLs through `this.apiConfig.baseUrl()`**; guild endpoints under `/api/v1/guild`.
- **Enums serialize as strings.** `status` is `"Scheduled" | "Active" | "Completed" | "Cancelled"`; template channel `type` is `"Text" | "Voice" | "Forum" | "Announcement"`.
- **All user-facing strings must be i18n keys** in `en.json`, `de.json`, `fr.json` (flat dotted keys). That directory is the `venta-i18n` git submodule — commit inside it first.
- **Visual target is Discord**, adapted to Alpine's conventions.
- Use `ChangeDetectionStrategy.OnPush` on all new components.
- Permission gating uses `src/app/enums/permissions.enum.ts`: `parsePermissions`, `hasPermission`.
- Do not modify `src-tauri/Cargo.lock`.

---

### Task 1: ManageEvents permission bit

**Files:**
- Modify: `src/app/enums/permissions.enum.ts`
- Modify: `src/app/enums/permissions.enum.spec.ts`

**Interfaces:**
- Produces: `Permissions.ManageEvents` — consumed by Tasks 4 and 5.

**Read first:** `src/app/enums/permissions.enum.ts` in full. Bits must match the backend exactly; the backend declares `ManageEvents = 1ul << 38` in `Guild.Domain/Enums/Permissions.cs`, directly after `ManageEmojis = 1ul << 37`.

- [ ] **Step 1: Write the failing test**

Add to `src/app/enums/permissions.enum.spec.ts`:

```ts
    it('exposes ManageEvents at bit 38, matching the backend enum', () => {
        expect(Permissions.ManageEvents).toBe(1n << 38n);
    });

    it('round-trips ManageEvents through the serializer', () => {
        expect(stringifyPermissions(Permissions.ManageEvents)).toBe('ManageEvents');
        expect(parsePermissions('ManageEvents')).toBe(Permissions.ManageEvents);
    });
```

Make sure the imports at the top of that spec include everything referenced.

- [ ] **Step 2: Run it to verify it fails**

Run: `ng test --watch=false --include='**/permissions.enum.spec.ts'`
Expected: FAIL — `Permissions.ManageEvents` is undefined.

- [ ] **Step 3: Add the bit**

In `permissions.enum.ts`, directly after the `ManageEmojis` entry:

```ts
    // ── Event permissions ─────────────────────────────────────────────────────
    ManageEvents: 1n << 38n,
```

And add it to `PERM_GROUPS` as its own group, after the `Emojis` group:

```ts
    {
        label: 'Events',
        perms: ['ManageEvents'],
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `ng test --watch=false --include='**/permissions.enum.spec.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/enums/permissions.enum.ts src/app/enums/permissions.enum.spec.ts
git commit -m "feat: add ManageEvents permission bit"
```

---

### Task 2: Scheduled event DTOs and service

**Files:**
- Create: `src/app/dtos/response/scheduled-event.dto.ts`
- Create: `src/app/services/scheduled-event.service.ts`
- Test: `src/app/services/scheduled-event.service.spec.ts`

**Interfaces:**
- Produces: `ScheduledEventDto`, `ScheduledEventStatus`, `CreateScheduledEventDto`, `UpdateScheduledEventDto`, `ScheduledEventService.{list,create,update,cancel,markInterested,removeInterest}` — consumed by Tasks 3-4.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/scheduled-event.service.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {ScheduledEventService} from './scheduled-event.service';
import {ApiConfigService} from './api-config.service';

describe('ScheduledEventService', () => {
    let service: ScheduledEventService;
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
        service = TestBed.inject(ScheduledEventService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('lists events under the guild', () => {
        service.list('g1').subscribe();
        const req = http.expectOne(`${base}/guilds/g1/events`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('updates an event by id, not under the guild', () => {
        service.update('e1', {title: 'x'}).subscribe();
        const req = http.expectOne(`${base}/events/e1`);
        expect(req.request.method).toBe('PATCH');
        req.flush({});
    });

    it('cancels via DELETE on the event', () => {
        service.cancel('e1').subscribe();
        const req = http.expectOne(`${base}/events/e1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('marks and removes interest on the same path with different verbs', () => {
        service.markInterested('e1').subscribe();
        expect(http.expectOne(`${base}/events/e1/interested`).request.method).toBe('POST');
        http.verify();

        service.removeInterest('e1').subscribe();
        expect(http.expectOne(`${base}/events/e1/interested`).request.method).toBe('DELETE');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `ng test --watch=false --include='**/scheduled-event.service.spec.ts'`
Expected: FAIL — cannot resolve the service.

- [ ] **Step 3: Write the DTOs**

Create `src/app/dtos/response/scheduled-event.dto.ts`:

```ts
export enum ScheduledEventStatus {
    Scheduled = 'Scheduled',
    Active = 'Active',
    Completed = 'Completed',
    Cancelled = 'Cancelled',
}

export interface ScheduledEventDto {
    id: string;
    guildId: string;
    creatorUserId: string;
    title: string;
    description?: string | null;
    /** ISO 8601. */
    startsAt: string;
    endsAt?: string | null;
    /** Freeform text - not mutually exclusive with voiceChannelId. */
    location?: string | null;
    voiceChannelId?: string | null;
    /**
     * Nothing server-side ever moves this off Scheduled except an explicit cancel.
     * Derive "happening now" from startsAt/endsAt, not from this field.
     */
    status: ScheduledEventStatus;
    interestedCount: number;
    isInterested: boolean;
}

export interface CreateScheduledEventDto {
    title: string;
    description?: string | null;
    startsAt: string;
    endsAt?: string | null;
    location?: string | null;
    voiceChannelId?: string | null;
}

/** PATCH semantics: only the fields you send are touched. */
export type UpdateScheduledEventDto = Partial<CreateScheduledEventDto>;
```

- [ ] **Step 4: Write the service**

Create `src/app/services/scheduled-event.service.ts`:

```ts
import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {
    CreateScheduledEventDto,
    ScheduledEventDto,
    UpdateScheduledEventDto,
} from '../dtos/response/scheduled-event.dto';

@Injectable({providedIn: 'root'})
export class ScheduledEventService {
    private apiConfig = inject(ApiConfigService);
    private http = inject(HttpClient);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/guild';
    }

    /** Already sorted by startsAt server-side. Cancelled events are excluded entirely. */
    list(guildId: string): Observable<ScheduledEventDto[]> {
        return this.http.get<ScheduledEventDto[]>(`${this.base}/guilds/${guildId}/events`);
    }

    create(guildId: string, dto: CreateScheduledEventDto): Observable<ScheduledEventDto> {
        return this.http.post<ScheduledEventDto>(`${this.base}/guilds/${guildId}/events`, dto);
    }

    update(eventId: string, dto: UpdateScheduledEventDto): Observable<ScheduledEventDto> {
        return this.http.patch<ScheduledEventDto>(`${this.base}/events/${eventId}`, dto);
    }

    /** Soft-cancels. The row survives so members who RSVP'd can see it was called off. */
    cancel(eventId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/events/${eventId}`);
    }

    markInterested(eventId: string): Observable<void> {
        return this.http.post<void>(`${this.base}/events/${eventId}/interested`, {});
    }

    removeInterest(eventId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/events/${eventId}/interested`);
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `ng test --watch=false --include='**/scheduled-event.service.spec.ts'`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/app/dtos/response/scheduled-event.dto.ts src/app/services/scheduled-event.service.ts src/app/services/scheduled-event.service.spec.ts
git commit -m "feat: add scheduled event DTOs and service"
```

---

### Task 3: Scheduled event store and realtime sync

**Files:**
- Create: `src/app/stores/scheduled-event.store.ts`
- Modify: `src/app/services/guild-websocket.service.ts`
- Test: `src/app/stores/scheduled-event.store.spec.ts`

**Interfaces:**
- Consumes: `ScheduledEventService` (Task 2).
- Produces: `ScheduledEventStore` with `{loadFor, create, update, cancel, toggleInterest, eventsForGuild, loading}`; `GuildWebsocketService.{eventCreatedObservable, eventUpdatedObservable, eventCancelledObservable}`.

**Read first:** `src/app/stores/guild-emoji.store.ts` in full — this store must follow its structure (`signalStore` + `withEntities` + `withState` + `withMethods`), and `src/app/services/guild-websocket.service.ts` around lines 398-434 for the `Subject` + `this.realtime.on(...)` registration pattern.

- [ ] **Step 1: Add the realtime events**

In `guild-websocket.service.ts`, add the payload interfaces next to the other `Ws*` interfaces:

```ts
export interface WsEventCreated {
    guildId: string;
    eventId: string;
    title: string;
    startsAt: string;
}

export type WsEventUpdated = WsEventCreated;

export interface WsEventCancelled {
    guildId: string;
    eventId: string;
}
```

Add the subjects alongside the existing ones:

```ts
    readonly eventCreatedObservable = new Subject<WsEventCreated>();
    readonly eventUpdatedObservable = new Subject<WsEventUpdated>();
    readonly eventCancelledObservable = new Subject<WsEventCancelled>();
```

And register the handlers immediately after the existing `guild.EmojiDeleted` line:

```ts
        this.realtime.on('guild.EventCreated', (d: WsEventCreated) => this.eventCreatedObservable.next(d));
        this.realtime.on('guild.EventUpdated', (d: WsEventUpdated) => this.eventUpdatedObservable.next(d));
        this.realtime.on('guild.EventCancelled', (d: WsEventCancelled) => this.eventCancelledObservable.next(d));
```

- [ ] **Step 2: Write the failing store test**

Create `src/app/stores/scheduled-event.store.spec.ts` covering:

- `loadFor(guildId)` populates `eventsForGuild(guildId)` from the service.
- `loadFor` called twice for the same guild issues only one request while the first is in flight.
- `toggleInterest` on a non-interested event optimistically sets `isInterested: true` and increments `interestedCount`, and rolls both back if the request errors.
- `cancel(eventId)` removes the event from `eventsForGuild`.

Provide `ScheduledEventService` as a stub object returning `of(...)`/`throwError(...)` rather than going through `HttpTestingController`, so the test targets store logic only.

- [ ] **Step 3: Run it to verify it fails**

Run: `ng test --watch=false --include='**/scheduled-event.store.spec.ts'`
Expected: FAIL — cannot resolve the store.

- [ ] **Step 4: Write the store**

Create `src/app/stores/scheduled-event.store.ts` following `guild-emoji.store.ts`:

- `signalStore({providedIn: 'root'}, withEntities<ScheduledEventDto>(), withState({loadingGuilds: {} as Record<string, boolean>, loadedGuilds: {} as Record<string, boolean>}))`.
- `eventsForGuild(guildId)`: entities filtered by `guildId`, sorted ascending by `startsAt`.
- `loadFor(guildId)`: no-op if already loading or loaded; otherwise sets loading, calls `service.list`, upserts entities, clears loading. On error, clear loading **and** the loaded flag so a retry is possible.
- `toggleInterest(event)`: optimistic — flip `isInterested` and adjust `interestedCount` by ±1 before the call; on error, restore both to the pre-call values. Call `markInterested`/`removeInterest` accordingly.
- `create` / `update`: upsert the returned entity.
- `cancel(eventId)`: remove the entity (the list endpoint excludes cancelled events, so keeping it would desync on reload).
- `applyRealtimeCreatedOrUpdated(guildId)`: the realtime payload carries only `{guildId, eventId, title, startsAt}` — not enough to build a full `ScheduledEventDto` (no `interestedCount`/`isInterested`). Clear the guild's `loadedGuilds` flag and call `loadFor(guildId)` to refetch rather than synthesizing a partial entity.
- `applyRealtimeCancelled(eventId)`: remove the entity.

**Do not** wire an `effect()` that both reads and patches the same store slice — an earlier feature in this codebase caused a request storm that way. Subscribe to the websocket subjects from the panel component (Task 4) or in `withHooks` `onInit` with a plain `subscribe`, never from an `effect` that also writes state the effect reads.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `ng test --watch=false --include='**/scheduled-event.store.spec.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/stores/scheduled-event.store.ts src/app/stores/scheduled-event.store.spec.ts src/app/services/guild-websocket.service.ts
git commit -m "feat: add scheduled event store with realtime sync"
```

---

### Task 4: Events panel UI

**Files:**
- Create: `src/app/features/guild/components/events-panel/events-panel.component.ts`
- Create: `src/app/features/guild/components/events-panel/events-panel.component.html`
- Create: `src/app/features/guild/components/events-panel/event-editor-dialog.component.ts`
- Create: `src/app/features/guild/components/events-panel/event-editor-dialog.component.html`
- Modify: the guild header/toolbar that already hosts the wiki toggle (find it with `grep -rn "GUILD.WIKI" src/app/features/guild`)

**Interfaces:**
- Consumes: `ScheduledEventStore` (Task 3), `Permissions.ManageEvents` (Task 1), `GuildWebsocketService` event subjects (Task 3).

**Read first:** `src/app/features/guild/components/channel/thread-panel/` for the side-panel layout, header, and close-button conventions this panel must match.

- [ ] **Step 1: Write the events panel**

`events-panel.component.ts`:

- Inputs: `guildId = input.required<string>()`, `memberPermissions = input.required<string>()` (the serialized permission string; parse with `parsePermissions`).
- `protected canManage = computed(() => hasPermission(parsePermissions(this.memberPermissions()), Permissions.ManageEvents));`
- An `effect` calling `store.loadFor(this.guildId())` when the id changes.
- In the constructor, subscribe (with `takeUntilDestroyed`) to `guildWebsocket.eventCreatedObservable`, `eventUpdatedObservable` and `eventCancelledObservable`, filtering to the current `guildId`, and dispatch to the store's `applyRealtime*` methods.
- `protected upcoming` / `protected past` computed lists, split on `startsAt`/`endsAt` vs `Date.now()`, because the server never advances `status`.
- Methods: `openCreate()`, `openEdit(event)`, `confirmCancel(event)`, `toggleInterest(event)`.

`events-panel.component.html`:

- Panel header: title `{{ 'EVENTS.TITLE' | translate }}` plus, `@if (canManage())`, a `<p-button icon="pi pi-plus" [text]="true" severity="secondary" size="small" (onClick)="openCreate()" />`.
- Body: `thin-scrollbar` scroll container, `@for` over `upcoming()` rendering an event card — `bg-card border border-border rounded-lg p-3` with:
  - a date/time line in `text-[0.75rem] text-[var(--color-brand-dim)] uppercase`, formatted with `DatePipe`,
  - the title in `text-text-primary font-medium`,
  - `@if (event.description)` a clamped description in `text-[0.8125rem] text-text-secondary`,
  - a location/voice row: `pi pi-map-marker` + `location`, and `@if (event.voiceChannelId)` a `pi pi-volume-up` + channel name with a "Join voice" `<p-button>` wired to the existing guild-voice join flow,
  - an interest button (`pi pi-star-fill` when `isInterested`, `pi pi-star` otherwise, in `text-connecting` when active) showing `interestedCount`,
  - `@if (canManage())` edit and cancel icon-buttons.
- An empty state when `upcoming()` is empty.
- A collapsed "Past events" section rendering `past()` at reduced opacity.
- Add a muted footer note that no reminders are sent — the backend pushes nothing as an event approaches, so the UI must not imply otherwise.

- [ ] **Step 2: Write the editor dialog**

`event-editor-dialog.component.ts` — a `<p-dialog>` used for both create and edit:

- Inputs: `guildId`, `event` (nullable — null means create), `visible` model.
- Fields: title (`InputText`, required), description (`Textarea`), `startsAt` (`<p-datepicker [showTime]="true" hourFormat="24">`), `endsAt` (same, optional), location (`InputText`), voice channel (`<p-select>` over the guild's `ChannelType.Voice` channels, with a clear option).
- Client-side validation mirroring the server: title non-empty; `endsAt`, if set, must be strictly after `startsAt` (the server 400s otherwise).
- Convert the `Date` values from `p-datepicker` to ISO strings with `.toISOString()` before sending.
- On save, call `store.create(...)` or `store.update(...)`; close on success, toast on error.

- [ ] **Step 3: Add the panel toggle to the guild header**

Find the guild header component that toggles the wiki panel and add an events toggle beside it: `<p-button icon="pi pi-calendar" [text]="true" severity="secondary" size="small" (onClick)="toggleEvents()" [pTooltip]="'EVENTS.TITLE' | translate" />`, with a `showEvents` signal rendering `<app-events-panel>` in the same slot the wiki panel uses. Mirror the wiki panel's show/hide wiring exactly rather than inventing a new mechanism.

- [ ] **Step 4: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; suite green.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/events-panel src/app/features/guild
git commit -m "feat: add guild scheduled events panel"
```

---

### Task 5: Server templates

**Files:**
- Create: `src/app/dtos/response/guild-template.dto.ts`
- Create: `src/app/services/guild-template.service.ts`
- Create: `src/app/features/guild/components/guild-settings-modal/pages/templates-settings/templates-settings.component.ts`
- Create: `src/app/features/guild/components/guild-settings-modal/pages/templates-settings/templates-settings.component.html`
- Create: `src/app/features/guild/components/create-guild-modal/template-preview.component.ts`
- Create: `src/app/features/guild/components/create-guild-modal/template-preview.component.html`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts` and `.html`
- Modify: `src/app/features/guild/components/create-guild-modal/create-guild-modal.component.ts` and `.html`
- Test: `src/app/services/guild-template.service.spec.ts`

**Interfaces:**
- Produces: `GuildTemplateDto`, `GuildTemplateService.{createFromGuild,get,useTemplate}`.

- [ ] **Step 1: Write the failing test**

Create `src/app/services/guild-template.service.spec.ts` asserting:

- `createFromGuild('g1', {name, description})` → `POST {base}/guilds/g1/templates`.
- `get('t1')` → `GET {base}/templates/t1`.
- `useTemplate('t1', {name, description})` → `POST {base}/templates/t1/use`.

Use the same `ApiConfigService` stub pattern as the other service specs in this plan.

- [ ] **Step 2: Run it to verify it fails**

Run: `ng test --watch=false --include='**/guild-template.service.spec.ts'`
Expected: FAIL.

- [ ] **Step 3: Write the DTOs**

Create `src/app/dtos/response/guild-template.dto.ts`:

```ts
import {ChannelType} from './guild.dto';

export interface TemplateChannel {
    name: string;
    type: ChannelType;
    description?: string | null;
    position: number;
}

export interface TemplateCategory {
    name: string;
    position: number;
    channels: TemplateChannel[];
}

export interface TemplateRole {
    name: string;
    color: string;
    position: number;
    /** Raw bitmask as a number, not the comma-separated flag string used elsewhere. */
    permissions: number;
}

export interface GuildTemplateDto {
    id: string;
    name: string;
    description?: string | null;
    creatorUserId: string;
    createdAt: string;
    usageCount: number;
    /** Structure only - no permission overwrites, members, or messages are captured. */
    snapshot: {
        roles: TemplateRole[];
        categories: TemplateCategory[];
        uncategorizedChannels: TemplateChannel[];
    };
}

export interface CreateTemplateDto {
    name: string;
    description?: string;
}

export interface UseTemplateDto {
    name: string;
    description?: string;
}
```

**Note:** the template snapshot may contain `type: "Announcement"`, which the messaging-parity plan adds to `ChannelType`. If `ChannelType.Announcement` does not exist yet when this task runs, add it — it is a one-line addition and both plans converge on the same value `Announcement = 'Announcement'`.

- [ ] **Step 4: Write the service**

Create `guild-template.service.ts` with `createFromGuild`, `get`, `useTemplate`, following the `GuildEmojiService` shape exactly (private `base` getter off `apiConfig.baseUrl()`, one method per endpoint, no state).

`createFromGuild` returns `{id, name, description, createdAt}`; `useTemplate` returns `{id, name}` for the **new guild** — treat it exactly like the normal create-guild response.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `ng test --watch=false --include='**/guild-template.service.spec.ts'`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the "save as template" settings page**

`templates-settings.component.ts` + `.html`:

- A name field, a description field, and a "Save as template" `<p-button>` calling `createFromGuild`.
- On success, show the resulting template id prominently with a copy button, and copy explaining it is shareable by id like an invite code — **there is no template directory**, so an id nobody saved is unrecoverable. Make that consequence explicit in the UI copy.
- A muted list of what a template does and does not capture (structure and role permission bitmasks yes; permission overwrites, members, and messages no).
- Register in the guild settings modal under the **`Community`** nav group: `{id: 'templates', label: 'Templates', icon: 'pi pi-clone'}` plus the matching `@case`.

- [ ] **Step 7: Add "create from template" to the create-guild modal**

Read `create-guild-modal.component.ts` and `.html` first — it already has a "Import from Discord" alternate path whose structure this should mirror.

- Add a "Use a template" mode alongside the existing create and import paths.
- Input: a template id (accept a pasted full URL too and extract the trailing id segment).
- On blur/submit, call `templateService.get(id)`; on `404`, show an inline "No template with that code" message.
- On success, render `<app-template-preview [template]="template()" />`: a summary line ("Creates 3 categories, 8 channels, 4 roles"), a category/channel tree using the same channel-type icons as the sidebar, and a role list with color swatches (`[style.background-color]="role.color"`).
- A name field for the new guild, then a "Create" button calling `useTemplate`. On success, reuse the existing post-create-guild navigation path — the response has the same `{id, name}` shape.
- Note in the UI that roles may need reordering after creation, since the backend does not preserve exact positions.

- [ ] **Step 8: Verify**

Run: `ng build && ng test --watch=false`
Expected: build succeeds; suite green.

- [ ] **Step 9: Commit**

```bash
git add src/app/dtos/response/guild-template.dto.ts src/app/services/guild-template.service.ts src/app/services/guild-template.service.spec.ts src/app/features/guild/components/guild-settings-modal src/app/features/guild/components/create-guild-modal
git commit -m "feat: add server templates"
```

---

### Task 6: i18n keys

**Files:**
- Modify: `src/assets/i18n/locales/en.json`, `de.json`, `fr.json`

- [ ] **Step 1: Collect every new key**

Grep Tasks 4-5's files for `| translate`. Include at minimum the `EVENTS.*` group (title, create, edit, cancel, interested, starts, ends, location, join voice, empty state, past events, no-reminders note), the `GUILD_SETTINGS.TEMPLATES.*` group, `CREATE_GUILD.USE_TEMPLATE` and its preview strings, and `GUILD_SETTINGS.NAV.TEMPLATES`.

- [ ] **Step 2: Add to all three locales with real translations**

Flat dotted keys, grouped topically. No English placeholders in `de.json`/`fr.json`.

- [ ] **Step 3: Verify parity**

```bash
node -e "const a=require('./src/assets/i18n/locales/en.json'),b=require('./src/assets/i18n/locales/de.json'),c=require('./src/assets/i18n/locales/fr.json');const ka=Object.keys(a).sort(),kb=Object.keys(b).sort(),kc=Object.keys(c).sort();const miss=(x,y,n)=>x.filter(k=>!y.includes(k)).forEach(k=>console.log('missing in '+n+':',k));miss(ka,kb,'de');miss(ka,kc,'fr');console.log('en',ka.length,'de',kb.length,'fr',kc.length)"
```

Expected: no "missing in" lines; equal counts.

- [ ] **Step 4: Commit the submodule, then the pointer**

```bash
cd src/assets/i18n/locales
git add en.json de.json fr.json
git commit -m "feat: add events and templates strings"
git push
cd ../../../..
git add src/assets/i18n/locales
git commit -m "chore: bump i18n submodule for events and templates strings"
```

---

## Notes for the controller

**Expected merge conflicts with sibling plans in this batch:**

- `guild-settings-modal.component.ts` (`navGroups` + `imports`) and `.html` (`@case` blocks) — also modified by the guild-safety plan. Resolve by union.
- `src/app/services/guild-websocket.service.ts` — this plan adds three event subjects and handlers; the messaging-parity plan may also touch the file. Both are purely additive; resolve by union.
- `src/app/dtos/response/guild.dto.ts` — Task 5 may add `ChannelType.Announcement`, which the messaging-parity plan also adds. Identical value; keep one.
- `src/app/enums/permissions.enum.ts` — only this plan touches it in this batch.
- The three i18n locale files — union of added keys.
