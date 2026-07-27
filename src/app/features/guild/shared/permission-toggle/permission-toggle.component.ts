import {Component, input, output} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {PERM_GROUPS, PermissionKey, Permissions, permissionLabel} from '../../../../enums/permissions.enum';

@Component({
    selector: 'app-permission-toggle',
    imports: [ToggleSwitch, FormsModule],
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
        return permissionLabel(key);
    }
}
