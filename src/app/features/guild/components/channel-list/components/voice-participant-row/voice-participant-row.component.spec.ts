/**
 * The LIVE badge sits inside a row that already has its own click handler (open) and a
 * right-click handler. Clicking the badge has to watch the stream, not open/join the row it lives
 * in - see CallFocusService and Task 3 of the call-parity plan.
 */
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
            // app-avatar reaches for this to resolve a display label - irrelevant here since every
            // row already carries its own avatarLabel/displayName.
            {provide: ProfileService, useValue: {getCachedByUserId: () => undefined, resolveByUserId: () => void 0}},
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
        fixture.componentInstance.watch.subscribe(() => watched = true);
        fixture.componentInstance.open.subscribe(() => opened = true);

        watchButton(fixture)!.click();

        expect(watched).toBe(true);
        expect(opened).toBe(false);
    });

    it('still opens the row when the click lands outside the badge', () => {
        const fixture = render(participant({isScreenSharing: true}));
        let opened = false;
        fixture.componentInstance.open.subscribe(() => opened = true);

        (fixture.nativeElement.querySelector('[data-testid="voice-participant"]') as HTMLElement).click();

        expect(opened).toBe(true);
    });
});
