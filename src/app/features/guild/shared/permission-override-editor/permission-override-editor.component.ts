import {Component, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {PermissionKey, Permissions} from '../../../../enums/permissions.enum';

interface PermGroup {
  label: string;
  perms: PermissionKey[];
}

export type OverrideState = 'allow' | 'deny' | 'inherit';

export interface PermOverride {
  allow: bigint;
  deny: bigint;
}

const PERM_GROUPS: PermGroup[] = [
  {label: 'General', perms: ['ViewChannel']},
  {label: 'Messages', perms: ['SendMessages', 'EditOwnMessages', 'EditAnyMessage', 'DeleteOwnMessages', 'DeleteAnyMessage', 'PinMessages']},
  {label: 'Attachments & Embeds', perms: ['AttachFiles', 'EmbedLinks', 'AddReactions']},
  {label: 'Voice', perms: ['Connect', 'Speak', 'Stream', 'MuteMembers', 'DeafenMembers', 'MoveMembers']},
  {label: 'Threads', perms: ['CreateThreads', 'SendMessagesInThreads', 'ManageOwnThreads', 'ManageAnyThread']},
  {label: 'Moderation', perms: ['ManageChannel', 'ManagePermissions']},
];

@Component({
  selector: 'app-permission-override-editor',
  imports: [NgClass],
  templateUrl: './permission-override-editor.component.html',
})
export class PermissionOverrideEditorComponent {
  override = input.required<PermOverride>();
  overrideChange = output<PermOverride>();

  readonly groups = PERM_GROUPS;

  getState(key: PermissionKey): OverrideState {
    const val = Permissions[key];
    if ((this.override().allow & val) === val) return 'allow';
    if ((this.override().deny & val) === val) return 'deny';
    return 'inherit';
  }

  setState(key: PermissionKey, state: OverrideState): void {
    const val = Permissions[key];
    let allow = this.override().allow;
    let deny = this.override().deny;
    allow &= ~val;
    deny &= ~val;
    if (state === 'allow') allow |= val;
    else if (state === 'deny') deny |= val;
    this.overrideChange.emit({allow, deny});
  }

  label(key: PermissionKey): string {
    return key.replace(/([A-Z])/g, ' $1').trim();
  }
}
