/**
 * The lobby shows who is live before you join (avatars and mute state alone did not say that),
 * and offers "join and watch" as a second action naming that streamer - see Task 3 of the
 * call-parity plan. `joinVoice` stays the plain, always-present action.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {TranslateModule} from '@ngx-translate/core';
import {describe, expect, it} from 'vitest';
import {VoiceChannelLobbyComponent} from './voice-channel-lobby.component';
import {VoiceChannelParticipant} from '../../../../services/voice-channel.service';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {ProfileService} from '../../../../services/profile.service';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';

const CHANNEL = {id: 'chan-1', guildId: 'guild-1', name: 'General', type: ChannelType.Voice} as unknown as ChannelDto;

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

function render(participants: VoiceChannelParticipant[]): ComponentFixture<VoiceChannelLobbyComponent> {
    TestBed.configureTestingModule({
        imports: [VoiceChannelLobbyComponent, TranslateModule.forRoot()],
        providers: [
            provideFakePlatform(),
            {provide: ProfileService, useValue: {getCachedByUserId: () => undefined, resolveByUserId: () => void 0}},
        ],
    });
    const fixture = TestBed.createComponent(VoiceChannelLobbyComponent);
    fixture.componentRef.setInput('channel', CHANNEL);
    fixture.componentRef.setInput('participants', participants);
    fixture.detectChanges();
    return fixture;
}

function joinAndWatchButton(fixture: ComponentFixture<VoiceChannelLobbyComponent>): HTMLButtonElement | null {
    return Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
        .find(b => b.textContent?.includes('CALL.JOIN_AND_WATCH')) ?? null;
}

describe('VoiceChannelLobbyComponent live state', () => {
    it('shows no live badge and no join-and-watch button when nobody is sharing', () => {
        const fixture = render([participant(), participant({userId: 'user-2'})]);

        expect(fixture.nativeElement.textContent).not.toContain('CALL.LIVE');
        expect(joinAndWatchButton(fixture)).toBeNull();
    });

    it('badges the participant who is sharing before anyone joins', () => {
        const fixture = render([
            participant({userId: 'user-1', isScreenSharing: false}),
            participant({userId: 'user-2', isScreenSharing: true}),
        ]);

        expect(fixture.nativeElement.textContent).toContain('CALL.LIVE');
    });

    it('offers join-and-watch once at least one participant is live', () => {
        const fixture = render([participant({userId: 'user-2', isScreenSharing: true})]);

        expect(joinAndWatchButton(fixture)).not.toBeNull();
    });

    it('emits joinAndWatch carrying the live streamer\'s userId, not a plain join', () => {
        const fixture = render([
            participant({userId: 'user-1', isScreenSharing: false}),
            participant({userId: 'streamer-2', isScreenSharing: true}),
        ]);
        let watchedUserId: string | null = null;
        let plainJoined = false;
        fixture.componentInstance.joinAndWatch.subscribe(id => watchedUserId = id);
        fixture.componentInstance.joinVoice.subscribe(() => plainJoined = true);

        joinAndWatchButton(fixture)!.click();

        expect(watchedUserId).toBe('streamer-2');
        expect(plainJoined).toBe(false);
    });

    it('still offers the plain join action alongside join-and-watch', () => {
        const fixture = render([participant({userId: 'user-2', isScreenSharing: true})]);
        let plainJoined = false;
        fixture.componentInstance.joinVoice.subscribe(() => plainJoined = true);

        const plainButton = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
            .find(b => b.textContent?.includes('CALL.JOIN_VOICE'));
        plainButton!.click();

        expect(plainJoined).toBe(true);
    });
});
