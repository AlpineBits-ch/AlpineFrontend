# Guild Moderation & Permission Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Alpine Angular/Tauri client up to the backend's new Guild moderation surface - bans, kicks, timeouts, audit log, role hierarchy, channel permission overwrites, channel update/slowmode/threads, rich mentions, and Idle/DoNotDisturb presence - per the backend team's "Guild Moderation & Permission Completion" integration guide.

**Architecture:** All new REST calls go through the existing `GuildService` (guild domain) and `ProfileService` (social domain, for self-status). All new push events register on the existing single shared SignalR connection (`RealtimeConnectionService`) via the existing per-domain wrapper services (`GuildWebsocketService` for `guild.*` events). UI additions follow the codebase's established patterns exactly: PrimeNG `Dialog`-based settings pages under `guild-settings-modal/pages/*` and `channel-settings-modal/pages/*`, `Menu`/`ContextMenu` for right-click actions, `signal()`-based local state, `hasPermission(parsePermissions(...), Permissions.X)` for inline gating (no new directive/pipe infrastructure - matches existing repo convention).

**Tech Stack:** Angular 21 (standalone components, signals), PrimeNG 21, `@microsoft/signalr` 10, RxJS 7, `@ngx-translate/core`, Vitest (`@angular/build:unit-test`) + `HttpClientTestingModule`/`HttpTestingController` for service tests.

## Global Constraints

- JSON property names from the backend are **camelCase**; enum values serialize as **PascalCase strings** (`"Online"`, `"MemberBanned"`, `"Text"`) - never numbers, never camelCase enum values.
- Every gateway route below already includes the `/guild` or `/social` prefix the reverse proxy expects - `GuildService.base` is `${apiConfig.baseUrl()}/api/v1/guild`, so route strings in this plan are written relative to that base (e.g. `/guilds/{id}/bans` → `${this.base}/guilds/{id}/bans`). `ProfileService` uses `${apiConfig.baseUrl()}/api/v1/social/...` directly (no stored base).
- Permission bitmask is a **64-bit value** - always `bigint` (`1n << 32n`, never `1 << 32`). Truncating to `number` silently corrupts the top bits.
- Every new/changed permission-gated action must be checked client-side with `hasPermission(parsePermissions(member.permissions), Permissions.X)` (member-level) - this repo has no permission directive/pipe; follow the existing inline-computed-signal pattern from `channel-list.component.ts`.
- i18n: this repo uses flat-key `@ngx-translate/core` JSON files at `src/assets/i18n/locales/{en,de,fr}.json`. Add new keys to **`en.json` only** in this plan (matching how large recent features have landed - see `GUILD_SETTINGS.*` keys) and leave `de.json`/`fr.json` for a follow-up translation pass; this is a deliberate scope cut, not an oversight.
- Follow existing component conventions exactly: `signal()` for local state, `input.required<T>()` / `input<T>()` for component inputs, `inject()` for DI, `(onClick)` (not `(click)`) on `<p-button>`, `ToastService.httpError(...)` for failed-request toasts, `takeUntilDestroyed(this.destroyRef)` for subscribing to long-lived observables in components.
- This plan does not add automated tests for every UI component - this repo does not do that today (7 `.spec.ts` files total, mostly service/pure-logic). Tests are added in this plan for **service methods** (HTTP route/body correctness) and **pure functions** (permission bits, composer mention parsing) using the existing `HttpClientTestingModule` / `TestBed` + Vitest pattern (see `src/app/interceptors/token-interceptor.spec.ts`, `src/app/services/mls.service.spec.ts`). UI-heavy tasks end with a manual dev-server verification step instead.

---

## Part 1 - Foundations: permission bits, DTOs, enums

### Task 1: Add moderation permission bits and the audit-log DTO

**Files:**
- Modify: `src/app/enums/permissions.enum.ts`
- Modify: `src/app/features/guild/shared/permission-toggle/permission-toggle.component.ts`
- Modify: `src/app/features/guild/shared/permission-override-editor/permission-override-editor.component.ts`
- Create: `src/app/dtos/response/audit-log-entry.dto.ts`
- Test: `src/app/enums/permissions.enum.spec.ts`

**Interfaces:**
- Produces: `Permissions.KickMembers`, `Permissions.BanMembers`, `Permissions.ModerateMembers`, `Permissions.ManageGuild`, `Permissions.ViewAuditLog` (all `bigint`); `AuditLogEntryDto`, `AuditLogActionType` (string union) - consumed by Task 10 (service), Task 19 (bans UI), Task 20 (audit log UI), Task 18 (member context menu).

- [ ] **Step 1: Write the failing test for the new bit values**

```typescript
// src/app/enums/permissions.enum.spec.ts
import {describe, expect, it} from 'vitest';
import {hasPermission, Permissions, PermissionKey, stringifyPermissions} from './permissions.enum';

describe('Permissions moderation bits', () => {
    it('defines KickMembers at bit 32', () => {
        expect(Permissions.KickMembers).toBe(1n << 32n);
    });

    it('defines BanMembers at bit 33', () => {
        expect(Permissions.BanMembers).toBe(1n << 33n);
    });

    it('defines ModerateMembers at bit 34', () => {
        expect(Permissions.ModerateMembers).toBe(1n << 34n);
    });

    it('defines ManageGuild at bit 35', () => {
        expect(Permissions.ManageGuild).toBe(1n << 35n);
    });

    it('defines ViewAuditLog at bit 36', () => {
        expect(Permissions.ViewAuditLog).toBe(1n << 36n);
    });

    it('does not collide with any existing bit (0-31, 63)', () => {
        const newBits: PermissionKey[] = ['KickMembers', 'BanMembers', 'ModerateMembers', 'ManageGuild', 'ViewAuditLog'];
        const existingKeys = (Object.keys(Permissions) as PermissionKey[])
            .filter(k => !newBits.includes(k) && k !== 'None');
        for (const newKey of newBits) {
            for (const existingKey of existingKeys) {
                expect(Permissions[newKey] & Permissions[existingKey]).toBe(0n);
            }
        }
    });

    it('stringifyPermissions round-trips a mask containing BanMembers', () => {
        const mask = Permissions.ViewChannel | Permissions.BanMembers;
        const serialized = stringifyPermissions(mask);
        expect(serialized).toContain('BanMembers');
        expect(hasPermission(mask, Permissions.BanMembers)).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx ng test --include src/app/enums/permissions.enum.spec.ts`
Expected: FAIL - `Permissions.KickMembers` is `undefined`, so `undefined === 1n << 32n` fails.

- [ ] **Step 3: Add the five bits to `Permissions`**

In `src/app/enums/permissions.enum.ts`, insert after the existing `ManagePermissions: 1n << 21n,` line's group (keep the `CreateInvite: 1n << 22n,` line where it is) - add a new group right before `// ── Catch-all` :

```typescript
    // ── Guild moderation permissions ─────────────────────────────────────────
    KickMembers: 1n << 32n,
    BanMembers: 1n << 33n,
    ModerateMembers: 1n << 34n,
    ManageGuild: 1n << 35n,
    ViewAuditLog: 1n << 36n,

```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx ng test --include src/app/enums/permissions.enum.spec.ts`
Expected: PASS

- [ ] **Step 5: Add the new bits to the two permission-editing UIs**

In `src/app/features/guild/shared/permission-toggle/permission-toggle.component.ts`, change the `'Moderation'` group:

```typescript
    {
        label: 'Moderation',
        perms: ['ManageChannel', 'ManagePermissions', 'ManageGuild', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ViewAuditLog'],
    },
```

`permission-override-editor.component.ts` is scoped to per-channel/category overwrites only - `KickMembers`/`BanMembers`/`ModerateMembers`/`ManageGuild`/`ViewAuditLog` are guild-scoped moderation actions that don't apply to a channel overwrite, so leave its `PERM_GROUPS` untouched. (No-op sub-step, documented so the next task doesn't re-investigate this.)

- [ ] **Step 6: Create the audit log entry DTO**

```typescript
// src/app/dtos/response/audit-log-entry.dto.ts
export type AuditLogActionType =
    | 'MemberBanned' | 'MemberUnbanned' | 'MemberKicked' | 'MemberMuted' | 'MemberUnmuted' | 'MemberLeft'
    | 'RoleCreated' | 'RoleUpdated' | 'RoleDeleted' | 'RolePositionsChanged'
    | 'ChannelCreated' | 'ChannelDeleted' | 'ChannelUpdated' | 'ChannelPermissionChanged'
    | 'CategoryCreated' | 'CategoryDeleted'
    | 'GuildUpdated' | 'GuildDeleted'
    | 'InviteCreated' | 'InviteDeleted';

export interface AuditLogEntryDto {
    id: string;
    guildId: string;
    actorUserId: string;
    actionType: AuditLogActionType;
    targetId: string | null;
    /** JSON-encoded string, not a nested object - caller must JSON.parse it. */
    metadata: string | null;
    createdAt: string;
}
```

- [ ] **Step 7: Commit**

```bash
git add src/app/enums/permissions.enum.ts src/app/enums/permissions.enum.spec.ts src/app/features/guild/shared/permission-toggle/permission-toggle.component.ts src/app/dtos/response/audit-log-entry.dto.ts
git commit -m "feat: add guild moderation permission bits and audit log DTO"
```

---

### Task 2: Add role `position`, ban, mute, and reorder DTOs

**Files:**
- Modify: `src/app/dtos/response/guild.dto.ts` (add `position` to `RoleDto`)
- Create: `src/app/dtos/response/ban.dto.ts`
- Create: `src/app/dtos/request/reorder-roles.dto.ts`
- Create: `src/app/dtos/request/mute-member.dto.ts`

**Interfaces:**
- Consumes: none (pure DTO additions).
- Produces: `RoleDto.position: number`; `BanDto`; `ReorderRolesDto`; `MuteMemberDto` - consumed by Task 11 (service), Task 22 (role reorder UI), Task 19 (bans UI), Task 18 (mute action).

- [ ] **Step 1: Add `position` to `RoleDto`**

In `src/app/dtos/response/guild.dto.ts`, add the field to the existing interface:

```typescript
export interface RoleDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string;
    description: string;
    color: string;
    guildId: string;
    userId: string;
    permissions: string;
    type: RoleType;
    position: number;
}
```

- [ ] **Step 2: Create the ban DTO**

```typescript
// src/app/dtos/response/ban.dto.ts
export interface BanDto {
    id: string;
    guildId: string;
    userId: string;
    reason: string | undefined;
    createdAt: Date;
}
```

- [ ] **Step 3: Create the role-reorder request DTO**

```typescript
// src/app/dtos/request/reorder-roles.dto.ts
export interface RolePositionDto {
    roleId: string;
    position: number;
}

export interface ReorderRolesDto {
    roles: RolePositionDto[];
}
```

- [ ] **Step 4: Create the mute-member request DTO**

```typescript
// src/app/dtos/request/mute-member.dto.ts
export interface MuteMemberDto {
    durationMinutes: number;
}
```

- [ ] **Step 5: Verify the project still compiles**

Run: `npx ng build --configuration development`
Expected: build succeeds (no consumer of `RoleDto` was relying on an exhaustive/sealed shape, so adding a required field is safe - `RoleDto` is only ever read from server responses or spread-copied, never constructed by hand in the current codebase; this task itself doesn't add any construction sites either).

- [ ] **Step 6: Commit**

```bash
git add src/app/dtos/response/guild.dto.ts src/app/dtos/response/ban.dto.ts src/app/dtos/request/reorder-roles.dto.ts src/app/dtos/request/mute-member.dto.ts
git commit -m "feat: add role position field, ban, mute and role-reorder DTOs"
```

---

### Task 3: Add channel slowmode, `Thread` type, and thread request DTOs

**Files:**
- Modify: `src/app/dtos/response/guild.dto.ts` (`ChannelType`, `ChannelDto`)
- Modify: `src/app/services/guild.service.ts` (`UpdateChannelDto`)
- Create: `src/app/dtos/request/create-thread.dto.ts`

**Interfaces:**
- Consumes: none.
- Produces: `ChannelType.Thread`; `ChannelDto.slowModeSeconds: number`, `ChannelDto.parentChannelId: string | undefined`; `UpdateChannelDto` becomes a full-replace shape; `CreateThreadDto` - consumed by Task 12 (service), Task 23 (channel overview UI), Task 25 (threads UI).

- [ ] **Step 1: Extend `ChannelType` and `ChannelDto`**

In `src/app/dtos/response/guild.dto.ts`:

```typescript
export enum ChannelType {
    Text = 'Text',
    Voice = 'Voice',
    Thread = 'Thread',
}

export interface ChannelDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    name: string;
    description: string;
    type: ChannelType;
    guildId: string;
    isAgeRestricted: boolean;
    isPrivate: boolean;
    categoryId: string | undefined;
    permissions: ChannelPermission[];
    position: number;
    slowModeSeconds: number;
    parentChannelId: string | undefined;
}
```

Note: `Forum`, `Ticket`, `Announcement` are explicitly *not* added - the backend guide states channel creation now `400`s for those types since nothing is implemented behind them, so there is nothing for the client to represent.

- [ ] **Step 2: Change `UpdateChannelDto` to the full-replace shape and add `slowModeSeconds`**

In `src/app/services/guild.service.ts`:

```typescript
export interface UpdateChannelDto {
    name: string;
    description?: string;
    isAgeRestricted: boolean;
    isPrivate: boolean;
    slowModeSeconds: number;
}
```

(`categoryId` is removed from this DTO - it was never part of the PATCH body the backend guide documents for `PATCH /channels/{channelId}`; category assignment happens through channel reorder, which already has its own `ReorderChannesDto`. Grep confirms `categoryId` is not read from `UpdateChannelDto` anywhere outside `channel-overview.component.ts`, which Task 23 rewrites anyway.)

- [ ] **Step 3: Create the thread-create request DTO**

```typescript
// src/app/dtos/request/create-thread.dto.ts
export interface CreateThreadDto {
    name: string;
    description?: string;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/dtos/response/guild.dto.ts src/app/services/guild.service.ts src/app/dtos/request/create-thread.dto.ts
git commit -m "feat: add Thread channel type, slowmode field, and thread request DTO"
```

(Task 19 fixes the now-broken `channel-overview.component.ts` call site that only sends 4 of the 5 required `UpdateChannelDto` fields - the build will fail on that file until then, which is expected and resolved within this same plan before final verification.)

---

### Task 4: Add rich-mention fields to message DTOs

**Files:**
- Modify: `src/app/dtos/response/message.dto.ts`
- Modify: `src/app/dtos/request/create-message.dto.ts`

**Interfaces:**
- Produces: `MessageDto.roleMentions?/mentionsEveryone?/mentionsHere?`; `CreateMessageDto` same three fields - consumed by Task 16 (SignalR payload), Task 27 (composer).

- [ ] **Step 1: Extend `MessageDto`**

In `src/app/dtos/response/message.dto.ts`, add after `mentions: string[];`:

```typescript
    mentions: string[];
    roleMentions?: string[];
    mentionsEveryone?: boolean;
    mentionsHere?: boolean;
```

- [ ] **Step 2: Extend `CreateMessageDto`**

In `src/app/dtos/request/create-message.dto.ts`, add after `mentions: string[];`:

```typescript
    mentions: string[];
    roleMentions?: string[];
    mentionsEveryone?: boolean;
    mentionsHere?: boolean;
```

- [ ] **Step 3: Commit**

```bash
git add src/app/dtos/response/message.dto.ts src/app/dtos/request/create-message.dto.ts
git commit -m "feat: add optional role/everyone/here mention fields to message DTOs"
```

---

### Task 5: Add invite `code`/`expiresAt`/`maxUses`/`useCount` and Idle/DoNotDisturb/Hidden presence

**Files:**
- Modify: `src/app/dtos/response/invite.dto.ts`
- Modify: `src/app/dtos/request/create-invite.dto.ts`
- Modify: `src/app/dtos/response/profile.dto.ts`

**Interfaces:**
- Produces: `InviteDto.code/expiresAt/maxUses/useCount`; `CreateInviteDto.expiresAt/maxUses/channelId`; `OnlineStatus.Idle/DoNotDisturb/Hidden` - consumed by Task 14 (service), Task 26 (invites UI), Task 17 (presence service), Task 28 (status UI).

- [ ] **Step 1: Extend `InviteDto`**

```typescript
// src/app/dtos/response/invite.dto.ts
import {GuildDto} from './guild.dto';

export enum InviteType {
    OneTime = 'OneTime',
    Permanent = 'Permanent',
}

export enum InviteState {
    Active = 'Active',
    Expired = 'Expired',
}

export interface InviteDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    type: InviteType;
    state: InviteState;
    guildId: string;
    guild?: GuildDto;
    code: string;
    expiresAt?: string;
    maxUses?: number;
    useCount: number;
}
```

- [ ] **Step 2: Extend `CreateInviteDto`**

```typescript
// src/app/dtos/request/create-invite.dto.ts
import {InviteType} from "../response/invite.dto";

export interface CreateInviteDto {
    type: InviteType;
    expiresAt?: string;
    maxUses?: number;
    channelId?: string;
}
```

- [ ] **Step 3: Extend `OnlineStatus`**

```typescript
// src/app/dtos/response/profile.dto.ts
export interface ProfileDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userName: string;
    bio: string | undefined;
    userId: string;
    avatarUrl: string | undefined;
    onlineStatus: OnlineStatus;
}

export enum OnlineStatus {
    Offline = 'Offline',
    Hidden = 'Hidden',
    Online = 'Online',
    Idle = 'Idle',
    DoNotDisturb = 'DoNotDisturb',
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/dtos/response/invite.dto.ts src/app/dtos/request/create-invite.dto.ts src/app/dtos/response/profile.dto.ts
git commit -m "feat: add invite code/expiry/uses fields and Idle/DoNotDisturb/Hidden presence states"
```

---

## Part 2 - `GuildService` route fixes and new endpoints

### Task 6: Fix ban routes and kick route

The existing `banMemberByUserId(guildId, userId)` hits `POST /guilds/{guildId}/bans/{userId}` with an empty body - the backend guide specifies `POST /guilds/{guildId}/bans` with body `{ userId, reason? }`. The existing `kickMember(guildId, memberId)` hits `DELETE /guild/{guildId}/member/{memberId}` (singular, legacy) - the guide specifies `DELETE /guilds/{guildId}/members/{memberId}` (plural). Both are corrected here; `getBans`/`unbanMember` are added.

**Files:**
- Modify: `src/app/services/guild.service.ts`
- Modify: `src/app/features/guild/components/channel-list/channel-list.component.ts` (fixes the now-broken `banParticipant()` call site)
- Test: `src/app/services/guild.service.spec.ts` (new file - first spec for this service)

**Interfaces:**
- Consumes: `BanDto` (Task 2).
- Produces: `GuildService.banMember(guildId, dto: {userId: string; reason?: string}): Observable<void>`, `getBans(guildId): Observable<BanDto[]>`, `unbanMember(guildId, userId): Observable<void>`, corrected `kickMember(guildId, memberId): Observable<void>` - consumed by Task 18, Task 19, Task 21.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/app/services/guild.service.spec.ts
import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {GuildService} from './guild.service';
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
        service: TestBed.inject(GuildService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('GuildService bans', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('banMember POSTs to /guilds/{guildId}/bans with userId and reason in the body', () => {
        const {service, ctrl} = setup();
        service.banMember('g1', {userId: 'u1', reason: 'spam'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/bans`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({userId: 'u1', reason: 'spam'});
        req.flush(null);
    });

    it('banMember omits reason when not provided', () => {
        const {service, ctrl} = setup();
        service.banMember('g1', {userId: 'u1'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/bans`);
        expect(req.request.body).toEqual({userId: 'u1'});
        req.flush(null);
    });

    it('getBans GETs the bans list', () => {
        const {service, ctrl} = setup();
        service.getBans('g1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/bans`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('unbanMember DELETEs by userId', () => {
        const {service, ctrl} = setup();
        service.unbanMember('g1', 'u1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/bans/u1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('kickMember DELETEs the plural /guilds/{guildId}/members/{memberId} route', () => {
        const {service, ctrl} = setup();
        service.kickMember('g1', 'm1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/members/m1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ng test --include src/app/services/guild.service.spec.ts`
Expected: FAIL - `service.banMember` does not exist (`banMemberByUserId` does, with a different signature); `getBans`/`unbanMember` don't exist; `kickMember`'s request hits `/guild/g1/member/m1`, not `/guilds/g1/members/m1`.

- [ ] **Step 3: Fix the routes in `guild.service.ts`**

Replace the `// ── Members ──` block's ban/kick methods:

```typescript
    kickMember(guildId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/members/${memberId}`);
    }

    kickMemberByUserId(guildId: string, userId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/members/by-user/${userId}`);
    }

    banMember(guildId: string, dto: {userId: string; reason?: string}): Observable<void> {
        return this.http.post<void>(`${this.base}/guilds/${guildId}/bans`, dto);
    }

    getBans(guildId: string): Observable<BanDto[]> {
        return this.http.get<BanDto[]>(`${this.base}/guilds/${guildId}/bans`);
    }

    unbanMember(guildId: string, userId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/bans/${userId}`);
    }
```

Remove `banMemberByUserId` entirely (replaced by `banMember`). Add the import at the top of the file:

```typescript
import {BanDto} from "../dtos/response/ban.dto";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ng test --include src/app/services/guild.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Fix the now-broken `banParticipant()` call site**

In `src/app/features/guild/components/channel-list/channel-list.component.ts`, `banParticipant()` currently calls `this.guildService.banMemberByUserId(this.guild().id, menu.participant.userId)`. Change it to:

```typescript
    protected async banParticipant(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set(null);
        await firstValueFrom(
            this.guildService.banMember(this.guild().id, {userId: menu.participant.userId})
        ).catch(() => {
        });
    }
```

- [ ] **Step 6: Run the full test suite to check nothing else broke**

Run: `npx ng test`
Expected: PASS (all suites, including the pre-existing 6)

- [ ] **Step 7: Commit**

```bash
git add src/app/services/guild.service.ts src/app/services/guild.service.spec.ts src/app/features/guild/components/channel-list/channel-list.component.ts
git commit -m "fix: correct ban/kick routes to match backend guide, add ban list/unban"
```

---

### Task 7: Add timeout (mute/unmute) and leave-guild endpoints

**Files:**
- Modify: `src/app/services/guild.service.ts`
- Modify: `src/app/features/guild/components/server-taskbar/server-taskbar.component.ts` (`leaveServer` now uses the real endpoint instead of the kick-self workaround)
- Test: `src/app/services/guild.service.spec.ts`

**Interfaces:**
- Consumes: `MuteMemberDto` (Task 2).
- Produces: `muteMember(guildId, memberId, durationMinutes): Observable<void>`, `unmuteMember(guildId, memberId): Observable<void>`, `leaveGuild(guildId): Observable<void>` - consumed by Task 18 (mute action), Task 21 (leave server).

- [ ] **Step 1: Write the failing tests**

Append to `src/app/services/guild.service.spec.ts`:

```typescript
describe('GuildService timeouts and leave', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('muteMember POSTs durationMinutes to the mute route', () => {
        const {service, ctrl} = setup();
        service.muteMember('g1', 'm1', 60).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/members/m1/mute`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({durationMinutes: 60});
        req.flush(null);
    });

    it('unmuteMember DELETEs the mute route', () => {
        const {service, ctrl} = setup();
        service.unmuteMember('g1', 'm1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/members/m1/mute`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('leaveGuild DELETEs /guilds/{guildId}/members/me', () => {
        const {service, ctrl} = setup();
        service.leaveGuild('g1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/members/me`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx ng test --include src/app/services/guild.service.spec.ts`
Expected: FAIL - the three methods don't exist yet.

- [ ] **Step 3: Add the methods**

In `src/app/services/guild.service.ts`, add below the ban methods added in Task 6:

```typescript
    muteMember(guildId: string, memberId: string, durationMinutes: number): Observable<void> {
        return this.http.post<void>(`${this.base}/guilds/${guildId}/members/${memberId}/mute`, {durationMinutes});
    }

    unmuteMember(guildId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/members/${memberId}/mute`);
    }

    leaveGuild(guildId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/guilds/${guildId}/members/me`);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx ng test --include src/app/services/guild.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Wire `leaveServer()` in `server-taskbar.component.ts` to the real endpoint**

Replace the current implementation:

```typescript
    private leaveServer(guild: GuildDto): void {
        this.guildService.leaveGuild(guild.id).subscribe({
            next: () => {
                this.guilds.update(gs => gs.filter(g => g.id !== guild.id));
                const ws = this.navService.workspace();
                if (ws.type === 'server' && ws.guild.id === guild.id) {
                    this.navService.selectDMs();
                }
            },
            error: err => {
                if (err.status === 400) {
                    this.toastService.error('You must delete the server instead of leaving, since you own it.');
                } else {
                    this.toastService.httpError('Failed to leave server', err);
                }
            },
        });
    }
```

Add `private toastService = inject(ToastService);` to the class and `import {ToastService} from '../../../../services/toast.service';` at the top. The `profileService` field that only existed to read `ownUserId` for the old kick-self workaround stays if it's used elsewhere in the file (check with a grep for `profileService` before removing it - `inviteToServer`/other methods do not use it per the earlier read, so remove the now-unused `private profileService = inject(ProfileService);` field and its import only if nothing else in the file references `this.profileService`).

- [ ] **Step 6: Commit**

```bash
git add src/app/services/guild.service.ts src/app/services/guild.service.spec.ts src/app/features/guild/components/server-taskbar/server-taskbar.component.ts
git commit -m "feat: add timeout/mute and real leave-guild endpoints"
```

---

### Task 8: Add audit log fetch and role reorder endpoints

**Files:**
- Modify: `src/app/services/guild.service.ts`
- Test: `src/app/services/guild.service.spec.ts`

**Interfaces:**
- Consumes: `AuditLogEntryDto` (Task 1), `ReorderRolesDto` (Task 2).
- Produces: `getAuditLog(guildId, skip, take): Observable<AuditLogEntryDto[]>`, `reorderRoles(guildId, dto): Observable<void>` - consumed by Task 20 (audit log UI), Task 22 (role reorder UI).

- [ ] **Step 1: Write the failing tests**

```typescript
describe('GuildService audit log and role reorder', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('getAuditLog GETs with skip/take query params', () => {
        const {service, ctrl} = setup();
        service.getAuditLog('g1', 0, 50).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/audit-log?skip=0&take=50`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('reorderRoles PATCHes the roles array', () => {
        const {service, ctrl} = setup();
        const dto = {roles: [{roleId: 'r1', position: 0}, {roleId: 'r2', position: 1}]};
        service.reorderRoles('g1', dto).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/roles/reorder`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual(dto);
        req.flush(null);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx ng test --include src/app/services/guild.service.spec.ts`
Expected: FAIL

- [ ] **Step 3: Add the methods**

```typescript
    getAuditLog(guildId: string, skip: number, take: number): Observable<AuditLogEntryDto[]> {
        return this.http.get<AuditLogEntryDto[]>(`${this.base}/guilds/${guildId}/audit-log?skip=${skip}&take=${take}`);
    }

    reorderRoles(guildId: string, dto: ReorderRolesDto): Observable<void> {
        return this.http.patch<void>(`${this.base}/guilds/${guildId}/roles/reorder`, dto);
    }
```

Add imports: `import {AuditLogEntryDto} from "../dtos/response/audit-log-entry.dto";` and `import {ReorderRolesDto} from "../dtos/request/reorder-roles.dto";`.

- [ ] **Step 4: Run to verify pass**

Run: `npx ng test --include src/app/services/guild.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/guild.service.ts src/app/services/guild.service.spec.ts
git commit -m "feat: add audit log and role reorder service methods"
```

---

### Task 9: Fix channel PATCH route and rewrite channel/category permission-overwrite routes

The existing `updateChannel` hits `PATCH /channel/{id}` (singular) - the guide specifies `PATCH /channels/{channelId}` (plural). The existing `upsertChannelPermission`/`deleteChannelPermission`/`upsertCategoryPermission`/`deleteCategoryPermission` hit a single `/channel/{channelId}/permission` route keyed by an opaque permission id - the guide specifies four distinct routes keyed by `roleId`/`memberId` directly in the URL, which is what the backend actually implements now (per the guide, this write path did not previously work at all).

**Files:**
- Modify: `src/app/services/guild.service.ts`
- Test: `src/app/services/guild.service.spec.ts`

**Interfaces:**
- Produces: `updateChannel(id, dto: UpdateChannelDto)` on the fixed route; `OverridePermissionsDto`; `upsertChannelRolePermission(channelId, roleId, dto)`, `upsertChannelMemberPermission(channelId, memberId, dto)`, `deleteChannelRolePermission(channelId, roleId)`, `deleteChannelMemberPermission(channelId, memberId)`, and the four category equivalents - consumed by Task 24 (permission editor UI), Task 23 (channel overview).
- Removes: `UpsertPermissionOverrideDto`, `upsertChannelPermission`, `deleteChannelPermission`, `upsertCategoryPermission`, `deleteCategoryPermission` (superseded).

- [ ] **Step 1: Write the failing tests**

```typescript
describe('GuildService channel/category updates and permission overwrites', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('updateChannel PATCHes the plural /channels/{id} route with the full-replace body', () => {
        const {service, ctrl} = setup();
        const dto = {name: 'general', isAgeRestricted: false, isPrivate: false, slowModeSeconds: 5};
        service.updateChannel('c1', dto).subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual(dto);
        req.flush({});
    });

    it('upsertChannelRolePermission PUTs to /channels/{channelId}/permissions/roles/{roleId}', () => {
        const {service, ctrl} = setup();
        const dto = {allowPermissions: 'ViewChannel', denyPermissions: 'None'};
        service.upsertChannelRolePermission('c1', 'r1', dto).subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/permissions/roles/r1`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual(dto);
        req.flush({});
    });

    it('upsertChannelMemberPermission PUTs to /channels/{channelId}/permissions/members/{memberId}', () => {
        const {service, ctrl} = setup();
        service.upsertChannelMemberPermission('c1', 'm1', {allowPermissions: 'None', denyPermissions: 'None'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/permissions/members/m1`);
        expect(req.request.method).toBe('PUT');
        req.flush({});
    });

    it('deleteChannelRolePermission DELETEs by roleId', () => {
        const {service, ctrl} = setup();
        service.deleteChannelRolePermission('c1', 'r1').subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/permissions/roles/r1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('deleteChannelMemberPermission DELETEs by memberId', () => {
        const {service, ctrl} = setup();
        service.deleteChannelMemberPermission('c1', 'm1').subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/permissions/members/m1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('upsertCategoryRolePermission PUTs to /categories/{categoryId}/permissions/roles/{roleId}', () => {
        const {service, ctrl} = setup();
        service.upsertCategoryRolePermission('cat1', 'r1', {allowPermissions: 'None', denyPermissions: 'None'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/categories/cat1/permissions/roles/r1`);
        expect(req.request.method).toBe('PUT');
        req.flush({});
    });

    it('deleteCategoryMemberPermission DELETEs by memberId', () => {
        const {service, ctrl} = setup();
        service.deleteCategoryMemberPermission('cat1', 'm1').subscribe();
        const req = ctrl.expectOne(`${BASE}/categories/cat1/permissions/members/m1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx ng test --include src/app/services/guild.service.spec.ts`
Expected: FAIL - old routes/methods don't match.

- [ ] **Step 3: Rewrite the channel/category sections of `guild.service.ts`**

Replace `UpsertPermissionOverrideDto` with:

```typescript
export interface OverridePermissionsDto {
    allowPermissions: string;
    denyPermissions: string;
}
```

Replace the `updateChannel` method:

```typescript
    updateChannel(id: string, dto: UpdateChannelDto): Observable<ChannelDto> {
        return this.http.patch<ChannelDto>(`${this.base}/channels/${id}`, dto);
    }
```

Replace `upsertChannelPermission`/`deleteChannelPermission` with:

```typescript
    upsertChannelRolePermission(channelId: string, roleId: string, dto: OverridePermissionsDto): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(`${this.base}/channels/${channelId}/permissions/roles/${roleId}`, dto);
    }

    upsertChannelMemberPermission(channelId: string, memberId: string, dto: OverridePermissionsDto): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(`${this.base}/channels/${channelId}/permissions/members/${memberId}`, dto);
    }

    deleteChannelRolePermission(channelId: string, roleId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/channels/${channelId}/permissions/roles/${roleId}`);
    }

    deleteChannelMemberPermission(channelId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/channels/${channelId}/permissions/members/${memberId}`);
    }
```

Replace `upsertCategoryPermission`/`deleteCategoryPermission` with:

```typescript
    upsertCategoryRolePermission(categoryId: string, roleId: string, dto: OverridePermissionsDto): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(`${this.base}/categories/${categoryId}/permissions/roles/${roleId}`, dto);
    }

    upsertCategoryMemberPermission(categoryId: string, memberId: string, dto: OverridePermissionsDto): Observable<ChannelPermission> {
        return this.http.put<ChannelPermission>(`${this.base}/categories/${categoryId}/permissions/members/${memberId}`, dto);
    }

    deleteCategoryRolePermission(categoryId: string, roleId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/categories/${categoryId}/permissions/roles/${roleId}`);
    }

    deleteCategoryMemberPermission(categoryId: string, memberId: string): Observable<void> {
        return this.http.delete<void>(`${this.base}/categories/${categoryId}/permissions/members/${memberId}`);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx ng test --include src/app/services/guild.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/guild.service.ts src/app/services/guild.service.spec.ts
git commit -m "fix: correct channel PATCH route; rewrite permission overwrite routes to role/member-id-keyed shape"
```

(This intentionally breaks `channel-overview.component.ts`, `channel-permissions.component.ts`, and `category-permissions.component.ts` at compile time - they're fixed in Task 19 and Task 20 later in this same plan. Do not run a full `ng build` as a gate on this task; the per-file test above is the correct verification unit.)

---

### Task 10: Add thread endpoints and invite-by-code lookup

**Files:**
- Modify: `src/app/services/guild.service.ts`
- Test: `src/app/services/guild.service.spec.ts`

**Interfaces:**
- Consumes: `CreateThreadDto` (Task 3).
- Produces: `createThread(channelId, dto): Observable<ChannelDto>`, `getThreads(channelId): Observable<ChannelDto[]>`, `archiveThread(threadId): Observable<void>`, `getInviteByCode(code): Observable<InviteDto>` - consumed by Task 25 (threads UI), Task 26 (invites UI).

- [ ] **Step 1: Write the failing tests**

```typescript
describe('GuildService threads and invite-by-code', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('createThread POSTs to /channels/{channelId}/threads', () => {
        const {service, ctrl} = setup();
        service.createThread('c1', {name: 'bug-123'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/threads`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({name: 'bug-123'});
        req.flush({});
    });

    it('getThreads GETs /channels/{channelId}/threads', () => {
        const {service, ctrl} = setup();
        service.getThreads('c1').subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/threads`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('archiveThread PATCHes /threads/{threadId}/archive', () => {
        const {service, ctrl} = setup();
        service.archiveThread('t1').subscribe();
        const req = ctrl.expectOne(`${BASE}/threads/t1/archive`);
        expect(req.request.method).toBe('PATCH');
        req.flush(null);
    });

    it('getInviteByCode GETs /invites/code/{code}', () => {
        const {service, ctrl} = setup();
        service.getInviteByCode('ab12cd34').subscribe();
        const req = ctrl.expectOne(`${BASE}/invites/code/ab12cd34`);
        expect(req.request.method).toBe('GET');
        req.flush({});
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx ng test --include src/app/services/guild.service.spec.ts`
Expected: FAIL

- [ ] **Step 3: Add the methods**

```typescript
    createThread(channelId: string, dto: CreateThreadDto): Observable<ChannelDto> {
        return this.http.post<ChannelDto>(`${this.base}/channels/${channelId}/threads`, dto);
    }

    getThreads(channelId: string): Observable<ChannelDto[]> {
        return this.http.get<ChannelDto[]>(`${this.base}/channels/${channelId}/threads`);
    }

    archiveThread(threadId: string): Observable<void> {
        return this.http.patch<void>(`${this.base}/threads/${threadId}/archive`, {});
    }

    getInviteByCode(code: string): Observable<InviteDto> {
        return this.http.get<InviteDto>(`${this.base}/invites/code/${code}`);
    }
```

Add import: `import {CreateThreadDto} from "../dtos/request/create-thread.dto";`

- [ ] **Step 4: Run to verify pass**

Run: `npx ng test --include src/app/services/guild.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/services/guild.service.ts src/app/services/guild.service.spec.ts
git commit -m "feat: add thread endpoints and invite-by-code lookup"
```

---

## Part 3 - SignalR wiring

### Task 11: Guild moderation SignalR events (bans, kicks, mutes, member-left, guild deleted/updated)

**Files:**
- Modify: `src/app/services/guild-websocket.service.ts`

**Interfaces:**
- Consumes: `RealtimeConnectionService.on` (existing).
- Produces: `memberBannedObservable: Subject<WsMemberBanned>`, `memberKickedObservable: Subject<WsMemberKicked>`, `memberMutedObservable: Subject<WsMemberMuted>`, `memberUnmutedObservable: Subject<WsMemberUnmuted>`, `memberLeftObservable: Subject<WsMemberLeft>`, `guildDeletedObservable: Subject<WsGuildDeleted>`, `guildUpdatedObservable: Subject<WsGuildUpdated>` - consumed by Task 18 (member list live updates), Task 19 (bans tab), Task 21 (guild delete/update propagation).

- [ ] **Step 1: Add the event payload interfaces**

In `src/app/services/guild-websocket.service.ts`, add near the other `Ws*` interfaces:

```typescript
export interface WsMemberBanned {
    guildId: string;
    userId: string;
    reason?: string;
}

export interface WsMemberKicked {
    guildId: string;
    userId: string;
}

export interface WsMemberMuted {
    guildId: string;
    userId: string;
    mutedUntil: string;
}

export interface WsMemberUnmuted {
    guildId: string;
    userId: string;
}

export interface WsMemberLeft {
    guildId: string;
    userId: string;
}

export interface WsGuildDeleted {
    guildId: string;
}

export interface WsGuildUpdated {
    guildId: string;
}
```

- [ ] **Step 2: Add the Subjects to the class**

```typescript
    public memberBannedObservable = new Subject<WsMemberBanned>();
    public memberKickedObservable = new Subject<WsMemberKicked>();
    public memberMutedObservable = new Subject<WsMemberMuted>();
    public memberUnmutedObservable = new Subject<WsMemberUnmuted>();
    public memberLeftObservable = new Subject<WsMemberLeft>();
    public guildDeletedObservable = new Subject<WsGuildDeleted>();
    public guildUpdatedObservable = new Subject<WsGuildUpdated>();
```

- [ ] **Step 3: Register the handlers in `setupListeners()`**

Add alongside the existing `guild.ChannelCreated`/`guild.ChannelDeleted` registrations:

```typescript
        this.realtime.on('guild.MemberBanned', (d: WsMemberBanned) => this.memberBannedObservable.next(d));
        this.realtime.on('guild.MemberKicked', (d: WsMemberKicked) => this.memberKickedObservable.next(d));
        this.realtime.on('guild.MemberMuted', (d: WsMemberMuted) => this.memberMutedObservable.next(d));
        this.realtime.on('guild.MemberUnmuted', (d: WsMemberUnmuted) => this.memberUnmutedObservable.next(d));
        this.realtime.on('guild.MemberLeft', (d: WsMemberLeft) => this.memberLeftObservable.next(d));
        this.realtime.on('guild.GuildDeleted', (d: WsGuildDeleted) => this.guildDeletedObservable.next(d));
        this.realtime.on('guild.GuildUpdated', (d: WsGuildUpdated) => this.guildUpdatedObservable.next(d));
```

- [ ] **Step 4: Verify build**

Run: `npx ng build --configuration development`
Expected: succeeds - this task only adds new, unused-so-far exports.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/guild-websocket.service.ts
git commit -m "feat: register guild moderation SignalR events (ban/kick/mute/leave/guild delete/update)"
```

---

### Task 12: Guild role/channel/thread SignalR events

**Files:**
- Modify: `src/app/services/guild-websocket.service.ts`

**Interfaces:**
- Produces: `rolesReorderedObservable: Subject<ReorderRolesDto>`, `channelUpdatedObservable: Subject<WsChannelUpdated>`, `threadCreatedObservable: Subject<WsThreadCreated>` - consumed by Task 22 (roles UI), Task 23 (channel list live update), Task 25 (threads UI).

- [ ] **Step 1: Add payload interfaces and Subjects**

```typescript
export interface WsChannelUpdated {
    channelId: string;
    guildId: string;
}

export interface WsThreadCreated {
    channelId: string;
    parentChannelId: string;
    guildId: string;
}
```

```typescript
    public rolesReorderedObservable = new Subject<ReorderRolesDto>();
    public channelUpdatedObservable = new Subject<WsChannelUpdated>();
    public threadCreatedObservable = new Subject<WsThreadCreated>();
```

Add the import: `import {ReorderRolesDto} from "../dtos/request/reorder-roles.dto";`

- [ ] **Step 2: Register the handlers**

```typescript
        this.realtime.on('guild.RolesReordered', (d: ReorderRolesDto) => this.rolesReorderedObservable.next(d));
        this.realtime.on('guild.ChannelUpdated', (d: WsChannelUpdated) => this.channelUpdatedObservable.next(d));
        this.realtime.on('guild.ThreadCreated', (d: WsThreadCreated) => this.threadCreatedObservable.next(d));
```

- [ ] **Step 3: Verify build**

Run: `npx ng build --configuration development`
Expected: succeeds

- [ ] **Step 4: Commit**

```bash
git add src/app/services/guild-websocket.service.ts
git commit -m "feat: register guild role-reorder, channel-updated, and thread-created SignalR events"
```

---

### Task 13: Presence - `guild.PresenceChanged` push and self-status REST call

**Files:**
- Modify: `src/app/services/guild-websocket.service.ts` (the new event is `guild.*`-prefixed per the guide, so it belongs here, not in `messaging-websocket.service.ts`)
- Modify: `src/app/services/profile.service.ts`
- Test: `src/app/services/profile.service.spec.ts` (new file)

**Interfaces:**
- Produces: `GuildWebsocketService.presenceChangedObservable: Subject<WsPresenceChanged>`; `ProfileService.setSelfStatus(status: OnlineStatus): Observable<ProfileDto>` - consumed by Task 18 (guild member list live status), Task 28 (status picker UI).

- [ ] **Step 1: Write the failing test for `setSelfStatus`**

```typescript
// src/app/services/profile.service.spec.ts
import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {ProfileService} from './profile.service';
import {ApiConfigService} from './api-config.service';
import {OnlineStatus} from '../dtos/response/profile.dto';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(ProfileService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('ProfileService.setSelfStatus', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('PATCHes /api/v1/social/profiles/me/status with the status', () => {
        const {service, ctrl} = setup();
        service.setSelfStatus(OnlineStatus.Idle).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me/status');
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({status: 'Idle'});
        req.flush({onlineStatus: 'Idle'});
    });

    it('updates ownProfile signal on success', () => {
        const {service, ctrl} = setup();
        service['ownProfile'].set({
            id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.Online,
        });
        service.setSelfStatus(OnlineStatus.DoNotDisturb).subscribe();
        const req = ctrl.expectOne('https://api.test.example/api/v1/social/profiles/me/status');
        req.flush({
            id: 'p1', userId: 'u1', userName: 'me', bio: undefined, avatarUrl: undefined,
            createdAt: new Date(), updatedAt: new Date(), onlineStatus: OnlineStatus.DoNotDisturb,
        });
        expect(service.ownProfile()?.onlineStatus).toBe(OnlineStatus.DoNotDisturb);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx ng test --include src/app/services/profile.service.spec.ts`
Expected: FAIL - `setSelfStatus` doesn't exist.

- [ ] **Step 3: Add `setSelfStatus` to `ProfileService`**

```typescript
    public setSelfStatus(status: OnlineStatus): Observable<ProfileDto> {
        return this.httpClient
            .patch<ProfileDto>(`${this.apiConfig.baseUrl()}/api/v1/social/profiles/me/status`, {status})
            .pipe(tap(p => {
                this.ownProfile.set(p);
                this.store(p);
            }));
    }
```

Place it next to `getSelf()` (same "Own profile" region).

- [ ] **Step 4: Run to verify pass**

Run: `npx ng test --include src/app/services/profile.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Add the `guild.PresenceChanged` SignalR event to `GuildWebsocketService`**

Add the payload interface:

```typescript
export interface WsPresenceChanged {
    userId: string;
    guildId: string;
    status: OnlineStatus;
}
```

Add `import {OnlineStatus} from "../dtos/response/profile.dto";` at the top (the file already imports `ProfileService` from the same path's sibling, so this import is new but consistent).

Add the Subject:

```typescript
    public presenceChangedObservable = new Subject<WsPresenceChanged>();
```

Register the handler - also update the cross-app profile cache so DM/friends lists reflect it too:

```typescript
        this.realtime.on('guild.PresenceChanged', (d: WsPresenceChanged) => {
            this.presenceChangedObservable.next(d);
            this.profileService.setOnlineStatus(d.userId, d.status);
        });
```

(`this.profileService` is already injected in this class.)

- [ ] **Step 6: Verify build**

Run: `npx ng build --configuration development`
Expected: succeeds

- [ ] **Step 7: Commit**

```bash
git add src/app/services/profile.service.ts src/app/services/profile.service.spec.ts src/app/services/guild-websocket.service.ts
git commit -m "feat: add self-status REST call and guild.PresenceChanged live push"
```

---

## Part 4 - Moderation UI

### Task 14: Member list interactivity - kick/ban/mute context menu with hierarchy gating

`GuildMemberListComponent` currently renders a flat read-only list. This task adds a right-click context menu (matching the `channel-list.component.ts` `Menu`/`ContextMenu` pattern) with Kick/Ban/Timeout actions gated by `KickMembers`/`BanMembers`/`ModerateMembers` and role-hierarchy (client-side best-effort mirror of the server's rule: can't act on a member whose highest role position is ≥ the acting member's highest role position, and nobody can act on the guild owner).

**Files:**
- Modify: `src/app/features/guild/components/guild-member-list/guild-member-list.component.ts`
- Modify: `src/app/features/guild/components/guild-member-list/guild-member-list.component.html`
- Modify: `src/app/dtos/response/member.dto.ts` (need each member's role IDs to compute hierarchy - add `roleIds: string[]` sourced from `GuildMemberDto`... see Step 1 note)
- Modify: `src/assets/i18n/locales/en.json`

**Interfaces:**
- Consumes: `GuildService.kickMember/banMember/muteMember/unmuteMember`, `Permissions.KickMembers/BanMembers/ModerateMembers`, `hasPermission`/`parsePermissions`, `GuildWebsocketService.memberBannedObservable/memberKickedObservable/memberMutedObservable/memberUnmutedObservable/memberLeftObservable/presenceChangedObservable`.
- Produces: nothing new for other tasks (leaf UI feature).

- [ ] **Step 1: Confirm role-hierarchy data is available and add a `RoleMemberDto`-based lookup**

`GuildMemberDto` does not carry role IDs directly, but `GuildDto.roles: RoleDto[]` each has `userId` (per the existing, slightly odd shape noted in research - `RoleDto.userId` is populated per-assignment, not per-role-definition... actually re-check: `roleNamesFor` in `members-settings.component.ts` does `this.guild().roles.filter(r => r.userId === member.userId)`, meaning the guild's `roles` array, as returned embedded in `GuildDto`, contains **role-assignment rows** shaped like `RoleDto` with `userId` set to the assignee - i.e. one entry per (role × member) pairing, not one entry per distinct role. Use this exact pattern (already proven correct by the existing `members-settings.component.ts` code) rather than inventing a new field.

Add a small pure helper to compute a member's highest role position, colocated in the component since it's only used here:

```typescript
    private highestRolePosition(member: GuildMemberDto): number {
        const myRoles = this.guild().roles.filter(r => r.userId === member.userId);
        if (myRoles.length === 0) return -1;
        return Math.max(...myRoles.map(r => r.position));
    }
```

- [ ] **Step 2: Add context-menu state, permission/hierarchy computation, and action methods to the component**

```typescript
import {Component, computed, DestroyRef, inject, input, OnChanges, signal, SimpleChanges, ViewChild} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {GuildDto} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto, SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../services/guild.service';
import {environment} from '../../../../../environments/environment';
import {TranslateModule} from '@ngx-translate/core';
import {Menu} from 'primeng/menu';
import {MenuItem} from 'primeng/api';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
import {ToastService} from '../../../../services/toast.service';
import {
    GuildWebsocketService,
    WsMemberBanned,
    WsMemberKicked,
    WsMemberLeft,
    WsMemberMuted,
    WsMemberUnmuted,
    WsPresenceChanged,
} from '../../../../services/guild-websocket.service';

@Component({
    selector: 'app-guild-member-list',
    imports: [TranslateModule, Menu],
    templateUrl: './guild-member-list.component.html',
})
export class GuildMemberListComponent implements OnChanges {
    guild = input.required<GuildDto>();
    rows = signal<GuildMemberDto[]>([]);
    loading = signal(true);
    loadingMore = signal(false);
    hasMore = signal(true);
    onlineRows = computed(() => this.rows().filter(m => m.status === OnlineStatus.Online));
    offlineRows = computed(() => this.rows().filter(m => m.status !== OnlineStatus.Online));
    @ViewChild('memberMenu') memberMenu!: Menu;
    protected contextMember = signal<GuildMemberDto | null>(null);
    private ownMember = signal<SelfGuildMemberDto | null>(null);
    private guildService = inject(GuildService);
    private guildWsService = inject(GuildWebsocketService);
    private toastService = inject(ToastService);
    private destroyRef = inject(DestroyRef);
    private readonly TAKE = 50;
    private nextSkip = 0;

    constructor() {
        this.guildWsService.memberBannedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberBanned) => this.removeIfCurrentGuild(e.guildId, e.userId));
        this.guildWsService.memberKickedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberKicked) => this.removeIfCurrentGuild(e.guildId, e.userId));
        this.guildWsService.memberLeftObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberLeft) => this.removeIfCurrentGuild(e.guildId, e.userId));
        this.guildWsService.memberMutedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberMuted) => this.notifyOwnMuteState(e.guildId, e.userId, e.mutedUntil));
        this.guildWsService.memberUnmutedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsMemberUnmuted) => this.notifyOwnMuteState(e.guildId, e.userId, null));
        this.guildWsService.presenceChangedObservable.pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsPresenceChanged) => {
                if (e.guildId !== this.guild().id) return;
                this.rows.update(list => list.map(m => m.userId === e.userId ? {...m, status: e.status} : m));
            });
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['guild']) {
            this.reset();
            this.fetchPage(this.guild().id);
            this.guildService.getOwnMember(this.guild().id).subscribe(m => this.ownMember.set(m));
        }
    }
    // ... existing loadMore/onScroll/displayName/avatarUrl/reset/fetchPage unchanged ...

    protected canModerate(member: GuildMemberDto): boolean {
        if (member.userId === this.guild().ownerId) return false;
        const own = this.ownMember();
        if (!own || own.userId === member.userId) return false;
        const ownPos = this.highestRolePosition({...member, userId: own.userId});
        const targetPos = this.highestRolePosition(member);
        return targetPos < ownPos;
    }

    protected onMemberContextMenu(event: MouseEvent, member: GuildMemberDto): void {
        event.preventDefault();
        this.contextMember.set(member);
        this.memberMenu.model = this.buildMemberMenuItems(member);
        this.memberMenu.show(event);
    }

    private buildMemberMenuItems(member: GuildMemberDto): MenuItem[] {
        const own = this.ownMember();
        const perms = own ? parsePermissions(own.roleMembers.reduce((c, m) => m.role.permissions ? (c === '' ? m.role.permissions : `${c},${m.role.permissions}`) : c, own.permissions ?? '')) : 0n;
        const items: MenuItem[] = [];
        const canAct = this.canModerate(member);

        if (canAct && hasPermission(perms, Permissions.KickMembers)) {
            items.push({label: 'Kick', icon: 'pi pi-user-minus', command: () => this.kick(member)});
        }
        if (canAct && hasPermission(perms, Permissions.ModerateMembers)) {
            items.push({label: 'Timeout for 10 minutes', icon: 'pi pi-clock', command: () => this.mute(member, 10)});
        }
        if (canAct && hasPermission(perms, Permissions.BanMembers)) {
            items.push({label: 'Ban', icon: 'pi pi-ban', styleClass: 'text-rose-400', command: () => this.ban(member)});
        }
        if (items.length === 0) {
            items.push({label: 'No actions available', disabled: true});
        }
        return items;
    }

    private kick(member: GuildMemberDto): void {
        this.guildService.kickMember(this.guild().id, member.id).subscribe({
            next: () => this.rows.update(list => list.filter(m => m.id !== member.id)),
            error: err => this.toastService.httpError('Failed to kick member', err),
        });
    }

    private ban(member: GuildMemberDto): void {
        this.guildService.banMember(this.guild().id, {userId: member.userId}).subscribe({
            next: () => this.rows.update(list => list.filter(m => m.id !== member.id)),
            error: err => this.toastService.httpError('Failed to ban member', err),
        });
    }

    private mute(member: GuildMemberDto, minutes: number): void {
        this.guildService.muteMember(this.guild().id, member.id, minutes).subscribe({
            next: () => this.toastService.success(`Muted for ${minutes} minutes`),
            error: err => this.toastService.httpError('Failed to mute member', err),
        });
    }

    private removeIfCurrentGuild(guildId: string, userId: string): void {
        if (guildId !== this.guild().id) return;
        this.rows.update(list => list.filter(m => m.userId !== userId));
    }

    private notifyOwnMuteState(guildId: string, userId: string, mutedUntil: string | null): void {
        if (guildId !== this.guild().id) return;
        const ownUserId = this.ownMember()?.userId;
        if (userId !== ownUserId) return;
        this.toastService.info(mutedUntil ? `You have been muted until ${new Date(mutedUntil).toLocaleTimeString()}` : 'Your timeout has been lifted');
    }

    private highestRolePosition(member: GuildMemberDto): number {
        const myRoles = this.guild().roles.filter(r => r.userId === member.userId);
        if (myRoles.length === 0) return -1;
        return Math.max(...myRoles.map(r => r.position));
    }
}
```

Keep the pre-existing `loadMore`, `onScroll`, `displayName`, `avatarUrl`, `reset`, `fetchPage` methods exactly as they are - only insert the additions above.

- [ ] **Step 3: Add the `p-menu` and context menu binding to the template**

In `guild-member-list.component.html`, add near the top (as a sibling of the list, per the `channel-list.component.html` pattern):

```html
<p-menu #memberMenu [popup]="true" appendTo="body"/>
```

Add `(contextmenu)="onMemberContextMenu($event, member)"` to the row element that iterates `onlineRows()`/`offlineRows()` (locate the existing `@for` row markup and add the binding to its outer `<div>`/`<li>` - do not otherwise restructure the template).

- [ ] **Step 4: Add i18n keys used above** (this task uses plain English strings inline rather than `| translate` to keep the diff focused - codebase precedent for quick MenuItem labels is mixed; `channel-list.component.ts`'s `guildMenuItems` also uses inline English `label:` strings, so this matches existing convention for `MenuItem[]` arrays specifically, as opposed to template-bound `p-button` labels which do use `| translate`.)

No `en.json` changes needed for this task.

- [ ] **Step 5: Manual verification**

Run: `npx ng serve`, open a guild you own (or have `KickMembers`/`BanMembers`/`ModerateMembers` in), right-click another member in the member list sidebar, confirm the context menu shows Kick/Timeout/Ban and each action round-trips against the backend (or a mocked backend) without throwing. Confirm a member you can't outrank (e.g. the guild owner) shows no actionable items.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/components/guild-member-list/guild-member-list.component.ts src/app/features/guild/components/guild-member-list/guild-member-list.component.html
git commit -m "feat: add kick/ban/timeout context menu to guild member list with hierarchy gating"
```

---

### Task 15: Bans settings tab

**Files:**
- Create: `src/app/features/guild/components/guild-settings-modal/pages/bans-settings/bans-settings.component.ts`
- Create: `src/app/features/guild/components/guild-settings-modal/pages/bans-settings/bans-settings.component.html`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html`
- Modify: `src/assets/i18n/locales/en.json`

**Interfaces:**
- Consumes: `GuildService.getBans/banMember/unbanMember`, `ProfileService.fetchByUserId` (existing profile-resolution pattern from `members-settings.component.ts`).

- [ ] **Step 1: Create the component**

```typescript
// bans-settings.component.ts
import {Component, inject, input, OnInit, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {BanDto} from '../../../../../../dtos/response/ban.dto';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {TranslateModule} from '@ngx-translate/core';

interface BanRow {
    ban: BanDto;
    profile: ProfileDto | null;
}

@Component({
    selector: 'app-bans-settings',
    imports: [FormsModule, Button, InputText, Dialog, TranslateModule],
    templateUrl: './bans-settings.component.html',
})
export class BansSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    bans = signal<BanRow[]>([]);
    loading = signal(true);
    unbanningId = signal<string | null>(null);
    showBanDialog = signal(false);
    banUserId = signal('');
    banReason = signal('');
    banning = signal(false);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toastService = inject(ToastService);

    ngOnInit(): void {
        this.load();
    }

    load(): void {
        this.loading.set(true);
        this.guildService.getBans(this.guild().id).subscribe({
            next: bans => {
                const rows: BanRow[] = bans.map(ban => ({ban, profile: null}));
                this.bans.set(rows);
                this.loading.set(false);
                rows.forEach((row, i) => {
                    this.profileService.fetchByUserId(row.ban.userId).subscribe({
                        next: p => this.bans.update(list => {
                            const next = [...list];
                            next[i] = {...next[i], profile: p};
                            return next;
                        }),
                    });
                });
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError('Failed to load bans', err);
            },
        });
    }

    displayName(row: BanRow): string {
        return row.profile?.userName ?? row.ban.userId.slice(0, 8) + '…';
    }

    openBanDialog(): void {
        this.banUserId.set('');
        this.banReason.set('');
        this.showBanDialog.set(true);
    }

    submitBan(): void {
        const userId = this.banUserId().trim();
        if (!userId || this.banning()) return;
        this.banning.set(true);
        this.guildService.banMember(this.guild().id, {userId, reason: this.banReason().trim() || undefined}).subscribe({
            next: () => {
                this.showBanDialog.set(false);
                this.banning.set(false);
                this.load();
            },
            error: err => {
                this.banning.set(false);
                this.toastService.httpError('Failed to ban user', err);
            },
        });
    }

    unban(row: BanRow): void {
        if (this.unbanningId()) return;
        this.unbanningId.set(row.ban.id);
        this.guildService.unbanMember(this.guild().id, row.ban.userId).subscribe({
            next: () => {
                this.bans.update(list => list.filter(r => r.ban.id !== row.ban.id));
                this.unbanningId.set(null);
            },
            error: err => {
                this.unbanningId.set(null);
                this.toastService.httpError('Failed to unban user', err);
            },
        });
    }
}
```

- [ ] **Step 2: Create the template**

```html
<!-- bans-settings.component.html -->
<div class="flex items-center justify-between mb-4">
    <p class="text-xs text-white/40">{{ bans().length }} banned {{ bans().length === 1 ? 'user' : 'users' }}</p>
    <p-button (onClick)="openBanDialog()" icon="pi pi-plus" label="Ban User" severity="danger" size="small"/>
</div>

@if (loading()) {
    <p class="text-sm text-white/25 text-center py-6">Loading…</p>
} @else if (bans().length === 0) {
    <p class="text-sm text-white/25 text-center py-6">No banned users</p>
} @else {
    <div class="flex flex-col gap-1">
        @for (row of bans(); track row.ban.id) {
            <div class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.03]">
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-white/85 truncate">{{ displayName(row) }}</p>
                    @if (row.ban.reason) {
                        <p class="text-[11px] text-white/35 truncate">{{ row.ban.reason }}</p>
                    }
                </div>
                <p-button (onClick)="unban(row)" [loading]="unbanningId() === row.ban.id" label="Unban"
                          severity="secondary" size="small" [text]="true"/>
            </div>
        }
    </div>
}

<p-dialog [(visible)]="showBanDialog" [draggable]="false" [modal]="true" [resizable]="false"
          [style]="{width: '420px'}" appendTo="body">
    <ng-template pTemplate="header">
        <span class="text-sm font-semibold text-white/85">Ban User</span>
    </ng-template>
    <div class="flex flex-col gap-3 py-2">
        <input [(ngModel)]="banUserId" pInputText placeholder="User ID" type="text"/>
        <input [(ngModel)]="banReason" pInputText placeholder="Reason (optional)" type="text"/>
    </div>
    <ng-template pTemplate="footer">
        <p-button (onClick)="showBanDialog.set(false)" [text]="true" label="Cancel"/>
        <p-button (onClick)="submitBan()" [loading]="banning()" label="Ban" severity="danger"/>
    </ng-template>
</p-dialog>
```

Note: `ban by user ID` is a plain text field because there is no existing member-search-by-ID-entry widget to reuse cheaply and the guide doesn't require anything richer; this matches the scope of `members-settings.component.ts`'s existing kick flow (acts on an already-fetched member row) - banning a user who has already left/was never in the visible member list is the actual reason a bans tab needs a raw-ID entry point at all.

- [ ] **Step 3: Wire the new tab into the settings modal**

In `guild-settings-modal.component.ts`, import `BansSettingsComponent`, add it to `imports`, and add a nav item:

```typescript
    navGroups: NavGroup[] = [
        {
            title: 'Server Settings',
            items: [
                {id: 'overview', label: 'Overview', icon: 'pi pi-home'},
                {id: 'members', label: 'Members', icon: 'pi pi-users'},
                {id: 'roles', label: 'Roles', icon: 'pi pi-shield'},
                {id: 'bans', label: 'Bans', icon: 'pi pi-ban'},
            ],
        },
        {
            title: 'Community',
            items: [
                {id: 'invites', label: 'Invites', icon: 'pi pi-link'},
            ],
        },
    ];
```

In `guild-settings-modal.component.html`, add a case:

```html
                    @case ('bans') {
                        <app-bans-settings [guild]="guild()"/>
                    }
```

- [ ] **Step 4: Manual verification**

Run: `npx ng serve`, open Server Settings → Bans, confirm the list loads, banning by user ID and unbanning both round-trip.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/pages/bans-settings src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html
git commit -m "feat: add Bans settings tab"
```

---

### Task 16: Audit log settings tab

**Files:**
- Create: `src/app/features/guild/components/guild-settings-modal/pages/audit-log-settings/audit-log-settings.component.ts`
- Create: `src/app/features/guild/components/guild-settings-modal/pages/audit-log-settings/audit-log-settings.component.html`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html`

**Interfaces:**
- Consumes: `GuildService.getAuditLog`, `AuditLogEntryDto`, `ProfileService.fetchByUserId`.

- [ ] **Step 1: Create the component**

```typescript
// audit-log-settings.component.ts
import {Component, inject, input, OnInit, signal} from '@angular/core';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {AuditLogEntryDto} from '../../../../../../dtos/response/audit-log-entry.dto';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {Button} from 'primeng/button';

interface AuditRow {
    entry: AuditLogEntryDto;
    actorProfile: ProfileDto | null;
    metadata: Record<string, unknown> | null;
}

@Component({
    selector: 'app-audit-log-settings',
    imports: [Button],
    templateUrl: './audit-log-settings.component.html',
})
export class AuditLogSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    rows = signal<AuditRow[]>([]);
    loading = signal(true);
    loadingMore = signal(false);
    hasMore = signal(true);
    private readonly TAKE = 50;
    private nextSkip = 0;
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toastService = inject(ToastService);

    ngOnInit(): void {
        this.load();
    }

    load(): void {
        this.loading.set(true);
        this.nextSkip = 0;
        this.hasMore.set(true);
        this.rows.set([]);
        this.fetchPage();
    }

    loadMore(): void {
        if (this.loadingMore() || !this.hasMore() || this.loading()) return;
        this.loadingMore.set(true);
        this.fetchPage();
    }

    onScroll(event: Event): void {
        const el = event.target as HTMLElement;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) this.loadMore();
    }

    actorName(row: AuditRow): string {
        return row.actorProfile?.userName ?? row.entry.actorUserId.slice(0, 8) + '…';
    }

    describe(entry: AuditLogEntryDto): string {
        const map: Record<string, string> = {
            MemberBanned: 'banned a member', MemberUnbanned: 'unbanned a member',
            MemberKicked: 'kicked a member', MemberMuted: 'timed out a member',
            MemberUnmuted: 'removed a timeout', MemberLeft: 'left the server',
            RoleCreated: 'created a role', RoleUpdated: 'updated a role', RoleDeleted: 'deleted a role',
            RolePositionsChanged: 'reordered roles',
            ChannelCreated: 'created a channel', ChannelDeleted: 'deleted a channel',
            ChannelUpdated: 'updated a channel', ChannelPermissionChanged: 'changed channel permissions',
            CategoryCreated: 'created a category', CategoryDeleted: 'deleted a category',
            GuildUpdated: 'updated server settings', GuildDeleted: 'deleted the server',
            InviteCreated: 'created an invite', InviteDeleted: 'deleted an invite',
        };
        return map[entry.actionType] ?? entry.actionType;
    }

    private fetchPage(): void {
        const skip = this.nextSkip;
        this.guildService.getAuditLog(this.guild().id, skip, this.TAKE).subscribe({
            next: entries => {
                const rows: AuditRow[] = entries.map(entry => ({
                    entry,
                    actorProfile: null,
                    metadata: this.parseMetadata(entry.metadata),
                }));
                if (skip === 0) {
                    this.rows.set(rows);
                    this.loading.set(false);
                } else {
                    this.rows.update(list => [...list, ...rows]);
                    this.loadingMore.set(false);
                }
                this.nextSkip = skip + entries.length;
                if (entries.length < this.TAKE) this.hasMore.set(false);

                const baseIdx = skip === 0 ? 0 : this.rows().length - rows.length;
                rows.forEach((row, i) => {
                    this.profileService.fetchByUserId(row.entry.actorUserId).subscribe({
                        next: p => this.rows.update(list => {
                            const next = [...list];
                            const idx = baseIdx + i;
                            if (next[idx]) next[idx] = {...next[idx], actorProfile: p};
                            return next;
                        }),
                    });
                });
            },
            error: err => {
                this.loading.set(false);
                this.loadingMore.set(false);
                this.toastService.httpError('Failed to load audit log', err);
            },
        });
    }

    private parseMetadata(raw: string | null): Record<string, unknown> | null {
        if (!raw) return null;
        try {
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return null;
        }
    }
}
```

- [ ] **Step 2: Create the template**

```html
<!-- audit-log-settings.component.html -->
<div (scroll)="onScroll($event)" class="flex flex-col gap-1 max-h-full overflow-y-auto">
    @if (loading()) {
        <p class="text-sm text-white/25 text-center py-6">Loading…</p>
    } @else if (rows().length === 0) {
        <p class="text-sm text-white/25 text-center py-6">No audit log entries yet</p>
    } @else {
        @for (row of rows(); track row.entry.id) {
            <div class="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.03]">
                <div class="flex-1 min-w-0">
                    <p class="text-sm text-white/80">
                        <span class="font-medium">{{ actorName(row) }}</span> {{ describe(row.entry) }}
                    </p>
                    <p class="text-[11px] text-white/30">{{ row.entry.createdAt | date:'medium' }}</p>
                </div>
            </div>
        }
        @if (loadingMore()) {
            <p class="text-xs text-white/25 text-center py-3">Loading more…</p>
        }
    }
</div>
```

Note: `| date` requires `CommonModule`/`DatePipe` - add `DatePipe` to the component's `imports` array (`import {DatePipe} from '@angular/common';`) since this template uses it and no other page in this feature currently needs it.

- [ ] **Step 3: Wire the tab in, gated by `ViewAuditLog`**

In `guild-settings-modal.component.ts`, add `{id: 'audit-log', label: 'Audit Log', icon: 'pi pi-history'}` to the `Server Settings` group's `items`, and add the case in the HTML:

```html
                    @case ('audit-log') {
                        <app-audit-log-settings [guild]="guild()"/>
                    }
```

This plan does not add hide-if-no-permission logic to the settings modal's nav (none of the existing tabs do this either - `MembersSettingsComponent`'s kick button and edit-permissions button are always rendered regardless of the viewer's own permissions, relying on the server's 403 as the actual gate). Follow that precedent: show the tab to everyone, let a `403` from `getAuditLog` surface via `ToastService.httpError` as today.

- [ ] **Step 4: Manual verification**

Run: `npx ng serve`, open Server Settings → Audit Log with a user that has `ViewAuditLog`, confirm entries render with resolved actor names and pagination via scroll works.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/pages/audit-log-settings src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html
git commit -m "feat: add Audit Log settings tab"
```

---

### Task 17: Wire real delete-guild UI and propagate GuildDeleted/GuildUpdated pushes

**Files:**
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/overview-settings/overview-settings.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/overview-settings/overview-settings.component.html`
- Modify: `src/app/features/guild/components/server-taskbar/server-taskbar.component.ts`

**Interfaces:**
- Consumes: `GuildService.deleteGuild` (already existed, was dead code - now has real effect per the guide), `GuildWebsocketService.guildDeletedObservable/guildUpdatedObservable`.

- [ ] **Step 1: Add a guarded delete-server action to overview settings**

In `overview-settings.component.ts`, add:

```typescript
    showDeleteDialog = signal(false);
    deleting = signal(false);
    guildDeleted = output<string>();
```

```typescript
    deleteGuild(): void {
        if (this.deleting()) return;
        this.deleting.set(true);
        this.guildService.deleteGuild(this.guild().id).subscribe({
            next: () => {
                this.guildDeleted.emit(this.guild().id);
                this.showDeleteDialog.set(false);
                this.deleting.set(false);
            },
            error: () => this.deleting.set(false),
        });
    }
```

- [ ] **Step 2: Add the danger-zone UI to the template**

Append to `overview-settings.component.html`, after the existing save/reset buttons block:

```html
<div class="mt-8 pt-6 border-t border-white/[0.08]">
    <p class="text-xs font-semibold text-rose-400 uppercase tracking-widest mb-2">Danger Zone</p>
    <p-button (onClick)="showDeleteDialog.set(true)" icon="pi pi-trash" label="Delete Server" severity="danger" size="small"/>
</div>

<p-dialog [(visible)]="showDeleteDialog" [draggable]="false" [modal]="true" [resizable]="false"
          [style]="{width: '420px'}" appendTo="body">
    <ng-template pTemplate="header">
        <span class="text-sm font-semibold text-rose-400">Delete Server</span>
    </ng-template>
    <p class="text-sm text-white/70">
        This permanently deletes <strong>{{ guild().name }}</strong> and everything in it. This cannot be undone.
    </p>
    <ng-template pTemplate="footer">
        <p-button (onClick)="showDeleteDialog.set(false)" [text]="true" label="Cancel"/>
        <p-button (onClick)="deleteGuild()" [loading]="deleting()" label="Delete Forever" severity="danger"/>
    </ng-template>
</p-dialog>
```

- [ ] **Step 3: Propagate `guildDeleted` up through the settings modal to `server-taskbar`**

In `guild-settings-modal.component.ts`, add:

```typescript
    guildDeleted = output<string>();
```

and in `guild-settings-modal.component.html`'s `overview` case: `(guildDeleted)="guildDeleted.emit($event)"`.

In `server-taskbar.component.html`, add `(guildDeleted)="onGuildDeleted($event)"` to the existing `<app-guild-settings-modal ...>` usage. In `server-taskbar.component.ts`:

```typescript
    protected onGuildDeleted(guildId: string): void {
        this.showGuildSettings.set(false);
        this.guilds.update(gs => gs.filter(g => g.id !== guildId));
        const ws = this.navService.workspace();
        if (ws.type === 'server' && ws.guild.id === guildId) {
            this.navService.selectDMs();
        }
    }
```

- [ ] **Step 4: Subscribe to the SignalR `GuildDeleted`/`GuildUpdated` pushes**

In `server-taskbar.component.ts`'s `ngOnInit()`, add:

```typescript
        this.guildWsService.guildDeletedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => this.onGuildDeleted(e.guildId));

        this.guildWsService.guildUpdatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                this.guildService.getGuild(e.guildId).subscribe(updated => {
                    this.guilds.update(gs => gs.map(g => g.id === updated.id ? updated : g));
                    const ws = this.navService.workspace();
                    if (ws.type === 'server' && ws.guild.id === updated.id) {
                        this.navService.updateCurrentGuild(updated);
                    }
                });
            });
```

Add `private guildWsService = inject(GuildWebsocketService);` and the corresponding import.

- [ ] **Step 5: Manual verification**

Run: `npx ng serve`, as the owner of a test guild, open Server Settings → Overview → Delete Server, confirm the dialog appears and deleting removes the server from the taskbar and navigates to DMs. On a second logged-in-as-another-member session (or by simulating the event), confirm `guild.GuildDeleted`/`guild.GuildUpdated` pushes update that session too.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/pages/overview-settings src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.ts src/app/features/guild/components/guild-settings-modal/guild-settings-modal.component.html src/app/features/guild/components/server-taskbar/server-taskbar.component.ts src/app/features/guild/components/server-taskbar/server-taskbar.component.html
git commit -m "feat: wire real delete-server UI and live GuildDeleted/GuildUpdated propagation"
```

---

## Part 5 - Roles, channels, threads UI

### Task 18: Role hierarchy - sort by position, drag reorder, escalation-guard error handling

**Files:**
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/roles-settings/roles-settings.component.html`

**Interfaces:**
- Consumes: `GuildService.reorderRoles`, `GuildWebsocketService.rolesReorderedObservable`, `RoleDto.position` (Task 2).

- [ ] **Step 1: Sort the roles list by `position` and add reorder state**

In `roles-settings.component.ts`, change `ngOnInit` and add a sorted computed + drag handlers:

```typescript
    ngOnInit(): void {
        this.roles.set([...this.guild().roles].sort((a, b) => a.position - b.position));
        this.guildWsService.rolesReorderedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(dto => {
                const posMap = new Map(dto.roles.map(r => [r.roleId, r.position]));
                this.roles.update(list =>
                    list.map(r => posMap.has(r.id) ? {...r, position: posMap.get(r.id)!} : r)
                        .sort((a, b) => a.position - b.position)
                );
            });
    }

    private dragIndex = signal<number | null>(null);

    onDragStart(index: number): void {
        this.dragIndex.set(index);
    }

    onDragOver(event: DragEvent): void {
        event.preventDefault();
    }

    onDrop(targetIndex: number): void {
        const fromIndex = this.dragIndex();
        this.dragIndex.set(null);
        if (fromIndex === null || fromIndex === targetIndex) return;

        const reordered = [...this.roles()];
        const [moved] = reordered.splice(fromIndex, 1);
        reordered.splice(targetIndex, 0, moved);
        const withPositions = reordered.map((r, i) => ({...r, position: i}));
        this.roles.set(withPositions);

        this.guildService.reorderRoles(this.guild().id, {
            roles: withPositions.map(r => ({roleId: r.id, position: r.position})),
        }).subscribe({
            error: err => {
                this.toastService.httpError('Failed to reorder roles', err);
                this.roles.set([...this.guild().roles].sort((a, b) => a.position - b.position));
            },
        });
    }
```

Add `private destroyRef = inject(DestroyRef);`, `private guildWsService = inject(GuildWebsocketService);`, and the imports: `DestroyRef`, `takeUntilDestroyed` from `'@angular/core/rxjs-interop'`, `GuildWebsocketService` from the service path.

- [ ] **Step 2: Add `draggable` attributes to the role list rows in the template**

In `roles-settings.component.html`, find the `@for (role of roles(); ...)` block that renders each role row in the left-hand list, and add:

```html
@for (role of roles(); track role.id; let i = $index) {
    <div (dragover)="onDragOver($event)"
         (dragstart)="onDragStart(i)"
         (drop)="onDrop(i)"
         [draggable]="true"
         ... existing bindings and classes unchanged ...>
        ... existing row content unchanged ...
    </div>
}
```

(Do not otherwise alter row markup/classes - only add the three drag event bindings and `[draggable]="true"` to the existing row wrapper element.)

- [ ] **Step 3: Handle the permission-escalation 403 distinctly in `saveRole()`**

The existing `saveRole()` already routes errors through `this.toastService.httpError('Failed to save role', err)`. Change it to give a clearer message on `403` specifically, since the guide calls out that a hidden/disabled toggle is preferable but a clear message is the acceptable fallback this plan takes (no per-permission-row disabling is added - that would require plumbing the acting member's own mask into `PermissionToggleComponent`, which is out of scope for this task):

```typescript
            error: err => {
                this.editSaving.set(false);
                if (err.status === 403) {
                    this.toastService.error('You can only grant permissions you already have yourself.');
                } else {
                    this.toastService.httpError('Failed to save role', err);
                }
            },
```

Apply the same `403` branch to `createRole()`'s error handler.

- [ ] **Step 4: Manual verification**

Run: `npx ng serve`, open Server Settings → Roles, confirm roles render sorted by position, drag-reordering two roles persists (reload the modal to confirm), and attempting to grant a permission you don't hold yourself shows the specific 403 toast instead of the generic one.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/pages/roles-settings
git commit -m "feat: sort roles by position, add drag reorder, clarify permission-escalation errors"
```

---

### Task 19: Channel overview - slowmode field and full-replace PATCH body

This task fixes the compile break introduced by Task 3 (`UpdateChannelDto` shape change) and Task 9 (route rename).

**Files:**
- Modify: `src/app/features/guild/components/channel-settings-modal/pages/channel-overview/channel-overview.component.ts`
- Modify: `src/app/features/guild/components/channel-settings-modal/pages/channel-overview/channel-overview.component.html`

**Interfaces:**
- Consumes: `GuildService.updateChannel` (Task 9), `UpdateChannelDto` (Task 3).

- [ ] **Step 1: Add a `slowModeSeconds` field and send the full-replace body**

```typescript
export class ChannelOverviewComponent implements OnInit {
    channel = input.required<ChannelDto>();
    channelUpdated = output<ChannelDto>();
    name = signal('');
    description = signal('');
    isPrivate = signal(false);
    isAgeRestricted = signal(false);
    slowModeSeconds = signal(0);
    saving = signal(false);
    dirty = signal(false);
    protected readonly ChannelType = ChannelType;
    private guildService = inject(GuildService);

    ngOnInit(): void {
        const c = this.channel();
        this.name.set(c.name);
        this.description.set(c.description ?? '');
        this.isPrivate.set(c.isPrivate);
        this.isAgeRestricted.set(c.isAgeRestricted);
        this.slowModeSeconds.set(c.slowModeSeconds);
        this.dirty.set(false);
    }

    onChange(): void {
        const c = this.channel();
        this.dirty.set(
            this.name() !== c.name ||
            this.description() !== (c.description ?? '') ||
            this.isPrivate() !== c.isPrivate ||
            this.isAgeRestricted() !== c.isAgeRestricted ||
            this.slowModeSeconds() !== c.slowModeSeconds
        );
    }

    save(): void {
        if (this.saving()) return;
        this.saving.set(true);
        const dto: UpdateChannelDto = {
            name: this.name(),
            description: this.description(),
            isPrivate: this.isPrivate(),
            isAgeRestricted: this.isAgeRestricted(),
            slowModeSeconds: this.slowModeSeconds(),
        };
        this.guildService.updateChannel(this.channel().id, dto).subscribe({
            next: updated => {
                this.channelUpdated.emit(updated);
                this.dirty.set(false);
                this.saving.set(false);
            },
            error: () => this.saving.set(false),
        });
    }
}
```

- [ ] **Step 2: Add the slowmode input to the template**

In `channel-overview.component.html`, add near the `isAgeRestricted` toggle (only for `ChannelType.Text` channels - voice channels don't have slow mode):

```html
@if (channel().type === ChannelType.Text) {
    <div class="mb-5">
        <label class="block text-xs font-semibold text-white/50 mb-1.5" for="slowmode">Slow Mode (seconds)</label>
        <input (ngModelChange)="onChange()" [(ngModel)]="slowModeSeconds" [min]="0" [max]="21600"
               id="slowmode" pInputText type="number"/>
        <p class="text-[11px] text-white/30 mt-1">Members must wait this long between messages. Not yet enforced by the server.</p>
    </div>
}
```

(The "not yet enforced" hint mirrors the guide's §4.2 note verbatim - this avoids the UI implying a guarantee the backend doesn't currently provide.)

- [ ] **Step 3: Verify build**

Run: `npx ng build --configuration development`
Expected: succeeds - this resolves the `UpdateChannelDto` shape mismatch introduced in Task 3.

- [ ] **Step 4: Manual verification**

Run: `npx ng serve`, open a text channel's settings → Overview, set a slow mode value, save, reopen and confirm it persisted.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/channel-settings-modal/pages/channel-overview
git commit -m "feat: add slow mode field to channel overview, send full-replace update body"
```

---

### Task 20: Channel and category permission editors - adapt to role/member-id-keyed routes

This task resolves the compile break from Task 9's route rewrite. `ChannelPermission.id` is still present in `PUT` responses so it's kept in the row model for the UI, but writes/deletes now key off `roleId`/`memberId` directly instead of `perm.id`.

**Files:**
- Modify: `src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.ts`
- Modify: `src/app/features/guild/components/category-settings-modal/pages/category-permissions/category-permissions.component.ts`

**Interfaces:**
- Consumes: `GuildService.upsertChannelRolePermission/upsertChannelMemberPermission/deleteChannelRolePermission/deleteChannelMemberPermission` and the four category equivalents (Task 9).

- [ ] **Step 1: Update `channel-permissions.component.ts`'s save/delete calls**

Replace `saveRoleOverride`:

```typescript
    saveRoleOverride(row: RoleOverride): void {
        if (row.saving) return;
        this.roleOverrides.update(list => list.map(r => r.role.id === row.role.id ? {...r, saving: true} : r));
        this.guildService.upsertChannelRolePermission(this.channel().id, row.role.id, {
            allowPermissions: stringifyPermissions(row.override.allow),
            denyPermissions: stringifyPermissions(row.override.deny),
        }).subscribe({
            next: perm => {
                this.roleOverrides.update(list =>
                    list.map(r => r.role.id === row.role.id ? {...r, perm, dirty: false, saving: false} : r)
                );
            },
            error: () => {
                this.roleOverrides.update(list => list.map(r => r.role.id === row.role.id ? {...r, saving: false} : r));
            },
        });
    }
```

Replace `deleteRoleOverride`:

```typescript
    deleteRoleOverride(row: RoleOverride): void {
        if (!row.perm) return;
        this.guildService.deleteChannelRolePermission(this.channel().id, row.role.id).subscribe({
            next: () => {
                this.roleOverrides.update(list =>
                    list.map(r => r.role.id === row.role.id
                        ? {...r, perm: null, override: {allow: 0n, deny: 0n}, dirty: false}
                        : r
                    )
                );
            },
        });
    }
```

Replace `saveMemberOverride`/`deleteMemberOverride` the same way, swapping `row.role.id` for `row.member.id` and `upsertChannelMemberPermission`/`deleteChannelMemberPermission`:

```typescript
    saveMemberOverride(row: MemberOverride): void {
        if (row.saving) return;
        this.memberOverrides.update(list => list.map(r => r.member.id === row.member.id ? {...r, saving: true} : r));
        this.guildService.upsertChannelMemberPermission(this.channel().id, row.member.id, {
            allowPermissions: stringifyPermissions(row.override.allow),
            denyPermissions: stringifyPermissions(row.override.deny),
        }).subscribe({
            next: perm => {
                this.memberOverrides.update(list =>
                    list.map(r => r.member.id === row.member.id ? {...r, perm, dirty: false, saving: false} : r)
                );
            },
            error: () => {
                this.memberOverrides.update(list => list.map(r => r.member.id === row.member.id ? {...r, saving: false} : r));
            },
        });
    }

    deleteMemberOverride(row: MemberOverride): void {
        if (!row.perm) return;
        this.guildService.deleteChannelMemberPermission(this.channel().id, row.member.id).subscribe({
            next: () => {
                this.memberOverrides.update(list =>
                    list.map(r => r.member.id === row.member.id
                        ? {...r, perm: null, override: {allow: 0n, deny: 0n}, dirty: false}
                        : r
                    )
                );
            },
        });
    }
```

- [ ] **Step 2: Apply the identical mechanical change to `category-permissions.component.ts`**

Same four-method rewrite, using `this.category().id`, `upsertCategoryRolePermission`/`deleteCategoryRolePermission`/`upsertCategoryMemberPermission`/`deleteCategoryMemberPermission`.

- [ ] **Step 3: Verify build**

Run: `npx ng build --configuration development`
Expected: succeeds - this resolves the last of the Task 9 route-rewrite compile breaks.

- [ ] **Step 4: Manual verification**

Run: `npx ng serve`, open a channel's Permissions tab, set a role override to Deny on `SendMessages`, save, reload the modal, confirm it persisted; delete the override and confirm it reverts to Inherit. Repeat for a member override and for a category.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/channel-settings-modal/pages/channel-permissions src/app/features/guild/components/category-settings-modal/pages/category-permissions
git commit -m "fix: adapt channel/category permission editors to role/member-id-keyed routes"
```

---

### Task 21: Threads - minimal create/list/archive panel reusing the existing channel message view

Threads are first-class `Channel` rows (`type: Thread`, `parentChannelId` set) - opening one reuses `NavigationService.openChannel()` and the existing `ChannelComponent` message view as-is, so this task only needs a thread list/create/archive panel, not a new messaging surface.

**Files:**
- Create: `src/app/features/guild/components/channel/thread-panel/thread-panel.component.ts`
- Create: `src/app/features/guild/components/channel/thread-panel/thread-panel.component.html`
- Modify: `src/app/features/guild/components/channel/channel.component.ts`
- Modify: `src/app/features/guild/components/channel/channel.component.html`

**Interfaces:**
- Consumes: `GuildService.createThread/getThreads/archiveThread`, `GuildWebsocketService.threadCreatedObservable`, `Permissions.CreateThreads/ManageOwnThreads/ManageAnyThread`.

- [ ] **Step 1: Create the thread panel component**

```typescript
// thread-panel.component.ts
import {Component, DestroyRef, inject, input, output, OnInit, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {ChannelDto} from '../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../services/guild.service';
import {GuildWebsocketService} from '../../../../../services/guild-websocket.service';
import {ToastService} from '../../../../../services/toast.service';

@Component({
    selector: 'app-thread-panel',
    imports: [Button, InputText, Dialog],
    templateUrl: './thread-panel.component.html',
})
export class ThreadPanelComponent implements OnInit {
    parentChannelId = input.required<string>();
    threadSelected = output<ChannelDto>();
    threads = signal<ChannelDto[]>([]);
    loading = signal(true);
    showCreateDialog = signal(false);
    createName = signal('');
    creating = signal(false);
    archivingId = signal<string | null>(null);
    private guildService = inject(GuildService);
    private guildWsService = inject(GuildWebsocketService);
    private toastService = inject(ToastService);
    private destroyRef = inject(DestroyRef);

    ngOnInit(): void {
        this.load();
        this.guildWsService.threadCreatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.parentChannelId !== this.parentChannelId()) return;
                this.load();
            });
    }

    load(): void {
        this.loading.set(true);
        this.guildService.getThreads(this.parentChannelId()).subscribe({
            next: threads => {
                this.threads.set(threads);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError('Failed to load threads', err);
            },
        });
    }

    createThread(): void {
        const name = this.createName().trim();
        if (!name || this.creating()) return;
        this.creating.set(true);
        this.guildService.createThread(this.parentChannelId(), {name}).subscribe({
            next: thread => {
                this.threads.update(list => [thread, ...list]);
                this.showCreateDialog.set(false);
                this.createName.set('');
                this.creating.set(false);
                this.threadSelected.emit(thread);
            },
            error: err => {
                this.creating.set(false);
                this.toastService.httpError('Failed to create thread', err);
            },
        });
    }

    archive(thread: ChannelDto): void {
        if (this.archivingId()) return;
        this.archivingId.set(thread.id);
        this.guildService.archiveThread(thread.id).subscribe({
            next: () => {
                this.threads.update(list => list.filter(t => t.id !== thread.id));
                this.archivingId.set(null);
            },
            error: err => {
                this.archivingId.set(null);
                this.toastService.httpError('Failed to archive thread', err);
            },
        });
    }
}
```

- [ ] **Step 2: Create the template**

```html
<!-- thread-panel.component.html -->
<div class="flex items-center justify-between px-3 py-2 border-b border-white/[0.08]">
    <span class="text-xs font-semibold text-white/50 uppercase tracking-widest">Threads</span>
    <p-button (onClick)="showCreateDialog.set(true)" [text]="true" icon="pi pi-plus" size="small"/>
</div>

@if (loading()) {
    <p class="text-xs text-white/25 text-center py-4">Loading…</p>
} @else if (threads().length === 0) {
    <p class="text-xs text-white/25 text-center py-4">No threads yet</p>
} @else {
    <div class="flex flex-col gap-0.5 p-1.5">
        @for (thread of threads(); track thread.id) {
            <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] cursor-pointer group">
                <span (click)="threadSelected.emit(thread)" class="flex-1 text-sm text-white/70 truncate">
                    # {{ thread.name }}
                </span>
                <p-button (onClick)="archive(thread)" [loading]="archivingId() === thread.id" [text]="true"
                          class="opacity-0 group-hover:opacity-100" icon="pi pi-inbox" size="small"/>
            </div>
        }
    </div>
}

<p-dialog [(visible)]="showCreateDialog" [draggable]="false" [modal]="true" [resizable]="false"
          [style]="{width: '380px'}" appendTo="body">
    <ng-template pTemplate="header">
        <span class="text-sm font-semibold text-white/85">Create Thread</span>
    </ng-template>
    <input [(ngModel)]="createName" pInputText placeholder="Thread name" type="text"/>
    <ng-template pTemplate="footer">
        <p-button (onClick)="showCreateDialog.set(false)" [text]="true" label="Cancel"/>
        <p-button (onClick)="createThread()" [loading]="creating()" label="Create"/>
    </ng-template>
</p-dialog>
```

Add `FormsModule` to the component's `imports` (needed for `[(ngModel)]`).

- [ ] **Step 3: Mount the panel in `channel.component`**

In `channel.component.ts`, add a toggle signal:

```typescript
    protected showThreadPanel = signal(false);
```

In `channel.component.html`, only for text channels (not threads themselves - a thread's `parentChannelId` being set is how you'd detect that, but simplest is gating on `channel().type === ChannelType.Text`), add a header button that toggles `showThreadPanel`, and conditionally render:

```html
@if (channel().type === ChannelType.Text) {
    <p-button (onClick)="showThreadPanel.set(!showThreadPanel())" icon="pi pi-comments" [text]="true" size="small"/>
}
```

and, in the layout (as a collapsible side panel alongside the message list - follow whatever existing flex/grid wrapper `channel.component.html` uses for its main content area):

```html
@if (showThreadPanel()) {
    <app-thread-panel (threadSelected)="navService.openChannel($event)" [parentChannelId]="channel().id"
                       class="w-64 shrink-0 border-l border-white/[0.08]"/>
}
```

Add `ThreadPanelComponent` to `channel.component.ts`'s `imports` array and import it. `navService` is already injected in this component (confirmed in research) and `NavigationService.openChannel(channel: ChannelDto)` already exists and is what the rest of the app uses to navigate into any channel - a thread is just a `ChannelDto`, so this reuses it as-is with zero new navigation code.

- [ ] **Step 4: Manual verification**

Run: `npx ng serve`, open a text channel, toggle the thread panel, create a thread, confirm clicking it navigates into a working message view (send/receive a message), archive it and confirm it disappears from the list.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/channel/thread-panel src/app/features/guild/components/channel/channel.component.ts src/app/features/guild/components/channel/channel.component.html
git commit -m "feat: add thread create/list/archive panel, reusing existing channel message view for thread navigation"
```

---

## Part 6 - Invites and rich mentions

### Task 22: Invite settings - code-based links, expiry/maxUses/useCount

**Files:**
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/invites-settings/invites-settings.component.ts`
- Modify: `src/app/features/guild/components/guild-settings-modal/pages/invites-settings/invites-settings.component.html`
- Modify: `src/app/features/guild/components/channel-list/channel-list.component.ts` (fix `quickCreateInvite`'s link to use `code`)
- Modify: `src/app/features/guild/components/server-taskbar/server-taskbar.component.ts` (fix `inviteToServer`'s link to use `code`)
- Modify: `src/assets/i18n/locales/en.json`

**Interfaces:**
- Consumes: `InviteDto.code/expiresAt/maxUses/useCount` (Task 5), `CreateInviteDto.expiresAt/maxUses/channelId` (Task 5).

- [ ] **Step 1: Update `invites-settings.component.ts` to use `code` for the shareable link and expose expiry input**

```typescript
    inviteLink(invite: InviteDto): string {
        return `https://venta.gg/invite/${invite.code}`;
    }
```

Add expiry controls for the "one-time"/"permanent" create flow - add a signal for an optional expiry duration and pass it through:

```typescript
    createExpiryHours = signal<number | null>(null);

    createPermanentInvite(): void {
        this.createInvite(InviteType.Permanent);
    }

    createOneTimeInvite(): void {
        this.createInvite(InviteType.OneTime);
    }

    private createInvite(type: InviteType): void {
        if (this.creating()) return;
        this.creating.set(true);
        const hours = this.createExpiryHours();
        const expiresAt = hours ? new Date(Date.now() + hours * 3600_000).toISOString() : undefined;
        this.guildService.createInvite({type, expiresAt}, this.guild().id).subscribe({
            next: invite => {
                this.invites.update(list => [invite, ...list]);
                this.creating.set(false);
            },
            error: () => this.creating.set(false),
        });
    }
```

- [ ] **Step 2: Show `expiresAt`/`maxUses`/`useCount` in the list template**

In `invites-settings.component.html`, in the per-invite row (alongside the existing type badge / created-date text), add:

```html
<span class="text-[11px] text-white/30">{{ invite.useCount }} use{{ invite.useCount === 1 ? '' : 's' }}@if (invite.maxUses) { / {{ invite.maxUses }} }</span>
@if (invite.expiresAt) {
    <span class="text-[11px] text-white/30">Expires {{ invite.expiresAt | date:'short' }}</span>
}
```

Add `DatePipe` to the component's `imports`.

- [ ] **Step 3: Fix the two other invite-link construction sites to use `code`**

In `channel-list.component.ts`'s `quickCreateInvite()`:

```typescript
            next: invite => {
                this.inviteLink.set(`https://venta.gg/invite/${invite.code}`);
                this.inviteLoading.set(false);
            },
```

In `server-taskbar.component.ts`'s `inviteToServer()`:

```typescript
    private inviteToServer(guild: GuildDto): void {
        this.guildService.createInvite({type: InviteType.Permanent}, guild.id).subscribe({
            next: invite => navigator.clipboard.writeText(`https://venta.gg/invite/${invite.code}`),
        });
    }
```

- [ ] **Step 4: Manual verification**

Run: `npx ng serve`, create an invite from Server Settings → Invites, confirm the copied link uses the `code` (not the opaque `id`), confirm `useCount`/`maxUses`/`expiresAt` render when present. Repeat for the quick-invite flow from the channel list guild menu.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/guild/components/guild-settings-modal/pages/invites-settings src/app/features/guild/components/channel-list/channel-list.component.ts src/app/features/guild/components/server-taskbar/server-taskbar.component.ts
git commit -m "feat: use invite code for shareable links, show expiry/max-uses/use-count"
```

---

### Task 23: Composer - role/@everyone/@here mention parsing and rich mention serialization

This is the largest single UI task in the plan: `MentionCandidate` becomes a discriminated union so the composer, suggestion overlay, and both message-send call sites (`channel.component.ts`, `conversation.component.ts`) can distinguish user/role/everyone/here mentions through the same pipeline.

**Files:**
- Modify: `src/app/features/messaging/components/conversation/composer/composer-utils.ts`
- Modify: `src/app/features/messaging/components/conversation/composer/composer.component.ts`
- Modify: `src/app/features/messaging/components/conversation/composer/suggestion-overlay/suggestion-overlay.component.ts`
- Modify: `src/app/features/messaging/components/conversation/composer/suggestion-overlay/suggestion-overlay.component.html`
- Modify: `src/app/features/guild/components/channel/channel.component.ts`
- Modify: `src/app/features/guild/components/channel/channel.component.html`
- Modify: `src/app/features/messaging/components/conversation/conversation.component.ts` (pass through the new fields unchanged for DMs - DMs have no roles/everyone/here, so this is a type-shape update only)
- Modify: `src/app/services/messaging.service.ts` is untouched (it already forwards whatever `CreateMessageDto` it's given)
- Test: `src/app/features/messaging/components/conversation/composer/composer-utils.spec.ts`

**Interfaces:**
- Consumes: `MessageDto`/`CreateMessageDto` mention fields (Task 4), `RoleDto` (existing).
- Produces: `MentionCandidate` discriminated union; `ComposerComponent`'s `message` output gains `roleMentions`, `mentionsEveryone`, `mentionsHere`.

- [ ] **Step 1: Write the failing test for the pure trigger-detection logic (unchanged regex, but the candidate type it feeds now needs a `kind` discriminator downstream - this step locks in `detectTrigger`'s existing behavior stays correct before the type change)**

```typescript
// composer-utils.spec.ts
import {describe, expect, it} from 'vitest';
import {detectTrigger} from './composer-utils';

function makeEditorWithCursorAt(text: string, cursorOffset: number): HTMLElement {
    const editor = document.createElement('div');
    const textNode = document.createTextNode(text);
    editor.appendChild(textNode);
    const range = document.createRange();
    range.setStart(textNode, cursorOffset);
    range.setEnd(textNode, cursorOffset);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return editor;
}

describe('detectTrigger mention detection', () => {
    it('detects a bare @ at the start of input', () => {
        const editor = makeEditorWithCursorAt('@', 1);
        const result = detectTrigger(editor);
        expect(result?.type).toBe('mention');
        expect(result?.query).toBe('');
    });

    it('detects @everyone as an in-progress mention query', () => {
        const editor = makeEditorWithCursorAt('@everyone', 9);
        const result = detectTrigger(editor);
        expect(result?.type).toBe('mention');
        expect(result?.query).toBe('everyone');
    });

    it('detects @here as an in-progress mention query', () => {
        const editor = makeEditorWithCursorAt('hey @here', 9);
        const result = detectTrigger(editor);
        expect(result?.type).toBe('mention');
        expect(result?.query).toBe('here');
    });

    it('detects a role-name query the same way as a user query (both are plain @word)', () => {
        const editor = makeEditorWithCursorAt('@mod', 4);
        const result = detectTrigger(editor);
        expect(result?.type).toBe('mention');
        expect(result?.query).toBe('mod');
    });
});
```

- [ ] **Step 2: Run to verify pass (this locks in existing, unchanged behavior - a safety net before the type refactor, not a new-behavior test)**

Run: `npx ng test --include src/app/features/messaging/components/conversation/composer/composer-utils.spec.ts`
Expected: PASS immediately - `detectTrigger` isn't being changed, only what consumes its output.

- [ ] **Step 3: Change `MentionCandidate` to a discriminated union in `composer-utils.ts`**

```typescript
export interface UserMentionCandidate {
    kind: 'user';
    userId: string;
    userName: string;
    avatarUrl?: string;
}

export interface RoleMentionCandidate {
    kind: 'role';
    roleId: string;
    name: string;
    color: string;
}

export interface EveryoneMentionCandidate {
    kind: 'everyone';
}

export interface HereMentionCandidate {
    kind: 'here';
}

export type MentionCandidate = UserMentionCandidate | RoleMentionCandidate | EveryoneMentionCandidate | HereMentionCandidate;

export function mentionCandidateId(c: MentionCandidate): string {
    switch (c.kind) {
        case 'user': return `user:${c.userId}`;
        case 'role': return `role:${c.roleId}`;
        case 'everyone': return 'everyone';
        case 'here': return 'here';
    }
}

export function mentionCandidateLabel(c: MentionCandidate): string {
    switch (c.kind) {
        case 'user': return c.userName;
        case 'role': return c.name;
        case 'everyone': return 'everyone';
        case 'here': return 'here';
    }
}

export function mentionCandidateMatches(c: MentionCandidate, query: string): boolean {
    return mentionCandidateLabel(c).toLowerCase().includes(query.toLowerCase());
}
```

- [ ] **Step 4: Rewrite `composer.component.ts`'s mention plumbing**

Change the `guildId`/candidate inputs and filtering:

```typescript
    guildId = input<string | null>(null);
    conversationMembers = input<MentionCandidate[]>([]);
    guildRoles = input<RoleDto[]>([]);
```

Add the import: `import {RoleDto} from '../../../../../dtos/response/guild.dto';`

Change `conversationMembers` construction upstream is out of scope here (Step 6 handles `channel.component.ts`); this component just needs to merge user results with role/everyone/here candidates when `guildId()` is set:

```typescript
    private readonly staticGuildCandidates = computed<MentionCandidate[]>(() => {
        if (!this.guildId()) return [];
        const roleCandidates: MentionCandidate[] = this.guildRoles()
            .filter(r => r.type !== RoleType.Everyone)
            .map(r => ({kind: 'role', roleId: r.id, name: r.name, color: r.color}));
        return [
            {kind: 'everyone'},
            {kind: 'here'},
            ...roleCandidates,
        ];
    });

    filteredMentions = computed<MentionCandidate[]>(() => {
        if (this.overlayType() !== 'mention') return [];
        const q = this.query().toLowerCase();
        const userCandidates: MentionCandidate[] = this.guildId()
            ? this.guildSearchResults()
            : this.conversationMembers().filter(m => mentionCandidateMatches(m, q));
        const staticMatches = this.staticGuildCandidates().filter(c => mentionCandidateMatches(c, q));
        return [...staticMatches, ...userCandidates].slice(0, 8);
    });
```

Update `guildSearchResults` (the async `guildService.searchMembers` pipeline) to produce `UserMentionCandidate`s with `kind: 'user'`:

```typescript
    private readonly guildSearchResults = toSignal(
        this._queryStream.pipe(
            debounceTime(200),
            switchMap(q => {
                const gid = this.guildId();
                if (!gid || this.overlayType() !== 'mention') return of<MentionCandidate[]>([]);
                return this.guildService.searchMembers(gid, q).pipe(
                    map(members => members
                        .filter(m => m.profile)
                        .map((m): MentionCandidate => ({
                            kind: 'user',
                            userId: m.userId,
                            userName: m.profile!.userName,
                            avatarUrl: m.profile?.avatarUrl,
                        }))
                    ),
                    catchError(() => of<MentionCandidate[]>([]))
                );
            }),
        ),
        {initialValue: [] as MentionCandidate[]}
    );
```

Update `onMentionSelected` to branch on `kind` and set different chip data attributes/classes per kind:

```typescript
    onMentionSelected(candidate: MentionCandidate): void {
        if (!this.triggerRange) return;

        this.triggerRange.deleteContents();

        const chip = document.createElement('span');
        chip.contentEditable = 'false';

        if (candidate.kind === 'user') {
            chip.className = 'mention-chip';
            chip.dataset['userId'] = candidate.userId;
            chip.dataset['display'] = `@${candidate.userName}`;
            chip.textContent = `@${candidate.userName}`;
        } else if (candidate.kind === 'role') {
            chip.className = 'mention-chip mention-chip-role';
            chip.dataset['roleId'] = candidate.roleId;
            chip.dataset['display'] = `@${candidate.name}`;
            chip.textContent = `@${candidate.name}`;
            chip.style.color = candidate.color;
        } else if (candidate.kind === 'everyone') {
            chip.className = 'mention-chip mention-chip-special';
            chip.dataset['everyone'] = 'true';
            chip.dataset['display'] = '@everyone';
            chip.textContent = '@everyone';
        } else {
            chip.className = 'mention-chip mention-chip-special';
            chip.dataset['here'] = 'true';
            chip.dataset['display'] = '@here';
            chip.textContent = '@here';
        }

        this.triggerRange.insertNode(chip);
        const space = document.createTextNode(' ');
        chip.after(space);

        const sel = window.getSelection();
        if (sel) {
            const r = document.createRange();
            r.setStartAfter(space);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        }

        this.closeOverlay();
        this.editorRef().nativeElement.focus();
    }
```

Update `send()` to collect all four kinds from the DOM and change the `message` output's type:

```typescript
    message = output<{
        content: string;
        attachments: string[];
        inReplyTo?: string;
        mentions: string[];
        roleMentions: string[];
        mentionsEveryone: boolean;
        mentionsHere: boolean;
    }>();
```

```typescript
        const attachments = this.attachments.flushAndClear();
        const chips = Array.from(editor.querySelectorAll<HTMLElement>('.mention-chip'));
        const mentions = chips.map(c => c.dataset['userId'] ?? '').filter(Boolean);
        const roleMentions = chips.map(c => c.dataset['roleId'] ?? '').filter(Boolean);
        const mentionsEveryone = chips.some(c => c.dataset['everyone'] === 'true');
        const mentionsHere = chips.some(c => c.dataset['here'] === 'true');

        if (text || attachments.length > 0) {
            this.message.emit({content: text, attachments, inReplyTo: this.replyTo()?.id, mentions, roleMentions, mentionsEveryone, mentionsHere});
        }
```

Every other `this.message.emit({...})` call site in this file (the GIF-drop and inline-command-at-non-start paths) must add the three new fields too - e.g. `onGifSelected`: `this.message.emit({content: url, attachments: [], mentions: [], roleMentions: [], mentionsEveryone: false, mentionsHere: false});`, and the equivalent spot in `onCommandSelected`.

- [ ] **Step 5: Update the suggestion overlay to render all four candidate kinds**

`suggestion-overlay.component.html`'s mention block currently does `@for (m of filteredMentions(); track m.userId; ...)`, which breaks for non-user candidates. Replace with:

```html
@if (overlayType() === 'mention') {
    @for (m of filteredMentions(); track mentionCandidateId(m); let i = $index) {
        <div
                (mousedown)="mentionSelected.emit(m)"
                [ngClass]="selectedIndex() === i ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'"
                class="flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors">
            @switch (m.kind) {
                @case ('user') {
                    <p-avatar icon="pi pi-user" shape="circle"/>
                    <span class="text-sm font-semibold text-white/80">{{ m.userName }}</span>
                }
                @case ('role') {
                    <span class="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                          [style.background-color]="m.color + '33'">
                        <i class="pi pi-shield text-xs" [style.color]="m.color"></i>
                    </span>
                    <span class="text-sm font-semibold" [style.color]="m.color">{{ m.name }}</span>
                }
                @case ('everyone') {
                    <span class="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                        <i class="pi pi-at text-xs text-white/50"></i>
                    </span>
                    <span class="text-sm font-semibold text-white/80">everyone</span>
                }
                @case ('here') {
                    <span class="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                        <i class="pi pi-circle-fill text-xs text-emerald-400"></i>
                    </span>
                    <span class="text-sm font-semibold text-white/80">here</span>
                }
            }
        </div>
    }
}
```

In `suggestion-overlay.component.ts`, add `protected readonly mentionCandidateId = mentionCandidateId;` and import it from `composer-utils`, since the template's `track` expression needs a component-exposed function (Angular templates can't call a bare imported function directly).

- [ ] **Step 6: Feed `guildRoles` into the composer from `channel.component.ts` and update its `createMessage` handler**

```typescript
    protected guildRoles = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? ws.guild.roles : [];
    });
```

In `channel.component.html`, add `[guildRoles]="guildRoles()"` to the existing `<app-composer ... [guildId]="guildId()" ...>` binding.

Update `createMessage(event)`'s parameter type and both the optimistic `MessageDto` and the `messagingService.createMessage(...)` call to include the three new fields:

```typescript
    public createMessage(event: {
        content: string;
        attachments: string[];
        inReplyTo?: string;
        mentions: string[];
        roleMentions: string[];
        mentionsEveryone: boolean;
        mentionsHere: boolean;
    }): void {
        const {content, attachments, inReplyTo, mentions, roleMentions, mentionsEveryone, mentionsHere} = event;
        const tempId = crypto.randomUUID();
        const now = new Date();

        this.replyingTo.set(null);

        const optimistic: MessageDto = {
            id: tempId,
            content: btoa(encodeURIComponent(content).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))),
            channelId: this.channel().id,
            conversationId: undefined,
            authorId: this.profileService.ownProfile()?.userId ?? '',
            createdAt: now,
            updatedAt: now,
            isPending: true,
            isFailed: false,
            attachments: [],
            inReplyTo,
            mentions,
            roleMentions,
            mentionsEveryone,
            mentionsHere,
            encryptionState: MessageEncryptionState.Plain,
            mlsEpoch: undefined,
            mlsSequenceNumber: undefined,
            senderDeviceId: undefined,
            type: MessageType.Message,
        };

        this.messageStore.addMessage(optimistic);

        this.messagingService.createMessage({
            content,
            channelId: this.channel().id,
            conversationId: undefined,
            attachments,
            inReplyTo,
            mentions,
            roleMentions,
            mentionsEveryone,
            mentionsHere,
        }).pipe(
            tap(confirmed => {
                this.messageStore.confirmMessage(tempId, confirmed);
                this.messagingService.messageSentObservable.next(confirmed);
            }),
            catchError(() => {
                this.messageStore.failMessage(tempId);
                return EMPTY;
            }),
        ).subscribe();
    }
```

- [ ] **Step 7: Update `conversation.component.ts` (DM flow) to accept and pass through the same shape**

DMs don't have roles/`@everyone`/`@here` - the composer never emits non-empty values for them there (since `guildId` is unset in that usage, `staticGuildCandidates` is empty and no role/everyone/here chip can ever be created), but the type signature must still match. Update `createPlainMessage`/`createEncryptedMessage` parameter types and pass-throughs identically to Step 6's pattern, and update the `message` output binding in `conversation.component.html` if the event type is named there. Add `roleMentions: [], mentionsEveryone: false, mentionsHere: false` wherever `mentions` is currently threaded through `messagingService.createMessage(...)` and the optimistic `MessageDto`.

- [ ] **Step 8: Run the full test suite**

Run: `npx ng test`
Expected: PASS - including the existing `composer.component.spec.ts`, which must still pass; if it asserts on the old `MentionCandidate` shape (e.g. constructs one with bare `{userId, userName}`), update its fixtures to `{kind: 'user', userId, userName}`.

- [ ] **Step 9: Run a full build**

Run: `npx ng build --configuration development`
Expected: succeeds - this is the last task touching `MessageDto`/`CreateMessageDto` consumers, so this is the point where the whole plan should compile cleanly end-to-end.

- [ ] **Step 10: Manual verification**

Run: `npx ng serve`, in a guild text channel, type `@` and confirm `everyone`, `here`, and role names appear alongside member results; type `@role-name` and send, confirm the chip renders in the sent message distinctly from a user mention (check the rendered message component too - if `message.component.ts` renders mention chips from stored `mentions`, this plan does not add role-chip *rendering in already-sent messages* since that requires the read-side `message.component.ts` to resolve role IDs back to names, which is a separate, unscoped concern - verify this gap is visible but not silently broken, i.e. the message still sends and displays its plain text content correctly, just without a highlighted role chip in the read view).

- [ ] **Step 11: Commit**

```bash
git add src/app/features/messaging/components/conversation/composer src/app/features/guild/components/channel/channel.component.ts src/app/features/guild/components/channel/channel.component.html src/app/features/messaging/components/conversation/conversation.component.ts
git commit -m "feat: parse @role/@everyone/@here in composer, serialize rich mention fields on send"
```

---

## Part 7 - Presence UI

### Task 24: 4-state status dot and self-status picker

**Files:**
- Modify: `src/app/components/user-status-dot/user-status-dot.component.ts`
- Create: `src/app/features/main-page/components/status-picker/status-picker.component.ts`
- Create: `src/app/features/main-page/components/status-picker/status-picker.component.html`
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.ts`
- Modify: `src/app/features/main-page/components/quick-settings/quick-settings.component.html`
- Test: `src/app/components/user-status-dot/user-status-dot.component.spec.ts`

**Interfaces:**
- Consumes: `OnlineStatus.Idle/DoNotDisturb/Hidden` (Task 5), `ProfileService.setSelfStatus` (Task 13).

- [ ] **Step 1: Write the failing test for the 4-state color mapping**

```typescript
// user-status-dot.component.spec.ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {UserStatusDotComponent} from './user-status-dot.component';
import {OnlineStatus} from '../../dtos/response/profile.dto';

describe('UserStatusDotComponent', () => {
    let fixture: ComponentFixture<UserStatusDotComponent>;

    async function render(status: OnlineStatus | null) {
        fixture = TestBed.createComponent(UserStatusDotComponent);
        fixture.componentRef.setInput('status', status);
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [UserStatusDotComponent]}).compileComponents();
    });

    it('renders emerald for Online', async () => {
        const el = await render(OnlineStatus.Online);
        expect(el.querySelector('div')?.className).toContain('bg-emerald-400');
    });

    it('renders amber for Idle', async () => {
        const el = await render(OnlineStatus.Idle);
        expect(el.querySelector('div')?.className).toContain('bg-amber-400');
    });

    it('renders rose for DoNotDisturb', async () => {
        const el = await render(OnlineStatus.DoNotDisturb);
        expect(el.querySelector('div')?.className).toContain('bg-rose-500');
    });

    it('renders muted grey for Offline', async () => {
        const el = await render(OnlineStatus.Offline);
        expect(el.querySelector('div')?.className).toContain('bg-white/20');
    });

    it('renders muted grey for Hidden', async () => {
        const el = await render(OnlineStatus.Hidden);
        expect(el.querySelector('div')?.className).toContain('bg-white/20');
    });

    it('renders nothing for null status', async () => {
        const el = await render(null);
        expect(el.querySelector('div')).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx ng test --include src/app/components/user-status-dot/user-status-dot.component.spec.ts`
Expected: FAIL - `Idle`/`DoNotDisturb` currently fall into the `bg-white/20` else-branch, not `bg-amber-400`/`bg-rose-500`.

- [ ] **Step 3: Update the color mapping**

```typescript
export class UserStatusDotComponent {
    status = input.required<OnlineStatus | null>();
    size = input<'sm' | 'md' | 'lg'>('sm');
    borderColor = input<string>('border-sidebar');

    protected classes = computed(() => [
        SIZE_CLASSES[this.size()],
        this.borderColor(),
        this.colorClass(),
    ]);

    private colorClass(): string {
        switch (this.status()) {
            case OnlineStatus.Online: return 'bg-emerald-400';
            case OnlineStatus.Idle: return 'bg-amber-400';
            case OnlineStatus.DoNotDisturb: return 'bg-rose-500';
            default: return 'bg-white/20';
        }
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx ng test --include src/app/components/user-status-dot/user-status-dot.component.spec.ts`
Expected: PASS

- [ ] **Step 5: Create the status picker component**

```typescript
// status-picker.component.ts
import {Component, inject} from '@angular/core';
import {Menu} from 'primeng/menu';
import {MenuItem} from 'primeng/api';
import {ProfileService} from '../../../../services/profile.service';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {UserStatusDotComponent} from '../../../../components/user-status-dot/user-status-dot.component';

@Component({
    selector: 'app-status-picker',
    imports: [Menu, UserStatusDotComponent],
    templateUrl: './status-picker.component.html',
})
export class StatusPickerComponent {
    protected profileService = inject(ProfileService);
    protected readonly OnlineStatus = OnlineStatus;

    protected menuItems: MenuItem[] = [
        {label: 'Online', icon: 'pi pi-circle-fill', styleClass: 'status-online', command: () => this.setStatus(OnlineStatus.Online)},
        {label: 'Idle', icon: 'pi pi-circle-fill', styleClass: 'status-idle', command: () => this.setStatus(OnlineStatus.Idle)},
        {label: 'Do Not Disturb', icon: 'pi pi-circle-fill', styleClass: 'status-dnd', command: () => this.setStatus(OnlineStatus.DoNotDisturb)},
        {label: 'Appear Offline', icon: 'pi pi-circle', styleClass: 'status-hidden', command: () => this.setStatus(OnlineStatus.Hidden)},
    ];

    private setStatus(status: OnlineStatus): void {
        this.profileService.setSelfStatus(status).subscribe();
    }
}
```

- [ ] **Step 6: Create the template**

```html
<!-- status-picker.component.html -->
<div (click)="menu.toggle($event)" class="relative cursor-pointer">
    <app-user-status-dot [status]="profileService.ownProfile()?.onlineStatus ?? null" size="md"/>
</div>
<p-menu #menu [model]="menuItems" [popup]="true" appendTo="body"/>
```

- [ ] **Step 7: Mount it in `quick-settings`, wrapping the existing avatar**

In `quick-settings.component.ts`, add `StatusPickerComponent` to `imports`. In `quick-settings.component.html`, find the existing `<app-avatar>` usage and wrap/place `<app-status-picker>` as a positioned overlay on it (following the same `absolute -bottom-0.5 -right-0.5` corner-badge convention `UserStatusDotComponent` itself already uses) - locate the avatar's containing `relative`-positioned wrapper and add:

```html
<app-status-picker class="absolute -bottom-0.5 -right-0.5"/>
```

- [ ] **Step 8: Manual verification**

Run: `npx ng serve`, click your own avatar's status dot in the bottom-left quick settings, pick "Do Not Disturb", confirm your avatar's dot turns rose immediately (optimistic via the `ownProfile` signal update inside `setSelfStatus`'s `tap`), and that another connected session sees your status dot flip via `guild.PresenceChanged` within a guild's member list.

- [ ] **Step 9: Commit**

```bash
git add src/app/components/user-status-dot src/app/features/main-page/components/status-picker src/app/features/main-page/components/quick-settings
git commit -m "feat: add Idle/DoNotDisturb status colors and a self-status picker"
```

---

## Final verification

- [ ] **Step 1: Full test suite**

Run: `npx ng test`
Expected: all suites pass, including every new `*.spec.ts` added across this plan.

- [ ] **Step 2: Full production build**

Run: `npx ng build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Manual smoke pass**

Run: `npx ng serve`, and walk the checklist from the backend guide end-to-end in the running app:
- Rename and delete a test server (confirm delete is now real and irreversible via the confirm dialog).
- Ban, unban, kick, and timeout a member from both the member-list context menu and the Bans tab.
- View the Audit Log tab and confirm entries appear for the actions just taken.
- Reorder two roles by drag and confirm the order persists across a reload.
- Set a channel permission override for a role and a member, confirm both persist and can be cleared.
- Set channel slow mode and confirm the value round-trips.
- Create, open, and archive a thread.
- Create an invite with an expiry and max uses, confirm the copied link uses `code`.
- Send a message mentioning a role, `@everyone`, and `@here` in a guild channel; confirm a DM message still sends normally with none of those set.
- Change your own status to each of Online/Idle/Do Not Disturb/Appear Offline and confirm the dot color and a second session's live view both update.
