/** The LIVE badge sits inside a row with its own click (open) and right-click handlers; clicking the badge must watch the stream, not open/join the row it lives in. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {TranslateModule} from '@ngx-translate/core';
import {describe, expect, it} from 'vitest';
import {VoiceParticipantRowComponent} from './voice-participant-row.component';
import {VoiceChannelParticipant} from '../../../../../../services/voice-channel.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {provideFakePlatform} from '../../../../../../platform/testing/provide-fake-platform';

function participant(overrides: Partial<VoiceChannelParticipant> = {}): VoiceChannelParticipant {
    return {
        userId: 'user-1',
        displayName: 'Alex',
        avatarLabel: 'A',
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
        isScreenSharing: false,
        isServerDeafened: false,
        isLocal: false,
        ...overrides,
    };
}

function render(p: VoiceChannelParticipant): ComponentFixture<VoiceParticipantRowComponent> {
    TestBed.configureTestingModule({
        imports: [VoiceParticipantRowComponent, TranslateModule.forRoot()],
        providers: [
            provideFakePlatform(),
            // app-avatar reaches for this to resolve a display label; irrelevant here since every row already carries its own avatarLabel/displayName.
            {
                provide: ProfileService,
                useValue: {getCachedByUserId: () => undefined, resolveByUserId: () => void 0},
            },
        ],
    });
    const fixture = TestBed.createComponent(VoiceParticipantRowComponent);
    fixture.componentRef.setInput('participant', p);
    fixture.detectChanges();
    return fixture;
}

function watchButton(fixture: ComponentFixture<VoiceParticipantRowComponent>): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('button');
}

function cameraIcon(fixture: ComponentFixture<VoiceParticipantRowComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="voice-participant-camera"]');
}

/** Camera has no other indicator: screen share has the LIVE badge, mute has its slash. */
describe('VoiceParticipantRowComponent camera indicator', () => {
    it('shows nothing for a participant whose camera is off', () => {
        const fixture = render(participant({isCameraOn: false}));

        expect(cameraIcon(fixture)).toBeNull();
    });

    it('marks a participant who is on camera, with an accessible name', () => {
        const fixture = render(participant({isCameraOn: true}));

        expect(cameraIcon(fixture)?.getAttribute('aria-label')).toBe('CALL.CAMERA_ON');
    });

    /** Camera and screen share are independent; somebody doing both gets both marks. */
    it('sits alongside the watch badge when they are also sharing a screen', () => {
        const fixture = render(participant({isCameraOn: true, isScreenSharing: true}));

        expect(cameraIcon(fixture)).not.toBeNull();
        expect(watchButton(fixture)).not.toBeNull();
    });

    /** Status, not a control: clicking it must not join the channel behind the row. */
    it('is not a button', () => {
        const fixture = render(participant({isCameraOn: true}));

        expect(cameraIcon(fixture)?.tagName).not.toBe('BUTTON');
    });
});

describe('VoiceParticipantRowComponent watch badge', () => {
    it('renders no watch button for a participant who is not sharing', () => {
        const fixture = render(participant({isScreenSharing: false}));

        expect(watchButton(fixture)).toBeNull();
    });

    it('renders the badge as a real button with an accessible name when the participant is sharing', () => {
        const fixture = render(participant({isScreenSharing: true}));

        const button = watchButton(fixture);
        expect(button).not.toBeNull();
        expect(button?.getAttribute('aria-label')).toBe('CALL.WATCH_STREAM');
    });

    it('emits watch, not open, when the badge is clicked', () => {
        const fixture = render(participant({isScreenSharing: true}));
        let watched = false;
        let opened = false;
        fixture.componentInstance.watch.subscribe(() => (watched = true));
        fixture.componentInstance.open.subscribe(() => (opened = true));

        watchButton(fixture)!.click();

        expect(watched).toBe(true);
        expect(opened).toBe(false);
    });

    it('still opens the row when the click lands outside the badge', () => {
        const fixture = render(participant({isScreenSharing: true}));
        let opened = false;
        fixture.componentInstance.open.subscribe(() => (opened = true));

        (fixture.nativeElement.querySelector('[data-testid="voice-participant"]') as HTMLElement).click();

        expect(opened).toBe(true);
    });
});
