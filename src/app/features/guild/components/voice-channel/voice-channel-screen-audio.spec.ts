/**
 * "Your screen is being shared without sound", and when it is said.
 *
 * <p><b>Three states, not a boolean, and this is the one that needs a sentence.</b> `'off'` means nobody
 * asked for screen audio; `'published'` needs no comment; `'unavailable'` means it was asked for and
 * could not be had. Without a line for that third case every other signal says the share is fine - the
 * video is up, and the mute-stream-audio button is simply absent - so the honest user report is "nobody
 * can hear my game".</p>
 *
 * <p>The reason is worth stating rather than hinting at: in a browser, screen audio only ever comes from
 * a single tab or window and only in Chromium, so a whole-desktop share never carries it. On desktop the
 * same outcome means no usable loopback device, which is why the notice is driven by the outcome and not
 * by the host.</p>
 *
 * <p>Rendered rather than asserted on the computed, because the notice is a template branch and a
 * component test that never looks at the DOM would pass with the `@if` deleted.</p>
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {of} from 'rxjs';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it} from 'vitest';
import {VoiceChannelComponent} from './voice-channel.component';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {RustMediaService} from '../../../../services/rust-media.service';
import {ScreenAudioOutcome} from '../../../../platform/screen-publisher-host';
import {GuildService} from '../../../../services/guild.service';
import {GuildVoiceService} from '../../../../services/guild-voice.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {OwnMemberRevisionService} from '../../../../services/own-member-revision.service';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';

const CHANNEL = {
    id: 'chan-1',
    guildId: 'guild-1',
    name: 'General Voice',
    type: ChannelType.Voice,
} as unknown as ChannelDto;

interface Options {
    sharing?: boolean;
    outcome?: ScreenAudioOutcome;
    joined?: boolean;
}

function render(options: Options = {}): ComponentFixture<VoiceChannelComponent> {
    const outcome: WritableSignal<ScreenAudioOutcome> = signal(options.outcome ?? 'off');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideTranslateService(),
            {
                provide: VoiceChannelService,
                useValue: {
                    // Joined, with an empty roster: the notice sits on the stage, and an empty roster is
                    // what keeps this test out of the participant tiles and their own dependencies.
                    joinedChannelId: signal(options.joined === false ? null : CHANNEL.id),
                    channelParticipants: signal(new Map<string, unknown[]>()),
                    participantsWithAudio: signal(new Set<string>()),
                    rtcState: signal('connected'),
                    localState: signal({
                        isMuted: false,
                        isDeafened: false,
                        isCameraOn: false,
                        isScreenSharing: options.sharing ?? false,
                    }),
                    localVideoStream: signal(null),
                    localScreenStream: signal(null),
                    localScreenHasAudio: signal(false),
                    localScreenAudioMuted: signal(false),
                    getVideoStream: () => null,
                    getScreenStream: () => null,
                    isScreenAudioMuted: () => false,
                    getUserVolume: () => 1,
                    rtc: {screenPreset: signal(null)},
                },
            },
            {
                provide: RustMediaService,
                useValue: {
                    screenAudioOutcome: outcome,
                    publishPreview: signal(null),
                    renderedFps: signal(0),
                    inboundFps: signal(0),
                    previewPaused: signal(false),
                    claimPreviewRender: () => void 0,
                    releasePreviewRender: () => void 0,
                    resumePreview: () => void 0,
                },
            },
            {provide: NavigationService, useValue: {mobileNavOpen: signal(false), workspace: signal({type: 'home'})}},
            {provide: GuildService, useValue: {getOwnMember: () => of(null)}},
            {provide: OwnMemberRevisionService, useValue: {revision: signal(0)}},
            {provide: GuildVoiceService, useValue: {}},
        ],
    });

    const fixture = TestBed.createComponent(VoiceChannelComponent);
    fixture.componentRef.setInput('channel', CHANNEL);
    fixture.detectChanges();
    return fixture;
}

function notice(fixture: ComponentFixture<VoiceChannelComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="screen-audio-unavailable"]');
}

describe('VoiceChannelComponent screen audio', () => {
    it('says nothing when audio was never asked for', () => {
        expect(notice(render({sharing: true, outcome: 'off'}))).toBeNull();
    });

    it('says nothing when the audio half was published', () => {
        expect(notice(render({sharing: true, outcome: 'published'}))).toBeNull();
    });

    it('states the reason when audio was asked for and could not be had', () => {
        const fixture = render({sharing: true, outcome: 'unavailable'});

        expect(notice(fixture)?.textContent?.trim()).toBe('CALL.SCREEN_AUDIO_UNAVAILABLE');
    });

    it('drops a stale outcome once the share has ended', () => {
        // `screenAudioOutcome` is reset by the service on stop, but the notice must not depend on that
        // ordering: a line about a share that is over is worse than no line at all.
        expect(notice(render({sharing: false, outcome: 'unavailable'}))).toBeNull();
    });
});
