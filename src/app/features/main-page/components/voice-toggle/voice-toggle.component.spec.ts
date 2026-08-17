/** The device chevron's menu, and the one thing it could not previously explain. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MenuItem} from 'primeng/api';
import {describe, expect, it} from 'vitest';
import {VoiceToggleComponent} from './voice-toggle.component';
import {DeviceOption} from '../../../../services/media-device-catalog.service';

const DEVICES: DeviceOption[] = [
    {label: 'Microphone 1', value: 'mic-1'},
    {label: 'Microphone 2', value: 'mic-2'},
];

function render(devices: DeviceOption[], namesWithheld: boolean): ComponentFixture<VoiceToggleComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({providers: [provideTranslateService()]});

    const fixture = TestBed.createComponent(VoiceToggleComponent);
    fixture.componentRef.setInput('active', false);
    fixture.componentRef.setInput('icon', 'pi-microphone');
    fixture.componentRef.setInput('label', 'QUICK_SETTINGS.MUTE');
    fixture.componentRef.setInput('deviceLabel', 'QUICK_SETTINGS.INPUT_DEVICE');
    fixture.componentRef.setInput('devices', devices);
    fixture.componentRef.setInput('selected', 'mic-1');
    fixture.componentRef.setInput('namesWithheld', namesWithheld);
    fixture.detectChanges();
    return fixture;
}

/** Every row inside the device group, which is where the hint belongs. */
function deviceRows(fixture: ComponentFixture<VoiceToggleComponent>): MenuItem[] {
    const items = (fixture.componentInstance as unknown as {menuItems: () => MenuItem[]}).menuItems();
    return items.find(item => item.items)?.items ?? [];
}

describe('VoiceToggleComponent device names', () => {
    it('lists the devices and nothing else when the names are real', () => {
        expect(deviceRows(render(DEVICES, false)).map(r => r.label))
            .toEqual(['Microphone 1', 'Microphone 2']);
    });

    it('adds an unpickable hint when the host is withholding names', () => {
        const rows = deviceRows(render(DEVICES, true));

        expect(rows).toHaveLength(3);
        expect(rows[2].label).toBe('QUICK_SETTINGS.DEVICE_NAMES_WITHHELD');
        // A sentence, not a row to choose: selecting it must not be able to change the device.
        expect(rows[2].disabled).toBe(true);
        expect(rows[2].command).toBeUndefined();
    });

    it('says nothing when there are no devices to explain', () => {
        // The empty menu already degrades to the settings link. A lone hint above it would be a menu
        // whose only content is an apology.
        const fixture = render([], true);

        expect(deviceRows(fixture)).toEqual([]);
        const items = (fixture.componentInstance as unknown as {menuItems: () => MenuItem[]}).menuItems();
        expect(items.map(i => i.label)).toEqual(['QUICK_SETTINGS.VOICE_SETTINGS']);
    });
});
