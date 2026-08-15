/**
 * What the voice surface looks like in each of the states a plan can put it in.
 *
 * <p>Four of them, and none is an error: inside the plan (nothing at all), clamped (a card naming
 * the rung), audio-only (a standing badge plus disabled video controls), and publisher slots full
 * (a queue count). The one thing every state has in common is that it is <b>on screen for as long
 * as it is true</b> - this replaced a toast, which gave the reader four seconds to understand why
 * their camera button had stopped working.</p>
 */
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
import {SettingsUiService} from '../../../../services/settings-ui.service';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';
import {ApiConfigService} from '../../../../services/api-config.service';
import {SlotCount} from '../../../../core/voice-limits';
import {VideoCeiling} from '../../../../models/stream-preset';
import {VoiceLimitNotice} from '../../../../services/voice-limits.service';

const CHANNEL = {
    id: 'chan-1',
    guildId: 'guild-1',
    name: 'General Voice',
    type: ChannelType.Voice,
} as unknown as ChannelDto;

interface RoomState {
    notices?: VoiceLimitNotice[];
    audioOnly?: boolean;
    publisherSlots?: SlotCount | null;
    videoCeiling?: VideoCeiling | null;
    participantSlots?: SlotCount | null;
    videoBlock?: 'audio_only' | 'publishers_full' | null;
    isScreenSharing?: boolean;
}

function notice(over: Partial<VoiceLimitNotice> = {}): VoiceLimitNotice {
    return {
        key: 'voice.video_ceiling',
        surfaceKey: 'VOICE.DEGRADED.QUALITY_CAPPED',
        rung: '720p30',
        granted: {kind: 'ladder', rung: '720p30', rank: 2},
        refused: false,
        messageKey: 'ENTITLEMENT.REASON.GUILD_PLAN_LIMIT',
        ctaKey: null,
        hintKey: null,
        subject: {kind: 'guild', id: 'guild-1'},
        feature: null,
        retryable: false,
        ...over,
    };
}

function render(room: RoomState = {}) {
    const settingsUi = {open: vi.fn(), openGuild: vi.fn()};

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            // No translations loaded, so every key echoes itself - which is what lets an assertion
            // name the key the component chose rather than a sentence somebody may reword.
            provideTranslateService(),
            provideFakePlatform(),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test'}},
            {
                provide: VoiceChannelService,
                useValue: {
                    joinedChannelId: signal(CHANNEL.id),
                    channelParticipants: signal(new Map<string, unknown[]>([[CHANNEL.id, []]])),
                    participantsWithAudio: signal(new Set<string>()),
                    rtcState: signal('connected'),
                    localState: signal({
                        isMuted: false, isDeafened: false, isCameraOn: false,
                        isScreenSharing: room.isScreenSharing ?? false,
                    }),
                    localVideoStream: signal(null),
                    localScreenStream: signal(null),
                    localScreenHasAudio: signal(false),
                    localScreenAudioMuted: signal(false),
                    inboundVideoFps: signal({}),
                    getVideoStream: () => null,
                    getScreenStream: () => null,
                    isScreenAudioMuted: () => false,
                    getUserVolume: () => 1,
                    rtc: {screenPreset: signal({resolution: '720p', framerate: 30})},
                    videoBlock: () => room.videoBlock ?? null,
                    limits: {
                        notices: () => room.notices ?? [],
                        audioOnly: () => room.audioOnly ?? false,
                        publisherSlots: () => room.publisherSlots ?? null,
                        videoCeiling: () => room.videoCeiling ?? null,
                        participantSlots: () => room.participantSlots ?? null,
                    },
                },
            },
            {
                provide: RustMediaService,
                useValue: {
                    screenAudioOutcome: signal('off'),
                    publishPreview: () => null,
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
            {provide: SettingsUiService, useValue: settingsUi},
            {
                provide: ShareWatchService,
                useValue: {
                    setWatching: vi.fn(), refresh: vi.fn(), clear: vi.fn(),
                    viewerCount: () => 0, viewersOf: () => [],
                },
            },
        ],
    });

    const fixture = TestBed.createComponent(VoiceChannelComponent);
    fixture.componentRef.setInput('channel', CHANNEL);
    fixture.detectChanges();
    return {fixture, settingsUi};
}

function find(fixture: ComponentFixture<VoiceChannelComponent>, testid: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${testid}"]`);
}

describe('a room inside its plan', () => {
    it('says nothing about limits at all', () => {
        const {fixture} = render();

        expect(find(fixture, 'voice-limit-notices')).toBeNull();
        expect(find(fixture, 'audio-only-badge')).toBeNull();
        expect(find(fixture, 'participant-slots')).toBeNull();
        expect(find(fixture, 'publisher-slots')).toBeNull();
        expect((find(fixture, 'camera-toggle') as HTMLButtonElement).disabled).toBe(false);
        expect((find(fixture, 'share-toggle') as HTMLButtonElement).disabled).toBe(false);
    });
});

describe('a room the plan clamped', () => {
    it('keeps the reason on screen, with the rung it settled on', () => {
        const {fixture} = render({
            notices: [notice({ctaKey: 'ENTITLEMENT.CTA.UPGRADE_SERVER'})],
            videoCeiling: {maxHeight: 720, maxFramerate: 30},
            isScreenSharing: true,
        });

        const strip = find(fixture, 'voice-limit-notices')!;
        expect(strip.textContent).toContain('VOICE.DEGRADED.QUALITY_CAPPED');
        expect(strip.textContent).toContain('ENTITLEMENT.REASON.GUILD_PLAN_LIMIT');
        // Sharing is still running: a clamp is a success, and nothing here rolled it back.
        expect((find(fixture, 'share-toggle') as HTMLButtonElement).disabled).toBe(false);
    });

    it('sends an actionable reader to the plan page of the guild the server named', () => {
        const {fixture, settingsUi} = render({
            notices: [notice({ctaKey: 'ENTITLEMENT.CTA.UPGRADE_SERVER'})],
        });

        (find(fixture, 'voice-limit-cta') as HTMLButtonElement).click();

        expect(settingsUi.openGuild).toHaveBeenCalledWith('guild-1', 'plan');
        expect(settingsUi.open).not.toHaveBeenCalled();
    });

    /** A user-bound ceiling is the reader's own account, not whichever server they are standing in. */
    it('sends a user-bound remedy to the account billing page instead', () => {
        const {fixture, settingsUi} = render({
            notices: [notice({
                ctaKey: 'ENTITLEMENT.CTA.UPGRADE_ACCOUNT',
                subject: {kind: 'user', id: 'user-1'},
            })],
        });

        (find(fixture, 'voice-limit-cta') as HTMLButtonElement).click();

        expect(settingsUi.open).toHaveBeenCalledWith('billing');
        expect(settingsUi.openGuild).not.toHaveBeenCalled();
    });

    /** Negative: no button at all for a reader the server said cannot act on it. */
    it('draws no button a member without ManageGuild would only be refused for', () => {
        const {fixture} = render({
            notices: [notice({ctaKey: null, hintKey: 'ENTITLEMENT.CTA.ASK_OWNER'})],
        });

        expect(find(fixture, 'voice-limit-cta')).toBeNull();
        expect(find(fixture, 'voice-limit-notices')!.textContent).toContain('ENTITLEMENT.CTA.ASK_OWNER');
    });
});

describe('an audio-only room', () => {
    it('states it as a standing fact and disables the video controls', () => {
        const {fixture} = render({audioOnly: true, videoBlock: 'audio_only'});

        expect(find(fixture, 'audio-only-badge')!.textContent!.trim())
            .toBe('VOICE.DEGRADED.AUDIO_ONLY');
        expect((find(fixture, 'camera-toggle') as HTMLButtonElement).disabled).toBe(true);
        expect((find(fixture, 'share-toggle') as HTMLButtonElement).disabled).toBe(true);
    });

    /**
     * Edge: nobody has tried to publish, so no degradation exists. The room still has to say what
     * it is - two dead buttons and no sentence is the state this whole change exists to end.
     */
    it('says so even with no degradation to explain it', () => {
        const {fixture} = render({audioOnly: true, videoBlock: 'audio_only', notices: []});

        expect(find(fixture, 'voice-limit-notices')).toBeNull();
        expect(find(fixture, 'audio-only-badge')).not.toBeNull();
    });
});

describe('a room out of publisher slots', () => {
    it('draws the queue as a count rather than leaving the button a mystery', () => {
        const {fixture} = render({
            publisherSlots: {used: 2, max: 2},
            videoBlock: 'publishers_full',
        });

        expect(find(fixture, 'publisher-slots')!.textContent!.trim()).toBe('2/2');
        expect((find(fixture, 'share-toggle') as HTMLButtonElement).getAttribute('title'))
            .toBe('VOICE.DEGRADED.PUBLISHERS_FULL');
        // Not an audio-only room: the plan carries video, the room is simply busy right now.
        expect(find(fixture, 'audio-only-badge')).toBeNull();
    });

    it('draws the room denominator in the header when the room has one', () => {
        const {fixture} = render({participantSlots: {used: 3, max: 10}});

        expect(find(fixture, 'participant-slots')!.textContent)
            .toContain('CALL.PARTICIPANT_COUNT_OF');
    });
});
