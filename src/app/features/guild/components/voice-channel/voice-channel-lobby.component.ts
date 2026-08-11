import {Component, input, output} from '@angular/core';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {VoiceChannelParticipant} from '../../../../services/voice-channel.service';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-voice-channel-lobby',
    imports: [AppAvatarComponent, TranslateModule],
    templateUrl: './voice-channel-lobby.component.html',
})
export class VoiceChannelLobbyComponent {
    channel = input.required<ChannelDto>();
    participants = input.required<VoiceChannelParticipant[]>();

    joinVoice = output<void>();
}
