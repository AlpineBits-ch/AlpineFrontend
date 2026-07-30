import {Component, computed, input, output} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {PERM_GROUPS, PermissionKey, Permissions, permissionLabel} from '../../../../enums/permissions.enum';
import {GuildFeatureSet} from '../../guild-features';

@Component({
    selector: 'app-permission-toggle',
    imports: [ToggleSwitch, FormsModule],
    templateUrl: './permission-toggle.component.html',
})
export class PermissionToggleComponent {
    /** Current combined permission mask */
    mask = input.required<bigint>();
    maskChange = output<bigint>();

    /**
     * The guild's module set. A group whose module is off is hidden outright rather than
     * disabled: "this house doesn't do money" and "you aren't allowed to touch the money"
     * must not look the same - see §10.2 of the household modules guide.
     *
     * Optional. Omitted means "show everything", which is what any caller with no guild
     * in hand needs and what every caller did before modules existed.
     */
    features = input<GuildFeatureSet | null>(null);

    protected readonly groups = computed(() => {
        const features = this.features();
        if (!features) return PERM_GROUPS;
        return PERM_GROUPS.filter(group => !group.feature || features.has(group.feature));
    });
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
        return permissionLabel(key);
    }
}
