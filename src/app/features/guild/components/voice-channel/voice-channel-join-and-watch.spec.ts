import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {of} from 'rxjs';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it, vi} from 'vitest';
import {VoiceChannelComponent} from './voice-channel.component';
import {VoiceChannelParticipant, VoiceChannelService} from '../../../../services/voice-channel.service';
import {RustMediaService} from '../../../../services/rust-media.service';
import {GuildService} from '../../../../services/guild.service';
import {GuildVoiceService} from '../../../../services/guild-voice.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {OwnMemberRevisionService} from '../../../../services/own-member-revision.service';
import {ProfileService} from '../../../../services/profile.service';
import {CallFocusService} from '../../../../services/call-focus.service';
import {scopeKey} from '../../../../services/share-watch.service';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';

const CHANNEL = {
    id: 'chan-1',
    guildId: 'guild-1',
    name: 'General Voice',
    type: ChannelType.Voice,
} as unknown as ChannelDto;

const STREAMER: VoiceChannelParticipant = {
    userId: 'streamer-1',
    displayName: 'Streamer',
    avatarLabel: 'S',
    isMuted: false,
    isSpeaking: false,
    isCameraOn: false,
    isScreenSharing: true,
    isServerDeafened: false,
    isLocal: false,
};

function render(joinChannel: ReturnType<typeof vi.fn>): ComponentFixture<VoiceChannelComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideTranslateService(),
            provideFakePlatform(),
            {
                provide: VoiceChannelService,
                useValue: {
                    joinedChannelId: signal(null),
                    // Nothing in flight: these tests are about what an already-settled join arms.
                    pendingJoinId: signal(null),
                    // The roster already carries a streamer, so the lobby offers join-and-watch
                    // without this test having to touch a signal after the fixture is built.
                    channelParticipants: signal(new Map([[CHANNEL.id, [STREAMER]]])),
                    participantsWithAudio: signal(new Set<string>()),
                    rtcState: signal('idle'),
                    localState: signal({
                        isMuted: false,
                        isDeafened: false,
                        isCameraOn: false,
                        isScreenSharing: false,
                    }),
                    localVideoStream: signal(null),
                    localScreenStream: signal(null),
                    localScreenHasAudio: signal(false),
                    localScreenAudioMuted: signal(false),
                    getVideoStream: () => null,
                    getScreenStream: () => null,
                    isScreenAudioMuted: () => false,
                    isScreenResuming: () => false,
                    getUserVolume: () => 1,
                    rtc: {screenPreset: signal(null)},
                    videoBlock: () => null,
                    limits: {
                        notices: () => [],
                        audioOnly: () => false,
                        publisherSlots: () => null,
                        videoCeiling: () => null,
                        participantSlots: () => null,
                    },
                    joinChannel,
                },
            },
            {
                provide: RustMediaService,
                useValue: {
                    screenAudioOutcome: signal('off'),
                    publishPreview: signal(null),
                    localPublishStream: signal(null),
                    renderedFps: signal(0),
                    inboundFps: signal(0),
                    previewPaused: signal(false),
                    claimPreviewRender: () => void 0,
                    releasePreviewRender: () => void 0,
                    resumePreview: () => void 0,
                },
            },
            {
                provide: NavigationService,
                useValue: {
                    mobileNavOpen: signal(false),
                    workspace: signal({type: 'server', guild: {name: 'My Guild'}}),
                },
            },
            {provide: GuildService, useValue: {getOwnMember: () => of(null)}},
            {provide: OwnMemberRevisionService, useValue: {revision: signal(0)}},
            {provide: GuildVoiceService, useValue: {}},
            {
                provide: ProfileService,
                useValue: {getCachedByUserId: () => undefined, resolveByUserId: () => void 0},
            },
        ],
    });

    const fixture = TestBed.createComponent(VoiceChannelComponent);
    fixture.componentRef.setInput('channel', CHANNEL);
    fixture.detectChanges();
    return fixture;
}

function joinAndWatchButton(fixture: ComponentFixture<VoiceChannelComponent>): HTMLButtonElement {
    return Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find(
        b => b.textContent?.includes('CALL.JOIN_AND_WATCH'),
    )!;
}

describe('VoiceChannelComponent join-and-watch', () => {
    it('joins the channel and arms a focus request for the streamer', async () => {
        // `joinChannel` answers whether the join actually happened, so the stub has to say so.
        const joinChannel = vi.fn().mockResolvedValue(true);
        const fixture = render(joinChannel);
        const requestSpy = vi.spyOn(TestBed.inject(CallFocusService), 'request');

        joinAndWatchButton(fixture).click();
        await vi.waitFor(() => expect(requestSpy).toHaveBeenCalled());

        expect(joinChannel).toHaveBeenCalledWith(CHANNEL, 'My Guild');
        const scope = scopeKey({kind: 'channel', guildId: CHANNEL.guildId, channelId: CHANNEL.id});
        expect(requestSpy).toHaveBeenCalledWith(scope, {userId: 'streamer-1'});
    });

    it('does not arm a request when the plain join button is used instead', async () => {
        const joinChannel = vi.fn().mockResolvedValue(true);
        const fixture = render(joinChannel);
        const requestSpy = vi.spyOn(TestBed.inject(CallFocusService), 'request');

        const plainButton = Array.from(
            fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
        ).find(b => b.textContent?.includes('CALL.JOIN_VOICE'))!;
        plainButton.click();
        await vi.waitFor(() => expect(joinChannel).toHaveBeenCalledWith(CHANNEL, 'My Guild'));

        expect(requestSpy).not.toHaveBeenCalled();
    });

    /** A refused join has already said so; a stage focused on a room nobody is in has not. */
    it('arms nothing when the join was refused', async () => {
        const joinChannel = vi.fn().mockResolvedValue(false);
        const fixture = render(joinChannel);
        const requestSpy = vi.spyOn(TestBed.inject(CallFocusService), 'request');

        joinAndWatchButton(fixture).click();
        await vi.waitFor(() => expect(joinChannel).toHaveBeenCalled());

        expect(requestSpy).not.toHaveBeenCalled();
    });
});
