# Permission Overrides Redesign + Create-Modal Enter-to-Submit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stacked-full-editor-per-role/member permission override UI (channel and category settings) with a Discord-style master-detail layout, and fix Enter-to-submit in the create-channel/create-category modals.

**Architecture:** One new presentational shared component (`PermissionOverridesPanelComponent`) renders a compact sidebar list (roles or members) plus a single detail panel for whichever entry is selected, with a popover-based "+" picker for adding new overrides. `channel-permissions` and `category-permissions` keep their existing state and API-call logic untouched, only feeding it through this shared component instead of rendering stacked cards directly.

**Tech Stack:** Angular 21 (signals, `@if`/`@for` control flow, signal `input()`/`output()`), PrimeNG 21 (`p-button`, `p-popover`), Tailwind CSS v4.

## Global Constraints

- Use `(onClick)` not `(click)` on `p-button`, per project convention.
- Sidebar/detail scroll regions use the existing `thin-scrollbar` CSS class — never repeat the inline scrollbar style.
- Font sizes use rem-based Tailwind classes (e.g. `text-[10px]` is already used elsewhere for these labels; keep consistent with sibling components).
- No new automated tests — this feature area has none (only one `.spec.ts` exists in the whole `guild` feature). Verify each task with `ng build` (type-checks templates across the whole `src` tree) and a final manual pass in the running app.
- Follow the approved spec at `docs/superpowers/specs/2026-07-27-permission-overrides-redesign-design.md`.

---

### Task 1: Shared `PermissionOverridesPanelComponent`

**Files:**
- Create: `src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.ts`
- Create: `src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.html`

**Interfaces:**
- Consumes: `PermOverride` and `app-permission-override-editor` from `../permission-override-editor/permission-override-editor.component` (unchanged).
- Produces (for Tasks 2 & 3):
  - `export interface OverrideEntry { id: string; name: string; color?: string; avatarUrl?: string | null; hasOverride: boolean; dirty: boolean; saving: boolean; pinned?: boolean; override: PermOverride; }`
  - Component selector `app-permission-overrides-panel` with inputs `entries: OverrideEntry[]` (required), `addable: OverrideEntry[]` (required), `kind: 'role' | 'member'` (required), `loading` (default `false`), and outputs `add: string`, `change: {id: string; override: PermOverride}`, `save: string`, `delete: string`.

- [ ] **Step 1: Write the component TypeScript**

`src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.ts`:

```ts
import {Component, computed, input, output, signal, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {Popover} from 'primeng/popover';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {
    PermissionOverrideEditorComponent,
    PermOverride,
} from '../permission-override-editor/permission-override-editor.component';

export interface OverrideEntry {
    id: string;
    name: string;
    color?: string;
    avatarUrl?: string | null;
    hasOverride: boolean;
    dirty: boolean;
    saving: boolean;
    pinned?: boolean;
    override: PermOverride;
}

@Component({
    selector: 'app-permission-overrides-panel',
    imports: [NgClass, Popover, Button, Tooltip, PermissionOverrideEditorComponent],
    templateUrl: './permission-overrides-panel.component.html',
})
export class PermissionOverridesPanelComponent {
    entries = input.required<OverrideEntry[]>();
    addable = input.required<OverrideEntry[]>();
    kind = input.required<'role' | 'member'>();
    loading = input(false);

    add = output<string>();
    change = output<{ id: string; override: PermOverride }>();
    save = output<string>();
    delete = output<string>();

    protected selectedId = signal<string | null>(null);
    protected selected = computed<OverrideEntry | null>(() => {
        const list = this.entries();
        if (list.length === 0) return null;
        return list.find(e => e.id === this.selectedId()) ?? list[0];
    });

    @ViewChild('addPopover') private addPopoverRef!: Popover;

    select(id: string): void {
        this.selectedId.set(id);
    }

    toggleAddPopover(event: Event): void {
        this.addPopoverRef.toggle(event);
    }

    onAdd(id: string): void {
        this.addPopoverRef.hide();
        this.selectedId.set(id);
        this.add.emit(id);
    }

    initial(name: string): string {
        return name.charAt(0).toUpperCase();
    }

    sidebarEmptyText(): string {
        return this.kind() === 'role' ? 'No roles in this server' : 'No member overrides yet';
    }

    detailPlaceholderText(): string {
        if (this.entries().length === 0) return this.sidebarEmptyText();
        return this.kind() === 'role' ? 'Select a role to edit its permissions' : 'Select a member to edit its permissions';
    }

    addableEmptyText(): string {
        return this.kind() === 'role' ? 'All roles have overrides' : 'No more members to add';
    }
}
```

- [ ] **Step 2: Write the component template**

`src/app/features/guild/shared/permission-overrides-panel/permission-overrides-panel.component.html`:

```html
@if (loading()) {
    <div class="h-[400px] flex items-center justify-center">
        <i class="pi pi-spin pi-spinner text-white/30 text-xl"></i>
    </div>
} @else {
    <div class="flex gap-4 h-[400px]">

        <!-- Sidebar -->
        <div class="w-44 shrink-0 flex flex-col gap-2">
            <div class="flex items-center justify-between px-1">
                <p class="text-[10px] font-semibold text-white/30 uppercase tracking-widest">
                    {{ kind() === 'role' ? 'Roles' : 'Members' }}
                </p>
                <button
                        (click)="toggleAddPopover($event)"
                        class="w-5 h-5 rounded-full flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/[0.08] transition-colors cursor-pointer border-0"
                        title="Add override">
                    <i class="pi pi-plus text-[10px]"></i>
                </button>
            </div>

            <div class="flex-1 min-h-0 overflow-y-auto thin-scrollbar space-y-0.5">
                @for (entry of entries(); track entry.id; let i = $index) {
                    @if (entry.pinned && i > 0) {
                        <div class="my-1 border-t border-white/[0.08]"></div>
                    }
                    <button
                            (click)="select(entry.id)"
                            [ngClass]="selected()?.id === entry.id ? 'bg-white/[0.08] text-white/90' : 'text-white/50 hover:bg-white/[0.04] hover:text-white/75'"
                            class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer border-0 text-left">
                        @if (kind() === 'role') {
                            <span [style.background]="entry.color || '#6366f1'" class="w-2.5 h-2.5 rounded-full shrink-0"></span>
                        } @else {
                            <div class="w-5 h-5 rounded-full bg-card shrink-0 flex items-center justify-center overflow-hidden">
                                @if (entry.avatarUrl) {
                                    <img [alt]="entry.name" [src]="entry.avatarUrl" class="w-full h-full object-cover"/>
                                } @else {
                                    <span class="text-[9px] font-semibold text-white/40">{{ initial(entry.name) }}</span>
                                }
                            </div>
                        }
                        <span class="truncate">{{ entry.name }}</span>
                    </button>
                }
                @if (entries().length === 0) {
                    <p class="text-xs text-white/25 text-center py-4">{{ sidebarEmptyText() }}</p>
                }
            </div>
        </div>

        <!-- Detail panel -->
        <div class="flex-1 min-w-0 border border-white/[0.10] rounded-2xl overflow-hidden flex flex-col">
            @if (selected(); as entry) {
                <div class="flex items-center gap-3 px-4 py-3 bg-white/[0.02] shrink-0">
                    @if (kind() === 'role') {
                        <span [style.background]="entry.color || '#6366f1'" class="w-3 h-3 rounded-full shrink-0"></span>
                    } @else {
                        <div class="w-7 h-7 rounded-full bg-card shrink-0 flex items-center justify-center overflow-hidden">
                            @if (entry.avatarUrl) {
                                <img [alt]="entry.name" [src]="entry.avatarUrl" class="w-full h-full object-cover"/>
                            } @else {
                                <span class="text-xs font-semibold text-white/40">{{ initial(entry.name) }}</span>
                            }
                        </div>
                    }
                    <span class="text-sm font-semibold text-white/80 flex-1 truncate">{{ entry.name }}</span>
                    @if (entry.hasOverride) {
                        <p-button (onClick)="delete.emit(entry.id)" [text]="true" icon="pi pi-trash" pTooltip="Remove override"
                                  severity="danger" size="small" tooltipPosition="top"/>
                    }
                    @if (entry.dirty) {
                        <p-button (onClick)="save.emit(entry.id)" [loading]="entry.saving" icon="pi pi-save" label="Save"
                                  severity="primary" size="small"/>
                    }
                </div>
                <div class="flex-1 overflow-y-auto thin-scrollbar px-4 py-3">
                    <app-permission-override-editor
                            (overrideChange)="change.emit({id: entry.id, override: $event})"
                            [override]="entry.override"/>
                </div>
            } @else {
                <div class="flex-1 flex items-center justify-center px-4">
                    <p class="text-sm text-white/25 text-center">{{ detailPlaceholderText() }}</p>
                </div>
            }
        </div>
    </div>
}

<p-popover #addPopover [style]="{width: '220px', padding: '0'}" appendTo="body" styleClass="permission-overrides-add-popover">
    <div class="max-h-64 overflow-y-auto thin-scrollbar py-1">
        @for (entry of addable(); track entry.id) {
            <button
                    (click)="onAdd(entry.id)"
                    class="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.06] transition-colors cursor-pointer border-0 text-left">
                @if (kind() === 'role') {
                    <span [style.background]="entry.color || '#6366f1'" class="w-2.5 h-2.5 rounded-full shrink-0"></span>
                } @else {
                    <div class="w-6 h-6 rounded-full bg-card shrink-0 flex items-center justify-center overflow-hidden">
                        @if (entry.avatarUrl) {
                            <img [alt]="entry.name" [src]="entry.avatarUrl" class="w-full h-full object-cover"/>
                        } @else {
                            <span class="text-[10px] font-semibold text-white/40">{{ initial(entry.name) }}</span>
                        }
                    </div>
                }
                <span class="text-sm text-white/70 truncate">{{ entry.name }}</span>
            </button>
        }
        @if (addable().length === 0) {
            <p class="text-xs text-white/25 text-center py-3 px-3">{{ addableEmptyText() }}</p>
        }
    </div>
</p-popover>
```

- [ ] **Step 3: Verify it compiles**

Run: `npx ng build`
Expected: build succeeds with no TypeScript or template errors (this component isn't wired into any parent yet, but `ng build` type-checks every component under `src/`).

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/shared/permission-overrides-panel
git commit -m "feat: add shared permission overrides master-detail panel"
```

---

### Task 2: Wire the panel into `channel-permissions`

**Files:**
- Modify: `src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.ts`
- Modify: `src/app/features/guild/components/channel-settings-modal/pages/channel-permissions/channel-permissions.component.html`

**Interfaces:**
- Consumes: `OverrideEntry`, `PermissionOverridesPanelComponent` from Task 1 (`../../../../shared/permission-overrides-panel/permission-overrides-panel.component`); `PermOverride` from `../../../../shared/permission-override-editor/permission-override-editor.component`; `RoleType` from `../../../../../../dtos/response/guild.dto`.
- Produces: no change to the component's public inputs (`channel`, `guild`); internal methods `saveRoleOverride`, `deleteRoleOverride`, `saveMemberOverride`, `deleteMemberOverride` now take an `id: string` instead of a full row object — this is a breaking signature change but these methods are only called from this component's own template.

- [ ] **Step 1: Replace the component TypeScript**

Replace the full contents of `channel-permissions.component.ts` with:

```ts
import {Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {ChannelDto, ChannelPermission, GuildDto, RoleDto, RoleType,} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {
    OverrideEntry,
    PermissionOverridesPanelComponent,
} from '../../../../shared/permission-overrides-panel/permission-overrides-panel.component';
import {PermOverride} from '../../../../shared/permission-override-editor/permission-override-editor.component';
import {parsePermissions, stringifyPermissions} from '../../../../../../enums/permissions.enum';
import {TranslateModule} from '@ngx-translate/core';

interface RoleOverride {
    role: RoleDto;
    perm: ChannelPermission | null;
    override: PermOverride;
    dirty: boolean;
    saving: boolean;
}

interface MemberOverride {
    member: GuildMemberDto;
    profile: ProfileDto | null;
    perm: ChannelPermission | null;
    override: PermOverride;
    dirty: boolean;
    saving: boolean;
}

@Component({
    selector: 'app-channel-permissions',
    imports: [NgClass, PermissionOverridesPanelComponent, TranslateModule],
    templateUrl: './channel-permissions.component.html',
})
export class ChannelPermissionsComponent implements OnInit {
    channel = input.required<ChannelDto>();
    guild = input.required<GuildDto>();
    activeTab = signal<'roles' | 'members'>('roles');
    roleOverrides = signal<RoleOverride[]>([]);
    memberOverrides = signal<MemberOverride[]>([]);
    membersLoading = signal(false);
    readonly emptyOverride: PermOverride = {allow: 0n, deny: 0n};
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);

    protected roleEntries = computed<OverrideEntry[]>(() => {
        const everyoneId = this.everyoneRoleId();
        const rows = this.roleOverrides();
        const overridden = rows
            .filter(r => (r.perm !== null || r.dirty) && r.role.id !== everyoneId)
            .map(r => this.toRoleEntry(r, false));
        const everyone = rows.find(r => r.role.id === everyoneId);
        return everyone ? [...overridden, this.toRoleEntry(everyone, true)] : overridden;
    });

    protected addableRoles = computed<OverrideEntry[]>(() => {
        const everyoneId = this.everyoneRoleId();
        return this.roleOverrides()
            .filter(r => r.perm === null && !r.dirty && r.role.id !== everyoneId)
            .map(r => this.toRoleEntry(r, false));
    });

    protected memberEntries = computed<OverrideEntry[]>(() =>
        this.memberOverrides()
            .filter(r => r.perm !== null || r.dirty)
            .map(r => this.toMemberEntry(r))
    );

    protected addableMembers = computed<OverrideEntry[]>(() =>
        this.memberOverrides()
            .filter(r => r.perm === null && !r.dirty)
            .map(r => this.toMemberEntry(r))
    );

    ngOnInit(): void {
        this.buildRoleOverrides();
    }

    switchTab(tab: 'roles' | 'members'): void {
        this.activeTab.set(tab);
        if (tab === 'members' && this.memberOverrides().length === 0) {
            this.loadMembers();
        }
    }

    onRoleOverrideChange(roleId: string, ov: PermOverride): void {
        this.roleOverrides.update(list =>
            list.map(r => r.role.id === roleId
                ? {...r, override: ov, dirty: true}
                : r
            )
        );
    }

    onAddRoleOverride(roleId: string): void {
        this.onRoleOverrideChange(roleId, this.emptyOverride);
    }

    saveRoleOverride(roleId: string): void {
        const row = this.roleOverrides().find(r => r.role.id === roleId);
        if (!row || row.saving) return;
        this.roleOverrides.update(list => list.map(r => r.role.id === roleId ? {...r, saving: true} : r));
        this.guildService.upsertChannelRolePermission(this.channel().id, roleId, {
            allowPermissions: stringifyPermissions(row.override.allow),
            denyPermissions: stringifyPermissions(row.override.deny),
        }).subscribe({
            next: perm => {
                this.roleOverrides.update(list =>
                    list.map(r => r.role.id === roleId ? {...r, perm, dirty: false, saving: false} : r)
                );
            },
            error: () => {
                this.roleOverrides.update(list => list.map(r => r.role.id === roleId ? {...r, saving: false} : r));
            },
        });
    }

    deleteRoleOverride(roleId: string): void {
        const row = this.roleOverrides().find(r => r.role.id === roleId);
        if (!row?.perm) return;
        this.guildService.deleteChannelRolePermission(this.channel().id, roleId).subscribe({
            next: () => {
                this.roleOverrides.update(list =>
                    list.map(r => r.role.id === roleId
                        ? {...r, perm: null, override: {allow: 0n, deny: 0n}, dirty: false}
                        : r
                    )
                );
            },
        });
    }

    onMemberOverrideChange(memberId: string, ov: PermOverride): void {
        this.memberOverrides.update(list =>
            list.map(r => r.member.id === memberId ? {...r, override: ov, dirty: true} : r)
        );
    }

    onAddMemberOverride(memberId: string): void {
        this.onMemberOverrideChange(memberId, this.emptyOverride);
    }

    saveMemberOverride(memberId: string): void {
        const row = this.memberOverrides().find(r => r.member.id === memberId);
        if (!row || row.saving) return;
        this.memberOverrides.update(list => list.map(r => r.member.id === memberId ? {...r, saving: true} : r));
        this.guildService.upsertChannelMemberPermission(this.channel().id, memberId, {
            allowPermissions: stringifyPermissions(row.override.allow),
            denyPermissions: stringifyPermissions(row.override.deny),
        }).subscribe({
            next: perm => {
                this.memberOverrides.update(list =>
                    list.map(r => r.member.id === memberId ? {...r, perm, dirty: false, saving: false} : r)
                );
            },
            error: () => {
                this.memberOverrides.update(list => list.map(r => r.member.id === memberId ? {
                    ...r,
                    saving: false
                } : r));
            },
        });
    }

    deleteMemberOverride(memberId: string): void {
        const row = this.memberOverrides().find(r => r.member.id === memberId);
        if (!row?.perm) return;
        this.guildService.deleteChannelMemberPermission(this.channel().id, memberId).subscribe({
            next: () => {
                this.memberOverrides.update(list =>
                    list.map(r => r.member.id === memberId
                        ? {...r, perm: null, override: {allow: 0n, deny: 0n}, dirty: false}
                        : r
                    )
                );
            },
        });
    }

    private everyoneRoleId(): string | undefined {
        return this.guild().roles.find(r => r.type === RoleType.Everyone)?.id;
    }

    private toRoleEntry(row: RoleOverride, pinned: boolean): OverrideEntry {
        return {
            id: row.role.id,
            name: row.role.name,
            color: row.role.color,
            hasOverride: row.perm !== null,
            dirty: row.dirty,
            saving: row.saving,
            pinned,
            override: row.override,
        };
    }

    private toMemberEntry(row: MemberOverride): OverrideEntry {
        return {
            id: row.member.id,
            name: this.memberDisplayName(row),
            avatarUrl: row.profile?.avatarUrl ?? null,
            hasOverride: row.perm !== null,
            dirty: row.dirty,
            saving: row.saving,
            override: row.override,
        };
    }

    private memberDisplayName(row: MemberOverride): string {
        return row.profile?.userName ?? row.member.userId.slice(0, 8) + '…';
    }

    private buildRoleOverrides(): void {
        const overrides = this.channel().permissions;
        const rows: RoleOverride[] = this.guild().roles.map(role => {
            const perm = overrides.find(p => p.roleId === role.id) ?? null;
            return {
                role,
                perm,
                override: {
                    allow: perm ? parsePermissions(perm.allowPermissions) : 0n,
                    deny: perm ? parsePermissions(perm.denyPermissions) : 0n,
                },
                dirty: false,
                saving: false,
            };
        });
        this.roleOverrides.set(rows);
    }

    private loadMembers(): void {
        this.membersLoading.set(true);
        this.guildService.getMembers(this.guild().id, 0, 1000).subscribe({
            next: members => {
                const overrides = this.channel().permissions;
                const rows: MemberOverride[] = members.map(m => {
                    const perm = overrides.find(p => p.memberId === m.id) ?? null;
                    const row: MemberOverride = {
                        member: m,
                        profile: null,
                        perm,
                        override: {
                            allow: perm ? parsePermissions(perm.allowPermissions) : 0n,
                            deny: perm ? parsePermissions(perm.denyPermissions) : 0n,
                        },
                        dirty: false,
                        saving: false,
                    };
                    return row;
                });
                this.memberOverrides.set(rows);
                this.membersLoading.set(false);
                rows.forEach((row, i) => {
                    this.profileService.fetchByUserId(row.member.userId).subscribe({
                        next: p => {
                            this.memberOverrides.update(list => {
                                const next = [...list];
                                next[i] = {...next[i], profile: p};
                                return next;
                            });
                        },
                    });
                });
            },
            error: () => this.membersLoading.set(false),
        });
    }
}
```

- [ ] **Step 2: Replace the component template**

Replace the full contents of `channel-permissions.component.html` with:

```html
<div class="space-y-4">

    <p class="text-xs text-white/35">
        Permission overrides let you grant or deny specific permissions for roles and members,
        overriding the server-wide defaults.
    </p>

    <!-- Tabs -->
    <div class="flex gap-1 p-1 bg-white/[0.04] rounded-xl w-fit">
        <button
                (click)="switchTab('roles')"
                [ngClass]="activeTab() === 'roles' ? 'bg-white/[0.08] text-white/85' : 'text-white/40'"
                class="px-4 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer border-0">
            Roles
        </button>
        <button
                (click)="switchTab('members')"
                [ngClass]="activeTab() === 'members' ? 'bg-white/[0.08] text-white/85' : 'text-white/40'"
                class="px-4 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer border-0">
            Members
        </button>
    </div>

    <!-- Roles Tab -->
    @if (activeTab() === 'roles') {
        <app-permission-overrides-panel
                (add)="onAddRoleOverride($event)"
                (change)="onRoleOverrideChange($event.id, $event.override)"
                (delete)="deleteRoleOverride($event)"
                (save)="saveRoleOverride($event)"
                [addable]="addableRoles()"
                [entries]="roleEntries()"
                kind="role"/>
    }

    <!-- Members Tab -->
    @if (activeTab() === 'members') {
        <app-permission-overrides-panel
                (add)="onAddMemberOverride($event)"
                (change)="onMemberOverrideChange($event.id, $event.override)"
                (delete)="deleteMemberOverride($event)"
                (save)="saveMemberOverride($event)"
                [addable]="addableMembers()"
                [entries]="memberEntries()"
                [loading]="membersLoading()"
                kind="member"/>
    }
</div>
```

- [ ] **Step 3: Verify it compiles**

Run: `npx ng build`
Expected: build succeeds with no TypeScript or template errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/channel-settings-modal/pages/channel-permissions
git commit -m "feat: redesign channel permission overrides into master-detail layout"
```

---

### Task 3: Wire the panel into `category-permissions`

**Files:**
- Modify: `src/app/features/guild/components/category-settings-modal/pages/category-permissions/category-permissions.component.ts`
- Modify: `src/app/features/guild/components/category-settings-modal/pages/category-permissions/category-permissions.component.html`

**Interfaces:**
- Consumes: same `OverrideEntry` / `PermissionOverridesPanelComponent` / `PermOverride` / `RoleType` as Task 2.
- Produces: no change to public inputs (`category`, `guild`); `saveRole`, `deleteRole`, `saveMember`, `deleteMember` now take an `id: string`.

- [ ] **Step 1: Replace the component TypeScript**

Replace the full contents of `category-permissions.component.ts` with:

```ts
import {Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {CategoryDto, ChannelPermission, GuildDto, RoleDto, RoleType} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {
    OverrideEntry,
    PermissionOverridesPanelComponent,
} from '../../../../shared/permission-overrides-panel/permission-overrides-panel.component';
import {PermOverride} from '../../../../shared/permission-override-editor/permission-override-editor.component';
import {parsePermissions, stringifyPermissions} from '../../../../../../enums/permissions.enum';
import {TranslateModule} from '@ngx-translate/core';

interface RoleOverride {
    role: RoleDto;
    perm: ChannelPermission | null;
    override: PermOverride;
    dirty: boolean;
    saving: boolean;
}

interface MemberOverride {
    member: GuildMemberDto;
    profile: ProfileDto | null;
    perm: ChannelPermission | null;
    override: PermOverride;
    dirty: boolean;
    saving: boolean;
}

@Component({
    selector: 'app-category-permissions',
    imports: [NgClass, PermissionOverridesPanelComponent, TranslateModule],
    templateUrl: './category-permissions.component.html',
})
export class CategoryPermissionsComponent implements OnInit {
    category = input.required<CategoryDto>();
    guild = input.required<GuildDto>();
    activeTab = signal<'roles' | 'members'>('roles');
    roleOverrides = signal<RoleOverride[]>([]);
    memberOverrides = signal<MemberOverride[]>([]);
    membersLoading = signal(false);
    readonly emptyOverride: PermOverride = {allow: 0n, deny: 0n};
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);

    protected roleEntries = computed<OverrideEntry[]>(() => {
        const everyoneId = this.everyoneRoleId();
        const rows = this.roleOverrides();
        const overridden = rows
            .filter(r => (r.perm !== null || r.dirty) && r.role.id !== everyoneId)
            .map(r => this.toRoleEntry(r, false));
        const everyone = rows.find(r => r.role.id === everyoneId);
        return everyone ? [...overridden, this.toRoleEntry(everyone, true)] : overridden;
    });

    protected addableRoles = computed<OverrideEntry[]>(() => {
        const everyoneId = this.everyoneRoleId();
        return this.roleOverrides()
            .filter(r => r.perm === null && !r.dirty && r.role.id !== everyoneId)
            .map(r => this.toRoleEntry(r, false));
    });

    protected memberEntries = computed<OverrideEntry[]>(() =>
        this.memberOverrides()
            .filter(r => r.perm !== null || r.dirty)
            .map(r => this.toMemberEntry(r))
    );

    protected addableMembers = computed<OverrideEntry[]>(() =>
        this.memberOverrides()
            .filter(r => r.perm === null && !r.dirty)
            .map(r => this.toMemberEntry(r))
    );

    ngOnInit(): void {
        this.buildRoleOverrides();
    }

    switchTab(tab: 'roles' | 'members'): void {
        this.activeTab.set(tab);
        if (tab === 'members' && this.memberOverrides().length === 0) {
            this.loadMembers();
        }
    }

    onRoleChange(roleId: string, ov: PermOverride): void {
        this.roleOverrides.update(list =>
            list.map(r => r.role.id === roleId ? {...r, override: ov, dirty: true} : r)
        );
    }

    onAddRole(roleId: string): void {
        this.onRoleChange(roleId, this.emptyOverride);
    }

    saveRole(roleId: string): void {
        const row = this.roleOverrides().find(r => r.role.id === roleId);
        if (!row || row.saving) return;
        this.roleOverrides.update(list => list.map(r => r.role.id === roleId ? {...r, saving: true} : r));
        this.guildService.upsertCategoryRolePermission(this.category().id, roleId, {
            allowPermissions: stringifyPermissions(row.override.allow),
            denyPermissions: stringifyPermissions(row.override.deny),
        }).subscribe({
            next: perm => {
                this.roleOverrides.update(list =>
                    list.map(r => r.role.id === roleId ? {...r, perm, dirty: false, saving: false} : r)
                );
            },
            error: () => this.roleOverrides.update(list => list.map(r => r.role.id === roleId ? {
                ...r,
                saving: false
            } : r)),
        });
    }

    deleteRole(roleId: string): void {
        const row = this.roleOverrides().find(r => r.role.id === roleId);
        if (!row?.perm) return;
        this.guildService.deleteCategoryRolePermission(this.category().id, roleId).subscribe({
            next: () => {
                this.roleOverrides.update(list =>
                    list.map(r => r.role.id === roleId ? {
                        ...r,
                        perm: null,
                        override: {allow: 0n, deny: 0n},
                        dirty: false
                    } : r)
                );
            },
        });
    }

    onMemberChange(memberId: string, ov: PermOverride): void {
        this.memberOverrides.update(list =>
            list.map(r => r.member.id === memberId ? {...r, override: ov, dirty: true} : r)
        );
    }

    onAddMember(memberId: string): void {
        this.onMemberChange(memberId, this.emptyOverride);
    }

    saveMember(memberId: string): void {
        const row = this.memberOverrides().find(r => r.member.id === memberId);
        if (!row || row.saving) return;
        this.memberOverrides.update(list => list.map(r => r.member.id === memberId ? {...r, saving: true} : r));
        this.guildService.upsertCategoryMemberPermission(this.category().id, memberId, {
            allowPermissions: stringifyPermissions(row.override.allow),
            denyPermissions: stringifyPermissions(row.override.deny),
        }).subscribe({
            next: perm => {
                this.memberOverrides.update(list =>
                    list.map(r => r.member.id === memberId ? {...r, perm, dirty: false, saving: false} : r)
                );
            },
            error: () => this.memberOverrides.update(list => list.map(r => r.member.id === memberId ? {
                ...r,
                saving: false
            } : r)),
        });
    }

    deleteMember(memberId: string): void {
        const row = this.memberOverrides().find(r => r.member.id === memberId);
        if (!row?.perm) return;
        this.guildService.deleteCategoryMemberPermission(this.category().id, memberId).subscribe({
            next: () => {
                this.memberOverrides.update(list =>
                    list.map(r => r.member.id === memberId ? {
                        ...r,
                        perm: null,
                        override: {allow: 0n, deny: 0n},
                        dirty: false
                    } : r)
                );
            },
        });
    }

    private everyoneRoleId(): string | undefined {
        return this.guild().roles.find(r => r.type === RoleType.Everyone)?.id;
    }

    private toRoleEntry(row: RoleOverride, pinned: boolean): OverrideEntry {
        return {
            id: row.role.id,
            name: row.role.name,
            color: row.role.color,
            hasOverride: row.perm !== null,
            dirty: row.dirty,
            saving: row.saving,
            pinned,
            override: row.override,
        };
    }

    private toMemberEntry(row: MemberOverride): OverrideEntry {
        return {
            id: row.member.id,
            name: this.memberName(row),
            avatarUrl: row.profile?.avatarUrl ?? null,
            hasOverride: row.perm !== null,
            dirty: row.dirty,
            saving: row.saving,
            override: row.override,
        };
    }

    private memberName(row: MemberOverride): string {
        return row.profile?.userName ?? row.member.userId.slice(0, 8) + '…';
    }

    private buildRoleOverrides(): void {
        const overrides = this.category().permissions;
        this.roleOverrides.set(
            this.guild().roles.map(role => {
                const perm = overrides.find(p => p.roleId === role.id) ?? null;
                return {
                    role,
                    perm,
                    override: {
                        allow: perm ? parsePermissions(perm.allowPermissions) : 0n,
                        deny: perm ? parsePermissions(perm.denyPermissions) : 0n,
                    },
                    dirty: false,
                    saving: false,
                };
            })
        );
    }

    private loadMembers(): void {
        this.membersLoading.set(true);
        this.guildService.getMembers(this.guild().id, 0, 1000).subscribe({
            next: members => {
                const overrides = this.category().permissions;
                this.memberOverrides.set(
                    members.map(m => {
                        const perm = overrides.find(p => p.memberId === m.id) ?? null;
                        return {
                            member: m,
                            profile: null,
                            perm,
                            override: {
                                allow: perm ? parsePermissions(perm.allowPermissions) : 0n,
                                deny: perm ? parsePermissions(perm.denyPermissions) : 0n,
                            },
                            dirty: false,
                            saving: false,
                        };
                    })
                );
                this.membersLoading.set(false);
                this.memberOverrides().forEach((row, i) => {
                    this.profileService.fetchByUserId(row.member.userId).subscribe({
                        next: p => this.memberOverrides.update(list => {
                            const next = [...list];
                            next[i] = {...next[i], profile: p};
                            return next;
                        }),
                    });
                });
            },
            error: () => this.membersLoading.set(false),
        });
    }
}
```

- [ ] **Step 2: Replace the component template**

Replace the full contents of `category-permissions.component.html` with:

```html
<div class="space-y-4">

    <p class="text-xs text-white/35">
        Permissions set here apply to all channels within this category, unless overridden per channel.
    </p>

    <!-- Tabs -->
    <div class="flex gap-1 p-1 bg-white/[0.04] rounded-xl w-fit">
        <button
                (click)="switchTab('roles')"
                [ngClass]="activeTab() === 'roles' ? 'bg-white/[0.08] text-white/85' : 'text-white/40'"
                class="px-4 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer border-0">
            Roles
        </button>
        <button
                (click)="switchTab('members')"
                [ngClass]="activeTab() === 'members' ? 'bg-white/[0.08] text-white/85' : 'text-white/40'"
                class="px-4 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer border-0">
            Members
        </button>
    </div>

    @if (activeTab() === 'roles') {
        <app-permission-overrides-panel
                (add)="onAddRole($event)"
                (change)="onRoleChange($event.id, $event.override)"
                (delete)="deleteRole($event)"
                (save)="saveRole($event)"
                [addable]="addableRoles()"
                [entries]="roleEntries()"
                kind="role"/>
    }

    @if (activeTab() === 'members') {
        <app-permission-overrides-panel
                (add)="onAddMember($event)"
                (change)="onMemberChange($event.id, $event.override)"
                (delete)="deleteMember($event)"
                (save)="saveMember($event)"
                [addable]="addableMembers()"
                [entries]="memberEntries()"
                [loading]="membersLoading()"
                kind="member"/>
    }
</div>
```

- [ ] **Step 3: Verify it compiles**

Run: `npx ng build`
Expected: build succeeds with no TypeScript or template errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/category-settings-modal/pages/category-permissions
git commit -m "feat: redesign category permission overrides into master-detail layout"
```

---

### Task 4: Enter-to-submit in create-channel and create-category modals

**Files:**
- Modify: `src/app/features/guild/components/channel-list/components/create-channel-modal/create-channel-modal.component.html`
- Modify: `src/app/features/guild/components/channel-list/components/create-category-modal/create-category-modal.component.html`

**Interfaces:**
- Consumes: existing `submit()` method on both components (unchanged — already guards on empty name / in-flight creation).
- Produces: no new interfaces.

- [ ] **Step 1: Add the Enter handler to create-channel-modal**

In `create-channel-modal.component.html`, the name `<input>` currently reads:

```html
                <input (input)="onNameInput($event)"
                       [value]="name()"
                       [placeholder]="'GUILD.CHANNEL_NAME_PLACEHOLDER' | translate"
                       class="w-full !pl-8"
                       pInputText/>
```

Change it to:

```html
                <input (input)="onNameInput($event)"
                       (keydown.enter)="submit()"
                       [value]="name()"
                       [placeholder]="'GUILD.CHANNEL_NAME_PLACEHOLDER' | translate"
                       class="w-full !pl-8"
                       pInputText/>
```

- [ ] **Step 2: Add the Enter handler to create-category-modal**

In `create-category-modal.component.html`, the name `<input>` currently reads:

```html
            <input (ngModelChange)="name.set($event)"
                   [ngModel]="name()"
                   [placeholder]="'GUILD.CATEGORY_NAME_PLACEHOLDER' | translate"
                   class="w-full"
                   pInputText/>
```

Change it to:

```html
            <input (ngModelChange)="name.set($event)"
                   (keydown.enter)="submit()"
                   [ngModel]="name()"
                   [placeholder]="'GUILD.CATEGORY_NAME_PLACEHOLDER' | translate"
                   class="w-full"
                   pInputText/>
```

- [ ] **Step 3: Verify it compiles**

Run: `npx ng build`
Expected: build succeeds with no TypeScript or template errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/guild/components/channel-list/components/create-channel-modal/create-channel-modal.component.html src/app/features/guild/components/channel-list/components/create-category-modal/create-category-modal.component.html
git commit -m "fix: submit create-channel and create-category modals on Enter"
```

---

### Task 5: Manual verification

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run: `npm start` (or use the project's `run` skill if available) and open the app.

- [ ] **Step 2: Verify channel permissions**

Open a text channel's settings → Advanced Permissions:
- Roles tab shows a compact list on the left with `@everyone` pinned at the bottom behind a divider, and a detail panel on the right showing the selected role's grouped permissions.
- Click the "+" button, pick a role from the popover — it's added, marked dirty, and selected in the detail panel.
- Toggle a permission to Allow/Deny, confirm the Save button appears, save it, confirm it persists (no longer dirty, Delete button now visible).
- Delete the override, confirm it disappears from the sidebar (unless it's the pinned `@everyone` entry, which stays but loses its Delete button).
- Switch to the Members tab, confirm the spinner shows while loading, then repeat the add/edit/save/delete flow for a member.

- [ ] **Step 3: Verify category permissions**

Repeat Step 2 for a category's settings → Advanced Permissions (Roles and Members tabs).

- [ ] **Step 4: Verify Enter-to-submit**

Open "Create Channel", type a name, press Enter — confirm the channel is created and the modal closes. Repeat for "Create Category".

- [ ] **Step 5: Final full build**

Run: `npx ng build`
Expected: build succeeds.
