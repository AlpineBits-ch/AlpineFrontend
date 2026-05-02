import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NgClass } from '@angular/common';
import { Button } from 'primeng/button';
import { GuildDto, RoleDto, RoleType } from '../../../../../dtos/response/guild.dto';
import { GuildService } from '../../../../../services/guild.service';
import { PermissionsEditorComponent } from '../../components/permissions-editor/permissions-editor.component';

@Component({
  selector: 'app-roles-settings',
  imports: [NgClass, Button, PermissionsEditorComponent],
  templateUrl: './roles-settings.component.html',
})
export class RolesSettingsComponent {
  readonly guild = input.required<GuildDto>();
  readonly roles = input.required<RoleDto[]>();
  readonly rolesChanged = output<RoleDto[]>();

  protected readonly RoleType = RoleType;

  private guildService = inject(GuildService);

  protected selectedRole = signal<RoleDto | null>(null);
  protected editName = signal('');
  protected editDescription = signal('');
  protected editColor = signal('#6366f1');
  protected editPermissions = signal('');
  protected saving = signal(false);
  protected deleting = signal(false);
  protected creating = signal(false);

  protected isDirty = computed(() => {
    const r = this.selectedRole();
    if (!r) return false;
    return (
      this.editName() !== r.name ||
      this.editDescription() !== (r.description ?? '') ||
      this.editColor() !== (r.color || '#6366f1') ||
      this.editPermissions() !== (r.permissions ?? '')
    );
  });

  constructor() {
    effect(() => {
      const role = this.selectedRole();
      if (role) {
        untracked(() => {
          this.editName.set(role.name);
          this.editDescription.set(role.description ?? '');
          this.editColor.set(role.color || '#6366f1');
          this.editPermissions.set(role.permissions ?? '');
        });
      }
    });
  }

  protected selectRole(role: RoleDto): void {
    this.selectedRole.set(role);
  }

  protected createRole(): void {
    if (this.creating()) return;
    this.creating.set(true);
    this.guildService.createRole(this.guild().id, 'New Role', '#6366f1', '').subscribe({
      next: role => {
        const updated = [...this.roles(), role];
        this.rolesChanged.emit(updated);
        this.selectedRole.set(role);
        this.creating.set(false);
      },
      error: () => this.creating.set(false),
    });
  }

  protected saveRole(): void {
    const role = this.selectedRole();
    if (!role || this.saving()) return;
    this.saving.set(true);
    this.guildService.updateRole(role.id, this.editName().trim(), this.editDescription().trim(), this.editColor(), this.editPermissions()).subscribe({
      next: updated => {
        const list = this.roles().map(r => r.id === updated.id ? updated : r);
        this.rolesChanged.emit(list);
        this.selectedRole.set(updated);
        this.saving.set(false);
      },
      error: () => this.saving.set(false),
    });
  }

  protected deleteRole(): void {
    const role = this.selectedRole();
    if (!role || role.type === RoleType.Everyone || this.deleting()) return;
    this.deleting.set(true);
    this.guildService.deleteRole(role.id).subscribe({
      next: () => {
        const list = this.roles().filter(r => r.id !== role.id);
        this.rolesChanged.emit(list);
        this.selectedRole.set(null);
        this.deleting.set(false);
      },
      error: () => this.deleting.set(false),
    });
  }

  protected roleItemClasses(role: RoleDto): Record<string, boolean> {
    const active = this.selectedRole()?.id === role.id;
    return {
      'bg-indigo-500/15 text-white/90': active,
      'text-white/55 hover:bg-white/[0.04] hover:text-white/80': !active,
    };
  }
}
