import { Component, effect, input, output, signal } from '@angular/core';
import { hasPermission, parsePermissions, Permissions, PermissionKey, stringifyPermissions } from '../../../../../enums/permissions.enum';

interface PermItem {
  key: PermissionKey;
  label: string;
  hint: string;
}

interface PermGroup {
  label: string;
  items: PermItem[];
}

const PERMISSION_GROUPS: PermGroup[] = [
  {
    label: 'General',
    items: [
      { key: 'ViewChannel', label: 'View Channel', hint: 'See channels and read their message history' },
    ],
  },
  {
    label: 'Messages',
    items: [
      { key: 'SendMessages',       label: 'Send Messages',        hint: 'Post new messages in channels' },
      { key: 'EditOwnMessages',    label: 'Edit Own Messages',    hint: 'Edit messages they have sent' },
      { key: 'EditAnyMessage',     label: 'Edit Any Message',     hint: 'Edit messages sent by other members' },
      { key: 'DeleteOwnMessages',  label: 'Delete Own Messages',  hint: 'Delete messages they have sent' },
      { key: 'DeleteAnyMessage',   label: 'Delete Any Message',   hint: 'Delete messages sent by other members' },
      { key: 'PinMessages',        label: 'Pin Messages',         hint: 'Pin messages in channels' },
    ],
  },
  {
    label: 'Attachments',
    items: [
      { key: 'AttachFiles', label: 'Attach Files', hint: 'Upload files and images to messages' },
      { key: 'EmbedLinks',  label: 'Embed Links',  hint: 'Show rich previews for posted links' },
    ],
  },
  {
    label: 'Reactions',
    items: [
      { key: 'AddReactions', label: 'Add Reactions', hint: 'React to messages with emoji' },
    ],
  },
  {
    label: 'Voice',
    items: [
      { key: 'Connect',        label: 'Connect',          hint: 'Join voice channels' },
      { key: 'Speak',          label: 'Speak',            hint: 'Transmit audio in voice channels' },
      { key: 'Stream',         label: 'Stream',           hint: 'Share video or screen in voice channels' },
      { key: 'MuteMembers',    label: 'Mute Members',     hint: 'Server-mute other members in voice' },
      { key: 'DeafenMembers',  label: 'Deafen Members',   hint: 'Server-deafen other members in voice' },
      { key: 'MoveMembers',    label: 'Move Members',     hint: 'Move members between voice channels' },
    ],
  },
  {
    label: 'Threads',
    items: [
      { key: 'CreateThreads',           label: 'Create Threads',             hint: 'Start new threads in channels' },
      { key: 'SendMessagesInThreads',   label: 'Send in Threads',            hint: 'Reply inside existing threads' },
      { key: 'ManageOwnThreads',        label: 'Manage Own Threads',         hint: 'Archive and manage threads they created' },
      { key: 'ManageAnyThread',         label: 'Manage Any Thread',          hint: 'Archive and manage threads created by others' },
    ],
  },
  {
    label: 'Moderation',
    items: [
      { key: 'ManageChannel',     label: 'Manage Channels',     hint: 'Create, edit, and delete channels' },
      { key: 'ManagePermissions', label: 'Manage Permissions',  hint: 'Edit permission overrides for channels and roles' },
    ],
  },
  {
    label: 'Advanced',
    items: [
      { key: 'Superadmin', label: 'Administrator', hint: 'Grants every permission — use with caution' },
    ],
  },
];

@Component({
  selector: 'app-permissions-editor',
  templateUrl: './permissions-editor.component.html',
})
export class PermissionsEditorComponent {
  readonly permissions = input.required<string>();
  readonly permissionsChange = output<string>();
  readonly readonly = input(false);

  protected readonly groups = PERMISSION_GROUPS;
  protected localMask = signal<bigint>(0n);

  constructor() {
    effect(() => {
      this.localMask.set(parsePermissions(this.permissions()));
    });
  }

  protected isEnabled(key: PermissionKey): boolean {
    return hasPermission(this.localMask(), Permissions[key]);
  }

  protected toggle(key: PermissionKey): void {
    if (this.readonly()) return;
    const newMask = this.localMask() ^ Permissions[key];
    this.localMask.set(newMask);
    this.permissionsChange.emit(stringifyPermissions(newMask));
  }
}
