/** The participant row's `watch` is forwarded with the channel-scoped userId. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {describe, expect, it} from 'vitest';
import {VoiceChannelItemComponent} from './voice-channel-item.component';
import {VoiceChannelParticipant, VoiceChannelService} from '../../../../../../services/voice-channel.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {ChannelDto, ChannelType} from '../../../../../../dtos/response/guild.dto';
import {ScheduledEventStore} from '../../../../../../stores/scheduled-event.store';
import {MinuteClockService} from '../../../../../../services/minute-clock.service';
import {ChannelListDragService} from '../../channel-list-drag.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {provideFakePlatform} from '../../../../../../platform/testing/provide-fake-platform';

const CHANNEL = {id: 'chan-1', guildId: 'guild-1', name: 'General', type: ChannelType.Voice} as unknown as ChannelDto;

function participant(overrides: Partial<VoiceChannelParticipant> = {}): VoiceChannelParticipant {
    return {
        userId: 'user-1',
        displayName: 'Alex',
        avatarLabel: 'A',
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
        isScreenSharing: true,
        isServerDeafened: false,
        isLocal: false,
        ...overrides,
    };
}

function render(
    participants: VoiceChannelParticipant[],
    options: {pendingJoinId?: string | null} = {},
): ComponentFixture<VoiceChannelItemComponent> {
    TestBed.configureTestingModule({
        imports: [VoiceChannelItemComponent, TranslateModule.forRoot()],
        providers: [
            provideFakePlatform(),
            {
                provide: VoiceChannelService,
                useValue: {
                    channelParticipants: signal(new Map([[CHANNEL.id, participants]])),
                    joinedChannelId: signal(null),
                    pendingJoinId: signal(options.pendingJoinId ?? null),
                },
            },
            {provide: NavigationService, useValue: {isChannelActive: () => false}},
            {provide: ScheduledEventStore, useValue: {eventsForGuild: () => []}},
            {provide: MinuteClockService, useValue: {retain: () => void 0, now: () => new Date()}},
            // Drag/drop plumbing is irrelevant to watch forwarding; only its DI token needs satisfying, since the component injects it directly rather than through providers.
            {provide: ChannelListDragService, useValue: {onDragEnd: () => void 0, onItemDragOver: () => void 0, onChannelDragStart: () => void 0}},
            {provide: ProfileService, useValue: {getCachedByUserId: () => undefined, resolveByUserId: () => void 0}},
        ],
    });
    const fixture = TestBed.createComponent(VoiceChannelItemComponent);
    fixture.componentRef.setInput('channel', CHANNEL);
    fixture.componentRef.setInput('canReorder', false);
    fixture.detectChanges();
    return fixture;
}

describe('VoiceChannelItemComponent watch forwarding', () => {
    it('forwards the participant row watch click as {userId}', () => {
        const fixture = render([participant({userId: 'streamer-1'})]);
        let received: {userId: string} | null = null;
        fixture.componentInstance.watch.subscribe(e => received = e);

        const badge = fixture.nativeElement.querySelector(
            '[data-testid="voice-participant"] button',
        ) as HTMLButtonElement;
        badge.click();

        expect(received).toEqual({userId: 'streamer-1'});
    });

    it('does not also fire open when the watch badge is clicked', () => {
        const fixture = render([participant({userId: 'streamer-1'})]);
        let opened = false;
        fixture.componentInstance.open.subscribe(() => opened = true);

        const badge = fixture.nativeElement.querySelector(
            '[data-testid="voice-participant"] button',
        ) as HTMLButtonElement;
        badge.click();

        expect(opened).toBe(false);
    });
});

/** The row is the only part of the sidebar on screen for the whole of a join; without a mark here, nothing tells a user who clicked and looked away that a join is still running. */
describe('VoiceChannelItemComponent while its join is in flight', () => {
    const icon = (fixture: ComponentFixture<VoiceChannelItemComponent>) =>
        fixture.nativeElement.querySelector('.chan-icon i') as HTMLElement;

    it('spins its icon for a join of this channel', () => {
        const fixture = render([], {pendingJoinId: CHANNEL.id});

        expect(icon(fixture).className).toContain('pi-spin');
    });

    /** Somebody else's join is not this row's business; see the guard in joinChannel. */
    it('leaves the icon alone for a join of a different channel', () => {
        const fixture = render([], {pendingJoinId: 'chan-other'});

        expect(icon(fixture).className).not.toContain('pi-spin');
        expect(icon(fixture).className).toContain('pi-volume-up');
    });
});
