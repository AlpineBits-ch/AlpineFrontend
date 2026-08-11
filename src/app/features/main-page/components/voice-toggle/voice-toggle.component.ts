import {ChangeDetectionStrategy, Component, computed, inject, input, output, ViewChild} from '@angular/core';
import {Menu} from 'primeng/menu';
import {MenuItem} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {DeviceOption} from '../../../../services/media-device-catalog.service';

/**
 * One of the bottom bar's audio controls: a toggle, and a chevron onto the devices it applies to.
 *
 * <p>Not microphone-specific. The mic instance toggles mute and lists inputs; the headset instance
 * toggles deafen and lists outputs. Everything that differs between them arrives as an input, which
 * is what keeps the two from drifting apart in spacing, hover treatment or menu shape — they sit
 * next to each other, so any difference reads as a mistake.</p>
 */
@Component({
    selector: 'app-voice-toggle',
    imports: [Menu, TranslateModule],
    templateUrl: './voice-toggle.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceToggleComponent {
    /**
     * Whether the thing this controls is currently off - muted, or deafened.
     *
     * <p>Drives both the red treatment and the slash across the icon. There is no separate "off"
     * icon input: PrimeIcons has no slashed microphone or headphones, so the slash is drawn over
     * whichever glyph the control carries.</p>
     */
    active = input.required<boolean>();
    icon = input.required<string>();
    /** Translation key for the toggle's tooltip, which reads as the action, not the state. */
    label = input.required<string>();
    /** Translation key naming what the chevron lists, used as the menu's section header. */
    deviceLabel = input.required<string>();
    devices = input.required<DeviceOption[]>();
    selected = input.required<string>();

    /**
     * Whether the labels above are stand-ins rather than the devices' own names.
     *
     * <p>True in a browser until the page holds a media permission: `enumerateDevices()` returns real
     * ids with blank labels, and the adapter substitutes "Microphone 2" rather than rendering a nameless
     * row. Worth a line here as well as in the settings page because this menu is where most people
     * change device, and "Microphone 2" with no explanation looks like a bug rather than a permission
     * that has not been granted yet.</p>
     *
     * <p>Optional, so nothing that lists devices from a host which always names them has to say so.</p>
     */
    namesWithheld = input(false);

    toggled = output<void>();
    deviceChosen = output<string>();
    openSettings = output<void>();

    @ViewChild('menu') private menuRef!: Menu;

    private readonly translate = inject(TranslateService);

    /**
     * The device list, then a way out to the full settings.
     *
     * <p>An empty list is not an error worth rendering as one: it is the browser build, where there
     * is no Tauri side to enumerate with, and it is also a machine with no microphone. Either way
     * the settings link is the only useful thing on offer, so the menu degrades to just that rather
     * than to an empty box or a disabled row.</p>
     *
     * <p>Labels are translated here rather than in the template because PrimeNG renders `MenuItem`
     * labels itself, well out of reach of the `translate` pipe.</p>
     */
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
                ? [{label: this.translate.instant(this.deviceLabel()), items: deviceItems}]
                : []),
            {
                label: this.translate.instant('QUICK_SETTINGS.VOICE_SETTINGS'),
                icon: 'pi pi-cog',
                command: () => this.openSettings.emit(),
            },
        ];
    });

    protected openMenu(event: Event): void {
        this.menuRef.toggle(event);
    }
}
