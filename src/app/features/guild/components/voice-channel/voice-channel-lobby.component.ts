import {Component, input, output} from '@angular/core';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {VoiceChannelParticipant} from '../../../../services/voice-channel.service';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';

@Component({
    selector: 'app-voice-channel-lobby',
    imports: [AppAvatarComponent],
    templateUrl: './voice-channel-lobby.component.html',
})
export class VoiceChannelLobbyComponent {
    channel = input.required<ChannelDto>();
    participants = input.required<VoiceChannelParticipant[]>();

    joinVoice = output<void>();
}
