import {Component, computed, inject, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Tooltip} from 'primeng/tooltip';
import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {ScheduledEventDto} from '../../../../../../dtos/response/scheduled-event.dto';
import {ScheduledEventStore} from '../../../../../../stores/scheduled-event.store';
import {MinuteClockService} from '../../../../../../services/minute-clock.service';
import {VoiceChannelParticipant, VoiceChannelService} from '../../../../../../services/voice-channel.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {ChannelListDragService} from '../../channel-list-drag.service';
import {ParticipantMenuRequest} from '../channel-item.types';
import {VoiceParticipantRowComponent} from '../voice-participant-row/voice-participant-row.component';
import {phaseOf} from '../../../events-panel/event-timing';

/** A voice channel row plus the members currently connected to it. */
@Component({
    selector: 'app-voice-channel-item',
    host: {class: 'contents'},
    imports: [VoiceParticipantRowComponent, TranslateModule, Tooltip],
    templateUrl: './voice-channel-item.component.html',
})
export class VoiceChannelItemComponent {
    channel = input.required<ChannelDto>();
    canReorder = input.required<boolean>();

    readonly open = output<void>();
    readonly openMenu = output<MouseEvent>();
    readonly openParticipantMenu = output<ParticipantMenuRequest>();
    /** A participant's LIVE badge was clicked - forward whose stream it was. */
    readonly watch = output<{userId: string}>();

    protected drag = inject(ChannelListDragService);
    private navService = inject(NavigationService);
    private voiceChannelSvc = inject(VoiceChannelService);

    protected participants = computed<VoiceChannelParticipant[]>(() =>
        this.voiceChannelSvc.channelParticipants().get(this.channel().id) ?? []
    );

    protected isJoined = computed(() => this.voiceChannelSvc.joinedChannelId() === this.channel().id);
    protected isActive = computed(() => this.navService.isChannelActive(this.channel().id));

    private eventStore = inject(ScheduledEventStore);
    private minuteClock = inject(MinuteClockService);

    /**
     * Derived here rather than taken as an input, matching how this component already reaches for
     * `participants`, `isJoined` and `isActive`. Threading it down would have to cross
     * `channel-list-items`, whose whole job is drag-and-drop ordering and which has no other reason
     * to know that events exist.
     */
    protected liveEvent = computed<ScheduledEventDto | null>(() => {
        const now = this.minuteClock.now();
        const channelId = this.channel().id;

        return this.eventStore.eventsForGuild(this.channel().guildId)
            .find(e => e.voiceChannelId === channelId && phaseOf(e, now) === 'live') ?? null;
    });

    constructor() {
        this.minuteClock.retain();
    }

    protected onParticipantMenu(event: MouseEvent, participant: VoiceChannelParticipant): void {
        this.openParticipantMenu.emit({event, participant, channelId: this.channel().id});
    }
}
