import {ChangeDetectionStrategy, Component, computed, inject, input, output, viewChild} from '@angular/core';
import {ContextMenuComponent} from '../../../../shared/context-menu/context-menu.component';
import {MenuItem} from '../../../../shared/context-menu/context-menu.model';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {DeviceOption} from '../../../../services/media-device-catalog.service';

/** One of the bottom bar's audio controls: a toggle, and a chevron onto the devices it applies to. */
@Component({
    selector: 'app-voice-toggle',
    imports: [ContextMenuComponent, TranslateModule],
    templateUrl: './voice-toggle.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceToggleComponent {
    /** Whether the thing this controls is currently off - muted, or deafened. */
    readonly active = input.required<boolean>();
    readonly icon = input.required<string>();
    /** Translation key for the toggle's tooltip, which reads as the action, not the state. */
    readonly label = input.required<string>();
    /** Translation key naming what the chevron lists, used as the menu's section header. */
    readonly deviceLabel = input.required<string>();
    readonly devices = input.required<DeviceOption[]>();
    readonly selected = input.required<string>();

    /** Whether the labels above are stand-ins rather than the devices' own names. */
    readonly namesWithheld = input(false);

    toggled = output<void>();
    deviceChosen = output<string>();
    openSettings = output<void>();

    private readonly menuRef = viewChild.required<ContextMenuComponent>('menu');

    private readonly translate = inject(TranslateService);

    /** The device list, then a way out to the full settings. */
    protected readonly menuItems = computed((): MenuItem[] => {
        const devices = this.devices();
        const selected = this.selected();

        const deviceItems: MenuItem[] = devices.map(device => ({
            label: device.label,
            // A blank fixed-width icon on the unselected rows, so the labels stay in one column
            // instead of shifting sideways as the selection moves.
            icon: device.value === selected ? 'pi pi-check' : 'pi pi-fw',
            command: () => this.deviceChosen.emit(device.value),
        }));

        // Disabled rather than a command: it is a sentence, not a row to pick. Only shown alongside a
        // list, because with no devices listed there is nothing for it to be explaining.
        if (deviceItems.length && this.namesWithheld()) {
            deviceItems.push({
                label: this.translate.instant('QUICK_SETTINGS.DEVICE_NAMES_WITHHELD'),
                icon: 'pi pi-fw pi-info-circle',
                disabled: true,
            });
        }

        return [
            ...(deviceItems.length
                ? [{header: this.translate.instant(this.deviceLabel())}, ...deviceItems]
                : []),
            {
                label: this.translate.instant('QUICK_SETTINGS.VOICE_SETTINGS'),
                icon: 'pi pi-cog',
                command: () => this.openSettings.emit(),
            },
        ];
    });

    protected openMenu(event: MouseEvent): void {
        this.menuRef().toggle(event);
    }
}
