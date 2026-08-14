/**
 * The deferred test from Task 3's known gap (see .superpowers/sdd/call-parity-plan/task-3-report.md):
 * `ChannelListComponent.onWatchStream` itself was never spec-covered directly, because the component's
 * template pulls in a large dialog/menu/modal surface with its own heavy dependency chain.
 *
 * `TestBed.createComponent()` without `detectChanges()` sidesteps that: it resolves the component's
 * own constructor-time dependencies (still real DI, still real effects once they flush) but never
 * instantiates a single child component from the template - which is where the heavy chain actually
 * lives. Calling the handler directly, rather than clicking through the DOM, is what this buys.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {of, Subject} from 'rxjs';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it, vi} from 'vitest';
import {ChannelListComponent} from './channel-list.component';
import {NavigationService} from '../../../main-page/navigation.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {CallFocusService} from '../../../../services/call-focus.service';
import {scopeKey} from '../../../../services/share-watch.service';
import {ProfileService} from '../../../../services/profile.service';
import {GuildReadStateService} from '../../../../services/guild-read-state.service';
import {GuildService} from '../../../../services/guild.service';
import {OwnMemberRevisionService} from '../../../../services/own-member-revision.service';
import {GuildVoiceService} from '../../../../services/guild-voice.service';
import {GuildUiActionsService} from '../../../../services/guild-ui-actions.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {ScheduledEventStore} from '../../../../stores/scheduled-event.store';
import {MinuteClockService} from '../../../../services/minute-clock.service';
import {GuildOnboardingStateService} from '../../../../services/guild-onboarding-state.service';
import {ChannelDto, ChannelType, GuildDto} from '../../../../dtos/response/guild.dto';

const GUILD = {
    id: 'guild-1',
    name: 'Test Guild',
    ownerId: 'owner',
    channels: [],
    categories: [],
} as unknown as GuildDto;

const CHANNEL = {
    id: 'chan-1',
    guildId: GUILD.id,
    name: 'General Voice',
    type: ChannelType.Voice,
} as unknown as ChannelDto;

type OnWatchStreamHost = {onWatchStream(event: {channel: ChannelDto; userId: string}): Promise<void>};

function render(joinChannel: ReturnType<typeof vi.fn>): ComponentFixture<ChannelListComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [ChannelListComponent],
        providers: [
            provideTranslateService(),
            {
                provide: NavigationService,
                useValue: {
                    openChannel: () => undefined,
                    mainView: signal({type: 'server', guildId: GUILD.id}),
                    eventsPanelGuildId: signal(null),
                    mobileNavOpen: signal(false),
                },
            },
            {
                provide: VoiceChannelService,
                useValue: {
                    joinedChannelId: signal<string | null>(null),
                    joinChannel,
                    loadVoiceStatesForGuild: () => undefined,
                    leaveChannel: () => Promise.resolve(),
                },
            },
            {provide: ProfileService, useValue: {ownProfile: () => undefined, getCachedByUserId: () => undefined}},
            {provide: GuildReadStateService, useValue: {ensureSeeded: () => Promise.resolve()}},
            {
                provide: GuildService,
                useValue: {getOwnMember: () => of(null), getGuild: () => of({channels: [], categories: []})},
            },
            {provide: OwnMemberRevisionService, useValue: {revision: signal(0)}},
            {provide: GuildVoiceService, useValue: {}},
            {provide: GuildUiActionsService, useValue: {openCreateChannel$: new Subject(), openCreateCategory$: new Subject()}},
            {
                provide: GuildWebsocketService,
                useValue: {
                    channelReorderedObservable: new Subject(),
                    channelCreatedObservable: new Subject(),
                    channelDeletedObservable: new Subject(),
                    channelUpdatedObservable: new Subject(),
                    categoryCreatedObservable: new Subject(),
                    categoryUpdatedObservable: new Subject(),
                    categoryDeletedObservable: new Subject(),
                },
            },
            {provide: ScheduledEventStore, useValue: {eventsForGuild: () => [], loadFor: () => undefined}},
            {provide: MinuteClockService, useValue: {retain: () => undefined, now: () => 0}},
            {provide: GuildOnboardingStateService, useValue: {statusFor: () => undefined}},
        ],
    });

    const fixture = TestBed.createComponent(ChannelListComponent);
    // No detectChanges(): the point of this spec is exercising onWatchStream without paying for the
    // template's dialog/menu/modal tree. Signal inputs are readable via setInput() alone.
    fixture.componentRef.setInput('guild', GUILD);
    return fixture;
}

describe('ChannelListComponent.onWatchStream', () => {
    it('joins the channel and arms a focus request for the streamer', async () => {
        const joinChannel = vi.fn().mockResolvedValue(undefined);
        const fixture = render(joinChannel);
        const navService = TestBed.inject(NavigationService);
        const openChannelSpy = vi.spyOn(navService, 'openChannel');
        const requestSpy = vi.spyOn(TestBed.inject(CallFocusService), 'request');

        await (fixture.componentInstance as unknown as OnWatchStreamHost)
            .onWatchStream({channel: CHANNEL, userId: 'streamer-1'});

        expect(openChannelSpy).toHaveBeenCalledWith(CHANNEL);
        expect(joinChannel).toHaveBeenCalledWith(CHANNEL, GUILD.name);
        const scope = scopeKey({kind: 'channel', guildId: CHANNEL.guildId, channelId: CHANNEL.id});
        expect(requestSpy).toHaveBeenCalledWith(scope, {userId: 'streamer-1'});
    });

    it('does not re-join when already in the streamed channel, but still arms the request', async () => {
        const joinChannel = vi.fn().mockResolvedValue(undefined);
        const fixture = render(joinChannel);
        const voiceChannelSvc = TestBed.inject(VoiceChannelService) as unknown as {joinedChannelId: ReturnType<typeof signal<string | null>>};
        voiceChannelSvc.joinedChannelId = signal(CHANNEL.id);
        const requestSpy = vi.spyOn(TestBed.inject(CallFocusService), 'request');

        await (fixture.componentInstance as unknown as OnWatchStreamHost)
            .onWatchStream({channel: CHANNEL, userId: 'streamer-1'});

        expect(joinChannel).not.toHaveBeenCalled();
        expect(requestSpy).toHaveBeenCalled();
    });
});
