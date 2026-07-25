import {Component, computed, inject, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {VoiceChannelParticipant, VoiceChannelService} from '../../../../../../services/voice-channel.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {ChannelListDragService} from '../../channel-list-drag.service';
import {ParticipantMenuRequest} from '../channel-item.types';
import {VoiceParticipantRowComponent} from '../voice-participant-row/voice-participant-row.component';

/** A voice channel row plus the members currently connected to it. */
@Component({
    selector: 'app-voice-channel-item',
    host: {class: 'contents'},
    imports: [NgClass, VoiceParticipantRowComponent],
    templateUrl: './voice-channel-item.component.html',
})
export class VoiceChannelItemComponent {
    channel = input.required<ChannelDto>();
    canReorder = input.required<boolean>();

    readonly open = output<void>();
    readonly openMenu = output<MouseEvent>();
    readonly openParticipantMenu = output<ParticipantMenuRequest>();

    protected drag = inject(ChannelListDragService);
    private navService = inject(NavigationService);
    private voiceChannelSvc = inject(VoiceChannelService);

    protected participants = computed<VoiceChannelParticipant[]>(() =>
        this.voiceChannelSvc.channelParticipants().get(this.channel().id) ?? []
    );

    protected isJoined = computed(() => this.voiceChannelSvc.joinedChannelId() === this.channel().id);
    protected isActive = computed(() => this.navService.isChannelActive(this.channel().id));

    protected onParticipantMenu(event: MouseEvent, participant: VoiceChannelParticipant): void {
        this.openParticipantMenu.emit({event, participant, channelId: this.channel().id});
    }
}
