import {Component, computed, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {PermissionKey, Permissions} from '../../../../enums/permissions.enum';
import {ChannelType} from '../../../../dtos/response/guild.dto';

interface PermGroup {
    /** Untranslated identifier for the group - stable across locales, and the `@for` track. */
    label: string;
    /** The `PERM_GROUP.*` key the UI actually renders - the same vocabulary the role editor uses. */
    labelKey: string;
    perms: PermissionKey[];
    /** When set, this group only appears on a channel of that exact type. */
    channelType?: ChannelType;
}

export type OverrideState = 'allow' | 'deny' | 'inherit';

export interface PermOverride {
    allow: bigint;
    deny: bigint;
}

const PERM_GROUPS: PermGroup[] = [
    {label: 'General', labelKey: 'PERM_GROUP.GENERAL', perms: ['ViewChannel']},
    {
        label: 'Messages',
        labelKey: 'PERM_GROUP.MESSAGES',
        perms: ['SendMessages', 'EditOwnMessages', 'EditAnyMessage', 'DeleteOwnMessages', 'DeleteAnyMessage', 'PinMessages']
    },
    {label: 'Attachments & Embeds', labelKey: 'PERM_GROUP.ATTACHMENTS', perms: ['AttachFiles', 'EmbedLinks', 'AddReactions']},
    {label: 'Voice', labelKey: 'PERM_GROUP.VOICE', perms: ['Connect', 'Speak', 'Stream', 'MuteMembers', 'DeafenMembers', 'MoveMembers']},
    {label: 'Threads', labelKey: 'PERM_GROUP.THREADS', perms: ['CreateThreads', 'SendMessagesInThreads', 'ManageOwnThreads', 'ManageAnyThread']},
    {label: 'Moderation', labelKey: 'PERM_GROUP.MODERATION', perms: ['ManageChannel', 'ManagePermissions']},
    {label: 'Lists', labelKey: 'PERM_GROUP.LISTS', channelType: ChannelType.List, perms: ['ManageLists', 'AddListItems', 'CheckOffListItems']},
    {label: 'Chores', labelKey: 'PERM_GROUP.CHORES', channelType: ChannelType.Chores, perms: ['ManageChores', 'CompleteChores']},
    {label: 'Ledger', labelKey: 'PERM_GROUP.LEDGER', channelType: ChannelType.Ledger, perms: ['ManageLedger', 'AddExpenses']},
    {label: 'Pantry', labelKey: 'PERM_GROUP.PANTRY', channelType: ChannelType.Pantry, perms: ['ManagePantry']},
    {label: 'Decisions', labelKey: 'PERM_GROUP.DECISIONS', channelType: ChannelType.Decisions, perms: ['CreateDecisions', 'VoteDecisions']},
];

@Component({
    selector: 'app-permission-override-editor',
    imports: [NgClass, TranslateModule],
    templateUrl: './permission-override-editor.component.html',
})
export class PermissionOverrideEditorComponent {
    override = input.required<PermOverride>();
    overrideChange = output<PermOverride>();

    /**
     * The type of the channel being edited, or null for a category. Household permission
     * groups resolve per channel, so a Ledger channel offers the ledger permissions and
     * nothing else - and a category offers none of them, since a category-wide grant is
     * precisely the "controls every list" shape the per-channel model avoids.
     */
    channelType = input<ChannelType | null>(null);

    protected readonly groups = computed(() => {
        const type = this.channelType();
        return PERM_GROUPS.filter(group => !group.channelType || group.channelType === type);
    });

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
