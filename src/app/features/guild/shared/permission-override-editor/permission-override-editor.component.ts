import {Component, computed, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule} from '@ngx-translate/core';
import {CHANNEL_PERM_GROUPS, PermissionKey, permissionLabel, Permissions} from '../../../../enums/permissions.enum';
import {
    MODULE_PERM_GROUPS,
    ModulePermissionKey,
    ModulePermissions,
    stringifyModulePermissions,
} from '../../../../enums/module-permissions.enum';
import {ChannelType} from '../../../../dtos/response/guild.dto';

export type OverrideState = 'allow' | 'deny' | 'inherit';

export interface PermOverride {
    allow: bigint;
    deny: bigint;
    /**
     * The module half. Carried so an edit to the core masks cannot drop it, and rendered
     * read-only: `SetPermissionOverwriteDto` has no field to send it back.
     */
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
    override = input.required<PermOverride>();
    overrideChange = output<PermOverride>();

    /**
     * The type of the channel being edited, or null for a category. Household permissions resolve
     * per channel, so a Ledger channel offers the ledger ones and nothing else - and a category
     * offers none of them, since a category-wide grant is precisely the "controls every list"
     * shape the per-channel model avoids.
     */
    channelType = input<ChannelType | null>(null);

    protected readonly groups = CHANNEL_PERM_GROUPS;

    /**
     * Module bits already set on this row, as names.
     *
     * <p>Shown rather than edited: the server stores and enforces a module overwrite but the
     * upsert body cannot carry one, so a toggle here would save nothing. Empty string when there
     * is nothing to report, which is the common case.</p>
     */
    protected readonly moduleSummary = computed(() => {
        const {allowModule, denyModule} = this.override();
        const parts: string[] = [];
        if (allowModule) parts.push(`+ ${stringifyModulePermissions(allowModule)}`);
        if (denyModule) parts.push(`- ${stringifyModulePermissions(denyModule)}`);
        return parts.join('  ');
    });

    /** The module permissions this channel type would offer, once they can be written. */
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

    label(key: string): string {
        return permissionLabel(key as PermissionKey);
    }
}
