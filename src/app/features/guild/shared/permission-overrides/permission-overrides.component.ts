import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    input,
    OnInit,
    output,
    signal,
} from '@angular/core';
import {NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelPermission, GuildDto, RoleDto, RoleType} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../dtos/response/member.dto';
import {ProfileDto} from '../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {parsePermissions, stringifyPermissions} from '../../../../enums/permissions.enum';
import {parseModulePermissions} from '../../../../enums/module-permissions.enum';
import {
    OverrideEntry,
    PermissionOverridesPanelComponent,
} from '../permission-overrides-panel/permission-overrides-panel.component';
import {
    EMPTY_OVERRIDE,
    PermOverride,
} from '../permission-override-editor/permission-override-editor.component';
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
        this.memberRows()
            .filter(r => r.perm !== null || r.dirty)
            .map(r => this.toMemberEntry(r)),
    );

    protected readonly addableMembers = computed<OverrideEntry[]>(() =>
        this.memberRows()
            .filter(r => r.perm === null && !r.dirty)
            .map(r => this.toMemberEntry(r)),
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
        this.gateway
            .upsert(
                this.scope(),
                {kind: 'role', id: roleId} satisfies OverrideTarget,
                this.body(row.override),
            )
            .subscribe({
                next: perm => {
                    this.roleRows.update(list =>
                        list.map(r =>
                            r.subject.id === roleId ? {...r, perm, dirty: false, saving: false} : r,
                        ),
                    );
                    this.emitOverrides();
                },
                error: () => this.setRoleSaving(roleId, false),
            });
    }

    deleteRole(roleId: string): void {
        const row = this.roleRows().find(r => r.subject.id === roleId);
        if (!row?.perm) return;

        this.gateway.remove(this.scope(), {kind: 'role', id: roleId} satisfies OverrideTarget).subscribe({
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
        this.gateway
            .upsert(
                this.scope(),
                {kind: 'member', id: memberId} satisfies OverrideTarget,
                this.body(row.override),
            )
            .subscribe({
                next: perm => {
                    this.memberRows.update(list =>
                        list.map(r =>
                            r.subject.id === memberId ? {...r, perm, dirty: false, saving: false} : r,
                        ),
                    );
                    this.emitOverrides();
                },
                error: () => this.setMemberSaving(memberId, false),
            });
    }

    deleteMember(memberId: string): void {
        const row = this.memberRows().find(r => r.subject.id === memberId);
        if (!row?.perm) return;

        this.gateway.remove(this.scope(), {kind: 'member', id: memberId} satisfies OverrideTarget).subscribe({
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
        const rows = [...this.roleRows().map(r => r.perm), ...this.memberRows().map(r => r.perm)].filter(
            (p): p is ChannelPermission => p !== null,
        );
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
