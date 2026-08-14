import {Component, computed, input, output} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {TranslateModule} from '@ngx-translate/core';
import {FlagCatalog} from '../../../../enums/flag-mask';
import {CORE_PERM_CATALOG, permissionLabel} from '../../../../enums/permissions.enum';
import {GuildFeatureSet} from '../../guild-features';

@Component({
    selector: 'app-permission-toggle',
    imports: [ToggleSwitch, FormsModule, TranslateModule],
    templateUrl: './permission-toggle.component.html',
})
export class PermissionToggleComponent {
    mask = input.required<bigint>();
    maskChange = output<bigint>();

    /**
     * Which permission space this grid edits. Core by default, so every existing caller keeps
     * working; the role editor passes the module catalog for its second grid. One component for
     * both means the two cannot drift apart the way the old duplicated group lists did.
     */
    catalog = input<FlagCatalog>(CORE_PERM_CATALOG);

    /**
     * The guild's module set. A group whose module is off is hidden outright rather than
     * disabled: "this house doesn't do money" and "you aren't allowed to touch the money"
     * must not look the same - see §13.2 of the household modules guide.
     *
     * Omitted means "show everything", which is what any caller with no guild in hand needs.
     */
    features = input<GuildFeatureSet | null>(null);

    /** Names matching the filter, or every group when the box is empty. */
    query = input('');

    protected readonly groups = computed(() => {
        const features = this.features();
        const needle = this.query().trim().toLowerCase();

        return this.catalog().groups
            .filter(group => !features || !group.feature || features.has(group.feature))
            .map(group => ({
                ...group,
                perms: needle ? group.perms.filter(key => this.label(key).toLowerCase().includes(needle)) : group.perms,
            }))
            .filter(group => group.perms.length > 0);
    });

    protected readonly isEmpty = computed(() => this.groups().length === 0);

    has(key: string): boolean {
        const val = this.catalog().table[key];
        return (this.mask() & val) === val;
    }

    toggle(key: string): void {
        const val = this.catalog().table[key];
        this.maskChange.emit(this.has(key) ? this.mask() & ~val : this.mask() | val);
    }

    /** Every permission in the group, on or off in one go - a long list is tedious otherwise. */
    setGroup(keys: readonly string[], enabled: boolean): void {
        const table = this.catalog().table;
        const groupMask = keys.reduce((acc, key) => acc | table[key], 0n);
        this.maskChange.emit(enabled ? this.mask() | groupMask : this.mask() & ~groupMask);
    }

    groupState(keys: readonly string[]): 'all' | 'some' | 'none' {
        const held = keys.filter(key => this.has(key)).length;
        if (held === 0) return 'none';
        return held === keys.length ? 'all' : 'some';
    }

    label(key: string): string {
        return permissionLabel(key as never);
    }
}
