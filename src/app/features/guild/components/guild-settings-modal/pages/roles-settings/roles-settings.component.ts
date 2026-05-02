import {Component, inject, input, OnInit, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {Dialog} from 'primeng/dialog';
import {Tooltip} from 'primeng/tooltip';
import {GuildDto, RoleDto, RoleType} from '../../../../../../dtos/response/guild.dto';
import {GuildService, CreateRoleDto, UpdateRoleDto} from '../../../../../../services/guild.service';
import {parsePermissions, stringifyPermissions} from '../../../../../../enums/permissions.enum';
import {PermissionToggleComponent} from '../../../../shared/permission-toggle/permission-toggle.component';
import {PrimeTemplate} from "primeng/api";

@Component({
  selector: 'app-roles-settings',
  imports: [NgClass, FormsModule, Button, InputText, Textarea, Dialog, Tooltip, PermissionToggleComponent, PrimeTemplate],
  templateUrl: './roles-settings.component.html',
})
export class RolesSettingsComponent implements OnInit {
  guild = input.required<GuildDto>();
  rolesChanged = output<RoleDto[]>();

  private guildService = inject(GuildService);

  roles = signal<RoleDto[]>([]);
  selectedRole = signal<RoleDto | null>(null);

  editName = signal('');
  editDescription = signal('');
  editColor = signal('#6366f1');
  editPermMask = signal(0n);
  editSaving = signal(false);
  editDirty = signal(false);

  showCreateDialog = signal(false);
  createName = signal('');
  createColor = signal('#6366f1');
  creating = signal(false);

  confirmDeleteRole = signal<RoleDto | null>(null);
  showDeleteDialog = signal(false);
  deleting = signal(false);

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
  }

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
}
