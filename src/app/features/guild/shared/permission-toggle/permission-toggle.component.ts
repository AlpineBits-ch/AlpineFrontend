import {Component, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {PermissionKey, Permissions} from '../../../../enums/permissions.enum';

interface PermGroup {
  label: string;
  perms: PermissionKey[];
}

const PERM_GROUPS: PermGroup[] = [
  {
    label: 'General',
    perms: ['ViewChannel'],
  },
  {
    label: 'Messages',
    perms: ['SendMessages', 'EditOwnMessages', 'EditAnyMessage', 'DeleteOwnMessages', 'DeleteAnyMessage', 'PinMessages'],
  },
  {
    label: 'Attachments & Embeds',
    perms: ['AttachFiles', 'EmbedLinks', 'AddReactions'],
  },
  {
    label: 'Voice',
    perms: ['Connect', 'Speak', 'Stream', 'MuteMembers', 'DeafenMembers', 'MoveMembers'],
  },
  {
    label: 'Threads',
    perms: ['CreateThreads', 'SendMessagesInThreads', 'ManageOwnThreads', 'ManageAnyThread'],
  },
  {
    label: 'Moderation',
    perms: ['ManageChannel', 'ManagePermissions'],
  },
  {
    label: 'Admin',
    perms: ['Superadmin'],
  },
];

@Component({
  selector: 'app-permission-toggle',
  imports: [NgClass],
  templateUrl: './permission-toggle.component.html',
})
export class PermissionToggleComponent {
  /** Current combined permission mask */
  mask = input.required<bigint>();
  maskChange = output<bigint>();

  readonly groups = PERM_GROUPS;
  protected readonly Permissions = Permissions;

  has(key: PermissionKey): boolean {
    const val = Permissions[key];
    return (this.mask() & val) === val;
  }

  toggle(key: PermissionKey): void {
    const val = Permissions[key];
    const next = this.has(key) ? this.mask() & ~val : this.mask() | val;
    this.maskChange.emit(next);
  }

  label(key: PermissionKey): string {
    return key.replace(/([A-Z])/g, ' $1').trim();
  }
}
