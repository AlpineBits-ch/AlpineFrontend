import {ChangeDetectionStrategy, Component, computed, inject, input, output} from '@angular/core';
import {DatePipe, NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {ScheduledEventDto} from '../../../../dtos/response/scheduled-event.dto';
import {RelativeTimePipe} from '../../../../pipes/relative-time.pipe';
import {MinuteClockService} from '../../../../services/minute-clock.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {EventPhase} from './event-timing';

/**
 * One scheduled event, rendered for whichever phase it is in.
 *
 * <p>Presentation only: it resolves what it can read for itself - the voice channel's name, who is
 * in that channel, the clock - and emits an intent for anything that mutates. The panel owns the
 * store, the toasts and the cancel confirmation, so there stays exactly one place where an event
 * changes.</p>
 */
@Component({
    selector: 'app-event-card',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [DatePipe, NgClass, TranslateModule, RelativeTimePipe, Button, Tooltip],
    templateUrl: './event-card.component.html',
})
export class EventCardComponent {
    event = input.required<ScheduledEventDto>();
    phase = input.required<EventPhase>();
    canManage = input.required<boolean>();

    readonly edit = output<void>();
    readonly cancel = output<void>();
    readonly interest = output<void>();
    readonly joinVoice = output<void>();

    protected readonly clock = inject(MinuteClockService);
    private readonly navService = inject(NavigationService);
    private readonly voiceChannelSvc = inject(VoiceChannelService);

    constructor() {
        this.clock.retain();
    }

    /**
     * The end to render, or null when there is nothing truthful to show.
     *
     * <p>The open-ended grace window in {@link endBoundary} is an internal cutoff, not a claim
     * about when the event finishes - an event with no declared end must not be given one on
     * screen.</p>
     */
    protected endsAt = computed<string | null>(() => {
        const endsAt = this.event().endsAt;
        if (!endsAt) return null;
        return Number.isNaN(new Date(endsAt).getTime()) ? null : endsAt;
    });

    protected voiceChannelName = computed<string | null>(() => {
        const channelId = this.event().voiceChannelId;
        if (!channelId) return null;

        const ws = this.navService.workspace();
        if (ws.type !== 'server') return null;
        return ws.guild.channels.find(c => c.id === channelId)?.name ?? null;
    });

    protected voiceParticipantCount = computed(() => {
        const channelId = this.event().voiceChannelId;
        if (!channelId) return 0;
        return this.voiceChannelSvc.channelParticipants().get(channelId)?.length ?? 0;
    });
}
