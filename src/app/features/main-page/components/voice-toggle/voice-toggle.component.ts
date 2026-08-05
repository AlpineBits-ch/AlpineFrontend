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
    /** Whether the thing this controls is currently off - muted, or deafened. */
    active = input.required<boolean>();
    icon = input.required<string>();
    activeIcon = input.required<string>();
    /** Translation key for the toggle's tooltip, which reads as the action, not the state. */
    label = input.required<string>();
    /** Translation key naming what the chevron lists, used as the menu's section header. */
    deviceLabel = input.required<string>();
    devices = input.required<DeviceOption[]>();
    selected = input.required<string>();

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
