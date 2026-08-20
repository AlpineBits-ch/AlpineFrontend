# Channel Permissions Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the two duplicated permission pages into one, fix the members tab request storm, make module bits writable, and ship the two switches page (spec section A) and the inherited-value readout (spec section B).

**Architecture:** One shared `<app-permission-overrides>` replaces the near-identical channel and category components, parameterised by a `PermissionScope` value and a gateway that dispatches the four write calls. The channel Permissions page becomes a host: private toggle, sync row, and the overrides panel behind a disclosure. Inherited values come from the new server trace endpoint; implication warnings come from a client mirror of the server's table, pinned by tests on both sides.

**Tech Stack:** Angular 21 standalone components, signals, PrimeNG, ngx-translate, Vitest through the Angular CLI.

**Spec:** `docs/specs/channel-permissions-ux.md`

**Depends on:** `2026-08-20-channel-permissions-server.md` in the Echo repo, Tasks 3 and 5. Tasks 1 to 5 below have no server dependency and can start immediately. Tasks 6 to 8 need the endpoints deployed.

## Global Constraints

- `inject()`, never constructor parameters. `input()` / `output()` / `model()`, never `@Input` / `@Output`.
- `ChangeDetectionStrategy.OnPush` on every new component.
- Standalone components, no NgModules. Control flow blocks (`@if`, `@for`), not structural directives.
- Signals for component state. Any field written from an async callback and read by the template must be a signal, not a plain field with `markForCheck()`.
- 4-space indent, single quotes, semicolons, LF. No bracket spacing in imports: `import {Component, inject} from '@angular/core';`
- No em dashes anywhere: code, comments, UI copy, commit messages.
- No essays in comments. A comment states an invariant whose violation is silent, or names a non-obvious symbol. Nothing else.
- Never write `readonly x = SOME_IMPORTED_CONST` as a class field. Use a getter.
- Tests run through the Angular CLI only: `bun run ng test --watch=false --include="**/name.spec.ts"`. Never bare `vitest`, never `npx ng`.
- Baseline is green. Do not reduce the passing count. A new failure in an unrelated component right after adding a spec file is usually Vitest re-batching, not your change.
- `src/assets/i18n/locales` is a git submodule. New keys need their own commit in that repo, pushed before the client commit that uses them.
- Use `<app-avatar>` for avatars, `injectGuildRoster()` for member maps. Do not re-implement either.
- Push straight to `main`. No PRs.
- **Others are working on `main` at the same time.** Stage by explicit file path, never `git add -A` or `git add .`, or you will sweep up someone else's in-progress work. No `git stash`, no `git checkout --`, no `git reset --hard`, no rebase, no force push. If a pull brings conflicts, stop and ask rather than resolving blind.

## File Structure

| File | Responsibility |
|---|---|
| `features/guild/shared/permission-overrides/permission-scope.ts` | The `PermissionScope` value and its two constructors. Pure. |
| `features/guild/shared/permission-overrides/permission-scope.gateway.ts` | Maps a scope plus a target to the right `GuildService` call. |
| `features/guild/shared/permission-overrides/permission-overrides.component.ts/.html` | The merged roles/members override editor host. Replaces both duplicates. |
| `features/guild/shared/permission-override-editor/*` | Unchanged file, gains ghosted inherit and implication warnings. |
| `features/guild/shared/permission-overrides-panel/*` | Unchanged file, gains search and forwards the resolved trace. |
| `features/guild/components/channel-settings-modal/pages/channel-permissions/*` | Becomes the two switches page. |
| `features/guild/shared/permission-sync.ts` | Derives sync state and the divergence diff. Pure. |
| `enums/permissions.enum.ts` | Gains `IMPLIED_PERMISSIONS`, `expandImpliedPermissions`, `expandDeniedPermissions`. |
| `dtos/response/effective-permissions.dto.ts` | The trace response shape. |
| `services/guild.service.ts` | Gains `getEffectivePermissions` and `syncChannelPermissions`. |

Deleted: `features/guild/components/category-settings-modal/pages/category-permissions/*`.

---

### Task 1: Characterization tests for what exists

No spec covers either permission page today, and Task 2 moves both. Pin the behaviour first.

**Files:**
- Test: `src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `setup()` helper later tasks reuse. Exported from the spec file is not possible, so Task 2 copies it into the new spec rather than importing it.

- [ ] **Step 1: Write the characterization test**

Create `src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.spec.ts`:

```ts
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of} from 'rxjs';
import {vi} from 'vitest';
import {ChannelPermissionsComponent} from './channel-permissions.component';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {
    ChannelDto,
    ChannelType,
    GuildDto,
    RoleDto,
    RoleType,
} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';

const CHANNEL = 'chan_1';
const EVERYONE = 'role_everyone';
const PLAYER = 'role_player';

function role(id: string, name: string, type: RoleType): RoleDto {
    return {id, name, type, color: '#fff', permissions: 'None', position: 0} as RoleDto;
}

function guild(): GuildDto {
    return {
        id: 'guild_1',
        roles: [role(EVERYONE, 'everyone', RoleType.Everyone), role(PLAYER, 'player', RoleType.Custom)],
    } as GuildDto;
}

function channel(overrides: ChannelDto['permissions'] = []): ChannelDto {
    return {
        id: CHANNEL,
        name: 'general',
        type: ChannelType.Text,
        categoryId: 'cat_1',
        permissions: overrides,
        isPrivate: false,
    } as ChannelDto;
}

function setup(channelDto = channel()) {
    const guildService = {
        upsertChannelRolePermission: vi.fn(() =>
            of({id: 'p1', channelId: CHANNEL, roleId: PLAYER, allowPermissions: 'SendMessages', denyPermissions: 'None'}),
        ),
        deleteChannelRolePermission: vi.fn(() => of(void 0)),
        upsertChannelMemberPermission: vi.fn(() => of({id: 'p2'})),
        deleteChannelMemberPermission: vi.fn(() => of(void 0)),
        getMembers: vi.fn(() => of([] as GuildMemberDto[])),
    };

    TestBed.configureTestingModule({
        imports: [ChannelPermissionsComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            {provide: GuildService, useValue: guildService},
            {provide: ProfileService, useValue: {fetchByUserId: vi.fn(() => of({userName: 'ada'}))}},
        ],
    });

    const fixture: ComponentFixture<ChannelPermissionsComponent> =
        TestBed.createComponent(ChannelPermissionsComponent);
    fixture.componentRef.setInput('channel', channelDto);
    fixture.componentRef.setInput('guild', guild());
    fixture.detectChanges();

    return {fixture, component: fixture.componentInstance, guildService};
}

describe('ChannelPermissionsComponent', () => {
    it('lists only roles that already carry an override, plus @everyone pinned last', () => {
        const {component} = setup(
            channel([
                {
                    id: 'p1',
                    channelId: CHANNEL,
                    roleId: PLAYER,
                    allowPermissions: 'SendMessages',
                    denyPermissions: 'None',
                } as ChannelDto['permissions'][number],
            ]),
        );

        const entries = component['roleEntries']();

        expect(entries.map(e => e.id)).toEqual([PLAYER, EVERYONE]);
        expect(entries[1].pinned).toBe(true);
    });

    it('offers every role without an override as addable, never @everyone', () => {
        const {component} = setup();

        expect(component['addableRoles']().map(e => e.id)).toEqual([PLAYER]);
    });

    it('marks a changed row dirty without saving it', () => {
        const {component, guildService} = setup();

        component.onAddRoleOverride(PLAYER);

        expect(component['roleEntries']().find(e => e.id === PLAYER)?.dirty).toBe(true);
        expect(guildService.upsertChannelRolePermission).not.toHaveBeenCalled();
    });

    it('saves the allow and deny masks as name lists', () => {
        const {component, guildService} = setup();

        component.onRoleOverrideChange(PLAYER, {
            allow: 2n, // SendMessages
            deny: 1n, // ViewChannel
            allowModule: 0n,
            denyModule: 0n,
        });
        component.saveRoleOverride(PLAYER);

        expect(guildService.upsertChannelRolePermission).toHaveBeenCalledWith(CHANNEL, PLAYER, {
            allowPermissions: 'SendMessages',
            denyPermissions: 'ViewChannel',
        });
    });

    it('clears the row back to inherit when the override is deleted', () => {
        const {component, guildService} = setup(
            channel([
                {
                    id: 'p1',
                    channelId: CHANNEL,
                    roleId: PLAYER,
                    allowPermissions: 'SendMessages',
                    denyPermissions: 'None',
                } as ChannelDto['permissions'][number],
            ]),
        );

        component.deleteRoleOverride(PLAYER);

        expect(guildService.deleteChannelRolePermission).toHaveBeenCalledWith(CHANNEL, PLAYER);
        expect(component['roleEntries']().map(e => e.id)).toEqual([EVERYONE]);
    });

    it('loads members only when the members tab is opened', () => {
        const {component, guildService} = setup();

        expect(guildService.getMembers).not.toHaveBeenCalled();

        component.switchTab('members');

        expect(guildService.getMembers).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run it and make it green against the current code**

Run: `bun run ng test --watch=false --include="**/channel-permissions.component.spec.ts"`
Expected: PASS, 6 tests. If any fail, the expectation is wrong, not the component. Fix the test to describe what the code does today, since Task 2 has to preserve exactly that.

- [ ] **Step 3: Commit**

```bash
git add src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.spec.ts
git commit -m "test(permissions): characterize the channel override page before moving it"
```

---

### Task 2: One override component for both scopes

**Files:**
- Create: `src/app/features/guild/shared/permission-overrides/permission-scope.ts`
- Create: `src/app/features/guild/shared/permission-overrides/permission-scope.spec.ts`
- Create: `src/app/features/guild/shared/permission-overrides/permission-scope.gateway.ts`
- Create: `src/app/features/guild/shared/permission-overrides/permission-overrides.component.ts`
- Create: `src/app/features/guild/shared/permission-overrides/permission-overrides.component.html`
- Create: `src/app/features/guild/shared/permission-overrides/permission-overrides.component.spec.ts`
- Modify: `src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.ts` and `.html`
- Modify: `src/app/features/guild/components/category-settings-modal/category-settings-modal.component.ts` and `.html`
- Delete: `src/app/features/guild/components/category-settings-modal/pages/category-permissions/` (whole folder)
- Delete: `src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.spec.ts` (its cases move)

**Interfaces:**
- Consumes: `OverrideEntry` and `PermissionOverridesPanelComponent` from `shared/permission-overrides-panel`, `PermOverride` and `EMPTY_OVERRIDE` from `shared/permission-override-editor`.
- Produces:
  - `type PermissionScopeKind = 'channel' | 'category'`
  - `interface PermissionScope {kind: PermissionScopeKind; id: string; channelType: ChannelType | null; overrides: ChannelPermission[]}`
  - `function channelScope(channel: ChannelDto): PermissionScope`
  - `function categoryScope(category: CategoryDto): PermissionScope`
  - `class PermissionScopeGateway` with `upsert(scope, target, dto): Observable<ChannelPermission>` and `remove(scope, target): Observable<void>`, where `target` is `{kind: 'role' | 'member'; id: string}`
  - `<app-permission-overrides [scope] [guild]>` with output `overridesChanged = output<ChannelPermission[]>()`

- [ ] **Step 1: Write the failing scope test**

Create `src/app/features/guild/shared/permission-overrides/permission-scope.spec.ts`:

```ts
import {channelScope, categoryScope} from './permission-scope';
import {CategoryDto, ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';

describe('permission scope', () => {
    it('carries the channel type for a channel, so household groups render', () => {
        const scope = channelScope({
            id: 'chan_1',
            type: ChannelType.List,
            permissions: [],
        } as unknown as ChannelDto);

        expect(scope).toEqual({kind: 'channel', id: 'chan_1', channelType: ChannelType.List, overrides: []});
    });

    // A category-wide household grant would mean "controls every list in here", which is not a
    // thing the server resolves. Categories offer no module groups at all.
    it('carries no channel type for a category', () => {
        const scope = categoryScope({id: 'cat_1', permissions: []} as unknown as CategoryDto);

        expect(scope.channelType).toBeNull();
        expect(scope.kind).toBe('category');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/permission-scope.spec.ts"`
Expected: FAIL, cannot resolve `./permission-scope`.

- [ ] **Step 3: Write the scope and the gateway**

Create `src/app/features/guild/shared/permission-overrides/permission-scope.ts`:

```ts
import {CategoryDto, ChannelDto, ChannelPermission, ChannelType} from '../../../../dtos/response/guild.dto';

export type PermissionScopeKind = 'channel' | 'category';

/** What a set of overwrites hangs off, and everything the editor needs to know about it. */
export interface PermissionScope {
    kind: PermissionScopeKind;
    id: string;
    /** Null for a category: household permissions resolve per channel, so a category offers none. */
    channelType: ChannelType | null;
    overrides: ChannelPermission[];
}

export function channelScope(channel: ChannelDto): PermissionScope {
    return {kind: 'channel', id: channel.id, channelType: channel.type, overrides: channel.permissions};
}

export function categoryScope(category: CategoryDto): PermissionScope {
    return {kind: 'category', id: category.id, channelType: null, overrides: category.permissions};
}
```

Create `src/app/features/guild/shared/permission-overrides/permission-scope.gateway.ts`:

```ts
import {inject, Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {ChannelPermission} from '../../../../dtos/response/guild.dto';
import {GuildService, OverridePermissionsDto} from '../../../../services/guild.service';
import {PermissionScope} from './permission-scope';

export interface OverrideTarget {
    kind: 'role' | 'member';
    id: string;
}

/** The four write calls, picked by scope and target instead of by having two copies of the page. */
@Injectable({providedIn: 'root'})
export class PermissionScopeGateway {
    private guildService = inject(GuildService);

    upsert(
        scope: PermissionScope,
        target: OverrideTarget,
        dto: OverridePermissionsDto,
    ): Observable<ChannelPermission> {
        if (scope.kind === 'channel') {
            return target.kind === 'role'
                ? this.guildService.upsertChannelRolePermission(scope.id, target.id, dto)
                : this.guildService.upsertChannelMemberPermission(scope.id, target.id, dto);
        }

        return target.kind === 'role'
            ? this.guildService.upsertCategoryRolePermission(scope.id, target.id, dto)
            : this.guildService.upsertCategoryMemberPermission(scope.id, target.id, dto);
    }

    remove(scope: PermissionScope, target: OverrideTarget): Observable<void> {
        if (scope.kind === 'channel') {
            return target.kind === 'role'
                ? this.guildService.deleteChannelRolePermission(scope.id, target.id)
                : this.guildService.deleteChannelMemberPermission(scope.id, target.id);
        }

        return target.kind === 'role'
            ? this.guildService.deleteCategoryRolePermission(scope.id, target.id)
            : this.guildService.deleteCategoryMemberPermission(scope.id, target.id);
    }
}
```

- [ ] **Step 4: Run the scope test to verify it passes**

Run: `bun run ng test --watch=false --include="**/permission-scope.spec.ts"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the merged component**

Create `src/app/features/guild/shared/permission-overrides/permission-overrides.component.ts`. This is the body of the two deleted components, with the scope and gateway substituted for the hard-coded channel or category calls:

```ts
import {ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelPermission, GuildDto, RoleDto, RoleType} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../dtos/response/member.dto';
import {ProfileDto} from '../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {parsePermissions, stringifyPermissions} from '../../../../enums/permissions.enum';
import {parseModulePermissions} from '../../../../enums/module-permissions.enum';
import {OverrideEntry, PermissionOverridesPanelComponent} from '../permission-overrides-panel/permission-overrides-panel.component';
import {EMPTY_OVERRIDE, PermOverride} from '../permission-override-editor/permission-override-editor.component';
import {OverrideTarget, PermissionScopeGateway} from './permission-scope.gateway';
import {PermissionScope} from './permission-scope';

interface Row<T> {
    subject: T;
    perm: ChannelPermission | null;
    override: PermOverride;
    dirty: boolean;
    saving: boolean;
}

type RoleRow = Row<RoleDto>;
type MemberRow = Row<GuildMemberDto> & {profile: ProfileDto | null};

@Component({
    selector: 'app-permission-overrides',
    imports: [NgClass, PermissionOverridesPanelComponent, TranslateModule],
    templateUrl: './permission-overrides.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PermissionOverridesComponent implements OnInit {
    readonly scope = input.required<PermissionScope>();
    readonly guild = input.required<GuildDto>();

    /** The scope's overwrites after a save or delete, so the host can keep its own copy honest. */
    readonly overridesChanged = output<ChannelPermission[]>();

    protected readonly activeTab = signal<'roles' | 'members'>('roles');
    protected readonly roleRows = signal<RoleRow[]>([]);
    protected readonly memberRows = signal<MemberRow[]>([]);
    protected readonly membersLoading = signal(false);

    private gateway = inject(PermissionScopeGateway);
    private guildService = inject(GuildService);
    private profiles = inject(ProfileService);

    protected get emptyOverride(): PermOverride {
        return EMPTY_OVERRIDE;
    }

    protected readonly introKey = computed(() =>
        this.scope().kind === 'category' ? 'PERM_OVERRIDE.INTRO_CATEGORY' : 'PERM_OVERRIDE.INTRO',
    );

    protected readonly roleEntries = computed<OverrideEntry[]>(() => {
        const everyoneId = this.everyoneRoleId();
        const rows = this.roleRows();
        const overridden = rows
            .filter(r => (r.perm !== null || r.dirty) && r.subject.id !== everyoneId)
            .map(r => this.toRoleEntry(r, false));
        const everyone = rows.find(r => r.subject.id === everyoneId);
        return everyone ? [...overridden, this.toRoleEntry(everyone, true)] : overridden;
    });

    protected readonly addableRoles = computed<OverrideEntry[]>(() => {
        const everyoneId = this.everyoneRoleId();
        return this.roleRows()
            .filter(r => r.perm === null && !r.dirty && r.subject.id !== everyoneId)
            .map(r => this.toRoleEntry(r, false));
    });

    protected readonly memberEntries = computed<OverrideEntry[]>(() =>
        this.memberRows().filter(r => r.perm !== null || r.dirty).map(r => this.toMemberEntry(r)),
    );

    protected readonly addableMembers = computed<OverrideEntry[]>(() =>
        this.memberRows().filter(r => r.perm === null && !r.dirty).map(r => this.toMemberEntry(r)),
    );

    ngOnInit(): void {
        this.buildRoleRows();
    }

    switchTab(tab: 'roles' | 'members'): void {
        this.activeTab.set(tab);
        if (tab === 'members' && this.memberRows().length === 0) this.loadMembers();
    }

    onRoleChange(roleId: string, override: PermOverride): void {
        this.roleRows.update(list =>
            list.map(r => (r.subject.id === roleId ? {...r, override, dirty: true} : r)),
        );
    }

    onAddRole(roleId: string): void {
        this.onRoleChange(roleId, EMPTY_OVERRIDE);
    }

    saveRole(roleId: string): void {
        const row = this.roleRows().find(r => r.subject.id === roleId);
        if (!row || row.saving) return;

        this.setRoleSaving(roleId, true);
        this.gateway.upsert(this.scope(), {kind: 'role', id: roleId}, this.body(row.override)).subscribe({
            next: perm => {
                this.roleRows.update(list =>
                    list.map(r => (r.subject.id === roleId ? {...r, perm, dirty: false, saving: false} : r)),
                );
                this.emitOverrides();
            },
            error: () => this.setRoleSaving(roleId, false),
        });
    }

    deleteRole(roleId: string): void {
        const row = this.roleRows().find(r => r.subject.id === roleId);
        if (!row?.perm) return;

        this.gateway.remove(this.scope(), {kind: 'role', id: roleId}).subscribe({
            next: () => {
                this.roleRows.update(list =>
                    list.map(r =>
                        r.subject.id === roleId
                            ? {...r, perm: null, override: EMPTY_OVERRIDE, dirty: false}
                            : r,
                    ),
                );
                this.emitOverrides();
            },
        });
    }

    onMemberChange(memberId: string, override: PermOverride): void {
        this.memberRows.update(list =>
            list.map(r => (r.subject.id === memberId ? {...r, override, dirty: true} : r)),
        );
    }

    onAddMember(memberId: string): void {
        this.onMemberChange(memberId, EMPTY_OVERRIDE);
    }

    saveMember(memberId: string): void {
        const row = this.memberRows().find(r => r.subject.id === memberId);
        if (!row || row.saving) return;

        this.setMemberSaving(memberId, true);
        this.gateway.upsert(this.scope(), {kind: 'member', id: memberId}, this.body(row.override)).subscribe({
            next: perm => {
                this.memberRows.update(list =>
                    list.map(r => (r.subject.id === memberId ? {...r, perm, dirty: false, saving: false} : r)),
                );
                this.emitOverrides();
            },
            error: () => this.setMemberSaving(memberId, false),
        });
    }

    deleteMember(memberId: string): void {
        const row = this.memberRows().find(r => r.subject.id === memberId);
        if (!row?.perm) return;

        this.gateway.remove(this.scope(), {kind: 'member', id: memberId}).subscribe({
            next: () => {
                this.memberRows.update(list =>
                    list.map(r =>
                        r.subject.id === memberId
                            ? {...r, perm: null, override: EMPTY_OVERRIDE, dirty: false}
                            : r,
                    ),
                );
                this.emitOverrides();
            },
        });
    }

    private body(override: PermOverride) {
        return {
            allowPermissions: stringifyPermissions(override.allow),
            denyPermissions: stringifyPermissions(override.deny),
        };
    }

    private emitOverrides(): void {
        const rows = [
            ...this.roleRows().map(r => r.perm),
            ...this.memberRows().map(r => r.perm),
        ].filter((p): p is ChannelPermission => p !== null);
        this.overridesChanged.emit(rows);
    }

    private setRoleSaving(roleId: string, saving: boolean): void {
        this.roleRows.update(list => list.map(r => (r.subject.id === roleId ? {...r, saving} : r)));
    }

    private setMemberSaving(memberId: string, saving: boolean): void {
        this.memberRows.update(list => list.map(r => (r.subject.id === memberId ? {...r, saving} : r)));
    }

    private everyoneRoleId(): string | undefined {
        return this.guild().roles.find(r => r.type === RoleType.Everyone)?.id;
    }

    private toOverride(perm: ChannelPermission | null): PermOverride {
        return {
            allow: perm ? parsePermissions(perm.allowPermissions) : 0n,
            deny: perm ? parsePermissions(perm.denyPermissions) : 0n,
            allowModule: parseModulePermissions(perm?.allowModulePermissions),
            denyModule: parseModulePermissions(perm?.denyModulePermissions),
        };
    }

    private toRoleEntry(row: RoleRow, pinned: boolean): OverrideEntry {
        return {
            id: row.subject.id,
            name: row.subject.name,
            color: row.subject.color,
            hasOverride: row.perm !== null,
            dirty: row.dirty,
            saving: row.saving,
            pinned,
            override: row.override,
        };
    }

    private toMemberEntry(row: MemberRow): OverrideEntry {
        return {
            id: row.subject.id,
            name: row.profile?.userName ?? row.subject.userId.slice(0, 8) + '…',
            avatarUrl: row.profile?.avatarUrl ?? null,
            hasOverride: row.perm !== null,
            dirty: row.dirty,
            saving: row.saving,
            override: row.override,
        };
    }

    private buildRoleRows(): void {
        const overrides = this.scope().overrides;
        this.roleRows.set(
            this.guild().roles.map(subject => {
                const perm = overrides.find(p => p.roleId === subject.id) ?? null;
                return {subject, perm, override: this.toOverride(perm), dirty: false, saving: false};
            }),
        );
    }

    private loadMembers(): void {
        this.membersLoading.set(true);
        this.guildService.getMembers(this.guild().id, 0, 1000).subscribe({
            next: members => {
                const overrides = this.scope().overrides;
                this.memberRows.set(
                    members.map(subject => {
                        const perm = overrides.find(p => p.memberId === subject.id) ?? null;
                        return {
                            subject,
                            profile: null,
                            perm,
                            override: this.toOverride(perm),
                            dirty: false,
                            saving: false,
                        };
                    }),
                );
                this.membersLoading.set(false);
                this.hydrateProfiles();
            },
            error: () => this.membersLoading.set(false),
        });
    }

    // Replaced wholesale in Task 3. Kept identical to the old pages here so this task is a pure move.
    private hydrateProfiles(): void {
        this.memberRows().forEach((row, i) => {
            this.profiles.fetchByUserId(row.subject.userId).subscribe({
                next: profile => {
                    this.memberRows.update(list => {
                        const next = [...list];
                        next[i] = {...next[i], profile};
                        return next;
                    });
                },
            });
        });
    }
}
```

Create `src/app/features/guild/shared/permission-overrides/permission-overrides.component.html` by copying `channel-permissions.component.html` verbatim and changing three things: the intro key becomes `{{ introKey() | translate }}`, the handler names become `onAddRole` / `onRoleChange` / `deleteRole` / `saveRole` and their member twins, and `[channelType]` becomes `scope().channelType` on both panels.

- [ ] **Step 6: Move the characterization tests onto the new component**

Create `src/app/features/guild/shared/permission-overrides/permission-overrides.component.spec.ts` by copying the Task 1 spec and changing: the import and `TestBed.createComponent` target, `setInput('channel', ...)` becomes `setInput('scope', channelScope(channelDto))`, and the method names lose their `Override` suffix (`onAddRoleOverride` becomes `onAddRole`, and so on). Add one case the old spec could not express:

```ts
    it('routes a category scope to the category endpoints', () => {
        const {component, guildService} = setup();
        component['scope'] = undefined as never; // not reachable; see setupCategory below
    });
```

Replace that placeholder with a real second setup helper:

```ts
function setupCategory() {
    const guildService = {
        upsertCategoryRolePermission: vi.fn(() => of({id: 'p1'})),
        deleteCategoryRolePermission: vi.fn(() => of(void 0)),
        upsertCategoryMemberPermission: vi.fn(() => of({id: 'p2'})),
        deleteCategoryMemberPermission: vi.fn(() => of(void 0)),
        getMembers: vi.fn(() => of([])),
    };

    TestBed.configureTestingModule({
        imports: [PermissionOverridesComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            {provide: GuildService, useValue: guildService},
            {provide: ProfileService, useValue: {fetchByUserId: vi.fn(() => of({userName: 'ada'}))}},
        ],
    });

    const fixture = TestBed.createComponent(PermissionOverridesComponent);
    fixture.componentRef.setInput('scope', categoryScope({id: 'cat_1', permissions: []} as never));
    fixture.componentRef.setInput('guild', guild());
    fixture.detectChanges();

    return {component: fixture.componentInstance, guildService};
}
```

and the case:

```ts
    it('routes a category scope to the category endpoints', () => {
        const {component, guildService} = setupCategory();

        component.onRoleChange(PLAYER, {allow: 2n, deny: 0n, allowModule: 0n, denyModule: 0n});
        component.saveRole(PLAYER);

        expect(guildService.upsertCategoryRolePermission).toHaveBeenCalledWith('cat_1', PLAYER, {
            allowPermissions: 'SendMessages',
            denyPermissions: 'None',
        });
    });
```

- [ ] **Step 7: Run the new spec**

Run: `bun run ng test --watch=false --include="**/permission-overrides.component.spec.ts"`
Expected: PASS, 7 tests.

- [ ] **Step 8: Rewire both hosts and delete the duplicates**

`channel-permissions.component.ts` becomes a thin host:

```ts
import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {ChannelDto, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {PermissionOverridesComponent} from '../../../../shared/permission-overrides/permission-overrides.component';
import {channelScope} from '../../../../shared/permission-overrides/permission-scope';

@Component({
    selector: 'app-channel-permissions',
    imports: [PermissionOverridesComponent],
    templateUrl: './channel-permissions.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelPermissionsComponent {
    readonly channel = input.required<ChannelDto>();
    readonly guild = input.required<GuildDto>();

    protected readonly scope = computed(() => channelScope(this.channel()));
}
```

`channel-permissions.component.html` becomes:

```html
<app-permission-overrides [guild]="guild()" [scope]="scope()" />
```

In `category-settings-modal.component.ts`, replace the `CategoryPermissionsComponent` import and usage with `PermissionOverridesComponent`, and pass `[scope]="categoryScope(category())"` through a `computed`. Then delete the folder:

```bash
rm -r src/app/features/guild/components/category-settings-modal/pages/category-permissions
rm src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.spec.ts
```

- [ ] **Step 9: Verify nothing still references the deleted component**

Run: `grep -rn "CategoryPermissionsComponent\|category-permissions" src/app`
Expected: no results.

- [ ] **Step 10: Build and run the suite**

Run: `bun run ng build --configuration development`
Expected: success.

Run: `bun run test`
Expected: PASS, at or above the pre-task baseline count.

- [ ] **Step 11: Commit**

This task deletes files, so staging has to pick up removals. Check what is pending first, since someone else may be working in the same tree:

```bash
git status --short src/app/features/guild
```

Stage only the paths this task owns, then commit:

```bash
git add -A -- src/app/features/guild/shared/permission-overrides src/app/features/guild/components/channel-settings-modal/pages/channel-permissions src/app/features/guild/components/category-settings-modal
git commit -m "refactor(permissions): one override editor for channels and categories"
```

---

### Task 3: Members tab paging and cache-first profiles

**Files:**
- Modify: `src/app/features/guild/shared/permission-overrides/permission-overrides.component.ts` (`loadMembers`, `hydrateProfiles`, new paging and search state)
- Modify: `src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.ts` and `.html` (search box, load-more row)
- Test: `src/app/features/guild/shared/permission-overrides/permission-overrides.component.spec.ts` (append)

**Interfaces:**
- Consumes: `PermissionOverridesComponent` from Task 2.
- Produces: on the panel, `readonly searchable = input(false)`, `readonly hasMore = input(false)`, `search = output<string>()`, `loadMore = output<void>()`.

`fetchByUserId` is documented as the deliberate cache bypass, for settings tables that want a fresh row. Using it once per member is what makes this page issue one request per member. `getCachedByUserId` plus `resolveByUserId` is the cache-first pair.

- [ ] **Step 1: Write the failing test**

Append to `permission-overrides.component.spec.ts`:

```ts
describe('PermissionOverridesComponent members tab', () => {
    it('reads one page of members, not the whole guild', () => {
        const {component, guildService} = setup();

        component.switchTab('members');

        expect(guildService.getMembers).toHaveBeenCalledWith('guild_1', 0, 50);
    });

    it('never uses the cache-bypassing profile read', () => {
        const {component, profileService} = setup({members: [memberDto('ada'), memberDto('bo')]});

        component.switchTab('members');

        expect(profileService.fetchByUserId).not.toHaveBeenCalled();
        expect(profileService.getCachedByUserId).toHaveBeenCalledTimes(2);
    });

    it('asks the resolver only for the ids the cache missed', () => {
        const {component, profileService} = setup({
            members: [memberDto('ada'), memberDto('bo')],
            cached: ['ada'],
        });

        component.switchTab('members');

        expect(profileService.resolveByUserId).toHaveBeenCalledTimes(1);
        expect(profileService.resolveByUserId).toHaveBeenCalledWith('bo');
    });

    it('appends the next page rather than replacing the list', () => {
        const {component, guildService} = setup({members: [memberDto('ada')]});

        component.switchTab('members');
        component.loadMoreMembers();

        expect(guildService.getMembers).toHaveBeenLastCalledWith('guild_1', 50, 50);
    });

    it('replaces the list with search results while a term is set', () => {
        const {component, guildService} = setup();

        component.switchTab('members');
        component.searchMembers('ad');

        expect(guildService.searchMembers).toHaveBeenCalledWith('guild_1', 'ad');
    });

    it('goes back to the paged list when the term is cleared', () => {
        const {component, guildService} = setup();

        component.switchTab('members');
        component.searchMembers('ad');
        guildService.getMembers.mockClear();
        component.searchMembers('');

        expect(guildService.getMembers).toHaveBeenCalledWith('guild_1', 0, 50);
    });
});
```

Extend `setup()` to accept `{members, cached}` and to provide:

```ts
    const profileService = {
        fetchByUserId: vi.fn(() => of({userName: 'ada'})),
        getCachedByUserId: vi.fn((userId: string) =>
            (options.cached ?? []).includes(userId) ? {userName: userId} : undefined,
        ),
        resolveByUserId: vi.fn(),
    };
```

and add `searchMembers: vi.fn(() => of([]))` to the `guildService` stub, plus a `memberDto` helper:

```ts
function memberDto(userId: string): GuildMemberDto {
    return {id: `mem_${userId}`, guildId: 'guild_1', userId} as GuildMemberDto;
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/permission-overrides.component.spec.ts"`
Expected: FAIL, `loadMoreMembers` and `searchMembers` are not functions, and `getMembers` was called with `1000`.

- [ ] **Step 3: Implement paging and cache-first profiles**

In `permission-overrides.component.ts`, replace `loadMembers` and `hydrateProfiles`:

```ts
    private static readonly MEMBER_PAGE_SIZE = 50;

    protected readonly memberSearch = signal('');
    protected readonly hasMoreMembers = signal(false);
    private memberSkip = 0;

    protected get memberPageSize(): number {
        return PermissionOverridesComponent.MEMBER_PAGE_SIZE;
    }

    searchMembers(term: string): void {
        this.memberSearch.set(term);

        if (term.trim() === '') {
            this.memberSkip = 0;
            this.memberRows.set([]);
            this.loadMemberPage(false);
            return;
        }

        this.membersLoading.set(true);
        this.guildService.searchMembers(this.guild().id, term).subscribe({
            next: members => {
                this.memberRows.set(members.map(m => this.toMemberRow(m)));
                this.hasMoreMembers.set(false);
                this.membersLoading.set(false);
                this.hydrateProfiles();
            },
            error: () => this.membersLoading.set(false),
        });
    }

    loadMoreMembers(): void {
        if (this.membersLoading() || !this.hasMoreMembers()) return;
        this.loadMemberPage(true);
    }

    private loadMembers(): void {
        this.memberSkip = 0;
        this.loadMemberPage(false);
    }

    private loadMemberPage(append: boolean): void {
        this.membersLoading.set(true);
        const size = this.memberPageSize;

        this.guildService.getMembers(this.guild().id, this.memberSkip, size).subscribe({
            next: members => {
                const rows = members.map(m => this.toMemberRow(m));
                this.memberRows.update(list => (append ? [...list, ...rows] : rows));
                this.memberSkip += members.length;
                this.hasMoreMembers.set(members.length === size);
                this.membersLoading.set(false);
                this.hydrateProfiles();
            },
            error: () => this.membersLoading.set(false),
        });
    }

    private toMemberRow(subject: GuildMemberDto): MemberRow {
        const perm = this.scope().overrides.find(p => p.memberId === subject.id) ?? null;
        return {
            subject,
            profile: this.profiles.getCachedByUserId(subject.userId) ?? null,
            perm,
            override: this.toOverride(perm),
            dirty: false,
            saving: false,
        };
    }

    // getCachedByUserId, never fetchByUserId: that one bypasses the cache by design, which is what
    // turned this tab into one request per member.
    private hydrateProfiles(): void {
        for (const row of this.memberRows()) {
            if (row.profile) continue;
            this.profiles.resolveByUserId(row.subject.userId);
        }
    }
```

`resolveByUserId` returns void and fills the cache in the background. The rows read it on the next paint through `getCachedByUserId` inside `toMemberEntry`:

```ts
    private toMemberEntry(row: MemberRow): OverrideEntry {
        const profile = row.profile ?? this.profiles.getCachedByUserId(row.subject.userId) ?? null;
        return {
            id: row.subject.id,
            name: profile?.userName ?? row.subject.userId.slice(0, 8) + '…',
            avatarUrl: profile?.avatarUrl ?? null,
            hasOverride: row.perm !== null,
            dirty: row.dirty,
            saving: row.saving,
            override: row.override,
        };
    }
```

- [ ] **Step 4: Add the search box and load-more row to the panel**

In `permission-overrides-panel.component.ts` add:

```ts
    readonly searchable = input(false);
    readonly hasMore = input(false);

    search = output<string>();
    loadMore = output<void>();

    protected onSearch(value: string): void {
        this.search.emit(value);
    }
```

In `permission-overrides-panel.component.html`, above the entry list:

```html
@if (searchable()) {
    <input
        (input)="onSearch($any($event.target).value)"
        [attr.aria-label]="'PERM_OVERRIDE.SEARCH' | translate"
        [placeholder]="'PERM_OVERRIDE.SEARCH' | translate"
        class="w-full px-2.5 py-1.5 rounded-lg bg-card text-sm text-text-primary placeholder:text-text-faint border-0 outline-none focus-visible:ring-1 focus-visible:ring-brand"
        type="text"
    />
}
```

and below the `@for` block, still inside the scroll container:

```html
@if (hasMore()) {
    <button
        (click)="loadMore.emit()"
        class="w-full px-2.5 py-1.5 rounded-lg text-xs text-text-muted hover:bg-hover hover:text-text-secondary transition-colors cursor-pointer border-0 text-left"
    >
        {{ 'PERM_OVERRIDE.LOAD_MORE' | translate }}
    </button>
}
```

Wire both panels in `permission-overrides.component.html`. The members panel gets `searchable` and `hasMore`; the roles panel gets `searchable` only, filtered in memory:

```ts
    protected readonly roleSearch = signal('');

    searchRoles(term: string): void {
        this.roleSearch.set(term);
    }
```

and fold the filter into `roleEntries` and `addableRoles`:

```ts
    private matchesRoleSearch(role: RoleDto): boolean {
        const term = this.roleSearch().trim().toLowerCase();
        return term === '' || role.name.toLowerCase().includes(term);
    }
```

applied inside both `.filter(...)` chains, with @everyone exempt from the filter so the pinned row never disappears.

- [ ] **Step 5: Run the spec**

Run: `bun run ng test --watch=false --include="**/permission-overrides.component.spec.ts"`
Expected: PASS, 13 tests.

- [ ] **Step 6: Add the i18n keys**

In the locales submodule, add to `en.json`, `de.json` and `fr.json`:

```json
"PERM_OVERRIDE.SEARCH": "Search",
"PERM_OVERRIDE.LOAD_MORE": "Load more"
```

Commit inside the submodule first:

```bash
cd src/assets/i18n/locales
git add en.json de.json fr.json
git commit -m "feat: add permission override search and paging strings"
git push
cd ../../../..
```

- [ ] **Step 7: Commit**

```bash
git add src/app/features/guild/shared src/assets/i18n/locales
git commit -m "fix(permissions): page the members tab and read profiles from the cache"
```

---

### Task 4: Module permissions become writable

**Files:**
- Modify: `src/app/services/guild.service.ts` (`OverridePermissionsDto` and its TSDoc, around line 115)
- Modify: `src/app/features/guild/shared/permission-override-editor/permission-override-editor.component.ts` and `.html`
- Modify: `src/app/features/guild/shared/permission-overrides/permission-overrides.component.ts` (`body`)
- Test: `src/app/features/guild/shared/permission-overrides/permission-overrides.component.spec.ts` (append)

**Interfaces:**
- Consumes: `PermissionScopeGateway` from Task 2.
- Produces: `OverridePermissionsDto` gains `allowModulePermissions?: string` and `denyModulePermissions?: string`. The editor gains `setModuleState(key, state)`.

The server already accepts both fields. `SetPermissionOverwriteDto` carries them as nullable, and omitting one means "carry over from the row being replaced". The client's TSDoc claiming otherwise is stale.

- [ ] **Step 1: Write the failing test**

Append to `permission-overrides.component.spec.ts`:

```ts
describe('PermissionOverridesComponent module masks', () => {
    it('sends the module masks when they carry anything', () => {
        const {component, guildService} = setup();

        component.onRoleChange(PLAYER, {
            allow: 0n,
            deny: 0n,
            allowModule: 1n << 10n, // AddListItems
            denyModule: 0n,
        });
        component.saveRole(PLAYER);

        expect(guildService.upsertChannelRolePermission).toHaveBeenCalledWith(CHANNEL, PLAYER, {
            allowPermissions: 'None',
            denyPermissions: 'None',
            allowModulePermissions: 'AddListItems',
            denyModulePermissions: 'None',
        });
    });

    // Omitting them means "carry over" on the server, which is the right default for a subject
    // whose module masks were never touched here.
    it('omits the module masks when nothing set them', () => {
        const {component, guildService} = setup();

        component.onRoleChange(PLAYER, {allow: 2n, deny: 0n, allowModule: 0n, denyModule: 0n});
        component.saveRole(PLAYER);

        expect(guildService.upsertChannelRolePermission).toHaveBeenCalledWith(CHANNEL, PLAYER, {
            allowPermissions: 'SendMessages',
            denyPermissions: 'None',
        });
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/permission-overrides.component.spec.ts"`
Expected: FAIL on the first case, module masks are not in the body.

- [ ] **Step 3: Update the DTO and its comment**

In `src/app/services/guild.service.ts`:

```ts
/**
 * Both mask spaces. The module pair is optional: omitting it tells the server to carry the module
 * masks over from the row being replaced, so a core-only edit cannot silently clear them.
 */
export interface OverridePermissionsDto {
    allowPermissions: string;
    denyPermissions: string;
    allowModulePermissions?: string;
    denyModulePermissions?: string;
}
```

- [ ] **Step 4: Send them from the component**

In `permission-overrides.component.ts`:

```ts
    private body(override: PermOverride): OverridePermissionsDto {
        const dto: OverridePermissionsDto = {
            allowPermissions: stringifyPermissions(override.allow),
            denyPermissions: stringifyPermissions(override.deny),
        };

        if (override.allowModule !== 0n || override.denyModule !== 0n) {
            dto.allowModulePermissions = stringifyModulePermissions(override.allowModule);
            dto.denyModulePermissions = stringifyModulePermissions(override.denyModule);
        }

        return dto;
    }
```

Import `stringifyModulePermissions` from `enums/module-permissions.enum`.

- [ ] **Step 5: Make the editor's module group a live control**

In `permission-override-editor.component.ts`, delete the `moduleSummary` computed and add:

```ts
    setModuleState(key: ModulePermissionKey, state: OverrideState): void {
        const val = ModulePermissions[key];
        const current = this.override();
        let allowModule = current.allowModule & ~val;
        let denyModule = current.denyModule & ~val;
        if (state === 'allow') allowModule |= val;
        else if (state === 'deny') denyModule |= val;
        this.overrideChange.emit({...current, allowModule, denyModule});
    }
```

In `permission-override-editor.component.html`, replace the read-only module block with the same tri-state markup the core rows use, calling `moduleState(key)` and `setModuleState(key, ...)`:

```html
@if (moduleGroup(); as group) {
    <div>
        <p class="text-[0.625rem] font-semibold text-text-muted uppercase tracking-widest mb-2">{{ group.labelKey | translate }}</p>
        <div class="space-y-1">
            @for (key of group.perms; track key) {
                <div class="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-card/60 hover:bg-hover transition-colors">
                    <span class="text-sm text-text-secondary truncate">{{ label(key) }}</span>
                    <div class="flex items-center gap-1 shrink-0" role="group">
                        <button
                            (click)="setModuleState(key, moduleState(key) === 'deny' ? 'inherit' : 'deny')"
                            [attr.aria-label]="'PERM_OVERRIDE.DENY' | translate"
                            [attr.aria-pressed]="moduleState(key) === 'deny'"
                            [ngClass]="moduleState(key) === 'deny' ? 'bg-offline/20 text-offline' : 'bg-hover text-text-muted hover:bg-offline/10 hover:text-offline/70'"
                            class="w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer border-0 text-xs"
                        >
                            <i class="pi pi-times"></i>
                        </button>
                        <button
                            (click)="setModuleState(key, 'inherit')"
                            [attr.aria-label]="'PERM_OVERRIDE.INHERIT' | translate"
                            [attr.aria-pressed]="moduleState(key) === 'inherit'"
                            [ngClass]="moduleState(key) === 'inherit' ? 'bg-hover text-text-secondary' : 'bg-card text-text-muted hover:bg-hover hover:text-text-secondary'"
                            class="w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer border-0 text-xs"
                        >
                            <i class="pi pi-minus"></i>
                        </button>
                        <button
                            (click)="setModuleState(key, moduleState(key) === 'allow' ? 'inherit' : 'allow')"
                            [attr.aria-label]="'PERM_OVERRIDE.ALLOW' | translate"
                            [attr.aria-pressed]="moduleState(key) === 'allow'"
                            [ngClass]="moduleState(key) === 'allow' ? 'bg-online/20 text-online' : 'bg-hover text-text-muted hover:bg-online/10 hover:text-online/70'"
                            class="w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer border-0 text-xs"
                        >
                            <i class="pi pi-check"></i>
                        </button>
                    </div>
                </div>
            }
        </div>
    </div>
}
```

Update the `PermOverride` TSDoc: the module half is now edited, not just carried.

- [ ] **Step 6: Run the spec**

Run: `bun run ng test --watch=false --include="**/permission-overrides.component.spec.ts"`
Expected: PASS, 15 tests.

- [ ] **Step 7: Remove the dead i18n key**

Delete `PERM_OVERRIDE.MODULE_READONLY` from `en.json`, `de.json` and `fr.json` in the locales submodule, commit and push there first.

- [ ] **Step 8: Commit**

```bash
git add src/app/services/guild.service.ts src/app/features/guild/shared src/assets/i18n/locales
git commit -m "feat(permissions): let a channel overwrite set module bits"
```

---

### Task 5: Mirror the implication table

**Files:**
- Modify: `src/app/enums/permissions.enum.ts`
- Test: `src/app/enums/permission-implications.spec.ts`

**Interfaces:**
- Consumes: `Permissions`, `PermissionKey`, `PermissionValue` from the same file.
- Produces:
  - `IMPLIED_PERMISSIONS: ReadonlyArray<readonly [PermissionKey, PermissionKey]>`
  - `expandImpliedPermissions(mask: PermissionValue): PermissionValue`
  - `expandDeniedPermissions(mask: PermissionValue): PermissionValue`

Pinned against the same golden list as the server test in the Echo plan, Task 4. Both fixtures cite the spec so a change on either side breaks a test.

- [ ] **Step 1: Write the failing test**

Create `src/app/enums/permission-implications.spec.ts`:

```ts
import {
    expandDeniedPermissions,
    expandImpliedPermissions,
    IMPLIED_PERMISSIONS,
    Permissions,
} from './permissions.enum';

// Mirrors Guild.Application/Services/GuildPermissionService.cs ImpliedPermissions.
// See docs/specs/channel-permissions-ux.md, "Golden list".
const GOLDEN: ReadonlyArray<readonly [keyof typeof Permissions, keyof typeof Permissions]> = [
    ['EditAnyMessage', 'EditOwnMessages'],
    ['DeleteAnyMessage', 'DeleteOwnMessages'],
    ['ManageAnyThread', 'ManageOwnThreads'],
    ['Speak', 'Connect'],
    ['Stream', 'Connect'],
    ['MuteMembers', 'Connect'],
    ['DeafenMembers', 'Connect'],
    ['MoveMembers', 'Connect'],
    ['PinMessages', 'SendMessages'],
    ['AttachFiles', 'SendMessages'],
    ['EmbedLinks', 'SendMessages'],
    ['AddReactions', 'SendMessages'],
    ['CreateThreads', 'SendMessages'],
    ['SendMessages', 'ViewChannel'],
    ['SendMessagesInThreads', 'ViewChannel'],
    ['Connect', 'ViewChannel'],
    ['EditOwnMessages', 'ViewChannel'],
    ['DeleteOwnMessages', 'ViewChannel'],
    ['ManageOwnThreads', 'ViewChannel'],
    ['ManagePermissions', 'ViewChannel'],
    ['ManageChannel', 'ViewChannel'],
];

describe('implication table', () => {
    it('matches the golden list exactly', () => {
        expect([...IMPLIED_PERMISSIONS]).toEqual([...GOLDEN]);
    });

    it('closes a grant forwards', () => {
        for (const [holder, implied] of GOLDEN) {
            const expanded = expandImpliedPermissions(Permissions[holder]);
            expect(expanded & Permissions[implied]).toBe(Permissions[implied]);
        }
    });

    it('closes a deny backwards', () => {
        for (const [holder, implied] of GOLDEN) {
            const expanded = expandDeniedPermissions(Permissions[implied]);
            expect(expanded & Permissions[holder]).toBe(Permissions[holder]);
        }
    });

    it('carries a deny transitively', () => {
        // AttachFiles implies SendMessages implies ViewChannel, so denying ViewChannel takes both.
        const expanded = expandDeniedPermissions(Permissions.ViewChannel);

        expect(expanded & Permissions.SendMessages).toBe(Permissions.SendMessages);
        expect(expanded & Permissions.AttachFiles).toBe(Permissions.AttachFiles);
    });

    it('leaves an unrelated bit alone', () => {
        expect(expandDeniedPermissions(Permissions.ManageEvents)).toBe(Permissions.ManageEvents);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/permission-implications.spec.ts"`
Expected: FAIL, `IMPLIED_PERMISSIONS` is not exported.

- [ ] **Step 3: Add the table and the closures**

Append to `src/app/enums/permissions.enum.ts`:

```ts
/**
 * Every "holding X means you also hold Y" rule the server enforces.
 * Mirrors `ImpliedPermissions` in `Guild.Application/Services/GuildPermissionService.cs`.
 * A change here without the matching change there makes the UI lie about what a deny costs.
 */
export const IMPLIED_PERMISSIONS: ReadonlyArray<readonly [PermissionKey, PermissionKey]> = [
    ['EditAnyMessage', 'EditOwnMessages'],
    ['DeleteAnyMessage', 'DeleteOwnMessages'],
    ['ManageAnyThread', 'ManageOwnThreads'],
    ['Speak', 'Connect'],
    ['Stream', 'Connect'],
    ['MuteMembers', 'Connect'],
    ['DeafenMembers', 'Connect'],
    ['MoveMembers', 'Connect'],
    ['PinMessages', 'SendMessages'],
    ['AttachFiles', 'SendMessages'],
    ['EmbedLinks', 'SendMessages'],
    ['AddReactions', 'SendMessages'],
    ['CreateThreads', 'SendMessages'],
    ['SendMessages', 'ViewChannel'],
    ['SendMessagesInThreads', 'ViewChannel'],
    ['Connect', 'ViewChannel'],
    ['EditOwnMessages', 'ViewChannel'],
    ['DeleteOwnMessages', 'ViewChannel'],
    ['ManageOwnThreads', 'ViewChannel'],
    ['ManagePermissions', 'ViewChannel'],
    ['ManageChannel', 'ViewChannel'],
];

function closeOver(mask: PermissionValue, edges: ReadonlyArray<readonly [bigint, bigint]>): PermissionValue {
    let result = mask;
    let changed = true;
    while (changed) {
        changed = false;
        for (const [from, to] of edges) {
            if ((result & from) === from && (result & to) !== to) {
                result |= to;
                changed = true;
            }
        }
    }
    return result;
}

const FORWARD_EDGES: ReadonlyArray<readonly [bigint, bigint]> = IMPLIED_PERMISSIONS.map(
    ([holder, implied]) => [Permissions[holder], Permissions[implied]] as const,
);

const REVERSE_EDGES: ReadonlyArray<readonly [bigint, bigint]> = IMPLIED_PERMISSIONS.map(
    ([holder, implied]) => [Permissions[implied], Permissions[holder]] as const,
);

/** Widens a grant with everything its bits imply. Superadmin short-circuits, as it does server-side. */
export function expandImpliedPermissions(mask: PermissionValue): PermissionValue {
    if ((mask & Permissions.Superadmin) === Permissions.Superadmin) return mask;
    return closeOver(mask, FORWARD_EDGES);
}

/** Widens a deny with everything that implies its bits, so a deny cannot leave a superset behind. */
export function expandDeniedPermissions(mask: PermissionValue): PermissionValue {
    return closeOver(mask, REVERSE_EDGES);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run ng test --watch=false --include="**/permission-implications.spec.ts"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/enums/permissions.enum.ts src/app/enums/permission-implications.spec.ts
git commit -m "feat(permissions): mirror the server's implication table"
```

---

### Task 6: Read the effective-permissions trace

**Blocked on:** Echo plan Task 3 deployed.

**Files:**
- Create: `src/app/dtos/response/effective-permissions.dto.ts`
- Modify: `src/app/services/guild.service.ts`
- Test: `src/app/services/guild.service.effective-permissions.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type PermissionSourceKey` (the 18 `decidedBy` values)
  - `interface PermissionSourceEntry {permission: PermissionKey; granted: boolean; decidedBy: PermissionSourceKey}`
  - `interface EffectivePermissionsDto {channelId: string; subjectKind: 'Role' | 'Member'; subjectId: string; permissions: string; modulePermissions: string; sources: PermissionSourceEntry[]}`
  - `GuildService.getEffectivePermissions(channelId, subject: {kind: 'role' | 'member'; id: string}): Observable<EffectivePermissionsDto>`
  - `GuildService.syncChannelPermissions(channelId): Observable<ChannelPermission[]>`

- [ ] **Step 1: Write the failing test**

Create `src/app/services/guild.service.effective-permissions.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {GuildService} from './guild.service';
import {ApiConfigService} from './api-config.service';

describe('GuildService permission reads', () => {
    let service: GuildService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test'}},
            ],
        });

        service = TestBed.inject(GuildService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('asks for a role subject by roleId', () => {
        service.getEffectivePermissions('chan_1', {kind: 'role', id: 'role_1'}).subscribe();

        const req = http.expectOne(
            'https://api.test/api/v1/guild/channels/chan_1/effective-permissions?roleId=role_1',
        );

        expect(req.request.method).toBe('GET');
        req.flush({channelId: 'chan_1', subjectKind: 'Role', subjectId: 'role_1', sources: []});
    });

    it('asks for a member subject by memberId', () => {
        service.getEffectivePermissions('chan_1', {kind: 'member', id: 'mem_1'}).subscribe();

        const req = http.expectOne(
            'https://api.test/api/v1/guild/channels/chan_1/effective-permissions?memberId=mem_1',
        );

        req.flush({channelId: 'chan_1', subjectKind: 'Member', subjectId: 'mem_1', sources: []});
    });

    it('posts an empty body to sync', () => {
        service.syncChannelPermissions('chan_1').subscribe();

        const req = http.expectOne('https://api.test/api/v1/guild/channels/chan_1/permissions/sync');

        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({});
        req.flush([]);
    });
});
```

Confirm the base path against `this.base` in `guild.service.ts` before running. It is `apiConfig.baseUrl() + '/api/v1/guild'`, so the gateway rewrite puts the singular segment first. Adjust the expected URLs if the running gateway disagrees.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/guild.service.effective-permissions.spec.ts"`
Expected: FAIL, `getEffectivePermissions` is not a function.

- [ ] **Step 3: Write the DTO**

Create `src/app/dtos/response/effective-permissions.dto.ts`:

```ts
import {PermissionKey} from '../../enums/permissions.enum';

/** The layer that last wrote a bit. Server enum names, so never rename one locally. */
export type PermissionSourceKey =
    | 'Base'
    | 'MemberGuildAllow'
    | 'MemberGuildDeny'
    | 'CategoryEveryoneAllow'
    | 'CategoryEveryoneDeny'
    | 'CategoryRoleAllow'
    | 'CategoryRoleDeny'
    | 'CategoryMemberAllow'
    | 'CategoryMemberDeny'
    | 'ChannelEveryoneAllow'
    | 'ChannelEveryoneDeny'
    | 'ChannelRoleAllow'
    | 'ChannelRoleDeny'
    | 'ChannelMemberAllow'
    | 'ChannelMemberDeny'
    | 'Implied'
    | 'Superadmin'
    | 'Muted';

export interface PermissionSourceEntry {
    permission: PermissionKey;
    granted: boolean;
    decidedBy: PermissionSourceKey;
}

/** What one role or member ends up with in one channel, and why. */
export interface EffectivePermissionsDto {
    channelId: string;
    subjectKind: 'Role' | 'Member';
    subjectId: string;
    permissions: string;
    modulePermissions: string;
    sources: PermissionSourceEntry[];
}
```

- [ ] **Step 4: Add the service methods**

In `src/app/services/guild.service.ts`, beside the other channel permission calls:

```ts
    /**
     * What a role or member actually ends up with here, plus which of the four layers wrote each
     * bit. Needs ManagePermissions. Uncached server-side, so call it once per subject and hold it.
     */
    getEffectivePermissions(
        channelId: string,
        subject: {kind: 'role' | 'member'; id: string},
    ): Observable<EffectivePermissionsDto> {
        const param = subject.kind === 'role' ? 'roleId' : 'memberId';
        return this.http.get<EffectivePermissionsDto>(
            `${this.base}/channels/${encodeURIComponent(channelId)}/effective-permissions` +
                `?${param}=${encodeURIComponent(subject.id)}`,
        );
    }

    /** Replaces the channel's overwrites with its category's, atomically. 404 if it has no category. */
    syncChannelPermissions(channelId: string): Observable<ChannelPermission[]> {
        return this.http.post<ChannelPermission[]>(
            `${this.base}/channels/${encodeURIComponent(channelId)}/permissions/sync`,
            {},
        );
    }
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun run ng test --watch=false --include="**/guild.service.effective-permissions.spec.ts"`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/dtos/response/effective-permissions.dto.ts src/app/services/guild.service.ts src/app/services/guild.service.effective-permissions.spec.ts
git commit -m "feat(permissions): read the effective-permissions trace and the sync route"
```

---

### Task 7: Inherit shows its value

**Blocked on:** Tasks 5 and 6.

**Files:**
- Modify: `src/app/features/guild/shared/permission-override-editor/permission-override-editor.component.ts` and `.html`
- Modify: `src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.ts` and `.html`
- Modify: `src/app/features/guild/shared/permission-overrides/permission-overrides.component.ts`
- Test: `src/app/features/guild/shared/permission-override-editor/permission-override-editor.component.spec.ts`

**Interfaces:**
- Consumes: `EffectivePermissionsDto`, `PermissionSourceEntry` from Task 6; `expandDeniedPermissions` from Task 5.
- Produces: on the editor, `readonly resolved = input<EffectivePermissionsDto | null>(null)`, `readonly savedOverride = input<PermOverride>(EMPTY_OVERRIDE)`, and `inheritedState(key): {granted: boolean; decidedBy: PermissionSourceKey} | null`, `impliedOff(key): boolean`, `denyCollateral(key): PermissionKey[]`.

The ghost is shown only for bits unset in the **saved** override. A bit the user has just cleared without saving would otherwise show a trace fetched while that bit was still overridden, which reads as the opposite of the truth.

- [ ] **Step 1: Write the failing test**

Create `src/app/features/guild/shared/permission-override-editor/permission-override-editor.component.spec.ts`:

```ts
import {TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {
    EMPTY_OVERRIDE,
    PermissionOverrideEditorComponent,
} from './permission-override-editor.component';
import {EffectivePermissionsDto} from '../../../../dtos/response/effective-permissions.dto';
import {ChannelType} from '../../../../dtos/response/guild.dto';

function trace(
    sources: EffectivePermissionsDto['sources'],
): EffectivePermissionsDto {
    return {
        channelId: 'chan_1',
        subjectKind: 'Role',
        subjectId: 'role_1',
        permissions: 'None',
        modulePermissions: 'None',
        sources,
    };
}

function setup(options: {
    resolved?: EffectivePermissionsDto | null;
    override?: typeof EMPTY_OVERRIDE;
    saved?: typeof EMPTY_OVERRIDE;
} = {}) {
    TestBed.configureTestingModule({
        imports: [PermissionOverrideEditorComponent],
        providers: [provideTranslateService()],
    });

    const fixture = TestBed.createComponent(PermissionOverrideEditorComponent);
    fixture.componentRef.setInput('override', options.override ?? EMPTY_OVERRIDE);
    fixture.componentRef.setInput('savedOverride', options.saved ?? EMPTY_OVERRIDE);
    fixture.componentRef.setInput('resolved', options.resolved ?? null);
    fixture.componentRef.setInput('channelType', ChannelType.Text);
    fixture.detectChanges();

    return fixture.componentInstance;
}

describe('PermissionOverrideEditorComponent inherited values', () => {
    it('shows nothing until the trace arrives', () => {
        const component = setup();

        expect(component.inheritedState('SendMessages')).toBeNull();
    });

    it('reports the resolved value and the layer that decided it', () => {
        const component = setup({
            resolved: trace([{permission: 'SendMessages', granted: false, decidedBy: 'ChannelEveryoneDeny'}]),
        });

        expect(component.inheritedState('SendMessages')).toEqual({
            granted: false,
            decidedBy: 'ChannelEveryoneDeny',
        });
    });

    // The trace describes the saved state. A bit this subject overrides has no inherited value to
    // show, and a bit just cleared in the UI has one the trace cannot know yet.
    it('shows no ghost for a bit the saved override sets', () => {
        const component = setup({
            saved: {allow: 0n, deny: 2n, allowModule: 0n, denyModule: 0n}, // deny SendMessages
            override: EMPTY_OVERRIDE,
            resolved: trace([{permission: 'SendMessages', granted: false, decidedBy: 'ChannelRoleDeny'}]),
        });

        expect(component.inheritedState('SendMessages')).toBeNull();
    });

    it('names everything a deny takes with it', () => {
        const component = setup();

        const collateral = component.denyCollateral('SendMessages');

        expect(collateral).toContain('AttachFiles');
        expect(collateral).toContain('PinMessages');
        expect(collateral).not.toContain('SendMessages');
    });

    it('greys a row the current deny already removed', () => {
        const component = setup({
            override: {allow: 0n, deny: 1n, allowModule: 0n, denyModule: 0n}, // deny ViewChannel
        });

        expect(component.impliedOff('SendMessages')).toBe(true);
        expect(component.impliedOff('ManageEvents')).toBe(false);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/permission-override-editor.component.spec.ts"`
Expected: FAIL, `inheritedState` is not a function.

- [ ] **Step 3: Implement on the editor**

Add to `permission-override-editor.component.ts`:

```ts
    /** The saved trace for the selected subject, or null while it is in flight. */
    readonly resolved = input<EffectivePermissionsDto | null>(null);

    /** What the server last stored for this subject. The trace describes this, not the live edit. */
    readonly savedOverride = input<PermOverride>(EMPTY_OVERRIDE);

    private readonly sourceByPermission = computed(() => {
        const map = new Map<PermissionKey, PermissionSourceEntry>();
        for (const entry of this.resolved()?.sources ?? []) map.set(entry.permission, entry);
        return map;
    });

    /** What leaving this row on inherit resolves to, or null when there is nothing honest to show. */
    inheritedState(key: PermissionKey): {granted: boolean; decidedBy: PermissionSourceKey} | null {
        const val = Permissions[key];
        const saved = this.savedOverride();
        if ((saved.allow & val) === val || (saved.deny & val) === val) return null;

        const entry = this.sourceByPermission().get(key);
        return entry ? {granted: entry.granted, decidedBy: entry.decidedBy} : null;
    }

    /** Everything denying this permission would take with it, itself excluded. */
    denyCollateral(key: PermissionKey): PermissionKey[] {
        const val = Permissions[key];
        const expanded = expandDeniedPermissions(val) & ~val;
        return CHANNEL_PERM_GROUPS.flatMap(group => group.perms).filter(
            k => (expanded & Permissions[k]) === Permissions[k],
        );
    }

    /** Whether the edit in progress already removes this row through some other deny. */
    impliedOff(key: PermissionKey): boolean {
        const val = Permissions[key];
        const current = this.override();
        if ((current.deny & val) === val) return false;
        return (expandDeniedPermissions(current.deny) & val) === val;
    }
```

Import `computed`, `expandDeniedPermissions`, `PermissionKey`, `EffectivePermissionsDto`, `PermissionSourceEntry`, `PermissionSourceKey`.

- [ ] **Step 4: Render the ghost, the chip and the warning**

In `permission-override-editor.component.html`, inside the per-permission row, before the tri-state group:

```html
@if (inheritedState(key); as inherited) {
    <span
        [ngClass]="inherited.granted ? 'text-online/60' : 'text-offline/60'"
        class="text-[0.625rem] font-mono border border-border-subtle rounded px-1.5 py-0.5 shrink-0"
    >
        {{ 'PERM_SOURCE.' + inherited.decidedBy | translate }}
    </span>
}
```

On the inherit button, add the ghost by swapping the icon when the row is on inherit and a value is known:

```html
<button
    (click)="setState(key, 'inherit')"
    [attr.aria-label]="'PERM_OVERRIDE.INHERIT' | translate"
    [attr.aria-pressed]="getState(key) === 'inherit'"
    [ngClass]="
        getState(key) !== 'inherit'
            ? 'bg-card text-text-muted hover:bg-hover hover:text-text-secondary'
            : inheritedState(key)?.granted === true
              ? 'bg-hover text-online/40'
              : inheritedState(key)?.granted === false
                ? 'bg-hover text-offline/40'
                : 'bg-hover text-text-secondary'
    "
    class="w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer border-0 text-xs"
>
    @if (getState(key) === 'inherit' && inheritedState(key); as inherited) {
        <i [ngClass]="inherited.granted ? 'pi pi-check' : 'pi pi-times'"></i>
    } @else {
        <i class="pi pi-minus"></i>
    }
</button>
```

Below a row set to deny, when it has collateral:

```html
@if (getState(key) === 'deny' && denyCollateral(key).length > 0) {
    <div class="flex gap-2 items-start mt-1 mb-2 px-3 py-2 rounded-xl bg-connecting/[0.07] border border-connecting/25">
        <i class="pi pi-exclamation-triangle text-connecting text-xs mt-0.5"></i>
        <p class="text-xs text-text-secondary m-0">
            {{ 'PERM_OVERRIDE.DENY_ALSO_REMOVES' | translate: {names: denyCollateral(key).join(', ')} }}
        </p>
    </div>
}
```

And grey an implied-off row by adding to its wrapper:

```html
[ngClass]="impliedOff(key) ? 'opacity-40' : ''"
```

- [ ] **Step 5: Forward the trace through the panel**

Add `readonly resolved = input<EffectivePermissionsDto | null>(null)` and `readonly savedOverrides = input<Record<string, PermOverride>>({})` to `permission-overrides-panel.component.ts`, pass them onto `<app-permission-override-editor>` as `[resolved]="resolved()"` and `[savedOverride]="savedOverrides()[entry.id] ?? emptyOverride"`, with:

```ts
    protected get emptyOverride(): PermOverride {
        return EMPTY_OVERRIDE;
    }
```

- [ ] **Step 6: Fetch the trace when the selection changes**

In `permission-overrides.component.ts`, add a cache keyed by subject and an effect that fills it. A channel scope only, since the endpoint is channel-addressed:

```ts
    private readonly traces = signal<Record<string, EffectivePermissionsDto>>({});

    protected readonly selectedTrace = computed(() => this.traces()[this.selectedSubjectId()] ?? null);

    protected readonly savedOverrides = computed<Record<string, PermOverride>>(() => {
        const map: Record<string, PermOverride> = {};
        for (const row of this.roleRows()) map[row.subject.id] = this.toOverride(row.perm);
        for (const row of this.memberRows()) map[row.subject.id] = this.toOverride(row.perm);
        return map;
    });

    /** Reads the saved state, so a save has to drop the entry rather than patch it. */
    private loadTrace(subjectId: string, kind: 'role' | 'member'): void {
        const scope = this.scope();
        if (scope.kind !== 'channel' || this.traces()[subjectId]) return;

        this.guildService.getEffectivePermissions(scope.id, {kind, id: subjectId}).subscribe({
            next: dto => this.traces.update(map => ({...map, [subjectId]: dto})),
            error: () => undefined,
        });
    }
```

Call `loadTrace` from the panel's selection output. Add `selectionChange = output<string>()` to the panel, emitted from `select()` and `onAdd()`. Drop the cached entry in `saveRole`, `saveMember`, `deleteRole` and `deleteMember`:

```ts
    private forgetTrace(subjectId: string): void {
        this.traces.update(map => {
            const next = {...map};
            delete next[subjectId];
            return next;
        });
    }
```

`selectedSubjectId` is a signal on the overrides component, set from the same `selectionChange`.

- [ ] **Step 7: Add the i18n keys**

In the locales submodule, add to all three files:

```json
"PERM_OVERRIDE.DENY_ALSO_REMOVES": "Denying this also removes {{names}} here.",
"PERM_SOURCE.Base": "role default",
"PERM_SOURCE.MemberGuildAllow": "member allow",
"PERM_SOURCE.MemberGuildDeny": "member deny",
"PERM_SOURCE.CategoryEveryoneAllow": "category @everyone",
"PERM_SOURCE.CategoryEveryoneDeny": "category @everyone",
"PERM_SOURCE.CategoryRoleAllow": "category role",
"PERM_SOURCE.CategoryRoleDeny": "category role",
"PERM_SOURCE.CategoryMemberAllow": "category member",
"PERM_SOURCE.CategoryMemberDeny": "category member",
"PERM_SOURCE.ChannelEveryoneAllow": "channel @everyone",
"PERM_SOURCE.ChannelEveryoneDeny": "channel @everyone",
"PERM_SOURCE.ChannelRoleAllow": "channel role",
"PERM_SOURCE.ChannelRoleDeny": "channel role",
"PERM_SOURCE.ChannelMemberAllow": "channel member",
"PERM_SOURCE.ChannelMemberDeny": "channel member",
"PERM_SOURCE.Implied": "implied",
"PERM_SOURCE.Superadmin": "admin",
"PERM_SOURCE.Muted": "timed out"
```

Commit and push in the submodule first.

- [ ] **Step 8: Run the specs**

Run: `bun run ng test --watch=false --include="**/permission-override-editor.component.spec.ts"`
Expected: PASS, 5 tests.

Run: `bun run ng test --watch=false --include="**/permission-overrides.component.spec.ts"`
Expected: PASS, 15 tests, unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/app/features/guild/shared src/assets/i18n/locales
git commit -m "feat(permissions): show what inherit resolves to and what a deny costs"
```

---

### Task 8: The two switches page

**Blocked on:** Tasks 2 and 6.

**Files:**
- Create: `src/app/features/guild/shared/permission-sync.ts`
- Create: `src/app/features/guild/shared/permission-sync.spec.ts`
- Modify: `src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.ts` and `.html`
- Modify: `src/app/features/guild/components/channel-settings-modal/pages/channel-overview/channel-overview.component.ts` and `.html` (remove the private toggle)
- Test: `src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.page.spec.ts`

**Interfaces:**
- Consumes: `PermissionOverridesComponent` and `channelScope` from Task 2, `syncChannelPermissions` from Task 6.
- Produces:
  - `interface OverrideDiffRow {targetId: string; kind: 'role' | 'member'; change: 'added' | 'removed' | 'changed' | 'same'}`
  - `function diffOverrides(channel: ChannelPermission[], category: ChannelPermission[]): OverrideDiffRow[]`
  - `function isSyncedWithCategory(channel: ChannelPermission[], category: ChannelPermission[]): boolean`

- [ ] **Step 1: Write the failing diff test**

Create `src/app/features/guild/shared/permission-sync.spec.ts`:

```ts
import {diffOverrides, isSyncedWithCategory} from './permission-sync';
import {ChannelPermission} from '../../../dtos/response/guild.dto';

function perm(over: Partial<ChannelPermission>): ChannelPermission {
    return {
        id: 'p',
        roleId: undefined,
        memberId: undefined,
        allowPermissions: 'None',
        denyPermissions: 'None',
        ...over,
    } as ChannelPermission;
}

describe('permission sync', () => {
    it('calls an empty pair synced', () => {
        expect(isSyncedWithCategory([], [])).toBe(true);
    });

    it('calls identical sets synced', () => {
        const rows = [perm({roleId: 'r1', allowPermissions: 'SendMessages'})];

        expect(isSyncedWithCategory(rows, rows)).toBe(true);
    });

    it('is not synced when a mask differs', () => {
        expect(
            isSyncedWithCategory(
                [perm({roleId: 'r1', allowPermissions: 'SendMessages'})],
                [perm({roleId: 'r1', allowPermissions: 'AddReactions'})],
            ),
        ).toBe(false);
    });

    it('names a channel-only override as removed by a sync', () => {
        const diff = diffOverrides([perm({roleId: 'r1'})], []);

        expect(diff).toEqual([{targetId: 'r1', kind: 'role', change: 'removed'}]);
    });

    it('names a category-only override as added by a sync', () => {
        const diff = diffOverrides([], [perm({memberId: 'm1'})]);

        expect(diff).toEqual([{targetId: 'm1', kind: 'member', change: 'added'}]);
    });

    it('names a differing mask as changed', () => {
        const diff = diffOverrides(
            [perm({roleId: 'r1', denyPermissions: 'SendMessages'})],
            [perm({roleId: 'r1', denyPermissions: 'None'})],
        );

        expect(diff).toEqual([{targetId: 'r1', kind: 'role', change: 'changed'}]);
    });

    it('compares the module masks too', () => {
        const diff = diffOverrides(
            [perm({roleId: 'r1', allowModulePermissions: 'ViewWiki'})],
            [perm({roleId: 'r1', allowModulePermissions: 'None'})],
        );

        expect(diff[0].change).toBe('changed');
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run ng test --watch=false --include="**/permission-sync.spec.ts"`
Expected: FAIL, cannot resolve `./permission-sync`.

- [ ] **Step 3: Write the diff**

Create `src/app/features/guild/shared/permission-sync.ts`:

```ts
import {ChannelPermission} from '../../../dtos/response/guild.dto';

export interface OverrideDiffRow {
    targetId: string;
    kind: 'role' | 'member';
    change: 'added' | 'removed' | 'changed' | 'same';
}

function keyOf(perm: ChannelPermission): string | null {
    return perm.roleId ?? perm.memberId ?? null;
}

function kindOf(perm: ChannelPermission): 'role' | 'member' {
    return perm.roleId ? 'role' : 'member';
}

/** All four masks, since a module-only difference is still a difference. */
function sameMasks(a: ChannelPermission, b: ChannelPermission): boolean {
    return (
        a.allowPermissions === b.allowPermissions &&
        a.denyPermissions === b.denyPermissions &&
        (a.allowModulePermissions ?? 'None') === (b.allowModulePermissions ?? 'None') &&
        (a.denyModulePermissions ?? 'None') === (b.denyModulePermissions ?? 'None')
    );
}

/** What syncing this channel with its category would change, one row per target. */
export function diffOverrides(
    channel: ChannelPermission[],
    category: ChannelPermission[],
): OverrideDiffRow[] {
    const byKey = new Map<string, {channel?: ChannelPermission; category?: ChannelPermission}>();

    for (const perm of channel) {
        const key = keyOf(perm);
        if (key) byKey.set(key, {...byKey.get(key), channel: perm});
    }

    for (const perm of category) {
        const key = keyOf(perm);
        if (key) byKey.set(key, {...byKey.get(key), category: perm});
    }

    const rows: OverrideDiffRow[] = [];
    for (const [targetId, pair] of byKey) {
        const source = pair.channel ?? pair.category!;
        const kind = kindOf(source);

        if (!pair.category) rows.push({targetId, kind, change: 'removed'});
        else if (!pair.channel) rows.push({targetId, kind, change: 'added'});
        else if (!sameMasks(pair.channel, pair.category)) rows.push({targetId, kind, change: 'changed'});
        else rows.push({targetId, kind, change: 'same'});
    }

    return rows;
}

export function isSyncedWithCategory(
    channel: ChannelPermission[],
    category: ChannelPermission[],
): boolean {
    return diffOverrides(channel, category).every(row => row.change === 'same');
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run ng test --watch=false --include="**/permission-sync.spec.ts"`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the page test**

Create `channel-permissions.page.spec.ts` next to the component, with a `setup()` mirroring Task 1's but adding a `category` input and a `syncChannelPermissions: vi.fn(() => of([]))` on the guild service stub:

```ts
describe('ChannelPermissionsComponent page', () => {
    it('reports synced when the channel matches its category', () => {
        const {component} = setup({channelOverrides: [], categoryOverrides: []});

        expect(component.synced()).toBe(true);
    });

    it('counts the overrides that differ', () => {
        const {component} = setup({
            channelOverrides: [perm({roleId: 'r1', denyPermissions: 'SendMessages'})],
            categoryOverrides: [perm({roleId: 'r2'})],
        });

        expect(component.synced()).toBe(false);
        expect(component.divergingCount()).toBe(2);
    });

    it('offers no sync row for a channel with no category', () => {
        const {component} = setup({categoryId: undefined});

        expect(component.category()).toBeNull();
    });

    it('calls the sync route and re-reads the channel', () => {
        const {component, guildService} = setup({
            channelOverrides: [perm({roleId: 'r1'})],
            categoryOverrides: [],
        });

        component.resync();

        expect(guildService.syncChannelPermissions).toHaveBeenCalledWith(CHANNEL);
    });

    it('writes the private flag through updateChannel', () => {
        const {component, guildService} = setup();

        component.setPrivate(true);

        expect(guildService.updateChannel).toHaveBeenCalledWith(CHANNEL, {isPrivate: true});
    });
});
```

- [ ] **Step 6: Build the page**

`channel-permissions.component.ts`:

```ts
import {ChangeDetectionStrategy, Component, computed, inject, input, signal} from '@angular/core';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {CategoryDto, ChannelDto, ChannelPermission, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {PermissionOverridesComponent} from '../../../../shared/permission-overrides/permission-overrides.component';
import {channelScope} from '../../../../shared/permission-overrides/permission-scope';
import {diffOverrides, isSyncedWithCategory} from '../../../../shared/permission-sync';

@Component({
    selector: 'app-channel-permissions',
    imports: [ToggleSwitch, FormsModule, Button, TranslateModule, PermissionOverridesComponent],
    templateUrl: './channel-permissions.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelPermissionsComponent {
    readonly channel = input.required<ChannelDto>();
    readonly guild = input.required<GuildDto>();
    readonly categories = input<CategoryDto[]>([]);

    protected readonly advancedOpen = signal(false);
    protected readonly syncing = signal(false);
    protected readonly diffOpen = signal(false);
    protected readonly overrides = signal<ChannelPermission[] | null>(null);

    private guildService = inject(GuildService);

    protected readonly scope = computed(() => channelScope(this.channel()));

    /** Live overwrites: the signal once anything has saved, the input until then. */
    protected readonly channelOverrides = computed(() => this.overrides() ?? this.channel().permissions);

    readonly category = computed<CategoryDto | null>(
        () => this.categories().find(c => c.id === this.channel().categoryId) ?? null,
    );

    readonly synced = computed(() => {
        const category = this.category();
        if (!category) return false;
        return isSyncedWithCategory(this.channelOverrides(), category.permissions);
    });

    readonly divergingCount = computed(() => {
        const category = this.category();
        if (!category) return 0;
        return diffOverrides(this.channelOverrides(), category.permissions).filter(
            row => row.change !== 'same',
        ).length;
    });

    readonly diffRows = computed(() => {
        const category = this.category();
        if (!category) return [];
        return diffOverrides(this.channelOverrides(), category.permissions).filter(
            row => row.change !== 'same',
        );
    });

    setPrivate(isPrivate: boolean): void {
        this.guildService.updateChannel(this.channel().id, {isPrivate}).subscribe({
            next: updated => this.overrides.set(updated.permissions),
        });
    }

    resync(): void {
        if (this.syncing()) return;
        this.syncing.set(true);
        this.guildService.syncChannelPermissions(this.channel().id).subscribe({
            next: rows => {
                this.overrides.set(rows);
                this.syncing.set(false);
                this.diffOpen.set(false);
            },
            error: () => this.syncing.set(false),
        });
    }

    onOverridesChanged(rows: ChannelPermission[]): void {
        this.overrides.set(rows);
    }

    toggleAdvanced(): void {
        this.advancedOpen.update(open => !open);
    }

    toggleDiff(): void {
        this.diffOpen.update(open => !open);
    }

    nameOf(row: {targetId: string; kind: 'role' | 'member'}): string {
        if (row.kind === 'role') {
            return this.guild().roles.find(r => r.id === row.targetId)?.name ?? row.targetId;
        }
        return row.targetId;
    }
}
```

`setPrivate` re-reads the overwrites from the response because the server rewrites the @everyone row when the flag flips. Without that the editor below is stale the moment the toggle is used.

`channel-permissions.component.html` follows the spec's section A layout: title, description, private row, sync row when `category()` is non-null, the diff panel behind `diffOpen()`, then the disclosure wrapping `<app-permission-overrides (overridesChanged)="onOverridesChanged($event)" [guild]="guild()" [scope]="scope()" />`.

- [ ] **Step 7: Remove the private toggle from Overview**

In `channel-overview.component.html`, delete the "Private" block. In `channel-overview.component.ts`, delete the `isPrivate` signal, its `ngOnInit` line, its `onChange` clause and its `dto` field. Leave age restriction alone.

- [ ] **Step 8: Pass categories into the page**

In `channel-settings-modal.component.ts`, add a `categories` input and forward it to `<app-channel-permissions [categories]="categories()">`. Find the modal's caller and pass `guild().categories` or whichever collection the channel list already holds. Verify with:

Run: `grep -rn "app-channel-settings-modal" src/app`

- [ ] **Step 9: Add the i18n keys**

In the locales submodule, all three files:

```json
"CHANNEL_PERMS.TITLE": "Permissions",
"CHANNEL_PERMS.SUBTITLE": "Who can see this channel, and what they can do in it.",
"CHANNEL_PERMS.PRIVATE": "Private channel",
"CHANNEL_PERMS.PRIVATE_HINT": "Hidden from everyone except the roles and members you add below.",
"CHANNEL_PERMS.SYNCED": "Synced with {{category}}",
"CHANNEL_PERMS.SYNCED_HINT": "Permissions come from the category. Editing anything below turns this off.",
"CHANNEL_PERMS.NOT_SYNCED": "Not synced with {{category}}",
"CHANNEL_PERMS.NOT_SYNCED_HINT": "{{count}} overrides differ from the category.",
"CHANNEL_PERMS.SEE_DIFFERENCE": "See the difference",
"CHANNEL_PERMS.RESYNC": "Re-sync",
"CHANNEL_PERMS.DIFF_TITLE": "What re-syncing would change",
"CHANNEL_PERMS.DIFF_ADDED": "added from the category",
"CHANNEL_PERMS.DIFF_REMOVED": "removed from this channel",
"CHANNEL_PERMS.DIFF_CHANGED": "replaced by the category's",
"CHANNEL_PERMS.ADVANCED": "Advanced permissions",
"CHANNEL_PERMS.ADVANCED_HINT": "Per-role and per-member overrides",
"CHANNEL_PERMS.OVERRIDE_COUNT": "{{count}} overrides"
```

Commit and push in the submodule first.

- [ ] **Step 10: Run the specs and the build**

Run: `bun run ng test --watch=false --include="**/permission-sync.spec.ts"`
Expected: PASS, 7 tests.

Run: `bun run ng test --watch=false --include="**/channel-permissions.page.spec.ts"`
Expected: PASS, 5 tests.

Run: `bun run ng build --configuration development`
Expected: success.

Run: `bun run test`
Expected: PASS, at or above baseline.

- [ ] **Step 11: Lint and format the touched files**

Run: `bun run lint`

Format only the files this plan touched. `bun run format` is `prettier --write .` and rewrites the whole repo:

```bash
bunx prettier --write "src/app/features/guild/shared/permission-*/**" "src/app/features/guild/components/channel-settings-modal/**" "src/app/enums/permissions.enum.ts" "src/app/services/guild.service.ts" "src/app/dtos/response/effective-permissions.dto.ts"
```

- [ ] **Step 12: Commit**

```bash
git add -- src/app/features/guild/shared/permission-sync.ts src/app/features/guild/shared/permission-sync.spec.ts src/app/features/guild/components/channel-settings-modal src/assets/i18n/locales
git commit -m "feat(permissions): open the channel page on private and category sync"
```

---

## Self-review notes

- **Spec coverage.** Section A is Task 8, B is Tasks 5 and 7, C is Task 3, D is Task 4. Sections E, F, G and H are deliberately not in this plan; they are the second client plan, `2026-08-20-channel-permissions-at-scale.md`.
- **Cut from the spec, on purpose.** The "last changed by" audit line. It needs an audit-log filter by channel, and the existing read is guild-wide and paged, so the entry may not be on the first page. Building it against that read would show a wrong name or nothing, at random.
- **The riskiest task is 7.** The trace describes the saved state while the editor shows a live edit. The `savedOverride` input is the whole guard against showing a ghost that contradicts what the user just did. If a case surfaces where a ghost still lies, prefer showing nothing.
- **Task 2 is a pure move.** If the Task 1 characterization tests do not pass unchanged against the merged component (bar renames), something behavioural has been altered and should be undone.
