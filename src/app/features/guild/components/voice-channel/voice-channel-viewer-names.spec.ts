import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {of} from 'rxjs';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it, vi} from 'vitest';
import {VoiceChannelComponent} from './voice-channel.component';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {RustMediaService} from '../../../../services/rust-media.service';
import {GuildService} from '../../../../services/guild.service';
import {GuildVoiceService} from '../../../../services/guild-voice.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {OwnMemberRevisionService} from '../../../../services/own-member-revision.service';
import {ShareWatchService} from '../../../../services/share-watch.service';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';
import {ApiConfigService} from '../../../../services/api-config.service';

const CHANNEL = {
    id: 'chan-1',
    guildId: 'guild-1',
    name: 'General Voice',
    type: ChannelType.Voice,
} as unknown as ChannelDto;

function render(participants: {userId: string; displayName: string}[]): ComponentFixture<VoiceChannelComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            // No translations loaded: `.instant()` on a missing key returns the key itself, which is exactly what this suite needs to tell "translated placeholder" apart from "raw id".
            provideTranslateService(),
            // A non-empty roster renders app-avatar for each participant, which reaches OsInfo, a platform port with no default provider outside app.config.ts; see provideFakePlatform's own doc.
            provideFakePlatform(),
            // app-avatar also reaches ProfileService -> ApiConfigService, whose real constructor reads localStorage directly: unavailable in this environment and not this suite's concern either way.
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test'}},
            {
                provide: VoiceChannelService,
                useValue: {
                    joinedChannelId: signal(CHANNEL.id),
                    channelParticipants: signal(new Map<string, unknown[]>([[CHANNEL.id, participants]])),
                    participantsWithAudio: signal(new Set<string>()),
                    rtcState: signal('connected'),
                    localState: signal({isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false}),
                    localVideoStream: signal(null),
                    localScreenStream: signal(null),
                    localScreenHasAudio: signal(false),
                    localScreenAudioMuted: signal(false),
                    inboundVideoFps: signal({}),
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
                },
            },
            {
                provide: RustMediaService,
                useValue: {
                    screenAudioOutcome: signal('off'),
                    publishPreview: () => null,
                    localPublishStream: () => null,
                    renderedFps: signal(0),
                    inboundFps: signal(0),
                    previewPaused: () => false,
                    claimPreviewRender: () => void 0,
                    releasePreviewRender: () => void 0,
                    resumePreview: () => void 0,
                },
            },
            {provide: NavigationService, useValue: {mobileNavOpen: signal(false), workspace: signal({type: 'home'})}},
            {provide: GuildService, useValue: {getOwnMember: () => of(null)}},
            {provide: OwnMemberRevisionService, useValue: {revision: signal(0)}},
            {provide: GuildVoiceService, useValue: {}},
            // app-call-screen-layout injects the real ShareWatchService unless overridden; its dependency chain (GuildWebsocketService/VoiceWebsocketService -> RealtimeConnectionService -> AuthService -> OAuthService) is otherwise unavailable in this test module.
            {
                provide: ShareWatchService,
                useValue: {setWatching: vi.fn(), refresh: vi.fn(), clear: vi.fn(), viewerCount: () => 0, viewersOf: () => []},
            },
        ],
    });

    const fixture = TestBed.createComponent(VoiceChannelComponent);
    fixture.componentRef.setInput('channel', CHANNEL);
    fixture.detectChanges();
    return fixture;
}

describe('VoiceChannelComponent viewer name resolution', () => {
    it('resolves a known channel member to their display name', () => {
        const fixture = render([{userId: 'user-a', displayName: 'Alice'}]);

        const resolve = (fixture.componentInstance as unknown as {resolveMemberName: (id: string) => string})
            .resolveMemberName;

        expect(resolve('user-a')).toBe('Alice');
    });

    it('falls back to a translated placeholder, never the raw user id, for an unresolved viewer', () => {
        const fixture = render([]);

        const resolve = (fixture.componentInstance as unknown as {resolveMemberName: (id: string) => string})
            .resolveMemberName;

        // No translations are loaded, so `.instant()` echoes the key back: proof this is the translated placeholder path, not the raw id, without depending on locale content.
        expect(resolve('someone-not-in-the-channel')).toBe('CALL.UNKNOWN_VIEWER');
        expect(resolve('someone-not-in-the-channel')).not.toBe('someone-not-in-the-channel');
    });
});
