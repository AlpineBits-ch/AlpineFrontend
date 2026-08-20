import {Component, computed, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule} from '@ngx-translate/core';
import {
    CHANNEL_PERM_GROUPS,
    PermissionKey,
    permissionLabel,
    Permissions,
} from '../../../../enums/permissions.enum';
import {
    MODULE_PERM_GROUPS,
    ModulePermissionKey,
    ModulePermissions,
} from '../../../../enums/module-permissions.enum';
import {ChannelType} from '../../../../dtos/response/guild.dto';

export type OverrideState = 'allow' | 'deny' | 'inherit';

export interface PermOverride {
    allow: bigint;
    deny: bigint;
    /** The module half; edited the same as the core mask and sent when either bit is nonzero. */
    allowModule: bigint;
    denyModule: bigint;
}

export const EMPTY_OVERRIDE: PermOverride = {allow: 0n, deny: 0n, allowModule: 0n, denyModule: 0n};

/** Which module group a channel of this type can override. Categories offer none. */
const MODULE_GROUP_BY_CHANNEL: Partial<Record<ChannelType, string>> = {
    [ChannelType.List]: 'Lists',
    [ChannelType.Chores]: 'Chores',
    [ChannelType.Ledger]: 'Ledger',
    [ChannelType.Pantry]: 'Pantry',
    [ChannelType.Decisions]: 'Decisions',
};

@Component({
    selector: 'app-permission-override-editor',
    imports: [NgClass, Tooltip, TranslateModule],
    templateUrl: './permission-override-editor.component.html',
})
export class PermissionOverrideEditorComponent {
    readonly override = input.required<PermOverride>();
    overrideChange = output<PermOverride>();

    /** The channel being edited, or null for a category; household permissions resolve per channel, so a category offers none of them (avoiding a category-wide "controls every list" grant). */
    readonly channelType = input<ChannelType | null>(null);

    protected readonly groups = CHANNEL_PERM_GROUPS;

    /** The module permissions this channel type can override. */
    protected readonly moduleGroup = computed(() => {
        const label = MODULE_GROUP_BY_CHANNEL[this.channelType() ?? ChannelType.Text];
        return MODULE_PERM_GROUPS.find(g => g.label === label) ?? null;
    });

    getState(key: PermissionKey): OverrideState {
        const val = Permissions[key];
        if ((this.override().allow & val) === val) return 'allow';
        if ((this.override().deny & val) === val) return 'deny';
        return 'inherit';
    }

    setState(key: PermissionKey, state: OverrideState): void {
        const val = Permissions[key];
        const current = this.override();
        let allow = current.allow & ~val;
        let deny = current.deny & ~val;
        if (state === 'allow') allow |= val;
        else if (state === 'deny') deny |= val;
        this.overrideChange.emit({...current, allow, deny});
    }

    moduleState(key: ModulePermissionKey): OverrideState {
        const val = ModulePermissions[key];
        if ((this.override().allowModule & val) === val) return 'allow';
        if ((this.override().denyModule & val) === val) return 'deny';
        return 'inherit';
    }

    setModuleState(key: ModulePermissionKey, state: OverrideState): void {
        const val = ModulePermissions[key];
        const current = this.override();
        let allowModule = current.allowModule & ~val;
        let denyModule = current.denyModule & ~val;
        if (state === 'allow') allowModule |= val;
        else if (state === 'deny') denyModule |= val;
        this.overrideChange.emit({...current, allowModule, denyModule});
    }

    label(key: string): string {
        return permissionLabel(key as PermissionKey);
    }
}
