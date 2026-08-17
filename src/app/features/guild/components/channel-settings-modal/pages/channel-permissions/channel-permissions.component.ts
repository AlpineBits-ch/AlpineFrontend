import {Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {
    ChannelDto,
    ChannelPermission,
    GuildDto,
    RoleDto,
    RoleType,
} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {
    OverrideEntry,
    PermissionOverridesPanelComponent,
} from '../../../../shared/permission-overrides-panel/permission-overrides-panel.component';
import {
    EMPTY_OVERRIDE,
    PermOverride,
} from '../../../../shared/permission-override-editor/permission-override-editor.component';
import {parsePermissions, stringifyPermissions} from '../../../../../../enums/permissions.enum';
import {parseModulePermissions} from '../../../../../../enums/module-permissions.enum';
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
    readonly channel = input.required<ChannelDto>();
    readonly guild = input.required<GuildDto>();
    readonly activeTab = signal<'roles' | 'members'>('roles');
    readonly roleOverrides = signal<RoleOverride[]>([]);
    readonly memberOverrides = signal<MemberOverride[]>([]);
    readonly membersLoading = signal(false);
    readonly emptyOverride: PermOverride = EMPTY_OVERRIDE;
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);

    protected readonly roleEntries = computed<OverrideEntry[]>(() => {
        const everyoneId = this.everyoneRoleId();
        const rows = this.roleOverrides();
        const overridden = rows
            .filter(r => (r.perm !== null || r.dirty) && r.role.id !== everyoneId)
            .map(r => this.toRoleEntry(r, false));
        const everyone = rows.find(r => r.role.id === everyoneId);
        return everyone ? [...overridden, this.toRoleEntry(everyone, true)] : overridden;
    });

    protected readonly addableRoles = computed<OverrideEntry[]>(() => {
        const everyoneId = this.everyoneRoleId();
        return this.roleOverrides()
            .filter(r => r.perm === null && !r.dirty && r.role.id !== everyoneId)
            .map(r => this.toRoleEntry(r, false));
    });

    protected readonly memberEntries = computed<OverrideEntry[]>(() =>
        this.memberOverrides()
            .filter(r => r.perm !== null || r.dirty)
            .map(r => this.toMemberEntry(r)),
    );

    protected readonly addableMembers = computed<OverrideEntry[]>(() =>
        this.memberOverrides()
            .filter(r => r.perm === null && !r.dirty)
            .map(r => this.toMemberEntry(r)),
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
            list.map(r => (r.role.id === roleId ? {...r, override: ov, dirty: true} : r)),
        );
    }

    onAddRoleOverride(roleId: string): void {
        this.onRoleOverrideChange(roleId, this.emptyOverride);
    }

    saveRoleOverride(roleId: string): void {
        const row = this.roleOverrides().find(r => r.role.id === roleId);
        if (!row || row.saving) return;
        this.roleOverrides.update(list => list.map(r => (r.role.id === roleId ? {...r, saving: true} : r)));
        this.guildService
            .upsertChannelRolePermission(this.channel().id, roleId, {
                allowPermissions: stringifyPermissions(row.override.allow),
                denyPermissions: stringifyPermissions(row.override.deny),
            })
            .subscribe({
                next: perm => {
                    this.roleOverrides.update(list =>
                        list.map(r => (r.role.id === roleId ? {...r, perm, dirty: false, saving: false} : r)),
                    );
                },
                error: () => {
                    this.roleOverrides.update(list =>
                        list.map(r => (r.role.id === roleId ? {...r, saving: false} : r)),
                    );
                },
            });
    }

    deleteRoleOverride(roleId: string): void {
        const row = this.roleOverrides().find(r => r.role.id === roleId);
        if (!row?.perm) return;
        this.guildService.deleteChannelRolePermission(this.channel().id, roleId).subscribe({
            next: () => {
                this.roleOverrides.update(list =>
                    list.map(r =>
                        r.role.id === roleId ? {...r, perm: null, override: EMPTY_OVERRIDE, dirty: false} : r,
                    ),
                );
            },
        });
    }

    onMemberOverrideChange(memberId: string, ov: PermOverride): void {
        this.memberOverrides.update(list =>
            list.map(r => (r.member.id === memberId ? {...r, override: ov, dirty: true} : r)),
        );
    }

    onAddMemberOverride(memberId: string): void {
        this.onMemberOverrideChange(memberId, this.emptyOverride);
    }

    saveMemberOverride(memberId: string): void {
        const row = this.memberOverrides().find(r => r.member.id === memberId);
        if (!row || row.saving) return;
        this.memberOverrides.update(list =>
            list.map(r => (r.member.id === memberId ? {...r, saving: true} : r)),
        );
        this.guildService
            .upsertChannelMemberPermission(this.channel().id, memberId, {
                allowPermissions: stringifyPermissions(row.override.allow),
                denyPermissions: stringifyPermissions(row.override.deny),
            })
            .subscribe({
                next: perm => {
                    this.memberOverrides.update(list =>
                        list.map(r =>
                            r.member.id === memberId ? {...r, perm, dirty: false, saving: false} : r,
                        ),
                    );
                },
                error: () => {
                    this.memberOverrides.update(list =>
                        list.map(r =>
                            r.member.id === memberId
                                ? {
                                      ...r,
                                      saving: false,
                                  }
                                : r,
                        ),
                    );
                },
            });
    }

    deleteMemberOverride(memberId: string): void {
        const row = this.memberOverrides().find(r => r.member.id === memberId);
        if (!row?.perm) return;
        this.guildService.deleteChannelMemberPermission(this.channel().id, memberId).subscribe({
            next: () => {
                this.memberOverrides.update(list =>
                    list.map(r =>
                        r.member.id === memberId
                            ? {...r, perm: null, override: EMPTY_OVERRIDE, dirty: false}
                            : r,
                    ),
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
                    allowModule: parseModulePermissions(perm?.allowModulePermissions),
                    denyModule: parseModulePermissions(perm?.denyModulePermissions),
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
                            allowModule: parseModulePermissions(perm?.allowModulePermissions),
                            denyModule: parseModulePermissions(perm?.denyModulePermissions),
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
