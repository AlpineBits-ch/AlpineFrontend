import {Component, inject, input, OnInit, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {
  ChannelDto,
  ChannelPermission,
  GuildDto,
  RoleDto,
} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {
  PermOverride,
  PermissionOverrideEditorComponent,
} from '../../../../shared/permission-override-editor/permission-override-editor.component';
import {parsePermissions, stringifyPermissions} from '../../../../../../enums/permissions.enum';

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
  imports: [NgClass, Button, Tooltip, PermissionOverrideEditorComponent],
  templateUrl: './channel-permissions.component.html',
})
export class ChannelPermissionsComponent implements OnInit {
  channel = input.required<ChannelDto>();
  guild = input.required<GuildDto>();

  private guildService = inject(GuildService);
  private profileService = inject(ProfileService);

  activeTab = signal<'roles' | 'members'>('roles');
  roleOverrides = signal<RoleOverride[]>([]);
  memberOverrides = signal<MemberOverride[]>([]);
  membersLoading = signal(false);

  addRoleDialog = signal(false);
  addMemberDialog = signal(false);
  members = signal<GuildMemberDto[]>([]);

  ngOnInit(): void {
    this.buildRoleOverrides();
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

  switchTab(tab: 'roles' | 'members'): void {
    this.activeTab.set(tab);
    if (tab === 'members' && this.memberOverrides().length === 0) {
      this.loadMembers();
    }
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

  onRoleOverrideChange(roleId: string, ov: PermOverride): void {
    this.roleOverrides.update(list =>
      list.map(r => r.role.id === roleId
        ? {...r, override: ov, dirty: true}
        : r
      )
    );
  }

  saveRoleOverride(row: RoleOverride): void {
    if (row.saving) return;
    this.roleOverrides.update(list => list.map(r => r.role.id === row.role.id ? {...r, saving: true} : r));
    this.guildService.upsertChannelPermission(this.channel().id, {
      roleId: row.role.id,
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

  deleteRoleOverride(row: RoleOverride): void {
    if (!row.perm) return;
    this.guildService.deleteChannelPermission(this.channel().id, row.perm.id).subscribe({
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

  onMemberOverrideChange(memberId: string, ov: PermOverride): void {
    this.memberOverrides.update(list =>
      list.map(r => r.member.id === memberId ? {...r, override: ov, dirty: true} : r)
    );
  }

  saveMemberOverride(row: MemberOverride): void {
    if (row.saving) return;
    this.memberOverrides.update(list => list.map(r => r.member.id === row.member.id ? {...r, saving: true} : r));
    this.guildService.upsertChannelPermission(this.channel().id, {
      memberId: row.member.id,
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
    this.guildService.deleteChannelPermission(this.channel().id, row.perm.id).subscribe({
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

  memberDisplayName(row: MemberOverride): string {
    return row.profile?.userName ?? row.member.userId.slice(0, 8) + '…';
  }

  readonly emptyOverride: PermOverride = {allow: 0n, deny: 0n};
}
