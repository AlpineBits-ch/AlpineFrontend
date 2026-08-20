import {Component, computed, inject, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {Tooltip} from 'primeng/tooltip';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {
    CHANNEL_PERM_GROUPS,
    expandDeniedPermissions,
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
import {
    EffectivePermissionsDto,
    PermissionSourceEntry,
    PermissionSourceKey,
} from '../../../../dtos/response/effective-permissions.dto';

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
    /** Names beyond this many are folded into a count instead of listed; ViewChannel alone has 21. */
    private static readonly DENY_COLLATERAL_DISPLAY_CAP = 5;

    readonly override = input.required<PermOverride>();
    overrideChange = output<PermOverride>();

    /** The channel being edited, or null for a category; household permissions resolve per channel, so a category offers none of them (avoiding a category-wide "controls every list" grant). */
    readonly channelType = input<ChannelType | null>(null);

    /** The saved trace for the selected subject, or null while it is in flight. */
    readonly resolved = input<EffectivePermissionsDto | null>(null);

    /** What the server last stored for this subject. The trace describes this, not the live edit. */
    readonly savedOverride = input<PermOverride>(EMPTY_OVERRIDE);

    protected readonly groups = CHANNEL_PERM_GROUPS;

    private readonly translate = inject(TranslateService);

    private readonly sourceByPermission = computed(() => {
        const map = new Map<PermissionKey, PermissionSourceEntry>();
        for (const entry of this.resolved()?.sources ?? []) map.set(entry.permission, entry);
        return map;
    });

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

    /** What leaving this row on inherit resolves to, or null when there is nothing honest to show. */
    inheritedState(key: PermissionKey): {granted: boolean; decidedBy: PermissionSourceKey} | null {
        const val = Permissions[key];
        const saved = this.savedOverride();
        if ((saved.allow & val) === val || (saved.deny & val) === val) return null;

        const entry = this.sourceByPermission().get(key);
        return entry ? {granted: entry.granted, decidedBy: entry.decidedBy} : null;
    }

    /** Everything denying this permission would take with it, itself excluded. */
    denyCollateral(key: PermissionKey): PermissionKey[] {
        const val = Permissions[key];
        const expanded = expandDeniedPermissions(val) & ~val;
        return CHANNEL_PERM_GROUPS.flatMap(group => group.perms).filter(
            k => (expanded & Permissions[k]) === Permissions[k],
        );
    }

    /** {@link denyCollateral} as labels, not identifiers, capped with a trailing count. */
    denyCollateralNames(key: PermissionKey): string {
        const collateral = this.denyCollateral(key);
        const shown = collateral
            .slice(0, PermissionOverrideEditorComponent.DENY_COLLATERAL_DISPLAY_CAP)
            .map(k => this.label(k));
        const names = shown.join(', ');

        const remaining = collateral.length - shown.length;
        if (remaining <= 0) return names;

        const more = this.translate.instant('PERM_OVERRIDE.DENY_ALSO_REMOVES_MORE', {count: remaining});
        return `${names}, ${more}`;
    }

    /** Whether the edit in progress already removes this row through some other deny. */
    impliedOff(key: PermissionKey): boolean {
        const val = Permissions[key];
        const current = this.override();
        if ((current.deny & val) === val) return false;
        return (expandDeniedPermissions(current.deny) & val) === val;
    }

    label(key: string): string {
        return permissionLabel(key as PermissionKey);
    }
}
