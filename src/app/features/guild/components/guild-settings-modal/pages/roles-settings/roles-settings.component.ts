import {Component, computed, inject, input, OnInit, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {Dialog} from 'primeng/dialog';
import {Tooltip} from 'primeng/tooltip';
import {PrimeTemplate} from 'primeng/api';
import {GuildDto, RoleDto, RoleType} from '../../../../../../dtos/response/guild.dto';
import {GuildMemberDto, RoleMemberDto} from '../../../../../../dtos/response/member.dto';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {GuildService, CreateRoleDto, UpdateRoleDto} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {parsePermissions, stringifyPermissions} from '../../../../../../enums/permissions.enum';
import {PermissionToggleComponent} from '../../../../shared/permission-toggle/permission-toggle.component';

interface RoleMemberDisplay {
  roleMember: RoleMemberDto;
  profile: ProfileDto | undefined;
  userId: string;
}

@Component({
  selector: 'app-roles-settings',
  imports: [NgClass, FormsModule, Button, InputText, Textarea, Dialog, Tooltip, PermissionToggleComponent, PrimeTemplate],
  templateUrl: './roles-settings.component.html',
})
export class RolesSettingsComponent implements OnInit {
  guild = input.required<GuildDto>();
  rolesChanged = output<RoleDto[]>();

  private guildService = inject(GuildService);
  private profileService = inject(ProfileService);

  roles = signal<RoleDto[]>([]);
  selectedRole = signal<RoleDto | null>(null);

  activeTab = signal<'settings' | 'members'>('settings');

  // Settings tab
  editName = signal('');
  editDescription = signal('');
  editColor = signal('#6366f1');
  editPermMask = signal(0n);
  editSaving = signal(false);
  editDirty = signal(false);

  // Create role dialog
  showCreateDialog = signal(false);
  createName = signal('');
  createColor = signal('#6366f1');
  creating = signal(false);

  // Delete role dialog
  confirmDeleteRole = signal<RoleDto | null>(null);
  showDeleteDialog = signal(false);
  deleting = signal(false);

  // Members tab — raw list; profiles resolved from store
  private readonly TAKE = 30;
  private memberNextSkip = 0;
  private memberSearchTimer?: ReturnType<typeof setTimeout>;

  roleMembers = signal<RoleMemberDto[]>([]);
  roleMembersLoading = signal(false);
  roleMembersLoadingMore = signal(false);
  roleMembersHasMore = signal(true);
  roleMembersQuery = signal('');
  roleMembersIsSearch = signal(false);
  roleMembersLoaded = signal(false);
  removing = signal<string | null>(null);

  roleMembersDisplay = computed<RoleMemberDisplay[]>(() =>
    this.roleMembers().map(rm => {
      const userId = rm.member?.userId ?? rm.userId ?? '';
      return {
        roleMember: rm,
        profile: userId ? this.profileService.getCachedByUserId(userId) : undefined,
        userId,
      };
    })
  );

  // Add member dialog
  showAddDialog = signal(false);
  addSearch = signal('');
  addCandidates = signal<GuildMemberDto[]>([]);
  addLoading = signal(false);
  adding = signal<string | null>(null);
  private addSearchTimer?: ReturnType<typeof setTimeout>;

  protected readonly RoleType = RoleType;

  ngOnInit(): void {
    this.roles.set([...this.guild().roles]);
  }

  selectRole(role: RoleDto): void {
    this.selectedRole.set(role);
    this.editName.set(role.name);
    this.editDescription.set(role.description ?? '');
    this.editColor.set(role.color ?? '#6366f1');
    this.editPermMask.set(parsePermissions(role.permissions));
    this.editDirty.set(false);
    this.activeTab.set('settings');
    this.resetMembersTab();
  }

  private resetMembersTab(): void {
    this.roleMembers.set([]);
    this.roleMembersLoaded.set(false);
    this.roleMembersQuery.set('');
    this.roleMembersIsSearch.set(false);
    this.roleMembersHasMore.set(true);
    this.memberNextSkip = 0;
  }

  switchTab(tab: 'settings' | 'members'): void {
    this.activeTab.set(tab);
    if (tab === 'members' && !this.roleMembersLoaded()) {
      this.loadRoleMembers();
    }
  }

  // ── Settings tab ───────────────────────────────────────────────────────────

  onEditField(): void {
    const r = this.selectedRole();
    if (!r) return;
    this.editDirty.set(
      this.editName() !== r.name ||
      this.editDescription() !== (r.description ?? '') ||
      this.editColor() !== (r.color ?? '#6366f1') ||
      this.editPermMask() !== parsePermissions(r.permissions)
    );
  }

  onPermChange(mask: bigint): void {
    this.editPermMask.set(mask);
    this.onEditField();
  }

  saveRole(): void {
    const role = this.selectedRole();
    if (!role || this.editSaving()) return;
    this.editSaving.set(true);
    const dto: UpdateRoleDto = {
      name: this.editName(),
      description: this.editDescription(),
      color: this.editColor(),
      permissions: stringifyPermissions(this.editPermMask()),
    };
    this.guildService.updateRole(role.id, dto).subscribe({
      next: updated => {
        this.roles.update(list => list.map(r => r.id === updated.id ? updated : r));
        this.selectedRole.set(updated);
        this.editDirty.set(false);
        this.editSaving.set(false);
        this.rolesChanged.emit(this.roles());
      },
      error: () => this.editSaving.set(false),
    });
  }

  createRole(): void {
    if (this.creating() || !this.createName().trim()) return;
    this.creating.set(true);
    const dto: CreateRoleDto = {
      guildId: this.guild().id,
      name: this.createName().trim(),
      color: this.createColor(),
      permissions: '0',
    };
    this.guildService.createRole(dto).subscribe({
      next: role => {
        this.roles.update(list => [...list, role]);
        this.showCreateDialog.set(false);
        this.createName.set('');
        this.creating.set(false);
        this.selectRole(role);
        this.rolesChanged.emit(this.roles());
      },
      error: () => this.creating.set(false),
    });
  }

  deleteRole(role: RoleDto): void {
    if (this.deleting()) return;
    this.deleting.set(true);
    this.guildService.deleteRole(role.id).subscribe({
      next: () => {
        this.roles.update(list => list.filter(r => r.id !== role.id));
        if (this.selectedRole()?.id === role.id) this.selectedRole.set(null);
        this.confirmDeleteRole.set(null);
        this.showDeleteDialog.set(false);
        this.deleting.set(false);
        this.rolesChanged.emit(this.roles());
      },
      error: () => this.deleting.set(false),
    });
  }

  // ── Members tab ────────────────────────────────────────────────────────────

  private loadRoleMembers(): void {
    const role = this.selectedRole();
    if (!role) return;
    this.roleMembersLoading.set(true);
    this.memberNextSkip = 0;
    this.roleMembers.set([]);
    this.roleMembersHasMore.set(true);
    this.fetchMembersPage(role.id);
  }

  private fetchMembersPage(roleId: string): void {
    const skip = this.memberNextSkip;
    this.guildService.getRoleMembers(roleId, skip, this.TAKE).subscribe({
      next: incoming => {
        incoming.forEach(rm => {
          const uid = rm.member?.userId ?? rm.userId;
          if (uid) this.profileService.resolveByUserId(uid);
        });
        if (skip === 0) {
          this.roleMembers.set(incoming);
          this.roleMembersLoading.set(false);
          this.roleMembersLoaded.set(true);
        } else {
          this.roleMembers.update(list => [...list, ...incoming]);
          this.roleMembersLoadingMore.set(false);
        }
        this.memberNextSkip = skip + incoming.length;
        if (incoming.length < this.TAKE) this.roleMembersHasMore.set(false);
      },
      error: () => {
        this.roleMembersLoading.set(false);
        this.roleMembersLoadingMore.set(false);
      },
    });
  }

  loadMoreRoleMembers(): void {
    const role = this.selectedRole();
    if (!role || this.roleMembersLoadingMore() || !this.roleMembersHasMore() || this.roleMembersLoading()) return;
    this.roleMembersLoadingMore.set(true);
    this.fetchMembersPage(role.id);
  }

  onMembersScroll(event: Event): void {
    if (this.roleMembersIsSearch()) return;
    const el = event.target as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
      this.loadMoreRoleMembers();
    }
  }

  onQueryChange(query: string): void {
    this.roleMembersQuery.set(query);
    clearTimeout(this.memberSearchTimer);
    this.memberSearchTimer = setTimeout(() => {
      if (query.trim()) {
        this.roleMembersIsSearch.set(true);
        this.doMemberSearch(query.trim());
      } else {
        this.roleMembersIsSearch.set(false);
        this.loadRoleMembers();
      }
    }, 300);
  }

  private doMemberSearch(query: string): void {
    const role = this.selectedRole();
    if (!role) return;
    this.roleMembersLoading.set(true);
    this.guildService.searchRoleMembers(role.id, query).subscribe({
      next: results => {
        results.forEach(rm => {
          const uid = rm.member?.userId ?? rm.userId;
          if (uid) this.profileService.resolveByUserId(uid);
        });
        this.roleMembers.set(results);
        this.roleMembersLoading.set(false);
      },
      error: () => this.roleMembersLoading.set(false),
    });
  }

  removeMember(rm: RoleMemberDto): void {
    const role = this.selectedRole();
    if (!role || this.removing()) return;
    this.removing.set(rm.memberId);
    this.guildService.removeRoleFromMember(role.id, rm.memberId).subscribe({
      next: () => {
        this.roleMembers.update(list => list.filter(r => r.memberId !== rm.memberId));
        this.removing.set(null);
      },
      error: () => this.removing.set(null),
    });
  }

  displayName(profile: ProfileDto | undefined, userId: string): string {
    return profile?.userName ?? (userId ? userId.slice(0, 8) + '…' : '?');
  }

  // ── Add member dialog ──────────────────────────────────────────────────────

  openAddDialog(): void {
    this.addSearch.set('');
    this.addCandidates.set([]);
    this.showAddDialog.set(true);
    this.fetchAddCandidates('');
  }

  onAddSearchChange(query: string): void {
    this.addSearch.set(query);
    clearTimeout(this.addSearchTimer);
    this.addSearchTimer = setTimeout(() => this.fetchAddCandidates(query.trim()), 300);
  }

  private fetchAddCandidates(query: string): void {
    this.addLoading.set(true);
    const obs = query
      ? this.guildService.searchMembers(this.guild().id, query)
      : this.guildService.getMembers(this.guild().id, 0, 30);
    obs.subscribe({
      next: members => {
        const existingIds = new Set(this.roleMembers().map(r => r.memberId));
        this.addCandidates.set(members.filter(m => !existingIds.has(m.id)));
        this.addLoading.set(false);
      },
      error: () => this.addLoading.set(false),
    });
  }

  addMember(member: GuildMemberDto): void {
    const role = this.selectedRole();
    if (!role || this.adding()) return;
    this.adding.set(member.id);
    this.guildService.assignRoleToMember(role.id, member.id).subscribe({
      next: () => {
        this.addCandidates.update(list => list.filter(m => m.id !== member.id));
        this.adding.set(null);
        this.resetMembersTab();
        this.loadRoleMembers();
      },
      error: () => this.adding.set(null),
    });
  }

  addDisplayName(member: GuildMemberDto): string {
    return member.profile?.userName ?? member.userId.slice(0, 8) + '…';
  }

  addAvatarUrl(member: GuildMemberDto): string | undefined {
    return member.profile?.avatarUrl;
  }
}
