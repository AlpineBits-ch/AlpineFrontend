import {Component, computed, inject, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Tooltip} from 'primeng/tooltip';
import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {ScheduledEventDto} from '../../../../../../dtos/response/scheduled-event.dto';
import {ScheduledEventStore} from '../../../../../../stores/scheduled-event.store';
import {MinuteClockService} from '../../../../../../services/minute-clock.service';
import {InviteNudgeService} from '../../../../../../services/invite-nudge.service';
import {VoiceChannelParticipant, VoiceChannelService} from '../../../../../../services/voice-channel.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {ChannelListDragService} from '../../channel-list-drag.service';
import {ParticipantMenuRequest} from '../channel-item.types';
import {InviteFriendsRowComponent} from '../invite-friends-row/invite-friends-row.component';
import {VoiceParticipantRowComponent} from '../voice-participant-row/voice-participant-row.component';
import {phaseOf} from '../../../events-panel/event-timing';
import {ChannelIconComponent} from '../../../channel-icon/channel-icon.component';

/** A voice channel row plus the members currently connected to it. */
@Component({
    selector: 'app-voice-channel-item',
    host: {class: 'contents'},
    imports: [
        VoiceParticipantRowComponent,
        InviteFriendsRowComponent,
        TranslateModule,
        Tooltip,
        ChannelIconComponent,
    ],
    templateUrl: './voice-channel-item.component.html',
})
export class VoiceChannelItemComponent {
    readonly channel = input.required<ChannelDto>();
    readonly canReorder = input.required<boolean>();
    /** True while previewing a subject who cannot see this channel; dims the row, never hides it. */
    readonly hidden = input(false);

    readonly open = output<void>();
    readonly openMenu = output<MouseEvent>();
    readonly openParticipantMenu = output<ParticipantMenuRequest>();
    /** A participant's LIVE badge was clicked; forward whose stream it was. */
    readonly watch = output<{userId: string}>();
    /** The invite-friends row was clicked; carries the event so the host can anchor its panel. */
    readonly openInvite = output<MouseEvent>();

    protected drag = inject(ChannelListDragService);
    private navService = inject(NavigationService);
    private voiceChannelSvc = inject(VoiceChannelService);
    private inviteNudge = inject(InviteNudgeService);

    protected readonly participants = computed<VoiceChannelParticipant[]>(
        () => this.voiceChannelSvc.channelParticipants().get(this.channel().id) ?? [],
    );

    protected readonly isJoined = computed(
        () => this.voiceChannelSvc.joinedChannelId() === this.channel().id,
    );

    /** A join for this channel is still in flight; scoped to this channel so a join running for a different room isn't claimed here too. */
    protected readonly isJoining = computed(() => this.voiceChannelSvc.pendingJoinId() === this.channel().id);

    /** Whether the empty seat is showing under this channel's roster; read rather than decided here, since every rule for when it appears/ends lives in {@link InviteNudgeService}. */
    protected readonly showInviteRow = computed(() => this.inviteNudge.channelId() === this.channel().id);
    protected readonly isActive = computed(() => this.navService.isChannelActive(this.channel().id));

    private eventStore = inject(ScheduledEventStore);
    private minuteClock = inject(MinuteClockService);

    /** Derived here rather than taken as an input, matching `participants`/`isJoined`/`isActive`: threading it down would cross `channel-list-items`, whose only job is drag-and-drop ordering. */
    protected readonly liveEvent = computed<ScheduledEventDto | null>(() => {
        const now = this.minuteClock.now();
        const channelId = this.channel().id;

        return (
            this.eventStore
                .eventsForGuild(this.channel().guildId)
                .find(e => e.voiceChannelId === channelId && phaseOf(e, now) === 'live') ?? null
        );
    });

    constructor() {
        this.minuteClock.retain();
    }

    protected onParticipantMenu(event: MouseEvent, participant: VoiceChannelParticipant): void {
        this.openParticipantMenu.emit({event, participant, channelId: this.channel().id});
    }
}
