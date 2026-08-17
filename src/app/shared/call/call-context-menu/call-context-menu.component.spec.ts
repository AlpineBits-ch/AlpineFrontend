import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallContextMenuComponent} from './call-context-menu.component';
import {CallParticipant, CallParticipantMenuData} from '../call.types';

function participant(overrides: Partial<CallParticipant> = {}): CallParticipant {
    return {
        userId: 'user-1',
        displayName: 'Test User',
        avatarLabel: 'T',
        isLocal: false,
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
        ...overrides,
    };
}

function menuData(overrides: Partial<CallParticipantMenuData> = {}): CallParticipantMenuData {
    return {
        x: 0,
        y: 0,
        participant: participant(),
        volume: 100,
        ...overrides,
    };
}

function setup(menu: CallParticipantMenuData) {
    TestBed.configureTestingModule({
        imports: [CallContextMenuComponent, TranslateModule.forRoot()],
    });

    const fixture: ComponentFixture<CallContextMenuComponent> =
        TestBed.createComponent(CallContextMenuComponent);
    fixture.componentRef.setInput('menu', menu);
    fixture.detectChanges();
    return fixture;
}

describe('CallContextMenuComponent stream volume slider', () => {
    beforeEach(() => TestBed.resetTestingModule());

    /**
     * A stream-volume control on someone with no stream is a control that does nothing - see task 6's
     * brief. `streamVolume` is left undefined by both hosts for a non-sharing participant, and the
     * template reads exactly that to decide whether to render the second slider.
     */
    it('hides the stream slider for a participant who is not sharing', () => {
        const fixture = setup(menuData({streamVolume: undefined}));

        expect(fixture.nativeElement.querySelector('#call-stream-volume')).toBeNull();
    });

    it('shows the stream slider once the participant has a streamVolume - i.e. is sharing', () => {
        const fixture = setup(menuData({streamVolume: 40}));

        const slider: HTMLInputElement | null = fixture.nativeElement.querySelector('#call-stream-volume');
        expect(slider).not.toBeNull();
        expect(slider!.value).toBe('40');
    });

    it('still shows the voice slider regardless of sharing state', () => {
        const fixture = setup(menuData({streamVolume: undefined}));

        expect(fixture.nativeElement.querySelector('#call-volume')).not.toBeNull();
    });

    it('treats a stream volume of exactly zero as "sharing", not as "absent"', () => {
        // A regression that would slip past a `menu().streamVolume` truthiness check but not an
        // explicit `!== undefined` one - muting a stream all the way down must not make its own
        // slider disappear.
        const fixture = setup(menuData({streamVolume: 0}));

        expect(fixture.nativeElement.querySelector('#call-stream-volume')).not.toBeNull();
    });

    it('emits streamVolumeChange with the slider value on input', () => {
        const fixture = setup(menuData({streamVolume: 40}));
        let emitted: number | undefined;
        fixture.componentInstance.streamVolumeChange.subscribe((v: number) => (emitted = v));

        const slider: HTMLInputElement = fixture.nativeElement.querySelector('#call-stream-volume');
        slider.value = '65';
        slider.dispatchEvent(new Event('input'));

        expect(emitted).toBe(65);
    });

    it('leaves the voice volumeChange output untouched by the new slider', () => {
        const fixture = setup(menuData({streamVolume: 40}));
        let emitted: number | undefined;
        fixture.componentInstance.volumeChange.subscribe((v: number) => (emitted = v));

        const slider: HTMLInputElement = fixture.nativeElement.querySelector('#call-volume');
        slider.value = '30';
        slider.dispatchEvent(new Event('input'));

        expect(emitted).toBe(30);
    });
});
