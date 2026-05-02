import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NgClass } from '@angular/common';
import { Button } from 'primeng/button';
import { Select } from 'primeng/select';
import { FormsModule } from '@angular/forms';
import { GuildDto, GuildMemberDto, RoleDto } from '../../../../../dtos/response/guild.dto';
import { RoleMemberDto } from '../../../../../dtos/response/member.dto';
import { GuildService } from '../../../../../services/guild.service';
import { PermissionsEditorComponent } from '../../components/permissions-editor/permissions-editor.component';

@Component({
  selector: 'app-members-settings',
  imports: [NgClass, Button, Select, FormsModule, PermissionsEditorComponent],
  templateUrl: './members-settings.component.html',
})
export class MembersSettingsComponent {
  readonly guild = input.required<GuildDto>();
  readonly members = input.required<GuildMemberDto[]>();
  readonly roles = input.required<RoleDto[]>();
  readonly loading = input(false);
  readonly membersChanged = output<GuildMemberDto[]>();

  private guildService = inject(GuildService);

  protected search = signal('');
  protected selectedMember = signal<GuildMemberDto | null>(null);
  protected memberRoles = signal<RoleMemberDto[]>([]);
  protected editPermissions = signal('');
  protected loadingRoles = signal(false);
  protected savingPerms = signal(false);
  protected addingRole = signal(false);
  protected selectedRoleToAdd = signal<RoleDto | null>(null);

  protected filteredMembers = computed(() => {
    const q = this.search().toLowerCase();
    if (!q) return this.members();
    return this.members().filter(m => m.userId.toLowerCase().includes(q));
  });

  protected availableRolesToAdd = computed(() => {
    const assigned = new Set(this.memberRoles().map(rm => rm.roleId));
    return this.roles().filter(r => !assigned.has(r.id));
  });

  constructor() {
    effect(() => {
      const member = this.selectedMember();
      if (member) {
        untracked(() => {
          this.editPermissions.set(member.permissions ?? '');
          this.loadRoles(member.id);
        });
      }
    });
  }

  protected selectMember(member: GuildMemberDto): void {
    this.selectedMember.set(member);
    this.selectedRoleToAdd.set(null);
  }

  private loadRoles(memberId: string): void {
    this.loadingRoles.set(true);
    this.guildService.getMemberRoles(memberId).subscribe({
      next: roles => {
        this.memberRoles.set(roles);
        this.loadingRoles.set(false);
      },
      error: () => this.loadingRoles.set(false),
    });
  }

  protected assignRole(): void {
    const member = this.selectedMember();
    const role = this.selectedRoleToAdd();
    if (!member || !role || this.addingRole()) return;
    this.addingRole.set(true);
    this.guildService.assignRole(member.id, role.id).subscribe({
      next: rm => {
        this.memberRoles.update(list => [...list, rm]);
        this.selectedRoleToAdd.set(null);
        this.addingRole.set(false);
      },
      error: () => this.addingRole.set(false),
    });
  }

  protected revokeRole(rm: RoleMemberDto): void {
    this.guildService.revokeRole(rm.id).subscribe({
      next: () => this.memberRoles.update(list => list.filter(r => r.id !== rm.id)),
      error: () => {},
    });
  }

  protected savePermissions(): void {
    const member = this.selectedMember();
    if (!member || this.savingPerms()) return;
    this.savingPerms.set(true);
    this.guildService.updateMember(member.id, this.editPermissions()).subscribe({
      next: updated => {
        const list = this.members().map(m => m.id === updated.id ? updated : m);
        this.membersChanged.emit(list);
        this.selectedMember.set(updated);
        this.savingPerms.set(false);
      },
      error: () => this.savingPerms.set(false),
    });
  }

  protected shortId(userId: string): string {
    return userId.length > 12 ? userId.substring(0, 12) + '…' : userId;
  }

  protected avatarLabel(userId: string): string {
    return userId.charAt(0).toUpperCase();
  }

  protected memberItemClasses(member: GuildMemberDto): Record<string, boolean> {
    const active = this.selectedMember()?.id === member.id;
    return {
      'bg-indigo-500/15 text-white/90': active,
      'text-white/55 hover:bg-white/[0.04] hover:text-white/80': !active,
    };
  }
}
